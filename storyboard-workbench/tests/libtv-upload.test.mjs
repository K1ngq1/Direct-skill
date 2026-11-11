import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { checkLibTVCurl, transferLibTVFile } from '../scripts/libtv_upload.mjs';
import { createLibTVReceiptStore, prepareLibTVAssets, runLibTVAssets } from '../scripts/libtv_assets.mjs';

function fixture(t) {
  // Atomic-receipt tests use the workspace volume because Windows sandbox TEMP can reject rename.
  const directory = fs.mkdtempSync(path.resolve('storyboard-workbench/tests/curl-upload-'));
  const filename = path.join(directory, '中文 素材.png'), bytes = Buffer.from([0, 255, 128, 13, 10, 42]);
  fs.writeFileSync(filename, bytes);
  const item = prepareLibTVAssets(directory, [{ id: 'S01', name: '中文素材', path: filename, folderId: 7 }], { projectId: 'test-project' })[0];
  const ticket = { uploadId: 'test-upload', path: 'test/remote.png', parts: [{ partNumber: 1, method: 'PUT', url: 'https://example.invalid/signed?token=private-test' }] };
  const receiptDirectory = path.join(directory, '.libtv-upload-receipts');
  t.after(() => {
    if (fs.existsSync(receiptDirectory)) {
      // Only files made by this fixture; an unexpected surviving lock fails cleanup.
      for (const name of fs.readdirSync(receiptDirectory)) fs.unlinkSync(path.join(receiptDirectory, name));
      fs.rmdirSync(receiptDirectory);
    }
    fs.unlinkSync(filename); fs.rmdirSync(directory);
  });
  return { directory, item, ticket, bytes, receiptDirectory };
}

function mockCurl(t, respond = call => call.finish()) {
  const calls = [];
  t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const chunks = [];
    child.stdin.on('data', chunk => chunks.push(chunk));
    const config = fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8');
    const call = { executable, args, options, config, child,
      finish: ({ code = 0, status = 200, bytes = call.bytes.length } = {}) => {
        child.stdout.end(`${status} ${bytes} 0.01`);
        child.stderr.end('https://example.invalid/signed?token=private-test');
        child.emit('close', code);
      } };
    child.kill = () => { call.finish({ code: 1 }); return true; };
    child.stdin.on('finish', () => { call.bytes = Buffer.concat(chunks); setImmediate(() => respond(call)); });
    calls.push(call);
    return child;
  });
  return calls;
}

test('native curl preflight is offline and available on the test host', async () => {
  const result = await checkLibTVCurl();
  assert.match(result.version, /^curl \d+\./);
});

test('uploads exact frozen binary bytes, uses safe native arguments, and reuses saved proof without PUT', async t => {
  const f = fixture(t), calls = mockCurl(t);
  const first = await transferLibTVFile(f.directory, f.item, f.ticket, { allowUpload: true });
  assert.deepEqual(calls[0].bytes, f.bytes);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].args[0], '--disable');
  assert.equal(calls[0].args[calls[0].args.indexOf('--upload-file') + 1], '-');
  // stdin has unknown length to curl; explicit Content-Length must suppress chunked transfer encoding.
  assert.ok(calls[0].args.includes('Transfer-Encoding:'));
  assert.ok(calls[0].config.includes(f.ticket.parts[0].url));
  assert.ok(!calls[0].args.join(' ').includes('private-test'));
  assert.ok(!calls[0].args.some(arg => ['--insecure', '-k', '--location', '--retry'].includes(arg)));
  assert.equal(first.sha256, crypto.createHash('sha256').update(f.bytes).digest('hex'));
  assert.equal(first.bytes, f.bytes.length);
  assert.equal(first.transport, 'native-curl');
  assert.equal(first.reused, false);
  assert.ok(fs.readdirSync(f.receiptDirectory).every(name => name.endsWith('.json')));
  assert.equal((await transferLibTVFile(f.directory, f.item, f.ticket)).reused, true);
  assert.equal(calls.length, 1);
});

