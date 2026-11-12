import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLibTVReceiptStore } from './libtv_assets.mjs';
import { createProcessLock } from './process_lock.mjs';

const executable = process.platform === 'win32' ? 'curl.exe' : 'curl';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let curlReady;

export function checkLibTVCurl() {
  return curlReady ??= new Promise((resolve, reject) => {
    childProcess.execFile(executable, ['--disable', '--version'], { windowsHide: true, timeout: 5000, encoding: 'utf8' }, (error, stdout) => {
      if (error || !/^curl \d+\./.test(stdout) || !/^Protocols:.*\bhttps\b/m.test(stdout)) {
        reject(new Error('原生 curl 不可用或不支持 HTTPS；请安装 curl 后重新检查，不申请上传票据'));
      } else resolve({ executable, version: stdout.split(/\r?\n/)[0] });
    });
  }).catch(error => { curlReady = null; throw error; });
}

function partsFor(ticket, size) {
  if (!ticket || typeof ticket.uploadId !== 'string' || !ticket.uploadId || typeof ticket.path !== 'string' || !ticket.path || !Array.isArray(ticket.parts) || !ticket.parts.length) throw new Error('LibTV 上传票据缺少原身份或分片');
  let offset = 0;
  const parts = ticket.parts.map((part, index) => {
    let address;
    try { address = new URL(part.url); } catch { throw new Error('LibTV 分片地址无效'); }
    if (typeof part.url !== 'string' || /[\x00-\x20\x7f]/.test(part.url) || address.protocol !== 'https:' || address.username || address.password || address.hash || (part.method ?? 'PUT') !== 'PUT'
      || part.partNumber !== index + 1 || (part.headers && Object.keys(part.headers).length)) throw new Error('LibTV 分片须按原序号使用 HTTPS PUT；不支持的票据不能猜测执行');
    const length = part.partSize ?? ticket.partSize ?? (ticket.parts.length === 1 ? size : null);
    if (!Number.isSafeInteger(length) || length <= 0 || offset >= size) throw new Error('LibTV 分片长度缺失或无效');
    const start = offset;
    offset += Math.min(length, size - offset);
    return { url: part.url, start, end: offset };
  });
  if (offset !== size) throw new Error('LibTV 分片未覆盖完整文件');
  return parts;
}

