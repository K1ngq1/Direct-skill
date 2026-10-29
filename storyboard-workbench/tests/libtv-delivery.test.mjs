import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createProcessLock } from '../scripts/process_lock.mjs';
import { validateLibTVExistingImage, validateLibTVImageDelivery, runLibTVImageDelivery, libtvDeliveryHostSource } from '../scripts/libtv_delivery.mjs';

const clone = value => structuredClone(value);
const job = { id: 'existing-image', projectId: 'project-test', taskId: 'task-test', nodeId: 'node-test', idempotencyKey: 'delivery-test', watermark: 'remove' };
const hash = 'a'.repeat(64);
const source = () => ({ structuredContent: {
  projectId: job.projectId, nodeId: job.nodeId,
  node: { id: job.nodeId, data: { type: 'image', taskInfo: { taskId: job.taskId, loading: false }, url: ['https://example.invalid/observed-node.png'] } },
  mediaPersistence: { nodes: [{ nodeId: job.nodeId, bindingStatus: 'present', readUrlCount: 1 }] }
} });
const manifest = () => ({ structuredContent: {
  projectId: job.projectId, status: 'ready', delivery: 'awaiting_host_save', fileCount: 1, sourceValidation: 'rechecked-after-preparation',
  files: [{ nodeId: job.nodeId, taskId: job.taskId, outputIndex: 0, mime: 'image/png', sourceIdentity: 'source-test', url: 'https://example.invalid/authorized-image.png', contentHash: hash, derivation: { kind: 'watermark', watermark: false } }]
} });
const savedImage = () => ({ path: path.resolve('mock-saved-image.png'), sha256: hash, bytes: 123, width: 32, height: 24, reused: false, timings: [{ stage: 'download', durationMs: 2 }] });

function harness() {
  let receipt = null;
  const calls = [], writes = [], saves = [];
  const options = {
    call: async (tool, args) => {
      calls.push([tool, clone(args)]);
      if (tool === 'read_node') return source();
      assert.equal(tool, 'prepare_project_delivery', 'no generation or upload tool may be called');
      return manifest();
    },
    readReceipt: async (entry, stage) => { assert.equal(stage, 'delivery'); return clone(receipt); },
    writeReceipt: async (entry, stage, value, { exclusive = false } = {}) => {
      assert.equal(stage, 'delivery');
      if (exclusive) assert.equal(receipt, null);
      receipt = clone(value); writes.push(clone(value));
    },
    saveImage: async value => { saves.push(clone(value)); return savedImage(); }
  };
  return { options, calls, writes, saves, receipt: () => clone(receipt) };
}

test('observed node contract binds project/task/image without asserting task success', () => {
  assert.deepEqual(validateLibTVExistingImage(source(), job), { projectId: job.projectId, taskId: job.taskId, nodeId: job.nodeId, taskState: 'unknown', binding: 'present' });
});

test('node identity, media type, stale/loading state and single-image persistence fail closed', async t => {
  const invalid = [
    ['project', body => { body.projectId = 'other'; }],
    ['top-level node', body => { body.nodeId = 'other'; }],
    ['nested node', body => { body.node.id = 'other'; }],
    ['task', body => { body.node.data.taskInfo.taskId = 'other'; }],
    ['type', body => { body.node.data.type = 'video'; }],
    ['loading', body => { body.node.data.taskInfo.loading = true; }],
    ['stale', body => { body.node.data.isStale = true; }],
    ['missing binding', body => { body.mediaPersistence.nodes[0].bindingStatus = 'missing'; }],
    ['read count', body => { body.mediaPersistence.nodes[0].readUrlCount = 2; }],
    ['url count', body => { body.node.data.url.push('https://example.invalid/second.png'); }]
  ];
  for (const [name, corrupt] of invalid) await t.test(name, () => {
    const response = source(); corrupt(response.structuredContent);
    assert.throws(() => validateLibTVExistingImage(response, job), /身份不匹配|绑定不可用/);
  });
});

