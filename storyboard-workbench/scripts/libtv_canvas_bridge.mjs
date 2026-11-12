import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Copied verbatim to the tool host, which has no Node, filesystem or base64 globals.
export async function openLibTVCanvasBridge({ nodeExecutable, assetsScript, directory, uploadDirectory = directory, execCommand, writeStdin }) {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(nodeExecutable ?? '');
  const absolute = windows ? /^(?:[A-Za-z]:[\\/]|\\\\)/ : /^\//;
  const quote = value => {
    if (typeof value !== 'string' || !absolute.test(value) || /[\0\r\n]/.test(value)) throw new Error('桥接程序与目录须使用绝对路径');
    return "'" + value.replaceAll("'", windows ? "''" : "'\\''") + "'";
  };
  const cmd = (windows ? '& ' : '') + [quote(nodeExecutable), quote(assetsScript), 'receipts --canvas-stdio', quote(directory), quote(uploadDirectory)].join(' ');
  const first = await execCommand({ cmd, ...(windows ? { shell: 'powershell.exe' } : {}), login: false, tty: true, yield_time_ms: 20, max_output_tokens: 12000 });
  const session_id = first.session_id;
  const send = chars => writeStdin({ session_id, chars, yield_time_ms: 50, max_output_tokens: 12000 });
  const receive = async (chunk, requestId) => {
    let text = '', encoded = '';
    const deadline = Date.now() + 120000;
    for (;;) {
      text += chunk.output ?? '';
      const clean = text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      const marker = clean.match(/~(END|MORE)(?:\r?\n|$)/);
      if (marker) {
        encoded += [...clean.slice(0, marker.index).matchAll(/~B64 ([A-Za-z0-9+/=]{1,48})/g)].map(match => match[1]).join('');
        if (marker[1] === 'END') break;
        text = '';
        chunk = await send('{"operation":"drain"}\n');
      } else {
        if (chunk.exit_code != null || !session_id || Date.now() > deadline) throw new Error('LibTV 本地回执连接中断或超时，保留原请求');
        chunk = await send('');
      }
    }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('LibTV 回执分帧不完整');
    let bytes = '', buffer = 0, bits = 0;
    for (const c of encoded.replace(/=+$/, '')) {
      buffer = (buffer << 6) | alphabet.indexOf(c);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes += '%' + ((buffer >> bits) & 255).toString(16).padStart(2, '0');
      }
    }
    const response = JSON.parse(decodeURIComponent(bytes));
    if (response.requestId !== requestId) throw new Error('LibTV 本地回执序号不符，保留原请求');
    return response;
  };
  const ready = await receive(first);
  if (!ready.ok || !ready.value?.ready) throw new Error(ready.error ?? 'LibTV 回执进程未就绪');
  let tail = Promise.resolve(), sequence = 0, broken = false, closed = false;
  const request = input => {
    const work = tail.then(async () => {
      if ((broken && input.operation !== 'close') || closed) throw new Error('LibTV 本地回执连接已停止，请核查原回执');
      const requestId = ++sequence;
      let response;
      try {
        const body = JSON.stringify({ ...input, requestId });
        // ConPTY line editing can truncate long JSON. Send numbered short lines in a single write.
        const segments = body.match(/[\s\S]{1,700}/g);
        const lines = segments.length === 1 ? body : segments.map((data, index) =>
          JSON.stringify({ part: index, count: segments.length, requestId, data })).join('\n');
        response = await receive(await send(lines + '\n'), requestId);
      } catch (error) { broken = true; throw error; }
      if (!response.ok) throw Object.assign(new Error(response.error), { code: response.code });
      if (input.operation === 'close') closed = true;
      if (input.operation === 'write' && response.value?.saved) {
        return { ...response.value, receipt: { ...input.value, receiptSavedAt: response.value.receiptSavedAt } };
      }
      return response.value;
    });
    tail = work.catch(() => {});
    return work;
  };
  return {
    bridge(input) {
      if (!['snapshot', 'read', 'write', 'verify', 'canvas-ready', 'canvas-summary', 'canvas-export'].includes(input?.operation)) throw new Error('未知回执操作');
      return request(input);
    },
    checkLocal: () => request({ operation: 'checkLocal' }),
    async transfer(item, ticket, { recoverDnsFailure = false } = {}) {
      await request({ operation: 'transfer', item, ticket, allowUpload: true, recoverDnsFailure });
      for (;;) {
        const result = await request({ operation: 'transfer-result', id: item.id });
        if (!result.pending) {
          if (result.error) throw Object.assign(new Error(result.error), { returned: result.returned, storageFailed: result.storageFailed });
          return result.proof;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    },
    close: () => request({ operation: 'close' })
  };
}

export const libtvCanvasBridgeHostSource = () => openLibTVCanvasBridge.toString();

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === 'host-source') {
  process.stdout.write(libtvCanvasBridgeHostSource() + '\n');
}
