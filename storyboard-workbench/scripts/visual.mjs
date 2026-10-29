import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ExcelJS from './vendor/exceljs.cjs';
import { checkShotSchema, ProjectError } from './project.mjs';
import { exportVisualExcel, exportCharacterExcel, exportSceneExcel, exportVisualMarkdown, validateCharacterBundle, validateSceneBundle } from './export_visual_excel.mjs';
import { inspectV2, sourceHashV2, parseFailure, summarize, issue, assetPlanHash } from './visual_v2.mjs';
import { initializeV2, freezeV2, saveInitialV2, changeV2, localFolder } from './visual_state.mjs';
import { validateLocalImage } from './local_image.mjs';
export { validateLocalImage } from './local_image.mjs';

export const dimensions = [
  ['moment', '主体与关键瞬间', 10], ['appearance', '外貌与服装', 10],
  ['pose', '姿态与动作', 10], ['expression', '表情与视线', 10],
  ['relations', '人物与道具关系', 10], ['camera', '景别、机位与景深', 10],
  ['composition', '构图与空间层次', 10], ['scene', '场景、布景与材质', 5],
  ['lighting', '光影与色调', 10], ['continuity', '跨镜画面连续性', 15]
];
export const rubricVersion = 'visual-v1';
export const currentRubricVersion = 'visual-v2';
const opticsDimensions = dimensions.flatMap(([key, label, weight]) => key === 'camera'
  ? [['camera', '景别、机位与取景', 5], ['optics', '摄影约束（焦距、光圈与对焦）', 5]]
  : [[key, label, weight]]);
export function dimensionsFor(version = rubricVersion) {
  if (version === rubricVersion) return dimensions;
  if (version === currentRubricVersion) return opticsDimensions;
  throw new ProjectError('评分规则版本无效', 422);
}
const fail = message => { throw new ProjectError(message, 422); };
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const string = (value, label, empty = false) => {
  if (typeof value !== 'string' || (!empty && !value.trim())) fail(`${label}须为${empty ? '' : '非空'}文本`);
};
const array = (value, label) => { if (!Array.isArray(value)) fail(`${label}须为数组`); };
const unique = (values, label) => { if (new Set(values).size !== values.length) fail(`${label}重复`); };
const id = (value, label) => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) fail(`${label}无效`); };
const ids = (values, allowed, label) => {
  array(values, label); unique(values, label);
  if (values.some(value => !allowed.includes(value))) fail(`${label}引用不存在或顺序错误`);
};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const promptHash = text => crypto.createHash('sha256').update(text).digest('hex');
const hash = value => promptHash(JSON.stringify(canonical(value)));
const fileHash = filename => promptHash(fs.readFileSync(filename));
const planFile = directory => path.join(directory, 'visual-plan.json');
const saveNew = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });

function checkGeneratedReference(directory, plan, reference, suppliedManifest) {
  const manifestFile = path.join(directory, 'generation-manifest.json');
  if (!suppliedManifest && !fs.existsSync(manifestFile)) fail('生成参考缺少本项目生成清单');
  const manifest = suppliedManifest ?? read(manifestFile);
  const task = manifest.tasks?.find(item => item.id === reference.generationTaskId);
  if (manifest.schemaVersion !== 1 || manifest.projectId !== plan.projectId || !task || task.phase !== 'assets' || !['character', 'location'].includes(task.targetType) || task.targetId !== reference.assetId) fail('生成参考与本项目资产映射不一致');
  const assets = plan.productionInventory[task.targetType === 'character' ? 'characters' : 'locations'];
  if (!assets.some(asset => asset.id === reference.assetId)) fail('生成参考类型与资产映射不一致');
  if (reference.userProvided !== false) fail('生成参考不得伪装为用户原始附件');
  if (task.status !== 'succeeded' || task.approval?.status !== 'confirmed' || task.approval.by !== 'user' || !Number.isFinite(Date.parse(task.approval.confirmedAt))) fail('生成参考必须成功且经用户确认');
  if (reference.path !== task.output?.path || reference.sha256 !== task.output?.sha256) fail('生成参考与已确认输出不一致');
  validateLocalImage(directory, reference);
}

