import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { receiptBridge, createLibTVCanvasSession, libtvAssetsHostSource } from '../scripts/libtv_assets.mjs';
import { runConcurrentJobs } from '../scripts/media_batch.mjs';

const clone = value => structuredClone(value);
const projectId = 'fake-project';
const cli = path.resolve('storyboard-workbench/scripts/libtv_assets.mjs');
const uploadArgs = id => ({ projectId, fileRef: `file-${id}`, name: id, mediaType: 'image', idempotencyKey: `original-${id}` });
const nodeArgs = (id, nodeType = 'image') => ({ projectId, name: id, nodeType, prompt: `完整中文正文 ${id}`, run: false, idempotencyKey: `original-${id}` });
const completedUploadPrerequisites = id => ({
  [`${id}.ticket`]: { tool: 'upload_ticket', args: { projectId, file_name: `${id}.png` }, status: 'completed', value: { uploadId: `${id}.png`, path: `remote/${id}.png`, parts: [{}] } },
  [`${id}.complete`]: { tool: 'upload_complete', args: { path: `remote/${id}.png`, upload_id: `${id}.png` }, status: 'completed', value: { file_ref: `file-${id}`, path: `remote/${id}.png` } }
});

function fakeHost(initial = {}) {
  const receipts = clone(initial), operations = [], calls = [];
  let active = 0, peak = 0;
  const bridge = async request => {
    operations.push(clone(request));
    if (request.operation === 'snapshot') return { receipts: clone(receipts) };
    if (request.operation === 'read') return clone(receipts[request.key] ?? null);
    assert.equal(request.operation, 'write');
    if (request.exclusive && Object.hasOwn(receipts, request.key)) throw new Error('exclusive receipt exists');
    if (Object.hasOwn(request, 'expected')) assert.deepEqual(receipts[request.key] ?? null, request.expected);
    const savedAt = new Date().toISOString();
    receipts[request.key] = clone(request.value);
    return { receipt: clone(request.value), receiptSavedAt: savedAt, receiptSaveMs: 0.1 };
  };
  const call = async (name, args) => {
    calls.push([name, clone(args)]);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    if (name === 'upload_ticket') return { uploadId: args.file_name, path: `remote/${args.file_name}`, parts: [{ partNumber: 1, url: 'https://example.invalid/unused-signed-url' }] };
    if (name === 'upload_complete') return { file_ref: `file-${args.upload_id.replace(/\.png$/, '')}`, path: args.path };
    return { status: 'completed', projectId, nodeId: `node-${args.name}`, resource: { resource_id: `resource-${args.name}`, review: { state: 'passed' } },
      plan: { nodeId: `node-${args.name}` }, operationResult: { subjectNodeId: `node-${args.name}` } };
  };
  return { receipts, operations, calls, bridge, call, peak: () => peak };
}

test('explicit independent jobs isolate an unknown upload without retrying it or allowing its next stage', async () => {
  const original = { tool: 'upload_media', args: uploadArgs('S01'), status: 'unknown', error: 'response lost' };
  const mock = fakeHost({ ...completedUploadPrerequisites('S01'), 'S01.upload': original });
  const session = await createLibTVCanvasSession({ projectId, bridge: mock.bridge, call: mock.call, paused: false, independentJobs: true });
  await session.savedCall('create_node', 'independent.node', nodeArgs('independent'));
  await assert.rejects(session.savedCall('upload_media', 'S01.upload', uploadArgs('S01')));
  await assert.rejects(session.savedCall('create_node', 'S01.node', nodeArgs('S01')));
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.receipts['S01.upload'], original);
  await assert.rejects(createLibTVCanvasSession({ projectId, bridge: mock.bridge, call: mock.call, independentJobs: 'yes' }));
});

