import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ExcelJS from '../scripts/vendor/exceljs.cjs';
import { exportVisualExcel, exportVisualMarkdown, exportSceneExcel, validateCharacterBundle, validateSceneBundle } from '../scripts/export_visual_excel.mjs';
import { dimensionsFor, promptHash } from '../scripts/visual.mjs';
import { assetPlanHash } from '../scripts/visual_v2.mjs';

function fixture() {
  const text = '窗边，一人右手握着白杯，目光落在杯口。\n\n平视中景，脸和右手清楚；背景轻微虚化。';
  const shot = { id: 'V001', variantId: 'V001_DEFAULT', selection: { by: 'agent-default', reason: '本次默认一案' }, intent: '交代人物持杯的状态', seconds: 3,
    sourceShotIds: ['S001'], locationId: 'ROOM', dimensions: Object.fromEntries(dimensionsFor('visual-v2').map(([key]) => [key, '本镜可见信息'])),
    shotSchema: { referenceIds: [], subjects: [], props: [], relations: [] }, transition: { fromShotIds: [], entry: '杯在手中', exit: '仍持杯', cut: '开场' },
    motion: '站立持杯', reuseOf: null, prompt: { text, textHash: promptHash(text) }, review: null, semanticReview: null };
  const plan = { schemaVersion: 2, mode: 'visual-excel-v2', projectId: 'EXPORT_TEST', title: '新版导出隔离样例', revision: 2, rubricVersion: 'visual-v2',
    spec: { duration: { basis: '按动作估计' }, style: '写实' }, productionInventory: { characters: [], locations: [{ id: 'ROOM', name: '窗边', description: '白墙和窗', basis: '导演设定' }] },
    props: [], references: [], designNotes: [], shots: [shot], calibration: [] };
  const project = { source: { path: 'sources/原稿.xlsx', sha256: 'source-sha' }, shots: [{ id: 'S001', original: '一人拿杯子。', sourceRef: { sheet: '脚本', contentCell: 'B2' }, originalFields: [{ name: '台词/旁白', value: '他轻声说：“热的。”' }] }] };
  const report = { valid: false, status: 'pending', issues: [], shots: [{ id: shot.id, status: 'pending', issues: [], scoreValid: false }] };
  return { plan, project, report };
}

const issue = (entityId = 'V001') => ({ category: 'semantic', code: 'REVIEW_REQUIRED', path: '/shots/0/semanticReview', entityId, severity: 'pending', message: '尚未核对人物关系', requirement: '核对视线与道具归属并记录证据' });
const value = (sheet, label, row = 2) => sheet.getRow(row).getCell(sheet.getRow(1).values.indexOf(label)).value;
const textValue = cell => typeof cell === 'object' && cell ? cell.text : cell;
const allValues = workbook => workbook.worksheets.flatMap(sheet => sheet.getSheetValues().flatMap(row => row ?? []));
const safeLines = (text, width) => text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil([...line].reduce((units, char) => units + (char.codePointAt(0) > 255 ? 2 : 1), 0) / Math.max(8, (width - 2) * 0.75))), 0);
function completeParagraphRows(sheet, rows, original, column = 3) {
  const parts = rows.map(row => row.getCell(column).text);
  assert.equal(parts.join(''), original);
  let offset = 0;
  for (const [index, part] of parts.entries()) {
    offset += part.length;
    if (index < parts.length - 1) assert.equal(original[offset - 1], '\n', '续行只在原文换行后开始，不能截断完整段落');
    const lines = safeLines(part, sheet.getColumn(column).width);
    assert.ok(lines <= 20, '单行正文不超过保守可见行数');
    assert.ok(rows[index].height >= Math.max(54, lines * 18 + 18), '行高覆盖完整正文并保留字体行距');
    assert.ok(rows[index].height <= 409);
    assert.equal(rows[index].getCell(column).font.name, 'Microsoft YaHei');
    assert.equal(rows[index].getCell(column).font.size, 11);
  }
}
async function workbookOf(plan, project, report, context = {}) {
  const [result] = await exportVisualExcel(plan, project, 3, null, report, context);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(result.buffer); return workbook;
}
function score(shot) {
  return { promptHash: promptHash(shot.prompt.text), rubricVersion: 'visual-v2', reviewer: 'isolated-test',
    scores: dimensionsFor('visual-v2').map(([dimension]) => ({ dimension, score: 4, evidence: '一人', reason: '隔离程序测试' })),
    strengths: ['主语清楚'], weaknesses: ['待核对杯子方向'], rewrite: { needed: false, reason: '无需重写', executed: false } };
}

