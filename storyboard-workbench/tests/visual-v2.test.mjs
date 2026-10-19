import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ExcelJS from '../scripts/vendor/exceljs.cjs';
import { sealPlan, reportVisualProject, reviseVisualPlan, exportVisualProject, importFeedback, dimensionsFor, promptHash } from '../scripts/visual.mjs';
import { assetPlanHash, contract } from '../scripts/visual_v2.mjs';

const cli = fileURLToPath(new URL('../scripts/visual.mjs', import.meta.url));
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const save = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', 'utf8');
const score = text => ({ promptHash: promptHash(text), reviewer: 'isolated-test-reviewer', rubricVersion: 'visual-v2',
  scores: dimensionsFor('visual-v2').map(([dimension]) => ({ dimension, score: 4, evidence: '50mm', reason: '隔离程序测试记录，不作为画面质量基线。' })),
  strengths: ['正文有明确摄影设计'], weaknesses: ['未验证实际生成画面'], rewrite: { needed: false, reason: '程序测试使用固定文本。', executed: false } });
const semantic = () => ({ reviewer: 'independent-test-checker', checks: ['relationships', 'staticMoment', 'lighting', 'continuity'].map(rule => ({ rule, status: 'pass', evidence: '一人站定，双手垂放，窗侧柔光。', reason: '隔离软件夹具的独立核对记录，不是人工画面验收。' })) });
const provenance = (fields, sourceId) => fields.map(field => ({ field, kind: field === 'dimensions.moment' ? 'source' : 'director', basis: '本测试原稿与本次导演设计', sourceShotIds: [sourceId] }));
const shot = (id, sourceId, locationId, personId, fromShotIds = []) => {
  const appearance = personId === 'P1' ? '短发灰衫' : '卷发蓝衫';
  const text = `${appearance}的人站在窗边桌旁，双手自然垂放，目光停在桌面，表情平静。\n平视中景，人物在画面左侧，右侧留出桌面，窗侧柔光。导演建议：全画幅等效50mm，f/4，对焦面部，脸与双手清晰，远处背景轻虚化。`;
  return { id, sourceShotIds: [sourceId], locationId, seconds: 3, intent: '交代人物在房间内站定的状态',
    dimensions: { moment: '人物已经站定，双手自然垂放', appearance, pose: '站直，双臂垂下', expression: '表情平静，目光在桌面', relations: '一人入镜，与桌子保持半步距离', camera: '平视中景', optics: '全画幅等效50mm，f/4，对焦面部，脸与双手清晰，背景轻虚化', composition: '人物位于左侧，右侧留出桌面', scene: '窗边的木桌，浅色墙面', lighting: '窗侧柔光，暖灰色调', continuity: fromShotIds.length ? '沿用前镜站位、衣服与光向' : '本段起始状态' },
    optics: { focalLengthMm: 50, aperture: 4, focus: '面部', depthOfField: '脸与双手清晰，背景轻虚化', frameBasis: '全画幅等效', basis: '本次导演建议，非实拍数据' },
    shotSchema: { referenceIds: [], subjects: [{ assetId: personId, referenceIds: [], appearance, clothing: personId === 'P1' ? '灰色上衣' : '蓝色上衣', position: '画面左侧窗边', orientation: '朝向桌面', pose: '站直', visibleParts: '头部、上身和双手', hands: '双手自然垂放', gaze: '看桌面', expression: '平静' }], props: [], relations: [] },
    notApplicable: {}, provenance: provenance(contract.shotProvenanceFields, sourceId),
    transition: { fromShotIds, entry: '人物已站在桌旁', exit: '人物保持站姿', cut: fromShotIds.length ? '接前镜同一人物' : '进入独立场景' },
    motion: '保留站姿三秒后切镜；静帧正文只描述站定瞬间。', reuseOf: null, prompt: { text }, review: score(text), semanticReview: semantic() };
};