test('manifest enforces ready delivery, source recheck, identity, count, MIME, hash and HTTPS URL', async t => {
  const invalid = [
    ['project', body => { body.projectId = 'other'; }],
    ['not ready', body => { body.status = 'processing'; }],
    ['delivery state', body => { body.delivery = 'saved'; }],
    ['count', body => { body.fileCount = 2; }],
    ['files count', body => { body.files.push(clone(body.files[0])); }],
    ['source check', body => { body.sourceValidation = 'unchecked'; }],
    ['node', body => { body.files[0].nodeId = 'other'; }],
    ['task', body => { body.files[0].taskId = 'other'; }],
    ['output index', body => { body.files[0].outputIndex = 1; }],
    ['MIME', body => { body.files[0].mime = 'video/mp4'; }],
    ['source identity', body => { body.files[0].sourceIdentity = ''; }],
    ['hash', body => { body.files[0].contentHash = 'not-a-byte-hash'; }],
    ['HTTP', body => { body.files[0].url = 'http://example.invalid/image.png'; }],
    ['credentials', body => { body.files[0].url = 'https://user:password@example.invalid/image.png'; }],
    ['invalid URL', body => { body.files[0].url = 'not a url'; }],
    ['watermark', body => { body.files[0].derivation.watermark = true; }]
  ];
  for (const [name, corrupt] of invalid) await t.test(name, () => {
    const response = manifest(); corrupt(response.structuredContent);
    assert.throws(() => validateLibTVImageDelivery(response, job), /不匹配|未就绪|未识别|URL 无效|HTTPS|水印/);
  });
});

test('needs_preference account to remove preserves the same delivery key and does not save prematurely', async () => {
  const mock = harness(), call = mock.options.call;
  mock.options.call = async (tool, args) => {
    if (tool === 'prepare_project_delivery' && args.watermark === 'account') {
      mock.calls.push([tool, clone(args)]);
      return { structuredContent: { projectId: job.projectId, status: 'needs_preference', delivery: 'needs_preference' } };
    }
    return call(tool, args);
  };
  const first = await runLibTVImageDelivery({ ...job, watermark: 'account' }, mock.options);
  assert.equal(first.state, 'needs_preference'); assert.equal(mock.saves.length, 0);
  const callsBefore = mock.calls.length;
  const stillWaiting = await runLibTVImageDelivery({ ...job, watermark: 'account' }, mock.options);
  assert.equal(stillWaiting.state, 'needs_preference'); assert.equal(mock.calls.length, callsBefore);
  const resumed = await runLibTVImageDelivery(job, mock.options);
  assert.equal(resumed.state, 'saved'); assert.equal(resumed.taskState, 'unknown');
  const requests = mock.calls.filter(([tool]) => tool === 'prepare_project_delivery').map(([, args]) => args);
  assert.deepEqual(requests.map(request => [request.idempotencyKey, request.watermark]), [[job.idempotencyKey, 'account'], [job.idempotencyKey, 'remove']]);
  assert.equal(mock.saves.length, 1);
  assert.equal(mock.saves[0].url, 'https://example.invalid/authorized-image.png');
  assert.equal(mock.saves[0].expectedSha256, hash);
});

