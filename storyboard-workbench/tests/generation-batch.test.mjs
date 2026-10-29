import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGenerationBatchStore, auditGenerationTranscript } from '../scripts/generation.mjs';
import { runConcurrentJobs, runMediaBatch, runMediaBatchAndSummarize, mediaBatchHostSource } from '../scripts/media_batch.mjs';

const job = id => ({ id, count: 1, prompt: '同一人物站在窗边。', references: ['confirmed-person.png'] });
const output = id => ({ path: `images/${id}.png`, sha256: 'a'.repeat(64) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, jobs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-batch-'));
  const source = path.join(directory, 'source.png');
  fs.writeFileSync(source, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lmN0AAAAASUVORK5CYII=', 'base64'));
  t.after(() => {
    for (const entry of jobs) {
      const claim = path.join(directory, 'claims', entry.id + '.json');
      const result = path.join(directory, 'results', entry.id + '.json');
      const image = path.join(directory, 'images', entry.id + '.png');
      const timeout = path.join(directory, 'claims', entry.id + '.timeout.json');
      if (fs.existsSync(claim)) fs.unlinkSync(claim);
      if (fs.existsSync(timeout)) fs.unlinkSync(timeout);
      if (fs.existsSync(result)) fs.unlinkSync(result);
      if (fs.existsSync(image)) fs.unlinkSync(image);
    }
    fs.unlinkSync(source);
    fs.unlinkSync(path.join(directory, 'batch.json'));
    if (fs.existsSync(path.join(directory, 'images'))) fs.rmdirSync(path.join(directory, 'images'));
    fs.rmdirSync(path.join(directory, 'claims'));
    fs.rmdirSync(path.join(directory, 'results'));
    fs.rmdirSync(directory);
  });
  return { directory, source, store: createGenerationBatchStore(directory, jobs) };
}

test('bounded queue starts the next job before a slower peer finishes and isolates rejection', async () => {
  const slow = deferred(), first = deferred(), third = deferred();
  const started = []; let active = 0, peak = 0;
  const running = runConcurrentJobs(['A', 'B', 'C', 'D'], async id => {
    active++; peak = Math.max(peak, active); started.push(id);
    try {
      if (id === 'A') await slow.promise;
      if (id === 'B') { await first.promise; throw new Error('one task failed'); }
      if (id === 'C') third.resolve();
      return id;
    } finally { active--; }
  }, { concurrency: 2 });
  assert.deepEqual(started, ['A', 'B']);
  first.resolve(); await third.promise;
  assert.ok(started.includes('C'));
  assert.equal(active >= 1, true);
  slow.resolve();
  const results = await running;
  assert.equal(peak, 2);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[3].value, 'D');
});

test('generation and supplements share default four slots with per-image save and failure records', async () => {
  const jobs = ['A', 'B', 'C', 'D', 'E'].map(job), release = deferred(), firstWave = deferred();
  const claims = new Set(), records = new Map(), started = [], saved = [];
  const options = {
    claim: async entry => { if (claims.has(entry.id)) return false; claims.add(entry.id); return true; },
    execute: async entry => {
      assert.ok(claims.has(entry.id)); started.push(entry.id);
      if (started.length === 4) firstWave.resolve();
      await release.promise;
      if (entry.id === 'B') throw Object.assign(new Error('definitive rejection'), { status: 'failed' });
      return { output_hint: `original/${entry.id}.png`, image_url: 'data:image/png;base64,not-a-receipt' };
    },
    save: async entry => { saved.push(entry.id); if (entry.id === 'C') throw new Error('disk unavailable'); return output(entry.id); },
    record: async (entry, state) => { records.set(entry.id, state); }
  };
  const running = runMediaBatch(jobs, options);
  await firstWave.promise;
  assert.equal(started.length, 4);
  release.resolve(); const results = await running;
  assert.deepEqual(results.map(entry => entry.status), ['succeeded', 'failed', 'unknown', 'succeeded', 'succeeded']);
  assert.equal(records.size, 5);
  assert.equal(records.get('C').receipt.output_hint, 'original/C.png');
  assert.equal(JSON.stringify([...records]).includes('base64'), false);
  assert.equal(saved.includes('B'), false);
  assert.ok((await runMediaBatch(jobs, options)).every(entry => entry.status === 'skipped'));
  const supplement = await runMediaBatch([job('SUPPLEMENT_A')], options);
  assert.equal(supplement[0].status, 'succeeded');
});

test('file store verifies real saved output and resumes without repeating any claimed job', async t => {
  const jobs = [job('A'), job('B')];
  const { directory, source, store } = fixture(t, jobs);
  let submitted = 0;
  const options = { ...store, execute: async () => { submitted++; return { path: source }; }, save: (entry, result) => store.save(entry, result.path) };
  const results = await runMediaBatch(jobs, options);
  assert.equal(submitted, 2);
  assert.ok(results.every(entry => entry.status === 'succeeded'));
  assert.equal(store.load(jobs[0]).status, 'succeeded');
  assert.deepEqual(fs.readFileSync(path.join(directory, results[0].output.path)), fs.readFileSync(source));
  const reopened = createGenerationBatchStore(directory, structuredClone(jobs));
  assert.ok((await runMediaBatch(jobs, { ...options, ...reopened })).every(entry => entry.status === 'skipped'));
  assert.equal(submitted, 2);
  assert.throws(() => createGenerationBatchStore(directory, [{ ...jobs[0], prompt: 'changed' }, jobs[1]]), /输入已变化/);
  assert.throws(() => store.claim({ ...jobs[0], references: ['other.png'] }, { id: 'A', status: 'submitted' }), /输入与已登记/);
  jobs[0].prompt = 'mutated in memory';
  assert.throws(() => store.load(jobs[0]), /输入与已登记/);
});

test('save failure remains unknown with original receipt and cannot submit again', async t => {
  const jobs = [job('SAVE_FAIL')], { store, source } = fixture(t, jobs);
  let submitted = 0;
  const options = { ...store, execute: async () => { submitted++; return { path: source }; }, save: async () => { throw new Error('no space'); } };
  const result = await runMediaBatch(jobs, options);
  assert.equal(result[0].status, 'unknown');
  assert.equal(store.load(jobs[0]).receipt.path, source);
  assert.equal((await runMediaBatch(jobs, options))[0].status, 'skipped');
  assert.equal(submitted, 1);
});

test('imagegen output_hint automatically saves its exact original path and rejects unknown hint formats', async t => {
  const jobs = [job('HINT')], { store, source } = fixture(t, jobs);
  const hint = `Generated images are saved to ${path.dirname(source)} as ${source} by default.\nIf you need to use a generated image at another path, copy it and leave the original in place.`;
  const result = await runMediaBatch(jobs, { ...store, execute: async () => ({ output_hint: hint, image_url: 'data:image/png;base64,omitted' }) });
  assert.equal(result[0].status, 'succeeded');
  assert.equal(store.load(jobs[0]).output.path, 'images/HINT.png');
  assert.throws(() => store.save(jobs[0], { output_hint: 'an unexpected provider response' }), /没有可识别的原图路径/);
});

test('failed result persistence leaves a durable submission and does not end peer jobs', async t => {
  const jobs = [job('A'), job('B')], { store, source } = fixture(t, jobs);
  let submitted = 0;
  const options = {
    ...store,
    execute: async () => { submitted++; return { path: source }; },
    save: (entry, result) => store.save(entry, result.path),
    record: (entry, state) => { if (entry.id === 'A') throw new Error('cannot write result'); return store.record(entry, state); }
  };
  const results = await runMediaBatch(jobs, options);
  assert.equal(results[0].status, 'unknown');
  assert.equal(results[0].persisted, false);
  assert.equal(store.load(jobs[0]).status, 'submitted');
  assert.equal(store.load(jobs[1]).status, 'succeeded');
  assert.ok((await runMediaBatch(jobs, options)).every(entry => entry.status === 'skipped'));
  assert.equal(submitted, 2);
});

test('host-source uses the same queue without imports and malformed batches never execute', async () => {
  const host = new Function(mediaBatchHostSource() + '; return {runConcurrentJobs, runMediaBatch};')();
  assert.equal((await host.runConcurrentJobs([1], async value => value))[0].value, 1);
  let executed = false;
  await assert.rejects(() => host.runMediaBatch([job('A'), job('A')], {}), /ID无效或重复/);
  await assert.rejects(() => host.runMediaBatch([job('A')], { concurrency: 0, claim: () => true, execute: () => { executed = true; }, save: () => output('A'), record: () => {} }), /并发数无效/);
  assert.equal(executed, false);
});

test('explicit imagegen moderation is failed while ambiguous transport errors stay unknown', async () => {
  const jobs = [job('REJECTED'), job('NETWORK')], records = new Map();
  const result = await runMediaBatch(jobs, {
    claim: () => true,
    execute: entry => { throw new Error(entry.id === 'REJECTED' ? 'image generation failed: Some("{\\n \\"code\\": \\"moderation_blocked\\"}")' : 'fetch failed'); },
    save: entry => output(entry.id),
    record: (entry, state) => records.set(entry.id, state)
  });
  assert.deepEqual(result.map(entry => entry.status), ['failed', 'unknown']);
  assert.equal(records.size, 2);
});

test('transcript audit distinguishes serial host execution from overlapping execution without media calls', async t => {
  const filename = path.join(os.tmpdir(), `generation-audit-${process.pid}-${Date.now()}.jsonl`);
  t.after(() => { fs.unlinkSync(filename); });
  const event = payload => ({ type: 'event_msg', timestamp: '2026-10-22T10:00:00Z', payload });
  const begin = id => event({ type: 'task_started', turn_id: id });
  const image = (id, start, end) => event({ type: 'item_completed', item: { type: 'Extension', kind: 'image_gen.generation', id }, started_at_ms: start, completed_at_ms: end });
  const rows = [begin('serial'), image('A', 1000, 2000), image('B', 2000, 3000), image('B', 2000, 3000), begin('overlap'), image('C', 4000, 6000), image('D', 5000, 7000)];
  fs.writeFileSync(filename, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  const serial = await auditGenerationTranscript(filename, 'serial');
  assert.equal(serial.observedToolExecutionPeak, 1); assert.equal(serial.toolExecutionSamples, 2);
  assert.equal(serial.toolExecutionTotalMs, 2000); assert.equal(serial.serverExecutionPeak, null);
  const latest = await auditGenerationTranscript(filename);
  assert.equal(latest.turnId, 'overlap'); assert.equal(latest.observedToolExecutionPeak, 2);
  await assert.rejects(auditGenerationTranscript(filename, 'missing'), /未找到/);
  fs.writeFileSync(filename, [begin('bad'), image('A', 2000, 1000)].map(row => JSON.stringify(row)).join('\n'), 'utf8');
  await assert.rejects(auditGenerationTranscript(filename), /区间无效/);
});

test('legacy store preflight retains existing submission capacity even when a new job appears first', async t => {
  const jobs = [job('NEW'), job('OLD')], { directory, source, store } = fixture(t, jobs);
  store.claim(jobs[1], { id: 'OLD', status: 'submitted', submittedAt: '2026-10-27T00:00:00.000Z' });
  const reopened = createGenerationBatchStore(directory, structuredClone(jobs));
  let submitted = 0, claims = 0, snapshots = 0;
  const result = await runMediaBatch(jobs, {
    ...reopened,
    snapshot: () => { snapshots++; return reopened.snapshot(); },
    claim: (entry, state) => { claims++; return reopened.claim(entry, state); },
    execute: async () => { submitted++; return { path: source }; }
  });
  assert.deepEqual(result.map(entry => entry.status), ['paused', 'skipped']);
  assert.equal(result[1].originalStatus, 'submitted');
  assert.equal(snapshots, 1);
  assert.equal(claims, 0);
  assert.equal(submitted, 0);
  assert.equal(fs.existsSync(path.join(directory, 'claims', 'NEW.json')), false);
});

test('legacy timeout is an append-only observation and the original result can later be saved without resubmission', { timeout: 2000 }, async t => {
  const jobs = [job('SLOW'), job('NEW')], { directory, source, store } = fixture(t, jobs), late = deferred();
  let submitted = 0;
  const options = { ...store, concurrency: 1, callTimeoutMs: 20, execute: async () => { submitted++; return late.promise; } };
  const first = await runMediaBatch(jobs, options);
  assert.deepEqual(first.map(entry => entry.status), ['unknown', 'paused']);
  assert.equal(first[0].errorCode, 'CALL_TIMEOUT');
  assert.equal(first[0].persisted, true);
  const claimPath = path.join(directory, 'claims', 'SLOW.json'), timeoutPath = path.join(directory, 'claims', 'SLOW.timeout.json');
  const originalClaim = fs.readFileSync(claimPath, 'utf8'), timeoutObservation = fs.readFileSync(timeoutPath, 'utf8');
  assert.equal(JSON.parse(originalClaim).status, 'submitted');
  assert.equal(JSON.parse(timeoutObservation).status, 'unknown');
  assert.equal(fs.existsSync(path.join(directory, 'results', 'SLOW.json')), false);
  const reopened = createGenerationBatchStore(directory, structuredClone(jobs));
  const retry = await runMediaBatch(jobs, { ...options, ...reopened });
  assert.deepEqual(retry.map(entry => entry.status), ['skipped', 'paused']);
  assert.equal(retry[0].originalStatus, 'unknown');
  assert.equal(submitted, 1);
  late.resolve({ path: source });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.existsSync(path.join(directory, 'results', 'SLOW.json')), false, 'late execution must not save itself after handoff');
  const saved = reopened.save(jobs[0], { path: source });
  reopened.record(jobs[0], { id: 'SLOW', status: 'succeeded', output: saved, receipt: { path: source } });
  assert.equal(reopened.load(jobs[0]).status, 'succeeded');
  assert.equal(fs.readFileSync(claimPath, 'utf8'), originalClaim);
  assert.equal(fs.readFileSync(timeoutPath, 'utf8'), timeoutObservation);
  const resumed = await runMediaBatch(jobs, { ...options, ...reopened, execute: async () => { submitted++; return { path: source }; } });
  assert.deepEqual(resumed.map(entry => entry.status), ['skipped', 'succeeded']);
  assert.equal(submitted, 2);
  assert.throws(() => reopened.record(jobs[0], { ...JSON.parse(timeoutObservation), error: 'changed observation' }), /超时观察不能覆盖/);
});

test('legacy partial summary is delivered while a timed-out peer remains unknown', { timeout: 2000 }, async t => {
  const jobs = [job('SLOW'), job('READY')], { store, source } = fixture(t, jobs);
  let summaries = 0;
  const summary = await runMediaBatchAndSummarize(jobs, {
    ...store,
    callTimeoutMs: 20,
    execute: async entry => entry.id === 'SLOW' ? new Promise(() => {}) : { path: source },
    summarize: async results => { summaries++; return { results, delivered: results.filter(entry => entry.status === 'succeeded').map(entry => entry.output) }; }
  });
  assert.deepEqual(summary.results.map(entry => entry.status), ['unknown', 'succeeded']);
  assert.equal(summary.delivered.length, 1);
  assert.equal(summary.delivered[0].path, 'images/READY.png');
  assert.equal(store.snapshot().SLOW.status, 'unknown');
  assert.equal(summaries, 1);
});

test('legacy recovery snapshots validate keys and states before claim; explicit initial states avoid a second read', async () => {
  const jobs = [job('A')]; let claims = 0, snapshots = 0;
  const options = { claim: () => { claims++; return true; }, execute: () => ({}), save: () => output('A'), record: () => {} };
  for (const initialStates of [null, [], new Map([['A', { status: 'unknown' }]]), Object.create({ A: { status: 'unknown' } }), { A: Object.create({ status: 'succeeded' }) }, { OTHER: { status: 'submitted' } }, { A: { status: 'ready' } }, { A: { id: 'OTHER', status: 'submitted' } }, { A: null }]) {
    await assert.rejects(runMediaBatch(jobs, { ...options, initialStates }), /恢复快照/);
  }
  assert.equal(claims, 0);
  const result = await runMediaBatch(jobs, { ...options, initialStates: { A: { status: 'succeeded' } }, snapshot: () => { snapshots++; return {}; } });
  assert.equal(result[0].status, 'skipped');
  assert.equal(result[0].originalStatus, 'succeeded');
  assert.equal(snapshots, 0);
  assert.equal(claims, 0);
});

test('legacy ambiguous transport failure retains capacity while explicit notAccepted allows the next task', async t => {
  for (const notAccepted of [false, true]) await t.test(String(notAccepted), async () => {
    const jobs = [job('FIRST'), job('NEW')], called = [], claimed = [];
    const result = await runMediaBatch(jobs, {
      concurrency: 1,
      claim: entry => { claimed.push(entry.id); return true; },
      execute: entry => {
        called.push(entry.id);
        if (entry.id === 'FIRST') throw Object.assign(new Error('connection interrupted'), { notAccepted });
        return {};
      },
      save: entry => output(entry.id),
      record: () => {}
    });
    assert.deepEqual(result.map(entry => entry.status), notAccepted ? ['failed', 'succeeded'] : ['unknown', 'paused']);
    assert.deepEqual(called, notAccepted ? ['FIRST', 'NEW'] : ['FIRST']);
    assert.deepEqual(claimed, called);
  });
});

test('legacy claim failure stops new claims and a concurrent late claim never reaches execute', async t => {
  await t.test('claim failure', async () => {
    const claimed = [], called = [];
    const result = await runMediaBatch([job('FIRST'), job('NEW')], {
      concurrency: 1,
      claim: entry => { claimed.push(entry.id); throw new Error('claim response lost'); },
      execute: entry => { called.push(entry.id); return {}; },
      save: entry => output(entry.id),
      record: () => {}
    });
    assert.deepEqual(result.map(entry => entry.status), ['unknown', 'paused']);
    assert.equal(result[0].stage, 'claim');
    assert.deepEqual(claimed, ['FIRST']);
    assert.deepEqual(called, []);
  });
  await t.test('late successful claim', async () => {
    const lateClaim = deferred(), failed = deferred(), called = [], records = [];
    const jobs = [job('FIRST'), job('LATE')], { store } = fixture(t, jobs);
    const running = runMediaBatch(jobs, {
      ...store,
      concurrency: 2,
      claim: async (entry, state) => { const claimed = store.claim(entry, state); if (entry.id === 'LATE') await lateClaim.promise; return claimed; },
      execute: entry => { called.push(entry.id); throw new Error('connection interrupted'); },
      save: entry => output(entry.id),
      record: (entry, state) => { store.record(entry, state); records.push([entry.id, state.status]); failed.resolve(); }
    });
    await failed.promise;
    lateClaim.resolve(true);
    const result = await running;
    assert.deepEqual(result.map(entry => entry.status), ['unknown', 'paused']);
    assert.equal(result[1].stage, 'dispatch');
    assert.equal(result[1].claimed, true);
    assert.equal(result[1].executed, false);
    assert.match(result[1].reason, /已登记但未调用/);
    assert.equal(store.load(jobs[1]).status, 'submitted');
    assert.deepEqual(called, ['FIRST']);
    assert.deepEqual(records, [['FIRST', 'unknown']]);
  });
});