function fixture(t, { calibration = false, emptyScene = false, sourceText = null, configure = null } = {}) {
  // The Windows sandbox temp volume denies rename; keep atomic-write fixtures in this writable workspace.
  const directory = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '导演 v2 中文 '));
  const source = path.join(directory, '原稿 文本.txt'), projectFile = path.join(directory, 'project.json'), planFile = path.join(directory, 'visual-plan.json');
  const generated = new Set(), folders = new Set();
  const track = filename => {
    const relative = path.relative(directory, filename);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '仅登记本夹具生成的明确路径');
    generated.add(filename);
    for (let folder = path.dirname(filename); folder !== directory; folder = path.dirname(folder)) folders.add(folder);
    return filename;
  };
  const snapshot = revision => track(path.join(directory, 'visual-revisions', `${String(revision).padStart(6, '0')}.json`));
  t.after(() => {
    // Only known files returned or created by this fixture are removed, one path per operation.
    for (const filename of generated) if (fs.existsSync(filename)) fs.unlinkSync(filename);
    if (fs.existsSync(planFile)) fs.unlinkSync(planFile);
    if (fs.existsSync(projectFile)) fs.unlinkSync(projectFile);
    if (fs.existsSync(source)) fs.unlinkSync(source);
    for (const folder of [...folders].sort((a, b) => b.length - a.length)) if (fs.existsSync(folder)) fs.rmdirSync(folder);
    fs.rmdirSync(directory);
  });
  fs.writeFileSync(source, sourceText ?? (emptyScene ? '镜1：第一间空房内的木桌。\n镜2：同一间空房内的木桌。\n镜3：第二间空房内的木桌。' : '镜1：灰衫的人站在第一间屋的桌旁。\n镜2：灰衫的人保持站姿。\n镜3：蓝衫的人站在另一间屋的桌旁。'), 'utf8');
  const project = { title: '三镜隔离软件验收', source: { path: '原稿 文本.txt', sha256: promptHash(fs.readFileSync(source)), sheets: [] },
    workflowMode: 'manual', legacyMarker: { selectedVariantId: 'preserve-existing-selection' },
    shots: ['S1', 'S2', 'S3'].map((id, index) => ({ id, original: emptyScene ? '空房间内的窗边木桌。' : `${index === 2 ? '蓝衫' : '灰衫'}的人站定在桌旁。`, sourceNumber: String(index + 1), sourceRef: { sheet: '脚本', contentCell: `B${index + 2}` }, originalFields: [], originalDuration: 3 })), references: [] };
  const asset = (id, name, sourceId) => ({ id, name, description: name + '，本次隔离验收设定', basis: '本次导演设计', provenance: provenance(['description'], sourceId) });
  const input = { schemaVersion: 2, mode: 'visual-excel-v2', rubricVersion: 'visual-v2', projectId: 'isolated-v2-project', title: '三镜隔离软件验收',
    run: { platform: 'node-test', model: null }, spec: { aspectRatio: '16:9', resolution: '1920x1080', style: '写实', duration: { mode: 'estimate', basis: '三镜各三秒' } },
    productionInventory: { characters: [asset('P1', '灰衫人物', 'S1'), asset('P2', '蓝衫人物', 'S3')], locations: [asset('R1', '第一房间', 'S1'), asset('R2', '第二房间', 'S3')] },
    props: [], references: [], designNotes: ['独立软件夹具，不使用用户项目或模型生成。'], shots: [shot('T1', 'S1', 'R1', 'P1'), shot('T2', 'S2', 'R1', 'P1', ['T1']), shot('T3', 'S3', 'R2', 'P2')], calibration: [] };
  if (emptyScene) {
    input.productionInventory.characters = [];
    for (const shot of input.shots) {
      shot.intent = '交代空房间内桌子的空间位置'; shot.shotSchema.subjects = [];
      Object.assign(shot.dimensions, { moment: '窗边木桌上没有物品，房间内没有人物', appearance: '无人镜，不适用', pose: '无人镜，不适用', expression: '无人镜，不适用', relations: '无人镜，不适用', optics: '全画幅等效50mm，f/4，对焦桌面，近处木纹清晰，远墙略虚', composition: '木桌位于左侧，右侧留出空地', continuity: '沿用本场景桌子位置与光向' });
      Object.assign(shot.optics, { focus: '桌面', depthOfField: '近处木纹清晰，远墙略虚' });
      Object.assign(shot.transition, { entry: '木桌与窗户位于固定位置', exit: '空房间布局不变', cut: '按场景顺序切换' });
      shot.motion = '静止画面保留三秒后切镜。';
      shot.prompt.text = '房间里空无一人，木桌紧靠画面左侧窗户，右侧地面留空，窗侧柔光落在桌面。导演建议：全画幅等效50mm，f/4，对焦桌面，近处木纹清晰，远墙略虚。';
      shot.review = score(shot.prompt.text);
      for (const check of shot.semanticReview.checks) check.evidence = '房间无人，木桌静止，窗侧柔光。';
    }
  }
  if (calibration) input.calibration.push({ id: 'C1', shotId: 'T1', label: '人工评分软件夹具', text: input.shots[0].prompt.text, review: score(input.shots[0].prompt.text) });
  configure?.(input, project);
  save(projectFile, project);
  const originalInput = structuredClone(input), sourceBytes = fs.readFileSync(source), projectBytes = fs.readFileSync(projectFile);
  snapshot(1);
  const plan = sealPlan(directory, input);
  const bundle = (kind, filename) => save(track(path.join(directory, filename)), { schemaVersion: 1, projectId: plan.projectId, sourcePlanHash: assetPlanHash(plan, kind),
    [kind]: plan.productionInventory[kind].map(asset => ({ assetId: asset.id, base: { mode: 'generate', text: `${asset.description}。同一对象的三个互补视角。`, referenceIds: [], basis: '本次隔离验收资产设定。' }, ...(kind === 'characters' ? { optionalDetails: [] } : {}) })) });
  if (!emptyScene) bundle('characters', 'character-prompts.json');
  bundle('locations', 'scene-prompts.json');
  assert.equal(reportVisualProject(directory).status, 'passed', JSON.stringify(reportVisualProject(directory).issues, null, 2));
  const revise = (request, action = 'revise') => {
    snapshot(read(planFile).revision + 1);
    return reviseVisualPlan(directory, request, action);
  };
  const exportFiles = async () => { const files = await exportVisualProject(directory); files.forEach(track); return files; };
  const request = (changes, extra = {}) => ({ baseRevision: read(planFile).revision, actor: 'agent', reason: '用户要求定向调整本镜', userRequest: '请只修改指定镜头的画面。', kind: 'edit', shotEdits: [{ id: 'T1', changes }], ...extra });
  return { directory, project, plan, input, originalInput, source, sourceBytes, projectFile, projectBytes, planFile, track, snapshot, revise, exportFiles, request };
}