async function putPart(directory, part, bytes, timeoutSeconds) {
  const filename = path.join(directory, `${crypto.randomUUID()}.curl-config`);
  // Keep signed addresses out of process arguments; send the verified bytes without a second image file.
  fs.writeFileSync(filename, `url = ${JSON.stringify(part.url)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    return await new Promise((resolve, reject) => {
      // curl otherwise adds chunked encoding to stdin, conflicting with the known Content-Length.
      const child = childProcess.spawn(executable, ['--disable', '--config', filename, '--globoff', '--proto', '=https',
        '--silent', '--show-error', '--connect-timeout', '15', '--max-time', String(timeoutSeconds),
        '--upload-file', '-', '--header', `Content-Length: ${bytes.length}`, '--header', 'Transfer-Encoding:', '--header', 'Expect:',
        '--output', process.platform === 'win32' ? 'NUL' : '/dev/null', '--write-out', '%{http_code} %{size_upload} %{time_total}'],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', inputFailed = false, spawnFailed = false, killed = false;
      const timer = setTimeout(() => { killed = true; child.kill(); }, (timeoutSeconds + 5) * 1000);
      child.stdout.on('data', chunk => { if (output.length < 4096) output += chunk.toString('utf8'); });
      child.stderr.resume(); // curl errors can contain credentials; only report exit/status codes.
      child.stdin.on('error', () => { inputFailed = true; });
      child.on('error', () => { spawnFailed = true; });
      child.on('close', code => {
        clearTimeout(timer);
        const fields = output.trim().split(/\s+/), status = Number(fields[0]), uploaded = Number(fields[1]), seconds = Number(fields[2]);
        if (spawnFailed || killed || inputFailed || code !== 0 || fields.length !== 3 || !Number.isInteger(status) || status < 200 || status >= 300 || uploaded !== bytes.length || !Number.isFinite(seconds) || seconds < 0) {
          reject(new Error(`curl 上传失败或结果未知（exit=${code}, HTTP=${Number.isInteger(status) ? status : 0}）；保留原票据，不自动重传`));
        } else resolve({ status, bytes: uploaded, transferMs: seconds * 1000 });
      });
      child.stdin.end(bytes);
    });
  } finally { fs.unlinkSync(filename); }
}

// shortcut: image-sized buffers preserve exactly the hashed bytes; use immutable streamed snapshots for large video uploads.
export async function transferLibTVFile(directory, item, ticket, { allowUpload = false, timeoutSeconds = 90, recoverDnsFailure = false } = {}) {
  if (!path.isAbsolute(directory ?? '') || !/^[A-Za-z0-9_-]{1,80}$/.test(item?.id ?? '') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(item.id)
    || !path.isAbsolute(item.path ?? '') || typeof item.projectId !== 'string' || !item.projectId.trim()
    || !Number.isSafeInteger(item.size) || item.size <= 0 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')
    || typeof allowUpload !== 'boolean' || typeof recoverDnsFailure !== 'boolean' || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new Error('LibTV 上传文件身份、授权或超时无效');
  const parts = partsFor(ticket, item.size);
  const bytes = await fs.promises.readFile(item.path);
  if (bytes.length !== item.size || hash(bytes) !== item.sha256 || (item.sha1 !== undefined && crypto.createHash('sha1').update(bytes).digest('hex') !== item.sha1)) throw new Error('LibTV 冻结文件长度或哈希已变化');
  fs.mkdirSync(directory, { recursive: true });
  const receiptDirectory = path.join(fs.realpathSync(directory), '.libtv-upload-receipts');
  fs.mkdirSync(receiptDirectory, { recursive: true });
  if (fs.lstatSync(receiptDirectory).isSymbolicLink()) throw new Error('LibTV 上传回执目录不能是链接');
  const lock = createProcessLock(path.join(receiptDirectory, `${item.id}.lock`)), owner = lock.acquire();
  try {
    const store = createLibTVReceiptStore(receiptDirectory);
    const identity = { id: item.id, projectId: item.projectId, path: item.path, bytes: item.size, sha256: item.sha256,
      uploadId: ticket.uploadId, remotePath: ticket.path, partsHash: hash(JSON.stringify(parts)) };
    const read = async stage => {
      const receipt = await store.readReceipt(item, stage);
      if (receipt && (receipt.schemaVersion !== 1 || JSON.stringify(receipt.identity) !== JSON.stringify(identity))) throw new Error('LibTV 上传回执与原文件或票据不一致');
      return receipt;
    };
    const completed = await read('curl_completed');
    if (completed) {
      const proof = completed.proof;
      if (completed.state !== 'completed' || !Number.isInteger(proof?.status) || proof.status < 200 || proof.status >= 300 || proof.bytes !== item.size || proof.sha256 !== item.sha256) throw new Error('LibTV 上传完成证明无效');
      return { ...proof, reused: true };
    }
    const submitted = await read('curl_submitted');
    if (submitted) {
      const failure = await read('curl_error');
      // A single-part curl exit 6 cannot send HTTP; all other incomplete PUTs remain blocked.
      if (!recoverDnsFailure || parts.length !== 1 || failure?.state !== 'unknown' || !/（exit=6, HTTP=0）/.test(failure.error ?? '')) throw new Error('LibTV 原 PUT 已提交但无完成证明；先核对原进程和服务端，不自动重传');
    } else if (recoverDnsFailure) throw new Error('DNS恢复须有同一原票据的单片解析失败证据');
    if (!allowUpload) throw new Error('LibTV 字节上传未获本次授权；仅允许复用完成证明');
    await checkLibTVCurl();
    const startedAt = new Date().toISOString(), start = performance.now();
    const base = { schemaVersion: 1, identity, startedAt };
    await store.writeReceipt(item, submitted ? 'curl_dns_recovery' : 'curl_submitted', { ...base, state: 'submitted' }, { exclusive: true });
    let status, transferMs = 0;
    try {
      for (const part of parts) {
        lock.assertOwner(owner);
        const result = await putPart(receiptDirectory, part, bytes.subarray(part.start, part.end), timeoutSeconds);
        status = result.status; transferMs += result.transferMs;
      }
    } catch (error) {
      await store.writeReceipt(item, submitted ? 'curl_dns_recovery.error' : 'curl_error', { ...base, state: 'unknown', error: error.message, finishedAt: new Date().toISOString() }, { exclusive: true });
      throw error;
    }
    const proof = { status, bytes: bytes.length, sha256: item.sha256, transport: 'native-curl', transferMs, wallMs: performance.now() - start };
    const returned = { ...base, state: 'completed', proof, finishedAt: new Date().toISOString() };
    try { await store.writeReceipt(item, 'curl_completed', returned, { exclusive: true }); }
    catch {
      try {
        lock.assertOwner(owner);
        const saved = await read('curl_completed');
        if (!saved) await store.writeReceipt(item, 'curl_completed', returned, { exclusive: true });
        else {
          if (JSON.stringify(saved) !== JSON.stringify(returned)) throw new Error('完成证明与原返回结果冲突');
          // The first write may have left the correct bytes but failed to flush them.
          const fd = fs.openSync(path.join(receiptDirectory, item.id + '.curl_completed.json'), 'r+');
          try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
      } catch (error) {
        throw Object.assign(new Error('curl 已返回成功，完成证明补存失败：' + error.message), { returned, storageFailed: true });
      }
    }
    return { ...proof, reused: false };
  } finally { lock.release(owner); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let value;
    if (process.argv[2] === 'doctor' && process.argv.length === 3) value = await checkLibTVCurl();
    else if (process.argv[2] === 'upload' && process.argv.length === 4) {
      let input;
      try { input = JSON.parse(fs.readFileSync(process.argv[3] === '-' ? 0 : process.argv[3], 'utf8')); }
      catch { throw new Error('无法读取 UTF-8 JSON 上传请求；不输出含签名票据的原文'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('LibTV 上传请求须为对象');
      value = await transferLibTVFile(input.directory, input.item, input.ticket, { allowUpload: input.allowUpload, timeoutSeconds: input.timeoutSeconds, recoverDnsFailure: input.recoverDnsFailure });
    } else throw new Error('用法：libtv_upload.mjs doctor | upload <request.json|->');
    process.stdout.write(JSON.stringify({ ok: true, value }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message, ...(error.returned ? { returned: error.returned, storageFailed: true } : {}) }) + '\n');
    process.exitCode = 1;
  }
}