test('unknown preparation response is never resent and never falls back to the node raw link', async t => {
  for (const failure of ['disconnect', 'unrecognized-response']) await t.test(failure, async () => {
    const mock = harness(), call = mock.options.call;
    mock.options.call = async (tool, args) => {
      if (tool === 'get_web_operation_status') {
        mock.calls.push([tool, clone(args)]);
        return { structuredContent: { projectId: job.projectId, operationId: 'operation-test', operation: 'prepare_delivery_item', status: 'completed', result: { url: 'https://example.invalid/operation-result.png', sourceIdentity: 'source-test' } } };
      }
      if (tool !== 'prepare_project_delivery') return call(tool, args);
      mock.calls.push([tool, clone(args)]);
      if (failure === 'disconnect') throw new Error('connection interrupted');
      return { structuredContent: { projectId: job.projectId, operationIds: ['operation-test'], status: 'pending', delivery: 'pending' } };
    };
    await assert.rejects(runLibTVImageDelivery(job, mock.options), /响应未知|尚未就绪/);
    assert.equal(mock.receipt().state, failure === 'disconnect' ? 'requesting' : 'unknown');
    const callsBefore = mock.calls.length;
    await assert.rejects(runLibTVImageDelivery(job, mock.options), /结果未知/);
    assert.equal(mock.calls.length, callsBefore + (failure === 'disconnect' ? 0 : 1));
    if (failure === 'unrecognized-response') {
      assert.deepEqual(mock.calls.at(-1), ['get_web_operation_status', { projectId: job.projectId, operationId: 'operation-test' }]);
      assert.deepEqual(mock.receipt().operations, [{ operationId: 'operation-test', status: 'completed' }]);
      assert.equal(mock.receipt().state, 'unknown');
    }
    assert.equal(mock.saves.length, 0);
    assert.equal(mock.calls.filter(([tool]) => tool === 'prepare_project_delivery').length, 1);
  });
});

test('unknown delivery operation recovery rejects changed project, operation identity or kind', async t => {
  for (const changed of [{ projectId: 'other-project' }, { operationId: 'other-operation' }, { operation: 'generate_image' }]) await t.test(JSON.stringify(changed), async () => {
    const mock = harness(), call = mock.options.call;
    mock.options.call = async (tool, args) => {
      if (tool === 'prepare_project_delivery') {
        mock.calls.push([tool, clone(args)]);
        return { structuredContent: { projectId: job.projectId, operationIds: ['operation-test'], status: 'pending', delivery: 'pending' } };
      }
      if (tool === 'get_web_operation_status') {
        mock.calls.push([tool, clone(args)]);
        return { structuredContent: { projectId: job.projectId, operationId: 'operation-test', operation: 'prepare_delivery_item', status: 'completed', ...changed } };
      }
      return call(tool, args);
    };
    await assert.rejects(runLibTVImageDelivery(job, mock.options), /尚未就绪/);
    await assert.rejects(runLibTVImageDelivery(job, mock.options), /原交付操作回读身份不匹配/);
    assert.equal(mock.calls.filter(([tool]) => tool === 'prepare_project_delivery').length, 1);
    assert.equal(mock.saves.length, 0);
    assert.equal(mock.receipt().state, 'unknown');
  });
});

test('interrupted download preserves ready, restart only saves, and saved restart performs no remote request', async () => {
  const mock = harness(), save = mock.options.saveImage;
  mock.options.saveImage = async () => { throw new Error('download interrupted'); };
  const firstReport = {};
  await assert.rejects(runLibTVImageDelivery(job, { ...mock.options, report: firstReport }), /download interrupted/);
  assert.equal(mock.receipt().state, 'ready');
  assert.ok(firstReport.events.some(event => event.stage === 'local-file' && event.outcome === 'failed' && event.durationMs >= 0));
  const callsBefore = mock.calls.length;
  mock.options.saveImage = save;
  const resumed = await runLibTVImageDelivery(job, mock.options);
  assert.equal(resumed.state, 'saved'); assert.equal(resumed.taskState, 'unknown');
  assert.equal(mock.calls.length, callsBefore); assert.equal(mock.saves.length, 1);
  mock.options.saveImage = async value => ({ ...(await save(value)), reused: true });
  const completed = await runLibTVImageDelivery(job, mock.options);
  assert.equal(mock.calls.length, callsBefore); assert.equal(completed.reused, true);
  assert.equal(completed.taskState, 'unknown');
  assert.equal(completed.report.remoteCalls, 0);
  for (const result of [resumed, completed]) {
    assert.equal(result.report.generationCalls, 0); assert.equal(result.report.uploadCalls, 0);
    assert.ok(result.report.events.every(event => Number.isFinite(event.durationMs) && event.durationMs >= 0));
  }
  assert.ok(mock.receipt().timings.every(event => Number.isFinite(event.durationMs) && event.durationMs >= 0));
  assert.doesNotMatch(JSON.stringify(completed), /example\.invalid|observed-node|authorized-image/);
});