test('v2 seals the default plan and exports a first-sheet storyboard without choosing shots or rewriting archived state', async t => {
  const f = fixture(t);
  assert.deepEqual(f.input, f.originalInput, 'seal 不改写调用方输入');
  assert.ok(f.plan.shots.every(shot => shot.variantId === 'default' && shot.selection.by === 'agent-default'));
  assert.ok(f.plan.shots.every(shot => shot.review.sourceHash === shot.prompt.sourceHash && shot.semanticReview.sourceHash === shot.prompt.sourceHash));
  const files = await f.exportFiles(), workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(files.find(file => file.endsWith('画面分镜与评分.xlsx'))));
  const table = workbook.worksheets[0]; assert.equal(table.name, '分镜总表');
  const promptColumn = table.getRow(1).values.indexOf('自然语言Prompt');
  assert.equal(table.getCell('A1').font.name, 'Microsoft YaHei');
  assert.equal(table.getRow(2).getCell(promptColumn).font.name, 'Microsoft YaHei');
  assert.deepEqual([2, 3, 4].map(row => table.getRow(row).getCell(promptColumn).value), f.plan.shots.map(shot => shot.prompt.text));
  assert.equal(workbook.getWorksheet('最终Prompt'), undefined);
  const markdown = fs.readFileSync(files.find(file => file.endsWith('分镜总表.md')), 'utf8');
  for (const shot of f.plan.shots) assert.ok(markdown.includes(shot.prompt.text));
  assert.ok(markdown.indexOf('## T1') < markdown.indexOf('## T2') && markdown.indexOf('## T2') < markdown.indexOf('## T3'));
  assert.deepEqual(fs.readFileSync(f.source), f.sourceBytes);
  assert.deepEqual(fs.readFileSync(f.projectFile), f.projectBytes);
});

test('v2 aggregates malformed types, duplicate IDs, unknown references and fields including null rows', t => {
  const f = fixture(t), broken = structuredClone(f.plan);
  broken.extra = '不允许静默忽略';
  broken.shots[0].seconds = '3';
  broken.shots[0].sourceShotIds = ['S404'];
  broken.shots[0].locationId = 'R404';
  broken.shots[0].shotSchema.subjects[0].assetId = 'P404';
  broken.shots.push(structuredClone(broken.shots[0]), null);
  broken.productionInventory.characters.push(null);
  broken.references.push(null);
  const report = reportVisualProject(f.directory, broken), codes = new Set(report.issues.map(issue => issue.code));
  for (const code of ['UNKNOWN_FIELD', 'FIELD_TYPE', 'DUPLICATE_ID', 'UNKNOWN_REFERENCE', 'LOCATION_UNKNOWN', 'SHOT_SCHEMA_INVALID', 'OBJECT_REQUIRED']) assert.ok(codes.has(code), `${code} 应被聚合：${JSON.stringify(report)}`);
  assert.equal(report.status, 'invalid');
  assert.equal(report.execution.hardValidation, 'executed');
  assert.ok(report.issues.every(issue => typeof issue.path === 'string' && issue.message && issue.requirement));
  for (const [shots, expectedCode, folderName] of [[[null], 'OBJECT_REQUIRED', '空条目输入'], [{}, 'FIELD_TYPE', '错误镜头类型']]) {
    const directory = path.join(f.directory, folderName); fs.mkdirSync(directory);
    fs.writeFileSync(f.track(path.join(directory, '原稿 文本.txt')), f.sourceBytes);
    fs.writeFileSync(f.track(path.join(directory, 'project.json')), f.projectBytes);
    const input = { ...structuredClone(f.originalInput), shots };
    assert.throws(() => sealPlan(directory, input), error => !(error instanceof TypeError) && error.report?.issues.some(issue => issue.code === expectedCode));
    assert.equal(fs.existsSync(path.join(directory, 'visual-plan.json')), false);
  }
  const cyclic = structuredClone(f.plan);
  cyclic.shots[0].transition.fromShotIds = ['T2'];
  cyclic.calibration = [{ id: 'C1', shotId: 'T1', label: '依赖环软件夹具', text: cyclic.shots[0].prompt.text, sourceHash: cyclic.shots[0].prompt.sourceHash, textHash: cyclic.shots[0].prompt.textHash, review: score(cyclic.shots[0].prompt.text) }];
  const cyclicReport = reportVisualProject(f.directory, cyclic);
  assert.ok(cyclicReport.issues.some(issue => issue.code === 'DEPENDENCY_CYCLE'));
  assert.ok(cyclicReport.issues.some(issue => issue.code === 'CALIBRATION_DEPENDENCY_INVALID'));
  assert.equal(cyclicReport.execution.hardValidation, 'executed');
  assert.deepEqual(read(f.planFile), f.plan);
});

