import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createLibTVGenerationStore } from '../scripts/libtv_generation_store.mjs';
import { runLibTVGenerationBatch } from '../scripts/libtv_generation.mjs';

const identity = { batchId: 'mock-libtv', version: 'v1', phase: 'scenes', projectId: 'project' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const job = (id = 'A', dependsOn = []) => ({ id, count: 1, dependsOn, submitArgs: { project_id: 'project', kind: 'image', idempotency_key: `key-${id}`, request: { model: 'mock-image', prompt: '保留中文场景与完整构图。', params: { count: 1 } } } });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libtv-generation-')), directory = path.join(root, 'batch'), source = path.join(root, 'source.png');
  const savedPaths = [], children = [];
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lmN0AAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(source, bytes);
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    const receiptDirectory = path.join(directory, 'receipts');
    if (fs.existsSync(receiptDirectory)) { for (const name of fs.readdirSync(receiptDirectory)) fs.unlinkSync(path.join(receiptDirectory, name)); fs.rmdirSync(receiptDirectory); }
    const coordinator = path.join(directory, 'coordinator.lock');
    if (fs.existsSync(coordinator) && fs.statSync(coordinator).isDirectory()) { for (const name of fs.readdirSync(coordinator)) fs.unlinkSync(path.join(coordinator, name)); fs.rmdirSync(coordinator); }
    if (fs.existsSync(directory)) { for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory); }
    for (const filename of savedPaths) if (fs.existsSync(filename)) fs.unlinkSync(filename);
    fs.unlinkSync(source); fs.rmdirSync(root);
  });
  return { root, directory, source, savedPaths, children, files: [{ path: source, sha256: createHash('sha256').update(bytes).digest('hex') }] };
}

function localStoreProcess(fixture, jobs, body) {
  const source = [
    `import {createLibTVGenerationStore} from ${JSON.stringify(new URL('../scripts/libtv_generation_store.mjs', import.meta.url).href)};`,
    `import {runLibTVGenerationBatch} from ${JSON.stringify(new URL('../scripts/libtv_generation.mjs', import.meta.url).href)};`,
    `const store=createLibTVGenerationStore(${JSON.stringify(fixture.directory)},${JSON.stringify(jobs)},${JSON.stringify(identity)});`,
    body
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  child.testErrors = '';
  child.stderr.on('data', bytes => { child.testErrors += bytes.toString('utf8'); });
  fixture.children.push(child);
  return child;
}

function childMessage(child) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.off('message', message); child.off('exit', exited); child.off('error', failed); };
    const message = value => { cleanup(); resolve(value); };
    const exited = code => { cleanup(); reject(new Error(`local test process exited (${code}): ${child.testErrors}`)); };
    const failed = error => { cleanup(); reject(error); };
    child.once('message', message); child.once('exit', exited); child.once('error', failed);
  });
}

test('freezes original requests, exposes small scheduler jobs and appends recoverable immutable receipts', t => {
  const f = fixture(t), jobs = [job()], store = createLibTVGenerationStore(f.directory, jobs, identity);
  assert.deepEqual(store.jobs, [{ id: 'A', count: 1, dependsOn: [] }]);
  store.writeReceipt('A', { state: 'submitting' }, { exclusive: true });
  store.writeReceipt('A', { state: 'pending', taskId: 'task-original' });
  const reopened = createLibTVGenerationStore(f.directory, jobs, identity);
  assert.equal(reopened.readReceipt('A').taskId, 'task-original');
  assert.deepEqual(reopened.prepare('A').job, jobs[0]);
  assert.equal(fs.readdirSync(path.join(f.directory, 'receipts')).length, 4);
  assert.throws(() => reopened.writeReceipt('A', { state: 'submitting' }, { exclusive: true }), /重复认领/);
  assert.throws(() => reopened.writeReceipt('A', { state: 'pending', taskId: 'replacement' }), /替换原 taskId/);
  const changed = structuredClone(jobs); changed[0].submitArgs.request.params.prompt = '改稿';
  assert.throws(() => createLibTVGenerationStore(f.directory, changed, identity), /冻结输入已变化/);
});

