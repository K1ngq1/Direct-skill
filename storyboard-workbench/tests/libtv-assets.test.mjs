import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepareLibTVAssets, createLibTVReceiptStore, discoverLibTVAssets, runLibTVAssets, libtvAssetsHostSource } from '../scripts/libtv_assets.mjs';

const item = number => ({ id: `S${number}`, name: `S${number}`, fileName: `S${number}.png`, path: `S${number}.png`, size: 100, folderId: 7, projectId: 'project', scope: 'personal', sha256: number.toString(16).padStart(64, '0'), sha1: number.toString(16).padStart(40, '0'), uploadKey: `upload-${number}`, saveKey: `save-${number}` });
const clone = value => structuredClone(value);
function harness(items) {
  const receipts = new Map(), calls = [], assets = new Map(items.map(entry => [`asset-${entry.id}`, entry]));
  let discoveries = 0;
  const options = {
    discover: async context => { discoveries++; return { ...context, assets: [] }; },
    readReceipt: async (entry, stage) => clone(receipts.get(`${entry.id}/${stage}`) || null),
    writeReceipt: async (entry, stage, value, { exclusive } = {}) => {
      const key = `${entry.id}/${stage}`;
      if (exclusive && receipts.has(key)) throw new Error('claim exists');
      receipts.set(key, clone(value));
    },
    transfer: async entry => { calls.push(['transfer', entry.id]); return { status: 200, bytes: entry.size, sha256: entry.sha256 }; },
    call: async (name, args) => {
      calls.push([name, clone(args)]);
      if (name === 'upload_ticket') return { uploadId: args.file_name, path: `remote/${args.file_name}`, parts: [{ partNumber: 1, url: 'https://example.invalid/signed' }] };
      if (name === 'upload_complete') return { path: args.path, file_ref: args.upload_id };
      if (name === 'upload_media') return { projectId: 'project', status: 'completed', nodeId: `node-${args.name}`, resource: { resource_id: `resource-${args.name}`, review: { state: 'passed' } } };
      if (name === 'read_node') return { projectId: 'project', nodeId: args.node, node: { id: args.node } };
      if (name === 'save_asset_from_node') return { projectId: 'project', status: 'completed', operationId: `operation-${args.name}`, result: { asset: { assetId: `asset-${args.name}` } } };
      if (name === 'get_asset') {
        const entry = assets.get(args.assetId);
        return { projectId: 'project', scope: 'personal', asset: { assetId: args.assetId, assetVersion: 'persisted-version', folderId: entry.folderId, tags: JSON.stringify([`sha256:${entry.sha256}`]), items: [{ resourceIds: [`resource-${entry.id}`] }] } };
      }
      throw new Error(`Unexpected tool: ${name}`);
    }
  };
  return { options, receipts, calls, discoveries: () => discoveries };
}

test('LibTV runs independent assets concurrently, isolates MCP errors and only discovers once', async () => {
  const items = Array.from({ length: 6 }, (_, index) => item(index + 1)), mock = harness(items);
  const original = mock.options.call;
  let active = 0, maximum = 0;
  mock.options.call = async (name, args) => {
    if (name === 'upload_ticket') {
      active++; maximum = Math.max(active, maximum);
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
    }
    if (name === 'upload_media' && args.name === 'S2') return { isError: true, content: [{ type: 'text', text: 'review rejected' }] };
    return original(name, args);
  };
  const results = await runLibTVAssets(items, mock.options);
  assert.equal(maximum, 4);
  assert.equal(mock.discoveries(), 1);
  assert.deepEqual(results.map(result => result.status), ['succeeded', 'failed', 'succeeded', 'succeeded', 'succeeded', 'succeeded']);
  assert.equal(mock.calls.filter(([name]) => name === 'get_asset').length, 5);
  assert.equal(mock.calls.filter(([name]) => name === 'search_assets').length, 0);
  assert.equal(mock.receipts.get('S2/upload_media').state, 'failed');
});

