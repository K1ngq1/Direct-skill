import ExcelJS from './vendor/exceljs.cjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { addSheet } from './export_excel.mjs';
import { dimensionsFor, reviewTotal, calibrationBackground, rubricVersion, promptHash } from './visual.mjs';
import { assetPlanHash } from './visual_v2.mjs';
import { ProjectError } from './project.mjs';

const joined = values => values.join('\n');
const assessment = review => review.rewrite.needed ? '建议重写；本次未执行' : '保留当前一稿';

export function textLines(text, columnWidth) {
  // shortcut: conservative YaHei wrapping estimates, use reader metrics if fonts or wrapping rules change.
  const width = Math.max(8, (columnWidth - 2) * 0.75);
  return text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil([...line].reduce((n, char) => n + (char.codePointAt(0) > 255 ? 2 : 1), 0) / width)), 0);
}

function readable(sheet, widths = {}) {
  for (const [key, width] of Object.entries(widths)) sheet.getColumn(Number(key)).width = width;
  sheet.eachRow((row, rowNumber) => {
    row.eachCell(cell => { cell.font = { ...cell.font, name: 'Microsoft YaHei' }; });
    if (rowNumber === 1) return;
    let lines = 2;
    row.eachCell(cell => {
      const width = sheet.getColumn(cell.col).width ?? 20;
      const text = cell.text;
      const count = textLines(text, width);
      lines = Math.max(lines, count);
      if (rowNumber % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6F9' } };
    });
    row.height = Math.min(409, Math.max(54, lines * 18 + 18));
  });
  sheet.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1' };
  return sheet;
}

function createWorkbook(title) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '画面分镜 Skill'; workbook.title = title;
  workbook.created = new Date(); workbook.modified = new Date();
  return workbook;
}

const statusText = status => ({ passed: '检查通过（不等于用户确认）', pending: '待处理', invalid: '检查未通过' }[status] ?? '未执行硬校验');
const selectionText = shot => ({ 'agent-default': 'Agent默认方案', user: '用户选择' }[shot.selection?.by] ?? '未记录');
const issueText = issue => `[${issue.category}/${issue.code}] ${issue.path || '/'}：${issue.message}\n修改要求：${issue.requirement}`;

function exportCheck(plan, shot, report) {
  if (!report) return { status: '未执行硬校验', issues: [] };
  const ids = new Set(plan.shots.map(item => item.id));
  const globalIssues = report.issues.filter(issue => !ids.has(issue.entityId));
  const result = report.shots.find(item => item.id === shot.id);
  const issues = [...new Map([...globalIssues, ...(result?.issues ?? [])].map(issue => [JSON.stringify(issue), issue])).values()];
  const status = issues.some(issue => issue.severity === 'error') ? 'invalid' : issues.length ? 'pending' : result?.status;
  return { status: statusText(status), issues };
}

function currentReview(entry, version) {
  const review = entry.review, text = entry.prompt?.text ?? entry.text;
  const dimensions = dimensionsFor(version);
  return review && review.promptHash === promptHash(text) && review.rubricVersion === version
    && Array.isArray(review.scores) && review.scores.length === dimensions.length
    && dimensions.every(([key]) => review.scores.some(score => score.dimension === key && (score.score === null || typeof score.score === 'number' && score.score >= 0 && score.score <= 5)))
    && Array.isArray(review.strengths) && Array.isArray(review.weaknesses) && typeof review.rewrite?.needed === 'boolean' && typeof review.rewrite.reason === 'string';
}

function sourcePosition(project, shot) {
  return shot.sourceShotIds.map(id => {
    const source = project.shots.find(item => item.id === id), ref = source?.sourceRef;
    return [id, ref?.sheet, ref?.contentCell].filter(Boolean).join(' · ');
  }).join('\n');
}