test('formal export has exactly three clear sheets with no internal records, hidden data or comments', async () => {
  const { plan, project, report } = fixture(), problem = issue(); report.issues.push(problem); report.shots[0].issues.push(problem); plan.shots[0].review = score(plan.shots[0]);
  const before = JSON.stringify(plan), workbook = await workbookOf(plan, project, report), summary = workbook.worksheets[0];
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['分镜脚本', '生成Prompt', '人物与场景']);
  assert.deepEqual(summary.getRow(1).values.slice(1), ['镜号', '起止时间', '时长（秒）', '场景与人物', '分镜图', '画面与动作', '对白与声音', '摄影与运镜', '衔接备注', '用户意见']);
  assert.equal(value(summary, '起止时间'), '00:00.0–00:03.0');
  assert.equal(value(summary, '对白与声音'), '他轻声说：“热的。”');
  assert.equal(value(summary, '分镜图'), '待补图');
  assert.equal(value(workbook.getWorksheet('生成Prompt'), '完整Prompt'), plan.shots[0].prompt.text);
  assert.match(JSON.stringify(allValues(workbook)), /窗边/);
  assert.doesNotMatch(JSON.stringify(allValues(workbook)), /评分|sha|hash|REVIEW_REQUIRED|V001_DEFAULT|isolated-test|项目修订|检查状态/i);
  workbook.eachSheet(sheet => {
    assert.equal(sheet.state, 'visible');
    assert.ok(sheet.columns.every(column => !column.hidden));
    sheet.eachRow(row => row.eachCell(cell => {
      assert.equal(cell.font.name, 'Microsoft YaHei'); assert.equal(cell.font.size, 11);
      assert.equal(cell.note, undefined);
    }));
    assert.equal(sheet.pageSetup.printTitlesRow, '1:1');
    assert.ok(sheet.autoFilter);
  });
  assert.equal(summary.views[0].xSplit, 1); assert.equal(summary.views[0].ySplit, 1);
  assert.deepEqual(summary.columns.map(column => column.width ?? 9), [9, 18, 10, 20, 35, 38, 28, 28, 30, 24]);
  assert.equal(summary.getCell('A2').value.hyperlink, "#'生成Prompt'!C2");
  assert.equal(workbook.getWorksheet('生成Prompt').getCell('B2').value.hyperlink, "#'分镜脚本'!A2");
  assert.equal(summary.getCell('J2').protection.locked, false);
  assert.equal(summary.getCell('J2').fill.fgColor.argb, 'FFFFF4CE');
  assert.equal(summary.sheetProtection.sheet, true);
  assert.equal(summary.sheetProtection.hashValue, undefined);
  assert.equal(JSON.stringify(plan), before);
});

test('Markdown preserves full score evidence and explicitly labels unverified and stale reviews', async () => {
  const { plan, project, report } = fixture(); plan.shots[0].review = score(plan.shots[0]);
  let log = exportVisualMarkdown(plan, project, report);
  assert.match(log, /评分未验证或已失效，不计分/); assert.doesNotMatch(log, /有效文本评分：80/);
  assert.match(log, /Prompt原文证据/); assert.match(log, /隔离程序测试/);
  assert.match(log, /主语清楚/); assert.match(log, /待核对杯子方向/); assert.match(log, /source-sha/);
  report.shots[0].scoreValid = true; log = exportVisualMarkdown(plan, project, report);
  assert.match(log, /有效文本评分：80 \/ 100/);
  plan.shots[0].review.promptHash = 'stale'; log = exportVisualMarkdown(plan, project, report);
  assert.match(log, /Prompt哈希：stale/); assert.doesNotMatch(log, /有效文本评分：80/);
  assert.ok(!JSON.stringify(allValues(await workbookOf(plan, project, report))).includes('stale'));
});

