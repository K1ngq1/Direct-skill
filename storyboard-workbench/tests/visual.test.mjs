import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ExcelJS from '../scripts/vendor/exceljs.cjs';
import { exportCharacterExcel } from '../scripts/export_visual_excel.mjs';
import { sealPlan, validateVisualPlan, exportVisualProject, importFeedback, promptHash, dimensions, dimensionsFor, currentRubricVersion, reviewTotal } from '../scripts/visual.mjs';

const save = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
const review = text => ({ promptHash: promptHash(text), reviewer: 'test-reviewer', rubricVersion: 'visual-v1', scores: dimensions.map(([dimension]) => ({ dimension, score: 4, evidence: '一人', reason: '测试评分证据。' })), strengths: ['主体明确'], weaknesses: ['仅文本校验'], rewrite: { needed: false, reason: '保留当前一稿。', executed: false } });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-contract-'));
  fs.mkdirSync(path.join(directory, 'sources'));
  const source = Buffer.from('isolated-source-bytes');
  fs.writeFileSync(path.join(directory, 'sources/source.xlsx'), source);
  const project = { title: '隔离样例', source: { path: 'sources/source.xlsx', sha256: promptHash(source), sheets: [] }, shots: [{ id: 'S001', original: '一人拿杯子。', sourceNumber: '1', sourceRef: { sheet: '脚本', contentCell: 'B2' }, originalFields: [], originalDuration: null }], references: [] };
  save(path.join(directory, 'project.json'), project);
  const text = '一人站在桌边，右手拿着杯子，目光落在杯口。\n平视中景，窗边柔光照亮脸和双手。';
  const shot = { id: 'V001', sourceShotIds: ['S001'], locationId: 'ROOM', seconds: 3, dimensions: Object.fromEntries(dimensions.map(([key]) => [key, '一人拿杯，平视中景。'])),
    shotSchema: { referenceIds: [], subjects: [{ assetId: 'PERSON', referenceIds: [], appearance: '短发', clothing: '灰衫', pose: '站立' }], props: [{ id: 'CUP', name: '杯子', holderAssetIds: ['PERSON'], referenceIds: [], position: '右手', state: '握住' }], relations: [] },
    transition: { fromShotIds: [], entry: '站在桌边', exit: '杯子仍在右手', cut: '开场' }, motion: '站立持杯。', reuseOf: null, prompt: { text }, review: null };
  const plan = { schemaVersion: 1, mode: 'visual-excel-v1', title: '隔离样例', spec: { aspectRatio: '16:9', resolution: '1920×1080', style: '写实', duration: { mode: 'estimate', basis: '按动作估计' } }, productionInventory: { characters: [{ id: 'PERSON', name: '人物', description: '短发灰衫', basis: '本次提案' }], locations: [{ id: 'ROOM', name: '房间', description: '窗边桌子', basis: '本次提案' }] }, props: [{ id: 'CUP', name: '杯子', description: '白色杯子' }], references: [], designNotes: ['以动作估计时长'], shots: [shot], calibration: [{ id: 'C01', shotId: 'V001', label: '样本A', text, review: null }] };
  return { directory, project, plan };
}
function complete() {
  const fixtureValue = fixture();
  const plan = sealPlan(fixtureValue.directory, fixtureValue.plan);
  plan.shots.forEach(shot => { shot.review = review(shot.prompt.text); });
  plan.calibration.forEach(sample => { sample.review = review(sample.text); });
  save(path.join(fixtureValue.directory, 'visual-plan.json'), plan);
  return { ...fixtureValue, plan };
}

const characterBundle = plan => ({
  schemaVersion: 1, projectId: plan.projectId, sourcePlanHash: promptHash(JSON.stringify(plan)),
  characters: [{ assetId: 'PERSON', base: { mode: 'generate', text: '短发灰衫的人正面站立，表情平静，浅灰背景，脸和发际清楚。', referenceIds: [], basis: '沿用本次短发灰衫设定，正面人物参考图。' },
    optionalDetails: [{ id: 'LEFT_CHEEK_MOLE', description: '人物自身左脸颊一颗小痣，未采用', template: '以{{characterReference}}为基础，仅在人物自身左脸颊增加一颗小痣，其余保持原图。', state: 'dormant', requiresUserRequest: true }] }]
});