test('delivery receipt identity and watermark are immutable after preparation', async () => {
  const mock = harness();
  await runLibTVImageDelivery(job, mock.options);
  const callsBefore = mock.calls.length;
  await assert.rejects(runLibTVImageDelivery({ ...job, taskId: 'replacement-task' }, mock.options), /回执身份已变化/);
  await assert.rejects(runLibTVImageDelivery({ ...job, watermark: 'keep' }, mock.options), /水印选择不能变化/);
  assert.equal(mock.calls.length, callsBefore);
});

test('cached request project, key, item identity and output index must match before any call', async t => {
  for (const [name, change] of [
    ['project', request => { request.projectId = 'other'; }],
    ['key', request => { request.idempotencyKey = 'other'; }],
    ['node', request => { request.items[0].nodeId = 'other'; }],
    ['index', request => { request.items[0].outputIndex = 1; }],
    ['kind', request => { request.items[0].kind = 'video'; }],
    ['count', request => { request.items.push(clone(request.items[0])); }]
  ]) await t.test(name, async () => {
    const mock = harness();
    await runLibTVImageDelivery(job, mock.options);
    const receipt = mock.receipt(); change(receipt.request);
    mock.options.readReceipt = async () => clone(receipt);
    const callsBefore = mock.calls.length, savesBefore = mock.saves.length;
    await assert.rejects(runLibTVImageDelivery(job, mock.options), /缓存交付请求身份不匹配/);
    assert.equal(mock.calls.length, callsBefore); assert.equal(mock.saves.length, savesBefore);
  });
});

test('invalid local save evidence cannot become saved', async t => {
  for (const invalid of [{ sha256: 'bad' }, { bytes: 0 }, { width: 0 }, { height: 0 }, { path: '' }, { path: '  ' }, { path: {} }, { width: '32' }, { height: '24' }, { width: Infinity }, { height: Infinity }, { width: 1.5 }, { height: 1.5 }]) await t.test(JSON.stringify(invalid), async () => {
    const mock = harness(); mock.options.saveImage = async () => ({ ...savedImage(), ...invalid });
    await assert.rejects(runLibTVImageDelivery(job, mock.options), /缺少字节、哈希或完整解码证据/);
    assert.equal(mock.receipt().state, 'ready');
    assert.equal(mock.writes.some(receipt => receipt.state === 'saved'), false);
  });
});

test('manifest byte hash must match the saved file hash', async () => {
  const mock = harness(); mock.options.saveImage = async () => ({ ...savedImage(), sha256: 'b'.repeat(64) });
  await assert.rejects(runLibTVImageDelivery(job, mock.options), /哈希/);
  assert.equal(mock.receipt().state, 'ready');
});

test('host-source is self-contained and supports a host without performance or URL', async () => {
  const sourceCode = libtvDeliveryHostSource();
  assert.doesNotMatch(sourceCode, /^import\s/m);
  const run = vm.runInNewContext(`${sourceCode}\nrunLibTVImageDelivery;`, { setTimeout, clearTimeout });
  const mock = harness(), result = await run(job, mock.options);
  assert.equal(result.state, 'saved'); assert.equal(result.taskState, 'unknown');
  assert.ok(result.report.events.every(event => event.durationMs >= 0 && event.durationSource === 'wall-clock'));
});

test('a stalled delivery preparation retains the original request and ignores a late ready response', { timeout: 2000 }, async () => {
  const mock = harness(), call = mock.options.call;
  let resolveLate;
  const late = new Promise(resolve => { resolveLate = resolve; });
  mock.options.call = async (tool, args) => {
    if (tool !== 'prepare_project_delivery') return call(tool, args);
    mock.calls.push([tool, clone(args)]);
    return late;
  };
  await assert.rejects(runLibTVImageDelivery(job, { ...mock.options, callTimeoutMs: 20 }), error => {
    assert.equal(error.code, 'CALL_TIMEOUT');
    assert.match(error.message, /响应未知/);
    return true;
  });
  assert.equal(mock.receipt().state, 'requesting');
  assert.equal(mock.receipt().request.idempotencyKey, job.idempotencyKey);
  const before = mock.receipt(), writesBefore = mock.writes.length;
  resolveLate(manifest());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(mock.receipt(), before);
  assert.equal(mock.writes.length, writesBefore);
  await assert.rejects(runLibTVImageDelivery(job, mock.options), /结果未知/);
  assert.equal(mock.calls.filter(([tool]) => tool === 'prepare_project_delivery').length, 1);
  assert.deepEqual(mock.saves, []);
});

