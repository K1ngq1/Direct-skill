import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ExcelJS from '../scripts/vendor/exceljs.cjs';
import { sealPlan, promptHash, dimensionsFor, exportVisualProject } from '../scripts/visual.mjs';
import { contract } from '../scripts/visual_v2.mjs';
import { validateVideoWorkflow, sealVideoWorkflow, readVideoWorkflow, finalizeVideoWorkflow, importVideoFeedback } from '../scripts/video.mjs';

const save = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', 'utf8');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF7sAAAAASUVORK5CYII=', 'base64');
const provenance = sourceId => contract.shotProvenanceFields.map(field => ({ field, kind: 'director', basis: '本次隔离软件样例', sourceShotIds: [sourceId] }));

function fixture(t, version = 1) {
  const directory = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'video-isolated-'));
  const files = new Set(), folders = new Set();
  const track = filename => {
    assert.ok(path.relative(directory, filename) && !path.relative(directory, filename).startsWith('..'));
    files.add(filename);
    for (let folder = path.dirname(filename); folder !== directory; folder = path.dirname(folder)) folders.add(folder);
    return filename;
  };
  t.after(() => {
    for (const relative of ['excel-delivery/records', 'excel-delivery/snapshots']) {
      const folder = path.join(directory, relative);
      if (fs.existsSync(folder)) for (const name of fs.readdirSync(folder)) track(path.join(folder, name));
    }
    for (const name of ['excel-delivery.json', 'excel-delivery.lock', 'excel-delivery.pending.json']) {
      const filename = path.join(directory, name);
      if (fs.existsSync(filename)) track(filename);
    }
    for (const filename of files) if (fs.existsSync(filename)) fs.unlinkSync(filename);
    for (const folder of [...folders].sort((a, b) => b.length - a.length)) if (fs.existsSync(folder)) fs.rmdirSync(folder);
    fs.rmdirSync(directory);
  });
  const source = track(path.join(directory, '原稿.txt')); fs.writeFileSync(source, '一人站在桌边，随后抬手。', 'utf8');
  const project = { title: '视频规划隔离验收', source: { path: '原稿.txt', sha256: promptHash(fs.readFileSync(source)), sheets: [] },
    shots: ['S1', 'S2', 'S3'].map(id => ({ id, original: '一人站在桌旁。', sourceNumber: id, sourceRef: { sheet: '脚本', contentCell: 'B2' }, originalFields: [], originalDuration: 2 })), references: [] };
  save(track(path.join(directory, 'project.json')), project);
  const asset = (id, name) => ({ id, name, description: `${name}，隔离样例设定`, basis: '软件样例', ...(version === 2 ? { provenance: [{ field: 'description', kind: 'director', basis: '本次隔离软件样例', sourceShotIds: ['S1'] }] } : {}) });
  const shots = ['S07a', 'S07b', 'S13'].map((id, index) => {
    const text = '短发灰衫的人站在窗边桌旁，双手自然垂下，目光在桌面。平视中景，窗侧柔光。全画幅等效50mm，f/4，对焦面部，脸与手清晰，背景轻虚。';
    const review = { promptHash: promptHash(text), reviewer: 'isolated-software-fixture', rubricVersion: `visual-v${version}`, scores: dimensionsFor(`visual-v${version}`).map(([dimension]) => ({ dimension, score: 4, evidence: '平视中景', reason: '仅隔离软件样例' })), strengths: ['软件样例'], weaknesses: ['未生成画面'], rewrite: { needed: false, reason: '固定软件样例', executed: false } };
    return { id, sourceShotIds: [`S${index + 1}`], locationId: 'ROOM', seconds: 2, dimensions: Object.fromEntries(dimensionsFor(`visual-v${version}`).map(([key]) => [key, key === 'optics' ? '全画幅等效50mm，f/4，对焦面部，脸与手清晰，背景轻虚。' : '短发灰衫的人站在窗边，双手垂下，窗侧柔光。'])),
      shotSchema: { referenceIds: [], subjects: [{ assetId: 'PERSON', referenceIds: [], appearance: '短发', clothing: '灰衫', pose: '站直', ...(version === 2 ? { position: '画面左侧', orientation: '面向桌面', visibleParts: '头、上身、手', hands: '自然垂放', gaze: '看桌面', expression: '平静' } : {}) }], props: [], relations: [] },
      transition: { fromShotIds: index ? [['S07a', 'S07b'][index - 1]] : [], entry: '人物站定', exit: '人物站定', cut: '直接切换' }, motion: '站定两秒。', reuseOf: index === 2 ? 'S07a' : null, prompt: { text }, review,
      ...(version === 2 ? { intent: '交代人物站姿', notApplicable: {}, provenance: provenance(`S${index + 1}`), optics: { focalLengthMm: 50, aperture: 4, focus: '面部', depthOfField: '脸与手清晰，背景轻虚', frameBasis: '全画幅等效', basis: '导演建议' } } : {}) };
  });
  const input = { schemaVersion: version, mode: `visual-excel-v${version}`, ...(version === 2 ? { rubricVersion: 'visual-v2', run: { platform: 'node-test', model: null } } : {}), projectId: 'video-isolated', title: project.title,
    spec: { aspectRatio: '16:9', resolution: '1920x1080', style: '写实', duration: { mode: 'estimate', basis: '每条静帧两秒' } },
    productionInventory: { characters: [asset('PERSON', '人物')], locations: [asset('ROOM', '房间')] }, props: [], references: [], designNotes: ['隔离软件样例'], shots, calibration: [] };
  track(path.join(directory, 'visual-plan.json'));
  if (version === 2) track(path.join(directory, 'visual-revisions', '000001.json'));
  const plan = sealPlan(directory, input);
  fs.writeFileSync(track(path.join(directory, 'start.png')), png); fs.writeFileSync(track(path.join(directory, 'end.png')), png);
  const image = (id, shotId, imagePath) => ({ id, shotId, locationId: 'ROOM', characterIds: ['PERSON'], path: imagePath, sha256: promptHash(png), review: { status: 'needs-change', reason: '需核对手臂连续性，仅作预演', reviewer: 'software-fixture' }, selection: { by: 'agent', reason: '预演占位' }, approval: { status: 'pending', by: null } });
  const videoShot = (id, shotIds, startImageId, endImageId, seconds) => ({ id, shotIds, startImageId, endImageId, startState: '人物站定', action: '缓慢抬手', camera: '固定机位', endState: '手停在胸前', invariants: ['服装与光向保持'], durationSeconds: seconds, dialogue: '', sound: '室内底噪', videoPrompt: '固定机位，人物从站定缓慢抬手，服装与光向保持。' });
  const workflow = { schemaVersion: 1, projectId: plan.projectId, revision: 1, sourcePlanHash: promptHash(JSON.stringify(plan)), images: [image('IMG_A', 'S07a', 'start.png'), image('IMG_B', 'S07b', 'end.png')],
    videoShots: [videoShot('V01', ['S07a', 'S07b'], 'IMG_A', 'IMG_B', 4), videoShot('V02', ['S13'], 'IMG_A', null, 2)], timeline: plan.shots.map(shot => ({ shotId: shot.id, seconds: 2, reason: '本次预演时长' })), pilotVideoShotIds: ['V01'], results: [] };
  const seal = value => { const result = sealVideoWorkflow(directory, value); track(result.file); return result; };
  const feedback = comments => {
    const file = track(path.join(directory, '意见.json'));
    save(file, { schemaVersion: 1, projectId: workflow.projectId, revision: workflow.revision, workflowHash: promptHash(JSON.stringify(workflow)), comments });
    return file;
  };
  const importFeedback = async (value, file) => { const result = await importVideoFeedback(directory, value, file); track(result.file); track(result.markdownFile); return result; };
  return { directory, plan, workflow, track, seal, feedback, importFeedback };
}