test('a local shot edit invalidates its dependent shot while preserving an unrelated shot and score', t => {
  const f = fixture(t), before = structuredClone(f.plan);
  const changed = f.revise(f.request({ dimensions: { ...before.shots[0].dimensions, composition: '人物居中，桌面在右侧' } }));
  assert.deepEqual(new Set(changed.affectedShotIds), new Set(['T1', 'T2']));
  assert.notEqual(changed.plan.shots[0].prompt.sourceHash, before.shots[0].prompt.sourceHash);
  assert.notEqual(changed.plan.shots[1].prompt.sourceHash, before.shots[1].prompt.sourceHash);
  assert.deepEqual(changed.plan.shots[2], before.shots[2]);
  assert.equal(changed.report.shots.find(shot => shot.id === 'T1').scoreValid, false);
  assert.equal(changed.report.shots.find(shot => shot.id === 'T2').scoreValid, false);
  assert.equal(changed.report.shots.find(shot => shot.id === 'T3').scoreValid, true);
  assert.deepEqual(fs.readFileSync(f.projectFile), f.projectBytes);
});

test('optional videoPrompt validates text, normalizes newlines and invalidates dependent checks on revision', t => {
  const f = fixture(t, { configure(input) { input.shots[0].videoPrompt = '人物保持站姿，镜头缓缓前推。\r\n最终停在平视中景。'; } });
  assert.equal(f.plan.shots[0].videoPrompt, '人物保持站姿，镜头缓缓前推。\n最终停在平视中景。');
  assert.equal(Object.hasOwn(f.plan.shots[1], 'videoPrompt'), false);
  for (const invalid of ['', ' \r\n\t', null, 3, [], {}]) {
    const broken = structuredClone(f.plan); broken.shots[0].videoPrompt = invalid;
    const report = reportVisualProject(f.directory, broken);
    assert.ok(report.issues.some(issue => issue.code === 'FIELD_TYPE' && issue.path === '$.shots.T1.videoPrompt'), JSON.stringify(report.issues));
  }
  const revised = f.revise(f.request({ videoPrompt: '人物保持站姿，镜头由中景缓慢拉远。\r\n窗侧柔光与站位不变。' }));
  assert.deepEqual(new Set(revised.affectedShotIds), new Set(['T1', 'T2']));
  assert.equal(revised.plan.shots[0].prompt.text, f.plan.shots[0].prompt.text);
  assert.equal(revised.plan.shots[0].motion, f.plan.shots[0].motion);
  assert.ok(!revised.plan.shots[0].videoPrompt.includes('\r'));
  for (const id of ['T1', 'T2']) {
    assert.equal(revised.report.shots.find(shot => shot.id === id).scoreValid, false);
    assert.ok(revised.report.issues.some(issue => issue.entityId === id && issue.code === 'SEMANTIC_STALE'));
  }
  assert.deepEqual(revised.plan.shots[2], f.plan.shots[2]);
  const invalidCandidate = candidateRequest(f); invalidCandidate.candidate.changes.videoPrompt = ' ';
  assert.throws(() => f.revise(invalidCandidate, 'add-candidate'), /候选结构不合法.*videoPrompt/);
  const brokenCandidate = structuredClone(revised.plan);
  brokenCandidate.shots[0].candidates.push({ ...invalidCandidate.candidate, baseSourceHash: brokenCandidate.shots[0].prompt.sourceHash, basePromptHash: brokenCandidate.shots[0].prompt.textHash });
  assert.ok(reportVisualProject(f.directory, brokenCandidate).issues.some(issue => issue.code === 'FIELD_TYPE' && issue.path.endsWith('.changes.videoPrompt')));
});

