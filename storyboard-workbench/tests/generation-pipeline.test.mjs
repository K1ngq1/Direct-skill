import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { runMediaBatch, runMediaBatchAndSummarize, createMediaBatchController, mediaBatchHostSource } from '../scripts/media_batch.mjs';
import { createGenerationPipelineStore, createGenerationBatchStore } from '../scripts/generation_batch_store.mjs';
import { createProcessLock } from '../scripts/process_lock.mjs';

const job = (id, dependsOn = []) => ({ id, count: 1, dependsOn, request: { prompt: '窗边的人物，保留完整构图。' } });
const batch = { batchId: 'mock-batch', version: 'v1', phase: 'storyboards' };
const output = id => ({ path: `images/${id}.png`, sha256: 'a'.repeat(64) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const next = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function harness(concurrency = 4) {
  let control = { ...batch, revision: 0, paused: false, concurrency, receivedAt: new Date().toISOString() };
  const controller = createMediaBatchController(), started = [], captured = new Map(), finalized = [], observations = [], report = {};
  const options = {
    batch, concurrency, controller, report,
    readControl: () => ({ ...control }), acknowledgeControl: value => { observations.push(value); },
    prepare: id => ({ action: 'execute', request: job(id).request, control: { ...control } }),
    execute: async entry => { started.push(entry.id); return { path: `original/${entry.id}.png` }; },
    capture: (id, value) => { captured.set(id, value); return { id, ...value, persisted: true }; },
    finalize: id => { finalized.push(id); const value = captured.get(id); return { id, status: value?.status === 'returned' ? 'succeeded' : value?.status, output: output(id), persisted: true }; }
  };
  const change = (value, observe = true) => {
    control = { ...control, ...value, revision: control.revision + 1, receivedAt: new Date().toISOString() };
    if (observe) controller.observe(control);
    return { ...control };
  };
  return { options, started, captured, finalized, observations, report, change };
}

test('automatic closeout runs once after every result is finalized and returns only the summary', async () => {
  const h = harness(), summary = { path: 'summary.json', deliveryAllowed: true, counts: { succeeded: 2 } };
  let summarized = 0;
  const response = await runMediaBatchAndSummarize([job('A'), job('B')], {
    ...h.options,
    summarize: (results, report) => {
      summarized++;
      assert.deepEqual(h.finalized, ['A', 'B']);
      assert.ok(results.every(result => result.status === 'succeeded' && result.persisted));
      assert.equal(report, h.report);
      assert.equal(report.deliveryAllowed, true);
      return summary;
    }
  });
  assert.equal(summarized, 1);
  assert.deepEqual(response, summary);
  assert.doesNotMatch(JSON.stringify(response), /prompt|receipt|events|base64|results/);
});

test('automatic closeout requires its callback before invoking tools and includes partial failures', async () => {
  const h = harness();
  await assert.rejects(runMediaBatchAndSummarize([job('A')], h.options), /summarize/);
  assert.deepEqual(h.started, []);
  const execute = h.options.execute;
  h.options.execute = entry => entry.id === 'B' ? Promise.reject(Object.assign(new Error('rejected'), { notAccepted: true })) : execute(entry);
  let summarized = 0;
  const response = await runMediaBatchAndSummarize([job('A'), job('B')], {
    ...h.options,
    summarize: results => {
      summarized++;
      assert.equal(h.finalized.length, 2);
      assert.deepEqual(results.map(result => result.status), ['succeeded', 'failed']);
      return { counts: { succeeded: 1, failed: 1 } };
    }
  });
  assert.equal(summarized, 1);
  assert.deepEqual(response.counts, { succeeded: 1, failed: 1 });
});

test('automatic closeout is included in the import-free host source', async () => {
  const execute = new Function(`${mediaBatchHostSource()}; return runMediaBatchAndSummarize;`)();
  const h = harness();
  const response = await execute([job('A')], { ...h.options, summarize: results => ({ counts: { succeeded: results.length } }) });
  assert.deepEqual(response, { counts: { succeeded: 1 } });
  assert.deepEqual(h.started, ['A']);
});

test('a hung tool hands off saved peers, stops new dispatch and ignores late completion', { timeout: 2000 }, async () => {
  const h = harness(2), late = deferred();
  h.options.execute = entry => {
    h.started.push(entry.id);
    return entry.id === 'A' ? late.promise : { path: `original/${entry.id}.png` };
  };
  const result = await runMediaBatchAndSummarize([job('A'), job('B'), job('C', ['A'])], {
    ...h.options, callTimeoutMs: 20,
    summarize: (results, report) => ({ results, deliveryAllowed: report.deliveryAllowed, dispatchStopped: report.dispatchStopped })
  });
  assert.deepEqual(result.results.map(item => item.status), ['unknown', 'succeeded', 'blocked']);
  assert.equal(result.results[0].errorCode, 'CALL_TIMEOUT');
  assert.equal(h.captured.get('A').toolReturnedAt, null);
  assert.equal(result.deliveryAllowed, true);
  assert.ok(result.dispatchStopped);
  assert.deepEqual(h.started, ['A', 'B']);
  assert.deepEqual(h.finalized, ['B']);
  const before = JSON.stringify(result);
  late.resolve({ path: 'late/A.png' }); await next();
  assert.equal(JSON.stringify(result), before);
  assert.deepEqual(h.finalized, ['B']);
});

test('a timeout never frees capacity for a new independent submission', { timeout: 2000 }, async () => {
  const h = harness(1);
  h.options.execute = entry => { h.started.push(entry.id); return new Promise(() => {}); };
  const results = await runMediaBatch([job('A'), job('B')], { ...h.options, callTimeoutMs: 20 });
  assert.deepEqual(results.map(item => item.status), ['unknown', 'paused']);
  assert.deepEqual(h.started, ['A']);
});

test('a pending finalizer cannot hide saved peers or run twice after host source reload', { timeout: 2000 }, async () => {
  const h = harness(2), late = deferred(), finish = h.options.finalize;
  let slowCalls = 0;
  h.options.finalize = id => id === 'SLOW' ? (slowCalls++, late.promise) : finish(id);
  const first = await runMediaBatch([job('OK'), job('SLOW')], { ...h.options, localTimeoutMs: 20 });
  assert.deepEqual(first.map(item => item.status), ['succeeded', 'unknown']);
  assert.equal(first[1].errorCode, 'CALL_TIMEOUT');
  assert.equal(h.report.deliveryAllowed, true);
  const reload = new Function(`${mediaBatchHostSource()}; return runMediaBatch;`)();
  const recovery = { OK: first[0], SLOW: { id: 'SLOW', status: 'returned' } };
  try {
    const second = await reload([job('OK'), job('SLOW'), job('NEW')], { ...h.options, initialStates: recovery, localTimeoutMs: 20 });
    assert.equal(second[1].errorCode, 'FINALIZE_PENDING');
    assert.equal(second[2].status, 'paused');
    assert.equal(slowCalls, 1);
    assert.deepEqual(h.started, ['OK', 'SLOW']);
    late.resolve({ id: 'SLOW', status: 'succeeded', output: output('SLOW'), persisted: true });
    await next();
    assert.equal(first[1].status, 'unknown');
    const recovered = await reload([job('OK'), job('SLOW')], { ...h.options, initialStates: recovery, finalize: finish });
    assert.ok(recovered.every(item => item.status === 'succeeded'));
  } finally { late.resolve({}); await next(); }
});

test('summary timeout returns a small partial handoff and rechecks current delivery control', { timeout: 2000 }, async () => {
  for (const paused of [false, true]) {
    const h = harness(), late = deferred();
    const summary = await runMediaBatchAndSummarize([job('A')], {
      ...h.options, localTimeoutMs: 20,
      summarize: () => { if (paused) h.change({ paused: true }, false); return late.promise; }
    });
    assert.equal(summary.summaryPersisted, false);
    assert.equal(summary.errorCode, 'CALL_TIMEOUT');
    assert.equal(summary.deliveryAllowed, !paused);
    assert.deepEqual(summary.counts, { succeeded: 1 });
    assert.equal(Boolean(summary.tasks[0].output), !paused);
    assert.doesNotMatch(JSON.stringify(summary), /prompt|receipt|events|base64/);
    const before = JSON.stringify(summary);
    late.resolve({ path: 'late-summary.json' }); await next();
    assert.equal(JSON.stringify(summary), before);
  }
});

test('pipeline automatically reads the store snapshot before allowing any fresh submission', async t => {
  const { directory } = fixture(t), jobs = [job('NEW'), job('OLD')];
  const store = createGenerationPipelineStore(directory, jobs, batch);
  store.prepare('OLD');
  let submissions = 0, snapshots = 0;
  const results = await runMediaBatch(jobs, { ...store,
    snapshot: () => { snapshots++; return store.snapshot(); },
    execute: () => { submissions++; }
  });
  assert.equal(snapshots, 1);
  assert.equal(submissions, 0);
  assert.deepEqual(results.map(item => item.status), ['paused', 'submitting']);
  assert.equal(store.load('NEW'), null);
});

test('durable finalizer timeout hands off the saved peer and waits for the original write before recovery', { timeout: 2000 }, async t => {
  const { directory, source } = fixture(t), jobs = [job('OK'), job('SLOW')], late = deferred();
  const store = createGenerationPipelineStore(directory, jobs, batch);
  let submits = 0, finishes = 0;
  const options = { ...store, localTimeoutMs: 20,
    execute: () => { submits++; return { path: source }; },
    finalize: async id => { if (id === 'SLOW') { finishes++; await late.promise; } return store.finalize(id); }
  };
  try {
    const first = await runMediaBatchAndSummarize(jobs, options);
    assert.equal(first.deliveryAllowed, true);
    assert.deepEqual(first.counts, { succeeded: 1, unknown: 1 });
    assert.equal(first.images.length, 1);
    assert.equal(fs.existsSync(first.images[0].path), true);
    assert.equal(store.load('SLOW').status, 'returned');
    const second = await runMediaBatch(jobs, options);
    assert.equal(second[1].errorCode, 'FINALIZE_PENDING');
    assert.equal(finishes, 1);
    assert.equal(submits, 2);
    late.resolve(); await next();
    assert.equal(store.load('SLOW').status, 'succeeded');
    const restored = await runMediaBatchAndSummarize(jobs, options);
    assert.deepEqual(restored.counts, { succeeded: 2 });
    assert.equal(submits, 2);
    assert.equal(finishes, 1);
  } finally { late.resolve(); await next(); }
});

test('cross-process finalization protects partial copies and recovers only after the original process exits', { timeout: 10000 }, async t => {
  const { directory, source } = fixture(t), jobs = [job('A')];
  const store = createGenerationPipelineStore(directory, jobs, batch);
  store.prepare('A'); store.capture('A', { status: 'returned', receipt: { path: source } });
  const moduleUrl = new URL('../scripts/generation_batch_store.mjs', import.meta.url).href;
  const setup = `import fs from 'node:fs'; import {createGenerationPipelineStore} from ${JSON.stringify(moduleUrl)}; const store=createGenerationPipelineStore(${JSON.stringify(directory)},${JSON.stringify(jobs)},${JSON.stringify(batch)});`;
  const script = setup + `fs.copyFileSync=(_source,target)=>{fs.writeFileSync(target,'partial image');process.send({owner:store.inspectFinalization('A').owner});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};store.finalize('A');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', value => { stderr += value; });
  try {
    const [message] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(stderr || 'child exited before copying'); })]);
    assert.equal(fs.existsSync(path.join(directory, 'images', 'A.png')), false);
    assert.throws(() => store.recoverFinalization('A', { owner: message.owner, reason: 'live child must retain its lock' }), error => error.code === 'LOCK_OWNER_ALIVE');
    const contender = spawnSync(process.execPath, ['--input-type=module', '-e', setup + `try{store.finalize('A');process.stdout.write('unexpected success');}catch(error){process.stdout.write(error.code??error.message);}`], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    assert.equal(contender.status, 0, contender.stderr);
    assert.equal(contender.stdout, 'FINALIZE_PENDING');
    assert.equal(store.load('A').status, 'returned');
    assert.equal(fs.existsSync(path.join(directory, 'results', 'A.json')), false);
    const exited = once(child, 'exit'); child.kill(); await exited;
    assert.equal(store.recoverFinalization('A', { owner: message.owner, reason: 'test child has exited; resume the original receipt' }), true);
    const result = store.finalize('A');
    assert.equal(result.status, 'succeeded');
    assert.equal(store.load('A').status, 'succeeded');
    assert.deepEqual(fs.readFileSync(path.join(directory, 'images', 'A.png')), fs.readFileSync(source));
    assert.deepEqual(fs.readdirSync(path.join(directory, 'images')), ['A.png']);
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
});

test('a process exiting before result publication leaves the complete image recoverable', { timeout: 10000 }, async t => {
  const { directory, source } = fixture(t), jobs = [job('A')];
  const store = createGenerationPipelineStore(directory, jobs, batch);
  store.prepare('A'); store.capture('A', { status: 'returned', receipt: { path: source } });
  const moduleUrl = new URL('../scripts/generation_batch_store.mjs', import.meta.url).href;
  const script = `import fs from 'node:fs';import{createGenerationPipelineStore}from ${JSON.stringify(moduleUrl)};const store=createGenerationPipelineStore(${JSON.stringify(directory)},${JSON.stringify(jobs)},${JSON.stringify(batch)});const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(to.endsWith('A.json')){process.send({owner:store.inspectFinalization('A').owner});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return rename(from,to);};store.finalize('A');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', value => { stderr += value; });
  try {
    const [message] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(stderr || 'child exited before result publication'); })]);
    assert.deepEqual(fs.readFileSync(path.join(directory, 'images', 'A.png')), fs.readFileSync(source));
    assert.equal(store.load('A').status, 'returned');
    const exited = once(child, 'exit'); child.kill(); await exited;
    store.recoverFinalization('A', { owner: message.owner, reason: 'resume after test child exited before result publication' });
    assert.equal(store.finalize('A').status, 'succeeded');
    assert.deepEqual(fs.readdirSync(path.join(directory, 'results')), ['A.json']);
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
});