test('43 fake uploads and 57 unexecuted nodes use one snapshot, two writes per operation, and no per-item reads', async () => {
  const mock = fakeHost();
  const session = await createLibTVCanvasSession({ projectId, bridge: mock.bridge, call: mock.call, paused: false });
  const uploads = Array.from({ length: 43 }, (_, index) => `asset-${index + 1}`);
  const uploadResults = await runConcurrentJobs(uploads, async id => {
    await session.savedCall('upload_ticket', `${id}.ticket`, { projectId, file_name: `${id}.png`, file_size: 123, sha1_hex: 'a'.repeat(40) });
    await session.savedCall('upload_complete', `${id}.complete`, { path: `remote/${id}.png`, upload_id: `${id}.png` });
    return session.savedCall('upload_media', `${id}.upload`, uploadArgs(id));
  }, { concurrency: 4 });
  assert.ok(uploadResults.every(result => result.status === 'fulfilled'), String(uploadResults.find(result => result.status === 'rejected')?.reason));
  const types = [...Array(40).fill('image'), ...Array(15).fill('video'), 'audio', 'text'];
  const nodes = await runConcurrentJobs(types, (type, index) => session.savedCall('create_node', `prompt-${index}.node`, nodeArgs(`prompt-${index}`, type)), { concurrency: 4 });
  assert.ok(nodes.every(result => result.status === 'fulfilled'), String(nodes.find(result => result.status === 'rejected')?.reason));
  assert.equal(mock.calls.length, 43 * 3 + 57);
  assert.equal(mock.peak(), 4);
  assert.equal(mock.operations.filter(operation => operation.operation === 'snapshot').length, 1);
  assert.equal(mock.operations.filter(operation => operation.operation === 'read').length, 0);
  assert.equal(mock.operations.filter(operation => operation.operation === 'write').length, mock.calls.length * 2);
  assert.ok(mock.calls.filter(([name]) => name === 'create_node').every(([, args]) => args.run === false));
  for (const receipt of Object.values(mock.receipts)) {
    assert.equal(receipt.status, 'completed');
    assert.ok(receipt.startedAt);
    assert.ok(receipt.toolStartedAt);
    assert.ok(receipt.toolReturnedAt);
    assert.ok(Date.parse(receipt.toolReturnedAt) >= Date.parse(receipt.toolStartedAt));
  }
  const restarted = await createLibTVCanvasSession({ projectId, bridge: mock.bridge, call: mock.call });
  const before = mock.calls.length;
  for (const [key, receipt] of Object.entries(mock.receipts)) await restarted.savedCall(receipt.tool, key, receipt.args);
  assert.equal(mock.calls.length, before, 'paused restart may reuse completed receipts without remote calls');
});

test('normal response persistence in one active worker does not block another worker next stage', async () => {
  const mock = fakeHost();
  let signalSaving, releaseSaving, secondSaving = false, nextStageDuringSave = false;
  const savingStarted = new Promise(resolve => { signalSaving = resolve; });
  const finishSaving = new Promise(resolve => { releaseSaving = resolve; });
  const bridge = async request => {
    if (request.operation === 'write' && request.value.status === 'completed') {
      if (request.key === 'S01.ticket') await savingStarted;
      if (request.key === 'S02.ticket') {
        secondSaving = true;
        signalSaving();
        await finishSaving;
        secondSaving = false;
      }
    }
    return mock.bridge(request);
  };
  const call = async (name, args) => {
    if (name === 'upload_complete' && args.upload_id === 'S01.png') nextStageDuringSave = secondSaving;
    return mock.call(name, args);
  };
  const session = await createLibTVCanvasSession({ projectId, bridge, call, paused: false });
  const results = await runConcurrentJobs(['S01', 'S02'], async id => {
    try {
      await session.savedCall('upload_ticket', `${id}.ticket`, { projectId, file_name: `${id}.png`, file_size: 123, sha1_hex: 'a'.repeat(40) });
      await session.savedCall('upload_complete', `${id}.complete`, { path: `remote/${id}.png`, upload_id: `${id}.png` });
      return await session.savedCall('upload_media', `${id}.upload`, uploadArgs(id));
    } finally {
      if (id === 'S01') releaseSaving();
    }
  }, { concurrency: 2 });
  assert.ok(results.every(result => result.status === 'fulfilled'), String(results.find(result => result.status === 'rejected')?.reason));
  assert.equal(nextStageDuringSave, true);
  assert.equal(mock.calls.length, 6);
  assert.ok(Object.values(mock.receipts).every(receipt => receipt.status === 'completed'));
});