test('validates both submit tools without changing arguments and rejects duplicate keys, cycles or canvas receipts', t => {
  const f = fixture(t), typed = { id: 'T', count: 1, dependsOn: [], submitTool: 'create_node', submitArgs: { projectId: 'project', idempotencyKey: 'typed-key', nodeType: 'image', run: true, name: '中文场景', prompt: '保留中文场景与完整构图。', params: { model: 'mock', count: 1 } } };
  const store = createLibTVGenerationStore(f.directory, [typed], identity);
  assert.deepEqual(store.prepare('T').job, typed);
  assert.throws(() => store.writeReceipt('T', { state: 'pending', taskId: 'cop_canvas' }), /画布回执/);
  assert.throws(() => createLibTVGenerationStore(f.directory, [job('A', ['B']), job('B', ['A'])], identity), /依赖存在循环/);
  const duplicate = job('B'); duplicate.submitArgs.idempotency_key = 'key-A';
  assert.throws(() => createLibTVGenerationStore(f.directory, [job(), duplicate], identity), /唯一 ID、幂等键/);
  assert.throws(() => createLibTVGenerationStore(f.directory, [{ ...typed, submitArgs: { ...typed.submitArgs, run: false } }], identity), /明确单张/);
  assert.throws(() => createLibTVGenerationStore(f.directory, [{ ...typed, submitArgs: { ...typed.submitArgs, prompt: '' } }], identity), /明确单张/);
  const stringFixture = fixture(t), stringJob = job();
  stringJob.submitArgs.request.params = JSON.stringify(stringJob.submitArgs.request.params);
  assert.throws(() => createLibTVGenerationStore(stringFixture.directory, [stringJob], identity), /明确单张/);
  createLibTVGenerationStore(stringFixture.directory, [job()], identity);
  const oldPlanFile = path.join(stringFixture.directory, 'batch.json'), oldPlan = JSON.parse(fs.readFileSync(oldPlanFile, 'utf8'));
  oldPlan.jobs = [stringJob]; fs.writeFileSync(oldPlanFile, JSON.stringify(oldPlan), 'utf8');
  const stringStore = createLibTVGenerationStore(stringFixture.directory, [stringJob], identity);
  assert.equal(stringStore.prepare('A').job.submitArgs.request.params, stringJob.submitArgs.request.params);
});

test('coordinator ownership is exclusive and another store cannot remove its lock', t => {
  const f = fixture(t), first = createLibTVGenerationStore(f.directory, [job()], identity), second = createLibTVGenerationStore(f.directory, [job()], identity);
  first.acquire();
  assert.throws(() => second.acquire(), { code: 'EEXIST' });
  assert.equal(second.release(), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'coordinator.lock')), true);
  assert.equal(first.release(), true);
  second.acquire(); second.release();
});

test('control pause preserves history and suppresses delivery even after files succeeded', t => {
  const f = fixture(t), store = createLibTVGenerationStore(f.directory, [job()], identity);
  store.writeReceipt('A', { state: 'succeeded', taskId: 'original', files: f.files });
  const paused = store.setControl({ paused: true });
  store.acknowledgeControl({ ...paused, observedAt: new Date().toISOString(), effectiveAt: new Date().toISOString() });
  assert.equal(store.prepare('A').control.paused, true);
  const summary = store.summarize([{ id: 'A', status: 'succeeded', taskId: 'original' }], { deliveryAllowed: true });
  assert.equal(summary.deliveryAllowed, false);
  assert.equal(summary.deliveryPath, null);
  assert.ok(fs.existsSync(path.join(f.directory, 'control-observed-1.json')));
  assert.equal(createLibTVGenerationStore(f.directory, [job()], identity).readControl().paused, true);
});

test('success requires actual files and hashes; summary is compact while full evidence stays local', t => {
  const f = fixture(t), store = createLibTVGenerationStore(f.directory, [job()], identity);
  assert.throws(() => store.writeReceipt('A', { state: 'succeeded', taskId: 'original', files: [] }), /文件或数量/);
  assert.throws(() => store.writeReceipt('A', { state: 'succeeded', taskId: 'original', files: [{ ...f.files[0], sha256: 'a'.repeat(64) }] }), /哈希不一致/);
  store.writeReceipt('A', { state: 'generated', taskId: 'original', outputs: [{ nodeId: 'node-original' }] });
  store.writeReceipt('A', { state: 'succeeded', taskId: 'original', files: f.files });
  const results = [{ id: 'A', status: 'succeeded', taskId: 'original', internalEvidence: 'large-data'.repeat(1000) }];
  const summary = store.summarize(results, { deliveryAllowed: true, events: ['internal'] });
  assert.equal(summary.deliveryAllowed, true);
  assert.deepEqual(summary.counts, { succeeded: 1 });
  assert.deepEqual(summary.tasks, [{ id: 'A', status: 'succeeded', taskId: 'original' }]);
  assert.ok(JSON.stringify(summary).length < 1200);
  assert.doesNotMatch(JSON.stringify(summary), /large-data|prompt|events|files|base64|internalEvidence/);
  assert.match(fs.readFileSync(summary.deliveryPath, 'utf8'), /LibTV 批次交付索引/);
  assert.equal(JSON.parse(fs.readFileSync(summary.path, 'utf8')).results[0].internalEvidence, results[0].internalEvidence);
  fs.writeFileSync(f.source, 'changed');
  assert.throws(() => store.summarize(results, { deliveryAllowed: true }), /哈希不一致/);
});

