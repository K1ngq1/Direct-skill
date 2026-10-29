import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import ExcelJS from './vendor/exceljs.cjs';
import { ProjectError } from './project.mjs';
import { promptHash, validateVisualPlan, validateLocalImage } from './visual.mjs';
import { localFolder } from './visual_state.mjs';
import { validateSceneBundle } from './export_visual_excel.mjs';
import { validateGenerationProject } from './generation.mjs';

const fail = message => { throw new ProjectError(message, 422); };
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const hash = value => promptHash(JSON.stringify(value));
const text = (value, label, empty = false) => { if (typeof value !== 'string' || (!empty && !value.trim())) fail(`${label}须为${empty ? '' : '非空'}文本`); };
const list = (value, label) => { if (!Array.isArray(value)) fail(`${label}须为数组`); };
const identifier = (value, label) => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) fail(`${label}无效`); };
const unique = (values, label) => { if (new Set(values).size !== values.length) fail(`${label}重复`); };
const positive = (value, label) => { if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(`${label}须为正数`); };
const revisionName = revision => `revision-${String(revision).padStart(6, '0')}.json`;
const sameIds = (left, right) => left.length === right.length && left.every(id => right.includes(id));

function frozen(directory, forExport) {
  const manifestFile = path.join(directory, 'generation-manifest.json');
  if (forExport && fs.existsSync(manifestFile)) return validateGenerationProject(directory);
  const plan = read(path.join(directory, 'visual-plan.json'));
  return validateVisualPlan(directory, plan, { requireReview: forExport, allowPending: !forExport || plan.schemaVersion === 2 });
}

function insideFile(directory, filename) {
  const root = fs.realpathSync(directory), target = path.resolve(root, filename);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('文件路径必须位于项目目录');
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) fail('文件不存在');
  const real = fs.realpathSync(target), realRelative = path.relative(root, real);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) fail('文件链接越出项目目录');
  return target;
}

function imageForShot(plan, image, shot) {
  let source = shot;
  while (source.reuseOf) source = plan.shots.find(item => item.id === source.reuseOf);
  return image.shotId === shot.id || image.shotId === source.id;
}