test('legacy receipts retain original identity and changed requests are rejected before remote calls', async () => {
  const args = uploadArgs('S01'), startedAt = '2026-10-28T01:02:03.000Z';
  const mock = fakeHost({ ...completedUploadPrerequisites('S01'), 'S01.upload': { tool: 'upload_media', args, status: 'review_pending', startedAt, value: { status: 'review_pending' } } });
  const session = await createLibTVCanvasSession({ projectId, bridge: mock.bridge, call: mock.call, paused: false });
  await assert.rejects(session.savedCall('upload_media', 'S01.upload', { ...args, idempotencyKey: 'new-key' }, { recover: true }));
  await assert.rejects(session.savedCall('upload_media', 'S01.upload', { ...args, fileRef: 'different-file' }, { recover: true }));
  await assert.rejects(session.savedCall('upload_media', 'S01.upload', { ...args, projectId: 'wrong-project' }, { recover: true }));
  assert.equal(mock.calls.length, 0);
  await session.savedCall('upload_media', 'S01.upload', args, { recover: true });
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.calls[0], ['upload_media', args]);
  assert.equal(mock.receipts['S01.upload'].startedAt, startedAt);
});

test('unknown tickets and completion requests never retry; unresolved uploads block new work', async () => {
  for (const [tool, key, args] of [
    ['upload_ticket', 'S01.ticket', { projectId, file_name: 'original.png', file_size: 123, sha1_hex: 'b'.repeat(40) }],
    ['upload_complete', 'S01.complete', { path: 'original/path', upload_id: 'original-upload' }]
  ]) {
    const mock = fakeHost({ [key]: { tool, args, status: 'submitted', startedAt: '2026-10-28T00:00:00.000Z' },
      ...(tool === 'upload_complete' ? { 'S01.ticket': { tool: 'upload_ticket', args: { projectId, file_name: 'original.png' }, status: 'completed', value: { path: args.path, uploadId: args.upload_id, parts: [{}] } } } : {}) });
    const session = await createLibTVCanvasSession({ projectId, bridge: mock.bridge, call: mock.call, paused: false });
    await assert.rejects(session.savedCall(tool, key, args, { recover: true }));
    await assert.rejects(session.savedCall('upload_media', 'S02.upload', uploadArgs('S02')));
    assert.equal(mock.calls.length, 0);
  }
  const args = uploadArgs('S01'), mock = fakeHost({ ...completedUploadPrerequisites('S01'), 'S01.upload': { tool: 'upload_media', args, status: 'unknown' } });
  const session = await createLibTVCanvasSession({ projectId, bridge: mock.bridge, call: mock.call, paused: false });
  await assert.rejects(session.savedCall('upload_media', 'S01.upload', args));
  assert.equal(mock.calls.length, 0);
  await session.savedCall('upload_media', 'S01.upload', args, { recover: true });
  assert.equal(mock.calls.length, 1);
});

test('review pending, explicit rejection and network failures stay distinct and do not auto-retry', async () => {
  for (const [outcome, expected] of [[{ status: 'review_pending' }, 'review_pending'], [{ status: 'review_rejected' }, 'review_rejected'], [new Error('Transport send error'), 'unknown']]) {
    const mock = fakeHost(completedUploadPrerequisites('S01'));
    let calls = 0;
    const session = await createLibTVCanvasSession({ projectId, bridge: mock.bridge, paused: false, call: async () => { calls++; if (outcome instanceof Error) throw outcome; return outcome; } });
    await assert.rejects(session.savedCall('upload_media', 'S01.upload', uploadArgs('S01')));
    assert.equal(mock.receipts['S01.upload'].status, expected);
    await assert.rejects(session.savedCall('upload_media', 'S01.upload', uploadArgs('S01')));
    assert.equal(calls, 1);
    if (expected === 'review_rejected') {
      await assert.rejects(session.savedCall('upload_media', 'S01.upload', uploadArgs('S01'), { recover: true }));
      assert.equal(calls, 1);
    }
  }
});

