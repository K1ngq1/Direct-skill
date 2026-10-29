import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { ProjectError } from './project.mjs';
import { promptHash, validateVisualPlan, validateLocalImage } from './visual.mjs';
import { validateCharacterBundle, validateSceneBundle } from './export_visual_excel.mjs';
import { mediaBatchHostSource } from './media_batch.mjs';
export { runConcurrentJobs, runMediaBatch, runMediaBatchAndSummarize, runMediaPipeline, createMediaBatchController, mediaBatchHostSource } from './media_batch.mjs';
export { createGenerationBatchStore, createGenerationPipelineStore } from './generation_batch_store.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const fail = message => { throw new ProjectError(message, 422); };
const sameIds = (left, right) => left.length === right.length && left.every(id => right.includes(id));

export async function auditGenerationTranscript(filename, turnId) {
  const lines = createInterface({ input: fs.createReadStream(filename, { encoding: 'utf8' }), crlfDelay: Infinity });
  let selected, active = false, lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { fail(`会话JSONL第${lineNumber}行无法解析`); }
      if (row.type !== 'event_msg') continue;
      const event = row.payload;
      if (event?.type === 'task_started') {
        active = !turnId || event.turn_id === turnId;
        if (active) selected = { turnId: event.turn_id, startedAt: row.timestamp, finishedAt: null, intervals: new Map() };
      }
      if (!active || !selected) continue;
      if (['task_complete', 'turn_aborted'].includes(event.type)) selected.finishedAt = row.timestamp;
      if (event.type !== 'item_completed' || event.item?.type !== 'Extension' || event.item.kind !== 'image_gen.generation') continue;
      const { started_at_ms: start, completed_at_ms: end } = event;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || typeof event.item.id !== 'string') fail(`生图执行区间无效，第${lineNumber}行`);
      const interval = { id: event.item.id, start, end };
      const old = selected.intervals.get(interval.id);
      if (old && (old.start !== start || old.end !== end)) fail('同一生图工具ID存在冲突时间');
      selected.intervals.set(interval.id, interval);
    }
  } finally { lines.close(); }
  if (!selected) fail('未找到指定任务的开始记录');
  const intervals = [...selected.intervals.values()].sort((a, b) => a.start - b.start);
  const points = intervals.filter(x => x.end > x.start).flatMap(x => [[x.start, 1], [x.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0, peak = 0;
  for (const [, change] of points) { current += change; peak = Math.max(peak, current); }
  return {
    turnId: selected.turnId, startedAt: selected.startedAt, finishedAt: selected.finishedAt,
    toolExecutionSamples: intervals.length, observedToolExecutionPeak: intervals.length ? peak : null,
    executionEvidence: intervals.length ? 'host-extension-events' : 'unobserved', serverExecutionPeak: null,
    toolExecutionTotalMs: intervals.reduce((total, x) => total + x.end - x.start, 0),
    intervals: intervals.map(x => ({ id: x.id, startedAt: new Date(x.start).toISOString(), finishedAt: new Date(x.end).toISOString(), durationMs: x.end - x.start }))
  };
}


export function validateGenerationManifest(directory, manifest = read(path.join(directory, 'generation-manifest.json'))) {
  return validateGenerationProject(directory, manifest).generation;
}

export function validateGenerationProject(directory, manifest = read(path.join(directory, 'generation-manifest.json'))) {
  const checked = validateVisualPlan(directory, undefined, { generationManifest: manifest });
  return { ...checked, generation: inspectGenerationManifest(directory, manifest, checked) };
}

function inspectGenerationManifest(directory, manifest, { plan, project }) {
  if (manifest.schemaVersion !== 1 || manifest.projectId !== plan.projectId || manifest.sourcePlanHash !== promptHash(JSON.stringify(plan))) fail('生成清单与冻结项目版本不匹配');
  if (!Array.isArray(manifest.tasks)) fail('生成任务须为数组');
  const characters = validateCharacterBundle(read(path.join(directory, 'character-prompts.json')), plan).characters;
  const locations = validateSceneBundle(read(path.join(directory, 'scene-prompts.json')), plan).locations;
  for (const [assets, entries] of [[plan.productionInventory.characters, characters], [plan.productionInventory.locations, locations]]) {
    if (!sameIds(assets.map(asset => asset.id), entries.map(entry => entry.assetId))) fail('资产Prompt须覆盖本项目全部人物和场景；仅局部人物可显式标记not-required');
  }
  const expected = [
    ...characters.filter(entry => entry.base.mode === 'generate').map(entry => ({ phase: 'assets', targetType: 'character', targetId: entry.assetId, text: entry.base.text })),
    ...locations.map(entry => ({ phase: 'assets', targetType: 'location', targetId: entry.assetId, text: entry.base.text })),
    ...plan.shots.filter(shot => !shot.reuseOf).map(shot => ({ phase: 'storyboards', targetType: 'shot', targetId: shot.id, text: shot.prompt.text }))
  ];
  const key = task => `${task.phase}:${task.targetType}:${task.targetId}`;
  if (manifest.tasks.length !== expected.length || new Set(manifest.tasks.map(key)).size !== expected.length) fail('生成任务须逐一覆盖资产与独立分镜，复用帧和道具不得另建任务');
  const taskIds = new Set(), outputPaths = new Set();
  for (const task of manifest.tasks) {
    if (typeof task.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(task.id) || taskIds.has(task.id)) fail('生成任务ID无效或重复');
    taskIds.add(task.id);
    const target = expected.find(entry => key(entry) === key(task));
    if (!target) fail('生成任务包含未知资产、道具或复用帧');
    if (task.count !== 1) fail('每条Prompt仅生成一张图片');
    if (task.promptHash !== promptHash(target.text)) fail(`${task.id}生成Prompt与冻结正文不一致`);
    if (!['planned', 'submitted', 'succeeded', 'failed', 'unknown'].includes(task.status)) fail('生成状态无效');
    if (!Array.isArray(task.inputReferenceIds) || new Set(task.inputReferenceIds).size !== task.inputReferenceIds.length || task.inputReferenceIds.some(id => !plan.references.some(ref => ref.id === id))) fail('生成输入参考不存在或重复');
    if (!['pending', 'confirmed', 'rejected'].includes(task.approval?.status)) fail('用户确认状态无效');
    if (task.approval.status === 'pending' ? task.approval.by !== null : task.approval.by !== 'user') fail('资产采用必须由用户确认，不能代为确认');
    if (task.approval.status === 'confirmed' && (task.status !== 'succeeded' || !Number.isFinite(Date.parse(task.approval.confirmedAt)))) fail('用户确认须绑定成功输出及确认时间');
    if (task.status === 'succeeded' && !task.output) fail('成功任务缺少输出文件');
    if (['planned', 'submitted'].includes(task.status) && task.output != null) fail('未完成任务不能声称已有输出');
    if (task.output != null) {
      const filename = validateLocalImage(directory, task.output);
      const normalized = process.platform === 'win32' ? filename.toLowerCase() : filename;
      if (outputPaths.has(normalized)) fail('独立生成任务不能共用输出路径');
      outputPaths.add(normalized);
    }
    if (task.phase === 'assets') {
      if (task.inputReferenceIds.length) fail('新建资产任务不使用未确认图片');
      continue;
    }
    const shot = plan.shots.find(item => item.id === task.targetId);
    const bound = [...new Set([...shot.shotSchema.referenceIds, ...shot.shotSchema.subjects.flatMap(subject => subject.referenceIds), ...shot.shotSchema.props.flatMap(prop => prop.referenceIds)])];
    if (task.inputReferenceIds.some(id => !bound.includes(id))) fail(`${task.id}生成输入未绑定当前镜头`);
    if (task.status === 'planned') continue;
    if (!sameIds(task.inputReferenceIds, bound)) fail(`${task.id}实际输入与镜头参考不一致`);
    const requiredAssets = [shot.locationId, ...shot.shotSchema.subjects.map(subject => subject.assetId).filter(assetId => characters.find(entry => entry.assetId === assetId)?.base.mode !== 'not-required')];
    for (const assetId of requiredAssets) {
      const assetTask = manifest.tasks.find(item => item.phase === 'assets' && item.targetId === assetId);
      const references = task.inputReferenceIds.map(id => plan.references.find(ref => ref.id === id));
      if (assetTask) {
        if (assetTask.status !== 'succeeded' || assetTask.approval.status !== 'confirmed' || assetTask.approval.by !== 'user') fail(`${task.id}所需资产尚未经用户确认`);
        if (!references.some(ref => ref.origin === 'generated-confirmed' && ref.assetId === assetId && ref.generationTaskId === assetTask.id)) fail(`${task.id}缺少该资产已确认的真实参考`);
      } else {
        const base = characters.find(entry => entry.assetId === assetId)?.base;
        if (base?.mode !== 'reuse' || !base.referenceIds.some(id => task.inputReferenceIds.includes(id))) fail(`${task.id}所需资产尚无可用图片`);
      }
    }
    for (const refId of task.inputReferenceIds) {
      const reference = plan.references.find(item => item.id === refId);
      if (reference.origin === 'generated-confirmed') validateLocalImage(directory, reference);
      else {
        const original = project.references.find(item => item.id === refId);
        validateLocalImage(directory, { path: original?.path, sha256: original?.sha256 });
      }
    }
  }
  return { manifest, assetTasks: expected.filter(task => task.phase === 'assets').length, storyboardTasks: expected.filter(task => task.phase === 'storyboards').length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, directory, turnId] = process.argv.slice(2);
    if (command === 'host-source') { console.log(mediaBatchHostSource()); process.exit(0); }
    if (command === 'audit-execution' && directory) { console.log(JSON.stringify(await auditGenerationTranscript(directory, turnId), null, 2)); process.exit(0); }
    if (command !== 'validate' || !directory) fail('用法：generation.mjs validate <project> | audit-execution <rollout.jsonl> [turnId]');
    const { assetTasks, storyboardTasks } = validateGenerationManifest(directory);
    console.log(JSON.stringify({ status: 'valid', assetTasks, storyboardTasks }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