test('static revision binds real references and updates prose while preserving the frozen source', async t => {
  const { directory, workflow, track, seal, importFeedback } = fixture(t), original = fs.readFileSync(path.join(directory, 'visual-plan.json'));
  workflow.shotPrompts = [{ shotId: 'S07a', text: '参考图中的人物站在原桌旁，双手自然垂下。', basis: '本轮明确复用现有人物参考',
    references: [{ assetId: 'PERSON', path: 'start.png', sha256: promptHash(png) }] }];
  validateVideoWorkflow(directory, workflow);
  seal(workflow);
  const files = await exportVisualProject(directory, { videoWorkflow: workflow }); files.forEach(track);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(fs.readFileSync(files[0]));
  assert.equal(workbook.getWorksheet('生成Prompt').getCell('C2').text, workflow.shotPrompts[0].text);
  const { exportVisualExcel } = await import('../scripts/export_visual_excel.mjs');
  const [directFile] = await exportVisualExcel(JSON.parse(original), JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf8')), 6, null, null, { directory, workflow });
  const direct = new ExcelJS.Workbook(); await direct.xlsx.load(directFile.buffer);
  assert.equal(direct.getWorksheet('生成Prompt').getCell('C2').text, workflow.shotPrompts[0].text);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'visual-plan.json')), original);
  workbook.getWorksheet('分镜脚本').getCell('J2').value = '本轮静帧意见';
  fs.writeFileSync(files[0], Buffer.from(await workbook.xlsx.writeBuffer()));
  const feedback = await importFeedback(workflow, files[0]);
  assert.equal(JSON.parse(fs.readFileSync(feedback.file, 'utf8')).entries[0].promptHash, promptHash(workflow.shotPrompts[0].text));
  const invalid = structuredClone(workflow); invalid.shotPrompts[0].references[0].assetId = 'UNKNOWN';
  assert.throws(() => validateVideoWorkflow(directory, invalid), /参考与本镜资产不匹配/);
  invalid.shotPrompts = [workflow.shotPrompts[0], workflow.shotPrompts[0]];
  assert.throws(() => validateVideoWorkflow(directory, invalid), /镜号重复/);
});