test('synthetic three-shot product brief keeps cup ownership and image/video prose through Excel export', async t => {
  const originals = ['灰衫的人右手握住白杯把手，杯身竖直。', '同一人仍用右手握住白杯把手，镜头强调杯柄。', '同一人右手保持白杯竖直，左手自然垂放。'];
  const f = fixture(t, { sourceText: '合成白杯广告需求：16:9，9秒，三镜，交付图像与视频Prompt文本，不生成媒体。\n' + originals.map((text, index) => `镜${index + 1}：${text}`).join('\n'), configure(input, project) {
    input.title = '合成白杯广告程序验收'; input.spec.duration = { mode: 'exact', seconds: 9, basis: '合成广告明确要求9秒' };
    input.productionInventory.characters = input.productionInventory.characters.slice(0, 1);
    input.productionInventory.locations = input.productionInventory.locations.slice(0, 1);
    input.props = [{ id: 'CUP', name: '白杯', description: '白色陶瓷杯，圆弧把手', provenance: provenance(['description'], 'S1') }];
    input.shots[2] = { ...structuredClone(input.shots[1]), id: 'T3', sourceShotIds: ['S3'], provenance: provenance(contract.shotProvenanceFields, 'S3'), transition: { fromShotIds: ['T2'], entry: '白杯仍在右手', exit: '保持竖直持杯', cut: '接前镜同一杯柄方向' } };
    for (const [index, shot] of input.shots.entries()) {
      project.shots[index].original = originals[index];
      shot.intent = ['交代产品与持有者', '突出杯柄握持关系', '收束在稳定持杯画面'][index];
      Object.assign(shot.dimensions, { moment: originals[index], pose: '右手握杯柄，左手垂放', relations: '白杯由同一人的右手持有', continuity: '白杯与圆弧杯柄方向保持一致，不交换持有者或左右手' });
      Object.assign(shot.shotSchema.subjects[0], { pose: '右臂在胸前持杯，左臂垂下', hands: '右手握杯柄，左手自然垂放', gaze: '看向白杯' });
      shot.shotSchema.props = [{ id: 'CUP', name: '白杯', holderAssetIds: ['P1'], referenceIds: [], position: '人物右手', state: '右手握把，杯身竖直' }];
      Object.assign(shot.transition, { entry: '白杯由右手持有', exit: '白杯仍由右手持有' });
      shot.motion = '右手保持白杯竖直，按本镜视频正文执行镜头变化。';
      shot.prompt.text = `短发灰衫的人站在窗边，右手握住白杯的圆弧把手，杯身竖直，左手自然垂放，目光落在白杯。${index === 1 ? '杯柄与右手占据画面中心。' : '人物与白杯位于画面左侧，右侧留白。'}窗侧柔光，导演建议：全画幅等效50mm，f/4，右手与杯柄清晰，背景轻虚化。`;
      shot.videoPrompt = ['人物保持持杯姿势，镜头缓慢前推，保持杯柄与右手清晰。', '从右手与杯柄近景轻微侧移，白杯仍由右手持有，杯身保持竖直。', '镜头缓缓拉回中景后停稳，人物与白杯保持原位，右侧留白。'][index];
      shot.review = score(shot.prompt.text);
      for (const check of shot.semanticReview.checks) check.evidence = '同一人的右手持有同一白杯，静帧单一瞬间，窗侧柔光沿用。';
    }
  } });
  assert.equal(reportVisualProject(f.directory).status, 'passed');
  assert.ok(f.plan.shots.every(shot => shot.shotSchema.props[0].holderAssetIds[0] === 'P1'));
  const broken = structuredClone(f.plan); broken.shots[1].shotSchema.props[0].holderAssetIds = ['UNKNOWN'];
  assert.ok(reportVisualProject(f.directory, broken).issues.some(issue => issue.code === 'SHOT_SCHEMA_INVALID' && issue.entityId === 'T2'));
  const files = await f.exportFiles(), workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(files.find(file => file.endsWith('画面分镜与评分.xlsx'))));
  const table = workbook.worksheets[0], column = label => table.getRow(1).values.indexOf(label);
  for (const [index, shot] of f.plan.shots.entries()) {
    assert.equal(table.getRow(index + 2).getCell(column('自然语言Prompt')).value, shot.prompt.text);
    assert.equal(table.getRow(index + 2).getCell(column('视频Prompt')).value, shot.videoPrompt);
    assert.equal(table.getRow(index + 2).getCell(column('原稿画面')).value, originals[index]);
  }
});

test('a shared character edit reaches its scenes only and expires the character bundle independently', t => {
  const f = fixture(t);
  const changed = f.revise(f.request({}, { shotEdits: [], assetEdits: [{ kind: 'characters', id: 'P1', changes: { description: '短发灰衫，领口增加清晰可见的一粒扣子' } }] }));
  assert.deepEqual(new Set(changed.affectedShotIds), new Set(['T1', 'T2']));
  assert.deepEqual(changed.plan.shots[2], f.plan.shots[2]);
  assert.ok(changed.report.issues.some(issue => issue.path === '$.character-prompts.json' && issue.code === 'ASSET_PROMPTS_INVALID'));
  assert.ok(!changed.report.issues.some(issue => issue.path === '$.scene-prompts.json'));
});

