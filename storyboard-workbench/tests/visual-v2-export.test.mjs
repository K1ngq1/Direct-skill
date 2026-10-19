import test from 'node:test';
import assert from 'node:assert/strict';
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
  const project = { shots: [{ id: 'S001', original: '一人拿杯子。', sourceRef: { sheet: '脚本', contentCell: 'B2' } }] };
  const report = { valid: false, status: 'pending', issues: [], shots: [{ id: shot.id, status: 'pending', issues: [], scoreValid: false }] };
  return { plan, project, report };
}

const issue = (entityId = 'V001') => ({ category: 'semantic', code: 'REVIEW_REQUIRED', path: '/shots/0/semanticReview', entityId, severity: 'pending', message: '尚未核对人物关系', requirement: '核对视线与道具归属并记录证据' });
const value = (sheet, label, row = 2) => sheet.getRow(row).getCell(sheet.getRow(1).values.indexOf(label)).value;
async function workbookOf(plan, project, report) {
  const [result] = await exportVisualExcel(plan, project, 3, null, report);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result.buffer);
  return workbook;
}
function score(shot) {
  return { promptHash: promptHash(shot.prompt.text), rubricVersion: 'visual-v2', reviewer: 'isolated-test',
    scores: dimensionsFor('visual-v2').map(([dimension]) => ({ dimension, score: 4, evidence: '一人', reason: '隔离程序测试' })),
    strengths: ['主语清楚'], weaknesses: [], rewrite: { needed: false, reason: '无需重写', executed: false } };
}

test('v2 makes the complete current storyboard the first sheet and labels pending content', async () => {
  const { plan, project, report } = fixture(), problem = issue();
  report.issues.push(problem); report.shots[0].issues.push(problem);
  const original = JSON.stringify(plan), workbook = await workbookOf(plan, project, report), summary = workbook.worksheets[0];
  assert.equal(summary.name, '分镜总表');
  assert.equal(workbook.getWorksheet('最终Prompt'), undefined);
  assert.equal(value(summary, '自然语言Prompt'), plan.shots[0].prompt.text);
  assert.ok(!summary.getRow(1).values.includes('视频Prompt'));
  assert.ok(!exportVisualMarkdown(plan, project, report).includes('### 视频 Prompt'));
  assert.equal(value(summary, '当前方案ID'), 'V001_DEFAULT');
  assert.equal(value(summary, '采用来源'), 'Agent默认方案');
  assert.equal(value(summary, '项目修订'), 2);
  assert.equal(value(summary, '检查状态'), '待处理');
  assert.match(value(summary, '检查问题与修改要求'), /REVIEW_REQUIRED.*\/shots\/0\/semanticReview[\s\S]*核对视线/);
  assert.match(value(summary, '原稿来源'), /S001 · 脚本 · B2/);
  assert.equal(value(summary, '画面目的'), plan.shots[0].intent);
  assert.ok(summary.getRow(1).values.includes('摄影约束（焦距、光圈与对焦）'));
  assert.equal(value(summary, 'Agent文本分（100）'), null);
  assert.equal(value(summary, '评分状态'), '尚未评分');
  assert.equal(workbook.getWorksheet('评分总览').rowCount, 1);
  assert.equal(JSON.stringify(plan), original);
});

test('v2 report and current review must both permit displaying a score', async () => {
  const { plan, project, report } = fixture(), shot = plan.shots[0];
  shot.review = score(shot);
  let workbook = await workbookOf(plan, project, report);
  assert.equal(value(workbook.worksheets[0], 'Agent文本分（100）'), null);
  report.shots[0].scoreValid = true;
  workbook = await workbookOf(plan, project, report);
  assert.equal(value(workbook.worksheets[0], 'Agent文本分（100）'), 80);
  assert.equal(workbook.getWorksheet('评分总览').getCell('B2').value, 80);
  assert.equal(workbook.getWorksheet('评分依据').rowCount, 12);
  shot.review.promptHash = 'stale';
  workbook = await workbookOf(plan, project, report);
  assert.equal(value(workbook.worksheets[0], 'Agent文本分（100）'), null);
  assert.match(value(workbook.worksheets[0], '评分状态'), /失效/);
  assert.equal(workbook.getWorksheet('评分总览').rowCount, 1);
});