test('read-only delivery calls also have a deadline and invalid deadlines perform no I/O', { timeout: 2000 }, async () => {
  const mock = harness();
  for (const callTimeoutMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
    await assert.rejects(runLibTVImageDelivery(job, { ...mock.options, callTimeoutMs }), /调用期限无效/);
  }
  assert.deepEqual(mock.calls, []);
  const run = vm.runInNewContext(`${libtvDeliveryHostSource()}\nrunLibTVImageDelivery;`, { setTimeout, clearTimeout });
  await assert.rejects(run(job, { ...mock.options, callTimeoutMs: 20, call: () => new Promise(() => {}) }), error => error.code === 'CALL_TIMEOUT');
  assert.equal(mock.receipt(), null);
  assert.deepEqual(mock.saves, []);
});

test('observed unsupported tool use rejects delivery before reading receipts or calling MCP', async () => {
  const mock = harness();
  const run = { capabilities: { toolUse: 'unsupported' }, capabilityObservations: { toolUse: { status: 'unsupported', evidence: 'local mock denied tool calls', observedAt: '2026-10-27T00:00:00.000Z' } } };
  mock.options.readReceipt = async () => { throw new Error('capability gate must precede receipt I/O'); };
  await assert.rejects(runLibTVImageDelivery(job, { ...mock.options, run }), error => error.issue?.code === 'RUNTIME_CAPABILITY_UNSUPPORTED');
  assert.deepEqual(mock.calls, []);
  assert.deepEqual(mock.saves, []);
});

test('local callback deadlines retain the lease until the original callback settles', { timeout: 3000 }, async t => {
  for (const stage of ['readReceipt', 'writeReceipt', 'saveImage']) await t.test(stage, async () => {
    const mock = harness(), original = mock.options[stage];
    let resolveLate, calls = 0;
    const late = new Promise(resolve => { resolveLate = resolve; });
    mock.options[stage] = async (...args) => { calls++; await late; return original(...args); };
    await assert.rejects(runLibTVImageDelivery(job, { ...mock.options, localTimeoutMs: 20 }), error => error.code === 'CALL_TIMEOUT');
    const before = { calls, remote: mock.calls.length, writes: mock.writes.length };
    await assert.rejects(runLibTVImageDelivery(job, mock.options), error => error.code === 'LOCAL_CALLBACK_PENDING');
    assert.deepEqual({ calls, remote: mock.calls.length, writes: mock.writes.length }, before);
    resolveLate();
    await new Promise(resolve => setImmediate(resolve));
    mock.options[stage] = original;
    assert.equal(mock.writes.some(receipt => receipt.state === 'saved'), false, 'late callback must not resume abandoned delivery');
    if (stage === 'writeReceipt') {
      assert.equal(mock.receipt().state, 'requesting');
      await assert.rejects(runLibTVImageDelivery(job, mock.options), /结果未知/);
      assert.equal(mock.calls.filter(([tool]) => tool === 'prepare_project_delivery').length, 0);
    } else {
      assert.equal((await runLibTVImageDelivery(job, mock.options)).state, 'saved');
      assert.equal(mock.calls.filter(([tool]) => tool === 'prepare_project_delivery').length, 1);
    }
  });
});