test('two rejected repair attempts consume the budget and preserve prose; a new edit needs the actual user request', t => {
  const f = fixture(t), texts = f.plan.shots.map(shot => shot.prompt.text);
  const repair = () => ({ baseRevision: read(f.planFile).revision, actor: 'agent', reason: '修复错误时长的隔离失败案例', kind: 'repair', shotEdits: [{ id: 'T1', changes: { seconds: '错误' } }] });
  const first = f.revise(repair()); assert.equal(first.accepted, false); assert.equal(first.plan.repairAttempts.length, 1);
  const second = f.revise(repair()); assert.equal(second.accepted, false); assert.equal(second.plan.repairAttempts.length, 2);
  assert.deepEqual(second.plan.shots.map(shot => shot.prompt.text), texts);
  assert.ok(read(f.snapshot(3)).attemptReport.issues.some(issue => issue.path.endsWith('.seconds')));
  const before = fs.readFileSync(f.planFile);
  assert.throws(() => f.revise(repair()), /两轮|上限/);
  const hiddenRepair = f.request({ seconds: 4 }); delete hiddenRepair.userRequest;
  assert.throws(() => f.revise(hiddenRepair), /userRequest|用户/);
  assert.deepEqual(fs.readFileSync(f.planFile), before);
  const explicit = f.revise(f.request({ seconds: 4 }, { userRequest: '新的调整：第一镜改成四秒。' }));
  assert.equal(explicit.accepted, true); assert.equal(explicit.plan.repairAttempts.length, 2);
  assert.equal(explicit.plan.shots[0].seconds, 4);
  assert.deepEqual(fs.readFileSync(f.source), f.sourceBytes);
});

test('baseRevision conflicts preserve the current state and its history', t => {
  const f = fixture(t);
  f.revise(f.request({ motion: '站定四秒的导演动作说明' }));
  const current = fs.readFileSync(f.planFile), history = fs.readFileSync(f.snapshot(2));
  assert.throws(() => f.revise(f.request({ motion: '另一个修改' }, { baseRevision: 1 })), /版本冲突/);
  assert.deepEqual(fs.readFileSync(f.planFile), current);
  assert.deepEqual(fs.readFileSync(f.snapshot(2)), history);
  assert.equal(fs.existsSync(f.snapshot(3)), false);
});

const candidateRequest = f => ({ baseRevision: read(f.planFile).revision, actor: 'agent', reason: '用户需要一个低机位的可选调整', shotId: 'T1', candidate: { id: 'low-angle', difference: '由平视改为低机位，保留同一人物和瞬间', changes: { dimensions: { ...read(f.planFile).shots[0].dimensions, camera: '低机位中景' }, prompt: { text: read(f.planFile).shots[0].prompt.text.replace('平视中景', '低机位中景') } } } });

test('adding a candidate leaves the adopted prose untouched; user selection updates JSON, Markdown and Excel together', async t => {
  const f = fixture(t), original = f.plan.shots[0].prompt.text;
  const request = candidateRequest(f); request.candidate.changes.videoPrompt = '从低机位中景缓慢前推，人物保持站姿与视线。';
  const added = f.revise(request, 'add-candidate');
  assert.equal(added.plan.revision, 2); assert.equal(added.plan.shots[0].prompt.text, original);
  assert.equal(added.plan.shots[0].selection.by, 'agent-default');
  const beforeSelect = fs.readFileSync(f.planFile);
  assert.throws(() => f.revise({ baseRevision: 2, actor: 'agent', reason: '错误地代替用户采用', shotId: 'T1', candidateId: 'low-angle' }, 'select'), /用户选择/);
  assert.deepEqual(fs.readFileSync(f.planFile), beforeSelect);
  const selected = f.revise({ baseRevision: 2, actor: 'user', reason: '采用低机位方案', shotId: 'T1', candidateId: 'low-angle' }, 'select');
  const text = original.replace('平视中景', '低机位中景');
  assert.equal(selected.plan.revision, 3); assert.equal(selected.plan.shots[0].variantId, 'low-angle');
  assert.equal(selected.plan.shots[0].selection.by, 'user'); assert.equal(selected.plan.shots[0].prompt.text, text);
  assert.equal(selected.plan.shots[0].videoPrompt, request.candidate.changes.videoPrompt);
  const files = await f.exportFiles(), workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(files.find(file => file.endsWith('画面分镜与评分.xlsx'))));
  const sheet = workbook.worksheets[0], column = sheet.getRow(1).values.indexOf('自然语言Prompt');
  assert.equal(sheet.getRow(2).getCell(column).value, text);
  assert.equal(sheet.getRow(2).getCell(sheet.getRow(1).values.indexOf('视频Prompt')).value, selected.plan.shots[0].videoPrompt);
  assert.ok(fs.readFileSync(files.find(file => file.endsWith('分镜总表.md')), 'utf8').includes(text));
  assert.deepEqual(fs.readFileSync(f.projectFile), f.projectBytes);
});

