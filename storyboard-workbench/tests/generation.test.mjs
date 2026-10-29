import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ExcelJS from '../scripts/vendor/exceljs.cjs';
import { sealPlan, sourceHash, promptHash, dimensions, validateVisualPlan, exportVisualProject } from '../scripts/visual.mjs';
import { validateGenerationManifest } from '../scripts/generation.mjs';

const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
function fixture(t) {
  // The Windows sandbox temp volume denies rename; atomic delivery needs the writable workspace.
  const directory = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generation-contract-'));
  const exportedFiles = new Set(), exportFolders = new Set();
  t.after(() => {
    const remove = file => { const target = path.join(directory, file); if (fs.existsSync(target)) fs.unlinkSync(target); };
    for (const relative of ['excel-delivery/records', 'excel-delivery/snapshots']) {
      const folder = path.join(directory, relative);
      if (fs.existsSync(folder)) {
        for (const name of fs.readdirSync(folder)) exportedFiles.add(path.join(folder, name));
        exportFolders.add(folder); exportFolders.add(path.dirname(folder));
      }
    }
    remove('excel-delivery.json');
    remove('excel-delivery.lock');
    remove('excel-delivery.pending.json');
    for (const filename of exportedFiles) if (fs.existsSync(filename)) fs.unlinkSync(filename);
    for (const folder of [...exportFolders].sort((a, b) => b.length - a.length)) if (fs.existsSync(folder)) fs.rmdirSync(folder);
    remove('images/T_PERSON.png');
    remove('images/T_ROOM.png');
    if (fs.existsSync(path.join(directory, 'exports'))) fs.rmdirSync(path.join(directory, 'exports'));
    if (fs.existsSync(path.join(directory, 'images'))) fs.rmdirSync(path.join(directory, 'images'));
    remove('project.json');
    remove('visual-plan.json');
    remove('character-prompts.json');
    remove('scene-prompts.json');
    remove('generation-manifest.json');
    remove('source.xlsx');
    fs.rmdirSync(directory);
  });
  fs.writeFileSync(path.join(directory, 'source.xlsx'), 'fixture');
  const project = { source: { path: 'source.xlsx', sha256: promptHash('fixture') }, shots: [{ id: 'S1', original: '一人拿杯。' }], references: [] };
  save(path.join(directory, 'project.json'), project);
  const text = '一人右手握住白色杯子，站在窗边，平视中景，脸和手清楚。';
  const shot = { id: 'V1', sourceShotIds: ['S1'], locationId: 'ROOM', seconds: 2, dimensions: Object.fromEntries(dimensions.map(([key]) => [key, '一人窗边持杯。'])),
    shotSchema: { referenceIds: [], subjects: [{ assetId: 'PERSON', referenceIds: [] }], props: [{ id: 'CUP', name: '杯子', holderAssetIds: ['PERSON'], referenceIds: [] }], relations: [] },
    transition: { fromShotIds: [], entry: '站立', exit: '持杯', cut: '开场' }, motion: '站立持杯。', reuseOf: null, prompt: { text },
    review: { promptHash: promptHash(text), reviewer: 'test', rubricVersion: 'visual-v1', scores: dimensions.map(([dimension]) => ({ dimension, score: 4, evidence: '一人', reason: '测试证据' })), strengths: ['主体明确'], weaknesses: [], rewrite: { needed: false, reason: '不改稿', executed: false } } };
  const plan = sealPlan(directory, { schemaVersion: 1, mode: 'visual-excel-v1', title: '生成隔离样例', spec: { aspectRatio: '16:9', resolution: '1920x1080', style: '写实', duration: { mode: 'estimate', basis: '动作估计' } },
    productionInventory: { characters: [{ id: 'PERSON', name: '人物', description: '短发灰衫', basis: '导演设计' }], locations: [{ id: 'ROOM', name: '房间', description: '窗与桌子', basis: '导演设计' }] },
    props: [{ id: 'CUP', name: '杯子', description: '白色杯子' }], references: [], designNotes: ['同一人物与场景'], shots: [shot, { ...structuredClone(shot), id: 'V2', reuseOf: 'V1', transition: { ...shot.transition, fromShotIds: ['V1'] } }], calibration: [] });
  const header = { schemaVersion: 1, projectId: plan.projectId, sourcePlanHash: promptHash(JSON.stringify(plan)) };
  const characters = { ...header, characters: [{ assetId: 'PERSON', base: { mode: 'generate', text: '同一人物正面、侧面和背面三联图。', referenceIds: [], basis: '人物资产设计' }, optionalDetails: [] }] };
  const locations = { ...header, locations: [{ assetId: 'ROOM', base: { mode: 'generate', text: '同一房间三个互补机位三联图。', referenceIds: [], basis: '固定空间设计' } }] };
  const task = (id, phase, targetType, targetId, text) => ({ id, phase, targetType, targetId, promptHash: promptHash(text), count: 1, status: 'planned', inputReferenceIds: [], output: null, approval: { status: 'pending', by: null } });
  const manifest = { ...header, workflow: { provider: 'imagegen', maxConcurrency: 2, assetApprovalRequired: true, imagesPerPrompt: 1 }, tasks: [task('T_PERSON', 'assets', 'character', 'PERSON', characters.characters[0].base.text), task('T_ROOM', 'assets', 'location', 'ROOM', locations.locations[0].base.text), task('T_SHOT', 'storyboards', 'shot', 'V1', text)] };
  const persist = () => {
    for (const entry of plan.shots) entry.prompt.sourceHash = sourceHash(project, plan, entry);
    const planHash = promptHash(JSON.stringify(plan));
    for (const bundle of [characters, locations, manifest]) bundle.sourcePlanHash = planHash;
    for (const [file, value] of Object.entries({ 'project.json': project, 'visual-plan.json': plan, 'character-prompts.json': characters, 'scene-prompts.json': locations, 'generation-manifest.json': manifest })) save(path.join(directory, file), value);
  };
  const approveAssets = () => {
    fs.mkdirSync(path.join(directory, 'images'), { recursive: true });
    for (const entry of manifest.tasks.filter(task => task.phase === 'assets')) {
      const bytes = Buffer.from(`image fixture ${entry.id}`), output = { path: `images/${entry.id}.png`, sha256: promptHash(bytes) };
      fs.writeFileSync(path.join(directory, output.path), bytes);
      Object.assign(entry, { status: 'succeeded', output, approval: { status: 'confirmed', by: 'user', confirmedAt: '2026-10-15T00:00:00Z' } });
      plan.references.push({ id: `R_${entry.targetId}`, origin: 'generated-confirmed', assetId: entry.targetId, generationTaskId: entry.id, ...output, purpose: '本项目确认资产', userProvided: false });
    }
    for (const entry of plan.shots) { entry.shotSchema.referenceIds = ['R_ROOM']; entry.shotSchema.subjects[0].referenceIds = ['R_PERSON']; }
    manifest.tasks[2].inputReferenceIds = ['R_ROOM', 'R_PERSON'];
    persist();
  };
  persist();
  const exportFiles = async options => {
    const files = await exportVisualProject(directory, options);
    for (const filename of files) {
      assert.ok(path.relative(directory, filename) && !path.relative(directory, filename).startsWith('..'));
      exportedFiles.add(filename); exportFolders.add(path.dirname(filename));
    }
    return files;
  };
  return { directory, plan, project, characters, locations, manifest, persist, approveAssets, exportFiles };
}