export function validateVideoWorkflow(directory, workflow, { forExport = false } = {}) {
  const { plan, project, report, generation } = frozen(directory, forExport);
  if (workflow?.schemaVersion !== 1 || workflow.projectId !== plan.projectId || workflow.sourcePlanHash !== hash(plan)) fail('视频规划与冻结项目版本不匹配或已过期');
  if (!Number.isSafeInteger(workflow.revision) || workflow.revision < 1) fail('视频规划版本须为正整数');
  if (workflow.title !== undefined) text(workflow.title, '视频规划标题');
  for (const [key, label] of [['generationSettings', '全片视频参数'], ['musicPrompt', '全片音乐Prompt']]) if (workflow[key] !== undefined) text(workflow[key], label);
  for (const key of ['images', 'videoShots', 'timeline', 'pilotVideoShotIds', 'results']) list(workflow[key], key);
  const shotIds = plan.shots.map(shot => shot.id);
  if (workflow.shotPrompts !== undefined) {
    list(workflow.shotPrompts, '修订静帧Prompt'); unique(workflow.shotPrompts.map(item => item.shotId), '修订静帧镜号');
    for (const item of workflow.shotPrompts) {
      const shot = plan.shots.find(shot => shot.id === item.shotId);
      if (!shot) fail('修订静帧Prompt包含未知镜号');
      text(item.text, `${item.shotId}修订静帧Prompt`); text(item.basis, `${item.shotId}静帧修订依据`);
      list(item.references, `${item.shotId}静帧参考`); unique(item.references.map(reference => reference.assetId), '静帧参考资产');
      for (const reference of item.references) {
        if (![shot.locationId, ...shot.shotSchema.subjects.map(subject => subject.assetId)].includes(reference.assetId)) fail('修订静帧参考与本镜资产不匹配');
        validateLocalImage(directory, reference);
      }
    }
  }
  const sceneBundle = workflow.sceneBundleRef !== undefined ? validateSceneBundle(read(validateLocalImage(directory, workflow.sceneBundleRef)), plan) : null;
  const manifestFile = path.join(directory, 'generation-manifest.json');
  let generationItems = null;
  if (workflow.generationSource !== undefined) {
    const filename = validateLocalImage(directory, workflow.generationSource), source = read(filename);
    list(source.items, '图片生成来源条目'); unique(source.items.map(item => item.id), '图片生成来源镜号');
    generationItems = source.items;
  }
  const manifest = generationItems === null && fs.existsSync(manifestFile) ? read(manifestFile) : null;
  unique(workflow.images.map(image => image.id), '图片ID');
  for (const image of workflow.images) {
    identifier(image.id, '图片ID');
    const shot = plan.shots.find(item => item.id === image.shotId);
    if (!shot || image.locationId !== shot.locationId) fail(`${image.id}图片与分镜或场景关系不匹配`);
    list(image.characterIds, `${image.id}人物`); unique(image.characterIds, `${image.id}人物`);
    if (!sameIds(image.characterIds, shot.shotSchema.subjects.map(subject => subject.assetId))) fail(`${image.id}图片人物映射不匹配`);
    validateLocalImage(directory, image);
    if (generationItems !== null) {
      const item = generationItems.find(value => value.id === image.shotId);
      if (!item || item.status !== 'succeeded' || item.output?.path !== image.path || item.output?.sha256?.toLowerCase() !== image.sha256.toLowerCase()) fail(`${image.id}图片与明确生成来源不匹配，失败或未完成记录不能作参考`);
    }
    if (manifest) {
      const task = manifest.tasks?.find(item => item.targetType === 'shot' && item.targetId === image.shotId);
      if (task && (task.status !== 'succeeded' || task.output?.path !== image.path || task.output?.sha256?.toLowerCase() !== image.sha256.toLowerCase())) fail(`${image.id}图片不能冒充失败、未完成或不匹配的生成输出`);
    }
    if (!['usable', 'needs-change', 'pending'].includes(image.review?.status)) fail(`${image.id}图片检查状态无效`);
    text(image.review.reason, `${image.id}检查原因`); text(image.review.reviewer, `${image.id}检查者`);
    if (image.productionNote !== undefined) text(image.productionNote, `${image.id}制作备注`);
    if (!['agent', 'user'].includes(image.selection?.by)) fail(`${image.id}选择来源无效`);
    text(image.selection.reason, `${image.id}选择原因`);
    if (!['pending', 'confirmed'].includes(image.approval?.status) || (image.approval.status === 'confirmed' ? image.approval.by !== 'user' : image.approval.by !== null)) fail(`${image.id}用户确认必须与图片检查和选择分开记录`);
  }
  if (workflow.assetImages !== undefined) {
    list(workflow.assetImages, '资产图片');
    unique(workflow.assetImages.map(image => image.assetId), '资产图片ID');
    const assetIds = [...plan.productionInventory.characters, ...plan.productionInventory.locations].map(asset => asset.id);
    for (const image of workflow.assetImages) {
      if (!assetIds.includes(image.assetId)) fail('资产图片引用不存在');
      validateLocalImage(directory, image);
      if (image.description !== undefined) text(image.description, `${image.assetId}资产描述`);
      if (image.caption !== undefined) text(image.caption, `${image.assetId}图片说明`);
    }
  }
  unique(workflow.videoShots.map(shot => shot.id), '视频镜头ID');
  if (!isDeepStrictEqual(workflow.videoShots.flatMap(shot => shot.shotIds), shotIds)) fail('视频镜头须按顺序覆盖全部原分镜一次');
  if (!isDeepStrictEqual(workflow.timeline.map(row => row.shotId), shotIds)) fail('时间线须与原分镜顺序一致且逐镜覆盖');
  for (const row of workflow.timeline) {
    positive(row.seconds, `${row.shotId}时间线秒数`); text(row.reason, `${row.shotId}时长依据`);
    if (row.description !== undefined) text(row.description, `${row.shotId}画面描述`);
  }
  for (const shot of workflow.videoShots) {
    identifier(shot.id, '视频镜头ID'); list(shot.shotIds, `${shot.id}分镜关系`);
    if (!shot.shotIds.length) fail('视频镜头至少关联一条分镜');
    for (const key of ['startState', 'action', 'camera', 'endState']) text(shot[key], `${shot.id}.${key}`);
    for (const key of ['dialogue', 'sound']) text(shot[key], `${shot.id}.${key}`, true);
    list(shot.invariants, `${shot.id}保持不变的内容`); shot.invariants.forEach(value => text(value, `${shot.id}保持不变的内容`));
    positive(shot.durationSeconds, `${shot.id}视频秒数`);
    const seconds = workflow.timeline.filter(row => shot.shotIds.includes(row.shotId)).reduce((sum, row) => sum + row.seconds, 0);
    if (Math.abs(shot.durationSeconds - seconds) > 0.000001) fail(`${shot.id}视频秒数与时间线不一致`);
    if (shot.videoPrompt !== undefined) text(shot.videoPrompt, `${shot.id}视频Prompt`);
    if (shot.generationParameters !== undefined) text(shot.generationParameters, `${shot.id}视频参数`);
    const original = shot.shotIds.length === 1 ? plan.shots.find(item => item.id === shot.shotIds[0]) : null;
    if (original?.videoPrompt !== undefined && shot.videoPrompt !== undefined && shot.videoPrompt !== original.videoPrompt) fail(`${shot.id}须复用已有视频Prompt，不能另存不同正文`);
    for (const [key, index] of [['startImageId', 0], ['endImageId', shot.shotIds.length - 1]]) {
      if (shot[key] === null) continue;
      const image = workflow.images.find(item => item.id === shot[key]);
      const source = plan.shots.find(item => item.id === shot.shotIds[index]);
      if (!image || !imageForShot(plan, image, source)) fail(`${shot.id}首尾图片与对应分镜不匹配`);
    }
  }
  unique(workflow.pilotVideoShotIds, '试用视频镜头');
  if (workflow.pilotVideoShotIds.some(id => !workflow.videoShots.some(shot => shot.id === id))) fail('试用视频镜头不存在');
  for (const result of workflow.results) {
    if (!workflow.videoShots.some(shot => shot.id === result.videoShotId) || !['succeeded', 'failed', 'unknown'].includes(result.status)) fail('视频结果关联或状态无效');
    if (result.status === 'succeeded' && !result.output) fail('视频成功结果须有实际输出');
    if (result.output) validateLocalImage(directory, result.output);
    if (!Number.isSafeInteger(result.attempts) || result.attempts < 1) fail('实际视频结果须记录真实尝试次数');
    text(result.manualEdits, '人工修改记录', true);
    if (result.cause !== undefined && !['prompt', 'reference', 'model', 'editing', 'unknown'].includes(result.cause)) fail('视频问题原因无效');
    if (result.cause !== undefined) text(result.evidence, '视频问题归因依据');
  }
  const pendingImageIds = workflow.images.filter(image => image.review.status !== 'usable' || image.approval.status !== 'confirmed').map(image => image.id);
  return { workflow, project, plan, report, sceneBundle, generation, totalSeconds: workflow.timeline.reduce((sum, row) => sum + row.seconds, 0), pendingImageIds };
}