for (const version of [1, 2]) test(`v${version} sidecar preserves frozen source and supports paired frames and reuse`, t => {
  const { directory, workflow, seal } = fixture(t, version), before = fs.readFileSync(path.join(directory, 'visual-plan.json'));
  workflow.title = '视频脚本'; workflow.images[0].productionNote = '保持右臂位置'; workflow.timeline[0].description = '人物站定后抬手';
  workflow.assetImages = [{ assetId: 'PERSON', path: 'start.png', sha256: promptHash(png), description: '短发灰衫人物' }];
  const checked = validateVideoWorkflow(directory, workflow);
  assert.equal(checked.totalSeconds, 6); assert.deepEqual(checked.pendingImageIds, ['IMG_A', 'IMG_B']);
  const { file } = seal(workflow);
  assert.deepEqual(readVideoWorkflow(directory, file), workflow);
  assert.throws(() => sealVideoWorkflow(directory, workflow), /已存在/);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'visual-plan.json')), before);
});

test('fresh video CLI seal/validate stay compact and export completes without circular module deadlock', t => {
  const { directory, workflow, track } = fixture(t);
  const input = track(path.join(directory, 'video-input.json')); save(input, workflow);
  const cli = fileURLToPath(new URL('../scripts/video.mjs', import.meta.url));
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.equal(result.signal, null);
    assert.ok(result.stdout.length < 3000, 'CLI只输出文件与数量，不打印Prompt正文');
    return JSON.parse(result.stdout);
  };
  const sealed = run('seal', directory, input); track(sealed.file);
  assert.equal(sealed.status, 'sealed'); assert.equal(sealed.workflow, undefined); assert.equal(sealed.counts.videoShots, 2);
  const checked = run('validate', directory, sealed.file);
  assert.equal(checked.status, 'valid'); assert.equal(checked.plan, undefined); assert.equal(checked.totalSeconds, 6);
  const result = run('export', directory, sealed.file);
  for (const file of result.files) { track(file); assert.ok(fs.statSync(file).size > 0); }
  assert.equal(result.files.filter(file => file.endsWith('.xlsx')).length, 1);
  assert.equal(result.files.filter(file => file.endsWith('.md')).length, 1);
  workflow.revision++; save(input, workflow);
  const finalized = run('finalize', directory, input); track(finalized.file); finalized.files.forEach(track);
  assert.equal(finalized.stateSaved, true); assert.equal(finalized.exportsUpdated, true);
  assert.equal(finalized.files.find(file => file.endsWith('.xlsx')), result.files.find(file => file.endsWith('.xlsx')));
});

