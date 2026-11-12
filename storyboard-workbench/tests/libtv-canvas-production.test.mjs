import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canvasProductionHostSource, runLibTVCanvasProduction } from '../scripts/libtv_canvas_production.mjs';
import { receiptBridge } from '../scripts/libtv_assets.mjs';

function production(fault) {
  const projectId = 'P', calls = [], receipts = new Map(), nodes = new Map(), graph = [], media = [];
  let interrupted = fault;
  const sources = ['A', 'B', 'C'].map(id => ({ id, name: id, path: 'reviews.json', pointer: '/' + id, uploadKey: 'upload-' + id }));
  sources[0].videos = [{ id: 'VA', args: { projectId, nodeType: 'video', model: 'M', prompt: 'look at {{START_FRAME}}', run: false, idempotencyKey: 'node-A' } }];
  const local = {
    checkLocal: async () => true,
    async transfer(item) {
      calls.push('PUT:' + item.id);
      if (interrupted === 'dns' || interrupted === 'unknown-put') throw new Error(interrupted);
      return { status: 200, bytes: item.size, sha256: item.sha256 };
    },
    async bridge(request) {
      if (request.operation === 'canvas-export') {
        assert.ok(calls.some(entry => entry.startsWith('get_project_snapshot:')));
        calls.push('excel'); return { exportsUpdated: true, acceptance: 'passed' };
      }
      if (request.operation === 'canvas-ready') return request.sources.map(({ id }) => ({
        id, status: id === 'C' ? 'needs-change' : 'usable', qualifiedAt: new Date(0).toISOString(),
        fileName: id, size: 42, sha1: '1'.repeat(40), sha256: '0'.repeat(64) }));
      if (request.operation === 'canvas-summary') return { path: 'mock-summary' };
      if (request.operation === 'snapshot') return { receipts: Object.fromEntries(receipts) };
      if (request.operation === 'read') return receipts.get(request.key);
      assert.equal(request.operation, 'write');
      assert.deepEqual(receipts.get(request.key) ?? null, request.expected);
      receipts.set(request.key, request.value);
      if (request.value.status === 'completed' && interrupted === 'lost-write-ack') {
        interrupted = null; throw new Error('lost acknowledgement');
      }
      return { receipt: request.value };
    }
  };
  async function call(name, args) {
    calls.push(name + ':' + (args.file_name ?? args.name ?? args.node ?? ''));
    if (name === 'doctor') return { status: fault === 'token' ? 'unauthenticated' : 'ready' };
    if (name === 'target_project') return { projectId };
    if (name === 'upload_ticket') return { uploadId: args.file_name, path: args.file_name, parts: [{}] };
    if (name === 'upload_complete') return { file_ref: args.path, path: args.path };
    if (name === 'upload_media') {
      const nodeId = 'i-' + args.name, resourceId = 'r-' + args.name;
      graph.push({ itemType: 'node', nodeId, type: 'image' });
      media.push({ nodeId, type: 'image', identity: { state: 'resource', resourceIds: [resourceId] } });
      nodes.set(nodeId, { id: nodeId, type: 'image', data: { resourceIds: [resourceId] } });
      return { projectId, nodeId, status: 'completed', resourceId, resource: { review: { state: 'passed' } } };
    }
    if (name === 'create_node') {
      assert.equal(args.run, false);
      const nodeId = 'v-A';
      graph.push({ itemType: 'node', type: 'video', nodeId, task: {} }, { itemType: 'edge', source: args.startFrameNode, target: nodeId });
      nodes.set(nodeId, { id: nodeId, type: 'video', data: { url: [], params: { model: args.model,
        prompt: 'look at {{Image 1}}', imageList: [{ nodeId: args.startFrameNode }] } } });
      return { projectId, status: 'completed', plan: { nodeId } };
    }
    if (name === 'read_node') {
      if (fault === 'wrong-resource') throw new Error('resource mismatch');
      return { projectId, nodeId: args.node, node: nodes.get(args.node), mediaPersistence: { nodes: [
        { nodeId: args.node, bindingStatus: 'present', persistedUrlCount: 0, persistedResourceIdCount: 0 }] } };
    }
    assert.equal(name, 'get_project_snapshot');
    const items = args.section === 'graph' ? graph : media;
    return { project: { projectId }, section: args.section, items, revision: { token: 'rev' }, page: { offset: 0, total: items.length } };
  }
  return { calls, run: () => runLibTVCanvasProduction({ projectId, sources, projectDirectory: 'project', closedFile: 'closed',
    planFile: 'plan', workflowFile: 'workflow', call, local }) };
}