export function sealVideoWorkflow(directory, input) {
  const workflow = structuredClone(input);
  validateVideoWorkflow(directory, workflow);
  const output = localFolder(directory, 'video-workflow'), file = path.join(output, revisionName(workflow.revision));
  if (fs.existsSync(file)) fail('本视频规划版本已存在，拒绝覆盖');
  fs.writeFileSync(file, JSON.stringify(workflow, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return { workflow, file };
}

export function readVideoWorkflow(directory, filename) {
  const workflow = read(insideFile(directory, filename));
  validateVideoWorkflow(directory, workflow);
  return workflow;
}

const summary = workflow => ({ revision: workflow.revision, counts: { images: workflow.images.length, videoShots: workflow.videoShots.length, timeline: workflow.timeline.length, results: workflow.results.length }, totalSeconds: workflow.timeline.reduce((sum, row) => sum + row.seconds, 0), pendingImageIds: workflow.images.filter(image => image.review.status !== 'usable' || image.approval.status !== 'confirmed').map(image => image.id) });

export async function finalizeVideoWorkflow(directory, input) {
  const sealed = sealVideoWorkflow(directory, input);
  const result = { status: 'sealed', stateSaved: true, exportsUpdated: false, file: sealed.file, ...summary(sealed.workflow) };
  try {
    const { exportVisualProject } = await import('./visual.mjs');
    result.files = await exportVisualProject(directory, { videoWorkflow: sealed.workflow });
    result.status = 'delivered'; result.exportsUpdated = true;
  } catch (error) {
    result.exportFailure = { message: error.message, ...(error.conflicts ? { conflicts: error.conflicts } : {}) };
  }
  return result;
}

async function excelComments(directory, workflow, filename, checked) {
  const { deliveryBaseline } = await import('./excel_delivery.mjs');
  const delivery = await deliveryBaseline(directory, hash(workflow), true);
  let baseline = delivery?.buffer;
  if (!baseline) {
    const { exportVisualExcel } = await import('./export_visual_excel.mjs');
    const bundle = name => fs.existsSync(path.join(directory, name)) ? read(path.join(directory, name)) : null;
    const files = await exportVisualExcel(checked.plan, checked.project, checked.totalSeconds, bundle('generation-manifest.json'), checked.report, {
      directory, workflow, characterBundle: bundle('character-prompts.json'), sceneBundle: checked.sceneBundle ?? bundle('scene-prompts.json')
    });
    baseline = files.find(file => file.filename.endsWith('.xlsx')).buffer;
  }
  const expected = new ExcelJS.Workbook(), actual = new ExcelJS.Workbook();
  await expected.xlsx.load(baseline);
  await actual.xlsx.load(fs.readFileSync(filename));
  if (!isDeepStrictEqual(actual.worksheets.map(sheet => sheet.name), expected.worksheets.map(sheet => sheet.name))) fail('反馈文件工作表被改动');
  const main = expected.getWorksheet('分镜脚本');
  const noteColumn = main?.getRow(1).values.indexOf('用户意见');
  if (noteColumn !== 10) fail('当前Excel导出缺少指定的用户意见填写列');
  const comments = [];
  for (let index = 0; index < expected.worksheets.length; index++) {
    const base = expected.worksheets[index], sheet = actual.worksheets[index];
    if (sheet.rowCount !== base.rowCount || sheet.columnCount !== base.columnCount) fail('反馈文件表格结构被改动');
    const anchors = value => value.getImages().map(item => ({ imageId: item.imageId, type: item.type, range: item.range ? { tl: item.range.tl?.model, br: item.range.br?.model, ext: item.range.ext, editAs: item.range.editAs, hyperlinks: item.range.hyperlinks } : null }));
    if (!isDeepStrictEqual(anchors(sheet), anchors(base))) fail('反馈文件图片绑定被改动');
    for (let row = 1; row <= sheet.rowCount; row++) for (let column = 1; column <= sheet.columnCount; column++) {
      const value = sheet.getCell(row, column).value;
      if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) fail('反馈文件不得使用公式');
      if (index === 0 && row > 1 && column === noteColumn) {
        if (value === null || value === '') continue;
        if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) fail('用户意见须为文字或有限数字');
        const shotId = base.getCell(row, 1).text;
        if (delivery?.record.inheritedOpinions?.some(entry => entry.shotId === shotId && entry.note === value)) continue;
        comments.push({ shotId, note: value });
      } else if (!isDeepStrictEqual(value, base.getCell(row, column).value)) fail('反馈文件中非填写区内容被改动');
    }
  }
  const media = workbook => (workbook.model.media ?? []).map(item => ({ extension: item.extension, sha256: promptHash(item.buffer) }));
  if (!isDeepStrictEqual(media(actual), media(expected))) fail('反馈文件图片内容被改动');
  return comments;
}

