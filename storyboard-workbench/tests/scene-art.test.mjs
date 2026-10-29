import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from '../scripts/vendor/exceljs.cjs';
import { dimensionsFor, promptHash, sealPlan } from '../scripts/visual.mjs';
import { assetPlanHash } from '../scripts/visual_v2.mjs';
import { validateSceneBundle, exportVisualExcel, exportVisualMarkdown } from '../scripts/export_visual_excel.mjs';
import { validateVideoWorkflow, sealVideoWorkflow, importVideoFeedback } from '../scripts/video.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF7sAAAAASUVORK5CYII=', 'base64');
const textValue = value => value && typeof value === 'object' ? value.text : value;

function sceneDesign(shotId, room) {
  return {
    useAndUsers: `脚本事实：人物在${room}停留；导演补全：按日常休息与通行安排空间。`,
    scriptFacts: [`人物在${room}停留。`],
    layout: '北墙设窗，东侧入口与主要家具之间保留连续通道。',
    furnishingLayers: { large: ['主家具靠西墙，支撑人物休息。'], medium: ['矮柜贴南墙收纳用品，不进入通道。'], small: ['矮柜上放一只杯子，便于伸手取用。'] },
    useTraces: '靠垫保留轻微压痕，杯子下有杯垫，走道保持整洁。',
    materials: '墙面哑光，木柜有细木纹，棉布坐垫保留柔软褶皱。',
    composition: '主家具旁承载日用品细节，入口与人物手、脸周围留空。',
    invariants: ['后台共用锚点：北窗、东门、西侧主家具不得随机位搬动。'],
    views: [{ id: 'VIEW_MAIN', shotIds: [shotId], position: '入口斜侧平视', visible: '主家具与北窗进入画面。', keepClear: '人物手部和门口通道不被遮挡。' }],
    constraintReview: [{ original: '后台旧约束原句：整个空间没有物件。', source: '历史场景Prompt', decision: 'narrow', reason: '保持动作区畅通，同时保留有用途的日用品。', replacement: '入口与人物动作区保持畅通，杯子只放在矮柜上。' }]
  };
}

function fixture() {
  const text = '一人站在窗边，双手垂下，目光落在桌面。平视中景，窗侧柔光照亮面部与双手。';
  const asset = (id, name) => ({ id, name, description: `${name}的历史简要设定。`, basis: '软件隔离样例' });
  const project = { title: '场景美术样例', references: [], shots: ['S01', 'S02'].map((id, index) => ({ id: `SRC${index + 1}`, original: '一人站在窗边。', originalFields: [], sourceRef: { sheet: '脚本', contentCell: `B${index + 2}` } })) };
  const plan = { schemaVersion: 1, mode: 'visual-excel-v1', projectId: 'scene-art-fixture', title: project.title,
    spec: { aspectRatio: '16:9', resolution: '1920x1080', style: '写实', duration: { mode: 'estimate', basis: '镜头各两秒' } },
    productionInventory: { characters: [asset('PERSON', '人物')], locations: [asset('BEDROOM', '卧室'), asset('LIVING', '客厅')] }, props: [], references: [], designNotes: ['本次软件隔离样例'], calibration: [],
    shots: ['S01', 'S02'].map((id, index) => ({ id, sourceShotIds: [`SRC${index + 1}`], locationId: index ? 'LIVING' : 'BEDROOM', seconds: 2,
      dimensions: Object.fromEntries(dimensionsFor('visual-v1').map(([key]) => [key, '一人站在窗边，双手垂下，平视中景。'])),
      shotSchema: { referenceIds: [], subjects: [{ assetId: 'PERSON', referenceIds: [], appearance: '短发', clothing: '灰衫', pose: '站直' }], props: [], relations: [] },
      transition: { fromShotIds: index ? ['S01'] : [], entry: '人物站定', exit: '保持站姿', cut: '直接切换' }, motion: '站定两秒。', reuseOf: null, prompt: { text } })) };
  return { plan, project };
}