test('process locks mint fresh ownership tokens and never reclaim live, unknown or legacy locks', t => {
  const { directory } = fixture(t); fs.mkdirSync(directory);
  const filename = path.join(directory, 'test.lock'), lock = createProcessLock(filename);
  const first = lock.acquire({ owner: 'repeated-request' });
  assert.equal(first.pid, process.pid);
  assert.throws(() => lock.recover({ owner: first.owner, reason: 'live owners cannot be recovered' }), error => error.code === 'LOCK_OWNER_ALIVE');
  assert.equal(lock.release(first), true);
  const second = lock.acquire({ owner: 'repeated-request' });
  assert.notEqual(first.owner, second.owner);
  assert.equal(lock.release(first), false);
  assert.throws(() => lock.assertOwner(first), error => error.code === 'LOCK_OWNER_CHANGED');
  assert.equal(lock.inspect().owner, second.owner);
  lock.release(second);
  fs.mkdirSync(filename);
  assert.throws(() => lock.inspect(), error => error.code === 'LOCK_UNVERIFIED');
  assert.throws(() => lock.acquire(), error => error.code === 'EEXIST');
  assert.throws(() => lock.recover({ owner: second.owner, reason: 'unknown empty lock remains protected' }), error => error.code === 'LOCK_UNVERIFIED');
  fs.rmdirSync(filename);
  fs.writeFileSync(filename, JSON.stringify({ owner: 'legacy' }));
  assert.throws(() => lock.recover({ owner: 'legacy', reason: 'old file locks are not silently migrated' }), error => error.code === 'LOCK_UNVERIFIED');
  fs.unlinkSync(filename);
});