test('video export validates its source once per call and does not reuse checks after source bytes change', { concurrency: false }, async t => {
  const { directory, workflow, track } = fixture(t), originalRead = fs.readFileSync;
  const planFile = path.join(directory, 'visual-plan.json'); let reads = 0;
  fs.readFileSync = (filename, ...args) => {
    if (typeof filename === 'string' && path.resolve(filename) === planFile) reads++;
    return originalRead(filename, ...args);
  };
  try { (await exportVisualProject(directory, { videoWorkflow: workflow })).forEach(track); }
  finally { fs.readFileSync = originalRead; }
  assert.equal(reads, 1, '同一次视频导出复用其已校验计划，不再调用第二套源校验');
  fs.appendFileSync(path.join(directory, 'start.png'), 'changed');
  await assert.rejects(exportVisualProject(directory, { videoWorkflow: workflow }), /哈希/);
});

test('finalize seals and delivers once, and reports saved state when Excel export fails', async t => {
  const { directory, workflow, track } = fixture(t);
  const first = await finalizeVideoWorkflow(directory, workflow); track(first.file); first.files.forEach(track);
  assert.equal(first.stateSaved, true); assert.equal(first.exportsUpdated, true); assert.equal(first.status, 'delivered');
  const workbook = first.files.find(file => file.endsWith('.xlsx')), bytes = fs.readFileSync(workbook);
  const next = structuredClone(workflow); next.revision++;
  next.shotPrompts = [{ shotId: 'S07a', text: '人物保持站立，目光停在桌面。'.repeat(800), basis: '本次软件样例', references: [] }];
  const failed = await finalizeVideoWorkflow(directory, next); track(failed.file);
  assert.equal(failed.stateSaved, true); assert.equal(failed.exportsUpdated, false); assert.equal(failed.status, 'sealed');
  assert.match(failed.exportFailure.message, /过长|空间|行高/);
  assert.deepEqual(readVideoWorkflow(directory, failed.file), next);
  assert.deepEqual(fs.readFileSync(workbook), bytes);
});

test('rejects outdated plan/image bytes, escaped images, invalid relations and fake confirmation', t => {
  const { directory, workflow } = fixture(t);
  for (const [change, error] of [
    [value => { value.sourcePlanHash = 'outdated'; }, /版本不匹配|过期/],
    [value => { value.title = ''; }, /标题须为非空文本/],
    [value => { value.generationSettings = ' '; }, /全片视频参数须为非空文本/],
    [value => { value.generationSettings = 480; }, /全片视频参数须为非空文本/],
    [value => { value.musicPrompt = ''; }, /全片音乐Prompt须为非空文本/],
    [value => { value.musicPrompt = null; }, /全片音乐Prompt须为非空文本/],
    [value => { value.videoShots[0].generationParameters = ''; }, /视频参数须为非空文本/],
    [value => { value.videoShots[0].generationParameters = {}; }, /视频参数须为非空文本/],
    [value => { value.images[0].productionNote = 1; }, /制作备注须为非空文本/],
    [value => { value.timeline[0].description = ' '; }, /画面描述须为非空文本/],
    [value => { value.assetImages = [{ assetId: 'PERSON', path: 'start.png', sha256: promptHash(png), description: null }]; }, /资产描述须为非空文本/],
    [value => { value.images[0].path = '../outside.png'; }, /项目目录/],
    [value => { value.images[0].sha256 = '0'.repeat(64); }, /哈希/],
    [value => { value.images[0].locationId = 'OTHER'; }, /场景关系/],
    [value => { value.images[0].characterIds = []; }, /人物映射/],
    [value => { value.images[0].approval = { status: 'confirmed', by: 'agent' }; }, /用户确认/],
    [value => { value.videoShots[0].endImageId = 'IMG_A'; }, /首尾图片/],
    [value => { value.videoShots[0].shotIds.reverse(); }, /覆盖全部/],
    [value => { value.timeline.reverse(); }, /时间线/],
    [value => { value.videoShots[0].durationSeconds = 9; }, /时间线不一致/],
    [value => { value.results = [{ videoShotId: 'V01', status: 'succeeded', attempts: 1, manualEdits: '' }]; }, /实际输出/]
  ]) { const changed = structuredClone(workflow); change(changed); assert.throws(() => validateVideoWorkflow(directory, changed), error); }
});