function bundleFor(plan, designed = true) {
  return { schemaVersion: 1, projectId: plan.projectId, sourcePlanHash: plan.schemaVersion === 2 ? assetPlanHash(plan, 'locations') : promptHash(JSON.stringify(plan)), ...(designed ? { designStageVersion: 1 } : {}),
    locations: plan.productionInventory.locations.map(asset => ({ assetId: asset.id, ...(designed ? { sceneDesign: sceneDesign(plan.shots.find(shot => shot.locationId === asset.id).id, asset.name) } : {}),
      base: { mode: 'generate', text: `${asset.name}的完整新场景Prompt。平视观察主家具、北窗与连贯的入口通道，哑光墙面和棉布坐垫清晰可辨。`, basis: '本次共用场景美术设计', referenceIds: [] } })) };
}

function localFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-art-'));
  const track = filename => { t.after(() => { if (fs.existsSync(filename)) fs.unlinkSync(filename); }); return filename; };
  const save = (name, value) => { const filename = track(path.join(directory, name)); fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', 'utf8'); return filename; };
  const { plan: input, project } = fixture();
  const source = track(path.join(directory, '原稿.txt')); fs.writeFileSync(source, '一人站在卧室，随后切到客厅。', 'utf8');
  project.source = { path: '原稿.txt', sha256: promptHash(fs.readFileSync(source)), sheets: [] }; save('project.json', project);
  const plan = sealPlan(directory, input); track(path.join(directory, 'visual-plan.json'));
  const bundle = bundleFor(plan), filename = save('scene-art-v2.json', bundle);
  const workflow = { schemaVersion: 1, projectId: plan.projectId, revision: 1, sourcePlanHash: promptHash(JSON.stringify(plan)), sceneBundleRef: { path: 'scene-art-v2.json', sha256: promptHash(fs.readFileSync(filename)) },
    images: [], videoShots: plan.shots.map((shot, index) => ({ id: `V0${index + 1}`, shotIds: [shot.id], startImageId: null, endImageId: null,
      startState: '人物站定。', action: '保持站姿。', camera: '固定机位。', endState: '人物仍然站定。', invariants: ['沿用共用场景布局。'], durationSeconds: 2, dialogue: '', sound: '室内底噪。' })),
    timeline: plan.shots.map(shot => ({ shotId: shot.id, seconds: 2, reason: '隔离样例时长。' })), pilotVideoShotIds: [], results: [] };
  return { directory, plan, project, bundle, workflow, save, track };
}

test('six concrete scene design components are required only for the new design contract', () => {
  const { plan } = fixture(), bundle = bundleFor(plan);
  assert.equal(validateSceneBundle(bundle, plan), bundle);
  for (const field of ['useAndUsers', 'layout', 'useTraces', 'materials', 'composition', 'furnishingLayers']) {
    const broken = structuredClone(bundle); delete broken.locations[0].sceneDesign[field];
    assert.throws(() => validateSceneBundle(broken, plan), /须为/);
  }
  for (const field of ['scriptFacts', 'invariants', 'views']) {
    const broken = structuredClone(bundle); broken.locations[0].sceneDesign[field] = [];
    assert.throws(() => validateSceneBundle(broken, plan), /非空/);
  }
  const legacy = bundleFor(plan, false); assert.equal(validateSceneBundle(legacy, plan), legacy);
  assert.throws(() => validateSceneBundle({ ...legacy, designStageVersion: 1 }, plan), /sceneDesign/);
  const current = { ...plan, schemaVersion: 2, rules: { files: [{ path: 'references/scene-art-direction.md', sha256: 'rule-hash' }] } };
  assert.throws(() => validateSceneBundle(bundleFor(current, false), current), /sceneDesign/);
  const old = { ...current, rules: { files: [{ path: 'references/directing.md', sha256: 'old-rule-hash' }] } };
  assert.ok(validateSceneBundle(bundleFor(old, false), old));
  const sparse = structuredClone(bundle); sparse.locations[0].sceneDesign.furnishingLayers.medium = []; sparse.locations[0].sceneDesign.furnishingLayers.small = [];
  sparse.locations[0].sceneDesign.composition = '本镜只保留主家具与通道，不使用中小型陈设。'; assert.ok(validateSceneBundle(sparse, plan));
});