test('global validation issues stay in the log and missing report never claims a pass', async () => {
  const { plan, project, report } = fixture();
  report.issues.push({ ...issue(null), category: 'rules', code: 'RULES_STALE', path: '/rules', severity: 'error', message: '规则已变化', requirement: '重新读取规则并核对' });
  report.status = 'invalid';
  assert.match(exportVisualMarkdown(plan, project, report), /RULES_STALE[\s\S]*重新读取规则并核对/);
  assert.match(exportVisualMarkdown(plan, project), /未执行硬校验/);
  assert.doesNotMatch(JSON.stringify(allValues(await workbookOf(plan, project, report))), /RULES_STALE|规则已变化/);
});

test('literal Prompt prose including long continuations is preserved completely in its own sheet', async () => {
  const { plan, project, report } = fixture();
  const next = structuredClone(plan.shots[0]); next.id = 'V002'; next.prompt.text = '=正文_x0041_ | @\n\n' + Array.from({ length: 900 }, () => '长中文🙂'.repeat(8) + '完整段落。').join('\n\n') + '\n末句';
  plan.shots.push(next);
  const before = JSON.stringify(plan), workbook = await workbookOf(plan, project, report), prompts = workbook.getWorksheet('生成Prompt');
  const prose = prompts.getSheetValues().slice(2).filter(row => textValue(row?.[2]) === 'V002').map(row => row[3]).join('');
  assert.equal(prose, next.prompt.text);
  assert.ok(prompts.rowCount > 4);
  assert.ok(prompts.getSheetValues().slice(2).some(row => row?.[1]?.startsWith('静帧（续')));
  completeParagraphRows(prompts, prompts.getRows(2, prompts.rowCount - 1).filter(row => row.getCell(2).text === 'V002'), next.prompt.text);
  const log = exportVisualMarkdown(plan, project, report);
  assert.ok(log.includes('\n' + next.prompt.text + '\n'));
  assert.ok(log.indexOf('## V001') < log.indexOf('## V002'));
  assert.equal(JSON.stringify(plan), before);
});