function archivedProject(directory) {
  const project = read(path.join(directory, 'project.json'));
  const source = project.source;
  if (!source || typeof source.path !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sha256 ?? '')) fail('原稿归档缺少路径或SHA256');
  const root = fs.realpathSync(directory), filename = path.resolve(root, source.path);
  const relative = path.relative(root, filename);
  if (path.isAbsolute(source.path) || relative.startsWith('..') || path.isAbsolute(relative)) fail('原稿路径必须位于项目目录');
  const real = fs.realpathSync(filename), realRelative = path.relative(root, real);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) fail('原稿路径越出项目目录');
  if (fileHash(real) !== source.sha256.toLowerCase()) fail('原件哈希不一致，不能继续使用旧创作');
  array(project.shots, '原稿镜头');
  unique(project.shots.map(shot => shot.id), '原稿镜头ID');
  return project;
}

export function sourceHash(project, plan, shot) {
  if (plan.schemaVersion === 2) return sourceHashV2(project, plan, shot);
  return hash({
    ...(plan.rubricVersion != null ? { rubricVersion: plan.rubricVersion } : {}),
    source: project.source,
    originals: shot.sourceShotIds.map(id => {
      const source = project.shots.find(item => item.id === id);
      return { id, original: source?.original, originalFields: source?.originalFields, sourceRef: source?.sourceRef, sourceNumber: source?.sourceNumber, originalDuration: source?.originalDuration };
    }),
    spec: plan.spec, productionInventory: plan.productionInventory, props: plan.props,
    references: plan.references, designNotes: plan.designNotes,
    shot: { id: shot.id, sourceShotIds: shot.sourceShotIds, locationId: shot.locationId, seconds: shot.seconds, dimensions: shot.dimensions, shotSchema: shot.shotSchema, transition: shot.transition, motion: shot.motion, reuseOf: shot.reuseOf }
  });
}

export function reviewTotal(review) {
  let points = 0, weight = 0;
  for (const [key, , value] of dimensionsFor(review.rubricVersion)) {
    const score = review.scores.find(item => item.dimension === key)?.score;
    if (score != null) { points += score / 5 * value; weight += value; }
  }
  return weight ? Math.round(points / weight * 1000) / 10 : null;
}

function checkReview(review, text, label, requireReview, version) {
  if (review == null) { if (requireReview) fail(`${label}缺少评审`); return; }
  if (review.promptHash !== promptHash(text)) fail(`${label}评分对应的Prompt已过期`);
  if (review.rubricVersion !== version) fail(`${label}评分规则版本无效`);
  string(review.reviewer, `${label}评审者`);
  array(review.scores, `${label}评分`);
  const keys = dimensionsFor(version).map(([key]) => key);
  ids(review.scores.map(item => item.dimension), keys, `${label}评分维度`);
  if (review.scores.length !== keys.length) fail(`${label}评分需要${keys.length === 10 ? '十个' : '十一个'}维度`);
  for (const entry of review.scores) {
    if (entry.score !== null && (typeof entry.score !== 'number' || !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 5)) fail(`${label}维度分数须为0至5或null`);
    string(entry.reason, `${label}评分理由`);
    string(entry.evidence, `${label}评分证据`, true);
    if ((entry.score > 0 && !entry.evidence.trim()) || (entry.evidence && !text.includes(entry.evidence))) fail(`${label}评分证据必须来自对应Prompt原文`);
  }
  if (review.scores.every(item => item.score === null)) fail(`${label}不能全部不适用`);
  for (const key of ['strengths', 'weaknesses']) { array(review[key], `${label}${key}`); review[key].forEach(value => string(value, `${label}${key}`)); }
  if (typeof review.rewrite?.needed !== 'boolean' || review.rewrite.executed !== false) fail(`${label}重写建议须记录needed，executed必须为false；本流程不自动重写`);
  string(review.rewrite.reason, `${label}重写原因`);
}