test('scene views cover their real shots once and constraint edits retain explicit provenance', () => {
  const { plan } = fixture(), bundle = bundleFor(plan);
  for (const [change, error] of [
    [design => { design.views[0].shotIds = ['S02']; }, /本场景真实镜号/],
    [design => { design.views.push({ ...design.views[0], id: 'OTHER' }); }, /重复绑定/],
    [design => { design.views[0].shotIds = ['S01', 'UNKNOWN']; }, /真实镜号/],
    [design => { design.constraintReview[0].source = ''; }, /source须为非空文本/],
    [design => { design.constraintReview[0].reason = ''; }, /reason须为非空文本/],
    [design => { delete design.constraintReview[0].replacement; }, /替换内容/],
    [design => { design.constraintReview[0].decision = 'semantic-passed'; }, /处理方式无效/]
  ]) { const broken = structuredClone(bundle); change(broken.locations[0].sceneDesign); assert.throws(() => validateSceneBundle(broken, plan), error); }
  const empty = structuredClone(bundle); empty.locations[0].sceneDesign.constraintReview = []; assert.ok(validateSceneBundle(empty, plan));
});

test('complete scene design and Prompt survive continuation rows while old images are captioned', async t => {
  const { directory, plan, project, bundle, track } = localFixture(t), design = bundle.locations[0].sceneDesign;
  design.layout += '\n' + Array.from({ length: 130 }, () => '入口到家具之间始终保留通道🙂。'.repeat(20)).join('\n\n') + '\n布局尾句。';
  bundle.locations[0].base.text += '\n' + Array.from({ length: 220 }, () => '完整场景正文，保持布置。'.repeat(10)).join('\n\n') + '\n场景正文尾句。';
  const image = track(path.join(directory, '旧参考.png')); fs.writeFileSync(image, png);
  const context = { directory, sceneBundle: bundle, workflow: { assetImages: [{ assetId: 'BEDROOM', path: '旧参考.png', sha256: promptHash(png), description: '不应覆盖完整场景设计的简短摘要。', caption: '旧参考图，陈设待更新' }] } };
  const original = JSON.stringify(plan), [file] = await exportVisualExcel(plan, project, 4, null, null, context), workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(file.buffer);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['分镜脚本', '生成Prompt', '人物与场景']);
  const settings = workbook.getWorksheet('人物与场景'), rows = settings.getSheetValues().slice(2).filter(row => textValue(row?.[1])?.startsWith('卧室'));
  assert.ok(rows.length > 2); const complete = rows.map(row => row[4]).join('');
  let offset = 0;
  for (const [index, row] of rows.entries()) {
    offset += row[4].length;
    if (index < rows.length - 1) assert.equal(complete[offset - 1], '\n', '设计续行保持完整原段落');
    const lines = row[4].split('\n').reduce((sum, paragraph) => sum + Math.max(1, Math.ceil([...paragraph].reduce((units, char) => units + (char.codePointAt(0) > 255 ? 2 : 1), 0) / ((settings.getColumn(4).width - 2) * 0.75))), 0);
    const physicalRow = settings.getRows(2, settings.rowCount - 1).find(item => item.getCell(4).text === row[4]);
    assert.ok(lines <= 20); assert.ok(physicalRow.height >= Math.max(54, lines * 18 + 18));
    assert.equal(physicalRow.getCell(4).font.size, 11);
  }
  for (const field of ['useAndUsers', 'layout', 'useTraces', 'materials', 'composition']) assert.ok(complete.includes(design[field]), `${field}完整保留`);
  for (const text of [...design.scriptFacts, ...Object.values(design.furnishingLayers).flat()]) assert.ok(complete.includes(text));
  for (const label of ['脚本事实', '导演补全', '空间用途与使用者', '核心布局', '陈设层次', '使用痕迹', '材质层次', '画面取舍']) assert.ok(complete.includes(label));
  assert.ok(!complete.includes('简短摘要')); assert.ok(settings.getRows(2, settings.rowCount - 1).every(row => row.height <= 409));
  assert.ok(rows.slice(1).every(row => row[1] === '卧室（续）' && row[3] == null));
  assert.equal(settings.getImages().length, 1); assert.equal(settings.getImages()[0].range.tl.nativeRow + 1, settings.getSheetValues().findIndex(row => row?.[1] === '卧室'));
  assert.match(rows[0][3].text, /旧参考图，陈设待更新.*查看原图/);
  assert.ok(rows.every(row => row[5].hyperlink === "#'分镜脚本'!A2"));
  const prompts = workbook.getWorksheet('生成Prompt').getSheetValues().slice(2).filter(row => row?.[1]?.startsWith('场景') && textValue(row?.[2]) === '卧室').map(row => row[3]).join('');
  assert.equal(prompts, bundle.locations[0].base.text); assert.equal(JSON.stringify(plan), original);
  const values = workbook.worksheets.flatMap(sheet => sheet.getSheetValues().flatMap(row => row ?? [])).map(textValue).join('\n');
  assert.ok(!values.includes('后台旧约束原句')); assert.ok(!values.includes('后台共用锚点'));
  const log = exportVisualMarkdown(plan, project, null, context); assert.match(log, /后台旧约束原句/); assert.match(log, /后台共用锚点/);
  t.after(() => fs.rmdirSync(directory));
});