test('missing control or interrupted receipt checkpoints fail closed instead of reopening an unsubmitted job', t => {
  const f = fixture(t), store = createLibTVGenerationStore(f.directory, [job()], identity);
  store.writeReceipt('A', { state: 'submitting' }, { exclusive: true });
  const receipt = path.join(f.directory, 'receipts', 'A-00000001.json');
  fs.unlinkSync(receipt);
  assert.throws(() => store.prepare('A'), /检查点缺失/);
  assert.throws(() => createLibTVGenerationStore(f.directory, [job()], identity), /检查点缺失/);
  fs.unlinkSync(path.join(f.directory, 'control.json'));
  assert.throws(() => createLibTVGenerationStore(f.directory, [job()], identity), /检查点缺失/);
});

test('real store and runner finalize dependent mock tasks once, then reopen with zero remote or save calls', async t => {
  const f = fixture(t), jobs = [job('B', ['A']), job('A')], calls = [], order = [];
  let store = createLibTVGenerationStore(f.directory, jobs, identity);
  const report = {}, hugePayload = 'data:image/png;base64,' + 'A'.repeat(10000);
  const summary = await runLibTVGenerationBatch(store.jobs, {
    ...store, allowNewSubmissions: true, maxPolls: 1, pollIntervalMs: 0, report,
    call: async (tool, args) => {
      calls.push(tool);
      if (tool === 'generation_submit') {
        const id = args.idempotency_key.slice(4);
        order.push(`submit-${id}`);
        if (id === 'B') {
          const prior = store.readReceipt('A');
          assert.equal(prior.state, 'succeeded');
          assert.deepEqual(fs.readFileSync(prior.files[0].path), fs.readFileSync(f.source));
        }
        assert.deepEqual(args, jobs.find(item => item.id === id).submitArgs);
        return { structuredContent: { task_id: `task-${id}`, rawImage: hugePayload } };
      }
      assert.equal(tool, 'task_status');
      return { structuredContent: { projectId: args.project_id, taskId: args.task_id, state: 'succeeded', outputs: [{ nodeId: `node-${args.task_id}`, rawImage: hugePayload, prompt: '不可进入小回执' }], rawImage: hugePayload } };
    },
    // This fixture explicitly maps a mock observed contract; it does not invent a production response schema.
    normalizeTask: response => response.structuredContent,
    finalize: async (entry, receipt) => {
      order.push(`save-${entry.id}`);
      assert.deepEqual(Object.keys(receipt.outputs[0]), ['nodeId']);
      const filename = path.join(f.root, `saved-${entry.id}.png`);
      fs.copyFileSync(f.source, filename, fs.constants.COPYFILE_EXCL); f.savedPaths.push(filename);
      return { files: [{ path: filename, sha256: f.files[0].sha256 }] };
    },
    wait: () => { throw new Error('single-poll fixture must not wait'); }
  });
  assert.deepEqual(summary.counts, { succeeded: 2 });
  assert.equal(report.submitted, 2);
  assert.deepEqual(order, ['submit-A', 'save-A', 'submit-B', 'save-B']);
  assert.equal(calls.filter(tool => tool === 'generation_submit').length, 2);
  assert.equal(calls.filter(tool => tool === 'task_status').length, 2);
  for (const name of fs.readdirSync(path.join(f.directory, 'receipts'))) assert.doesNotMatch(fs.readFileSync(path.join(f.directory, 'receipts', name), 'utf8'), /base64|不可进入小回执|rawImage/);
  assert.doesNotMatch(JSON.stringify(summary), /prompt|base64|rawImage|events/);
  store = createLibTVGenerationStore(f.directory, jobs, identity);
  let remoteCalls = 0, saves = 0;
  const resumed = await runLibTVGenerationBatch(store.jobs, {
    ...store, allowNewSubmissions: false,
    call: () => { remoteCalls++; throw new Error('completed task must not call remote'); },
    normalizeTask: () => { throw new Error('completed task must not normalize'); },
    finalize: () => { saves++; throw new Error('completed file must be reused'); }
  });
  assert.deepEqual(resumed.counts, { succeeded: 2 });
  assert.equal(remoteCalls, 0); assert.equal(saves, 0);
  assert.equal(fs.existsSync(path.join(f.directory, 'coordinator.lock')), false);
});