test('failed receipt save retains the original response and recoverSave never repeats the remote write', async () => {
  const mock = fakeHost(completedUploadPrerequisites('S01'));
  let failSave = true;
  const bridge = async request => {
    if (request.operation === 'write' && request.value.status === 'completed' && failSave) throw new Error('disk save failed');
    return mock.bridge(request);
  };
  const session = await createLibTVCanvasSession({ projectId, bridge, call: mock.call, paused: false });
  await assert.rejects(session.savedCall('upload_media', 'S01.upload', uploadArgs('S01')), /save|保存/i);
  assert.equal(mock.calls.length, 1);
  assert.notEqual(mock.receipts['S01.upload'].status, 'completed');
  await assert.rejects(session.savedCall('upload_media', 'S01.upload', uploadArgs('S01'), { recover: true }));
  await assert.rejects(session.savedCall('create_node', 'S02.node', nodeArgs('S02')));
  assert.equal(mock.calls.length, 1);
  failSave = false;
  await session.recoverSave('S01.upload');
  assert.equal(mock.receipts['S01.upload'].status, 'completed');
  await session.savedCall('upload_media', 'S01.upload', uploadArgs('S01'));
  assert.equal(mock.calls.length, 1);
});

test('pause defaults closed and is checked again after the submitted receipt is saved', async () => {
  const mock = fakeHost({ ...completedUploadPrerequisites('S01'), ...completedUploadPrerequisites('S02') });
  const paused = await createLibTVCanvasSession({ projectId, bridge: mock.bridge, call: mock.call });
  await assert.rejects(paused.savedCall('upload_media', 'S01.upload', uploadArgs('S01')));
  assert.equal(mock.calls.length, 0);
  let session;
  const bridge = async request => {
    const result = await mock.bridge(request);
    if (request.operation === 'write' && request.value.status === 'submitted') session.setPaused(true);
    return result;
  };
  session = await createLibTVCanvasSession({ projectId, bridge, call: mock.call, paused: false });
  await assert.rejects(session.savedCall('upload_media', 'S02.upload', uploadArgs('S02')));
  assert.equal(mock.calls.length, 0);
});

test('a proven undispatched prepared request can resume once after pause without retrying unknown submissions', async () => {
  const mock = fakeHost();
  let session, pauseOnce = true;
  const bridge = async request => {
    const result = await mock.bridge(request);
    if (request.operation === 'write' && request.value.status === 'submitted' && pauseOnce) {
      pauseOnce = false;
      session.setPaused(true);
    }
    return result;
  };
  session = await createLibTVCanvasSession({ projectId, bridge, call: mock.call, paused: false });
  const args = nodeArgs('S01');
  await assert.rejects(session.savedCall('create_node', 'S01.node', args));
  assert.equal(mock.calls.length, 0);
  assert.equal(mock.receipts['S01.node'].status, 'prepared');
  session.setPaused(false);
  await session.savedCall('create_node', 'S01.node', args);
  await session.savedCall('create_node', 'S01.node', args);
  assert.equal(mock.calls.length, 1);
});

test('upload completion and attachment cannot borrow another item ticket or fileRef', async () => {
  const first = completedUploadPrerequisites('S01'), second = completedUploadPrerequisites('S02');
  const mock = fakeHost({ ...first, ...second });
  delete mock.receipts['S01.complete'];
  const session = await createLibTVCanvasSession({ projectId, bridge: mock.bridge, call: mock.call, paused: false });
  await assert.rejects(session.savedCall('upload_complete', 'S01.complete', second['S02.complete'].args));
  await assert.rejects(session.savedCall('upload_media', 'S01.upload', { ...uploadArgs('S01'), fileRef: 'file-S02' }));
  assert.equal(mock.calls.length, 0);
  assert.equal(mock.operations.filter(operation => operation.operation === 'write').length, 0);
  const withOwnCompletion = fakeHost({ ...first, ...second });
  const original = await createLibTVCanvasSession({ projectId, bridge: withOwnCompletion.bridge, call: withOwnCompletion.call, paused: false });
  await assert.rejects(original.savedCall('upload_media', 'S01.upload', { ...uploadArgs('S01'), fileRef: 'file-S02' }));
  await original.savedCall('upload_media', 'S01.upload', uploadArgs('S01'));
  assert.equal(withOwnCompletion.calls.length, 1);
});