function checkDuration(plan) {
  const target = plan.spec?.duration;
  if (!target || !['estimate', 'exact', 'max', 'range'].includes(target.mode)) fail('时长模式无效');
  string(target.basis, '时长依据');
  const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const total = Math.round(plan.shots.reduce((sum, shot) => sum + shot.seconds, 0) * 1000) / 1000;
  if (['exact', 'max'].includes(target.mode) && !positive(target.seconds)) fail('时长目标须为正数');
  if (target.mode === 'range' && (!positive(target.min) || !positive(target.max) || target.max < target.min)) fail('时长区间无效');
  if (target.mode === 'exact' && Math.abs(total - target.seconds) > 0.01) fail(`总时长${total}秒不符合指定${target.seconds}秒；请调整编排后继续`);
  if (target.mode === 'max' && total > target.seconds + 0.01) fail(`总时长${total}秒超过上限${target.seconds}秒；请调整编排后继续`);
  if (target.mode === 'range' && (total < target.min - 0.01 || total > target.max + 0.01)) fail(`总时长${total}秒不在指定区间；请调整编排后继续`);
  return total;
}

export function validateVisualPlan(directory, plan = read(planFile(directory)), { requireReview = true, sealed = true, generationManifest, allowPending = false } = {}) {
  const project = archivedProject(directory);
  if (plan?.schemaVersion === 2) {
    const report = inspectV2(directory, project, plan, { sealed, checkReview, checkGeneratedReference: (dir, value, ref) => checkGeneratedReference(dir, value, ref, generationManifest), validateLocalImage });
    checkAssetBundles(directory, plan, report);
    if (report.issues.some(item => item.severity === 'error' || !allowPending)) {
      const error = new ProjectError(report.issues.map(item => `${item.path}: ${item.message}`).join('\n'), 422);
      error.report = report; throw error;
    }
    return { project, plan, totalSeconds: report.totalSeconds, report };
  }
  if (plan.schemaVersion !== 1 || plan.mode !== 'visual-excel-v1') fail('仅支持visual-excel-v1');
  const version = plan.rubricVersion ?? rubricVersion, rules = dimensionsFor(version);
  string(plan.projectId, 'projectId'); string(plan.title, '标题');
  if (plan.sourceSha256 !== project.source.sha256) fail('计划与归档源文件不匹配');
  for (const key of ['aspectRatio', 'resolution', 'style']) string(plan.spec?.[key], key);
  array(plan.designNotes, '设定依据'); plan.designNotes.forEach(value => string(value, '设定依据'));
  const assets = [];
  for (const kind of ['characters', 'locations']) {
    array(plan.productionInventory?.[kind], kind);
    unique(plan.productionInventory[kind].map(item => item.name), `${kind}名称`);
    for (const item of plan.productionInventory[kind]) {
      id(item.id, '资产ID'); assets.push(item.id);
      for (const key of ['name', 'description', 'basis']) string(item[key], `资产${key}`);
    }
  }
  array(plan.props, '道具');
  for (const prop of plan.props) { id(prop.id, '道具ID'); assets.push(prop.id); string(prop.name, '道具名'); string(prop.description, '道具描述'); }
  unique(assets, '实体ID');
  array(plan.references, '参考'); unique(plan.references.map(ref => ref.id), '参考ID');
  for (const reference of plan.references) {
    id(reference.id, '参考ID');
    string(reference.purpose, '参考用途');
    if (reference.origin === 'generated-confirmed') {
      checkGeneratedReference(directory, plan, reference, generationManifest);
      if (!assets.includes(reference.assetId)) fail('生成参考资产不存在');
      continue;
    }
    if (reference.origin != null && reference.origin !== 'user-provided') fail('参考来源无效');
    const source = project.references?.find(item => item.id === reference.id);
    if (!source || (reference.path && reference.path !== source.path) || (reference.url && reference.url !== source.url)) fail('参考须来自本次归档，不可虚构或换绑');
    if (reference.userProvided !== true) fail('参考须明确标为本次用户提供');
    if (reference.sha256 && reference.sha256 !== source.sha256) fail('参考哈希与归档不一致');
  }
  array(plan.shots, '分镜'); if (!plan.shots.length) fail('至少需要一镜');
  unique(plan.shots.map(shot => shot.id), '分镜ID');
  const covered = new Set(), earlier = [];
  for (const shot of plan.shots) {
    id(shot.id, '分镜ID');
    ids(shot.sourceShotIds, project.shots.map(item => item.id), `${shot.id}原稿镜号`);
    if (!shot.sourceShotIds.length) fail(`${shot.id}缺少原稿来源`);
    shot.sourceShotIds.forEach(value => covered.add(value));
    if (!plan.productionInventory.locations.some(item => item.id === shot.locationId)) fail(`${shot.id}场景未登记`);
    if (typeof shot.seconds !== 'number' || !Number.isFinite(shot.seconds) || shot.seconds <= 0) fail(`${shot.id}秒数须为正数`);
    for (const [key] of rules) string(shot.dimensions?.[key], `${shot.id}维度${key}`);
    checkShotSchema(shot.shotSchema, plan);
    for (const subject of shot.shotSchema.subjects) for (const refId of subject.referenceIds) {
      const reference = plan.references.find(item => item.id === refId);
      if (reference.assetId != null && reference.assetId !== subject.assetId) fail(`${shot.id}人物参考资产映射不一致`);
    }
    for (const refId of shot.shotSchema.referenceIds) {
      const reference = plan.references.find(item => item.id === refId);
      if (reference.assetId != null && reference.assetId !== shot.locationId && !shot.shotSchema.subjects.some(subject => subject.assetId === reference.assetId && subject.referenceIds.includes(refId))) fail(`${shot.id}场景参考资产映射不一致`);
    }
    for (const prop of shot.shotSchema.props) for (const refId of prop.referenceIds) {
      const reference = plan.references.find(item => item.id === refId);
      if (reference.assetId != null && reference.assetId !== prop.id) fail(`${shot.id}道具参考资产映射不一致`);
    }
    for (const prop of shot.shotSchema.props) if (!plan.props.some(item => item.id === prop.id && item.name === prop.name)) fail(`${shot.id}道具须登记且名称一致`);
    ids(shot.transition?.fromShotIds, earlier, `${shot.id}前镜依赖`);
    for (const key of ['entry', 'exit', 'cut']) string(shot.transition[key], `${shot.id}衔接${key}`);
    string(shot.motion, `${shot.id}动作编排`);
    string(shot.prompt?.text, `${shot.id}Prompt`);
    if (shot.reuseOf !== null) {
      if (!earlier.includes(shot.reuseOf)) fail(`${shot.id}仅可复用更早镜头`);
      const reused = plan.shots.find(item => item.id === shot.reuseOf);
      if (shot.prompt.text !== reused.prompt.text) fail(`${shot.id}复用帧必须保持原Prompt，后期排版写入motion`);
    }
    if (sealed && (shot.prompt.sourceHash !== sourceHash(project, plan, shot) || shot.prompt.textHash !== promptHash(shot.prompt.text))) fail(`${shot.id}正文或来源已变化，冻结失效；请显式制作新版本`);
    checkReview(shot.review, shot.prompt.text, shot.id, requireReview, version);
    earlier.push(shot.id);
  }
  if (project.shots.some(shot => !covered.has(shot.id))) fail('存在未覆盖的原稿镜头');
  array(plan.calibration, '校准样本'); unique(plan.calibration.map(item => item.id), '校准样本ID');
  for (const sample of plan.calibration) {
    id(sample.id, '校准样本ID'); string(sample.label, '样本标签'); string(sample.text, '样本Prompt');
    const shot = plan.shots.find(item => item.id === sample.shotId);
    if (!shot) fail('校准样本引用不存在的镜头');
    if (sealed && (sample.sourceHash !== sourceHash(project, plan, shot) || sample.textHash !== promptHash(sample.text))) fail(`${sample.id}校准样本或来源已变化`);
    checkReview(sample.review, sample.text, sample.id, requireReview, version);
  }
  return { project, plan, totalSeconds: checkDuration(plan) };
}