test('generated checkpoint survives local save failure and restart performs only file finalization', async t => {
  const f = fixture(t), jobs = [job()];
  let store = createLibTVGenerationStore(f.directory, jobs, identity), calls = 0, saves = 0;
  const first = await runLibTVGenerationBatch(store.jobs, {
    ...store, allowNewSubmissions: true, maxPolls: 1,
    call: async (tool, args) => {
      calls++;
      return { structuredContent: tool === 'generation_submit' ? { task_id: 'task-original' } : { projectId: args.project_id, taskId: args.task_id, state: 'succeeded', outputs: [{ resourceId: 'resource-original' }] } };
    },
    normalizeTask: response => response.structuredContent,
    finalize: () => { saves++; throw new Error('local disk temporarily unavailable'); }
  });
  assert.deepEqual(first.counts, { generated: 1 });
  assert.equal(store.readReceipt('A').state, 'generated');
  assert.equal(calls, 2); assert.equal(saves, 1);
  store = createLibTVGenerationStore(f.directory, jobs, identity);
  let resumedRemoteCalls = 0, resumedSaves = 0;
  const second = await runLibTVGenerationBatch(store.jobs, {
    ...store, allowNewSubmissions: false,
    call: () => { resumedRemoteCalls++; throw new Error('generated task must not call remote'); },
    normalizeTask: () => { throw new Error('generated task must not normalize'); },
    finalize: (entry, receipt) => {
      resumedSaves++;
      assert.equal(receipt.taskId, 'task-original');
      assert.deepEqual(receipt.outputs, [{ resourceId: 'resource-original' }]);
      assert.equal(entry.count, f.files.length);
      return { files: f.files };
    }
  });
  assert.deepEqual(second.counts, { succeeded: 1 });
  assert.equal(resumedRemoteCalls, 0); assert.equal(resumedSaves, 1);
  assert.equal(store.readReceipt('A').files[0].sha256, f.files[0].sha256);
  assert.match(fs.readFileSync(second.deliveryPath, 'utf8'), /source\.png/);
});

test('recovery plans freeze existing task identity without fabricated submission arguments', t => {
  const f = fixture(t), recovery = { id: 'A', count: 1, projectId: 'project', existingTaskId: 'task-existing', outputNodeId: 'node-existing' };
  const store = createLibTVGenerationStore(f.directory, [recovery], identity);
  assert.deepEqual(store.prepare('A').job, recovery);
  assert.deepEqual(store.jobs, [{ id: 'A', count: 1, dependsOn: [], existingTaskId: 'task-existing' }]);
  for (const change of [{ submitArgs: job().submitArgs }, { submitTool: 'generation_submit' }, { projectId: 'other-project' }, { existingTaskId: 'cop_write' }, { existingTaskId: '' }, { outputNodeId: 'https://example.invalid/node' }]) {
    assert.throws(() => createLibTVGenerationStore(f.directory, [{ ...recovery, ...change }], identity), /已有任务恢复身份/);
  }
  assert.throws(() => createLibTVGenerationStore(f.directory, [recovery, { ...recovery, id: 'B' }], identity), /唯一 ID、幂等键或已有任务身份/);
  assert.throws(() => createLibTVGenerationStore(f.directory, [{ ...recovery, existingTaskId: 'different-task' }], identity), /冻结输入已变化/);
  assert.throws(() => store.writeReceipt('A', { state: 'submitting', taskId: 'task-existing' }), /不能提交/);
  assert.throws(() => store.writeReceipt('A', { state: 'unknown' }), /原 taskId/);
  store.writeReceipt('A', { state: 'pending', taskId: 'task-existing' });
  assert.throws(() => store.writeReceipt('A', { state: 'pending', taskId: 'replacement' }), /原 taskId/);
  assert.throws(() => store.writeReceipt('A', { state: 'generated', taskId: 'task-existing', outputs: [{ nodeId: 'other-node' }] }), /节点与恢复绑定不一致/);
  assert.equal(createLibTVGenerationStore(f.directory, [recovery], identity).readReceipt('A').taskId, 'task-existing');
});

test('multiple recovery plans do not require idempotency keys and cannot reopen interrupted checkpoints', t => {
  const f = fixture(t), jobs = ['A', 'B'].map(id => ({ id, count: 1, projectId: 'project', existingTaskId: `existing-${id}` }));
  const store = createLibTVGenerationStore(f.directory, jobs, identity);
  store.writeReceipt('A', { state: 'pending', taskId: 'existing-A' });
  fs.unlinkSync(path.join(f.directory, 'receipts', 'A-00000001.json'));
  assert.throws(() => createLibTVGenerationStore(f.directory, jobs, identity), /检查点缺失/);
});