test('planned manifest validates exact assets and independent shots; script workbook preserves scene prose', async t => {
  const { directory, manifest, locations, exportFiles } = fixture(t);
  assert.deepEqual(Object.fromEntries(Object.entries(validateGenerationManifest(directory)).filter(([key]) => key !== 'manifest')), { assetTasks: 2, storyboardTasks: 1 });
  const files = await exportFiles();
  assert.equal(files.length, 2);
  assert.equal(files.filter(file => file.endsWith('.xlsx')).length, 1);
  assert.ok(files.filter(file => file.endsWith('.xlsx')).every(file => path.dirname(file) === path.join(directory, 'exports', 'delivery-000001')));
  assert.ok(files.filter(file => file.endsWith('.md')).every(file => path.dirname(file) === path.join(directory, 'excel-delivery', 'records')));
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(fs.readFileSync(files.find(file => file.endsWith('_分镜脚本.xlsx'))));
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['分镜脚本', '生成Prompt', '人物与场景']);
  const sceneRows = [];
  workbook.getWorksheet('生成Prompt').eachRow(row => { if (row.getCell(1).text === '场景') sceneRows.push(row.getCell(3).text); });
  assert.deepEqual(sceneRows, [locations.locations[0].base.text]);
  const log = fs.readFileSync(files.find(file => file.endsWith('.md')), 'utf8');
  assert.ok(log.includes('文本评分与证据') && log.includes('测试证据'));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/generation.mjs', import.meta.url)), 'validate', directory], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).storyboardTasks, 1);
  assert.equal(manifest.tasks.some(task => task.targetId === 'V2'), false);
});

test('static and video exports validate a manifest and its plan together once per call', { concurrency: false }, async t => {
  for (const video of [false, true]) {
    const f = fixture(t), planFile = path.join(f.directory, 'visual-plan.json'), originalRead = fs.readFileSync;
    const workflow = { schemaVersion: 1, projectId: f.plan.projectId, revision: 1, sourcePlanHash: promptHash(JSON.stringify(f.plan)), images: [],
      videoShots: f.plan.shots.map(shot => ({ id: `VIDEO_${shot.id}`, shotIds: [shot.id], startImageId: null, endImageId: null,
        startState: '人物站定', action: '保持持杯', camera: '固定机位', endState: '人物站定', invariants: ['服装不变'], durationSeconds: shot.seconds, dialogue: '', sound: '' })),
      timeline: f.plan.shots.map(shot => ({ shotId: shot.id, seconds: shot.seconds, reason: '隔离软件样例' })), pilotVideoShotIds: [], results: [] };
    const options = video ? { videoWorkflow: workflow } : undefined; let reads = 0;
    fs.readFileSync = (filename, ...args) => {
      if (typeof filename === 'string' && path.resolve(filename) === planFile) reads++;
      return originalRead(filename, ...args);
    };
    try { await f.exportFiles(options); }
    finally { fs.readFileSync = originalRead; }
    assert.equal(reads, 1, `${video ? '视频' : '静态'}导出复用同一次源校验`);
    f.manifest.tasks[0].count = 2; f.persist();
    await assert.rejects(f.exportFiles(options), /仅生成一张/);
  }
});