test('snapshot identity is checked and prototype names remain valid fresh job IDs', async () => {
  const h = harness();
  for (const initialStates of [{ A: { id: 'B', status: 'succeeded' } }, new Map([['A', { status: 'unknown' }]]), Object.create({ A: { status: 'succeeded' } }), { A: Object.create({ status: 'succeeded' }) }]) {
    await assert.rejects(runMediaBatch([job('A')], { ...h.options, initialStates }), /快照/);
  }
  assert.deepEqual(h.started, []);
  const results = await runMediaBatch([job('constructor'), job('toString')], h.options);
  assert.ok(results.every(item => item.status === 'succeeded'));
  assert.deepEqual(h.started, ['constructor', 'toString']);
});

test('unresolved snapshots stop new submissions but returned outputs still finalize', async () => {
  for (const status of ['claimed', 'submitting', 'submitted', 'pending', 'unknown']) {
    const h = harness();
    h.captured.set('RETURNED', { status: 'returned' });
    const results = await runMediaBatch(['J1', 'J2', 'J3', 'J4', 'RETURNED', 'NEW'].map(id => job(id)), {
      ...h.options,
      initialStates: { ...Object.fromEntries(['J1', 'J2', 'J3', 'J4'].map(id => [id, { id, status }])), RETURNED: { id: 'RETURNED', status: 'returned' } }
    });
    assert.deepEqual(h.started, []);
    assert.deepEqual(h.finalized, ['RETURNED']);
    assert.equal(results.at(-1).status, 'paused');
    assert.equal(h.report.deliveryAllowed, true);
    assert.ok(h.report.dispatchStopped);
  }
});

