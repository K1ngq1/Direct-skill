import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { applyAction, loadProject, exportProject, ProjectError } from './project.mjs';
import { exportExcel } from './export_excel.mjs';

const webRoot = fileURLToPath(new URL('../assets/web/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8' };
function send(response, status, content, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
  response.end(typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
}
export function createServer(directory) {
  directory = fs.realpathSync(directory);
  loadProject(directory);
  return http.createServer(async (request, response) => {
    try {
      const localHost = `127.0.0.1:${serverPort(response)}`;
      if (request.headers.host !== localHost) throw new ProjectError('只接受本地地址', 403);
      const url = new URL(request.url, `http://${localHost}`);
      if (request.method === 'POST') {
        if (request.headers.origin && request.headers.origin !== `http://${localHost}`) throw new ProjectError('跨站写入已拒绝', 403);
        if (request.headers['content-type'] !== 'application/json') throw new ProjectError('需要application/json', 415);
        const chunks = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 256000) throw new ProjectError('提交内容过大', 413);
          chunks.push(chunk);
        }
        if (url.pathname !== '/api/action') throw new ProjectError('接口不存在', 404);
        let action;
        try { action = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ProjectError('JSON格式错误'); }
        return send(response, 200, applyAction(directory, action));
      }
      if (request.method !== 'GET') throw new ProjectError('不支持该方法', 405);
      if (url.pathname === '/api/project') return send(response, 200, loadProject(directory));
      if (url.pathname === '/api/export.xlsx') {
        const { buffer, filename } = await exportExcel(loadProject(directory));
        const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
        response.setHeader('Content-Disposition', `attachment; filename="storyboard.xlsx"; filename*=UTF-8''${encoded}`);
        return send(response, 200, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      }
      if (url.pathname === '/api/export') { exportProject(directory); return send(response, 200, { ok: true }); }
      const routes = { '/': 'index.html', '/app.js': 'app.js', '/workflow.mjs': 'workflow.mjs', '/style.css': 'style.css' };
      let filename;
      if (routes[url.pathname]) filename = path.join(webRoot, routes[url.pathname]);
      else {
        const project = loadProject(directory);
        const reference = project.references.find(r => `/files/${r.path}` === decodeURIComponent(url.pathname));
        const exports = ['storyboard.md', 'selected-prompts.md', 'current-draft.md', 'static-prompts.md', 'pending-comments.md', 'project.json', 'libtv-batch.json', 'libtv-batch.md'];
        const exportName = url.pathname.startsWith('/exports/') ? url.pathname.slice(9) : null;
        if (['libtv-batch.json', 'libtv-batch.md'].includes(exportName) && !project.imageBatches?.length) throw new ProjectError('尚未准备LibTV提交清单；须先通过全片审核', 404);
        const relative = reference?.path ?? (exports.includes(exportName) ? `exports/${exportName}` : null);
        if (!relative) throw new ProjectError('文件不存在', 404);
        filename = fs.realpathSync(path.resolve(directory, relative));
        if (!filename.startsWith(directory + path.sep)) throw new ProjectError('路径超出项目', 403);
      }
      return send(response, 200, fs.readFileSync(filename), types[path.extname(filename)] ?? 'application/octet-stream');
    } catch (error) {
      const status = error.status ?? (error.code === 'ENOENT' ? 404 : 500);
      send(response, status, { error: status === 500 ? (request.url?.startsWith('/api/export.xlsx') ? 'Excel导出失败，请重试；仍失败时查看服务日志。' : '项目读取或保存失败，请查看服务日志') : error.message });
      if (status === 500) console.error(error);
    }
  });
}
function serverPort(response) { return response.socket.localPort; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) { console.error('用法：node server.mjs <项目目录> [--open] [--port=4318]'); process.exit(1); }
  const port = Number(process.argv.find(a => a.startsWith('--port='))?.slice(7) ?? 4318);
  const server = createServer(directory);
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口${port}已占用，请换--port参数` : error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    console.log(`STORYBOARD_URL=${url}`);
    if (process.argv.includes('--open')) {
      const args = process.platform === 'win32' ? ['-NoProfile', '-Command', `Start-Process '${url}'`] : [url];
      const command = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
      child.on('error', () => console.error('自动打开失败，请在系统浏览器打开上方地址'));
    }
  });
}