export function sealPlan(directory, inputPlan) {
  if (fs.existsSync(planFile(directory))) fail('visual-plan.json已存在；不覆盖已冻结版本，请新建版本目录');
  if (inputPlan?.schemaVersion === 2) {
    const project = archivedProject(directory), plan = initializeV2(project, inputPlan);
    const report = inspectV2(directory, project, plan, { sealed: false, checkReview, checkGeneratedReference, validateLocalImage });
    if (report.issues.some(item => item.severity === 'error')) { const error = new ProjectError('新方案结构未通过，输入文件保持原样', 422); error.report = report; throw error; }
    const explicit = new Set(plan.shots.flatMap(shot => ['review', 'semanticReview'].filter(key => shot[key]).map(key => `${shot.id}:${key}`)));
    freezeV2(project, plan, explicit);
    for (const sample of plan.calibration) { sample.text = sample.text.replace(/\r\n?/g, '\n'); sample.sourceHash = sourceHashV2(project, plan, plan.shots.find(shot => shot.id === sample.shotId)); sample.textHash = promptHash(sample.text); }
    plan.sealedAt = new Date().toISOString();
    return saveInitialV2(directory, plan, inputPlan);
  }
  const project = archivedProject(directory), plan = structuredClone(inputPlan);
  plan.projectId ??= crypto.randomUUID(); plan.sourceSha256 ??= project.source.sha256;
  for (const shot of plan.shots ?? []) if (typeof shot.prompt?.text === 'string') shot.prompt.text = shot.prompt.text.replace(/\r\n?/g, '\n');
  for (const sample of plan.calibration ?? []) if (typeof sample.text === 'string') sample.text = sample.text.replace(/\r\n?/g, '\n');
  validateVisualPlan(directory, plan, { requireReview: false, sealed: false });
  for (const shot of plan.shots) { shot.prompt.sourceHash = sourceHash(project, plan, shot); shot.prompt.textHash = promptHash(shot.prompt.text); }
  for (const sample of plan.calibration) { sample.sourceHash = sourceHash(project, plan, plan.shots.find(shot => shot.id === sample.shotId)); sample.textHash = promptHash(sample.text); }
  plan.sealedAt = new Date().toISOString();
  saveNew(planFile(directory), plan);
  return plan;
}