test('failed generation output cannot be promoted to an image reference', t => {
  const { directory, workflow, track } = fixture(t);
  save(track(path.join(directory, 'generation-manifest.json')), { tasks: [{ targetType: 'shot', targetId: 'S07a', status: 'failed', output: { path: 'start.png', sha256: promptHash(png) } }] });
  assert.throws(() => validateVideoWorkflow(directory, workflow), /失败、未完成/);
});

test('explicit completed generation source takes precedence over an old planned manifest and stays hash bound', t => {
  const { directory, workflow, track } = fixture(t);
  save(track(path.join(directory, 'generation-manifest.json')), { tasks: [{ targetType: 'shot', targetId: 'S07a', status: 'planned' }] });
  const file = track(path.join(directory, 'verification.json'));
  const verification = { items: workflow.images.map(image => ({ id: image.shotId, status: 'succeeded', output: { path: image.path, sha256: image.sha256 } })) };
  save(file, verification);
  workflow.generationSource = { path: 'verification.json', sha256: promptHash(fs.readFileSync(file)) };
  assert.equal(validateVideoWorkflow(directory, workflow).totalSeconds, 6);
  verification.items[0].status = 'failed'; save(file, verification);
  assert.throws(() => validateVideoWorkflow(directory, workflow), /哈希/);
  workflow.generationSource.sha256 = promptHash(fs.readFileSync(file));
  assert.throws(() => validateVideoWorkflow(directory, workflow), /失败或未完成/);
});

test('symlink image and revision traversal cannot leave the project', t => {
  const { directory, workflow, track } = fixture(t);
  assert.throws(() => readVideoWorkflow(directory, '../outside.json'), /项目目录/);
  const link = track(path.join(directory, 'outside-link.png'));
  try { fs.symlinkSync(fileURLToPath(import.meta.url), link, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('Current Windows user cannot create symlinks; traversal and byte validation remain tested.'); return; } throw error; }
  const changed = structuredClone(workflow); changed.images[0].path = 'outside-link.png'; changed.images[0].sha256 = promptHash(fs.readFileSync(fileURLToPath(import.meta.url)));
  assert.throws(() => validateVideoWorkflow(directory, changed), /越出项目目录/);
});

test('JSON feedback keeps zero, binds images and text, rejects stale or duplicate comments', async t => {
  const { directory, workflow, track, seal, feedback, importFeedback } = fixture(t);
  seal(workflow);
  const file = feedback([{ shotId: 'S07a', note: 0 }, { shotId: 'S07b', note: '抬手减慢' }]);
  const result = await importFeedback(workflow, file), record = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  assert.equal(result.imported, 2); assert.equal(record.entries[0].note, 0);
  const markdown = fs.readFileSync(result.markdownFile, 'utf8');
  assert.match(markdown, /意见：0/); assert.match(markdown, /抬手减慢/); assert.match(markdown, /静帧正文哈希：/);
  assert.deepEqual(record.entries[0].images.map(image => image.id), ['IMG_A', 'IMG_B']);
  assert.equal(record.entries[1].videoPromptHash, promptHash(workflow.videoShots[0].videoPrompt));
  assert.equal(workflow.images[0].approval.status, 'pending');
  await assert.rejects(importVideoFeedback(directory, workflow, file), /重复记录/);
  const stale = track(path.join(directory, '陈旧意见.json')); save(stale, { schemaVersion: 1, projectId: workflow.projectId, revision: 2, workflowHash: promptHash(JSON.stringify(workflow)), comments: [{ shotId: 'S07a', note: '意见' }] });
  await assert.rejects(importVideoFeedback(directory, workflow, stale), /版本不匹配/);
  const invalid = feedback([{ shotId: 'MISSING', note: '不能记录未知镜头' }]);
  await assert.rejects(importVideoFeedback(directory, workflow, invalid), /未知镜号/);
});