test('slow asset upload does not block another asset from finishing or the fifth asset from starting', async () => {
  const items = Array.from({ length: 5 }, (_, index) => item(index + 1)), mock = harness(items);
  let releaseSlow, fifthStarted;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const fifth = new Promise(resolve => { fifthStarted = resolve; });
  const call = mock.options.call;
  mock.options.call = async (name, args) => {
    if (name === 'upload_ticket' && args.file_name === 'S1.png') await slow;
    if (name === 'upload_ticket' && args.file_name === 'S5.png') fifthStarted();
    return call(name, args);
  };
  const running = runLibTVAssets(items, mock.options);
  await fifth;
  assert.ok(mock.receipts.get('S2/get_asset')?.state === 'completed');
  assert.equal(mock.calls.some(([name, id]) => name === 'transfer' && id === 'S1'), false);
  releaseSlow();
  assert.ok((await running).every(value => value.status === 'succeeded'));
});

test('same-content aliases and pre-read existing assets are reused without upload or repeated detail reads', async () => {
  const first = item(1), alias = { ...first, id: 'S2', name: 'S2' }, mock = harness([first]);
  mock.options.discover = async context => ({ ...context, assets: [{ sha256: first.sha256, assetId: 'asset-S1', folderId: 7 }] });
  const results = await runLibTVAssets([first, alias], mock.options);
  assert.equal(results[1].reusedFrom, 'S1');
  assert.equal(results[0].assetId, results[1].assetId);
  assert.deepEqual(mock.calls.map(([name]) => name), ['get_asset']);
  await runLibTVAssets([first, alias], mock.options);
  assert.equal(mock.calls.length, 1);
});

test('pending save recovers by original operation identity without reupload or resave', async () => {
  const entry = item(1), mock = harness([entry]), original = mock.options.call;
  mock.options.call = async (name, args) => {
    if (name === 'save_asset_from_node') {
      mock.calls.push([name, clone(args)]);
      return { projectId: 'project', status: 'pending', operationId: 'original-operation' };
    }
    if (name === 'get_web_operation_status') {
      mock.calls.push([name, clone(args)]);
      assert.deepEqual(args, { projectId: 'project', operationId: 'original-operation' });
      return { projectId: 'project', status: 'completed', operationId: 'original-operation', result: { asset: { assetId: 'asset-S1' } } };
    }
    return original(name, args);
  };
  assert.equal((await runLibTVAssets([entry], mock.options))[0].status, 'pending');
  assert.equal((await runLibTVAssets([entry], mock.options))[0].status, 'succeeded');
  assert.equal(mock.calls.filter(([name]) => name === 'upload_ticket').length, 1);
  assert.equal(mock.calls.filter(([name]) => name === 'transfer').length, 1);
  assert.equal(mock.calls.filter(([name]) => name === 'save_asset_from_node').length, 1);
});

test('unknown ticket is not resent and pending review only replays the exact upload key', async () => {
  const entries = [item(1), item(2)], mock = harness(entries), original = mock.options.call;
  let uploadCount = 0;
  mock.options.call = async (name, args) => {
    if (name === 'upload_ticket' && args.file_name === 'S1.png') { mock.calls.push([name, args]); throw new Error('connection lost'); }
    if (name === 'upload_media') {
      uploadCount++;
      if (uploadCount === 1) { mock.calls.push([name, clone(args)]); return { projectId: 'project', status: 'review_pending', task_id: 'original-task' }; }
    }
    return original(name, args);
  };
  assert.deepEqual((await runLibTVAssets(entries, mock.options)).map(result => result.status), ['unknown', 'pending']);
  assert.deepEqual((await runLibTVAssets(entries, mock.options)).map(result => result.status), ['unknown', 'succeeded']);
  assert.equal(mock.calls.filter(([name, args]) => name === 'upload_ticket' && args.file_name === 'S1.png').length, 1);
  const requests = mock.calls.filter(([name]) => name === 'upload_media').map(([, args]) => args);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
});

test('rejected reviews and unverified detail never become succeeded', async () => {
  const entries = [item(1), item(2)], mock = harness(entries), original = mock.options.call;
  mock.options.call = async (name, args) => {
    if (name === 'upload_media' && args.name === 'S1') return { status: 'review_rejected' };
    const response = await original(name, args);
    if (name === 'get_asset') response.asset.tags = '[]';
    return response;
  };
  assert.deepEqual((await runLibTVAssets(entries, mock.options)).map(result => result.status), ['failed', 'unknown']);
  assert.equal(mock.calls.filter(([name, args]) => name === 'save_asset_from_node' && args.name === 'S1').length, 0);
});