test('existing-task delivery recovery persists stage timings and later reopens without remote or download calls', async t => {
  const f = fixture(t), jobs = [{ id: 'A', count: 1, projectId: 'project', existingTaskId: 'task-existing', outputNodeId: 'node-existing' }], calls = [];
  let store = createLibTVGenerationStore(f.directory, jobs, identity);
  const first = await runLibTVGenerationBatch(store.jobs, {
    ...store, allowNewSubmissions: true, recoverUnknownSubmission: true, maxPolls: 1,
    call: async (tool, args) => {
      calls.push(tool);
      assert.equal(tool, 'task_status');
      assert.deepEqual(args, { project_id: 'project', task_id: 'task-existing' });
      assert.equal(store.readReceipt('A').taskId, 'task-existing');
      return { structuredContent: { projectId: args.project_id, taskId: args.task_id, state: 'succeeded', outputs: [{ nodeId: 'node-existing' }] } };
    },
    normalizeTask: response => response.structuredContent,
    finalize: () => { throw new Error('download interrupted'); }
  });
  assert.deepEqual(first.counts, { generated: 1 });
  const firstReport = JSON.parse(fs.readFileSync(first.path, 'utf8')).report;
  assert.equal(firstReport.submitted, 0); assert.equal(firstReport.recoveredSubmissions, 0);
  assert.ok(firstReport.events.some(event => event.type === 'finalize-returned' && event.durationMs >= 0));
  assert.equal(store.readReceipt('A').state, 'generated');
  store = createLibTVGenerationStore(f.directory, jobs, identity);
  let saves = 0;
  const second = await runLibTVGenerationBatch(store.jobs, {
    ...store, allowNewSubmissions: true, recoverUnknownSubmission: true,
    call: () => { throw new Error('generated task must not query or submit'); },
    normalizeTask: () => { throw new Error('generated task must not normalize'); },
    finalize: (entry, receipt) => { saves++; assert.equal(receipt.taskId, 'task-existing'); return { files: f.files }; }
  });
  assert.deepEqual(second.counts, { succeeded: 1 }); assert.equal(saves, 1);
  assert.deepEqual(calls, ['task_status']);
  const secondReport = JSON.parse(fs.readFileSync(second.path, 'utf8')).report;
  assert.equal(secondReport.polls, 0);
  assert.ok(secondReport.events.some(event => event.type === 'prepare-returned' && event.durationMs >= 0));
  assert.ok(secondReport.workDurationMs >= 0);
  store = createLibTVGenerationStore(f.directory, jobs, identity);
  const completed = await runLibTVGenerationBatch(store.jobs, {
    ...store,
    call: () => { throw new Error('saved task must not call remote'); },
    normalizeTask: () => { throw new Error('saved task must not normalize'); },
    finalize: () => { throw new Error('saved file must not download again'); }
  });
  assert.deepEqual(completed.counts, { succeeded: 1 });
  assert.ok(JSON.stringify(completed).length < 1200);
  assert.doesNotMatch(JSON.stringify(completed), /durationMs|events|submitArgs|prompt|base64/);
});

test('remote-only batches persist generated references and compact task indices without downloading files', async t => {
  const f = fixture(t), jobs = [job('B', ['A']), job('A')], calls = [];
  let store = createLibTVGenerationStore(f.directory, jobs, identity);
  const summary = await runLibTVGenerationBatch(store.jobs, {
    ...store, allowNewSubmissions: true, maxPolls: 1,
    call: async (tool, args) => {
      calls.push(tool);
      if (tool === 'generation_submit') {
        if (args.idempotency_key === 'key-B') assert.equal(store.readReceipt('A').state, 'generated');
        return { structuredContent: { task_id: 'task-' + args.idempotency_key.slice(4) } };
      }
      assert.equal(tool, 'task_status');
      return { structuredContent: { projectId: args.project_id, taskId: args.task_id, state: 'succeeded', outputs: [{ nodeId: 'node-' + args.task_id, ignoredPayload: 'not-for-context' }] } };
    },
    normalizeTask: response => response.structuredContent
  });
  assert.deepEqual(summary.counts, { generated: 2 });
  assert.deepEqual(summary.tasks, [
    { id: 'B', status: 'generated', taskId: 'task-B', outputs: [{ nodeId: 'node-task-B' }] },
    { id: 'A', status: 'generated', taskId: 'task-A', outputs: [{ nodeId: 'node-task-A' }] }
  ]);
  assert.ok(JSON.stringify(summary).length < 1600);
  assert.doesNotMatch(JSON.stringify(summary), /not-for-context|submitArgs|base64|timings/);
  const index = fs.readFileSync(summary.deliveryPath, 'utf8');
  assert.match(index, /批次任务索引/); assert.match(index, /未执行本地下载/);
  assert.doesNotMatch(index, /确认文件与哈希/);
  for (const entry of jobs) { const receipt = store.readReceipt(entry.id); assert.equal(receipt.state, 'generated'); assert.equal(receipt.files, undefined); }
  assert.ok(calls.every(tool => ['generation_submit', 'task_status'].includes(tool)));
  store = createLibTVGenerationStore(f.directory, jobs, identity);
  const resumed = await runLibTVGenerationBatch(store.jobs, {
    ...store,
    call: () => { throw new Error('generated restart must not call remote'); },
    normalizeTask: () => { throw new Error('generated restart must not parse a response'); }
  });
  assert.deepEqual(resumed.tasks, summary.tasks);
  assert.deepEqual(resumed.counts, { generated: 2 });
});