export function exportVisualMarkdown(plan, project, report = null, context = {}) {
  const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const json = value => ['```json', JSON.stringify(value, null, 2), '```'];
  const version = plan.rubricVersion ?? rubricVersion;
  const lines = [`# ${context.workflow?.title ?? plan.title} · 制作日志`, '', `项目：${plan.projectId}；修订：${plan.revision ?? '未记录'}；${statusText(report?.status)}`, '',
    '内部生产记录；评分、检查、版本和来源证据仅保留在本日志，不进入用户脚本 Excel。采用与检查通过不表示用户确认；程序检查不代替画面语义复核。', '',
    `原件路径：${project.source?.path ?? '未记录'}；原件哈希：${project.source?.sha256 ?? plan.sourceSha256 ?? '未记录'}`, '',
    '| 镜号 | 秒数 | 当前方案ID | 采用来源 | 检查状态 |', '| --- | --- | --- | --- | --- |',
    ...plan.shots.map(shot => `| ${[shot.id, shot.seconds, shot.variantId, selectionText(shot), exportCheck(plan, shot, report).status].map(cell).join(' | ')} |`)];
  const reviewLog = (entry, permitScore = true) => {
    if (!entry.review) return ['尚未评分。'];
    const review = entry.review, valid = currentReview(entry, version) && permitScore;
    const dimensions = dimensionsFor(version);
    return [valid ? `有效文本评分：${reviewTotal(review)} / 100` : '评分未验证或已失效，不计分；以下原始评价仅归档。',
      `评审者：${review.reviewer ?? '未记录'}；评分规则：${review.rubricVersion ?? '未记录'}；Prompt哈希：${review.promptHash ?? '未记录'}`, '',
      '| 维度 | 权重 | 原始分值 | Prompt原文证据 | 理由 |', '| --- | --- | --- | --- | --- |',
      ...(review.scores ?? []).map(score => {
        const definition = dimensions.find(([key]) => key === score.dimension);
        return `| ${[definition?.[1] ?? score.dimension, definition?.[2], score.score ?? 'N/A', score.evidence, score.reason].map(cell).join(' | ')} |`;
      }), '', `优点：${(review.strengths ?? []).join('；') || '未记录'}`, `不足：${(review.weaknesses ?? []).join('；') || '未记录'}`,
      `重写建议：${review.rewrite ? assessment(review) : '未记录'}；原因：${review.rewrite?.reason ?? '未记录'}；实际执行：${review.rewrite?.executed === true ? '已执行' : '未执行'}`, '',
      ...json(review)];
  };
  for (const shot of plan.shots) {
    const check = exportCheck(plan, shot, report);
    lines.push('', `## ${shot.id}`, '', `当前方案：${shot.variantId ?? '未记录'}；${selectionText(shot)}；${check.status}`, '',
      `原稿来源：${sourcePosition(project, shot).replace(/\n/g, '；')}`, '',
      `原稿内容：${shot.sourceShotIds.map(id => project.shots.find(source => source.id === id)?.original ?? `缺少原稿：${id}`).join('\n')}`, '',
      `Prompt哈希：${shot.prompt.textHash ?? promptHash(shot.prompt.text)}；来源哈希：${shot.prompt.sourceHash ?? '未记录'}`, '',
      ...check.issues.flatMap(issue => [issueText(issue), '']), '### 自然语言 Prompt', '', shot.prompt.text);
    if (context.workflow?.shotPrompts?.some(item => item.shotId === shot.id)) lines.push('', '本轮静帧正文与参考已修订；原冻结计划保留作来源，旧正文评分与语义核对不代表本轮正文通过。');
    if (shot.videoPrompt !== undefined) lines.push('', '### 视频 Prompt', '', shot.videoPrompt);
    lines.push('', '### 文本评分与证据', '', ...reviewLog(shot, plan.schemaVersion !== 2 || report?.shots?.find(row => row.id === shot.id)?.scoreValid === true));
    if (shot.semanticReview) lines.push('', '### 独立语义核对', '', ...json(shot.semanticReview));
  }
  if (plan.calibration?.length) for (const sample of plan.calibration) lines.push('', `## 人工校准样本 ${sample.id}`, '', sample.text, '', ...reviewLog(sample), '', ...json(sample));
  for (const [title, value] of [['硬校验记录', report], ['视频工作流与验收记录', context.workflow], ['生成清单与失败记录', context.manifest], ['人物资产记录', context.characterBundle], ['场景资产记录', context.sceneBundle]]) {
    if (value) lines.push('', `## ${title}`, '', ...json(value));
  }
  return lines.join('\n') + '\n';
}