test('manifest rejects multiple images, missing tasks, prop tasks, reuse tasks and stale Prompt hashes', t => {
  const { directory, manifest } = fixture(t);
  for (const change of [value => { value.tasks[0].count = 2; }, value => { value.tasks.pop(); }, value => { value.tasks[2].targetType = 'prop'; value.tasks[2].targetId = 'CUP'; }, value => { value.tasks[2].targetId = 'V2'; }, value => { value.tasks[0].promptHash = 'stale'; }]) {
    const changed = structuredClone(manifest); change(changed);
    assert.throws(() => validateGenerationManifest(directory, changed), /仅生成一张|逐一覆盖|道具或复用帧|正文不一致/);
  }
});

test('storyboard submission requires all needed assets confirmed and real mapped input images', t => {
  const { directory, manifest, approveAssets, persist } = fixture(t);
  manifest.tasks[2].status = 'submitted';
  assert.throws(() => validateGenerationManifest(directory, manifest), /尚未经用户确认/);
  approveAssets();
  assert.equal(validateGenerationManifest(directory).storyboardTasks, 1);
  manifest.tasks[2].inputReferenceIds.pop(); persist();
  assert.throws(() => validateGenerationManifest(directory), /实际输入与镜头参考不一致/);
});

test('generated references detect false user provenance, missing approval, wrong asset binding and altered files', t => {
  const value = fixture(t); value.approveAssets();
  const { directory, plan, manifest } = value;
  const falseOrigin = structuredClone(plan); falseOrigin.references[0].userProvided = true;
  assert.throws(() => validateVisualPlan(directory, falseOrigin), /不得伪装/);
  const pending = structuredClone(manifest); pending.tasks[0].approval = { status: 'pending', by: null };
  assert.throws(() => validateGenerationManifest(directory, pending), /经用户确认/);
  const wrongPerson = structuredClone(plan); wrongPerson.shots[0].shotSchema.subjects[0].referenceIds = ['R_ROOM'];
  assert.throws(() => validateVisualPlan(directory, wrongPerson), /人物参考资产映射/);
  const wrongScene = structuredClone(plan); wrongScene.shots[0].shotSchema.referenceIds = ['R_PERSON']; wrongScene.shots[0].shotSchema.subjects[0].referenceIds = [];
  assert.throws(() => validateVisualPlan(directory, wrongScene), /场景参考资产映射/);
  fs.appendFileSync(path.join(directory, manifest.tasks[0].output.path), 'tampered');
  assert.throws(() => validateGenerationManifest(directory), /图片哈希不一致/);
});

test('success requires local output; unknown and failed states cannot bypass second stage readiness', t => {
  const { directory, manifest } = fixture(t);
  const missing = structuredClone(manifest); missing.tasks[0].status = 'succeeded';
  assert.throws(() => validateGenerationManifest(directory, missing), /缺少输出/);
  for (const status of ['unknown', 'failed']) {
    const changed = structuredClone(manifest); changed.tasks[2].status = status;
    assert.throws(() => validateGenerationManifest(directory, changed), /尚未经用户确认/);
  }
  const outside = structuredClone(manifest); Object.assign(outside.tasks[0], { status: 'succeeded', output: { path: '../outside.png', sha256: promptHash('outside') } });
  assert.throws(() => validateGenerationManifest(directory, outside), /路径必须位于/);
});

test('legacy text projects remain valid and export without sidecars or a manifest', async t => {
  const { directory, exportFiles } = fixture(t);
  fs.unlinkSync(path.join(directory, 'character-prompts.json'));
  fs.unlinkSync(path.join(directory, 'scene-prompts.json'));
  fs.unlinkSync(path.join(directory, 'generation-manifest.json'));
  assert.equal(validateVisualPlan(directory).plan.shots.length, 2);
  const firstFiles = await exportFiles(), firstWorkbook = firstFiles.find(file => file.endsWith('_分镜脚本.xlsx'));
  assert.equal(firstFiles.length, 2);
  const original = fs.readFileSync(firstWorkbook), nextFiles = await exportFiles();
  assert.equal(nextFiles.find(file => file.endsWith('_分镜脚本.xlsx')), firstWorkbook);
  assert.deepEqual(fs.readFileSync(firstWorkbook), original);
});