test('explicit scene bundle references reject stale hashes and escaped paths', t => {
  const { directory, bundle, workflow } = localFixture(t);
  assert.deepEqual(validateVideoWorkflow(directory, workflow).sceneBundle, bundle);
  const stale = structuredClone(workflow); stale.sceneBundleRef.sha256 = '0'.repeat(64); assert.throws(() => validateVideoWorkflow(directory, stale), /哈希/);
  const escaped = structuredClone(workflow); escaped.sceneBundleRef.path = '../outside.json'; assert.throws(() => validateVideoWorkflow(directory, escaped), /项目目录/);
  const badCaption = structuredClone(workflow); badCaption.assetImages = [{ assetId: 'BEDROOM', path: 'scene-art-v2.json', sha256: workflow.sceneBundleRef.sha256, caption: 1 }];
  assert.throws(() => validateVideoWorkflow(directory, badCaption), /图片说明须为非空文本/);
  t.after(() => fs.rmdirSync(directory));
});

test('Excel feedback uses the explicitly bound new scene Prompt instead of the default historical bundle', async t => {
  const { directory, plan, project, bundle, workflow, save, track } = localFixture(t);
  const legacy = bundleFor(plan, false); legacy.locations[0].base.text = '历史场景正文：旧版空房间。'; save('scene-prompts.json', legacy);
  const sealed = sealVideoWorkflow(directory, workflow); track(sealed.file);
  const checked = validateVideoWorkflow(directory, workflow);
  const [file] = await exportVisualExcel(plan, project, 4, null, checked.report, { directory, workflow, sceneBundle: checked.sceneBundle });
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(file.buffer);
  assert.ok(workbook.getWorksheet('生成Prompt').getSheetValues().some(row => row?.[3] === bundle.locations[0].base.text));
  workbook.getWorksheet('分镜脚本').getCell('J2').value = '保留新的场景陈设设计。';
  const feedback = track(path.join(directory, '用户意见.xlsx')); fs.writeFileSync(feedback, Buffer.from(await workbook.xlsx.writeBuffer()));
  const imported = await importVideoFeedback(directory, workflow, feedback); track(imported.file); track(imported.markdownFile);
  assert.equal(imported.imported, 1); assert.equal(JSON.parse(fs.readFileSync(imported.file, 'utf8')).entries[0].note, '保留新的场景陈设设计。');
  t.after(() => fs.rmdirSync(path.join(directory, 'video-workflow', 'feedback')));
  t.after(() => fs.rmdirSync(path.join(directory, 'video-workflow')));
  t.after(() => fs.rmdirSync(directory));
});