test('generated receipts reject missing, extra or non-opaque outputs and summaries use durable references', t => {
  const f = fixture(t), store = createLibTVGenerationStore(f.directory, [job()], identity);
  for (const outputs of [undefined, [], [{ nodeId: 'n1' }, { nodeId: 'n2' }], [{ nodeId: 'https://example.invalid/not-an-id' }]]) {
    assert.throws(() => store.writeReceipt('A', { state: 'generated', taskId: 'task-A', outputs }), /产物数量|产物引用/);
  }
  store.writeReceipt('A', { state: 'generated', taskId: 'task-A', outputs: [{ nodeId: 'verified-node', rawPixels: 'never-return-this' }] });
  const summary = store.summarize([{ id: 'A', status: 'generated', taskId: 'task-A', outputs: [{ nodeId: 'forged-result' }] }], { deliveryAllowed: true, localFinalization: false });
  assert.deepEqual(summary.tasks[0].outputs, [{ nodeId: 'verified-node' }]);
  assert.doesNotMatch(JSON.stringify(summary), /rawPixels|never-return-this|forged-result/);
  store.setControl({ paused: true });
  const paused = store.summarize([{ id: 'A', status: 'generated', taskId: 'task-A' }], { deliveryAllowed: true, localFinalization: false });
  assert.equal(paused.deliveryAllowed, false); assert.equal(paused.tasks[0].outputs, undefined);
});

test('new plans enforce current image request shape while frozen legacy requests recover unchanged', async t => {
  const f = fixture(t);
  for (const change of [args => { delete args.kind; }, args => { args.kind = 'video'; }, args => { delete args.request.prompt; }, args => { args.request.prompt = ' '; }, args => { args.request.params = JSON.stringify(args.request.params); }]) {
    const entry = job(); change(entry.submitArgs);
    assert.throws(() => createLibTVGenerationStore(f.directory, [entry], identity), /明确单张/);
  }
  createLibTVGenerationStore(f.directory, [job()], identity);
  const planFile = path.join(f.directory, 'batch.json'), legacy = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  delete legacy.jobs[0].submitArgs.kind;
  const request = legacy.jobs[0].submitArgs.request;
  request.params = JSON.stringify({ count: 1, prompt: request.prompt }); delete request.prompt;
  fs.writeFileSync(planFile, JSON.stringify(legacy), 'utf8');
  const originalArgs = structuredClone(legacy.jobs[0].submitArgs), store = createLibTVGenerationStore(f.directory, legacy.jobs, identity);
  const blocked = await runLibTVGenerationBatch(store.jobs, {
    ...store, allowNewSubmissions: true,
    call: () => { throw new Error('unaccepted legacy request cannot create a new task'); },
    normalizeTask: () => { throw new Error('no remote response'); }
  });
  assert.deepEqual(blocked.counts, { unknown: 1 });
  assert.equal(store.readReceipt('A'), null);
  const attached = store.acquire();
  store.writeReceipt('A', { state: 'pending', taskId: 'legacy-task' }, { context: attached });
  store.release(attached);
  const calls = [];
  const recovered = await runLibTVGenerationBatch(store.jobs, {
    ...store, maxPolls: 1,
    call: async (tool, args) => {
      calls.push(tool); assert.equal(tool, 'task_status');
      return { projectId: args.project_id, taskId: args.task_id, state: 'succeeded', outputs: [{ nodeId: 'legacy-node' }] };
    },
    normalizeTask: response => response
  });
  assert.deepEqual(recovered.counts, { generated: 1 }); assert.deepEqual(calls, ['task_status']);
  assert.deepEqual(store.prepare('A').job.submitArgs, originalArgs);
  assert.deepEqual(JSON.parse(fs.readFileSync(planFile, 'utf8')).jobs[0].submitArgs, originalArgs);
});

test('expired acquisition contexts and stale release owners cannot affect a replacement coordinator', t => {
  const f = fixture(t), store = createLibTVGenerationStore(f.directory, [job()], identity);
  assert.throws(() => store.acquire({ owner: 'expired', deadlineAt: Date.now() - 1 }), error => error.code === 'CALL_TIMEOUT');
  assert.equal(fs.existsSync(path.join(f.directory, 'coordinator.lock')), false);
  const first = store.acquire();
  assert.equal(store.release(first), true);
  const second = store.acquire();
  assert.equal(store.release(first), false);
  assert.equal(store.inspectLock().owner, second.owner);
  assert.equal(store.release(second), true);
});