test('SPA-style static, video, character and scene Prompts show complete paragraphs at 11pt', async () => {
  const { plan, project, report } = fixture();
  const paragraphs = [
    '午后的理疗房里，男子仰躺在按摩床上，头部靠近画面右侧，穿浅灰色棉质浴袍。按摩师站在床的远侧，双手只接触男子的小腿，保持手腕与前臂自然相连。',
    '按摩床沿长轴指向远墙，右后方的窄柜放叠好的毛巾和一只陶杯；入口到床尾保留连续通道，柜面用品不进入按摩师站立和移动的范围。',
    '从床尾斜侧的平视机位观察，男子面部、浴袍领口与按摩师双手保持清晰，背景墙面和窄柜稍微退后；主要人物轮廓不与柜上的陶杯重叠。',
    '按全画幅等效50mm、f/4设计，对焦男子面部与最近的按摩师双手。窗侧柔光照出棉布褶皱，木柜有细木纹，暖白哑光墙面保持均匀而克制的层次。',
    '按摩师先保持双手落在小腿上的姿势，随后缓慢向膝部推压，再回到原来的接触位置。男子的身体由床面支撑，头部和肩膀不突然偏移。',
    '镜头以稳定的小幅前推接近男子上半身，始终维持原来的观看方向。结束时停在面部与双手都能读清的位置，床边通道和后方窄柜继续保持原样。',
    '男子的短发自然贴合头部，眉眼放松，嘴唇微微闭合；按摩师穿素色短袖工作服，站姿稳定，不增加额外人物、手部或悬空肢体。',
    '房间的材质和布置在全段保持一致：毛巾叠在窄柜左侧，陶杯留在右侧，按摩床周围的地面畅通。只有剧情明确使用的毛巾可以移动，其他固定物件不改变位置。'
  ];
  const prose = Object.fromEntries(['静帧', '视频', '人物', '场景'].map(type => [type, `${type}完整正文。\n\n` + [...paragraphs, ...paragraphs].join('\n\n') + `\n\n${type}尾段：所有画面关系在此完整结束。`]));
  plan.shots[0].prompt.text = prose.静帧; plan.shots[0].videoPrompt = prose.视频;
  plan.productionInventory.characters.push({ id: 'THERAPIST', name: '按摩师', description: '素色短袖，站姿稳定。', basis: '软件回归样例' });
  const context = { characterBundle: { characters: [{ assetId: 'THERAPIST', base: { text: prose.人物 } }] }, sceneBundle: { locations: [{ assetId: 'ROOM', base: { text: prose.场景 } }] } };
  const workbook = await workbookOf(plan, project, report, context), prompts = workbook.getWorksheet('生成Prompt');
  for (const [type, original] of Object.entries(prose)) {
    const rows = prompts.getRows(2, prompts.rowCount - 1).filter(row => row.getCell(1).text.startsWith(type));
    assert.ok(rows.length > 1, `${type}覆盖实际长正文续行`);
    completeParagraphRows(prompts, rows, original);
  }
});

test('an oversized single paragraph is rejected instead of splitting words or hiding text', async () => {
  const tooLong = '保持按摩床、双手接触位置和人物轮廓完整。'.repeat(180);
  for (const type of ['静帧', '视频', '人物', '场景']) {
    const { plan, project, report } = fixture(), context = {};
    if (type === '静帧') plan.shots[0].prompt.text = tooLong;
    if (type === '视频') plan.shots[0].videoPrompt = tooLong;
    if (type === '人物') {
      plan.productionInventory.characters.push({ id: 'PERSON', name: '人物', description: '普通短发人物。', basis: '软件样例' });
      context.characterBundle = { characters: [{ assetId: 'PERSON', base: { text: tooLong } }] };
    }
    if (type === '场景') context.sceneBundle = { locations: [{ assetId: 'ROOM', base: { text: tooLong } }] };
    const before = JSON.stringify({ plan, context });
    await assert.rejects(exportVisualExcel(plan, project, 3, null, report, context), /完整段落[\s\S]*无法[\s\S]*显示/);
    assert.equal(JSON.stringify({ plan, context }), before, '拒绝导出时保留完整正文');
  }
});

test('calibration is explicit, preserves empty human inputs and never adds AI score sheets', async () => {
  const { plan, project, report } = fixture();
  plan.calibration.push({ id: 'C01', shotId: 'V001', label: '隔离样本', text: plan.shots[0].prompt.text, textHash: plan.shots[0].prompt.textHash, sourceHash: 'source-hash', review: null });
  assert.equal((await exportVisualExcel(plan, project, 3, null, report)).length, 1);
  const files = await exportVisualExcel(plan, project, 3, null, report, { calibration: true }), workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(files[1].buffer);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['填写说明', '人工评分']);
  assert.equal(value(workbook.getWorksheet('人工评分'), '用户总分（0–100）'), null);
  assert.equal(value(workbook.getWorksheet('人工评分'), '用户原因'), null);
});