test('finalize actions release preparation before waiting for bounded queue capacity', { timeout: 2000 }, async () => {
  for (const [concurrency, maxPendingFinalization] of [[4, 1], [8, 4]]) {
    const h = harness(concurrency), jobs = Array.from({ length: concurrency }, (_, i) => job(`J${i}`));
    const prepare = h.options.prepare;
    h.options.prepare = id => { h.captured.set(id, { status: 'returned' }); return { ...prepare(id), action: 'finalize' }; };
    const results = await runMediaBatch(jobs, { ...h.options, maxPendingFinalization });
    assert.ok(results.every(item => item.status === 'succeeded'));
    assert.equal(h.finalized.length, jobs.length);
    assert.deepEqual(h.started, []);
    assert.ok(h.report.peakPendingFinalization <= maxPendingFinalization);
  }
});

test('host source bounds tool waits and invalid deadlines fail before dispatch', { timeout: 2000 }, async () => {
  const execute = new Function(`${mediaBatchHostSource()}; return runMediaBatchAndSummarize;`)();
  const h = harness(); h.options.execute = () => new Promise(() => {});
  const result = await execute([job('A')], { ...h.options, callTimeoutMs: 20, summarize: results => results });
  assert.equal(result[0].errorCode, 'CALL_TIMEOUT');
  for (const callTimeoutMs of [0, -1, Infinity, 2147483648]) {
    await assert.rejects(runMediaBatch([job('A')], { ...h.options, callTimeoutMs }), /期限/);
  }
});

test('fifth submission starts while first image is finalizing and the other three tools are pending', async () => {
  const h = harness(), peers = deferred(), save = deferred(), saving = deferred(), fifth = deferred();
  h.options.execute = async entry => {
    h.started.push(entry.id);
    if (entry.id === 'J5') fifth.resolve();
    if (entry.id !== 'J1') await peers.promise;
    return { path: `original/${entry.id}.png` };
  };
  const finalize = h.options.finalize;
  h.options.finalize = async id => { if (id === 'J1') { saving.resolve(); await save.promise; } return finalize(id); };
  const running = runMediaBatch(Array.from({ length: 5 }, (_, i) => job(`J${i + 1}`)), h.options);
  await saving.promise; await fifth.promise;
  assert.equal(h.finalized.length, 0);
  assert.deepEqual(h.started, ['J1', 'J2', 'J3', 'J4', 'J5']);
  assert.equal(h.captured.has('J1'), true);
  save.resolve(); peers.resolve();
  assert.ok((await running).every(value => value.status === 'succeeded'));
});

test('concurrency 1/2/4/8 and finalization backpressure remain bounded', async () => {
  for (const concurrency of [1, 2, 4, 8]) {
    const h = harness(concurrency), release = deferred(), saving = deferred();
    const finalize = h.options.finalize;
    h.options.finalize = async id => { saving.resolve(); await release.promise; return finalize(id); };
    const running = runMediaBatch(Array.from({ length: 16 }, (_, i) => job(`J${i}`)), h.options);
    await saving.promise; await next();
    assert.ok(h.captured.size <= 5, `only one finalizing plus four captured: ${h.captured.size}`);
    assert.ok(h.report.peakGeneration <= concurrency);
    release.resolve();
    assert.equal((await running).filter(value => value.status === 'succeeded').length, 16);
    assert.ok(h.report.peakPendingFinalization <= 4);
    assert.equal(h.report.peakFinalizing, 1);
  }
});

test('serialized local bridge prioritizes the replacement tool before dispatching copy work', async () => {
  const h = harness(), peers = deferred(), save = deferred(), saving = deferred(), order = [];
  let tail = Promise.resolve();
  const bridge = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  for (const key of ['prepare', 'capture']) { const fn = h.options[key]; h.options[key] = (...args) => bridge(() => fn(...args)); }
  const finalize = h.options.finalize;
  h.options.finalize = id => bridge(async () => { order.push(`finalize-${id}`); if (id === 'J1') { saving.resolve(); await save.promise; } return finalize(id); });
  h.options.execute = async entry => { order.push(`execute-${entry.id}`); if (entry.id !== 'J1') await peers.promise; return { path: entry.id }; };
  const running = runMediaBatch(Array.from({ length: 5 }, (_, i) => job(`J${i + 1}`)), h.options);
  await saving.promise;
  assert.ok(order.indexOf('execute-J5') >= 0);
  assert.ok(order.indexOf('execute-J5') < order.indexOf('finalize-J1'));
  save.resolve(); peers.resolve(); await running;
});

test('dependencies wait outside generation slots and chain heads get priority', async () => {
  const h = harness(2), savedHead = deferred(), headSaving = deferred(), independent = deferred();
  const jobs = [job('IND'), job('S07b', ['S07a']), job('S07a', ['S06d']), job('S06d')];
  const finalize = h.options.finalize;
  h.options.finalize = async id => { if (id === 'S06d') { headSaving.resolve(); await savedHead.promise; } return finalize(id); };
  h.options.execute = async entry => { h.started.push(entry.id); if (entry.id === 'IND') { independent.resolve(); } return { path: entry.id }; };
  const running = runMediaBatch(jobs, h.options);
  await headSaving.promise; await independent.promise;
  assert.deepEqual(h.started, ['S06d', 'IND']);
  savedHead.resolve(); await running;
  assert.deepEqual(h.started, ['S06d', 'IND', 'S07a', 'S07b']);
  for (const jobs of [[job('A', ['missing'])], [job('A', ['B']), job('B', ['A'])]]) await assert.rejects(runMediaBatch(jobs, harness().options), /依赖/);
});