test('character assets export separately; dormant details never enter base or shot Prompts', async () => {
  const { directory, plan } = complete(), before = fs.readFileSync(path.join(directory, 'visual-plan.json'));
  const bundle = characterBundle(plan); save(path.join(directory, 'character-prompts.json'), bundle);
  const files = await exportVisualProject(directory);
  assert.equal(files.length, 3);
  const characters = new ExcelJS.Workbook(); await characters.xlsx.load(fs.readFileSync(files[2]));
  assert.equal(characters.getWorksheet('基础人物Prompt').getCell('D2').value, bundle.characters[0].base.text);
  assert.equal(characters.getWorksheet('基础人物Prompt').getCell('E2').value, null);
  assert.equal(characters.getWorksheet('可选细节编辑Prompt').getCell('E2').value, bundle.characters[0].optionalDetails[0].template);
  for (const filename of files.slice(0, 2)) {
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(fs.readFileSync(filename));
    workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => {
      assert.ok(!String(cell.value).includes('LEFT_CHEEK_MOLE'));
      assert.ok(!String(cell.value).includes('人物自身左脸颊增加一颗小痣'));
    })));
  }
  assert.deepEqual(fs.readFileSync(path.join(directory, 'visual-plan.json')), before);
  assert.equal(validateVisualPlan(directory).plan.shots[0].prompt.text, plan.shots[0].prompt.text);
});

test('character export rejects stale versions, wrong assets, unbound images and active subjective details', async () => {
  const { plan } = complete();
  for (const [change, message] of [
    [bundle => { bundle.sourcePlanHash = 'outdated'; }, /版本不匹配/],
    [bundle => { bundle.characters[0].assetId = 'UNKNOWN'; }, /资产不存在/],
    [bundle => { bundle.characters[0].base.mode = 'reuse'; bundle.characters[0].base.text = ''; bundle.characters[0].base.referenceIds = ['SCENE_OR_OTHER_PERSON']; }, /必须绑定到该角色/],
    [bundle => { bundle.characters[0].optionalDetails[0].state = 'active'; }, /必须保持未启用/],
    [bundle => { bundle.characters[0].optionalDetails[0].requiresUserRequest = false; }, /必须保持未启用/],
    [bundle => { bundle.characters[0].optionalDetails[0].template = '@不存在的图片，添加小痣'; }, /待绑定/]
  ]) {
    const bundle = characterBundle(plan); change(bundle);
    await assert.rejects(exportCharacterExcel(bundle, plan), message);
  }
});

test('character-only CLI creates one workbook and preserves existing human scores and exports', () => {
  const { directory, plan } = complete();
  save(path.join(directory, 'character-prompts.json'), characterBundle(plan));
  const exports = path.join(directory, 'exports'); fs.mkdirSync(exports);
  const ratings = path.join(exports, '人工校准.xlsx'), original = Buffer.from('user-owned-rating-file'); fs.writeFileSync(ratings, original);
  const cli = fileURLToPath(new URL('../scripts/visual.mjs', import.meta.url));
  const run = () => spawnSync(process.execPath, [cli, 'export-characters', directory], { encoding: 'utf8', timeout: 15000 });
  const result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).files.length, 1);
  assert.deepEqual(fs.readFileSync(ratings), original);
  assert.equal(fs.existsSync(path.join(exports, '画面分镜与评分.xlsx')), false);
  const target = path.join(exports, '人物资产Prompt.xlsx'), first = fs.readFileSync(target);
  assert.notEqual(run().status, 0); assert.deepEqual(fs.readFileSync(target), first);
});

test('seal is explicit, first-write-only and leaves source and natural Prompt intact', () => {
  const { directory, plan } = fixture(), original = fs.readFileSync(path.join(directory, 'project.json'));
  const sealed = sealPlan(directory, plan);
  assert.equal(sealed.shots[0].prompt.text, plan.shots[0].prompt.text);
  assert.match(sealed.shots[0].prompt.textHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'project.json')), original);
  assert.throws(() => sealPlan(directory, plan), /已存在/);
  assert.throws(() => validateVisualPlan(directory), /缺少评审/);
  assert.equal(validateVisualPlan(directory, sealed, { requireReview: false }).totalSeconds, 3);
});