export async function exportVisualProject(directory, { videoWorkflow = null, calibration = false, bindWorkbook = null } = {}) {
  let checked;
  if (videoWorkflow) {
    const { validateVideoWorkflow } = await import('./video.mjs');
    checked = validateVideoWorkflow(directory, videoWorkflow, { forExport: true });
  } else {
    const manifestFile = path.join(directory, 'generation-manifest.json');
    if (fs.existsSync(manifestFile)) {
      const { validateGenerationProject } = await import('./generation.mjs');
      checked = validateGenerationProject(directory);
    } else {
      const current = read(planFile(directory));
      checked = validateVisualPlan(directory, current, { allowPending: current.schemaVersion === 2 });
    }
  }
  const { plan, project, totalSeconds, report: validationReport } = checked, v2 = plan.schemaVersion === 2;
  const report = validationReport ?? { ...summarize([], plan), totalSeconds };
  const manifest = checked.generation?.manifest ?? null;
  const displayPlan = structuredClone(plan);
  if (v2) for (const sample of displayPlan.calibration) if (sample.sourceHash !== sourceHashV2(project, plan, plan.shots.find(shot => shot.id === sample.shotId))) sample.review = null;
  if (videoWorkflow) {
    for (const replacement of videoWorkflow.shotPrompts ?? []) {
      const shot = displayPlan.shots.find(shot => shot.id === replacement.shotId);
      shot.prompt = { ...shot.prompt, text: replacement.text, textHash: promptHash(replacement.text) };
    }
  }
  const context = { directory, workflow: videoWorkflow, manifest, calibration };
  const characterFile = path.join(directory, 'character-prompts.json');
  if (fs.existsSync(characterFile) && (!v2 || !report.issues.some(row => row.path === '$.character-prompts.json'))) context.characterBundle = read(characterFile);
  const sceneFile = path.join(directory, 'scene-prompts.json');
  if (fs.existsSync(sceneFile) && (!v2 || !report.issues.some(row => row.path === '$.scene-prompts.json'))) context.sceneBundle = read(sceneFile);
  if (checked.sceneBundle) context.sceneBundle = checked.sceneBundle;
  const files = await exportVisualExcel(displayPlan, project, videoWorkflow ? videoWorkflow.timeline.reduce((sum, row) => sum + row.seconds, 0) : totalSeconds, manifest, report, context);
  files.push({ filename: '制作日志.md', buffer: Buffer.from(exportVisualMarkdown(displayPlan, project, report, context), 'utf8') });
  let relativeOutput;
  if (videoWorkflow) relativeOutput = `exports/video-revision-${String(videoWorkflow.revision).padStart(6, '0')}${calibration ? '-calibration' : ''}`;
  else if (v2) relativeOutput = `exports/revision-${String(plan.revision).padStart(6, '0')}${calibration ? '-calibration' : ''}`;
  else {
    let next = 1;
    while (fs.existsSync(path.join(directory, `exports/delivery-${String(next).padStart(6, '0')}`))) next++;
    relativeOutput = `exports/delivery-${String(next).padStart(6, '0')}`;
  }
  if (!calibration) {
    const { deliverExcel } = await import('./excel_delivery.mjs');
    return deliverExcel(directory, { file: files[0], log: files.at(-1), planHash: hash(plan),
      workflowHash: videoWorkflow ? promptHash(JSON.stringify(videoWorkflow)) : null, bindWorkbook, outputDirectory: path.resolve(directory, relativeOutput) });
  }
  if (bindWorkbook) fail('人工校准表不使用正式Excel绑定');
  const output = localFolder(directory, relativeOutput); fs.mkdirSync(output, { recursive: true });
  if (files.some(file => fs.existsSync(path.join(output, file.filename)))) fail('本版本导出已存在，拒绝覆盖；保留人工内容，修订后导出新版本');
  const ratings = path.join(output, '人工校准.xlsx');
  if (fs.existsSync(ratings)) {
    const existing = new ExcelJS.Workbook(); await existing.xlsx.load(fs.readFileSync(ratings));
    const sheet = existing.getWorksheet('人工评分');
    if (!sheet) fail('已有校准表结构已变化，请保留用户文件并另存新的空白表');
    const scoreColumn = sheet.getRow(1).values.indexOf('用户总分（0–100）'), reasonColumn = sheet.getRow(1).values.indexOf('用户原因');
    if (scoreColumn < 1 || reasonColumn < 1) fail('已有校准表表头已变化，请保留用户文件');
    for (let row = 2; row <= sheet.rowCount; row++) {
      if ([scoreColumn, reasonColumn].some(column => ![null, undefined, ''].includes(sheet.getRow(row).getCell(column).value))) fail('已有校准表包含用户填写内容，拒绝覆盖；请先另存或导入评分');
    }
  }
  for (const file of files) fs.writeFileSync(path.join(output, file.filename), file.buffer, { flag: 'wx' });
  return files.map(file => path.join(output, file.filename));
}