test('pause before dispatch, after claim, during submission, and after completion; version switch blocks old work', async () => {
  const queued = harness(); queued.change({ paused: true }, false);
  assert.equal((await runMediaBatch([job('A')], queued.options))[0].status, 'paused');
  assert.deepEqual(queued.started, []);

  const claimed = harness(), prepared = deferred(), releasePrepare = deferred();
  const prepare = claimed.options.prepare;
  claimed.options.prepare = async id => { const old = prepare(id); prepared.resolve(); await releasePrepare.promise; return old; };
  const running = runMediaBatch([job('A')], claimed.options);
  await prepared.promise; claimed.change({ paused: true }); releasePrepare.resolve();
  assert.equal((await running)[0].status, 'paused'); assert.deepEqual(claimed.started, []);

  for (const change of [{ paused: true }, { version: 'v2', phase: 'characters' }]) {
    const h = harness(1), called = deferred(), release = deferred();
    h.options.execute = async entry => { h.started.push(entry.id); called.resolve(); await release.promise; return { path: entry.id }; };
    const running = runMediaBatch([job('A'), job('B')], h.options);
    await called.promise; h.change(change, false); release.resolve();
    const results = await running;
    assert.deepEqual(h.started, ['A']); assert.equal(results[0].status, 'succeeded'); assert.equal(results[1].status, 'paused');
    assert.equal(h.report.deliveryAllowed, false);
    assert.ok(h.observations.at(-1).effectiveAt);
  }
  const completed = harness();
  const finalize = completed.options.finalize;
  completed.options.finalize = id => { const value = finalize(id); completed.change({ paused: true }, false); return value; };
  assert.equal((await runMediaBatch([job('A')], completed.options))[0].status, 'succeeded');
  assert.equal(completed.report.deliveryAllowed, false);
});

test('control failures and capture failures stop new dispatch while preserving returned evidence', async () => {
  const h = harness(1); h.options.capture = () => { throw new Error('receipt disk unavailable'); };
  const results = await runMediaBatch([job('A'), job('B')], h.options);
  assert.deepEqual(h.started, ['A']); assert.equal(results[0].stage, 'capture');
  assert.equal(results[0].receipt.path, 'original/A.png'); assert.equal(results[1].status, 'paused');
  const broken = harness(); broken.options.readControl = () => { throw new Error('control unavailable'); };
  assert.equal((await runMediaBatch([job('A')], broken.options))[0].status, 'paused'); assert.deepEqual(broken.started, []);
});

test('known rejection, ambiguous throttling and timeout are recorded without automatic retries', async () => {
  const h = harness(), called = deferred(), release = deferred();
  h.options.execute = async entry => {
    h.started.push(entry.id);
    if (h.started.length === 3) called.resolve();
    await release.promise;
    throw Object.assign(new Error(entry.id === 'RATE' ? '429' : 'timeout'), entry.id === 'REJECTED' ? { notAccepted: true } : {});
  };
  const running = runMediaBatch(['REJECTED', 'RATE', 'TIMEOUT'].map(id => job(id)), h.options);
  await called.promise; release.resolve();
  const results = await running;
  assert.deepEqual(results.map(value => value.status), ['failed', 'unknown', 'unknown']);
  const restored = harness(); restored.options.initialStates = Object.fromEntries(results.map(value => [value.id, value]));
  await runMediaBatch(['REJECTED', 'RATE', 'TIMEOUT'].map(id => job(id)), restored.options);
  assert.deepEqual(restored.started, []);
});

test('observed missing tool or file capability rejects before any side effect, including host source', async t => {
  const unsupported = name => ({ capabilities: { [name]: 'unsupported' }, capabilityObservations: { [name]: { status: 'unsupported', evidence: '本地mock明确拒绝', observedAt: '2026-10-27T00:00:00Z' } } });
  for (const execute of [runMediaBatch, new Function(`${mediaBatchHostSource()}; return runMediaBatch;`)()]) {
    const h = harness(); let prepared = 0;
    await assert.rejects(execute([job('A')], { ...h.options, run: unsupported('toolUse'), prepare: () => { prepared++; } }), /toolUse/);
    assert.equal(prepared, 0); assert.deepEqual(h.started, []);
  }
  const { directory } = fixture(t);
  for (const name of ['fileRead', 'fileWrite']) {
    assert.throws(() => createGenerationPipelineStore(directory, [job('A')], { ...batch, run: unsupported(name) }), new RegExp(name));
    assert.equal(fs.existsSync(directory), false);
  }
});