export async function importVideoFeedback(directory, workflow, filename) {
  const checked = validateVideoWorkflow(directory, workflow);
  const saved = read(insideFile(directory, path.join('video-workflow', revisionName(workflow.revision))));
  if (hash(saved) !== hash(workflow)) fail('反馈须绑定已保存的相同视频规划版本');
  const sourceBytes = fs.readFileSync(filename), sourceSha256 = promptHash(sourceBytes);
  let comments;
  if (path.extname(filename).toLowerCase() === '.xlsx') comments = await excelComments(directory, workflow, filename, checked);
  else {
    const input = JSON.parse(sourceBytes.toString('utf8'));
    if (input.schemaVersion !== 1 || input.projectId !== workflow.projectId || input.revision !== workflow.revision || input.workflowHash !== hash(workflow)) fail('反馈与视频规划版本不匹配');
    comments = input.comments;
  }
  list(comments, '反馈意见'); unique(comments.map(comment => comment.shotId), '反馈镜号');
  const entries = comments.filter(comment => comment.note !== null && comment.note !== undefined && comment.note !== '').map(comment => {
    const shot = checked.plan.shots.find(item => item.id === comment.shotId);
    if (!shot) fail('反馈包含未知镜号');
    if (typeof comment.note !== 'string' && (typeof comment.note !== 'number' || !Number.isFinite(comment.note))) fail('反馈意见须为文字或有限数字');
    const videoShot = workflow.videoShots.find(item => item.shotIds.includes(shot.id));
    const images = [...new Set([videoShot.startImageId, videoShot.endImageId].filter(Boolean))].map(id => ({ id, sha256: workflow.images.find(image => image.id === id).sha256 }));
    const staticText = workflow.shotPrompts?.find(item => item.shotId === shot.id)?.text ?? shot.prompt.text;
    return { shotId: shot.id, note: comment.note, videoShotId: videoShot.id, promptHash: promptHash(staticText), videoPromptHash: promptHash(videoShot.videoPrompt ?? (videoShot.shotIds.length === 1 ? shot.videoPrompt ?? '' : '')), images };
  });
  if (!entries.length) fail('没有填写新意见，未保存反馈');
  const contentHash = hash({ projectId: workflow.projectId, workflowHash: hash(workflow), entries });
  const output = localFolder(directory, 'video-workflow/feedback'), file = path.join(output, `${contentHash}.json`);
  const markdownFile = path.join(output, `${contentHash}.md`);
  if (fs.existsSync(file) || fs.existsSync(markdownFile) || fs.readdirSync(output).some(name => name.endsWith('.json') && read(path.join(output, name)).sourceSha256 === sourceSha256)) fail('这份意见已导入，拒绝重复记录');
  const record = { schemaVersion: 1, projectId: workflow.projectId, revision: workflow.revision, workflowHash: hash(workflow), sourceSha256, importedAt: new Date().toISOString(), status: 'user-feedback-uninterpreted', changesRules: false, entries };
  const markdown = ['# 用户制作意见', '', `项目：${record.projectId}`, `视频规划版本：${record.revision}`, `导入时间：${record.importedAt}`, `规划哈希：${record.workflowHash}`, `反馈文件哈希：${record.sourceSha256}`, '',
    '本记录仅保留用户填写意见，不自动修改图片确认、评分或制作规则。',
    ...entries.flatMap(entry => ['', `## ${entry.shotId} · ${entry.videoShotId}`, '', `意见：${String(entry.note)}`, '', `静帧正文哈希：${entry.promptHash}`, `视频正文哈希：${entry.videoPromptHash}`, `图片绑定：${entry.images.length ? entry.images.map(image => `${image.id}（${image.sha256}）`).join('；') : '无图片绑定'}`])].join('\n') + '\n';
  const created = [];
  try {
    for (const [filename, value] of [[file, JSON.stringify(record, null, 2) + '\n'], [markdownFile, markdown]]) {
      const handle = fs.openSync(filename, 'wx'); created.push(filename);
      try { fs.writeFileSync(handle, value, 'utf8'); } finally { fs.closeSync(handle); }
    }
  } catch (error) { for (const filename of created) fs.unlinkSync(filename); throw error; }
  return { file, markdownFile, imported: entries.length };
}