export function validateCharacterBundle(bundle, plan) {
  const fail = message => { throw new ProjectError(message, 422); };
  const text = (value, label, allowEmpty = false) => {
    if (typeof value !== 'string' || (!allowEmpty && !value.trim())) fail(`${label}须为文本`);
  };
  const sourcePlanHash = plan.schemaVersion === 2 ? assetPlanHash(plan, 'characters') : promptHash(JSON.stringify(plan));
  if (bundle.schemaVersion !== 1 || bundle.projectId !== plan.projectId || bundle.sourcePlanHash !== sourcePlanHash) fail('人物Prompt与冻结项目版本不匹配，请核对后建立新版本');
  if (!Array.isArray(bundle.characters) || (plan.schemaVersion !== 2 && !bundle.characters.length)) fail('人物Prompt不能为空');
  const seen = new Set();
  for (const character of bundle.characters) {
    const asset = plan.productionInventory.characters.find(item => item.id === character.assetId);
    if (!asset || seen.has(character.assetId)) fail('人物Prompt资产不存在或重复');
    seen.add(character.assetId);
    const base = character.base;
    if (!base || !['generate', 'reuse', 'not-required', 'blocked'].includes(base.mode)) fail('人物基础Prompt模式无效');
    text(base.text, '人物基础Prompt', base.mode !== 'generate'); text(base.basis, '人物基础依据');
    const bound = new Set(plan.shots.flatMap(shot => shot.shotSchema.subjects.filter(subject => subject.assetId === asset.id).flatMap(subject => subject.referenceIds)));
    if (!Array.isArray(base.referenceIds) || new Set(base.referenceIds).size !== base.referenceIds.length || base.referenceIds.some(id => !bound.has(id) || !plan.references.some(reference => reference.id === id))) fail('人物图片必须绑定到该角色，不能用其他人或场景图代替');
    if ((base.mode === 'reuse' && !base.referenceIds.length) || (base.mode !== 'reuse' && base.referenceIds.length)) fail('人物基础模式与实际参考不一致');
    if (base.mode !== 'generate' && base.text) fail('非新建模式不填写可执行基础Prompt');
    if (!Array.isArray(character.optionalDetails)) fail('人物可选细节须为数组');
    const options = new Set();
    for (const detail of character.optionalDetails) {
      text(detail.id, '细节ID'); text(detail.description, '细节提案'); text(detail.template, '细节编辑模板');
      if (options.has(detail.id)) fail('人物细节ID重复'); options.add(detail.id);
      if (detail.state !== 'dormant' || detail.requiresUserRequest !== true) fail('主观人物细节必须保持未启用，不能自动激活');
      if (detail.template.split('{{characterReference}}').length !== 2) fail('细节编辑模板须保留一个待绑定的真实人物图片位置');
    }
  }
  if (plan.schemaVersion === 2 && plan.productionInventory.characters.some(asset => !seen.has(asset.id))) fail('人物Prompt须覆盖全部已登记角色；无需基础图或待补设定也须明确记录');
  return bundle;
}

export async function exportCharacterExcel(bundle, plan) {
  validateCharacterBundle(bundle, plan);
  const workbook = createWorkbook(plan.title + ' · 人物资产');
  readable(addSheet(workbook, '使用说明', ['内容', '规则'], [
    ['基础人物图', '基础Prompt只使用已知设定和有依据的导演拍法。已有实际角色图直接复用；不生成替代身份。'],
    ['可选细节', '痣、雀斑等为未采用的主观提案，独立保存；不混入基础人物Prompt、分镜正文或默认生成请求。'],
    ['何时使用', '人物参考图存在且用户明确要求某项细节后，仅使用所要求的一项编辑Prompt。将模板中的图片位置换成实际@引用，并绑定该图片输入。未绑定模板不能直接提交。'],
    ['保持一致', '位置按人物自身左右定义；只改变指定局部，保留五官比例、年龄感、发型、表情、服装、构图及光线。不要把所有可选提案一起提交。'],
    ['后续资产', '用户采用生成或编辑结果后，以稳定资产ID登记新的参考版本，再核对关联分镜。图片生成与用户确认状态以项目生成清单为准。']
  ]), {1:22, 2:115});
  const mode = { generate:'新建基础图', reuse:'复用已有角色图', 'not-required':'无需新增头像', blocked:'待补基础设定' };
  readable(addSheet(workbook, '基础人物Prompt', ['资产ID', '内部角色名', '处理方式', '基础人物Prompt', '实际参考ID', '依据及边界'], bundle.characters.map(character => [
    character.assetId, plan.productionInventory.characters.find(asset => asset.id === character.assetId).name,
    mode[character.base.mode], character.base.text || null, character.base.referenceIds.length ? joined(character.base.referenceIds) : null, character.base.basis
  ])), {1:20, 2:18, 3:23, 4:105, 5:22, 6:68});
  readable(addSheet(workbook, '可选细节编辑Prompt', ['资产ID', '内部角色名', '细节ID', '主观细节提案', '独立编辑Prompt模板（未启用）', '使用条件'], bundle.characters.flatMap(character => character.optionalDetails.map(detail => [
    character.assetId, plan.productionInventory.characters.find(asset => asset.id === character.assetId).name,
    detail.id, detail.description, detail.template, '未启用；仅在该角色真实参考图可用且用户要求此项后绑定使用，不提交其他提案。'
  ]))), {1:20, 2:18, 3:26, 4:58, 5:110, 6:50});
  return {filename:'人物资产Prompt.xlsx',buffer:Buffer.from(await workbook.xlsx.writeBuffer())};
}

