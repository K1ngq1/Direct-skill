import ExcelJS from './vendor/exceljs.cjs';
import { addSheet } from './export_excel.mjs';
import { dimensionsFor, reviewTotal, calibrationBackground, rubricVersion, promptHash } from './visual.mjs';
import { assetPlanHash } from './visual_v2.mjs';
import { ProjectError } from './project.mjs';

const joined = values => values.join('\n');
const bar = value => '█'.repeat(Math.round(value / 10)) + '░'.repeat(10 - Math.round(value / 10));
const assessment = review => review.rewrite.needed ? '建议重写；本次未执行' : '保留当前一稿';
const color = value => value >= 4 ? 'FFDDEDE1' : value >= 3 ? 'FFFFEEC2' : 'FFF8D9D5';

function readable(sheet, widths = {}) {
  for (const [key, width] of Object.entries(widths)) sheet.getColumn(Number(key)).width = width;
  sheet.eachRow((row, rowNumber) => {
    row.eachCell(cell => { cell.font = { ...cell.font, name: 'Microsoft YaHei' }; });
    if (rowNumber === 1) return;
    let lines = 2;
    row.eachCell(cell => {
      const width = sheet.getColumn(cell.col).width ?? 20;
      const text = String(cell.value ?? '');
      const count = text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil([...line].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0) / Math.max(8, width - 2))), 0);
      lines = Math.max(lines, count);
      if (rowNumber % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6F9' } };
    });
    row.height = Math.min(409, Math.max(42, lines * 15 + 12));
  });
  sheet.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1' };
  return sheet;
}

function scoreSheets(workbook, entries, version) {
  const dimensions = dimensionsFor(version), lastScore = dimensions.length + 3, firstNote = lastScore + 1;
  const summary = readable(addSheet(workbook, '评分总览', ['镜号／样本ID', 'Agent文本分（100）', '评分条', ...dimensions.map(([, label]) => label + '（5）'), '处理建议', '为什么高', '为什么低', '重写原因与执行状态'], entries.map(entry => [
    entry.id, reviewTotal(entry.review), bar(reviewTotal(entry.review)),
    ...dimensions.map(([key]) => entry.review.scores.find(item => item.dimension === key).score ?? 'N/A'),
    assessment(entry.review), joined(entry.review.strengths), joined(entry.review.weaknesses), entry.review.rewrite.reason + '\n实际重写：未执行'
  ])), { 1: 18, 2: 19, 3: 27, [firstNote]: 26, [firstNote + 1]: 52, [firstNote + 2]: 52, [firstNote + 3]: 58 });
  for (let col = 4; col <= lastScore; col++) summary.getColumn(col).width = dimensions[col - 4][0] === 'optics' ? 26 : 17;
  summary.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];
  if (entries.length) {
    summary.addConditionalFormatting({ ref: `B2:B${entries.length + 1}`, rules: [{ type: 'dataBar', minLength: 0, maxLength: 100, showValue: true, gradient: false, cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 100 }], color: { argb: 'FF65A9C2' } }] });
    summary.addConditionalFormatting({ ref: `D2:${summary.getColumn(lastScore).letter}${entries.length + 1}`, rules: [{ type: 'colorScale', cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 3 }, { type: 'num', value: 5 }], color: [{ argb: 'FFF4BCB5' }, { argb: 'FFFFE8AD' }, { argb: 'FFB7DEC2' }] }] });
    summary.eachRow((row, n) => { if (n > 1) for (let col = 4; col <= lastScore; col++) { const cell = row.getCell(col); if (typeof cell.value === 'number') cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color(cell.value) } }; } });
  }
  readable(addSheet(workbook, '评分依据', ['镜号／样本ID', '维度', '权重', 'Agent分（5）', 'Prompt原文证据', '得分或扣分理由', '评审者', '规则版本', 'Prompt哈希'], entries.flatMap(entry => entry.review.scores.map(score => [
    entry.id, dimensions.find(([key]) => key === score.dimension)[1], dimensions.find(([key]) => key === score.dimension)[2], score.score ?? 'N/A', score.evidence, score.reason, entry.review.reviewer, entry.review.rubricVersion, entry.review.promptHash
  ]))), { 1: 18, 2: 26, 3: 10, 4: 13, 5: 65, 6: 80, 7: 22, 8: 18, 9: 25 });
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