test('Excel feedback imports only the designated user comments and rejects content/formula/image tampering', async t => {
  const { directory, plan, workflow, track, seal, importFeedback } = fixture(t);
  seal(workflow);
  const { exportVisualExcel } = await import('../scripts/export_visual_excel.mjs');
  const files = await exportVisualExcel(plan, JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf8')), 6, null, null, { directory, workflow });
  const baseline = files.find(file => file.filename.endsWith('.xlsx')).buffer;
  const make = async (name, change) => {
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(baseline); change(workbook);
    const file = track(path.join(directory, name)); fs.writeFileSync(file, await workbook.xlsx.writeBuffer()); return file;
  };
  const good = await make('填写.xlsx', workbook => { workbook.getWorksheet('分镜脚本').getCell('J2').value = '=保持右臂位置'; });
  const imported = await importFeedback(workflow, good);
  assert.equal(imported.imported, 1);
  assert.equal(JSON.parse(fs.readFileSync(imported.file, 'utf8')).entries[0].note, '=保持右臂位置');
  await assert.rejects(importVideoFeedback(directory, workflow, good), /重复记录/);
  const changed = await make('改正文.xlsx', workbook => { workbook.getWorksheet('分镜脚本').getCell('F2').value = '更改冻结正文'; });
  await assert.rejects(importVideoFeedback(directory, workflow, changed), /非填写区/);
  const formula = await make('公式.xlsx', workbook => { workbook.getWorksheet('分镜脚本').getCell('J2').value = { formula: '1+1' }; });
  await assert.rejects(importVideoFeedback(directory, workflow, formula), /公式/);
  const image = await make('改图.xlsx', workbook => { workbook.model.media[0].buffer = Buffer.from('changed'); workbook.getWorksheet('分镜脚本').getCell('J2').value = '意见'; });
  await assert.rejects(importVideoFeedback(directory, workflow, image), /图片内容/);
});

test('optional video parameters and music export as complete rows and remain bound during feedback', async t => {
  const { directory, plan, workflow, track, seal, importFeedback } = fixture(t);
  const { exportVisualExcel } = await import('../scripts/export_visual_excel.mjs');
  const project = JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf8'));
  const exportWorkbook = async () => {
    const files = await exportVisualExcel(plan, project, 6, null, null, { directory, workflow });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(files.find(file => file.filename.endsWith('.xlsx')).buffer);
    return workbook;
  };
  const before = await exportWorkbook();
  const extraTypes = ['全片视频参数', '音乐', '视频参数'];
  assert.deepEqual(before.getWorksheet('生成Prompt').getRow(1).values.slice(1), ['类型', '对应镜号或名称', '完整Prompt']);
  before.getWorksheet('生成Prompt').eachRow((row, index) => { if (index > 1) assert.ok(!extraTypes.includes(row.getCell(1).value)); });
  workflow.generationSettings = '横向16:9，先480p试片，通过后将原样片升级至1080p。';
  workflow.musicPrompt = Array.from({ length: 8 }, (_, index) => `第${index + 1}段：轻柔的无歌词器乐，木吉他与暖色电钢琴沿同一主题自然变化，不掩盖对白，保持舒展而克制的节奏。`).join('\n\n');
  workflow.videoShots[0].generationParameters = '固定机位，生成时长4秒；采用时长4秒。\n\n沿用全片画幅与画质设置，声音保留室内底噪。';
  validateVideoWorkflow(directory, workflow);
  seal(workflow);
  const workbook = await exportWorkbook(), prompts = workbook.getWorksheet('生成Prompt');
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), before.worksheets.map(sheet => sheet.name));
  assert.deepEqual(prompts.getRow(1).values, before.getWorksheet('生成Prompt').getRow(1).values);
  const rows = [];
  prompts.eachRow((row, index) => { if (index > 1) rows.push({ type: row.getCell(1).value, text: row.getCell(3).value, row: index }); });
  for (const [type, expected] of [['全片视频参数', workflow.generationSettings], ['音乐', workflow.musicPrompt], ['视频参数', workflow.videoShots[0].generationParameters]]) {
    assert.equal(rows.filter(row => row.type === type || row.type.startsWith(type + '（续')).map(row => row.text).join(''), expected);
  }
  assert.ok(rows.filter(row => row.type === '音乐' || row.type.startsWith('音乐（续')).length > 1);
  assert.equal(rows.find(row => row.type === '视频').text, workflow.videoShots[0].videoPrompt);
  const navigation = workbook.getWorksheet('分镜脚本').getCell('A2').value.hyperlink;
  const destination = prompts.getCell(navigation.split('!')[1]);
  assert.equal(destination.value, plan.shots[0].prompt.text);
  assert.ok(!extraTypes.includes(prompts.getCell(destination.row, 1).value));
  workbook.getWorksheet('分镜脚本').getCell('J2').value = '保留这套参数和音乐方向';
  const filled = track(path.join(directory, '参数意见.xlsx'));
  fs.writeFileSync(filled, await workbook.xlsx.writeBuffer());
  assert.equal((await importFeedback(workflow, filled)).imported, 1);
  prompts.getCell(rows.find(row => row.type === '视频参数').row, 3).value = '更改已冻结参数';
  const changed = track(path.join(directory, '改参数.xlsx'));
  fs.writeFileSync(changed, await workbook.xlsx.writeBuffer());
  await assert.rejects(importVideoFeedback(directory, workflow, changed), /非填写区/);
});