async function main() {
    const [command, directory, revision, feedback] = process.argv.slice(2);
    if (!directory || !revision) fail('用法：video.mjs seal/finalize <project> <input.json> | validate/export <project> <revision.json> | bind-excel <project> <revision.json> <existing.xlsx> | feedback <project> <revision.json> <feedback.json|xlsx>');
    let result;
    if (command === 'seal') { const sealed = sealVideoWorkflow(directory, read(revision)); result = { status: 'sealed', file: sealed.file, ...summary(sealed.workflow) }; }
    else if (command === 'finalize') { result = await finalizeVideoWorkflow(directory, read(revision)); if (!result.exportsUpdated) process.exitCode = 1; }
    else {
      const workflow = read(insideFile(directory, revision));
      if (command === 'validate') { validateVideoWorkflow(directory, workflow); result = { status: 'valid', ...summary(workflow) }; }
      else if (command === 'export' || command === 'bind-excel' && feedback) {
        const { exportVisualProject } = await import('./visual.mjs');
        result = { files: await exportVisualProject(directory, { videoWorkflow: workflow, bindWorkbook: command === 'bind-excel' ? feedback : null }) };
      }
      else if (command === 'feedback' && feedback) result = await importVideoFeedback(directory, workflow, feedback);
      else fail('未知命令或缺少反馈文件');
    }
    console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(JSON.stringify({ status: 'invalid', message: error.message }, null, 2)); process.exitCode = 1;
});