test('fresh CLI processes seal, validate and export without circular top-level-await deadlock', () => {
  const { directory, plan } = fixture();
  plan.shots[0].review = review(plan.shots[0].prompt.text);
  plan.calibration[0].review = review(plan.calibration[0].text);
  const input = path.join(directory, 'input-plan.json'); save(input, plan);
  const cli = fileURLToPath(new URL('../scripts/visual.mjs', import.meta.url));
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.equal(result.signal, null);
    return JSON.parse(result.stdout);
  };
  assert.equal(run('seal', directory, input).status, 'sealed');
  assert.equal(run('validate', directory).status, 'valid');
  const output = run('export', directory);
  assert.equal(output.files.length, 2);
  for (const filename of output.files) assert.equal(fs.readFileSync(filename).subarray(0, 2).toString(), 'PK');
});

test('source bytes, archived facts, structure and frozen prose changes are all detected', () => {
  const { directory, plan, project } = complete();
  const changed = structuredClone(plan); changed.shots[0].prompt.text += '新增剧情';
  assert.throws(() => validateVisualPlan(directory, changed), /冻结失效/);
  const schema = structuredClone(plan); schema.shots[0].dimensions.lighting = '改成夜晚';
  assert.throws(() => validateVisualPlan(directory, schema), /冻结失效/);
  project.shots[0].original = '更改原稿'; save(path.join(directory, 'project.json'), project);
  assert.throws(() => validateVisualPlan(directory), /冻结失效/);
  fs.appendFileSync(path.join(directory, 'sources/source.xlsx'), 'tampered');
  assert.throws(() => validateVisualPlan(directory), /原件哈希/);
});

test('source coverage, holders, future transitions and reused-frame identity are validated', () => {
  const { directory, plan } = fixture();
  const prepare = data => { data.projectId = 'fixture'; data.sourceSha256 = JSON.parse(fs.readFileSync(path.join(directory, 'project.json'))).source.sha256; return data; };
  let changed = prepare(structuredClone(plan)); changed.shots[0].sourceShotIds = ['S999'];
  assert.throws(() => validateVisualPlan(directory, changed, { sealed: false, requireReview: false }), /原稿镜号/);
  changed = prepare(structuredClone(plan)); changed.shots[0].shotSchema.props[0].holderAssetIds = ['UNKNOWN'];
  assert.throws(() => validateVisualPlan(directory, changed, { sealed: false, requireReview: false }), /持有者/);
  changed = prepare(structuredClone(plan)); changed.shots[0].transition.fromShotIds = ['V002'];
  assert.throws(() => validateVisualPlan(directory, changed, { sealed: false, requireReview: false }), /前镜依赖/);
  changed = prepare(structuredClone(plan)); changed.shots.push({ ...structuredClone(changed.shots[0]), id: 'V002', reuseOf: 'V001', prompt: { text: '另一个新画面' } });
  assert.throws(() => validateVisualPlan(directory, changed, { sealed: false, requireReview: false }), /复用帧/);
});

test('duration supports exact, max and range without a fixed ninety-second default', () => {
  const { directory, plan } = complete();
  for (const duration of [{ mode: 'exact', seconds: 3 }, { mode: 'max', seconds: 4 }, { mode: 'range', min: 2, max: 4 }]) {
    const changed = structuredClone(plan); changed.spec.duration = { ...duration, basis: '用户明确需求' };
    assert.equal(validateVisualPlan(directory, changed, { sealed: false }).totalSeconds, 3);
  }
  const changed = structuredClone(plan); changed.spec.duration = { mode: 'max', seconds: 2, basis: '用户上限' };
  assert.throws(() => validateVisualPlan(directory, changed, { sealed: false }), /调整编排后继续/);
});