export function validateSceneBundle(bundle, plan) {
  const fail = message => { throw new ProjectError(message, 422); };
  const text = (value, label) => { if (typeof value !== 'string' || !value.trim()) fail(`${label}须为非空文本`); };
  const texts = (value, label, required = false) => {
    if (!Array.isArray(value) || required && !value.length) fail(`${label}须为${required ? '非空' : ''}文本数组`);
    value.forEach(item => text(item, label));
  };
  const sourcePlanHash = plan.schemaVersion === 2 ? assetPlanHash(plan, 'locations') : promptHash(JSON.stringify(plan));
  if (bundle.schemaVersion !== 1 || bundle.projectId !== plan.projectId || bundle.sourcePlanHash !== sourcePlanHash) fail('场景Prompt与冻结项目版本不匹配，请核对后建立新版本');
  if (bundle.designStageVersion !== undefined && bundle.designStageVersion !== 1) fail('场景美术设计版本无效');
  const requiresDesign = bundle.designStageVersion === 1 || plan.schemaVersion === 2 && plan.rules?.files?.some(file => file.path === 'references/scene-art-direction.md');
  if (!Array.isArray(bundle.locations) || (plan.schemaVersion !== 2 && !bundle.locations.length)) fail('场景Prompt不能为空');
  const seen = new Set();
  for (const location of bundle.locations) {
    if (!plan.productionInventory.locations.some(asset => asset.id === location.assetId) || seen.has(location.assetId)) fail('场景Prompt资产不存在或重复');
    seen.add(location.assetId);
    const base = location.base;
    if (base?.mode !== 'generate' || typeof base.text !== 'string' || !base.text.trim() || typeof base.basis !== 'string' || !base.basis.trim()) fail(plan.schemaVersion === 2 ? '场景资产须有Prompt与依据' : '场景三视图须有生成Prompt与依据');
    if (!Array.isArray(base.referenceIds) || base.referenceIds.length) fail(plan.schemaVersion === 2 ? '新建场景资产不绑定未生成的参考' : '新建场景三视图不绑定未生成的参考');
    const design = location.sceneDesign;
    if (design === undefined && !requiresDesign) continue;
    if (!design || typeof design !== 'object' || Array.isArray(design)) fail(`${location.assetId}须有场景美术设计 sceneDesign`);
    for (const key of ['useAndUsers', 'layout', 'useTraces', 'materials', 'composition']) text(design[key], `${location.assetId}.${key}`);
    for (const key of ['scriptFacts', 'invariants']) texts(design[key], `${location.assetId}.${key}`, true);
    for (const key of ['large', 'medium', 'small']) texts(design.furnishingLayers?.[key], `${location.assetId}.furnishingLayers.${key}`);
    if (!Array.isArray(design.views) || !design.views.length) fail(`${location.assetId}.views须为非空数组`);
    const shots = plan.shots.filter(shot => shot.locationId === location.assetId).map(shot => shot.id), used = new Set(), viewIds = new Set();
    for (const view of design.views) {
      for (const key of ['id', 'position', 'visible', 'keepClear']) text(view?.[key], `${location.assetId}.views.${key}`);
      if (viewIds.has(view.id)) fail('场景机位ID重复'); viewIds.add(view.id);
      texts(view.shotIds, `${location.assetId}.views.shotIds`, shots.length > 0);
      for (const shotId of view.shotIds) {
        if (!shots.includes(shotId) || used.has(shotId)) fail('场景机位须引用本场景真实镜号一次，不能跨场景或重复绑定');
        used.add(shotId);
      }
    }
    if (shots.some(shotId => !used.has(shotId))) fail('场景机位须覆盖本场景全部镜头');
    if (!Array.isArray(design.constraintReview)) fail('场景约束核对须为数组');
    for (const item of design.constraintReview) {
      for (const key of ['original', 'source', 'reason']) text(item?.[key], `场景约束核对.${key}`);
      if (!['retain', 'narrow', 'remove', 'replace'].includes(item.decision)) fail('场景约束处理方式无效');
      if (['narrow', 'replace'].includes(item.decision) || item.replacement !== undefined) text(item.replacement, '场景约束替换内容');
    }
  }
  if ((plan.schemaVersion === 2 || requiresDesign) && plan.productionInventory.locations.some(asset => !seen.has(asset.id))) fail('场景Prompt须覆盖全部已登记场景');
  return bundle;
}