test('multipart uploads obey exact ordered slices and reject missing sizes before any network call', async t => {
  const f = fixture(t), calls = mockCurl(t);
  f.ticket.parts.push({ ...f.ticket.parts[0], partNumber: 2, url: 'https://example.invalid/part-two' });
  await assert.rejects(transferLibTVFile(f.directory, f.item, f.ticket, { allowUpload: true }), /分片长度/);
  assert.equal(calls.length, 0);
  f.ticket.partSize = 4;
  const result = await transferLibTVFile(f.directory, f.item, f.ticket, { allowUpload: true });
  assert.deepEqual(calls.map(call => call.bytes), [f.bytes.subarray(0, 4), f.bytes.subarray(4)]);
  assert.equal(result.bytes, 6);
});

test('authorization, frozen file and complete ticket validation happen before PUT', async t => {
  const f = fixture(t), calls = mockCurl(t);
  await assert.rejects(transferLibTVFile(f.directory, f.item, f.ticket), /未获本次授权/);
  for (const url of ['http://example.invalid/upload', 'https://user:secret@example.invalid/upload', 'https://example.invalid/\nnext', 'https://example.invalid/#fragment']) {
    await assert.rejects(transferLibTVFile(f.directory, f.item, { ...f.ticket, parts: [{ ...f.ticket.parts[0], url }] }, { allowUpload: true }), /HTTPS|地址/);
  }
  await assert.rejects(transferLibTVFile(f.directory, f.item, { ...f.ticket, parts: [...f.ticket.parts, { ...f.ticket.parts[0], partNumber: 2 }] }, { allowUpload: true }), /分片长度/);
  fs.writeFileSync(f.item.path, 'changed');
  await assert.rejects(transferLibTVFile(f.directory, f.item, f.ticket, { allowUpload: true }), /哈希已变化/);
  assert.equal(calls.length, 0);
});

test('HTTP errors, network failures and short writes retain unknown evidence and never automatically retry', async t => {
  for (const response of [{ status: 403 }, { code: 28, status: 0 }, { bytes: 3 }]) {
    await t.test(JSON.stringify(response), async t => {
      const f = fixture(t), calls = mockCurl(t, call => call.finish(response));
      await assert.rejects(transferLibTVFile(f.directory, f.item, f.ticket, { allowUpload: true }), /失败或结果未知/);
      await assert.rejects(transferLibTVFile(f.directory, f.item, f.ticket, { allowUpload: true }), /不自动重传/);
      assert.equal(calls.length, 1);
      const text = fs.readFileSync(path.join(f.receiptDirectory, 'S01.curl_error.json'), 'utf8');
      assert.equal(JSON.parse(text).state, 'unknown');
      assert.ok(!text.includes('private-test'));
      assert.ok(!fs.existsSync(path.join(f.receiptDirectory, 'S01.curl_completed.json')));
    });
  }
});

test('a slow upload does not serialize a second file, while same-item concurrent PUT is rejected', async t => {
  const f = fixture(t);
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const calls = mockCurl(t, call => {
    if (calls.indexOf(call) === 0) { release = () => call.finish(); started(); }
    else call.finish();
  });
  const first = transferLibTVFile(f.directory, f.item, f.ticket, { allowUpload: true });
  await waiting;
  try {
    await assert.rejects(transferLibTVFile(f.directory, f.item, f.ticket, { allowUpload: true }), /进程锁/);
    const second = await transferLibTVFile(f.directory, { ...f.item, id: 'S02' }, { ...f.ticket, uploadId: 'second-upload' }, { allowUpload: true });
    assert.equal(second.status, 200);
    assert.equal(calls.length, 2);
  } finally { release(); await first; }
});