test('lost save acknowledgement reconciles one original receipt read and rejects a different result', async () => {
  for (const corruptSavedValue of [false, true]) {
    const mock = fakeHost(completedUploadPrerequisites('S01'));
    let loseAcknowledgement = true;
    const bridge = async request => {
      const result = await mock.bridge(request);
      if (request.operation === 'write' && request.value.status === 'completed' && loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error('receipt saved but acknowledgement lost');
      }
      return result;
    };
    const session = await createLibTVCanvasSession({ projectId, bridge, call: mock.call, paused: false });
    await assert.rejects(session.savedCall('upload_media', 'S01.upload', uploadArgs('S01')));
    assert.equal(mock.receipts['S01.upload'].status, 'completed');
    assert.equal(mock.calls.length, 1);
    if (corruptSavedValue) {
      mock.receipts['S01.upload'].value.nodeId = 'unrelated-node';
      await assert.rejects(session.recoverSave('S01.upload'));
    } else {
      await session.recoverSave('S01.upload');
      await session.savedCall('upload_media', 'S01.upload', uploadArgs('S01'));
    }
    assert.equal(mock.operations.filter(operation => operation.operation === 'read').length, 1);
    assert.equal(mock.calls.length, 1);
  }
});

test('completed upload status cannot override rejected, pending, or missing Resource review evidence', async () => {
  for (const [reviewState, expected] of [['rejected', 'review_rejected'], ['pending', 'review_pending'], [undefined, 'unknown']]) {
    const mock = fakeHost(completedUploadPrerequisites('S01'));
    let calls = 0;
    const session = await createLibTVCanvasSession({ projectId, bridge: mock.bridge, paused: false, call: async () => {
      calls++;
      return { projectId, status: 'completed', nodeId: 'original-node', resource: { resource_id: 'original-resource', ...(reviewState ? { review: { state: reviewState } } : {}) } };
    } });
    await assert.rejects(session.savedCall('upload_media', 'S01.upload', uploadArgs('S01')));
    assert.equal(mock.receipts['S01.upload'].status, expected);
    assert.equal(calls, 1);
    await assert.rejects(session.savedCall('upload_media', 'S01.upload', uploadArgs('S01')));
    assert.equal(calls, 1);
  }
});

test('node delivery refuses generation, upgrades, export execution, and any run value other than false', async () => {
  const mock = fakeHost();
  const session = await createLibTVCanvasSession({ projectId, bridge: mock.bridge, call: mock.call, paused: false });
  for (const run of [true, undefined, null, 'false']) await assert.rejects(session.savedCall('create_node', 'S01.node', { ...nodeArgs('S01'), run }));
  await assert.rejects(session.savedCall('manage_group', 'S01.group', { projectId, action: 'create', run: true }), /不得执行生成/);
  for (const tool of ['generation_submit', 'generate_image', 'generate_video', 'generate_audio', 'upgrade_video', 'export_project', 'prepare_project_delivery']) {
    await assert.rejects(session.savedCall(tool, 'S01.node', nodeArgs('S01')));
  }
  assert.equal(mock.calls.length, 0);
  assert.equal(mock.operations.filter(operation => operation.operation === 'write').length, 0);
});

test('exported host source works without performance or structuredClone in functions.exec', async () => {
  const context = vm.createContext({ performance: undefined, structuredClone: undefined });
  const factory = vm.runInContext(`${libtvAssetsHostSource()}\ncreateLibTVCanvasSession`, context);
  const mock = fakeHost();
  const session = await factory({ projectId, bridge: mock.bridge, call: mock.call, paused: false });
  const result = await session.savedCall('create_node', 'S01.node', nodeArgs('S01'));
  assert.equal(result.status, 'completed');
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.receipts['S01.node'].status, 'completed');
  assert.equal(mock.receipts['S01.node'].args.run, false);
  assert.equal(session.snapshot().timing.durationSource, 'utc-estimate');
});

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(process.cwd(), 'storyboard-workbench/tests/libtv-receipts-'));
  const files = [];
  t.after(() => {
    // Each fixture is an exact path created by this test; no recursive directory deletion.
    for (const file of files) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });
  return { directory, file: name => { const filename = path.join(directory, name); files.push(filename); return filename; } };
}

