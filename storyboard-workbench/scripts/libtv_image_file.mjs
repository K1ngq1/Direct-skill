import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { validateLocalImage } from './local_image.mjs';
import { createLibTVReceiptStore } from './libtv_assets.mjs';
import { withDeadline } from './media_batch.mjs';
import { createProcessLock } from './process_lock.mjs';

const formats = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

export function createLibTVImageLock(directory, id) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id ?? '') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) throw new Error('LibTV 图片锁身份无效');
  const receipts = path.join(fs.realpathSync(directory), '.libtv-image-receipts');
  if (fs.lstatSync(receipts).isSymbolicLink()) throw new Error('LibTV 图片回执目录不能是链接');
  return createProcessLock(path.join(receipts, `${id}.image.lock`));
}

// decodeImage must decode every pixel, not only read image headers or metadata.
export async function saveLibTVImage(directory, item, { fetch = globalThis.fetch, decodeImage, downloadTimeoutMs = 120000, localTimeoutMs = 30000 } = {}) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(item?.id ?? '') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(item.id)
    || !Object.hasOwn(formats, item.mime) || typeof item.sourceIdentity !== 'string' || !item.sourceIdentity.trim()
    || (item.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(item.expectedSha256))
    || typeof fetch !== 'function' || typeof decodeImage !== 'function'
    || ![downloadTimeoutMs, localTimeoutMs].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 2147483647)) throw new Error('LibTV 图片身份、格式、哈希、解码器或下载期限无效');
  let url;
  try { if (typeof item.url !== 'string') throw new Error(); url = new URL(item.url); } catch { throw new Error('LibTV 图片下载地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('LibTV 图片下载地址必须使用 HTTPS 且不含账户凭据');

  fs.mkdirSync(directory, { recursive: true });
  const root = fs.realpathSync(directory), receiptDirectory = path.join(root, '.libtv-image-receipts');
  const active = globalThis[Symbol.for('storyboard-workbench.libtv-image.active')] ??= new Map();
  const targetKey = path.join(root, item.id), activeKey = process.platform === 'win32' ? targetKey.toLowerCase() : targetKey;
  const pendingOperations = new Set();
  if (active.has(activeKey)) throw Object.assign(new Error('LibTV 原图片保存、下载或解码仍在执行；不能重复下载或解码'), { code: 'LOCAL_CALLBACK_PENDING' });
  const lease = {};
  active.set(activeKey, lease);
  let finished = false, processLock, processOwner, releaseError;
  const release = () => {
    if (!finished || pendingOperations.size || active.get(activeKey) !== lease) return;
    try { if (processOwner) processLock.release(processOwner); }
    catch (error) { releaseError = error; return; }
    active.delete(activeKey);
  };
  const track = promise => {
    pendingOperations.add(promise);
    const settled = () => { pendingOperations.delete(promise); release(); };
    promise.then(settled, settled);
    return promise;
  };
  try {
    fs.mkdirSync(receiptDirectory, { recursive: true });
    if (fs.lstatSync(receiptDirectory).isSymbolicLink()) throw new Error('LibTV 图片回执目录不能是链接');
    processLock = createLibTVImageLock(root, item.id);
    processOwner = processLock.acquire();
    const store = createLibTVReceiptStore(receiptDirectory), filename = `${item.id}.${extensions[item.mime]}`;
    const destination = path.join(root, filename), timings = { download: 0, hash: 0, decode: 0, save: 0 };
    const identity = { id: item.id, mime: item.mime, sourceIdentityHash: hash(item.sourceIdentity), expectedSha256: item.expectedSha256?.toLowerCase() ?? null };
    const result = (output, reused) => ({ path: destination, sha256: output.sha256, bytes: output.bytes, width: output.width, height: output.height, mime: output.mime, timings, reused });
    const measure = async (stage, operation) => {
      const start = performance.now();
      try { return await operation(); } finally { timings[stage] += Math.max(0, performance.now() - start); }
    };
    const receiptPath = stage => path.join(receiptDirectory, `${item.id}.${stage}.json`);
    const read = async stage => {
      const file = receiptPath(stage);
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('LibTV 图片回执不能是链接');
      let receipt;
      try { receipt = await store.readReceipt(item, stage); } catch { throw new Error('LibTV 图片回执无法读取'); }
      if (receipt && (receipt.schemaVersion !== 1 || JSON.stringify(receipt.identity) !== JSON.stringify(identity))) throw new Error('LibTV 图片回执与内容身份不一致');
      return receipt;
    };
    const persist = async (stage, receipt) => measure('save', async () => {
      processLock.assertOwner(processOwner);
      try { await store.writeReceipt(item, stage, { schemaVersion: 1, identity, ...receipt }, { exclusive: true }); }
      catch (error) { if (error.code !== 'EEXIST') throw new Error('LibTV 图片回执保存失败'); }
      const saved = await read(stage);
      const handle = fs.openSync(receiptPath(stage), 'r+');
      try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      return saved;
    });
    const verify = async (relative, output) => {
      if (typeof relative !== 'string' || path.basename(relative) !== relative || relative === '.' || relative === '..'
        || !/^[a-f0-9]{64}$/.test(output?.sha256 ?? '') || !positiveInteger(output?.bytes)
        || output.mime !== item.mime || (identity.expectedSha256 && output.sha256 !== identity.expectedSha256)) throw new Error('LibTV 图片检查点无效');
      const file = path.join(root, relative);
      await measure('hash', async () => {
        try {
          if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size !== output.bytes) throw new Error();
          validateLocalImage(root, { path: relative, sha256: output.sha256 });
        } catch { throw new Error('LibTV 图片文件缺失、被替换或哈希不一致'); }
      });
      const decoded = await measure('decode', async () => {
        let result;
        const decoding = track(Promise.resolve().then(() => decodeImage(file)));
        try { result = await withDeadline(decoding, localTimeoutMs, 'LibTV 图片完整解码'); }
        catch (error) {
          if (error?.code === 'CALL_TIMEOUT') throw Object.assign(new Error('LibTV 图片完整解码超时，保留已下载字节'), { code: 'CALL_TIMEOUT' });
          throw new Error('LibTV 图片完整解码失败');
        }
        if (!positiveInteger(result?.width) || !positiveInteger(result?.height)
          || result.format !== formats[item.mime]) throw new Error('LibTV 图片解码尺寸或格式不符');
        return { width: result.width, height: result.height };
      });
      if ((output.width !== undefined && output.width !== decoded.width) || (output.height !== undefined && output.height !== decoded.height)) throw new Error('LibTV 图片解码结果与检查点不一致');
      return decoded;
    };

    const claimed = await read('image_identity') || await persist('image_identity', { state: 'claimed' });
    if (claimed.state !== 'claimed') throw new Error('LibTV 图片身份回执无效');
    const completed = await read('image_completed');
    if (completed) {
      if (completed.state !== 'completed' || completed.output?.path !== filename || !positiveInteger(completed.output.width) || !positiveInteger(completed.output.height)) throw new Error('LibTV 图片完成回执无效');
      await verify(filename, completed.output);
      return result(completed.output, true);
    }

    let validated = await read('image_validated'), temporary, prepared = false;
    let reused = Boolean(validated);
    try {
      if (!validated) {
        if (fs.existsSync(destination)) throw new Error('LibTV 图片正式路径已有文件，缺少可核验检查点，拒绝覆盖');
        const downloaded = await read('image_downloaded');
        let output;
        if (downloaded) {
          if (downloaded.state !== 'downloaded' || downloaded.output?.path !== filename || typeof downloaded.temporary !== 'string'
            || !downloaded.temporary.startsWith(`.${item.id}.`) || !/^\.[A-Za-z0-9_-]+\.[a-f0-9-]{36}\.download$/.test(downloaded.temporary)) throw new Error('LibTV 图片下载检查点无效');
          temporary = downloaded.temporary; output = { ...downloaded.output }; prepared = true; reused = true;
        } else {
          const buffer = await measure('download', async () => {
            let response, bytes;
            const controller = new AbortController();
            try {
              ({ response, bytes } = await withDeadline(track((async () => {
                const response = await fetch(url.href, { redirect: 'error', signal: controller.signal });
                if (controller.signal.aborted) throw new Error('下载等待已结束');
                if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) throw new Error();
                return { response, bytes: Buffer.from(await response.arrayBuffer()) };
              })()), downloadTimeoutMs));
            } catch (error) {
              if (error?.code === 'CALL_TIMEOUT') {
                controller.abort();
                throw Object.assign(new Error('LibTV 图片下载超时，保留原交付检查点'), { code: 'CALL_TIMEOUT' });
              }
              throw new Error('LibTV 图片下载失败或 HTTP 状态无效');
            }
            const length = response.headers?.get('content-length');
            if (!bytes.length || (length != null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) !== bytes.length))) throw new Error('LibTV 图片下载为空或 Content-Length 不一致');
            return bytes;
          });
          const sha256 = await measure('hash', async () => hash(buffer));
          if (identity.expectedSha256 && sha256 !== identity.expectedSha256) throw new Error('LibTV 图片下载哈希不一致');
          temporary = `.${item.id}.${crypto.randomUUID()}.download`;
          await measure('save', async () => {
            processLock.assertOwner(processOwner);
            const handle = fs.openSync(path.join(root, temporary), 'wx');
            try { fs.writeFileSync(handle, buffer); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
          });
          output = { path: filename, sha256, bytes: buffer.length, mime: item.mime };
          prepared = true;
          await persist('image_downloaded', { state: 'downloaded', temporary, output, timings: { ...timings } });
        }
        Object.assign(output, await verify(temporary, output));
        prepared = true;
        validated = await persist('image_validated', { state: 'validated', temporary, output, timings: { ...timings } });
      }
      if (validated.state !== 'validated' || validated.output?.path !== filename || typeof validated.temporary !== 'string'
        || !positiveInteger(validated.output.width) || !positiveInteger(validated.output.height)
        || !validated.temporary.startsWith(`.${item.id}.`) || !/^\.[A-Za-z0-9_-]+\.[a-f0-9-]{36}\.download$/.test(validated.temporary)) throw new Error('LibTV 图片已验证检查点无效');
      if (fs.existsSync(destination)) await verify(filename, validated.output);
      else {
        if (validated.temporary !== temporary) await verify(validated.temporary, validated.output);
        await measure('save', async () => {
          processLock.assertOwner(processOwner);
          try {
            if (fs.existsSync(destination)) { await verify(filename, validated.output); return; }
            fs.renameSync(path.join(root, validated.temporary), destination);
            const handle = fs.openSync(destination, 'r+');
            try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
          }
          catch (error) {
            if (error.code !== 'EEXIST') throw new Error(`LibTV 图片发布失败，已保留检查点（${/^[A-Z]+$/.test(error.code) ? error.code : 'UNKNOWN'}）`);
            await verify(filename, validated.output);
          }
        });
      }
      const finished = await persist('image_completed', { state: 'completed', output: validated.output, timings: { ...timings } });
      if (finished.state !== 'completed' || JSON.stringify(finished.output) !== JSON.stringify(validated.output)) throw new Error('LibTV 图片完成回执不一致');
      const pendingFile = path.join(root, validated.temporary);
      if (fs.existsSync(pendingFile)) fs.unlinkSync(pendingFile);
      return result(validated.output, reused);
    } finally {
      // Keep the validated file until publication can be recovered after interruption.
      if (temporary && !pendingOperations.size && (!prepared || (validated && validated.temporary !== temporary)) && fs.existsSync(path.join(root, temporary))) fs.unlinkSync(path.join(root, temporary));
    }
  } finally { finished = true; release(); if (releaseError) throw releaseError; }
}