test('workflow adds video planning, source dialogue, cumulative timing, asset Prompts and image reuse', async () => {
  const { plan, project, report } = fixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'three-sheet-images-'));
  const pngResult = spawnSync('python', ['-c', 'import struct,zlib,sys; chunk=lambda t,d:struct.pack(">I",len(d))+t+d+struct.pack(">I",zlib.crc32(t+d)&0xffffffff); sys.stdout.buffer.write(b"\\x89PNG\\r\\n\\x1a\\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",1672,941,8,2,0,0,0))+chunk(b"IDAT",zlib.compress((b"\\x00"+b"\\x7f\\x7f\\x7f"*1672)*941))+chunk(b"IEND",b""))']);
  assert.equal(pngResult.status, 0, pngResult.stderr.toString()); const png = pngResult.stdout;
  fs.writeFileSync(path.join(directory, '分镜.png'), png);
  const next = structuredClone(plan.shots[0]); next.id = 'V002'; next.reuseOf = 'V001'; plan.shots.push(next);
  plan.productionInventory.characters.push({ id: 'PERSON', name: '主角', description: '短发灰衫', basis: '导演设定' });
  plan.shots.forEach(shot => shot.shotSchema.subjects.push({ assetId: 'PERSON' }));
  const workflow = { title: '片名', revision: 1, sourcePlanHash: 'internal-only', images: [{ id: 'IMG', shotId: 'V001', path: '分镜.png', sha256: promptHash(png), review: { status: 'needs-change', reason: '杯口方向须与下一镜一致', reviewer: 'agent' } }],
    assetImages: [{ assetId: 'PERSON', path: '分镜.png', sha256: promptHash(png), description: '短发，灰衫，神态放松。' }],
    videoShots: [{ id: 'VIDEO', shotIds: ['V001', 'V002'], startState: '主角端杯站立。', action: '缓慢抬眼。', endState: '目光停在窗外。', camera: '镜头静止。', dialogue: '他说：“热的。”', sound: '轻微瓷杯声。', durationSeconds: 4, videoPrompt: '开始端杯，随后缓慢抬眼，最后看向窗外。' }],
    timeline: [{ shotId: 'V001', seconds: 4, description: '主角端杯，慢慢抬眼看向窗外。' }, { shotId: 'V002', seconds: 0 }], results: [{ status: 'not-generated', reason: '本轮仅规划' }] };
  const context = { directory, workflow, characterBundle: { characters: [{ assetId: 'PERSON', base: { text: '人物基础完整正文。' } }] }, sceneBundle: { locations: [{ assetId: 'ROOM', base: { text: '场景基础完整正文。' } }] } };
  const [file] = await exportVisualExcel(plan, project, 6, null, report, context);
  assert.equal(file.filename, '片名_分镜脚本.xlsx');
  const drawingCheck = spawnSync('python', ['-c', 'import io,sys,zipfile,xml.etree.ElementTree as ET; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); ns={"xdr":"http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"}; roots=[ET.fromstring(z.read(n)) for n in z.namelist() if n.startswith("xl/drawings/drawing") and n.endswith(".xml")]; anchors=[a for root in roots for a in root]; assert len(anchors)==3,len(anchors); assert all(a.tag.endswith("twoCellAnchor") and a.attrib=={"editAs":"oneCell"} for a in anchors),[a.attrib for a in anchors]; assert all(len(a.findall("xdr:pic",ns))==1 for a in anchors); assert all((e.text or "").isdigit() for root in roots for e in root.iter() if e.tag.rsplit("}",1)[-1] in ("colOff","rowOff"))'], { input: file.buffer, encoding: 'utf8' });
  assert.equal(drawingCheck.status, 0, drawingCheck.error?.message ?? drawingCheck.stderr);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(file.buffer);
  const summary = workbook.getWorksheet('分镜脚本'), prompts = workbook.getWorksheet('生成Prompt');
  assert.equal(value(summary, '起止时间', 3), '00:04.0–00:04.0');
  assert.equal(value(summary, '时长（秒）', 3), 0);
  assert.equal(value(summary, '画面与动作'), '主角端杯，慢慢抬眼看向窗外。');
  assert.match(value(summary, '对白与声音'), /热的[\s\S]*瓷杯声/);
  assert.equal(value(summary, '摄影与运镜'), '镜头静止。\n本镜可见信息');
  assert.equal(value(summary, '衔接备注'), '参考图待修正，详见制作日志');
  assert.match(value(summary, '衔接备注', 3), /复用 V001/);
  assert.equal(summary.getImages().length, 2);
  const image = summary.getImages()[0], width = image.range.br.nativeColOff - image.range.tl.nativeColOff, height = image.range.br.nativeRowOff - image.range.tl.nativeRowOff;
  assert.equal(width, 240 * 9525); assert.equal(height, Math.round(240 * 941 / 1672 * 9525));
  assert.match(value(summary, '分镜图').hyperlink, /%E5%88%86%E9%95%9C\.png$/);
  assert.equal(workbook.getWorksheet('人物与场景').getImages().length, 1);
  assert.equal(value(workbook.getWorksheet('人物与场景'), '造型或空间设定'), '短发，灰衫，神态放松。');
  assert.equal(prompts.getSheetValues().filter(row => row?.[1] === '视频').length, 1);
  assert.ok(allValues(workbook).includes('人物基础完整正文。')); assert.ok(allValues(workbook).includes('场景基础完整正文。'));
  const log = exportVisualMarkdown(plan, project, report, { ...context, manifest: { tasks: [{ status: 'failed', error: 'S10 generation failed' }] } });
  assert.match(log, /internal-only/); assert.match(log, /本轮仅规划/); assert.match(log, /S10 generation failed/);
  assert.match(log, /杯口方向须与下一镜一致/);
  workflow.images[0].productionNote = '杯口朝向需与下一镜相同。';
  const cleaned = await workbookOf(plan, project, report, context);
  assert.equal(value(cleaned.getWorksheet('分镜脚本'), '衔接备注'), '杯口朝向需与下一镜相同。');
  assert.doesNotMatch(JSON.stringify(allValues(workbook)), /internal-only|generation failed|not-generated/);
  const changed = structuredClone(workflow); changed.images[0].sha256 = 'stale';
  await assert.rejects(exportVisualExcel(plan, project, 6, null, report, { ...context, workflow: changed }), /图片哈希已变化/);
  const unsafe = structuredClone(workflow), outside = directory + '-outside.png'; unsafe.images[0].path = outside; fs.writeFileSync(outside, png);
  await assert.rejects(exportVisualExcel(plan, project, 6, null, report, { ...context, workflow: unsafe }), /项目目录内/);
  fs.unlinkSync(outside);
  fs.unlinkSync(path.join(directory, '分镜.png'));
  fs.rmdirSync(directory);
});