test('reviews require exact evidence, current Prompt hash and ten dimensions; N/A is normalized', () => {
  const { directory, plan } = complete();
  let changed = structuredClone(plan); changed.shots[0].review.scores[0].evidence = '不在原文中的句子';
  assert.throws(() => validateVisualPlan(directory, changed), /证据/);
  changed = structuredClone(plan); changed.shots[0].review.promptHash = 'stale';
  assert.throws(() => validateVisualPlan(directory, changed), /评分对应/);
  changed = structuredClone(plan); changed.shots[0].review.scores.pop();
  assert.throws(() => validateVisualPlan(directory, changed), /十个维度/);
  changed = structuredClone(plan); Object.assign(changed.shots[0].review.scores[0], { score: null, evidence: '', reason: '该示例不适用，明确记录依据。' });
  assert.equal(reviewTotal(changed.shots[0].review), 80);
  validateVisualPlan(directory, changed);
  changed.shots[0].review.scores[0].reason = '';
  assert.throws(() => validateVisualPlan(directory, changed), /评分理由/);
});

test('v2 requires optics, scores eleven dimensions and exports the full heatmap and feedback version', async () => {
  const { directory, plan } = fixture();
  plan.rubricVersion = currentRubricVersion;
  const rules = dimensionsFor(plan.rubricVersion), shot = plan.shots[0];
  assert.equal(rules.length, 11);
  assert.equal(rules.reduce((sum, [, , weight]) => sum + weight, 0), 100);
  assert.throws(() => sealPlan(directory, plan), /optics/);
  shot.dimensions.optics = '导演建议：全画幅等效50mm，f/2.8，对焦脸与握杯右手，背景轻虚化。';
  shot.prompt.text += '\n全画幅等效50mm，f/2.8，脸和握杯右手清楚，背景轻虚化。';
  plan.calibration[0].text = shot.prompt.text;
  const sealed = sealPlan(directory, plan);
  const scored = text => ({ ...review(text), rubricVersion: currentRubricVersion,
    scores: rules.map(([dimension]) => ({ dimension, score: dimension === 'optics' ? 1 : 4, evidence: dimension === 'optics' ? '50mm，f/2.8' : '一人', reason: '隔离测试：参数存在，按该版本权重计算，非图像质量评价。' })) });
  sealed.shots[0].review = scored(shot.prompt.text);
  sealed.calibration[0].review = scored(shot.prompt.text);
  save(path.join(directory, 'visual-plan.json'), sealed);
  assert.equal(reviewTotal(sealed.shots[0].review), 77);
  const mixed = structuredClone(sealed); mixed.shots[0].review.rubricVersion = 'visual-v1';
  assert.throws(() => validateVisualPlan(directory, mixed), /评分规则版本/);
  const changed = structuredClone(sealed); changed.rubricVersion = 'visual-v1';
  assert.throws(() => validateVisualPlan(directory, changed), /冻结失效/);
  const files = await exportVisualProject(directory), workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(files[0]));
  assert.ok(workbook.getWorksheet('分镜总表').getRow(1).values.includes('摄影约束（焦距、光圈与对焦）'));
  assert.equal(workbook.getWorksheet('最终Prompt').getCell('B2').value, shot.prompt.text);
  assert.equal(workbook.getWorksheet('评分总览').getCell('B2').value, 77);
  assert.equal(workbook.getWorksheet('评分总览').getCell('O1').value, '处理建议');
  assert.equal(workbook.getWorksheet('评分总览').conditionalFormattings[1].ref, 'D2:N2');
  assert.equal(workbook.getWorksheet('评分依据').rowCount, 12);
  const calibration = new ExcelJS.Workbook(); await calibration.xlsx.load(fs.readFileSync(files[1]));
  assert.match(calibration.getWorksheet('人工评分').getCell('E2').value, /摄影约束.*50mm/);
  calibration.getWorksheet('人工评分').getCell('F2').value = 80;
  const ratings = path.join(directory, 'v2-ratings.xlsx'); fs.writeFileSync(ratings, Buffer.from(await calibration.xlsx.writeBuffer()));
  const feedback = JSON.parse(fs.readFileSync(await importFeedback(directory, ratings), 'utf8'));
  assert.equal(feedback.rubricVersion, 'visual-v2');
});