export function exportVisualMarkdown(plan, project, report = null) {
  const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const lines = [`# ${plan.title}`, '', `项目：${plan.projectId}；修订：${plan.revision ?? '未记录'}；${statusText(report?.status)}`, '',
    '总表中的采用来源不表示用户确认；程序检查不代替画面语义复核。', '',
    '| 镜号 | 秒数 | 当前方案ID | 采用来源 | 检查状态 |', '| --- | --- | --- | --- | --- |',
    ...plan.shots.map(shot => `| ${[shot.id, shot.seconds, shot.variantId, selectionText(shot), exportCheck(plan, shot, report).status].map(cell).join(' | ')} |`)];
  for (const shot of plan.shots) {
    const check = exportCheck(plan, shot, report);
    lines.push('', `## ${shot.id}`, '', `当前方案：${shot.variantId ?? '未记录'}；${selectionText(shot)}；${check.status}`, '',
      `原稿来源：${sourcePosition(project, shot).replace(/\n/g, '；')}`, '',
      ...check.issues.flatMap(issue => [issueText(issue), '']), '### 自然语言 Prompt', '', shot.prompt.text);
    if (plan.schemaVersion === 2 && shot.videoPrompt !== undefined) lines.push('', '### 视频 Prompt', '', shot.videoPrompt);
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
  const sourcePlanHash = plan.schemaVersion === 2 ? assetPlanHash(plan, 'locations') : promptHash(JSON.stringify(plan));
  if (bundle.schemaVersion !== 1 || bundle.projectId !== plan.projectId || bundle.sourcePlanHash !== sourcePlanHash) fail('场景Prompt与冻结项目版本不匹配，请核对后建立新版本');
  if (!Array.isArray(bundle.locations) || (plan.schemaVersion !== 2 && !bundle.locations.length)) fail('场景Prompt不能为空');
  const seen = new Set();
  for (const location of bundle.locations) {
    if (!plan.productionInventory.locations.some(asset => asset.id === location.assetId) || seen.has(location.assetId)) fail('场景Prompt资产不存在或重复');
    seen.add(location.assetId);
    const base = location.base;
    if (base?.mode !== 'generate' || typeof base.text !== 'string' || !base.text.trim() || typeof base.basis !== 'string' || !base.basis.trim()) fail(plan.schemaVersion === 2 ? '场景资产须有Prompt与依据' : '场景三视图须有生成Prompt与依据');
    if (!Array.isArray(base.referenceIds) || base.referenceIds.length) fail(plan.schemaVersion === 2 ? '新建场景资产不绑定未生成的参考' : '新建场景三视图不绑定未生成的参考');
  }
  if (plan.schemaVersion === 2 && plan.productionInventory.locations.some(asset => !seen.has(asset.id))) fail('场景Prompt须覆盖全部已登记场景');
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

export async function exportVisualExcel(plan, project, totalSeconds, manifest = null, report = null) {
  const version = plan.rubricVersion ?? rubricVersion, dimensions = dimensionsFor(version);
  const workbook = createWorkbook(plan.title);
  const v2 = plan.schemaVersion === 2 && plan.mode === 'visual-excel-v2';
  const generationState = shot => {
    if (shot.reuseOf) return `复用${shot.reuseOf}，不独立生成`;
    const task = manifest?.tasks.find(item => item.phase === 'storyboards' && item.targetId === shot.id);
    return task ? ({ planned: '未生成', submitted: '已提交，待结果', succeeded: '已生成', failed: '生成失败', unknown: '结果未知，待核对' }[task.status]) : '未生成';
  };
  const scores = v2 ? plan.shots.filter(shot => report?.shots.find(item => item.id === shot.id)?.scoreValid && currentReview(shot, version)) : plan.shots;
  if (v2) {
    const hasVideoPrompt = plan.shots.some(shot => shot.videoPrompt !== undefined);
    const summary = readable(addSheet(workbook, '分镜总表', ['镜号', '秒数', '当前方案ID', '采用来源', '项目修订', '检查状态', '检查问题与修改要求', '自然语言Prompt', ...(hasVideoPrompt ? ['视频Prompt'] : []), 'Agent文本分（100）', '评分状态', '原稿来源', '原稿画面', '画面目的', ...dimensions.map(([, label]) => label), '动作与剪辑安排', '复用画面', '实际生成', 'Prompt哈希'], plan.shots.map(shot => {
      const check = exportCheck(plan, shot, report), scored = scores.includes(shot);
      return [shot.id, shot.seconds, shot.variantId, selectionText(shot), plan.revision, check.status, check.issues.map(issueText).join('\n\n'), shot.prompt.text, ...(hasVideoPrompt ? [shot.videoPrompt ?? null] : []),
        scored ? reviewTotal(shot.review) : null, scored ? '有效文本评分' : shot.review ? '评分未验证或已失效，不计分' : '尚未评分',
        sourcePosition(project, shot), joined(shot.sourceShotIds.map(id => project.shots.find(item => item.id === id)?.original ?? `缺少原稿：${id}`)), shot.intent,
        ...dimensions.map(([key]) => shot.dimensions[key]), shot.motion, shot.reuseOf ?? '', generationState(shot), shot.prompt.textHash];
    })));
    summary.columns.forEach(column => { if (/^(自然语言Prompt|视频Prompt)/.test(column.header)) column.width = 112; });
    summary.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];
  }
  readable(addSheet(workbook, '阅读说明', ['项目', '内容'], [
    ['交付', plan.title + (v2 ? '；首表为当前分镜总表，默认每镜一案。采用与检查通过均不表示用户确认。' : '；每镜一个方案，自然正文保持冻结版本。')],
    ['总时长', `${totalSeconds}秒；${plan.spec.duration.basis}`],
    ['文本评分', `Agent按${dimensions.length}个画面维度给出0–5分，按权重折算100分；不适用项有理由并归一化。分数不是出图成功率，也不代表用户评分。${v2 ? '缺失、失效或未验证的评分不显示分数。' : ''}`],
    ['高低依据', '评分总览含色块和评分条；评分依据逐维给出对应Prompt原句及理由。低分不触发自动循环，重写建议与实际执行分开记录。'],
    ['生成与参考', '本表为冻结文本。若有生成清单，实际生成与用户确认状态以该清单为准；参考须来自本次附件或本项目生成且经用户确认的资产。'],
    ['人工校准', plan.calibration.length ? '单独的人工校准.xlsx可填写0–100总分和原因，尚未填写不推定用户标准。校准样本不替换正式分镜。' : '本次未要求人工校准，未另导出人工评分表，也没有代填用户评分。'],
    ['规则', version + '；评价画面信息、可读性和连续性，不评价商业任务或受众。']
  ]), { 1: 20, 2: 110 });
  if (!v2) {
    readable(addSheet(workbook, '分镜总表', ['镜号', '秒数', '原稿来源', '原稿画面', ...dimensions.map(([, label]) => label), '动作与剪辑安排', '复用画面'], plan.shots.map(shot => [
    shot.id, shot.seconds, joined(shot.sourceShotIds), joined(shot.sourceShotIds.map(id => project.shots.find(item => item.id === id).original)),
    ...dimensions.map(([key]) => shot.dimensions[key]), shot.motion, shot.reuseOf ?? ''
  ])), { 1: 15, 2: 10, 3: 18, 4: 55 });
  const prompts = readable(addSheet(workbook, '最终Prompt', ['镜号', '自然语言Prompt', 'Agent文本分（100）', '实际生成', 'Prompt哈希'], plan.shots.map(shot => [shot.id, shot.prompt.text, reviewTotal(shot.review), generationState(shot), shot.prompt.textHash])), { 1: 15, 2: 112, 3: 20, 4: 24, 5: 28 });
  prompts.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
  }
  scoreSheets(workbook, scores, version);
  readable(addSheet(workbook, '连续性', ['镜号', '前镜', '入镜状态', '出镜状态', '画面连接', '连续性核对', '复用画面'], plan.shots.map(shot => [shot.id, joined(shot.transition.fromShotIds), shot.transition.entry, shot.transition.exit, shot.transition.cut, shot.dimensions.continuity, shot.reuseOf ?? ''])), { 1: 15, 2: 18, 3: 60, 4: 60, 5: 60, 6: 60, 7: 18 });
  readable(addSheet(workbook, '本次设定', ['类型', '名称', '画面设定', '依据'], [
    ...plan.productionInventory.characters.map(item => ['角色', item.name, item.description, item.basis]),
    ...plan.productionInventory.locations.map(item => ['场景', item.name, item.description, item.basis]),
    ...plan.props.map(item => ['道具', item.name, item.description, '由本次画面规划登记']),
    ['风格', '全片', plan.spec.style, '本次目标'],
    ...plan.designNotes.map((note, index) => ['补全或调整', String(index + 1), note, '本次导演决定'])
  ]), { 1: 18, 2: 26, 3: 100, 4: 65 });

  const files = [{ filename: '画面分镜与评分.xlsx', buffer: Buffer.from(await workbook.xlsx.writeBuffer()) }];
  if (plan.calibration.length) {
    const calibration = createWorkbook(plan.title + ' · 人工校准');
    readable(addSheet(calibration, '填写说明', ['项目', '内容'], [
      ['填写位置', '在“人工评分”的黄色单元格填写用户总分（0–100）和原因；0分有效，可以只评部分样本。'],
      ['样本范围', `${plan.calibration.length}条单独校准文本；不作为正式拍法选择，不改变正式方案。`],
      ['评分对照', '评分总览和评分依据为Agent文本评审，供比较；用户未填写之前没有用户标准。'],
      ['高分要求', '人物、动作、持物、视线、空间、光影及跨镜状态明确；措辞自然且保留原稿事实。可在原因中指出最影响使用的具体句子。'],
      ['导入', '返回此文件后，只导入用户实际填写的总分和原因；冻结的ID、Prompt和背景不得修改。反馈独立保存，不自动改权重、不触发重新生成。'],
      ['证据边界', '本表评价文本，不评价未生成图像。比较样本属于开发校准，不能证明其他剧本的泛化质量。']
    ]), { 1: 20, 2: 112 });
    const sheet = readable(addSheet(calibration, '人工评分', ['样本ID', '关联镜号', '样本', '完整Prompt', '画面背景', '用户总分（0–100）', '用户原因', 'Prompt哈希', '来源哈希', '项目ID'], plan.calibration.map(sample => [
      sample.id, sample.shotId, sample.label, sample.text, calibrationBackground(plan, project, sample), null, null, sample.textHash, sample.sourceHash, plan.projectId
    ])), { 1: 16, 2: 15, 3: 18, 4: 108, 5: 85, 6: 22, 7: 65, 8: 25, 9: 25, 10: 25 });
    sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];
    const column = label => sheet.getRow(1).values.indexOf(label);
    for (let n = 2; n <= plan.calibration.length + 1; n++) {
      for (const label of ['用户总分（0–100）', '用户原因']) { const cell = sheet.getRow(n).getCell(column(label)); cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2B2' } }; cell.protection = { locked: false }; }
      sheet.getRow(n).getCell(column('用户总分（0–100）')).dataValidation = { type: 'decimal', operator: 'between', allowBlank: true, formulae: [0, 100], showErrorMessage: true, errorStyle: 'stop', errorTitle: '分数范围', error: '请填写0至100的数字。' };
    }
    for (const label of ['Prompt哈希', '来源哈希', '项目ID']) sheet.getColumn(column(label)).hidden = true;
    scoreSheets(calibration, v2 ? plan.calibration.filter(sample => currentReview(sample, version)) : plan.calibration, version);
    files.push({ filename: '人工校准.xlsx', buffer: Buffer.from(await calibration.xlsx.writeBuffer()) });
  }
  return files;
}