test('lowering concurrency applies to the next dispatch without cancelling in-flight tasks', async () => {
  const h = harness(4), gates = Array.from({ length: 6 }, deferred);
  h.options.execute = async entry => { h.started.push(entry.id); await gates[Number(entry.id.slice(1))].promise; return { path: entry.id }; };
  const running = runMediaBatch(gates.map((_, i) => job(`J${i}`)), h.options);
  await next(); assert.equal(h.started.length, 4);
  h.change({ concurrency: 1 }); gates[0].resolve(); await next();
  assert.equal(h.started.length, 4);
  gates[1].resolve(); gates[2].resolve(); gates[3].resolve(); await next();
  assert.equal(h.started.length, 5);
  gates[4].resolve(); gates[5].resolve(); await running;
  assert.equal(h.started.length, 6);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-pipeline-'));
  const source = path.join(root, 'source.png');
  fs.writeFileSync(source, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lmN0AAAAASUVORK5CYII=', 'base64'));
  const directory = path.join(root, 'batch');
  t.after(() => {
    // Only this fixture's known directories; unlink individual files, never recursive removal.
    for (const folder of ['claims', 'requests', 'captures', 'results', 'events', 'images']) {
      const p = path.join(directory, folder);
      if (fs.existsSync(p)) { for (const name of fs.readdirSync(p)) fs.unlinkSync(path.join(p, name)); fs.rmdirSync(p); }
    }
    if (fs.existsSync(directory)) { for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory); }
    fs.unlinkSync(source); fs.rmdirSync(root);
  });
  return { directory, source };
}
const envelope = source => ({ status: 'returned', receipt: { path: source }, callStartedAt: new Date().toISOString(), toolReturnedAt: new Date().toISOString() });

test('durable timeout handoff delivers saved files and permits only the original returned receipt to recover', { timeout: 3000 }, async t => {
  const { directory, source } = fixture(t), jobs = [job('A'), job('B'), job('C', ['A'])];
  const store = createGenerationPipelineStore(directory, jobs, batch);
  const summary = await runMediaBatchAndSummarize(jobs, {
    ...store, initialStates: store.snapshot(), callTimeoutMs: 40,
    execute: entry => entry.id === 'A' ? new Promise(() => {}) : { path: source }
  });
  assert.equal(summary.deliveryAllowed, true);
  assert.deepEqual(summary.images.map(item => item.id), ['B']);
  assert.equal(summary.counts.unknown, 1);
  assert.equal(store.snapshot().A.status, 'submitting');
  assert.equal(fs.existsSync(path.join(directory, 'captures', 'A.json')), false);
  assert.ok(fs.readdirSync(path.join(directory, 'events')).some(name => JSON.parse(fs.readFileSync(path.join(directory, 'events', name), 'utf8')).status === 'wait-expired'));
  let submissions = 0;
  await runMediaBatch(jobs, { ...store, initialStates: store.snapshot(), execute: () => { submissions++; } });
  assert.equal(submissions, 0);
  store.capture('A', envelope(source));
  const recovered = await runMediaBatch(jobs.slice(0, 2), {
    ...store, initialStates: { A: store.snapshot().A, B: store.snapshot().B }, execute: () => { submissions++; }
  });
  assert.equal(recovered[0].status, 'succeeded');
  assert.equal(submissions, 0);
});

test('automatic closeout resumes returned files without generation and preserves receipts if summary fails', async t => {
  const { directory, source } = fixture(t), jobs = [job('A')];
  let store = createGenerationPipelineStore(directory, jobs, batch);
  store.prepare('A');
  store.capture('A', envelope(source));
  let generated = 0;
  await assert.rejects(runMediaBatchAndSummarize(jobs, {
    ...store, initialStates: store.snapshot(), execute: () => { generated++; },
    summarize: () => { throw new Error('summary disk unavailable'); }
  }), /summary disk unavailable/);
  store = createGenerationPipelineStore(directory, jobs, batch);
  assert.equal(store.snapshot().A.status, 'succeeded');
  const summary = await runMediaBatchAndSummarize(jobs, {
    ...store, initialStates: store.snapshot(), execute: () => { generated++; }
  });
  assert.equal(generated, 0);
  assert.equal(summary.deliveryAllowed, true);
  assert.equal(summary.counts.succeeded, 1);
  assert.equal(summary.images.length, 1);
  assert.doesNotMatch(JSON.stringify(summary), /prompt|receipt|events|base64|results/);
});

test('durable prepare/capture/finalize preserves snapshots, timing, duplicate callbacks and recovery after exit', async t => {
  const { directory, source } = fixture(t), jobs = [job('A')];
  let store = createGenerationPipelineStore(directory, jobs, batch);
  assert.equal(store.prepare('A').action, 'execute');
  const returned = envelope(source), first = store.capture('A', returned);
  assert.deepEqual(store.capture('A', returned), first);
  assert.throws(() => store.capture('A', { ...returned, error: 'changed' }), /冲突/);
  store = createGenerationPipelineStore(directory, jobs, batch);
  let calls = 0;
  const results = await runMediaBatch(store.jobs, { ...store, initialStates: store.snapshot(), execute: () => { calls++; } });
  assert.equal(calls, 0); assert.equal(results[0].status, 'succeeded');
  assert.equal(results[0].serverReceivedAt, null); assert.equal(results[0].serverQueueMs, null);
  assert.ok(results[0].finalizeMs >= 0); assert.ok(results[0].capturedAt.clockId);
  assert.deepEqual(fs.readFileSync(path.join(directory, results[0].output.path)), fs.readFileSync(source));
  assert.deepEqual(store.finalize('A'), results[0]);
  const summary = store.summarize(results, { deliveryAllowed: true });
  assert.equal(summary.deliveryAllowed, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, summary.path), 'utf8')).results[0].status, 'succeeded');
  assert.throws(() => createGenerationPipelineStore(directory, [{ ...jobs[0], request: { prompt: 'changed' } }], batch), /不能迁移或覆盖/);
  assert.throws(() => createGenerationBatchStore(directory, jobs), /输入已变化/);
});

