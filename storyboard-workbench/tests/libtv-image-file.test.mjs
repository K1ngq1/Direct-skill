import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { saveLibTVImage, createLibTVImageLock } from '../scripts/libtv_image_file.mjs';

const pixels = Buffer.from('mock fully decodable image');
const sha256 = crypto.createHash('sha256').update(pixels).digest('hex');
const item = { id: 'S01', url: 'https://media.example.invalid/image?secret=private-token', mime: 'image/png', sourceIdentity: 'sha256-source-identity' };
const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'libtv-image-file-'));
const receiptPath = (root, stage) => path.join(root, '.libtv-image-receipts', `${item.id}.image_${stage}.json`);
const receipt = (root, stage) => JSON.parse(fs.readFileSync(receiptPath(root, stage), 'utf8'));

function imageProcess(root, hold) {
  const source = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { saveLibTVImage } from ${JSON.stringify(new URL('../scripts/libtv_image_file.mjs', import.meta.url).href)};
    const [root, hold] = process.argv.slice(1);
    const pixels = Buffer.from('mock fully decodable image');
    let downloads = 0, decodes = 0;
    if (hold) setInterval(() => {}, 1000);
    const pause = stage => { process.send({ event: stage }); return new Promise(() => {}); };
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to !== path.join(root, 'S01.png')) return rename(from, to);
      const checkpoint = () => {
        process.send({ event: hold, destinationExists: fs.existsSync(to), bytes: fs.statSync(fs.existsSync(to) ? to : from).size });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      };
      if (hold === 'publish') checkpoint();
      const result = rename(from, to);
      if (hold === 'published') checkpoint();
      return result;
    };
    fs.copyFileSync = () => { throw new Error('publication must not copy partial bytes to the final path'); };
    try {
      const saved = await saveLibTVImage(root, ${JSON.stringify(item)}, {
        localTimeoutMs: 30, downloadTimeoutMs: 30,
        fetch: async () => { downloads++; if (hold === 'download') return pause('download'); return new Response(pixels); },
        decodeImage: async () => { decodes++; if (hold === 'decode') return pause('decode'); return { width: 1920, height: 1080, format: 'png' }; }
      });
      process.send({ event: 'result', downloads, decodes, saved });
    } catch (error) { process.send({ event: 'result', downloads, decodes, code: error.code, error: error.message }); }
    if (!hold) process.disconnect();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, hold ?? ''], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = [], waiters = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', message => {
    messages.push(message);
    for (const waiter of [...waiters]) if (waiter.event === message.event) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, stderr })));
  const wait = event => {
    const found = messages.find(message => message.event === event);
    return found ? Promise.resolve(found) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child did not send ${event}: ${stderr}`)), 3000);
      waiters.push({ event, resolve: value => { clearTimeout(timer); resolve(value); } });
    });
  };
  return { child, wait, exited };
}
function mock(body = pixels) {
  let calls = 0, decodes = 0;
  return {
    options: {
      fetch: async (_url, options) => { calls++; assert.equal(options.redirect, 'error'); return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } }); },
      decodeImage: async file => { decodes++; assert.deepEqual(fs.readFileSync(file), pixels); return { width: 1920, height: 1080, format: 'png' }; }
    },
    calls: () => calls,
    decodes: () => decodes
  };
}

test('saved images are fully rechecked and reused without downloading; refreshed URLs do not change identity', async () => {
  const root = directory(), harness = mock();
  const first = await saveLibTVImage(root, item, harness.options);
  assert.equal(first.reused, false);
  assert.equal(first.path, path.join(root, 'S01.png'));
  assert.equal(first.sha256, sha256);
  assert.equal(first.bytes, pixels.length);
  assert.deepEqual([first.width, first.height, first.mime], [1920, 1080, 'image/png']);
  assert.ok(Object.values(first.timings).every(value => Number.isFinite(value) && value >= 0));
  const second = await saveLibTVImage(root, { ...item, url: 'https://media.example.invalid/refreshed' }, harness.options);
  assert.equal(second.reused, true);
  assert.equal(second.timings.download, 0);
  assert.equal(harness.calls(), 1);
  assert.equal(harness.decodes(), 2);
  for (const stage of ['identity', 'validated', 'completed']) assert.equal(fs.readFileSync(receiptPath(root, stage), 'utf8').includes('https:'), false);
  assert.deepEqual(fs.readdirSync(root).sort(), ['.libtv-image-receipts', 'S01.png']);
});

test('validated downloads recover before and after formal publication without another request', async () => {
  for (const published of [false, true]) {
    const root = directory(), harness = mock();
    await saveLibTVImage(root, item, harness.options);
    const saved = receipt(root, 'validated');
    fs.unlinkSync(receiptPath(root, 'completed'));
    if (!published) {
      fs.unlinkSync(path.join(root, 'S01.png'));
      fs.writeFileSync(path.join(root, saved.temporary), pixels);
    }
    const recovered = await saveLibTVImage(root, item, harness.options);
    assert.equal(recovered.reused, true);
    assert.equal(harness.calls(), 1);
    assert.equal(receipt(root, 'completed').state, 'completed');
    assert.equal(fs.existsSync(path.join(root, saved.temporary)), false);
  }
});

test('bad hash, HTTP, length, empty bytes and decoding errors never leave a successful checkpoint', async () => {
  const failures = [
    { patch: { expectedSha256: 'a'.repeat(64) }, pattern: /哈希/ },
    { fetch: async () => new Response('denied', { status: 403 }), pattern: /HTTP/ },
    { fetch: async () => { throw new Error(item.url); }, pattern: /下载/ },
    { fetch: async () => new Response(pixels, { headers: { 'content-length': '999' } }), pattern: /Content-Length/ },
    { fetch: async () => new Response(''), pattern: /为空/ },
    { body: Buffer.from('garbage'), pattern: /完整解码/ },
    { decodeImage: async () => { throw new Error(item.url); }, pattern: /完整解码/ },
    { decodeImage: async () => ({ width: 0, height: 10, format: 'png' }), pattern: /尺寸或格式/ },
    { decodeImage: async () => ({ width: 10, height: 10, format: 'jpeg' }), pattern: /尺寸或格式/ }
  ];
  for (const failure of failures) {
    const root = directory(), harness = mock(failure.body);
    await assert.rejects(saveLibTVImage(root, { ...item, ...failure.patch }, {
      ...harness.options,
      ...(failure.fetch ? { fetch: failure.fetch } : {}),
      ...(failure.decodeImage ? { decodeImage: failure.decodeImage } : {})
    }), error => { assert.match(error.message, failure.pattern); assert.equal(error.message.includes('private-token'), false); return true; });
    assert.equal(fs.existsSync(receiptPath(root, 'validated')), false);
    assert.equal(fs.existsSync(receiptPath(root, 'completed')), false);
    const downloaded = fs.existsSync(receiptPath(root, 'downloaded')) ? receipt(root, 'downloaded') : null;
    assert.deepEqual(fs.readdirSync(root).sort(), ['.libtv-image-receipts', ...(downloaded ? [downloaded.temporary] : [])].sort());
  }
});

test('unsafe paths, unsupported URLs and changed content identity are rejected', async () => {
  const root = directory(), harness = mock();
  for (const patch of [{ id: '../escape' }, { id: 'CON' }, { mime: 'text/html' }, { url: 'http://example.invalid' }, { url: 'https://user:pass@example.invalid' }, { sourceIdentity: '' }, { expectedSha256: 'bad' }]) {
    await assert.rejects(saveLibTVImage(root, { ...item, ...patch }, harness.options));
  }
  assert.equal(harness.calls(), 0);
  await saveLibTVImage(root, item, harness.options);
  for (const patch of [{ sourceIdentity: 'different-source' }, { mime: 'image/jpeg' }, { expectedSha256: sha256 }]) {
    await assert.rejects(saveLibTVImage(root, { ...item, ...patch }, harness.options), /内容身份不一致/);
  }
  assert.equal(harness.calls(), 1);
});

test('existing files and corrupted checkpoints are preserved and refused without redownload', async () => {
  const root = directory(), harness = mock(), existing = path.join(root, 'S01.png');
  fs.writeFileSync(existing, 'user file');
  await assert.rejects(saveLibTVImage(root, item, harness.options), /拒绝覆盖/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'user file');
  assert.equal(harness.calls(), 0);
  fs.unlinkSync(existing);
  await saveLibTVImage(root, item, harness.options);
  fs.writeFileSync(existing, 'changed');
  await assert.rejects(saveLibTVImage(root, item, harness.options), /哈希不一致/);
  assert.equal(harness.calls(), 1);
  fs.writeFileSync(existing, pixels);
  fs.unlinkSync(receiptPath(root, 'completed'));
  const saved = receipt(root, 'validated');
  saved.temporary = '../../outside.png';
  fs.writeFileSync(receiptPath(root, 'validated'), JSON.stringify(saved));
  await assert.rejects(saveLibTVImage(root, item, harness.options), /检查点无效/);
  assert.equal(harness.calls(), 1);
});

test('download deadline covers stalled fetch and response body, aborts and permits safe retry', { timeout: 2000 }, async t => {
  for (const stage of ['fetch', 'body']) await t.test(stage, async () => {
    const root = directory(), harness = mock();
    let signal, resolveLate;
    const late = new Promise(resolve => { resolveLate = resolve; });
    const fetch = async (_url, options) => {
      signal = options.signal;
      if (stage === 'fetch') return late;
      return { status: 200, headers: { get: () => null }, arrayBuffer: () => late };
    };
    await assert.rejects(saveLibTVImage(root, item, { ...harness.options, fetch, downloadTimeoutMs: 20 }), error => {
      assert.equal(error.code, 'CALL_TIMEOUT');
      assert.match(error.message, /下载超时/);
      assert.equal(error.message.includes('private-token'), false);
      return true;
    });
    assert.equal(signal.aborted, true);
    assert.equal(fs.existsSync(receiptPath(root, 'validated')), false);
    assert.equal(fs.existsSync(receiptPath(root, 'completed')), false);
    await assert.rejects(saveLibTVImage(root, item, harness.options), error => error.code === 'LOCAL_CALLBACK_PENDING');
    resolveLate(stage === 'fetch' ? new Response(pixels) : pixels);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(fs.readdirSync(root), ['.libtv-image-receipts']);
    const recovered = await saveLibTVImage(root, item, harness.options);
    assert.equal(recovered.sha256, sha256);
    assert.equal(harness.calls(), 1);
  });
});

test('invalid download deadlines reject before creating image checkpoints or requesting bytes', async () => {
  const root = directory(), harness = mock();
  for (const downloadTimeoutMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
    await assert.rejects(saveLibTVImage(root, item, { ...harness.options, downloadTimeoutMs }), /下载期限无效/);
  }
  assert.equal(harness.calls(), 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('decode timeout preserves bytes, blocks overlapping retries and recovers without another download', { timeout: 2000 }, async () => {
  const root = directory(), harness = mock();
  let resolveLate, decodingFile;
  const late = new Promise(resolve => { resolveLate = resolve; });
  await assert.rejects(saveLibTVImage(root, item, { ...harness.options, localTimeoutMs: 20, decodeImage: file => { decodingFile = file; return late; } }), error => error.code === 'CALL_TIMEOUT');
  assert.equal(fs.existsSync(decodingFile), true, 'the timed-out decoder may still be reading these bytes');
  assert.equal(receipt(root, 'downloaded').state, 'downloaded');
  assert.equal(fs.existsSync(receiptPath(root, 'validated')), false);
  assert.equal(fs.existsSync(path.join(root, 'S01.png')), false);
  await assert.rejects(saveLibTVImage(root, item, harness.options), error => error.code === 'LOCAL_CALLBACK_PENDING');
  assert.equal(harness.calls(), 1);
  resolveLate({ width: 1920, height: 1080, format: 'png' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.existsSync(receiptPath(root, 'validated')), false);
  const recovered = await saveLibTVImage(root, item, harness.options);
  assert.equal(recovered.sha256, sha256);
  assert.equal(recovered.reused, true);
  assert.equal(harness.calls(), 1);
  assert.equal(fs.existsSync(decodingFile), false);
});

test('download checkpoint recovery rejects replaced bytes without redownloading', { timeout: 2000 }, async () => {
  const root = directory(), harness = mock();
  let resolveLate;
  const late = new Promise(resolve => { resolveLate = resolve; });
  await assert.rejects(saveLibTVImage(root, item, { ...harness.options, localTimeoutMs: 20, decodeImage: () => late }), error => error.code === 'CALL_TIMEOUT');
  resolveLate({ width: 1920, height: 1080, format: 'png' });
  await new Promise(resolve => setImmediate(resolve));
  const checkpoint = receipt(root, 'downloaded');
  fs.writeFileSync(path.join(root, checkpoint.temporary), 'replaced');
  await assert.rejects(saveLibTVImage(root, item, harness.options), /哈希不一致/);
  assert.equal(harness.calls(), 1);
  assert.equal(fs.existsSync(receiptPath(root, 'completed')), false);
});

test('parallel saves cannot duplicate a download and an aborted late fetch does not read its body', { timeout: 2000 }, async () => {
  const root = directory(), harness = mock();
  let resolveLate, started, requests = 0, bodies = 0;
  const late = new Promise(resolve => { resolveLate = resolve; });
  const active = new Promise(resolve => { started = resolve; });
  const saving = saveLibTVImage(root, item, { ...harness.options, downloadTimeoutMs: 20, fetch: () => { requests++; started(); return late; } });
  await active;
  await assert.rejects(saveLibTVImage(root, item, harness.options), error => error.code === 'LOCAL_CALLBACK_PENDING');
  await assert.rejects(saving, error => error.code === 'CALL_TIMEOUT');
  resolveLate({ status: 200, headers: { get: () => null }, arrayBuffer: () => { bodies++; return pixels; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1); assert.equal(bodies, 0);
  assert.equal((await saveLibTVImage(root, item, harness.options)).sha256, sha256);
});

test('invalid decoder deadlines reject before creating checkpoints or downloading', async () => {
  const root = directory(), harness = mock();
  for (const localTimeoutMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
    await assert.rejects(saveLibTVImage(root, item, { ...harness.options, localTimeoutMs }), /下载期限无效/);
  }
  assert.equal(harness.calls(), 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('a stalled verification preserves the completed file and blocks concurrent decoder work', { timeout: 2000 }, async () => {
  const root = directory(), harness = mock();
  await saveLibTVImage(root, item, harness.options);
  const before = receipt(root, 'completed');
  let resolveLate;
  const late = new Promise(resolve => { resolveLate = resolve; });
  await assert.rejects(saveLibTVImage(root, item, { ...harness.options, localTimeoutMs: 20, decodeImage: () => late }), error => error.code === 'CALL_TIMEOUT');
  await assert.rejects(saveLibTVImage(root, item, harness.options), error => error.code === 'LOCAL_CALLBACK_PENDING');
  assert.deepEqual(receipt(root, 'completed'), before);
  assert.deepEqual(fs.readFileSync(path.join(root, 'S01.png')), pixels);
  resolveLate({ width: 1920, height: 1080, format: 'png' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await saveLibTVImage(root, item, harness.options)).reused, true);
  assert.equal(harness.calls(), 1);
});

test('live processes retain image ownership after timeout; confirmed dead owners recover without duplicate decode downloads', { timeout: 12000 }, async t => {
  for (const stage of ['download', 'decode']) await t.test(stage, async t => {
    const root = directory(), processes = [];
    const start = hold => { const child = imageProcess(root, hold); processes.push(child); return child; };
    t.after(async () => { for (const entry of processes) { if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill(); await entry.exited; } });
    const first = start(stage);
    await first.wait(stage);
    assert.equal((await first.wait('result')).code, 'CALL_TIMEOUT');
    const lock = createLibTVImageLock(root, item.id), owner = lock.inspect().owner;
    assert.throws(() => lock.recover({ owner, reason: 'offline regression: owner still alive' }));
    const second = start();
    const blocked = await second.wait('result');
    await second.exited;
    assert.ok(blocked.error);
    assert.equal(blocked.downloads, 0); assert.equal(blocked.decodes, 0);
    first.child.kill(); await first.exited;
    lock.recover({ owner, reason: 'offline regression: known child process exited' });
    const resumed = start(), result = await resumed.wait('result');
    await resumed.exited;
    assert.equal(result.error, undefined);
    assert.equal(result.saved.sha256, sha256);
    assert.equal(result.downloads, stage === 'decode' ? 0 : 1);
    assert.equal(result.decodes, 1);
    assert.equal(lock.inspect(), null);
  });
});

test('process death around atomic publication exposes no partial image and resumes without downloading', { timeout: 12000 }, async t => {
  for (const stage of ['publish', 'published']) await t.test(stage, async t => {
    const root = directory(), processes = [];
    const start = hold => { const entry = imageProcess(root, hold); processes.push(entry); return entry; };
    t.after(async () => { for (const entry of processes) { if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill(); await entry.exited; } });
    const interrupted = start(stage), observed = await interrupted.wait(stage);
    assert.equal(observed.destinationExists, stage === 'published');
    assert.equal(observed.bytes, pixels.length);
    assert.equal(receipt(root, 'validated').state, 'validated');
    assert.equal(fs.existsSync(receiptPath(root, 'completed')), false);
    const destination = path.join(root, 'S01.png');
    if (stage === 'published') assert.deepEqual(fs.readFileSync(destination), pixels);
    else assert.equal(fs.existsSync(destination), false);
    const lock = createLibTVImageLock(root, item.id), owner = lock.inspect().owner;
    interrupted.child.kill(); await interrupted.exited;
    lock.recover({ owner, reason: 'offline regression: publication child exited' });
    const resumed = start(), result = await resumed.wait('result');
    await resumed.exited;
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.downloads, 0);
    assert.equal(result.decodes, 1);
    assert.equal(result.saved.reused, true);
    assert.deepEqual(fs.readFileSync(destination), pixels);
    assert.equal(lock.inspect(), null);
  });
});