test('a timed-out acquire that arrives after a new coordinator is rejected by its original deadline', { timeout: 2000 }, async t => {
  const f = fixture(t), jobs = [job()], store = createLibTVGenerationStore(f.directory, jobs, identity), gate = deferred(), settled = deferred();
  const result = await runLibTVGenerationBatch(store.jobs, {
    ...store, localTimeoutMs: 20,
    acquire: async context => { try { await gate.promise; return store.acquire(context); } finally { settled.resolve(); } },
    call: () => { throw new Error('no remote call before acquisition'); },
    normalizeTask: response => response
  });
  assert.equal(result.incomplete, true);
  assert.equal(result.ownershipUnknown, true);
  const second = createLibTVGenerationStore(f.directory, jobs, identity), secondOwner = second.acquire();
  gate.resolve();
  await settled.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.inspectLock().owner, secondOwner.owner);
  assert.equal(second.release(secondOwner), true);
  assert.equal(store.readReceipt('A'), null);
});

test('late receipt writes retain the original coordinator lock and cannot reopen a fresh submission', { timeout: 2000 }, async t => {
  const f = fixture(t), jobs = [job()], store = createLibTVGenerationStore(f.directory, jobs, identity), gate = deferred(), released = deferred();
  let calls = 0;
  const result = await runLibTVGenerationBatch(store.jobs, {
    ...store, allowNewSubmissions: true, localTimeoutMs: 20,
    writeReceipt: async (...args) => { if (args[1].state === 'pending') await gate.promise; return store.writeReceipt(...args); },
    release: context => { const value = store.release(context); released.resolve(); return value; },
    call: () => { calls++; return { structuredContent: { task_id: 'task-original' } }; },
    normalizeTask: response => response
  });
  assert.equal(result.lockRetained, true);
  assert.equal(result.persistedSummary, false);
  const reopened = createLibTVGenerationStore(f.directory, jobs, identity);
  assert.throws(() => reopened.acquire(), { code: 'EEXIST' });
  gate.resolve();
  await released.promise;
  assert.equal(reopened.readReceipt('A').state, 'submitting');
  const resumed = await runLibTVGenerationBatch(reopened.jobs, {
    ...reopened, allowNewSubmissions: true, localTimeoutMs: 20,
    call: () => { calls++; throw new Error('unidentified prior submission cannot be resent'); },
    normalizeTask: response => response
  });
  assert.equal(calls, 1);
  assert.equal(resumed.counts.unknown, 1);
});

test('late local finalization stays isolated until settlement and resumes from the same generated task', { timeout: 2000 }, async t => {
  const f = fixture(t), jobs = [job()], store = createLibTVGenerationStore(f.directory, jobs, identity), gate = deferred(), released = deferred();
  store.writeReceipt('A', { state: 'generated', taskId: 'task-original', outputs: [{ nodeId: 'node-original' }] });
  const file = path.join(f.root, 'late-finalized.png'); f.savedPaths.push(file);
  const save = () => {
    if (!fs.existsSync(file)) fs.copyFileSync(f.source, file, fs.constants.COPYFILE_EXCL);
    return { files: [{ path: file, sha256: f.files[0].sha256 }] };
  };
  let calls = 0;
  const options = {
    ...store, allowNewSubmissions: true, localTimeoutMs: 20,
    finalize: async () => { await gate.promise; return save(); },
    release: context => { const value = store.release(context); released.resolve(); return value; },
    call: () => { calls++; throw new Error('generated task must never resubmit'); },
    normalizeTask: response => response
  };
  const result = await runLibTVGenerationBatch(store.jobs, options);
  assert.equal(result.lockRetained, true);
  assert.equal(result.results[0].taskId, 'task-original');
  const reopened = createLibTVGenerationStore(f.directory, jobs, identity);
  assert.throws(() => reopened.acquire(), { code: 'EEXIST' });
  gate.resolve();
  await released.promise;
  assert.equal(fs.existsSync(file), true);
  assert.equal(store.readReceipt('A').state, 'generated', 'a timed-out callback cannot resume runner persistence');
  const resumed = await runLibTVGenerationBatch(reopened.jobs, { ...options, ...reopened, finalize: save });
  assert.equal(resumed.counts.succeeded, 1);
  assert.equal(reopened.readReceipt('A').taskId, 'task-original');
  assert.equal(calls, 0);
});

test('captured owner contexts reject stale and context-free writes after the same store is reacquired', t => {
  const f = fixture(t), store = createLibTVGenerationStore(f.directory, [job()], identity);
  const first = store.acquire();
  const firstContext = { owner: first.owner, deadlineAt: Date.now() + 10000 };
  store.writeReceipt('A', { state: 'pending', taskId: 'task-original' }, { context: firstContext });
  store.release(firstContext);
  const second = store.acquire(), secondContext = { owner: second.owner, deadlineAt: Date.now() + 10000 };
  store.writeReceipt('A', { state: 'unknown', taskId: 'task-original', error: 'new owner state' }, { context: secondContext });
  const before = fs.readdirSync(f.directory).sort(), receiptCount = fs.readdirSync(path.join(f.directory, 'receipts')).length;
  for (const write of [
    () => store.writeReceipt('A', { state: 'pending', taskId: 'task-original' }, { context: firstContext }),
    () => store.writeReceipt('A', { state: 'pending', taskId: 'task-original' }),
    () => store.acknowledgeControl({ ...store.readControl(), observedAt: new Date().toISOString(), effectiveAt: new Date().toISOString() }, firstContext),
    () => store.summarize([{ id: 'A', status: 'unknown', taskId: 'task-original' }], { deliveryAllowed: true }, firstContext)
  ]) assert.throws(write, /owner/);
  assert.equal(store.readReceipt('A').error, 'new owner state');
  assert.equal(fs.readdirSync(path.join(f.directory, 'receipts')).length, receiptCount);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), before);
  assert.equal(store.release(firstContext), false);
  assert.equal(store.inspectLock().owner, second.owner);
  store.release(secondContext);
});