function checkAssetBundles(directory, plan, report) {
  for (const [filename, validate] of [['character-prompts.json', validateCharacterBundle], ['scene-prompts.json', validateSceneBundle]]) {
    const target = path.join(directory, filename);
    if (filename === 'character-prompts.json' && Array.isArray(plan.productionInventory?.characters) && !plan.productionInventory.characters.length && !fs.existsSync(target)) continue;
    if (!fs.existsSync(target)) {
      report.issues.push(issue('source', 'ASSET_PROMPTS_MISSING', `$.${filename}`, '尚未提供人物/场景资产 Prompt 文件', '完成本片资产正文；不适用人物用 not-required 并注明原因。', null, 'pending'));
    } else try {
      const bundle = read(target); validate(bundle, plan);
      for (const row of bundle.characters ?? []) if (row.base.mode === 'blocked') report.issues.push(issue('source', 'ASSET_PROMPT_BLOCKED', `$.${filename}.characters.${row.assetId}`, row.base.basis, '补齐具体缺口后再完成该人物资产；其他可交付内容继续导出。', null, 'pending'));
    }
    catch (error) { report.issues.push(issue(error instanceof SyntaxError ? 'parse' : 'source', 'ASSET_PROMPTS_INVALID', `$.${filename}`, error.message, '保留原文件，核对资产依赖版本后修订该文件。', null, 'pending')); }
  }
  Object.assign(report, summarize(report.issues, plan));
  report.assetHashes = { characters: assetPlanHash(plan, 'characters'), locations: assetPlanHash(plan, 'locations') };
}

