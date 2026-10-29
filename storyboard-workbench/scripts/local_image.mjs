import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ProjectError } from './project.mjs';

export function validateLocalImage(directory, output) {
  const fail = message => { throw new ProjectError(message, 422); };
  if (typeof output?.path !== 'string' || !output.path.trim()) fail('图片路径须为非空文本');
  if (!/^[a-f0-9]{64}$/i.test(output.sha256 ?? '')) fail('图片缺少SHA256');
  const root = fs.realpathSync(directory), filename = path.resolve(root, output.path);
  const inside = value => { const relative = path.relative(root, value); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  if (path.isAbsolute(output.path) || !inside(filename)) fail('图片路径必须位于项目目录');
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) fail('图片文件不存在');
  const real = fs.realpathSync(filename);
  if (!inside(real)) fail('图片路径越出项目目录');
  if (crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') !== output.sha256.toLowerCase()) fail('图片哈希不一致');
  return real;
}