test('a correct hash tag cannot hide an asset bound to the wrong Resource', async () => {
  const entry = item(1), mock = harness([entry]), original = mock.options.call;
  mock.options.call = async (name, args) => {
    const response = await original(name, args);
    if (name === 'get_asset') response.asset.items[0].resourceIds = ['unrelated-resource'];
    return response;
  };
  const result = (await runLibTVAssets([entry], mock.options))[0];
  assert.equal(result.status, 'unknown');
  assert.match(result.error, /Resource/);
});

test('discovery reads each folder once and consumes every search page before mutations', async () => {
  const calls = [];
  const inventory = await discoverLibTVAssets({ projectId: 'project', scope: 'personal', folderIds: [7, 7] }, async (name, args) => {
    calls.push([name, args]);
    if (name === 'get_asset_folder') return { projectId: 'project', scope: 'personal', folder: { folderId: 7 } };
    const entry = item(args.page);
    return { projectId: 'project', scope: 'personal', page: args.page, total: 2, items: [{ assetId: `asset-${args.page}`, folderId: 7, tags: [`sha256:${entry.sha256}`] }] };
  });
  assert.equal(inventory.assets.length, 2);
  assert.deepEqual(calls.map(([name]) => name), ['get_asset_folder', 'search_assets', 'search_assets']);
  assert.deepEqual(calls.filter(([name]) => name === 'search_assets').map(([, args]) => args.page), [1, 2]);
});

test('wrong project, folder conflicts and changed receipts fail before new writes', async () => {
  const entry = item(1), mock = harness([entry]);
  mock.options.discover = async context => ({ ...context, projectId: 'wrong', assets: [] });
  await assert.rejects(runLibTVAssets([entry], mock.options), /项目、空间或目录不匹配/);
  assert.equal(mock.calls.length, 0);
  mock.options.discover = async context => ({ ...context, assets: [] });
  await runLibTVAssets([entry], mock.options);
  const before = mock.calls.length;
  const changed = { ...entry, name: 'changed' };
  assert.equal((await runLibTVAssets([changed], mock.options))[0].status, 'failed');
  assert.equal(mock.calls.length, before);
  await assert.rejects(runLibTVAssets([entry, { ...entry, id: 'alias', folderId: 8 }], { ...mock.options, discover: async context => ({ ...context, assets: [] }) }), /不同目录/);
});

test('file preparation derives stable content keys and receipt files are exclusive UTF-8', async t => {
  // The Windows sandbox temp volume rejects rename; atomic-receipt fixtures stay on the workspace volume.
  const directory = fs.mkdtempSync(path.join(process.cwd(), 'storyboard-workbench/tests/libtv-flow-'));
  const filename = path.join(directory, '中文参考.png'), record = path.join(directory, 'S1.upload_ticket.json');
  t.after(() => {
    if (fs.existsSync(record)) fs.unlinkSync(record);
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
    fs.rmdirSync(directory);
  });
  fs.writeFileSync(filename, 'mock image bytes', 'utf8');
  const prepare = name => prepareLibTVAssets(directory, [{ id: 'S1', name, path: '中文参考.png', folderId: 7 }], { projectId: 'project' })[0];
  const first = prepare('中文名称'), second = prepare('另一名称');
  assert.equal(first.uploadKey, second.uploadKey);
  assert.equal(first.saveKey, second.saveKey);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  const store = createLibTVReceiptStore(directory);
  await store.writeReceipt(first, 'upload_ticket', { state: 'submitted', note: '中文回执' }, { exclusive: true });
  await assert.rejects(store.writeReceipt(first, 'upload_ticket', {}, { exclusive: true }), { code: 'EEXIST' });
  assert.equal((await store.readReceipt(first, 'upload_ticket')).note, '中文回执');
  await store.writeReceipt(first, 'upload_ticket', { state: 'completed' });
  assert.equal((await store.readReceipt(first, 'upload_ticket')).state, 'completed');
  assert.throws(() => prepareLibTVAssets(directory, [{ id: 'S1', name: 'bad', path: '../outside.png', folderId: 7 }], { projectId: 'project' }));
});

test('the exported host source uses the same scheduler and executes without imports', async () => {
  const execute = new Function(`${libtvAssetsHostSource()}; return runLibTVAssets;`)();
  const mock = harness([item(1)]);
  assert.equal((await execute([item(1)], mock.options))[0].status, 'succeeded');
});