test('completed proof is bound to the original project and ticket; failed local save preserves returned proof', async t => {
  const f = fixture(t), calls = mockCurl(t);
  const originalOpen = fs.openSync;
  const patch = t.mock.method(fs, 'openSync', (filename, ...args) => {
    if (String(filename).endsWith('curl_completed.json')) throw Object.assign(new Error('disk failure'), { code: 'EACCES' });
    return originalOpen(filename, ...args);
  });
  let returned;
  await assert.rejects(transferLibTVFile(f.directory, f.item, f.ticket, { allowUpload: true }), error => { returned = error.returned; return Boolean(returned?.proof); });
  patch.mock.restore();
  await assert.rejects(transferLibTVFile(f.directory, f.item, f.ticket, { allowUpload: true }), /不自动重传/);
  await createLibTVReceiptStore(f.receiptDirectory).writeReceipt(f.item, 'curl_completed', returned, { exclusive: true });
  assert.equal((await transferLibTVFile(f.directory, f.item, f.ticket)).reused, true);
  await assert.rejects(transferLibTVFile(f.directory, { ...f.item, projectId: 'other-project' }, f.ticket), /不一致/);
  await assert.rejects(transferLibTVFile(f.directory, f.item, { ...f.ticket, uploadId: 'other-ticket' }), /不一致/);
  assert.equal(calls.length, 1);
});

test('the existing asset runner consumes curl proof before completing or attaching the upload', async t => {
  const f = fixture(t), calls = mockCurl(t), receipts = new Map(), tools = [];
  const [result] = await runLibTVAssets([f.item], {
    discover: async context => ({ ...context, assets: [] }),
    readReceipt: async (item, stage) => receipts.get(stage),
    writeReceipt: async (item, stage, value) => { receipts.set(stage, value); },
    transfer: (item, ticket) => transferLibTVFile(f.directory, item, ticket, { allowUpload: true }),
    call: async (name, args) => {
      tools.push(name);
      if (name === 'upload_ticket') return f.ticket;
      if (name === 'upload_complete') {
        assert.ok(fs.existsSync(path.join(f.receiptDirectory, 'S01.curl_completed.json')));
        return { file_ref: 'test-ref', path: f.ticket.path };
      }
      if (name === 'upload_media') return { projectId: f.item.projectId, status: 'completed', nodeId: 'test-node', resource: { resource_id: 'test-resource', review: { state: 'passed' } } };
      if (name === 'read_node') return { projectId: f.item.projectId, nodeId: 'test-node' };
      if (name === 'save_asset_from_node') return { projectId: f.item.projectId, status: 'completed', result: { asset: { assetId: 'test-asset' } } };
      if (name === 'get_asset') return { projectId: f.item.projectId, scope: 'personal', asset: { assetId: 'test-asset', assetVersion: '1', folderId: 7, tags: [`sha256:${f.item.sha256}`], items: [{ resourceIds: ['test-resource'] }] } };
      throw new Error('Unexpected tool ' + name);
    }
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(calls.length, 1);
  assert.deepEqual(tools.slice(0, 3), ['upload_ticket', 'upload_complete', 'upload_media']);
});

test('CLI accepts Chinese paths over stdin, reuses proof, and rejects malformed requests without exposing tickets', async t => {
  const f = fixture(t), calls = mockCurl(t);
  const cli = path.resolve('storyboard-workbench/scripts/libtv_upload.mjs');
  const invoke = input => childProcess.spawnSync(process.execPath, [cli, 'upload', '-'], { input, encoding: 'utf8', windowsHide: true });
  const request = { directory: f.directory, item: f.item, ticket: f.ticket };
  const paused = invoke(JSON.stringify(request));
  assert.equal(paused.status, 1);
  assert.match(JSON.parse(paused.stdout).error, /未获本次授权/);
  await transferLibTVFile(f.directory, f.item, f.ticket, { allowUpload: true });
  const replay = invoke(JSON.stringify(request));
  assert.equal(replay.status, 0);
  assert.equal(JSON.parse(replay.stdout).value.reused, true);
  assert.equal(calls.length, 1);
  const malformed = invoke('{"ticket":"https://example.invalid/?private-test" BROKEN}');
  assert.equal(malformed.status, 1);
  assert.equal(JSON.parse(malformed.stdout).ok, false);
  assert.ok(!malformed.stdout.includes('private-test'));
});