test('首图回读解锁上传，已保存的应答和整批重新进入都不重复远端写入', async () => {
  const { run, calls } = production('lost-write-ack');
  const report = await run();
  assert.equal(report.verified, true, JSON.stringify(report.issues));
  assert.deepEqual([report.usableCount, report.needsChangeCount, report.readback.edgeCount], [2, 1, 1]);
  assert.ok(calls.indexOf('upload_ticket:B') > calls.indexOf('read_node:i-A'));
  assert.equal(typeof report.lastQualifiedToReadbackMs, 'number');
  assert.equal(report.excel.acceptance, 'passed');
  await run();
  assert.equal(calls.filter(x => x.startsWith('upload_ticket:')).length, 2);
  assert.equal(calls.filter(x => x.startsWith('upload_media:')).length, 2);
  assert.equal(calls.filter(x => x.startsWith('create_node:')).length, 1);
  assert.equal(typeof vm.runInNewContext(canvasProductionHostSource() + '\nrunCodexCanvasProduction'), 'function');
});

test('首图验证遇到认证、DNS、PUT 状态未知或回读错误，保留后续任务', async () => {
  for (const [fault, stage] of [['token', 'doctor'], ['dns', 'PUT'], ['unknown-put', 'PUT'], ['wrong-resource', 'read_node']]) {
    const { run, calls } = production(fault);
    const result = await run();
    assert.equal(result.issues[0].stage, stage);
    assert.equal(result.pilotPassed, false);
    assert.ok(result.remaining.includes('B'));
    assert.ok(!calls.includes('upload_ticket:B'));
    assert.ok(!calls.includes('excel'));
    assert.ok(!calls.some(s => s.startsWith('create_node:')));
  }
});

test('只发布当前可用槽位的已采用原件；变更文件拒绝入画布', async t => {
  const dir = fs.mkdtempSync(path.resolve('.canvas-review-test-'));
  const plan = path.join(dir, 'plan.json'), reviews = path.join(dir, 'review.json'), image = path.join(dir, 'image.png');
  t.after(() => {
    fs.unlinkSync(image);
    fs.unlinkSync(reviews);
    fs.unlinkSync(plan);
    fs.rmdirSync(dir);
  });
  fs.writeFileSync(plan, JSON.stringify({ schemaVersion: 2, run: { automation: { mode: 'single-run',
    userRequest: '制作画布', assetSelection: 'agent', imageGeneration: true, videoGeneration: false } } }));
  const bytes = Buffer.from('fixture'), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(image, bytes);
  const items = ['B', 'A'].map((id, n) => ({ id, path: 'image.png', sha256,
    selection: { by: 'agent', reason: '已检查', selectedAt: new Date(1000 - n).toISOString() },
    approval: { status: 'pending', by: null }, review: { status: 'usable', outputSha256: sha256, reason: '一致', reviewer: 'test' } }));
  fs.writeFileSync(reviews, JSON.stringify(items));
  const input = { operation: 'canvas-ready', directory: dir, projectDirectory: dir, planFile: plan, closedFile: 'closed',
    limit: 1, sources: items.map(({ id }, n) => ({ id, path: reviews, pointer: '/' + n })) };
  const decisions = await receiptBridge(input);
  assert.deepEqual(decisions.map(item => [item.id, item.status, item.sha256]), [['A', 'usable', sha256]]);
  fs.writeFileSync(image, 'changed');
  assert.equal((await receiptBridge(input))[0].status, 'blocked');
});