test('Excel keeps literal prose, displays score heatmap and bars, leaves human ratings empty', async () => {
  const { directory, plan } = complete();
  const before = fs.readFileSync(path.join(directory, 'visual-plan.json'));
  const files = await exportVisualProject(directory);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(fs.readFileSync(files[0]));
  assert.equal(workbook.getWorksheet('最终Prompt').getCell('B2').value, plan.shots[0].prompt.text);
  assert.equal(workbook.getWorksheet('评分总览').getCell('B2').value, 80);
  assert.equal(workbook.getWorksheet('评分总览').conditionalFormattings.length, 2);
  assert.ok(workbook.getWorksheet('评分总览').getCell('C2').value.includes('█'));
  const all = []; workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => all.push(cell.value))));
  assert.ok(!all.includes(plan.spec.resolution));
  const calibration = new ExcelJS.Workbook(); await calibration.xlsx.load(fs.readFileSync(files[1]));
  assert.equal(calibration.getWorksheet('人工评分').getCell('F2').value, null);
  assert.equal(calibration.getWorksheet('人工评分').getCell('G2').value, null);
  assert.equal(calibration.getWorksheet('人工评分').getColumn(8).hidden, true);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'visual-plan.json')), before);
});

test('confirmed image references preserve concise prose, acting and scene changes through export', async () => {
  const { directory, plan, project } = fixture();
  project.references = [
    { id: 'R_CHARACTER', path: 'references/person-final.png' },
    { id: 'R_SCENE', path: 'references/room-final.png' }
  ];
  save(path.join(directory, 'project.json'), project);
  plan.references = [
    { ...project.references[0], purpose: '用户确定的PERSON角色图；@人物定稿.png', userProvided: true },
    { ...project.references[1], purpose: '用户确定的ROOM场景图；@房间定稿.png', userProvided: true }
  ];
  const shot = plan.shots[0];
  shot.shotSchema.subjects[0].referenceIds = ['R_CHARACTER'];
  shot.shotSchema.referenceIds = ['R_SCENE'];
  shot.dimensions.appearance = '采用@人物定稿.png，无外貌或服装变化。';
  shot.dimensions.scene = '采用@房间定稿.png，原本关闭的门打开一条缝。';
  shot.prompt.text = '在@房间定稿.png中，@人物定稿.png的人物右手握杯，眉头紧锁、双眼瞪圆、张嘴怒喝，目光朝向画外门口；原本关闭的门打开了一条缝。平视中景，脸和右手清楚。';
  plan.calibration = [];
  const sealed = sealPlan(directory, plan);
  sealed.shots[0].review = review(shot.prompt.text);
  sealed.shots[0].review.scores.forEach(score => { score.evidence = '@人物定稿.png'; });
  save(path.join(directory, 'visual-plan.json'), sealed);
  const [filename] = await exportVisualProject(directory);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(fs.readFileSync(filename));
  assert.equal(workbook.getWorksheet('最终Prompt').getCell('B2').value, shot.prompt.text);
  assert.equal(workbook.getWorksheet('分镜总表').getCell('F2').value, shot.dimensions.appearance);
  assert.equal(workbook.getWorksheet('分镜总表').getCell('L2').value, shot.dimensions.scene);
  const frozen = JSON.parse(fs.readFileSync(path.join(directory, 'visual-plan.json'), 'utf8'));
  assert.deepEqual(frozen.shots[0].shotSchema.subjects[0].referenceIds, ['R_CHARACTER']);
  assert.deepEqual(frozen.shots[0].shotSchema.referenceIds, ['R_SCENE']);
  assert.equal(frozen.shots[0].shotSchema.subjects[0].appearance, '短发');
  const drift = structuredClone(frozen); drift.references[0].purpose = '换成另一个角色';
  assert.throws(() => validateVisualPlan(directory, drift), /冻结失效/);
});

test('feedback imports an actual zero score independently, preserves source plan and deduplicates', async () => {
  const { directory } = complete();
  const files = await exportVisualProject(directory), workbook = new ExcelJS.Workbook();
  await assert.rejects(importFeedback(directory, files[1]), /未填写/);
  await workbook.xlsx.load(fs.readFileSync(files[1]));
  workbook.getWorksheet('人工评分').getCell('F2').value = 0;
  workbook.getWorksheet('人工评分').getCell('G2').value = '人物动作需要说清';
  const file = path.join(directory, 'ratings.xlsx'); fs.writeFileSync(file, Buffer.from(await workbook.xlsx.writeBuffer()));
  const before = fs.readFileSync(path.join(directory, 'visual-plan.json'));
  const result = JSON.parse(fs.readFileSync(await importFeedback(directory, file), 'utf8'));
  assert.equal(result.ratings[0].score, 0); assert.equal(result.changesRules, false);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'visual-plan.json')), before);
  await assert.rejects(importFeedback(directory, file), /已导入/);
});