export function reportVisualProject(directory, inputPlan) {
  try {
    const plan = inputPlan ?? read(planFile(directory));
    const checked = validateVisualPlan(directory, plan, { allowPending: true });
    return checked.report ?? { ...summarize([], plan), totalSeconds: checked.totalSeconds };
  } catch (error) { return error.report ?? parseFailure(error); }
}

export function reviseVisualPlan(directory, request, action = 'revise') {
  const project = archivedProject(directory);
  const changed = changeV2(directory, request, { project, action, inspect: (plan, options = {}) => inspectV2(directory, project, plan, { ...options, checkReview, checkGeneratedReference, validateLocalImage }) });
  changed.report = reportVisualProject(directory);
  return changed;
}

export const calibrationBackground = (plan, project, sample) => {
  const shot = plan.shots.find(item => item.id === sample.shotId);
  return shot.sourceShotIds.map(id => `${id}：${project.shots.find(item => item.id === id).original}`).join('\n') + '\n本镜画面依据：\n' + dimensionsFor(plan.rubricVersion ?? rubricVersion).map(([key, label]) => `${label}：${shot.dimensions[key]}`).join('\n');
};

export async function importFeedback(directory, filename) {
  const currentPlan = read(planFile(directory));
  const { plan, project, report } = validateVisualPlan(directory, currentPlan, { allowPending: currentPlan.schemaVersion === 2 });
  if (report?.issues.some(row => row.code === 'CALIBRATION_STALE')) fail('校准样本已过期；保留旧评分文件，使用对应历史版本核对，不绑定到当前稿');
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(fs.readFileSync(filename));
  workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => { if (cell.value && typeof cell.value === 'object' && ('formula' in cell.value || 'sharedFormula' in cell.value)) fail('评分文件不得使用公式'); })));
  const sheet = workbook.getWorksheet('人工评分');
  if (!sheet || sheet.rowCount !== plan.calibration.length + 1) fail('评分表样本数量不匹配');
  const header = ['样本ID', '关联镜号', '样本', '完整Prompt', '画面背景', '用户总分（0–100）', '用户原因', 'Prompt哈希', '来源哈希', '项目ID'];
  const columns = header.map(() => []);
  let current = -1;
  sheet.getRow(1).eachCell((cell, column) => {
    if (cell.value === header[current + 1]) { current++; columns[current].push(column); }
    else if (current >= 0 && cell.value === `${header[current]}（续${columns[current].length + 1}）`) columns[current].push(column);
    else fail('评分表表头被改动');
  });
  if (columns.some(group => !group.length)) fail('评分表缺少必需表头');
  const values = row => columns.map(group => {
    const parts = group.map(column => row.getCell(column).value ?? null);
    if (parts.some(value => value !== null && typeof value === 'object')) fail('评分表不得使用公式、富文本或链接对象');
    if (parts.length === 1) return parts[0];
    if (parts.some(value => value !== null && typeof value !== 'string')) fail('续列须为文本');
    return parts.map(value => value ?? '').join('');
  });
  const ratings = [], seen = new Set();
  for (let index = 2; index <= sheet.rowCount; index++) {
    const row = values(sheet.getRow(index));
    if (row.some(value => value !== null && typeof value === 'object')) fail('评分表不得使用公式、富文本或链接对象');
    const sample = plan.calibration.find(item => item.id === row[0]);
    if (!sample || seen.has(sample.id)) fail('评分表包含未知或重复样本ID');
    seen.add(sample.id);
    const expected = [sample.id, sample.shotId, sample.label, sample.text, calibrationBackground(plan, project, sample), null, null, sample.textHash, sample.sourceHash, plan.projectId];
    if (expected.some((value, column) => ![5, 6].includes(column) && row[column] !== (typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : value))) fail(`${sample.id}冻结的Prompt或背景被改动`);
    const score = row[5], reason = row[6];
    if (score === null || score === '') { if (reason !== null && reason !== '') fail(`${sample.id}填写原因后请填写分数，0分可以正常录入`); continue; }
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) fail(`${sample.id}用户分数须为0至100数字`);
    if (reason !== null && typeof reason !== 'string') fail(`${sample.id}用户原因须为文本`);
    ratings.push({ sampleId: sample.id, shotId: sample.shotId, promptHash: sample.textHash, sourceHash: sample.sourceHash, score, reason: reason ?? '' });
  }
  if (!ratings.length) fail('未填写任何人工分数，未保存反馈');
  const record = { schemaVersion: 1, projectId: plan.projectId, rubricVersion: plan.rubricVersion ?? rubricVersion, planHash: hash(plan), importedAt: new Date().toISOString(), workbookSha256: fileHash(filename), ratings, status: 'user-feedback-uninterpreted', changesRules: false };
  const output = path.join(directory, 'feedback'); fs.mkdirSync(output, { recursive: true });
  const target = path.join(output, `${record.workbookSha256}.json`);
  if (fs.existsSync(target)) fail('这份评分文件已导入，未重复写入');
  saveNew(target, record); return target;
}