test('changing only the current prose makes an earlier candidate stale', t => {
  const f = fixture(t); f.revise(candidateRequest(f), 'add-candidate');
  const revised = f.revise(f.request({ prompt: { text: f.plan.shots[0].prompt.text + '\n人物保持同一站位。' } }));
  const before = fs.readFileSync(f.planFile);
  assert.throws(() => f.revise({ baseRevision: revised.plan.revision, actor: 'user', reason: '尝试采用旧候选', shotId: 'T1', candidateId: 'low-angle' }, 'select'), /过期/);
  assert.deepEqual(fs.readFileSync(f.planFile), before);
});

test('CLI parse failures are reported separately and preserve the malformed input and saved project', t => {
  const f = fixture(t), filename = f.track(path.join(f.directory, '坏的 修订.json')), bytes = Buffer.from('{"shotEdits": [未完成', 'utf8');
  fs.writeFileSync(filename, bytes);
  const before = fs.readFileSync(f.planFile);
  const result = spawnSync(process.execPath, [cli, 'revise', f.directory, filename], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stderr); assert.equal(report.issues[0].category, 'parse');
  assert.equal(report.execution.hardValidation, 'not-completed');
  assert.deepEqual(fs.readFileSync(filename), bytes); assert.deepEqual(fs.readFileSync(f.planFile), before);
  assert.deepEqual(fs.readFileSync(f.projectFile), f.projectBytes);
});

test('restoring a historical plan creates a new revision without deleting newer history', t => {
  const f = fixture(t), first = fs.readFileSync(f.snapshot(1));
  const changed = f.revise(f.request({ prompt: { text: f.plan.shots[0].prompt.text + '\n桌面纹理清楚。' } })), second = fs.readFileSync(f.snapshot(2));
  const restored = f.revise({ baseRevision: changed.plan.revision, actor: 'user', reason: '恢复最初采用的正文', targetRevision: 1 }, 'restore');
  assert.equal(restored.plan.revision, 3); assert.equal(restored.plan.shots[0].prompt.text, f.plan.shots[0].prompt.text);
  assert.deepEqual(fs.readFileSync(f.snapshot(1)), first); assert.deepEqual(fs.readFileSync(f.snapshot(2)), second);
  assert.deepEqual(restored.plan.changes.map(change => change.action), ['revise', 'restore']);
  assert.equal(read(f.snapshot(3)).request.targetRevision, 1);
});

test('UTF-8 exports retain real zero-point human feedback and a later revision writes a new workbook', async t => {
  const f = fixture(t, { calibration: true }), files = await f.exportFiles();
  const ratings = files.find(file => file.endsWith('人工校准.xlsx')), workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(ratings));
  const sheet = workbook.getWorksheet('人工评分'), headers = sheet.getRow(1).values;
  sheet.getRow(2).getCell(headers.indexOf('用户总分（0–100）')).value = 0;
  sheet.getRow(2).getCell(headers.indexOf('用户原因')).value = '软件验收填写：零分必须保留。';
  fs.writeFileSync(ratings, Buffer.from(await workbook.xlsx.writeBuffer()));
  const filled = fs.readFileSync(ratings), feedback = f.track(await importFeedback(f.directory, ratings));
  assert.equal(read(feedback).ratings[0].score, 0);
  await assert.rejects(f.exportFiles(), /拒绝覆盖|已存在/);
  assert.deepEqual(fs.readFileSync(ratings), filled);
  f.revise(f.request({ motion: '第三镜按用户要求增加停留说明' }, { shotEdits: [{ id: 'T3', changes: { motion: '第三镜按用户要求增加停留说明' } }] }));
  const nextFiles = await f.exportFiles(), nextRatings = nextFiles.find(file => file.endsWith('人工校准.xlsx'));
  assert.notEqual(nextRatings, ratings); assert.ok(nextRatings.includes('revision-000002'));
  assert.deepEqual(fs.readFileSync(ratings), filled); assert.equal(read(feedback).ratings[0].score, 0);
  const nextBook = new ExcelJS.Workbook(); await nextBook.xlsx.load(fs.readFileSync(nextRatings));
  assert.equal(nextBook.getWorksheet('人工评分').getRow(2).getCell(headers.indexOf('用户总分（0–100）')).value, null);
  const pendingRatings = f.track(path.join(f.directory, '其他镜头待处理时的 人评.xlsx'));
  sheet.getRow(2).getCell(headers.indexOf('用户原因')).value = '软件验收填写：第三镜待处理不应阻塞第一镜人评。';
  fs.writeFileSync(pendingRatings, Buffer.from(await workbook.xlsx.writeBuffer()));
  const pendingFeedback = f.track(await importFeedback(f.directory, pendingRatings));
  assert.equal(read(pendingFeedback).ratings[0].score, 0);
  f.revise(f.request({ dimensions: { ...read(f.planFile).shots[0].dimensions, composition: '人物移到画面中心，画面依据发生变化' } }));
  const preservedRatings = fs.readFileSync(pendingRatings);
  await assert.rejects(importFeedback(f.directory, pendingRatings), /校准样本已过期/);
  assert.deepEqual(fs.readFileSync(pendingRatings), preservedRatings);
});

