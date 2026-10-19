import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from '../scripts/vendor/exceljs.cjs';
import { exportExcel } from '../scripts/export_excel.mjs';
import { ProjectError, composeStaticPrompt, cameraFields } from '../scripts/project.mjs';

function fixture() {
  const breakdown = { content: '儿子看手机\n画面保持完整', camera: Object.fromEntries(Object.keys(cameraFields).map((key, index) => [key, `摄影原值 ${index}`])), composition: '前中后景', lighting: '柔光', pose: '低头', characters: '儿子', scene: '卧室', texture: '织物纹理', decision: '独立取舍说明' };
  const variant = { id: 'A', title: '方案甲', version: 2, staticPrompt: '过期缓存不应导出', motionPrompt: 'HISTORICAL_MOTION_TEXT', breakdown, characterAssetIds: ['CHAR_001'], referenceIds: ['R001'], rationale: '独立设计理由', description: '独立方案说明', constraints: ['约束'], tags: ['写实'], promptNeedsSync: false, origin: 'director' };
  const section = (id, category, prompts, extra = {}) => ({ id, category, title: `${id} 内容`, version: 1, prompts: prompts.map(text => ({ label: `${text} 名称`, text })), shotIds: ['S001'], assetIds: [category === 'sceneViews' ? 'LOC_001' : 'CHAR_001'], tags: [], options: [], rationale: '独立内容理由', ...extra });
  return {
    schemaVersion: 1, revision: 5, title: '中文分镜：导出/样例', overview: '项目概览', promptMode: 'static', aspectRatio: '16:9', targetDuration: 40,
    brief: { purpose: '广告', deliverables: '分镜和静帧', resolution: '1920×1080', style: '写实生活喜剧' }, sharedConstraints: ['共享约束独立记录'], tags: ['生活'], tagOptions: [],
    shots: [
      { id: 'S001', sourceNumber: '0001', displayNumber: '001', suggestedDuration: 3.5, originalDuration: null, original: '导入画面\n第二行', workingScript: '=1+2\n中文工作稿', characters: ['儿子'], scene: '卧室', tags: [], purpose: '开场', variants: [variant, { ...variant, id: 'B', title: '方案乙', breakdown: undefined, staticPrompt: '@独立静态Prompt\n完整第二行', version: 1 }], selectedVariantId: 'A', approval: { variantId: 'A', variantVersion: 2, projectRevision: 5 }, status: 'approved', sourceRef: { sheet: '分镜脚本', numberCell: 'A3', contentCell: 'B3' }, originalFields: [{ name: '台词/旁白', value: '你好\n第二句', cell: 'C3' }, { name: '音乐/音效', value: '海浪声', cell: 'D3' }, { name: '备注', value: '备注原文', cell: 'E3' }] },
      { id: 'S002', sourceNumber: '0002', original: '尚无候选的镜头', suggestedDuration: 2, variants: [], sourceRef: { sheet: '分镜脚本', contentCell: 'B4' } }
    ],
    promptSections: [section('F001', 'shotFrames', ['补充静帧完整内容'], { variantId: 'A' }), section('SC001', 'sceneViews', ['场景正视', '场景侧视', '场景反面']), section('CV001', 'characterViews', ['人物正面', '人物侧面', '人物背面']), section('CH001', 'character', ['角色独立细节']), section('ST001', 'style', ['独立风格'])],
    productionInventory: { characters: [{ id: 'CHAR_001', name: '儿子', version: 3, face: '只用于资产的详细五官', description: '角色设定全文\n第二行', basis: '推荐方案', shotIds: ['S001'] }], locations: [{ id: 'LOC_001', name: '卧室', version: 1, layout: '布局', description: '场景设定全文', basis: '待核对', shotIds: ['S001'] }], notes: '资料备注' },
    references: [{ id: 'R001', label: '参考图', path: 'references/R001.png', url: 'https://example.org/reference.png', sha256: 'sha', width: 1920, height: 1080, sourceRef: { sheet: '参考', anchorCell: 'A1' }, assetIds: ['CHAR_001'], observations: '参考可见特征', usage: '仅核验', uncertainties: '未知', visualStatus: 'reviewed', role: 'character' }],
    comments: [{ id: 'C001', groupId: 'GROUP01', category: '范围批注', target: { kind: 'variant', shotId: 'S001', variantId: 'A', field: 'breakdown.content' }, contentVersion: 2, baseRevision: 4, originalText: '批注原值\n原值第二行', text: '用户批注全文', reply: '回应全文', before: '修改前全文', after: '修改后全文', status: 'addressed', at: '2026-10-13', addressedRevision: 5 }, { id: 'C002', shotId: 'S001', variantId: 'B', variantVersion: 1, text: '旧版方案批注', status: 'pending' }],
    source: { originalName: '原稿.xlsx', path: 'sources/source.xlsx', sha256: 'source-hash', sheets: [{ sheet: '分镜脚本', cells: { A3: { value: 1, type: 'n' }, B3: { value: '=SUM(1,2)', type: 'f' }, C3: { value: '中文\n源单元格', type: 's' } }, mergedRanges: ['A1:E1'] }], duplicates: [] },
    reviewIssues: [{ id: 'P01', text: '尚待确认', resolved: false }], generationRequests: [{ id: 'REQ001', category: 'production', shotId: 'S001', text: '请求全文', status: 'pending', baseRevision: 5 }],
    imageBatches: [{ id: 'BATCH001', status: 'stale', executionStatus: 'not_submitted', sourceRevision: 4, createdAt: '2026-10-13', quantityPerShot: 2, targetProject: '画布01', resolution: '1920×1080', aspectRatio: '16:9', items: [{ shotId: 'S001', variantId: 'A', variantVersion: 1, staticPrompt: '冻结原Prompt不变', constraints: ['冻结约束'], characterAssets: [{ id: 'CHAR_001', name: '儿子', version: 1 }], additionalFrames: [{ sectionId: 'F001', text: '冻结补帧原文', version: 1 }], references: [] }] }]
  };
}