export async function exportSceneExcel(bundle, plan) {
  validateSceneBundle(bundle, plan);
  const workbook = createWorkbook(plan.title + ' · 场景资产');
  const v2 = plan.schemaVersion === 2, label = v2 ? '场景资产Prompt' : '场景三视图Prompt';
  readable(addSheet(workbook, '使用说明', ['内容', '规则'], [
    v2 ? ['场景资产', '默认每机位一张独立16:9场景图；具体视角与画幅按本次正文设计，保持同一空间的布局、陈设和光源。这里只交付Prompt文本，不自动生成图片。'] : ['场景三视图', '每条Prompt生成一张包含同一空间三个互补机位的三联图，固定布局、陈设和光源。'],
    ['道具', '必要陈设与场景道具写入场景及分镜Prompt，不独立生成道具图。'],
    ['用户确认', '实际生成、文件与用户确认状态以项目生成清单为准；未确认资产不用于下一阶段分镜生成。']
  ]), {1:22, 2:115});
  readable(addSheet(workbook, label, ['资产ID', '内部场景名', label, '依据及边界'], bundle.locations.map(location => [
    location.assetId, plan.productionInventory.locations.find(asset => asset.id === location.assetId).name, location.base.text, location.base.basis
  ])), {1:20, 2:24, 3:115, 4:70});
  return { filename: '场景资产Prompt.xlsx', buffer: Buffer.from(await workbook.xlsx.writeBuffer()) };
}

const uniqueText = values => [...new Set(values.filter(value => typeof value === 'string' && value.trim()))].join('\n');
const timecode = seconds => {
  const tenths = Math.round(seconds * 10), minutes = Math.floor(tenths / 600);
  return String(minutes).padStart(2, '0') + ':' + (tenths % 600 / 10).toFixed(1).padStart(4, '0');
};

function deliverySheet(workbook, name, headers, rows, widths) {
  const sheet = readable(addSheet(workbook, name, headers, rows), widths);
  sheet.views = [{ state: 'frozen', xSplit: name === '分镜脚本' ? 1 : 2, ySplit: 1 }];
  sheet.properties.tabColor = { argb: name === '分镜脚本' ? 'FF304C61' : 'FF9AAEBB' };
  sheet.eachRow((row, rowNumber) => row.eachCell({ includeEmpty: true }, cell => {
    cell.font = { ...cell.font, name: 'Microsoft YaHei', size: 11 };
    cell.border = rowNumber === 1 ? {} : { bottom: { style: 'hair', color: { argb: 'FFDDE3E8' } } };
    if (rowNumber === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF304C61' } };
  }));
  sheet.pageSetup.margins = { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.15, footer: 0.15 };
  sheet.headerFooter = { oddHeader: '&L&"Microsoft YaHei,Bold"&16' + workbook.title, oddFooter: '&R&P / &N' };
  return sheet;
}

export function promptParts(text, columnWidth = 112, maxLines = 20) {
  const parts = []; let part = '';
  for (const paragraph of text.replace(/\r\n?/g, '\n').match(/[^\n]+(?:\n+|$)|\n+/gu) ?? ['']) {
    if (textLines(paragraph, columnWidth) > maxLines) throw new ProjectError('完整段落过长，无法在 Excel 行高上限内完整显示；请在自然段落边界补换行后重新导出，不会截断正文。', 422);
    if (part && textLines(part + paragraph, columnWidth) > maxLines) { parts.push(part); part = ''; }
    part += paragraph;
  }
  parts.push(part);
  return parts;
}

function sceneDesignText(design) {
  const layers = [['large', '大件'], ['medium', '中型收纳'], ['small', '日用品']].map(([key, label]) => `${label}：${design.furnishingLayers[key].join('；') || '不适用，见画面取舍'}`).join('\n');
  return `脚本事实\n${design.scriptFacts.join('\n')}\n\n场景设计（脚本事实之外为导演补全）\n空间用途与使用者：${design.useAndUsers}\n\n核心布局：${design.layout}\n\n陈设层次\n${layers}\n\n使用痕迹：${design.useTraces}\n\n材质层次：${design.materials}\n\n画面取舍：${design.composition}`;
}

function localImage(directory, metadata) {
  if (!directory || !metadata?.path) return null;
  const root = fs.realpathSync(directory), filename = fs.realpathSync(path.resolve(directory, metadata.path));
  const relative = path.relative(root, filename);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new ProjectError('图片路径必须位于项目目录内', 422);
  const buffer = fs.readFileSync(filename);
  if (metadata.sha256 && promptHash(buffer) !== metadata.sha256) throw new ProjectError('图片哈希已变化，请重新检查后导出', 422);
  let width, height, extension;
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20); extension = 'png';
  } else if (buffer.length >= 10 && /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) {
    width = buffer.readUInt16LE(6); height = buffer.readUInt16LE(8); extension = 'gif';
  } else if (buffer.length >= 4 && buffer.readUInt16BE(0) === 0xffd8) {
    extension = 'jpeg';
    for (let offset = 2; offset + 8 < buffer.length;) {
      if (buffer[offset++] !== 0xff) continue;
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = buffer.readUInt16BE(offset + 3); width = buffer.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!width || !height) throw new ProjectError('图片无法读取尺寸；请提供有效的 PNG、JPEG 或 GIF', 422);
  return { filename, buffer, extension, width, height };
}