test('feedback uses the actual updated workbook baseline when fixed continuation rows differ from a fresh export', async t => {
  const { directory, plan, workflow, track, seal, importFeedback } = fixture(t);
  const { exportVisualExcel } = await import('../scripts/export_visual_excel.mjs');
  workflow.videoShots[0].videoPrompt = Array.from({ length: 16 }, (_, index) =>
    `第${index + 1}段，人物保持站姿，缓慢抬起手臂，目光始终落在桌面。镜头保持平视中景，窗侧柔光照亮面部，灰衫、木桌与窗户的位置不变。`).join('\n\n');
  seal(workflow);
  const first = await exportVisualProject(directory, { videoWorkflow: workflow }); first.forEach(track);
  const filename = first.find(file => file.endsWith('.xlsx')), original = new ExcelJS.Workbook();
  await original.xlsx.load(fs.readFileSync(filename));
  const fixedRows = original.getWorksheet('生成Prompt').rowCount;
  original.getWorksheet('分镜脚本').getCell('J2').value = '上一版意见：抬手还要慢一点。';
  fs.writeFileSync(filename, Buffer.from(await original.xlsx.writeBuffer()));
  assert.equal((await importFeedback(workflow, filename)).imported, 1);
  const next = structuredClone(workflow); next.revision++;
  next.videoShots[0].videoPrompt = '固定机位，人物慢慢抬手。';
  seal(next);
  const updated = await exportVisualProject(directory, { videoWorkflow: next }); updated.forEach(track);
  assert.equal(updated.find(file => file.endsWith('.xlsx')), filename);
  const actual = new ExcelJS.Workbook(); await actual.xlsx.load(fs.readFileSync(filename));
  assert.equal(actual.getWorksheet('生成Prompt').rowCount, fixedRows);
  assert.equal(actual.getWorksheet('分镜脚本').getCell('J2').value, '上一版意见：抬手还要慢一点。');
  await assert.rejects(importVideoFeedback(directory, next, filename), /没有填写新意见|没有新意见/);
  const [freshFile] = await exportVisualExcel(plan, JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf8')), 6, null, null, { directory, workflow: next });
  const fresh = new ExcelJS.Workbook(); await fresh.xlsx.load(freshFile.buffer);
  assert.ok(fresh.getWorksheet('生成Prompt').rowCount < fixedRows);
  actual.getWorksheet('分镜脚本').getCell('J2').value = '保留原表排版，抬手节奏可以。';
  actual.getWorksheet('分镜脚本').getColumn(6).width = 46;
  fs.writeFileSync(filename, Buffer.from(await actual.xlsx.writeBuffer()));
  const result = await importFeedback(next, filename);
  const record = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  assert.equal(result.imported, 1);
  assert.equal(record.revision, 2);
  assert.equal(record.entries[0].videoPromptHash, promptHash(next.videoShots[0].videoPrompt));
  assert.equal(record.entries[0].note, '保留原表排版，抬手节奏可以。');
});