async function read(project, date = new Date(2026, 9, 14)) {
  const output = await exportExcel(project, date);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(output.buffer);
  assert.equal(output.buffer.subarray(0, 2).toString(), 'PK');
  return { ...output, workbook };
}
const column = (sheet, name) => { let index; sheet.getRow(1).eachCell((cell, i) => { if (cell.value === name) index = i; }); assert.ok(index, name); return index; };
const value = (sheet, row, name) => sheet.getCell(row, column(sheet, name)).value;
const texts = workbook => workbook.worksheets.flatMap(sheet => { const result = []; sheet.eachRow(row => row.eachCell(cell => { if (typeof cell.value === 'string') result.push(cell.value); })); return result; });
const complete = () => {
  const project = fixture();
  project.shots[1].variants = [{ id: 'A', title: '第二镜选中', version: 1, staticPrompt: '第二镜的完整静帧 Prompt。' }];
  project.shots[1].selectedVariantId = 'A';
  return project;
};

test('all shots must have an actual saved choice; no approval is required', async () => {
  const project = fixture();
  await assert.rejects(exportExcel(project), error => error instanceof ProjectError && error.status === 422 && /未选镜号：0002/.test(error.message));
  await assert.rejects(exportExcel({ title: '空项目', shots: [] }), error => error.status === 422);
  await assert.rejects(exportExcel(null), error => error.status === 422);
  const selected = complete(); selected.shots[1].selectedVariantId = 'missing';
  await assert.rejects(exportExcel(selected), error => error.status === 422 && /未选镜号：0002/.test(error.message));
  await assert.rejects(exportExcel(complete(), new Date('invalid')), error => error.status === 422);
});

