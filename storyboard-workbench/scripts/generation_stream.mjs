import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createProcessLock } from './process_lock.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
const fail = message => { throw new Error(message); };

// The inventory is fixed; recipes and image adoption arrive while this one-shot host is running.
export async function generationStreamBridge(input, api) {
  const root = path.resolve(input.directory), specFile = path.join(root, 'stream.json');
  const { operation } = input;
  if (operation === 'stream-init') {
    const { tasks, startedAt = new Date().toISOString(), authorizedCount } = input;
    if (!Array.isArray(tasks) || !tasks.length || authorizedCount !== tasks.length || !Number.isFinite(Date.parse(startedAt)) || tasks.some(t => !/^[A-Za-z0-9_-]{1,80}$/.test(t.id ?? '') || !path.isAbsolute(t.recipe ?? '')) || new Set(tasks.map(t => t.id)).size !== tasks.length) fail('流水线须固定唯一任务、绝对recipe路径、授权数量和开始时间');
    const byId = new Map(tasks.map(t => [t.id, t])), visiting = new Set(), checked = new Set();
    const visit = id => {
      if (visiting.has(id)) fail('流水线依赖循环');
      if (checked.has(id)) return;
      visiting.add(id);
      const deps = byId.get(id).dependsOn ?? [];
      if (!Array.isArray(deps) || new Set(deps).size !== deps.length || deps.some(dep => !byId.has(dep))) fail('流水线依赖无效');
      deps.forEach(visit); visiting.delete(id); checked.add(id);
    };
    tasks.forEach(t => visit(t.id));
    fs.mkdirSync(root, { recursive: true });
    const spec = { schemaVersion: 1, tasks, authorizedCount, startedAt, startSource: input.startedAt ? 'provided' : 'first-observation' };
    if (fs.existsSync(specFile)) {
      const old = read(specFile);
      if (JSON.stringify(old.tasks) !== JSON.stringify(tasks) || old.authorizedCount !== authorizedCount || (input.startedAt && old.startedAt !== startedAt)) fail('不能覆盖本轮任务或开始时间');
      return old;
    }
    write(specFile, spec); return spec;
  }
  const spec = read(specFile);
  const lock = createProcessLock(path.join(root, '.stream-host.lock'));
  if (operation === 'stream-acquire') return lock.acquire();
  if (operation === 'stream-release') return lock.release({ owner: input.owner });
  if (operation === 'stream-close') {
    const file = path.join(root, 'closed.json');
    if (!fs.existsSync(file)) write(file, { closedAt: new Date().toISOString() });
    return { closed: true };
  }
  if (operation === 'stream-delivered') {
    const filename = path.resolve(input.summary ?? '');
    if (path.dirname(filename) !== root || !/^stream-summary-[a-f0-9-]+\.json$/.test(path.basename(filename))) fail('交付计时须引用本轮队列汇总');
    const summary = read(filename), finishedAt = input.finishedAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(finishedAt)) || Date.parse(finishedAt) < Date.parse(summary.finishedAt)) fail('交付完成时间须晚于队列结束');
    const record = { summary: filename, startedAt: spec.startedAt, startSource: spec.startSource, finishedAt,
      deliveryWallMs: Date.parse(finishedAt) - Date.parse(spec.startedAt), firstUsableStoryboardMs: summary.firstUsableStoryboardMs, runWallMs: summary.runWallMs };
    const file = path.join(root, `stream-delivery-${randomUUID()}.json`); write(file, record); return { ...record, path: file };
  }
  lock.assertOwner({ owner: input.owner });
  if (operation === 'stream-summary') {
    const finishedAt = new Date().toISOString();
    const summary = { ...input.report, startedAt: spec.startedAt, startSource: spec.startSource, finishedAt, runWallMs: Date.parse(finishedAt) - Date.parse(spec.startedAt), deliveryWallMs: null };
    const filename = path.join(root, `stream-summary-${randomUUID()}.json`);
    write(filename, summary); return { ...summary, path: filename };
  }
  if (operation !== 'stream-next') fail('未知流水线操作');
  const statuses = Object.create(null), candidates = [], blocked = [], usableStoryboards = [], awaitingReview = [];
  for (const task of spec.tasks) {
    const directory = path.join(root, task.id), preparedFile = path.join(directory, 'prepared.json');
    let prepared;
    try {
      if (fs.existsSync(preparedFile)) {
        prepared = read(preparedFile);
        const states = await api.bridge({ operation: 'snapshot', directory });
        const state = states[task.id];
        if (state) {
          statuses[task.id] = state;
          // Returned receipts can be saved even when the creative source has subsequently changed.
          if (state.status !== 'returned') {
            if (state.status === 'succeeded') {
              api.verifyPrepared(prepared);
              if (prepared.phase === 'storyboards' && task.adoption && fs.existsSync(task.adoption.path)) {
                const image = api.selected(task.adoption), recipe = read(task.recipe);
                const plan = recipe.planSource && api.selected(recipe.planSource);
                if ((api.userImageConfirmed(image) || plan && api.agentImageSelected(plan, image)) &&
                  (image.output ?? image).sha256 === state.output.sha256 &&
                  path.resolve(path.dirname(task.adoption.path), (image.output ?? image).path ?? '') === path.resolve(directory, state.output.path)) usableStoryboards.push(task.id);
              }
              if (prepared.phase === 'storyboards' && !usableStoryboards.includes(task.id)) awaitingReview.push(task.id);
            }
            continue;
          }
          candidates.push({ task, directory, prepared: preparedFile, recovery: true }); continue;
        }
      }
      if (!fs.existsSync(task.recipe)) { blocked.push({ id: task.id, reason: 'prompt-not-published' }); continue; }
      const recipe = read(task.recipe);
      if (recipe.tool !== 'imagegen' || recipe.concurrency && recipe.concurrency !== 1 || recipe.jobs?.length !== 1 || recipe.jobs[0].id !== task.id || recipe.jobs[0].dependsOn?.length) fail('流水线recipe须为单项imagegen，依赖声明在固定清单');
      const text = api.selected(recipe.jobs[0].source);
      const promptSha256 = createHash('sha256').update(JSON.stringify(text)).digest('hex');
      const checks = ['hard', 'semantic'].map(kind => {
        const source = recipe.checks?.[kind];
        const check = source && api.selected(source);
        if (check?.status !== 'passed' || check.promptSha256 !== promptSha256 || !check.reviewer?.trim()) fail('Prompt缺少绑定当前正文的硬校验或语义核对');
        return { ...source, sha256: api.sourceHash(source) };
      });
      if ((recipe.jobs[0].references ?? []).some(ref => !fs.existsSync(ref.path) || !ref.confirmation || !fs.existsSync(ref.confirmation.path))) { blocked.push({ id: task.id, reason: 'reference-not-ready' }); continue; }
      const fresh = api.prepareRequests(recipe);
      fresh.entries[0].sources.push(...checks);
      api.verifyPrepared(fresh);
      if (prepared) api.verifyPrepared(prepared);
      candidates.push({ task, directory, prepared: preparedFile, fresh });
    } catch (error) { blocked.push({ id: task.id, reason: String(error.message ?? error) }); if (statuses[task.id]?.status === 'succeeded') statuses[task.id] = { ...statuses[task.id], status: 'stale' }; }
  }
  const unknown = Object.values(statuses).some(s => ['claimed', 'submitting', 'submitted', 'pending', 'unknown'].includes(s.status));
  const ready = candidates.filter(c => c.recovery || !unknown && (c.task.dependsOn ?? []).every(id => statuses[id]?.status === 'succeeded'));
  const descendants = id => {
    const found = new Set();
    const visit = parent => { for (const t of spec.tasks) if ((t.dependsOn ?? []).includes(parent) && !found.has(t.id)) { found.add(t.id); visit(t.id); } };
    visit(id); return found.size;
  };
  ready.sort((a, b) => Number(b.recovery ?? false) - Number(a.recovery ?? false) || descendants(b.task.id) - descendants(a.task.id));
  const next = ready[0];
  if (next && !fs.existsSync(next.prepared)) {
    fs.mkdirSync(next.directory, { recursive: true });
    // init persists this exact prepared version before its first submission.
    next.prepared = path.join(root, `${next.task.id}-prepared-${randomUUID()}.json`);
    write(next.prepared, next.fresh);
  }
  const closed = fs.existsSync(path.join(root, 'closed.json'));
  const firstUsableFile = path.join(root, 'first-usable-storyboard.json');
  if (usableStoryboards.length && !fs.existsSync(firstUsableFile)) write(firstUsableFile, { id: usableStoryboards[0], observedAt: new Date().toISOString() });
  for (const candidate of candidates) if (!ready.includes(candidate)) blocked.push({ id: candidate.task.id, reason: 'dependency-not-ready' });
  for (const id of awaitingReview) blocked.push({ id, reason: 'awaiting-image-review' });
  return { next: next ? { id: next.task.id, directory: next.directory, prepared: next.prepared, authorizedCount: 1 } : null, statuses, blocked, usableStoryboards,
    firstUsableStoryboardAt: fs.existsSync(firstUsableFile) ? read(firstUsableFile).observedAt : null,
    done: !next && (unknown || closed || Object.keys(statuses).length === spec.tasks.length && !awaitingReview.length), unknown, closed, startedAt: spec.startedAt };
}