test('optional video prose stays separate and static text stays byte for byte', async () => {
  const { plan, project, report } = fixture(); plan.shots[0].videoPrompt = '人物保持握杯姿势，镜头缓缓向前推进。\n\n窗侧柔光保持不变，最后停在脸与杯子的近景。';
  const next = structuredClone(plan.shots[0]); next.id = 'V002'; delete next.videoPrompt; plan.shots.push(next);
  const workbook = await workbookOf(plan, project, report), prompts = workbook.getWorksheet('生成Prompt');
  assert.equal(value(prompts, '完整Prompt'), plan.shots[0].prompt.text);
  assert.equal(value(prompts, '完整Prompt', 3), plan.shots[0].videoPrompt);
  assert.equal(value(prompts, '类型', 3), '视频');
  assert.equal(value(prompts, '类型', 4), '静帧');
  assert.equal(exportVisualMarkdown(plan, project, report).match(/### 视频 Prompt/g).length, 1);
});

test('v2 asset bundles survive score revisions but reject changed assets; v1 keeps full-plan binding', () => {
  const { plan } = fixture();
  plan.productionInventory.characters.push({ id: 'PERSON', name: '人物', description: '短发灰衫', basis: '导演设定' });
  for (const [type, validate, assetId] of [['characters', validateCharacterBundle, 'PERSON'], ['locations', validateSceneBundle, 'ROOM']]) {
    const bundle = { schemaVersion: 1, projectId: plan.projectId, sourcePlanHash: assetPlanHash(plan, type),
      [type]: [{ assetId, base: { mode: 'generate', text: '可见的本次资产设定。', referenceIds: [], basis: '本次导演设定' }, ...(type === 'characters' ? { optionalDetails: [] } : {}) }] };
    assert.equal(validate(bundle, plan), bundle);
    assert.throws(() => validate({ ...bundle, [type]: [] }, plan), /须覆盖全部/);
    const missing = structuredClone(plan); missing.productionInventory[type].push({ ...missing.productionInventory[type][0], id: 'ANOTHER' });
    assert.throws(() => validate({ ...bundle, sourcePlanHash: assetPlanHash(missing, type) }, missing), /须覆盖全部/);
    const scored = structuredClone(plan); scored.revision++; scored.shots[0].review = score(scored.shots[0]);
    assert.equal(validate(bundle, scored), bundle);
    const changed = structuredClone(plan); changed.productionInventory[type][0].description = '改变资产外观';
    assert.throws(() => validate(bundle, changed), /版本不匹配/);
    const legacy = { ...plan, schemaVersion: 1, mode: 'visual-excel-v1' };
    const legacyBundle = { ...bundle, sourcePlanHash: promptHash(JSON.stringify(legacy)) };
    assert.equal(validate(legacyBundle, legacy), legacyBundle);
    assert.throws(() => validate(legacyBundle, { ...legacy, revision: legacy.revision + 1 }), /版本不匹配/);
    const legacyExtra = structuredClone(legacy); legacyExtra.productionInventory[type].push({ ...legacyExtra.productionInventory[type][0], id: 'ANOTHER' });
    assert.equal(validate({ ...legacyBundle, sourcePlanHash: promptHash(JSON.stringify(legacyExtra)) }, legacyExtra)[type].length, 1);
    if (type === 'characters') {
      for (const mode of ['not-required', 'blocked']) {
        const explicit = structuredClone(bundle); explicit.characters[0].base.mode = mode; explicit.characters[0].base.text = '';
        assert.equal(validate(explicit, plan), explicit);
      }
      const empty = structuredClone(plan); empty.productionInventory.characters = [];
      const emptyBundle = { ...bundle, characters: [], sourcePlanHash: assetPlanHash(empty, type) };
      assert.equal(validate(emptyBundle, empty), emptyBundle);
      const emptyLegacy = { ...empty, schemaVersion: 1, mode: 'visual-excel-v1' };
      assert.throws(() => validate({ ...emptyBundle, sourcePlanHash: promptHash(JSON.stringify(emptyLegacy)) }, emptyLegacy), /不能为空/);
    }
  }
});

test('v2 scene assets use neutral labels and independent-view guidance while v1 keeps triptych labels', async () => {
  const { plan } = fixture();
  const sceneText = '平视观察窗边的空房间，白墙和木桌清晰可见。';
  for (const version of [2, 1]) {
    const current = { ...plan, schemaVersion: version, mode: version === 2 ? 'visual-excel-v2' : 'visual-excel-v1' };
    const bundle = { schemaVersion: 1, projectId: current.projectId, sourcePlanHash: version === 2 ? assetPlanHash(current, 'locations') : promptHash(JSON.stringify(current)),
      locations: [{ assetId: 'ROOM', base: { mode: 'generate', text: sceneText, basis: '本次空间设定', referenceIds: [] } }] };
    const result = await exportSceneExcel(bundle, current), workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(result.buffer);
    const label = version === 2 ? '场景资产Prompt' : '场景三视图Prompt';
    assert.equal(value(workbook.getWorksheet(label), label), sceneText);
    const explanation = workbook.getWorksheet('使用说明').getCell('B2').value;
    assert.match(explanation, version === 2 ? /每机位一张独立16:9/ : /三个互补机位的三联图/);
    if (version === 2) assert.ok(!explanation.includes('三联图'));
  }
});