test('host-source reload retains pending callback protection and invalid local limits perform no I/O', { timeout: 2000 }, async () => {
  const context = vm.createContext({ setTimeout, clearTimeout }), mock = harness();
  const sourceCode = `${libtvDeliveryHostSource()}\nrunLibTVImageDelivery;`;
  const first = vm.runInContext(sourceCode, context);
  for (const localTimeoutMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
    await assert.rejects(first(job, { ...mock.options, localTimeoutMs }), /调用期限无效/);
  }
  assert.deepEqual(mock.calls, []);
  let resolveLate;
  const late = new Promise(resolve => { resolveLate = resolve; });
  await assert.rejects(first(job, { ...mock.options, localTimeoutMs: 20, readReceipt: () => late }), error => error.code === 'CALL_TIMEOUT');
  const second = vm.runInContext(sourceCode, context);
  await assert.rejects(second(job, mock.options), error => error.code === 'LOCAL_CALLBACK_PENDING');
  resolveLate(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await second(job, mock.options)).state, 'saved');
});

test('persistent ownership context reaches callbacks and an unresolved unlock retains the local lease', { timeout: 2000 }, async () => {
  const mock = harness(), contexts = [], originalWrite = mock.options.writeReceipt;
  let resolveRelease;
  const pendingRelease = new Promise(resolve => { resolveRelease = resolve; });
  const options = {
    ...mock.options, localTimeoutMs: 20,
    acquire: async context => { assert.ok(context.deadlineAt > Date.now()); return { owner: 'delivery-test-owner' }; },
    assertOwner: context => { assert.equal(context.owner, 'delivery-test-owner'); assert.ok(Number.isSafeInteger(context.deadlineAt)); },
    release: () => pendingRelease,
    writeReceipt: (entry, stage, value, options) => { contexts.push(options.context); return originalWrite(entry, stage, value, options); }
  };
  await assert.rejects(runLibTVImageDelivery(job, options), error => error.code === 'CALL_TIMEOUT');
  assert.equal(mock.receipt().state, 'saved');
  assert.ok(contexts.length > 0 && contexts.every(context => context.owner === 'delivery-test-owner'));
  await assert.rejects(runLibTVImageDelivery(job, options), error => error.code === 'LOCAL_CALLBACK_PENDING');
  resolveRelease(); await new Promise(resolve => setImmediate(resolve));
  const result = await runLibTVImageDelivery(job, { ...options, release: async () => {} });
  assert.equal(result.state, 'saved'); assert.equal(result.report.persistentOwnership, true);
});

test('partial persistent lock bridges fail before any receipt or tool call', async () => {
  const mock = harness();
  mock.options.readReceipt = () => { throw new Error('must not read'); };
  for (const patch of [{ acquire() {} }, { release() {}, assertOwner() {} }, { acquire() {}, release() {}, assertOwner: null }]) {
    await assert.rejects(runLibTVImageDelivery(job, { ...mock.options, ...patch }), /完整的 acquire/);
  }
  assert.deepEqual(mock.calls, []);
});

test('a late ownership check cannot start the abandoned callback', { timeout: 2000 }, async () => {
  const mock = harness();
  let resolveCheck, reads = 0, releases = 0;
  const late = new Promise(resolve => { resolveCheck = resolve; });
  await assert.rejects(runLibTVImageDelivery(job, {
    ...mock.options, localTimeoutMs: 20,
    acquire: async () => ({ owner: 'late-ownership-check' }), assertOwner: () => late,
    release: async () => { releases++; },
    readReceipt: async () => { reads++; return null; }
  }), error => error.code === 'CALL_TIMEOUT');
  resolveCheck(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0); assert.equal(releases, 1); assert.deepEqual(mock.calls, []);
});