test('batch summary writes a clickable UTF-8 delivery index and returns only compact verified paths', t => {
  const { directory, source } = fixture(t), jobs = ['A', 'B', 'C'].map(id => job(id));
  const store = createGenerationPipelineStore(directory, jobs, batch);
  store.prepare('A'); store.capture('A', envelope(source));
  store.prepare('B'); store.capture('B', { status: 'failed', error: 'rejected' });
  store.prepare('C'); store.capture('C', envelope(path.join(directory, 'missing.png')));
  const results = jobs.map(entry => store.finalize(entry.id));
  const report = { deliveryAllowed: true, events: [{ prompt: 'private prompt', image_url: 'data:image/png;base64,' + 'a'.repeat(10000) }] };
  const summary = store.summarize(results, report), response = JSON.stringify(summary);
  assert.deepEqual(summary.counts, { succeeded: 1, failed: 1, unknown: 1 });
  assert.deepEqual(summary.images, [{ id: 'A', path: path.resolve(directory, 'images/A.png') }]);
  assert.equal(path.isAbsolute(summary.deliveryPath), true);
  const index = fs.readFileSync(summary.deliveryPath, 'utf8');
  assert.ok(index.startsWith('# 图片批次交付索引\n'));
  assert.ok(index.split('\n').length >= 10);
  assert.match(index, /不代表画质审核或用户确认/);
  assert.ok(index.includes(`[A](<${summary.images[0].path.replaceAll('\\', '/')}>)`));
  assert.doesNotMatch(index, /\uFFFD/);
  assert.doesNotMatch(response, /private prompt|data:image|"events"|"results"|"report"/);
  assert.ok(Buffer.byteLength(response) < 2000);
  const second = store.summarize(results, report);
  assert.notEqual(second.path, summary.path);
  assert.notEqual(second.deliveryPath, summary.deliveryPath);
  assert.equal(fs.readFileSync(summary.deliveryPath, 'utf8'), index);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, summary.path), 'utf8')).report.events[0].prompt, 'private prompt');
  fs.appendFileSync(path.join(directory, 'images/A.png'), 'changed');
  assert.throws(() => store.summarize(results, report), /哈希/);
});

test('batch summary suppresses delivery links when either current control or report disallows delivery', t => {
  const { directory, source } = fixture(t), jobs = [job('A')];
  const store = createGenerationPipelineStore(directory, jobs, batch);
  store.prepare('A'); store.capture('A', envelope(source));
  const results = [store.finalize('A')];
  store.setControl({ paused: true });
  for (const report of [{ deliveryAllowed: true }, { deliveryAllowed: false }]) {
    const summary = store.summarize(results, report);
    assert.equal(summary.deliveryAllowed, false);
    assert.equal(summary.deliveryPath, null);
    assert.deepEqual(summary.images, []);
    assert.deepEqual(summary.counts, { succeeded: 1 });
    const internalPath = path.join(directory, summary.path.replace('summary-', 'delivery-').replace('.json', '.md'));
    const index = fs.readFileSync(internalPath, 'utf8');
    assert.ok(index.startsWith('# 图片批次交付索引\n'));
    assert.match(index, /不允许交付/);
    assert.doesNotMatch(index, /\]\(</);
    store.setControl({ paused: false });
  }
});

test('submission interrupted without capture is never regenerated on restart', async t => {
  const { directory } = fixture(t), jobs = [job('A')];
  let store = createGenerationPipelineStore(directory, jobs, batch); store.prepare('A');
  store = createGenerationPipelineStore(directory, jobs, batch);
  let calls = 0;
  const results = await runMediaBatch(store.jobs, { ...store, initialStates: store.snapshot(), execute: () => { calls++; } });
  assert.equal(calls, 0); assert.equal(results[0].status, 'submitting');
});

test('copy failure and S11 rejected save remain preserved and are not automatically retried', async t => {
  const { directory, source } = fixture(t), jobs = [job('S11')];
  const store = createGenerationPipelineStore(directory, jobs, batch); store.prepare('S11');
  store.capture('S11', envelope(path.join(directory, 'missing.png')));
  const result = store.finalize('S11'); assert.equal(result.status, 'unknown'); assert.equal(result.stage, 'save');
  let calls = 0;
  await runMediaBatch(store.jobs, { ...store, initialStates: store.snapshot(), execute: () => { calls++; }, finalize: () => { calls++; } });
  assert.equal(calls, 0); assert.ok(fs.existsSync(source));
  const h = harness();
  h.options.initialStates = { S11: { id: 'S11', status: 'unknown', stage: 'save', error: 'approval rejected', receipt: { path: source } } };
  const [preserved] = await runMediaBatch(jobs, h.options);
  assert.equal(preserved.error, 'approval rejected'); assert.deepEqual(h.started, []); assert.deepEqual(h.finalized, []);
});

test('persistent stage switch pauses old inputs and fixed reference mutation fails before claiming', t => {
  const { directory, source } = fixture(t);
  const entry = job('A'); entry.request.referenced_image_paths = [source];
  const store = createGenerationPipelineStore(directory, [entry], batch);
  const changed = store.setControl({ phase: 'characters', version: 'v2' });
  assert.equal(changed.revision, 1); assert.equal(store.prepare('A').action, 'paused');
  store.setControl({ phase: batch.phase, version: batch.version });
  fs.appendFileSync(source, 'changed');
  assert.throws(() => store.prepare('A'), /参考图已变化/); assert.equal(store.load('A'), null);
});

test('host-source executes the same pipeline without imports or a monotonic host clock', async () => {
  const host = new Function('performance', `${mediaBatchHostSource()}; return runMediaBatch;`)(undefined);
  const h = harness(); const results = await host([job('A')], h.options);
  assert.equal(results[0].status, 'succeeded'); assert.equal(h.report.durationSource, 'utc-estimate');
});