test('feedback rejects formula scores, unknown IDs and frozen Prompt/background edits', async () => {
  const { directory } = complete(), files = await exportVisualProject(directory);
  for (const [cell, value, error] of [['F2', { formula: '100', result: 100 }, /公式/], ['A2', 'UNKNOWN', /未知/], ['D2', '换成另一份文字', /被改动/], ['E2', '换背景', /被改动/], ['F2', 101, /0至100/]]) {
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(fs.readFileSync(files[1]));
    workbook.getWorksheet('人工评分').getCell('F2').value = 80;
    workbook.getWorksheet('人工评分').getCell(cell).value = value;
    const file = path.join(directory, `bad-${cell}.xlsx`); fs.writeFileSync(file, Buffer.from(await workbook.xlsx.writeBuffer()));
    await assert.rejects(importFeedback(directory, file), error);
  }
});

test('uncovered source rows and duplicate sample IDs cannot be silently accepted', async () => {
  const { directory, plan, project } = complete();
  project.shots.push({ ...structuredClone(project.shots[0]), id: 'S002' });
  save(path.join(directory, 'project.json'), project);
  assert.throws(() => validateVisualPlan(directory), /未覆盖/);
  project.shots.pop(); save(path.join(directory, 'project.json'), project);
  plan.calibration.push({ ...structuredClone(plan.calibration[0]), id: 'C02', label: '样本B' });
  save(path.join(directory, 'visual-plan.json'), plan);
  const files = await exportVisualProject(directory), workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(files[1]));
  workbook.getWorksheet('人工评分').getCell('A3').value = 'C01';
  const filename = path.join(directory, 'duplicate.xlsx'); fs.writeFileSync(filename, Buffer.from(await workbook.xlsx.writeBuffer()));
  await assert.rejects(importFeedback(directory, filename), /重复/);
});

test('re-export refuses to erase a filled human rating, including zero', async () => {
  const { directory } = complete(), files = await exportVisualProject(directory), workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(files[1]));
  workbook.getWorksheet('人工评分').getCell('F2').value = 0;
  fs.writeFileSync(files[1], Buffer.from(await workbook.xlsx.writeBuffer()));
  const before = fs.readFileSync(files[1]);
  await assert.rejects(exportVisualProject(directory), /拒绝覆盖/);
  assert.deepEqual(fs.readFileSync(files[1]), before);
});

test('long calibration text uses continuation columns and still imports the exact sample', async () => {
  const { directory, plan } = fixture();
  plan.calibration[0].text = '=一人' + '文'.repeat(33000) + '\r\n尾句';
  const sealed = sealPlan(directory, plan);
  sealed.shots[0].review = review(sealed.shots[0].prompt.text);
  sealed.calibration[0].review = review(sealed.calibration[0].text);
  save(path.join(directory, 'visual-plan.json'), sealed);
  const files = await exportVisualProject(directory), workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(files[1]));
  const sheet = workbook.getWorksheet('人工评分'), scoreColumn = sheet.getRow(1).values.indexOf('用户总分（0–100）');
  assert.ok(sheet.getRow(1).values.includes('完整Prompt（续2）'));
  sheet.getRow(2).getCell(scoreColumn).value = 88;
  const filename = path.join(directory, 'long-feedback.xlsx'); fs.writeFileSync(filename, Buffer.from(await workbook.xlsx.writeBuffer()));
  const result = JSON.parse(fs.readFileSync(await importFeedback(directory, filename), 'utf8'));
  assert.equal(result.ratings[0].score, 88);
  assert.equal(result.ratings[0].promptHash, promptHash(plan.calibration[0].text.replace(/\r\n?/g, '\n')));
});