test('persistent callback fences reject late writes after the delivery deadline', { timeout: 2000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libtv-delivery-fence-')), lock = createProcessLock(path.join(root, 'delivery.lock'));
  const mock = harness(), write = mock.options.writeReceipt;
  let resolveWrite;
  const late = new Promise(resolve => { resolveWrite = resolve; });
  await assert.rejects(runLibTVImageDelivery(job, {
    ...mock.options, ...lock, localTimeoutMs: 20,
    writeReceipt: async (...args) => { await late; lock.assertOwner(args[3].context); return write(...args); }
  }), error => error.code === 'CALL_TIMEOUT');
  const original = lock.inspect();
  assert.ok(original.owner);
  assert.throws(() => createProcessLock(path.join(root, 'delivery.lock')).acquire(), error => error.code === 'EEXIST');
  resolveWrite(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(mock.receipt(), null);
  assert.equal(lock.inspect(), null);
  assert.equal(mock.calls.filter(([tool]) => tool === 'prepare_project_delivery').length, 0);
  const recovered = await runLibTVImageDelivery(job, { ...mock.options, ...lock });
  assert.equal(recovered.state, 'saved');
});

test('a second process cannot repeat a pending save; explicit dead-owner recovery resumes only delivery', { timeout: 8000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libtv-delivery-process-')), lock = createProcessLock(path.join(root, 'delivery.lock'));
  const identity = { projectId: job.projectId, taskId: job.taskId, nodeId: job.nodeId, idempotencyKey: job.idempotencyKey };
  const request = { projectId: job.projectId, idempotencyKey: job.idempotencyKey, items: [{ kind: 'media', nodeId: job.nodeId, outputIndex: 0 }], watermark: job.watermark };
  const ready = { identity, request, state: 'ready', source: { taskState: 'unknown' }, response: manifest() };
  const filename = path.join(root, `${job.id}.delivery.json`);
  fs.writeFileSync(filename, JSON.stringify(ready), 'utf8');
  const sourceCode = `
    import path from 'node:path';
    import fs from 'node:fs';
    import { runLibTVImageDelivery } from ${JSON.stringify(new URL('../scripts/libtv_delivery.mjs', import.meta.url).href)};
    import { createProcessLock } from ${JSON.stringify(new URL('../scripts/process_lock.mjs', import.meta.url).href)};
    const [root, hold] = process.argv.slice(1), lock = createProcessLock(path.join(root, 'delivery.lock'));
    const filename = path.join(root, ${JSON.stringify(`${job.id}.delivery.json`)});
    let saves = 0, calls = 0;
    if (hold) setInterval(() => {}, 1000);
    try {
      const result = await runLibTVImageDelivery(${JSON.stringify(job)}, {
        ...lock, localTimeoutMs: 30,
        call: async () => { calls++; throw new Error('offline test: no MCP call is allowed'); },
        readReceipt: async () => JSON.parse(fs.readFileSync(filename, 'utf8')),
        writeReceipt: async (entry, stage, value, options) => { lock.assertOwner(options.context); fs.writeFileSync(filename, JSON.stringify(value), 'utf8'); },
        saveImage: async () => { saves++; if (hold) return new Promise(() => {}); return ${JSON.stringify(savedImage())}; }
      });
      process.send({ state: result.state, saves, calls });
    } catch(error) { process.send({ error: error.message, code: error.code, saves, calls }); }
    if (!hold) process.disconnect();
  `;
  const children = [];
  const start = hold => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', sourceCode, root, hold ? 'hold' : ''], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('delivery child did not return')), 3000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    const entry = { child, result, exited }; children.push(entry); return entry;
  };
  t.after(async () => { for (const entry of children) { if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill(); await entry.exited; } });
  const first = start(true), timedOut = await first.result;
  assert.equal(timedOut.code, 'CALL_TIMEOUT'); assert.equal(timedOut.saves, 1);
  const owner = lock.inspect().owner;
  const second = start(false), blocked = await second.result;
  await second.exited;
  assert.equal(blocked.code, 'EEXIST'); assert.equal(blocked.saves, 0); assert.equal(blocked.calls, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), ready);
  assert.throws(() => lock.recover({ owner, reason: 'offline test: still alive' }));
  first.child.kill(); await first.exited;
  lock.recover({ owner, reason: 'offline test: known child exited' });
  const third = start(false), recovered = await third.result;
  await third.exited;
  assert.equal(recovered.error, undefined, JSON.stringify(recovered));
  assert.equal(recovered.state, 'saved'); assert.equal(recovered.saves, 1); assert.equal(recovered.calls, 0);
  assert.equal(lock.inspect(), null);
});