function cliRequest(request, requestFile) {
  if (requestFile) fs.writeFileSync(requestFile, JSON.stringify(request), 'utf8');
  const result = spawnSync(process.execPath, [cli, 'receipts', ...(requestFile ? [requestFile] : [])], {
    input: requestFile ? undefined : JSON.stringify(request), encoding: 'utf8', maxBuffer: 2 * 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true, response.error);
  return response.value;
}

test('receipt CLI round-trips long Chinese prompts through stdin/files and verifies changed bytes', async t => {
  const fixture = temporaryDirectory(t), { directory } = fixture;
  const receiptFile = fixture.file('S01.upload.json');
  const errorFile = fixture.file('S01.upload.error.json');
  const requestFile = fixture.file('中文请求.json');
  const image = fixture.file('中文参考.png');
  const value = { status: 'completed', args: nodeArgs('S01'), note: '中文正文与标点；'.repeat(20000) };
  const saved = cliRequest({ operation: 'write', directory, key: 'S01.upload', value, exclusive: true });
  assert.deepEqual(saved.receipt, { ...value, receiptSavedAt: saved.receipt.receiptSavedAt });
  assert.ok(saved.receiptSavedAt);
  assert.deepEqual(cliRequest({ operation: 'read', directory, key: 'S01.upload' }, requestFile), saved.receipt);
  assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile, 'utf8')), saved.receipt);
  fs.writeFileSync(errorFile, JSON.stringify({ at: 'legacy', error: '原错误必须保留' }), 'utf8');
  const beforeError = fs.readFileSync(errorFile);
  const snapshot = cliRequest({ operation: 'snapshot', directory });
  assert.deepEqual(snapshot.receipts['S01.upload'], saved.receipt);
  assert.equal(snapshot.receipts['S01.upload.error'].error, '原错误必须保留');
  assert.deepEqual(fs.readFileSync(errorFile), beforeError);
  const bytes = Buffer.from('fake image bytes');
  fs.writeFileSync(image, bytes);
  const items = [{ id: 'S01', path: image, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }];
  await receiptBridge({ operation: 'verify', directory, items });
  fs.writeFileSync(image, 'changed bytes');
  await assert.rejects(receiptBridge({ operation: 'verify', directory, items }));
  await assert.rejects(receiptBridge({ operation: 'read', directory, key: '../outside' }));
});

function openStdio(directory) {
  const child = spawn(process.execPath, [cli, 'receipts', '--stdio', directory], { stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = new Map(), waiting = new Map();
  let output = '', errors = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { errors += text; });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', text => {
    output += text;
    for (let newline; (newline = output.indexOf('\n')) >= 0;) {
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      if (waiting.has(value.requestId)) { waiting.get(value.requestId)(value); waiting.delete(value.requestId); }
      else responses.set(value.requestId, value);
    }
  });
  return { child, errors: () => errors, request: request => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stdio response timeout: ${errors}`)), 10000);
    const finish = value => { clearTimeout(timer); resolve(value); };
    if (responses.has(request.requestId)) finish(responses.get(request.requestId));
    else waiting.set(request.requestId, finish);
    child.stdin.write(JSON.stringify(request) + '\n');
  }) };
}

test('stdio bridge holds one process lock and releases it only when closed', async t => {
  const fixture = temporaryDirectory(t), first = openStdio(fixture.directory);
  t.after(() => { if (first.child.exitCode === null) first.child.kill(); });
  assert.equal((await first.request({ requestId: 'first', operation: 'snapshot' })).ok, true);
  const duplicate = spawnSync(process.execPath, [cli, 'receipts', '--stdio', fixture.directory], {
    input: JSON.stringify({ requestId: 'second', operation: 'snapshot' }) + '\n', encoding: 'utf8', timeout: 10000
  });
  assert.notEqual(duplicate.status, 0, 'another coordinator must not acquire the live lock');
  const exit = once(first.child, 'exit');
  assert.equal((await first.request({ requestId: 'close', operation: 'close' })).ok, true);
  assert.deepEqual(await exit, [0, null]);
  assert.deepEqual(cliRequest({ operation: 'snapshot', directory: fixture.directory }).receipts, {});
});