async function main() {
  try {
    const [command, directory, input] = process.argv.slice(2);
    if (!directory) fail('用法：visual.mjs seal <project> <plan.json> | report/validate/export/export-calibration <project> | bind-excel <project> <existing.xlsx> | revise/add-candidate/select/restore <project> <request.json> | export-characters <project> | feedback <project> <ratings.xlsx>');
    let result;
    if (command === 'seal' && input) { const plan = sealPlan(directory, read(input)); result = { projectId: plan.projectId, status: 'sealed', ...(plan.schemaVersion === 2 ? { revision: plan.revision, validation: reportVisualProject(directory) } : {}) }; }
    else if (command === 'report') { result = reportVisualProject(directory); if (!result.valid) process.exitCode = 1; }
    else if (command === 'validate') {
      const current = read(planFile(directory));
      if (current.schemaVersion === 2) { result = reportVisualProject(directory, current); if (!result.valid) process.exitCode = 1; }
      else { const checked = validateVisualPlan(directory, current); result = { status: 'valid', shots: checked.plan.shots.length, calibration: checked.plan.calibration.length, totalSeconds: checked.totalSeconds }; }
    }
    else if (['revise', 'add-candidate', 'select', 'restore'].includes(command) && input) {
      const changed = reviseVisualPlan(directory, read(input), command);
      result = { stateSaved: true, accepted: changed.accepted, revision: changed.plan.revision, affectedShotIds: changed.affectedShotIds, validation: changed.report, attemptReport: changed.attemptReport };
      try { result.files = await exportVisualProject(directory); result.exportsUpdated = true; }
      catch (error) { result.exportsUpdated = false; result.exportFailure = error.report ?? parseFailure(error); process.exitCode = 1; }
      if (!changed.accepted) process.exitCode = 1;
    }
    else if (command === 'export') result = { files: await exportVisualProject(directory) };
    else if (command === 'bind-excel' && input) result = { files: await exportVisualProject(directory, { bindWorkbook: input }) };
    else if (command === 'export-calibration') result = { files: await exportVisualProject(directory, { calibration: true }) };
    else if (command === 'export-characters') {
      const { plan } = validateVisualPlan(directory);
      const file = await exportCharacterExcel(read(path.join(directory, 'character-prompts.json')), plan);
      const output = path.join(directory, 'exports'); fs.mkdirSync(output, { recursive: true });
      const target = path.join(output, file.filename);
      fs.writeFileSync(target, file.buffer, { flag: 'wx' });
      result = { files: [target] };
    }
    else if (command === 'feedback' && input) result = { file: await importFeedback(directory, input) };
    else fail('未知命令或缺少输入文件');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(JSON.stringify(error.report ?? parseFailure(error), null, 2)); process.exitCode = 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