test('a live child with a permanently pending finalizer cannot be recovered; its dead owner resumes only the original task', { timeout: 10000 }, async t => {
  const f = fixture(t), jobs = [job()], store = createLibTVGenerationStore(f.directory, jobs, identity);
  store.writeReceipt('A', { state: 'generated', taskId: 'task-original', outputs: [{ nodeId: 'node-original' }] });
  const child = localStoreProcess(f, jobs, `
    const result=await runLibTVGenerationBatch(store.jobs,{...store,localTimeoutMs:20,call:()=>{throw Error('no MCP allowed')},normalizeTask:response=>response,finalize:()=>new Promise(()=>{})});
    process.send({result,lock:store.inspectLock()});
    setInterval(()=>{},1000);
  `);
  const message = await childMessage(child);
  assert.equal(message.result.incomplete, true);
  assert.equal(message.result.lockRetained, true);
  assert.equal(message.lock.pid, child.pid);
  assert.throws(() => store.recoverLock({ owner: message.lock.owner, reason: 'mock live process must remain isolated' }), error => error.code === 'LOCK_OWNER_ALIVE');
  assert.throws(() => store.acquire(), { code: 'EEXIST' });
  const exited = once(child, 'exit'); child.kill(); await exited;
  assert.equal(store.recoverLock({ owner: message.lock.owner, reason: 'mock original child has exited' }), true);
  let calls = 0;
  const resumed = await runLibTVGenerationBatch(store.jobs, {
    ...store, localTimeoutMs: 1000,
    call: () => { calls++; throw new Error('recovery cannot generate'); },
    normalizeTask: response => response,
    finalize: () => ({ files: f.files })
  });
  assert.equal(resumed.counts.succeeded, 1);
  assert.equal(store.readReceipt('A').taskId, 'task-original');
  assert.equal(calls, 0);
});

test('a late child callback cannot write or release after its owner handed the batch to another process', { timeout: 10000 }, async t => {
  const f = fixture(t), jobs = [job()], store = createLibTVGenerationStore(f.directory, jobs, identity);
  const child = localStoreProcess(f, jobs, `
    const acquired=store.acquire();
    const context={owner:acquired.owner,deadlineAt:Date.now()+60000};
    store.writeReceipt('A',{state:'pending',taskId:'task-original'},{context});
    process.send({phase:'owned',owner:acquired.owner});
    process.on('message',command=>{
      if(command==='release'){store.release(context);process.send({phase:'released'});return;}
      const errors=[];
      for(const action of [
        ()=>store.writeReceipt('A',{state:'pending',taskId:'task-original',error:'stale callback'},{context}),
        ()=>store.writeReceipt('A',{state:'pending',taskId:'task-original',error:'missing owner'}),
        ()=>store.acknowledgeControl({...store.readControl(),observedAt:new Date().toISOString(),effectiveAt:new Date().toISOString()},context),
        ()=>store.summarize([{id:'A',status:'unknown',taskId:'task-original'}],{deliveryAllowed:true},context)
      ]){try{action();errors.push(null)}catch(error){errors.push(error.code??error.message)}}
      process.send({phase:'late',errors,released:store.release(context)});
    });
  `);
  await childMessage(child);
  const released = childMessage(child); child.send('release'); await released;
  const acquired = store.acquire(), context = { owner: acquired.owner, deadlineAt: Date.now() + 60000 };
  store.writeReceipt('A', { state: 'unknown', taskId: 'task-original', error: 'new owner state' }, { context });
  const receiptCount = fs.readdirSync(path.join(f.directory, 'receipts')).length, names = fs.readdirSync(f.directory).sort();
  const late = childMessage(child); child.send('late'); const message = await late;
  assert.ok(message.errors.every(error => typeof error === 'string' && error.length));
  assert.equal(message.released, false);
  assert.equal(store.inspectLock().owner, acquired.owner);
  assert.equal(store.readReceipt('A').error, 'new owner state');
  assert.equal(fs.readdirSync(path.join(f.directory, 'receipts')).length, receiptCount);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), names);
  store.release(context);
});