test('v2 global failures are visible on every row and missing report never claims a pass', async () => {
  const { plan, project, report } = fixture(), problem = { ...issue(null), category: 'rules', code: 'RULES_STALE', path: '/rules', severity: 'error', message: '规则已变化', requirement: '重新读取规则并核对' };
  report.issues.push(problem); report.status = 'invalid'; report.shots[0].status = 'passed';
  let workbook = await workbookOf(plan, project, report);
  assert.equal(value(workbook.worksheets[0], '检查状态'), '检查未通过');
  assert.match(value(workbook.worksheets[0], '检查问题与修改要求'), /RULES_STALE/);
  workbook = await workbookOf(plan, project, null);
  assert.equal(value(workbook.worksheets[0], '检查状态'), '未执行硬校验');
  assert.match(exportVisualMarkdown(plan, project), /未执行硬校验/);
});

test('Markdown keeps current selected prose and order byte for byte without field concatenation', async () => {
  const { plan, project, report } = fixture();
  const next = structuredClone(plan.shots[0]);
  next.id = 'V002'; next.variantId = 'V002_ALTERNATE'; next.selection.by = 'user'; next.prompt.text = '另一人的静帧。\n\n画面中有符号 | 和 @，正文逐字保留。';
  plan.shots.push(next); report.shots.push({ id: next.id, status: 'pending', scoreValid: false, issues: [] });
  const original = JSON.stringify(plan), markdown = exportVisualMarkdown(plan, project, report);
  assert.ok(markdown.includes('\n' + plan.shots[0].prompt.text + '\n'));
  assert.ok(markdown.includes('\n' + next.prompt.text + '\n'));
  assert.ok(markdown.indexOf('## V001') < markdown.indexOf('## V002'));
  assert.match(markdown, /V002_ALTERNATE.*用户选择/);
  const workbook = await workbookOf(plan, project, report);
  assert.equal(value(workbook.worksheets[0], '自然语言Prompt', 3), next.prompt.text);
  assert.equal(value(workbook.worksheets[0], '采用来源', 3), '用户选择');
  assert.equal(JSON.stringify(plan), original);
});

test('v2 nullable calibration reviews keep human inputs blank and do not claim Agent scores', async () => {
  const { plan, project, report } = fixture();
  plan.calibration.push({ id: 'C01', shotId: 'V001', label: '隔离样本', text: plan.shots[0].prompt.text, textHash: plan.shots[0].prompt.textHash, sourceHash: 'source-hash', review: null });
  const files = await exportVisualExcel(plan, project, 3, null, report), calibration = new ExcelJS.Workbook();
  await calibration.xlsx.load(files[1].buffer);
  assert.equal(calibration.getWorksheet('评分总览').rowCount, 1);
  assert.equal(value(calibration.getWorksheet('人工评分'), '用户总分（0–100）'), null);
  assert.equal(value(calibration.getWorksheet('人工评分'), '用户原因'), null);
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

test('optional video prose is exported separately without substituting motion or changing static prose', async () => {
  const { plan, project, report } = fixture();
  plan.shots[0].videoPrompt = '人物保持握杯姿势，镜头缓缓向前推进。\n\n窗侧柔光保持不变，最后停在脸与杯子的近景。';
  const next = structuredClone(plan.shots[0]); next.id = 'V002'; delete next.videoPrompt; plan.shots.push(next);
  report.shots.push({ ...report.shots[0], id: next.id });
  const original = JSON.stringify(plan), workbook = await workbookOf(plan, project, report), summary = workbook.worksheets[0];
  assert.equal(value(summary, '自然语言Prompt'), plan.shots[0].prompt.text);
  assert.equal(value(summary, '视频Prompt'), plan.shots[0].videoPrompt);
  assert.equal(value(summary, '视频Prompt', 3), null);
  assert.equal(value(summary, '动作与剪辑安排'), plan.shots[0].motion);
  assert.equal(summary.getRow(2).getCell(summary.getRow(1).values.indexOf('视频Prompt')).font.name, 'Microsoft YaHei');
  const markdown = exportVisualMarkdown(plan, project, report);
  assert.ok(markdown.includes('\n' + plan.shots[0].videoPrompt + '\n'));
  assert.equal(markdown.match(/### 视频 Prompt/g).length, 1);
  assert.equal(JSON.stringify(plan), original);
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