test('two sheets contain one selected overview and Prompt per shot, chosen frames and independent assets', async () => {
  const project = complete();
  project.promptSections.push({ ...structuredClone(project.promptSections[0]), id: 'F002', variantId: 'B', prompts: [{ label: '未选补帧', text: '未选方案的补帧不可导出' }] });
  const before = structuredClone(project);
  const { workbook, filename } = await read(project);
  assert.deepEqual(project, before);
  assert.equal(filename, '中文分镜：导出_样例-已选分镜-2026-10-14.xlsx');
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['分镜总览', '总共的Prompt']);
  const summary = workbook.getWorksheet('分镜总览'), prompts = workbook.getWorksheet('总共的Prompt');
  assert.equal(summary.rowCount - 1, 2);
  assert.equal(prompts.rowCount - 1, 11); // 2 main, 1 chosen frame, 3 scene, 3 character, 2 other
  assert.equal(value(summary, 2, '已选方案ID'), 'A');
  assert.equal(value(summary, 3, '已选方案ID'), 'A');
  assert.equal(value(summary, 2, '台词/旁白'), '你好\n第二句');
  assert.equal(value(summary, 2, '音乐/音效'), '海浪声');
  assert.equal(value(summary, 2, '导入原稿'), project.shots[0].original);
  assert.equal(value(prompts, 2, '静态Prompt'), composeStaticPrompt(project, project.shots[0].variants[0]));
  const allText = texts(workbook);
  for (const section of before.promptSections.filter(s => s.id !== 'F002')) for (const prompt of section.prompts) assert.ok(allText.includes(prompt.text), prompt.text);
  assert.ok(allText.includes('第二镜的完整静帧 Prompt。'));
  assert.ok(!allText.includes('@独立静态Prompt\n完整第二行'));
  assert.ok(!allText.includes('未选方案的补帧不可导出'));
  assert.ok(!allText.includes('HISTORICAL_MOTION_TEXT'));
  assert.equal(summary.views[0].ySplit, 1);
  assert.equal(summary.views[0].xSplit, 2);
  for (const sheet of workbook.worksheets) assert.ok(sheet.getCell('A2').alignment.wrapText);
});

test('a different selected alternative excludes the first choice and its frames; types and links survive', async () => {
  const project = complete(); project.shots[0].selectedVariantId = 'B';
  project.promptSections.push({ ...structuredClone(project.promptSections[0]), id: 'F002', variantId: 'B', prompts: [{ label: '当前补帧', text: '@选中方案的补帧\n第二行' }] });
  const { workbook } = await read(project);
  const values = texts(workbook), summary = workbook.getWorksheet('分镜总览'), prompts = workbook.getWorksheet('总共的Prompt');
  assert.equal(value(prompts, 2, '静态Prompt'), '@独立静态Prompt\n完整第二行');
  assert.ok(values.includes('@选中方案的补帧\n第二行'));
  assert.ok(!values.includes('补充静帧完整内容'));
  assert.ok(!values.includes(composeStaticPrompt(project, project.shots[0].variants[0])));
  assert.equal(value(summary, 2, '镜号'), '001');
  assert.equal(value(summary, 2, '原镜号'), '0001');
  assert.equal(value(summary, 2, '建议秒数'), 3.5);
  assert.equal(value(summary, 2, '脚本画面工作稿'), '=1+2\n中文工作稿');
  assert.equal(summary.getCell(2, column(summary, '脚本画面工作稿')).type, ExcelJS.ValueType.String);
  for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => assert.ok(![ExcelJS.ValueType.Formula, ExcelJS.ValueType.Hyperlink].includes(cell.type))));
  project.shots[0].selectedVariantId = 'A';
  const { workbook: linked } = await read(project);
  assert.match(value(linked.getWorksheet('分镜总览'), 2, '参考图路径／链接'), /references\/R001\.png/);
  assert.match(value(linked.getWorksheet('分镜总览'), 2, '参考图路径／链接'), /https:\/\/example\.org/);
});

test('long selected text, CRLF, emoji and formula-looking source remain intact and non-executable', async () => {
  const project = complete(); project.shots[0].selectedVariantId = 'B';
  const long = '中'.repeat(32766) + '😀' + '\r\n第二段\r' + '文'.repeat(34000) + '🙂结尾';
  project.shots[0].workingScript = '=SUM(1,2)\r\n中文\r下一行';
  project.shots[0].variants[1].staticPrompt = long;
  const { workbook } = await read(project), sheet = workbook.getWorksheet('总共的Prompt');
  const start = column(sheet, '静态Prompt');
  assert.equal([0, 1, 2].map(i => sheet.getCell(2, start + i).value).join(''), long.replace(/\r\n?/g, '\n'));
  assert.equal(value(workbook.getWorksheet('分镜总览'), 2, '脚本画面工作稿'), '=SUM(1,2)\n中文\n下一行');
  assert.equal(sheet.rowCount - 1, 10);
  assert.ok(sheet.getCell(2, start).value.length <= 32767);
  assert.equal(sheet.getCell(1, start + 1).value, '静态Prompt（续2）');
  project.shots[0].workingScript = '坏\u0000文字';
  await assert.rejects(exportExcel(project), error => error instanceof ProjectError && error.status === 422 && /XML/.test(error.message));
});
