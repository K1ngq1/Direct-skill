import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createGenerationPipelineStore } from './generation_batch_store.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail = message => { throw new Error(message); };
const writeOnce = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
const sourceHash = source => Object.hasOwn(source, 'pointer') ? createHash('sha256').update(JSON.stringify(selected(source))).digest('hex') : hash(source.path);
function selected(source) {
  if (!path.isAbsolute(source?.path ?? '') || typeof source.pointer !== 'string' || (source.pointer && !source.pointer.startsWith('/'))) fail('来源须为绝对路径与JSON Pointer');
  let value = read(source.path);
  for (const key of source.pointer ? source.pointer.slice(1).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~')) : []) {
    if (!value || !Object.hasOwn(value, key)) fail('来源位置不存在');
    value = value[key];
  }
  return value;
}

// Preparation only reads creative sources; it never claims or submits media tasks.
export function prepareRequests(recipe) {
  const started = performance.now();
  if (!Array.isArray(recipe.jobs) || !recipe.jobs.length) fail('准备任务不能为空');
  const ids = new Set();
  const entries = recipe.jobs.map(entry => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(entry.id ?? '') || ids.has(entry.id) || entry.count !== 1) fail('任务ID须唯一且每项一张');
    ids.add(entry.id);
    const prompt = selected(entry.source);
    if (typeof prompt !== 'string' || !prompt.trim()) fail('正文来源不是完整文本');
    if (entry.request?.prompt !== undefined && entry.request.prompt !== prompt) fail('提交正文与创作来源不一致');
    const sources = [{ ...entry.source, sha256: sourceHash(entry.source) }];
    const blocked = [];
    if (!recipe.tool) blocked.push('tool-not-selected');
    if (!entry.request) blocked.push('parameters-not-ready');
    const references = entry.references ?? [];
    if (entry.request?.num_last_images_to_include) fail('预备请求须绑定本地参考，不依赖对话图片顺序');
    if (entry.request?.referenced_image_paths && JSON.stringify(entry.request.referenced_image_paths) !== JSON.stringify(references.map(ref => ref.path))) fail('请求参考与来源映射不一致');
    for (const ref of references) {
      if (!path.isAbsolute(ref.path ?? '')) fail('参考须为绝对路径');
      if (!ref.confirmation || !fs.existsSync(ref.path)) { blocked.push('reference-not-ready'); continue; }
      const confirmation = selected(ref.confirmation);
      sources.push({ ...ref.confirmation, sha256: sourceHash(ref.confirmation) });
      sources.push({ path: ref.path, sha256: hash(ref.path) });
      if (confirmation?.status !== 'confirmed' || confirmation.by !== 'user' || confirmation.assetId !== ref.assetId || confirmation.path !== ref.path || confirmation.sha256 !== hash(ref.path)) blocked.push('reference-not-confirmed');
    }
    if (recipe.phase === 'storyboards' && (!references.length || !entry.requiredAssetIds?.length)) blocked.push('asset-bindings-missing');
    for (const assetId of entry.requiredAssetIds ?? []) if (!references.some(ref => ref.assetId === assetId)) blocked.push('asset-binding-missing:' + assetId);
    return { job: { id: entry.id, count: 1, ...(entry.attempt ? { attempt: entry.attempt } : {}), ...(entry.projectId ? { projectId: entry.projectId } : {}), ...(entry.sourcePlanHash ? { sourcePlanHash: entry.sourcePlanHash } : {}), ...(entry.dependsOn ? { dependsOn: entry.dependsOn } : {}), request: { ...entry.request, prompt, ...(references.length ? { referenced_image_paths: references.map(ref => ref.path) } : {}) } }, sources, blocked };
  });
  return { schemaVersion: 1, batchId: recipe.batchId, version: recipe.version, phase: recipe.phase, tool: recipe.tool ?? null,
    concurrency: recipe.concurrency ?? (recipe.tool === 'imagegen' ? 1 : 4), run: recipe.run, preparationMs: performance.now() - started, entries };
}

function verifyPrepared(prepared, id) {
  const entries = id ? prepared.entries.filter(entry => entry.job.id === id) : prepared.entries;
  if (!entries.length || entries.some(entry => entry.blocked.length)) fail('任务仍有未就绪依赖');
  for (const entry of entries) for (const source of entry.sources) if (sourceHash(source) !== source.sha256) fail('创作或确认来源已变化；须重新准备新版本');
}

export async function bridge(input) {
  const { operation, directory, args = [] } = input;
  if (operation === 'compile') {
    const prepared = prepareRequests(read(input.recipe));
    writeOnce(input.output, prepared);
    return { path: input.output, ready: prepared.entries.filter(entry => !entry.blocked.length).length, total: prepared.entries.length };
  }
  const root = path.resolve(directory);
  let prepared;
  if (operation === 'init') {
    prepared = read(input.prepared);
    verifyPrepared(prepared);
    if (input.authorizedCount !== prepared.entries.length) fail('授权数量与任务数不一致');
  } else if (fs.existsSync(path.join(root, 'prepared.json'))) prepared = read(path.join(root, 'prepared.json'));
  const plan = operation === 'init' ? { ...prepared, jobs: prepared.entries.map(entry => entry.job) } : read(path.join(root, 'batch.json'));
  if (prepared && ['init', 'prepare'].includes(operation)) verifyPrepared(prepared, operation === 'prepare' ? args[0] : undefined);
  const store = createGenerationPipelineStore(root, plan.jobs, { batchId: plan.batchId, version: plan.version, phase: plan.phase, concurrency: prepared?.concurrency ?? 4, run: prepared?.run });
  if (operation === 'init') {
    const file = path.join(root, 'prepared.json');
    if (fs.existsSync(file)) { if (JSON.stringify(read(file)) !== JSON.stringify(prepared)) fail('不能覆盖原准备记录'); }
    else writeOnce(file, prepared);
    return { batch: store.batch, run: store.run, concurrency: prepared.concurrency, jobs: store.jobs.map(({ id, dependsOn }) => ({ id, dependsOn })), initialStates: store.snapshot() };
  }
  if (operation === 'summarize') {
    const started = performance.now();
    const states = store.snapshot();
    const results = plan.jobs.map(job => states[job.id] ?? { id: job.id, status: 'paused' });
    const toolWaitMs = results.reduce((sum, item) => sum + (item.toolReturnedAt && item.callStartedAt ? Math.max(0, Date.parse(item.toolReturnedAt) - Date.parse(item.callStartedAt)) : 0), 0);
    const receiptSaveMs = results.reduce((sum, item) => sum + (item.finalizeMs ?? 0), 0);
    const summary = store.summarize(results, { ...(args[0] ?? { deliveryAllowed: true }), timing: { preparationMs: prepared?.preparationMs ?? null, toolWaitMs, receiptSaveMs, source: 'host-events; excludes-user-wait; not-gpu-time' } });
    return { ...summary, summaryMs: performance.now() - started };
  }
  if (!['snapshot', 'readControl', 'setControl', 'acknowledgeControl', 'prepare', 'capture', 'finalize', 'load', 'inspectFinalization', 'recoverFinalization'].includes(operation)) fail('未知存储操作');
  return store[operation](...args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(fs.readFileSync(process.argv[2] ?? 0, 'utf8'));
    console.log(JSON.stringify({ ok: true, value: await bridge(input) ?? null }));
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message, code: error.code ?? null })); process.exitCode = 1; }
}