function placeImage(workbook, sheet, rowNumber, column, image, caption = '') {
  if (!image) return;
  const width = Math.min(240, 480 * image.width / image.height), height = width * image.height / image.width;
  const id = workbook.addImage({ buffer: image.buffer, extension: image.extension });
  const row = sheet.getRow(rowNumber);
  row.height = Math.max(row.height ?? 0, (height + 36) * 0.75);
  // ExcelJS emits an invalid editAs attribute for tl+ext; two-cell anchors preserve valid OOXML and exact image pixels.
  sheet.addImage(id, {
    tl: { nativeCol: column - 1, nativeColOff: Math.round(4 * 9525), nativeRow: rowNumber - 1, nativeRowOff: Math.round(22 * 9525) },
    br: { nativeCol: column - 1, nativeColOff: Math.round((width + 4) * 9525), nativeRow: rowNumber - 1, nativeRowOff: Math.round((height + 22) * 9525) },
    editAs: 'oneCell'
  });
  row.getCell(column).value = { text: caption ? `${caption} · 查看原图` : '查看原图', hyperlink: pathToFileURL(image.filename).href };
  row.getCell(column).font = { name: 'Microsoft YaHei', size: 11, color: { argb: 'FF375F81' }, underline: true };
}

function calibrationExcel(workbook, plan, project) {
  readable(addSheet(workbook, '填写说明', ['项目', '内容'], [
    ['填写位置', '在“人工评分”的黄色单元格填写用户总分（0–100）和原因；0分有效，可以只评部分样本。'],
    ['样本范围', String(plan.calibration.length) + '条单独校准文本；不作为正式拍法选择，不改变正式方案。'],
    ['导入', '只导入用户实际填写的总分和原因；冻结的ID、Prompt和背景不得修改。反馈独立保存，不自动改权重或重新生成。']
  ]), { 1: 20, 2: 112 });
  const sheet = readable(addSheet(workbook, '人工评分', ['样本ID', '关联镜号', '样本', '完整Prompt', '画面背景', '用户总分（0–100）', '用户原因', 'Prompt哈希', '来源哈希', '项目ID'], plan.calibration.map(sample => [
    sample.id, sample.shotId, sample.label, sample.text, calibrationBackground(plan, project, sample), null, null, sample.textHash, sample.sourceHash, plan.projectId
  ])), { 1: 16, 2: 15, 3: 18, 4: 108, 5: 85, 6: 22, 7: 65, 8: 25, 9: 25, 10: 25 });
  sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];
  const column = label => sheet.getRow(1).values.indexOf(label);
  for (let n = 2; n <= plan.calibration.length + 1; n++) {
    for (const label of ['用户总分（0–100）', '用户原因']) {
      const cell = sheet.getRow(n).getCell(column(label));
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2B2' } }; cell.protection = { locked: false };
    }
    sheet.getRow(n).getCell(column('用户总分（0–100）')).dataValidation = { type: 'decimal', operator: 'between', allowBlank: true, formulae: [0, 100], showErrorMessage: true, errorStyle: 'stop', errorTitle: '分数范围', error: '请填写0至100的数字。' };
  }
  for (const label of ['Prompt哈希', '来源哈希', '项目ID']) sheet.getColumn(column(label)).hidden = true;
}