test('atomic rename and partial snapshot write failures preserve state and allow the same request to be retried', t => {
  const f = fixture(t), before = fs.readFileSync(f.planFile), originalHistory = fs.readFileSync(f.snapshot(1));
  const request = f.request({ motion: '用户明确要求的新动作安排说明' });
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.planFile) throw Object.assign(new Error('injected atomic rename failure'), { code: 'EIO' });
    return originalRename(from, to);
  });
  try { assert.throws(() => f.revise(request), /injected atomic rename failure/); }
  finally { t.mock.restoreAll(); }
  assert.deepEqual(fs.readFileSync(f.planFile), before);
  assert.deepEqual(fs.readFileSync(f.snapshot(1)), originalHistory);
  assert.equal(fs.existsSync(f.snapshot(2)), false);
  assert.deepEqual(fs.readdirSync(f.directory).filter(name => name === 'visual-plan.lock' || name.startsWith('.visual-plan-')), []);
  const retried = f.revise(request);
  assert.equal(retried.accepted, true); assert.equal(retried.plan.revision, 2);
  assert.equal(retried.plan.shots[0].motion, request.shotEdits[0].changes.motion);
  assert.equal(read(f.snapshot(2)).request.reason, request.reason);
  const secondRequest = f.request({ motion: '用户的下一项明确修订' }), secondState = fs.readFileSync(f.planFile), secondHistory = fs.readFileSync(f.snapshot(2));
  const failedSnapshot = f.snapshot(3), originalOpen = fs.openSync, originalWrite = fs.writeFileSync;
  let snapshotHandle;
  t.mock.method(fs, 'openSync', (filename, ...args) => {
    const handle = originalOpen(filename, ...args);
    if (filename === failedSnapshot) snapshotHandle = handle;
    return handle;
  });
  t.mock.method(fs, 'writeFileSync', (target, ...args) => {
    if (snapshotHandle !== undefined && target === snapshotHandle) {
      originalWrite(target, '{', 'utf8');
      throw Object.assign(new Error('injected partial snapshot write failure'), { code: 'ENOSPC' });
    }
    return originalWrite(target, ...args);
  });
  try { assert.throws(() => f.revise(secondRequest), /injected partial snapshot write failure/); }
  finally { t.mock.restoreAll(); }
  assert.deepEqual(fs.readFileSync(f.planFile), secondState);
  assert.deepEqual(fs.readFileSync(f.snapshot(2)), secondHistory);
  assert.equal(fs.existsSync(failedSnapshot), false);
  assert.deepEqual(fs.readdirSync(f.directory).filter(name => name === 'visual-plan.lock' || name.startsWith('.visual-plan-')), []);
  const retriedPartial = f.revise(secondRequest);
  assert.equal(retriedPartial.accepted, true); assert.equal(retriedPartial.plan.revision, 3);
  assert.equal(read(failedSnapshot).request.reason, secondRequest.reason);
});

test('an empty scene plan needs no character file, while an explicitly blocked character remains pending', async t => {
  const empty = fixture(t, { emptyScene: true });
  assert.equal(fs.existsSync(path.join(empty.directory, 'character-prompts.json')), false);
  assert.equal(reportVisualProject(empty.directory).status, 'passed');
  const emptyFiles = await empty.exportFiles();
  assert.ok(emptyFiles.some(filename => filename.endsWith('场景资产Prompt.xlsx')));
  assert.ok(!emptyFiles.some(filename => filename.endsWith('人物资产Prompt.xlsx')));
  const populated = fixture(t), filename = path.join(populated.directory, 'character-prompts.json'), bundle = read(filename);
  Object.assign(bundle.characters[0].base, { mode: 'blocked', text: '', basis: '角色可见服装存在关键矛盾，待用户确认。' });
  save(filename, bundle);
  const report = reportVisualProject(populated.directory);
  assert.equal(report.status, 'pending');
  assert.ok(report.issues.some(issue => issue.code === 'ASSET_PROMPT_BLOCKED' && issue.severity === 'pending' && issue.path.endsWith('.P1')));
  const pendingFiles = await populated.exportFiles();
  assert.ok(pendingFiles.some(filename => filename.endsWith('人物资产Prompt.xlsx')));
});
