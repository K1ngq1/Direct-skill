import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { agentImageSelected, singleRunEnabled, userImageConfirmed } from './single_run.mjs';

// Only files inside the authorized production project may supply images or review evidence.
export function readCanvasReady({ projectDirectory, planFile, closedFile, sources, limit = 4 }) {
  const root = fs.realpathSync(projectDirectory);
  function inside(filename) {
    const resolved = fs.realpathSync(path.resolve(root, filename));
    const relative = path.relative(root, resolved);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('画布输入须位于本轮项目内');
    return resolved;
  }
  const plan = JSON.parse(fs.readFileSync(inside(planFile), 'utf8'));
  if (!singleRunEnabled(plan)) throw new Error('画布连续制作缺少冻结的单次制作授权');
  const closed = Boolean(closedFile && fs.existsSync(path.resolve(root, closedFile)) && inside(closedFile));
  const decisions = [], candidates = [], documents = new Map();
  for (const source of sources) {
    try {
      const file = inside(source.path);
      if (!documents.has(file)) documents.set(file, JSON.parse(fs.readFileSync(file, 'utf8')));
      let record = documents.get(file);
      for (const segment of source.pointer ? source.pointer.slice(1).split('/') : []) {
        const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
        record = record && Object.hasOwn(record, key) ? record[key] : null;
      }
      if (!record) {
        if (closed) decisions.push({ id: source.id, status: 'pending-review' });
        continue;
      }
      if (![record.id, record.assetId, record.targetId, record.imageId, record.shotId].includes(source.id)) throw new Error('看图记录与任务 ID 不一致');
      const status = record.review?.status;
      if (['needs-change', 'rejected'].includes(status)) {
        decisions.push({ id: source.id, status });
        continue;
      }
      if (['failed', 'unknown', 'blocked'].includes(record.status)) {
        decisions.push({ id: source.id, status: record.status });
        continue;
      }
      if (!(agentImageSelected(plan, record) || userImageConfirmed(record) && status === 'usable')) {
        if (closed) decisions.push({ id: source.id, status: 'pending-review' });
        continue;
      }
      candidates.push({ source, file, record, qualifiedAt: record.approval?.confirmedAt ?? record.selection?.selectedAt });
    } catch (error) {
      if (error.code === 'ENOENT' && !closed) continue;
      decisions.push({ id: source.id, status: 'blocked', error: error.message });
    }
  }
  candidates.sort((a, b) => Date.parse(a.qualifiedAt) - Date.parse(b.qualifiedAt));
  for (const { source, file, record, qualifiedAt } of candidates.slice(0, limit)) {
    try {
      const output = record.output ?? record;
      const image = inside(path.resolve(path.dirname(file), output.path));
      const bytes = fs.readFileSync(image), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (!bytes.length || sha256 !== output.sha256 || (record.review.outputSha256 && record.review.outputSha256 !== sha256)) throw new Error('实际文件与看图哈希不一致');
      decisions.push({ id: source.id, status: 'usable', path: image, fileName: path.basename(image), size: bytes.length,
        sha1: crypto.createHash('sha1').update(bytes).digest('hex'), sha256, qualifiedAt });
    } catch (error) { decisions.push({ id: source.id, status: 'blocked', error: error.message }); }
  }
  return decisions;
}