test('dynamic reference hashes bind only after the prerequisite is saved; new versions use new batches', t => {
  const { directory, source } = fixture(t);
  const jobs = [job('A'), job('B', ['A'])];
  jobs[1].request.referenced_image_paths = [path.join(directory, 'images', 'A.png')];
  const store = createGenerationPipelineStore(directory, jobs, batch);
  assert.equal(store.prepare('B').action, 'blocked'); assert.equal(store.load('B'), null);
  store.prepare('A'); store.capture('A', envelope(source));
  assert.equal(store.prepare('B').action, 'blocked');
  store.finalize('A'); assert.equal(store.prepare('B').action, 'execute');
  const request = JSON.parse(fs.readFileSync(path.join(directory, 'requests', 'B.json'), 'utf8'));
  assert.equal(request.resolvedReferences[0].sha256, store.load('A').output.sha256);
  const second = fixture(t);
  const nextStore = createGenerationPipelineStore(second.directory, [job('A')], { ...batch, version: 'v2' });
  assert.equal(nextStore.prepare('A').action, 'execute');
});

test('exit after copying resumes from the durable receipt and never overwrites conflicting image bytes', async t => {
  const { directory, source } = fixture(t), jobs = [job('A')];
  const store = createGenerationPipelineStore(directory, jobs, batch);
  store.prepare('A'); store.capture('A', envelope(source));
  fs.mkdirSync(path.join(directory, 'images'));
  fs.copyFileSync(source, path.join(directory, 'images', 'A.png'));
  const reopened = createGenerationPipelineStore(directory, jobs, batch);
  let calls = 0;
  const [result] = await runMediaBatch(jobs, { ...reopened, initialStates: reopened.snapshot(), execute: () => { calls++; } });
  assert.equal(result.status, 'succeeded'); assert.equal(calls, 0);
  const second = fixture(t), conflicting = createGenerationPipelineStore(second.directory, jobs, batch);
  conflicting.prepare('A'); conflicting.capture('A', envelope(second.source));
  fs.mkdirSync(path.join(second.directory, 'images'));
  fs.writeFileSync(path.join(second.directory, 'images', 'A.png'), 'original user bytes');
  assert.equal(conflicting.finalize('A').status, 'unknown');
  assert.equal(fs.readFileSync(path.join(second.directory, 'images', 'A.png'), 'utf8'), 'original user bytes');
});

test('missing or corrupt control state cannot silently reset a paused batch', t => {
  const { directory } = fixture(t), jobs = [job('A')];
  const store = createGenerationPipelineStore(directory, jobs, batch);
  store.setControl({ paused: true });
  fs.writeFileSync(path.join(directory, 'control-00000001.json'), '{');
  assert.throws(() => store.prepare('A'), SyntaxError); assert.equal(store.load('A'), null);
  fs.unlinkSync(path.join(directory, 'control.json'));
  assert.throws(() => createGenerationPipelineStore(directory, jobs, batch), /检查点缺失/);
});

test('16-task mock comparison reports bridge count and timing without paid calls', async () => {
  const jobs = Array.from({ length: 16 }, (_, i) => job(`J${i}`));
  const generationMs = [45, 8, 30, 15, 8, 35, 10, 20, 15, 5, 30, 10, 20, 5, 15, 10];
  const bridge = () => { let tail = Promise.resolve(); return fn => { const result = tail.then(async () => { await delay(2); return fn(); }); tail = result.catch(() => {}); return result; }; };
  const oldBridge = bridge(); let oldCalls = 0, oldBusy = 0; const oldStart = performance.now(), oldEvents = [];
  const oldCall = fn => { oldCalls++; return oldBridge(fn); };
  await runMediaBatch(jobs, {
    claim: () => oldCall(() => true),
    execute: async entry => { await oldCall(() => true); const began = performance.now(); oldEvents.push({type:'call-started',elapsedMs:began-oldStart}); await delay(generationMs[Number(entry.id.slice(1))]); oldBusy += performance.now() - began; oldEvents.push({type:'tool-returned',elapsedMs:performance.now()-oldStart}); return {}; },
    save: entry => oldCall(async () => { await delay(4); return output(entry.id); }), record: () => oldCall(() => true)
  });
  const oldTotal = performance.now() - oldStart;
  const h = harness(), newBridge = bridge();
  for (const key of ['prepare', 'capture', 'finalize']) { const fn = h.options[key]; h.options[key] = (...args) => newBridge(async () => { if (key === 'finalize') await delay(4); return fn(...args); }); }
  h.options.execute = async entry => { await delay(generationMs[Number(entry.id.slice(1))]); return { path: entry.id }; };
  const results = await runMediaBatch(jobs, h.options);
  assert.equal(results.filter(value => value.status === 'succeeded').length, 16);
  assert.equal(oldCalls, 64); assert.equal(h.report.bridgeCalls, 48);
  const rounded = n => Math.round(n * 10) / 10;
  const median = values => rounded([...values].sort((a,b)=>a-b)[Math.floor(values.length/2)] ?? 0);
  const refill = events => events.flatMap((event,index) => { if(event.type!=='tool-returned') return []; const next=events.slice(index+1).find(e=>e.type==='call-started'); return next?[next.elapsedMs-event.elapsedMs]:[]; });
  console.log('MOCK_METRICS ' + JSON.stringify({ tasks: 16, concurrency: 4, legacy: { bridgeCalls: oldCalls, totalMs: rounded(oldTotal), generationUtilizationPercent: rounded(100*oldBusy / (4 * oldTotal)), nextSubmissionAfterReturnMedianMs:median(refill(oldEvents)) }, pipeline: { bridgeCalls: h.report.bridgeCalls, controlCalls: h.report.controlCalls, totalMs: rounded(h.report.totalMs), generationUtilizationPercent: rounded(100*h.report.generationBusyMs / (4 * h.report.totalMs)), nextSubmissionAfterReturnMedianMs:median(refill(h.report.events)), nextSubmissionAfterCaptureMedianMs:median(h.report.nextSubmissionAfterCaptureMs), peakPendingFinalization: h.report.peakPendingFinalization }, paidCalls: 0 }));
});