export async function exportVisualExcel(plan, project, totalSeconds, manifest = null, report = null, context = {}) {
  const workflow = context.workflow, title = workflow?.title || plan.title;
  const workbook = createWorkbook(title), images = workflow?.images ?? [], videos = workflow?.videoShots ?? [];
  const characters = plan.productionInventory.characters, locations = plan.productionInventory.locations;
  const byShot = new Map(videos.flatMap(video => video.shotIds.map(id => [id, video])));
  const timeline = new Map((workflow?.timeline ?? []).map(row => [row.shotId, row]));
  const assetImages = new Map((workflow?.assetImages ?? []).map(image => [image.assetId, image]));
  const imageFor = (shot, visited = new Set()) => {
    if (!shot || visited.has(shot.id)) return null;
    visited.add(shot.id);
    return images.find(image => image.shotId === shot.id) ?? (shot.reuseOf ? imageFor(plan.shots.find(item => item.id === shot.reuseOf), visited) : null);
  };
  let elapsed = 0;
  const rows = plan.shots.map(shot => {
    const video = byShot.get(shot.id), duration = timeline.get(shot.id)?.seconds ?? shot.seconds;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) throw new ProjectError('镜头时长须为非负秒数', 422);
    const start = elapsed; elapsed = Math.round((elapsed + duration) * 1000) / 1000;
    const sources = shot.sourceShotIds.map(id => project.shots.find(source => source.id === id)).filter(Boolean);
    const dialogue = uniqueText(sources.flatMap(source => (source.originalFields ?? []).filter(field => /台词|对白|旁白|音效|声音/.test(field.name)).map(field => field.value)));
    const location = locations.find(item => item.id === shot.locationId)?.name ?? '';
    const names = shot.shotSchema.subjects.map(subject => characters.find(item => item.id === subject.assetId)?.name).filter(Boolean);
    const image = imageFor(shot);
    const content = timeline.get(shot.id)?.description ?? (video ? video.shotIds[0] === shot.id ? uniqueText([video.startState, video.action, video.endState]) : video.endState : shot.dimensions.moment || sources.map(source => source.original).join('\n') || shot.motion);
    const notes = uniqueText([shot.reuseOf ? '复用 ' + shot.reuseOf + ' 画面' : '', image?.productionNote ?? (image?.review?.status === 'needs-change' ? '参考图待修正，详见制作日志' : '')]);
    return [shot.id, timecode(start) + '–' + timecode(elapsed), duration, uniqueText([location, names.join('、')]), image ? null : '待补图',
      content, video ? uniqueText([video.dialogue, video.sound]) || dialogue : dialogue,
      uniqueText([video?.camera ?? shot.dimensions.camera, shot.dimensions.optics]), notes, null];
  });
  const summary = deliverySheet(workbook, '分镜脚本', ['镜号', '起止时间', '时长（秒）', '场景与人物', '分镜图', '画面与动作', '对白与声音', '摄影与运镜', '衔接备注', '用户意见'], rows,
    { 1: 9, 2: 18, 3: 10, 4: 20, 5: 35, 6: 38, 7: 28, 8: 28, 9: 30, 10: 24 });
  const promptRows = [], targets = new Map(), deliveryGroups = [];
  const appendPrompt = (type, name, text, shotId, entityId = name) => {
    if (typeof text !== 'string' || !text.length) return;
    if (shotId && !targets.has(shotId)) targets.set(shotId, promptRows.length + 2);
    const start = promptRows.length + 2;
    promptParts(text).forEach((part, index) => promptRows.push([index ? type + '（续' + (index + 1) + '）' : type, name, part]));
    deliveryGroups.push({ id: `prompt/${type}/${entityId}`, kind: 'prompt', sheet: '生成Prompt',
      rows: Array.from({ length: promptRows.length + 2 - start }, (_, index) => start + index),
      values: [type, name, text.replace(/\r\n?/g, '\n')], textColumn: 3 });
  };
  appendPrompt('全片视频参数', '全片', workflow?.generationSettings);
  appendPrompt('音乐', '全片', workflow?.musicPrompt);
  for (const shot of plan.shots) {
    appendPrompt('静帧', shot.id, workflow?.shotPrompts?.find(item => item.shotId === shot.id)?.text ?? shot.prompt.text, shot.id);
    if (shot.videoPrompt !== undefined) appendPrompt('视频', shot.id, shot.videoPrompt, shot.id);
  }
  for (const video of videos) {
    if (video.videoPrompt && !video.shotIds.every(id => plan.shots.find(shot => shot.id === id)?.videoPrompt === video.videoPrompt)) appendPrompt('视频', video.shotIds.join(' / '), video.videoPrompt, video.shotIds[0]);
    appendPrompt('视频参数', video.shotIds.join(' / '), video.generationParameters);
  }
  for (const character of context.characterBundle?.characters ?? []) appendPrompt('人物', characters.find(item => item.id === character.assetId)?.name ?? '', character.base.text, undefined, character.assetId);
  for (const location of context.sceneBundle?.locations ?? []) appendPrompt('场景', locations.find(item => item.id === location.assetId)?.name ?? '', location.base.text, undefined, location.assetId);
  const prompts = deliverySheet(workbook, '生成Prompt', ['类型', '对应镜号或名称', '完整Prompt'], promptRows, { 1: 18, 2: 24, 3: 112 });
  const assets = [...characters.map(asset => ({ ...asset, type: '人物' })), ...locations.map(asset => ({ ...asset, type: '场景' }))];
  const assetShots = asset => plan.shots.filter(shot => asset.type === '人物' ? shot.shotSchema.subjects.some(subject => subject.assetId === asset.id) : shot.locationId === asset.id);
  const settingEntries = assets.flatMap(asset => {
    const design = asset.type === '场景' ? context.sceneBundle?.locations.find(location => location.assetId === asset.id)?.sceneDesign : null;
    const text = design ? sceneDesignText(design) : assetImages.get(asset.id)?.description ?? asset.description;
    return promptParts(text, 78).map((part, index) => ({ asset, first: index === 0, row: [asset.name + (index ? '（续）' : ''), asset.type, index ? null : '待补图', part, assetShots(asset).map(shot => shot.id).join('、')] }));
  });
  const settings = deliverySheet(workbook, '人物与场景', ['名称', '类型', '参考图', '造型或空间设定', '使用镜头'], settingEntries.map(entry => entry.row), { 1: 22, 2: 12, 3: 36, 4: 78, 5: 30 });
  for (const [index, shot] of plan.shots.entries()) {
    const row = summary.getRow(index + 2);
    for (let col = 1; col <= 10; col++) row.getCell(col).protection = { locked: col !== 10 };
    row.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4CE' } };
    row.height = Math.max(119, row.height);
    if (targets.has(shot.id)) row.getCell(1).value = { text: shot.id, hyperlink: "#'生成Prompt'!C" + targets.get(shot.id) };
    placeImage(workbook, summary, index + 2, 5, localImage(context.directory, imageFor(shot)));
  }
  for (let index = 0; index < promptRows.length; index++) {
    const name = promptRows[index][1], shot = plan.shots.find(item => name.split(' / ').includes(item.id));
    if (shot) prompts.getRow(index + 2).getCell(2).value = { text: name, hyperlink: "#'分镜脚本'!A" + (plan.shots.indexOf(shot) + 2) };
  }
  for (const [index, { asset, first }] of settingEntries.entries()) {
    const image = assetImages.get(asset.id);
    if (first) placeImage(workbook, settings, index + 2, 3, localImage(context.directory, image), image?.caption);
    const shots = assetShots(asset);
    if (shots.length) settings.getRow(index + 2).getCell(5).value = { text: shots.map(shot => shot.id).join('、'), hyperlink: "#'分镜脚本'!A" + (plan.shots.indexOf(shots[0]) + 2) };
  }
  await summary.protect('', { selectLockedCells: true, selectUnlockedCells: true, autoFilter: true });
  const safeTitle = Array.from(String(title || '分镜项目').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim().replace(/[. ]+$/g, '')).slice(0, 80).join('') || '分镜项目';
  const cellValue = cell => cell.value === null ? null : typeof cell.value === 'object' ? cell.text : cell.value;
  for (const [index, shot] of plan.shots.entries()) deliveryGroups.push({
    id: `shot/${shot.id}`, kind: 'row', sheet: '分镜脚本', rows: [index + 2],
    values: Array.from({ length: 9 }, (_, column) => cellValue(summary.getCell(index + 2, column + 1)))
  });
  for (const asset of assets) {
    const entries = settingEntries.flatMap((entry, index) => entry.asset.id === asset.id ? [index + 2] : []);
    const values = Array.from({ length: 5 }, (_, column) => cellValue(settings.getCell(entries[0], column + 1)));
    values[3] = entries.map(row => settings.getCell(row, 4).text).join('');
    deliveryGroups.push({ id: `asset/${asset.type}/${asset.id}`, kind: 'asset', sheet: '人物与场景', rows: entries, values, textColumn: 4 });
  }
  const deliveryData = { schemaVersion: 1, projectId: plan.projectId, groups: deliveryGroups,
    sheets: [summary, prompts, settings].map(sheet => ({ name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount,
      headers: Array.from({ length: sheet.columnCount }, (_, column) => cellValue(sheet.getCell(1, column + 1))) })),
    mediaHashes: (workbook.model.media ?? []).map(item => promptHash(item.buffer))
  };
  const files = [{ filename: safeTitle + '_分镜脚本.xlsx', buffer: Buffer.from(await workbook.xlsx.writeBuffer()), deliveryData }];
  if (context.calibration === true && plan.calibration?.length) {
    const calibration = createWorkbook(title + ' · 人工校准'); calibrationExcel(calibration, plan, project);
    files.push({ filename: '人工校准.xlsx', buffer: Buffer.from(await calibration.xlsx.writeBuffer()) });
  }
  return files;
}
