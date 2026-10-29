import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from '../scripts/vendor/exceljs.cjs';
import { exportVisualExcel } from '../scripts/export_visual_excel.mjs';
import { deliverExcel, deliveryBaseline } from '../scripts/excel_delivery.mjs';
import { promptHash } from '../scripts/visual.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF7sAAAAASUVORK5CYII=', 'base64');
const redPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAFElEQVR4nGN4piFHEmIY1TAoNAAA1Biowc5FwHgAAAAASUVORK5CYII=', 'base64');
const bluePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAFElEQVR4nGMQcbtDEmIY1TAoNAAAy6SuYQIZ3CcAAAAASUVORK5CYII=', 'base64');
const greenPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAFElEQVR4nGPgWuBGEmIY1TAoNAAALkWHAQV+UPMAAAAASUVORK5CYII=', 'base64');
const readWorkbook = async bytes => { const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes); return workbook; };
const paragraphs = count => Array.from({ length: count }, (_, index) => `第${index + 1}段，窗边的人保持站定，双手自然垂放，目光停在桌面。木桌靠窗，右侧通道留空，窗侧柔光照亮面部，平视中景保持人物与桌子的空间关系。`).join('\n\n');
const promptRows = (book, type, name) => book.getWorksheet('生成Prompt').getRows(2, book.getWorksheet('生成Prompt').rowCount - 1)
  .filter(row => row.getCell(1).text.replace(/（续\d+）$/, '') === type && row.getCell(2).text === name);
const imageAnchors = sheet => sheet.getImages().map(image => ({ imageId: image.imageId, type: image.type,
  tl: image.range.tl?.model, br: image.range.br?.model, ext: image.range.ext, editAs: image.range.editAs, hyperlinks: image.range.hyperlinks }));
const imageAt = (book, sheet, row, column) => {
  const image = book.getWorksheet(sheet).getImages().find(item => item.range.tl.nativeRow === row - 1 && item.range.tl.nativeCol === column - 1);
  return image ? book.getImage(image.imageId) : null;
};
const imageBytes = (book, sheet, row, column) => Buffer.from(imageAt(book, sheet, row, column).buffer);

function fixture(t, text = '人物在窗边站定，双手自然垂放。') {
  // The Windows sandbox temp volume denies rename, so atomic-write fixtures use this writable workspace.
  const directory = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'excel-delivery-isolated-'));
  const files = new Set(), folders = new Set();
  const track = filename => {
    const relative = path.relative(directory, filename);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    files.add(filename);
    for (let folder = path.dirname(filename); folder !== directory; folder = path.dirname(folder)) folders.add(folder);
    return filename;
  };
  t.after(() => {
    folders.add(path.join(directory, 'exports'));
    for (const relative of ['excel-delivery/records', 'excel-delivery/snapshots']) {
      const folder = path.join(directory, relative);
      folders.add(folder); folders.add(path.dirname(folder));
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
  fs.writeFileSync(track(path.join(directory, 'image.png')), png);
  const shot = { id: 'S01', sourceShotIds: ['SOURCE'], seconds: 3, locationId: 'ROOM',
    dimensions: { moment: '人物在窗边站定', camera: '平视中景', optics: '50mm，f/4，脸与手清晰' },
    shotSchema: { subjects: [], props: [], relations: [], referenceIds: [] }, motion: '站定', reuseOf: null,
    prompt: { text }, videoPrompt: '固定机位，人物慢慢抬头后保持站定。' };
  const plan = { schemaVersion: 2, mode: 'visual-excel-v2', projectId: 'DELIVERY_TEST', title: '原位更新测试', revision: 1,
    productionInventory: { characters: [], locations: [{ id: 'ROOM', name: '窗边', description: '白墙和木桌。' }] }, shots: [shot], calibration: [] };
  const project = { shots: [{ id: 'SOURCE', original: '人物在窗边站定。', originalFields: [] }] };
  const context = { directory, workflow: { images: [{ shotId: 'S01', path: 'image.png', sha256: promptHash(png) }] } };
  const candidate = async () => (await exportVisualExcel(plan, project, 3, null, null, context))[0];
  const deliver = async (file, options = {}) => {
    const result = await deliverExcel(directory, { file, log: { filename: '制作日志.md', buffer: Buffer.from('内部日志\n', 'utf8') },
      planHash: promptHash(JSON.stringify(plan)), workflowHash: promptHash(`workflow-${plan.revision}`),
      outputDirectory: path.join(directory, 'exports'), ...options });
    result.forEach(track);
    return result;
  };
  return { directory, plan, context, candidate, deliver, track };
}

test('first delivery fixes its path and an unchanged export leaves the exact workbook untouched', async t => {
  const f = fixture(t), file = await f.candidate(), first = await f.deliver(file);
  const before = fs.readFileSync(first[0]), beforeStat = fs.statSync(first[0]);
  const again = await f.deliver(await f.candidate());
  assert.equal(again[0], first[0]);
  assert.deepEqual(fs.readFileSync(first[0]), before);
  assert.equal(fs.statSync(first[0]).mtimeMs, beforeStat.mtimeMs);
  assert.deepEqual(await deliveryBaseline(f.directory, promptHash('workflow-1')), before);
  assert.equal(await deliveryBaseline(f.directory, promptHash('unknown-workflow')), null);
  assert.equal(fs.readdirSync(path.dirname(first[0])).filter(name => name.endsWith('.xlsx')).length, 1);
});

test('binding keeps existing bytes and shorter replacement uses old rows without changing user layout, images, links or comments', async t => {
  const f = fixture(t, paragraphs(18)), first = await f.candidate(), book = await readWorkbook(first.buffer);
  const main = book.getWorksheet('分镜脚本'), prompts = book.getWorksheet('生成Prompt');
  main.getCell('J2').value = 0;
  main.getCell('F2').font = { name: 'Arial', size: 13, bold: true, color: { argb: 'FF125544' } };
  main.getColumn(6).width = 49; main.getRow(2).height = 210;
  main.pageSetup.orientation = 'portrait';
  main.getCell('A2').value = { text: 'S01', hyperlink: 'https://example.test/story/S01' };
  const oldRows = promptRows(book, '静帧', 'S01').map(row => row.number);
  assert.ok(oldRows.length > 1);
  const videoRow = promptRows(book, '视频', 'S01')[0].number;
  const existing = f.track(path.join(f.directory, '沿用的脚本.xlsx'));
  fs.writeFileSync(existing, Buffer.from(await book.xlsx.writeBuffer()));
  const original = fs.readFileSync(existing), originalBook = await readWorkbook(original);
  const bound = await f.deliver(first, { bindWorkbook: existing });
  assert.equal(bound[0], existing); assert.deepEqual(fs.readFileSync(existing), original);
  f.plan.revision++;
  f.plan.shots[0].prompt.text = '=人物站在窗边，双手垂放。\n\n白墙保持原样。';
  const replacement = await f.candidate(), defaultBook = await readWorkbook(replacement.buffer);
  assert.ok(defaultBook.getWorksheet('生成Prompt').rowCount < prompts.rowCount, '候选默认版确实会减少续行，原位更新必须保留旧行槽');
  const result = await f.deliver(replacement), updated = await readWorkbook(fs.readFileSync(result[0]));
  const updatedMain = updated.getWorksheet('分镜脚本'), updatedPrompts = updated.getWorksheet('生成Prompt');
  assert.equal(result[0], existing);
  assert.equal(updatedPrompts.rowCount, prompts.rowCount);
  assert.equal(oldRows.map(row => updatedPrompts.getCell(row, 3).text).join(''), f.plan.shots[0].prompt.text);
  assert.equal(updatedPrompts.getCell(videoRow, 3).text, f.plan.shots[0].videoPrompt);
  assert.equal(updatedMain.getCell('J2').value, 0);
  assert.deepEqual(updatedMain.getCell('F2').style, originalBook.getWorksheet('分镜脚本').getCell('F2').style);
  assert.equal(updatedMain.getColumn(6).width, 49); assert.equal(updatedMain.getRow(2).height, 210);
  assert.equal(updatedMain.pageSetup.orientation, 'portrait');
  assert.deepEqual(updatedMain.getCell('A2').value, originalBook.getWorksheet('分镜脚本').getCell('A2').value);
  assert.deepEqual(imageAnchors(updatedMain), imageAnchors(originalBook.getWorksheet('分镜脚本')));
  assert.deepEqual(updated.model.media.map(image => image.buffer), originalBook.model.media.map(image => image.buffer));
  assert.deepEqual(await deliveryBaseline(f.directory, promptHash('workflow-1')), original);
  assert.deepEqual(await deliveryBaseline(f.directory, promptHash('workflow-2')), fs.readFileSync(existing));
});

test('an originally empty remark can be filled, but a user-cleared nonempty remark remains protected', async t => {
  const f = fixture(t), [filename] = await f.deliver(await f.candidate());
  const initial = await readWorkbook(fs.readFileSync(filename));
  assert.equal(initial.getWorksheet('分镜脚本').getCell('I2').text, '');
  initial.getWorksheet('分镜脚本').getCell('I2').value = null;
  fs.writeFileSync(filename, Buffer.from(await initial.xlsx.writeBuffer()));
  assert.equal((await readWorkbook(fs.readFileSync(filename))).getWorksheet('分镜脚本').getCell('I2').value, null);
  f.plan.revision++;
  f.context.workflow.images[0].productionNote = '同轴切近景，保持支撑臂。';
  await f.deliver(await f.candidate());
  const book = await readWorkbook(fs.readFileSync(filename));
  assert.equal(book.getWorksheet('分镜脚本').getCell('I2').value, '同轴切近景，保持支撑臂。');
  book.getWorksheet('分镜脚本').getCell('I2').value = null;
  fs.writeFileSync(filename, Buffer.from(await book.xlsx.writeBuffer()));
  const before = fs.readFileSync(filename);
  f.plan.revision++;
  f.context.workflow.images[0].productionNote = '新的导演衔接备注。';
  await assert.rejects(f.deliver(await f.candidate()), /冲突/);
  assert.deepEqual(fs.readFileSync(filename), before);
});

test('a conflicting user edit is not overwritten by a new source value', async t => {
  const f = fixture(t), [filename] = await f.deliver(await f.candidate()), book = await readWorkbook(fs.readFileSync(filename));
  book.getWorksheet('生成Prompt').getCell('C2').value = '用户亲自改写的站位。';
  fs.writeFileSync(filename, Buffer.from(await book.xlsx.writeBuffer()));
  const before = fs.readFileSync(filename);
  f.plan.revision++; f.plan.shots[0].prompt.text = '导演重新改写的不同站位。';
  await assert.rejects(f.deliver(await f.candidate()), /冲突|用户.*改|手工.*改/);
  assert.deepEqual(fs.readFileSync(filename), before);
});

test('overflow and changed entity structure fail before replacing the fixed workbook', async t => {
  const f = fixture(t);
  f.plan.productionInventory.locations.push({ id: 'HALL', name: '走廊', description: '白墙和地面。' });
  const [filename] = await f.deliver(await f.candidate()), before = fs.readFileSync(filename);
  const original = f.plan.shots[0].prompt.text;
  f.plan.revision++; f.plan.shots[0].prompt.text = paragraphs(18);
  await assert.rejects(f.deliver(await f.candidate()), /空间|续行|容纳|放不下|行高|完整显示/);
  assert.deepEqual(fs.readFileSync(filename), before);
  f.plan.shots[0].prompt.text = original;
  f.plan.shots[0].locationId = 'HALL';
  await assert.rejects(f.deliver(await f.candidate()), /使用镜头|镜头关系|关联镜头|超链接/);
  assert.deepEqual(fs.readFileSync(filename), before);
  f.plan.shots[0].locationId = 'ROOM';
  f.plan.shots.push({ ...structuredClone(f.plan.shots[0]), id: 'S02' });
  await assert.rejects(f.deliver(await f.candidate()), /结构|镜头|实体|对应|映射/);
  assert.deepEqual(fs.readFileSync(filename), before);
});

test('one preflight reports all overflowing text groups and leaves the workbook untouched', async t => {
  const f = fixture(t), [filename] = await f.deliver(await f.candidate()), before = fs.readFileSync(filename);
  f.plan.revision++;
  f.plan.shots[0].prompt.text = paragraphs(18); f.plan.shots[0].videoPrompt = paragraphs(18);
  await assert.rejects(f.deliver(await f.candidate()), error => {
    assert.ok(error.conflicts.length >= 2);
    assert.ok(error.conflicts.some(item => item.groupId?.includes('静帧')));
    assert.ok(error.conflicts.some(item => item.groupId?.includes('视频')));
    assert.ok(error.conflicts.every(item => item.sheet && item.cells.length && item.message.includes('空间')));
    return true;
  });
  assert.deepEqual(fs.readFileSync(filename), before);
});

test('failed workbook and pointer renames recover without losing the old file or applying the update twice', { concurrency: false }, async t => {
  const f = fixture(t), [filename] = await f.deliver(await f.candidate());
  const pointer = path.join(f.directory, 'excel-delivery.json'), pending = path.join(f.directory, 'excel-delivery.pending.json');
  const original = fs.readFileSync(filename), originalPointer = fs.readFileSync(pointer), rename = fs.renameSync;
  f.plan.revision++; f.plan.shots[0].prompt.text = '人物在窗边站定，目光朝向桌面。';
  const firstChange = await f.candidate();
  fs.renameSync = (source, target) => {
    if (path.resolve(target) === filename) throw Object.assign(new Error('fixture-workbook-rename'), { code: 'EPERM' });
    return rename(source, target);
  };
  try { await assert.rejects(f.deliver(firstChange), /fixture-workbook-rename/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(filename), original);
  assert.deepEqual(fs.readFileSync(pointer), originalPointer);
  assert.ok(fs.existsSync(pending));
  await f.deliver(firstChange);
  assert.equal((await readWorkbook(fs.readFileSync(filename))).getWorksheet('生成Prompt').getCell('C2').text, f.plan.shots[0].prompt.text);
  assert.equal(fs.existsSync(pending), false);

  const beforeSecond = fs.readFileSync(filename), pointerBeforeSecond = fs.readFileSync(pointer);
  f.plan.revision++; f.plan.shots[0].prompt.text = '人物保持站姿，目光朝向窗外。';
  const secondChange = await f.candidate();
  fs.renameSync = (source, target) => {
    if (path.resolve(target) === pointer) throw Object.assign(new Error('fixture-pointer-rename'), { code: 'EPERM' });
    return rename(source, target);
  };
  try { await assert.rejects(f.deliver(secondChange), /fixture-pointer-rename/); }
  finally { fs.renameSync = rename; }
  const written = fs.readFileSync(filename), writtenAt = fs.statSync(filename).mtimeMs;
  assert.notDeepEqual(written, beforeSecond);
  assert.equal((await readWorkbook(written)).getWorksheet('生成Prompt').getCell('C2').text, f.plan.shots[0].prompt.text);
  assert.deepEqual(fs.readFileSync(pointer), pointerBeforeSecond);
  assert.ok(fs.existsSync(pending));
  await f.deliver(secondChange);
  assert.deepEqual(fs.readFileSync(filename), written);
  assert.equal(fs.statSync(filename).mtimeMs, writtenAt);
  assert.notDeepEqual(fs.readFileSync(pointer), pointerBeforeSecond);
  assert.equal(fs.existsSync(pending), false);
  assert.deepEqual(await deliveryBaseline(f.directory, promptHash('workflow-3')), written);
});

test('replacing and adding storyboard PNGs preserves existing anchors, assets, layout, links and user opinions', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'image.png'), redPng);
  f.context.workflow.images[0].sha256 = promptHash(redPng);
  f.plan.shots.push({ ...structuredClone(f.plan.shots[0]), id: 'S02' },
    { ...structuredClone(f.plan.shots[0]), id: 'S03', reuseOf: 'S01' });
  fs.writeFileSync(f.track(path.join(f.directory, 'asset.png')), greenPng);
  f.context.workflow.assetImages = [{ assetId: 'ROOM', path: 'asset.png', sha256: promptHash(greenPng) }];
  const [filename] = await f.deliver(await f.candidate()), custom = await readWorkbook(fs.readFileSync(filename));
  // Existing projects predate stable imageSlots metadata and must migrate from their verified baseline.
  const pointer = JSON.parse(fs.readFileSync(path.join(f.directory, 'excel-delivery.json'), 'utf8'));
  const recordPath = path.join(f.directory, pointer.record), legacyRecord = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  delete legacyRecord.source.imageSlots;
  fs.writeFileSync(recordPath, JSON.stringify(legacyRecord, null, 2) + '\n', 'utf8');
  const main = custom.getWorksheet('分镜脚本');
  main.getCell('J2').value = '保持原来的构图。';
  main.getCell('F2').note = '这条批注保留。';
  main.getCell('F2').font = { name: 'Microsoft YaHei', size: 12, bold: true };
  main.getColumn(6).width = 45; main.getRow(3).height = 126;
  main.getCell('A2').value = { text: 'S01', hyperlink: 'https://example.test/story/S01' };
  fs.writeFileSync(filename, Buffer.from(await custom.xlsx.writeBuffer()));
  const before = await readWorkbook(fs.readFileSync(filename)), oldMain = before.getWorksheet('分镜脚本');
  const oldAnchors = imageAnchors(oldMain), oldAssetAnchors = imageAnchors(before.getWorksheet('人物与场景'));
  const oldRows = [2, 3, 4].map(row => oldMain.getRow(row).height);
  fs.writeFileSync(f.track(path.join(f.directory, 'replacement.png')), bluePng);
  f.context.workflow.images = [{ shotId: 'S01', path: 'replacement.png', sha256: promptHash(bluePng) },
    { shotId: 'S02', path: 'replacement.png', sha256: promptHash(bluePng) }];
  f.plan.revision++;
  const replacement = await f.candidate();
  await f.deliver(replacement);
  const updatedBytes = fs.readFileSync(filename), updated = await readWorkbook(updatedBytes), result = updated.getWorksheet('分镜脚本');
  assert.equal(result.getImages().length, 3);
  for (const row of [2, 3, 4]) assert.deepEqual(imageBytes(updated, '分镜脚本', row, 5), bluePng);
  assert.deepEqual(imageBytes(updated, '人物与场景', 2, 3), greenPng);
  for (const original of oldAnchors) assert.deepEqual(imageAnchors(result).find(image => image.tl.nativeRow === original.tl.nativeRow), original);
  assert.deepEqual(imageAnchors(updated.getWorksheet('人物与场景')), oldAssetAnchors);
  assert.deepEqual([2, 3, 4].map(row => result.getRow(row).height), oldRows);
  assert.equal(result.getColumn(6).width, 45);
  assert.deepEqual(result.getCell('F2').style, oldMain.getCell('F2').style);
  assert.deepEqual(result.getCell('F2').note, oldMain.getCell('F2').note);
  assert.equal(result.getCell('J2').text, '保持原来的构图。');
  assert.deepEqual(result.getCell('A2').value, oldMain.getCell('A2').value);
  for (const row of [2, 3, 4]) assert.equal(result.getCell(row, 5).value.hyperlink.endsWith('/replacement.png'), true);
  assert.equal(result.getCell('E3').text, '查看原图');
  const added = result.getImages().find(image => image.range.tl.nativeRow === 2);
  assert.ok(added.range.br.nativeRowOff / 9525 <= oldRows[1] * 4 / 3);
  const unchangedTime = fs.statSync(filename).mtimeMs;
  await f.deliver(replacement);
  assert.deepEqual(fs.readFileSync(filename), updatedBytes);
  assert.equal(fs.statSync(filename).mtimeMs, unchangedTime);

  // The new S02 media part is appended, so its media order differs from the fresh candidate.
  fs.writeFileSync(f.track(path.join(f.directory, 'next.png')), redPng);
  f.context.workflow.images[0] = { shotId: 'S01', path: 'next.png', sha256: promptHash(redPng) };
  f.plan.revision++;
  await f.deliver(await f.candidate());
  const next = await readWorkbook(fs.readFileSync(filename));
  assert.deepEqual(imageBytes(next, '分镜脚本', 2, 5), redPng);
  assert.deepEqual(imageBytes(next, '分镜脚本', 3, 5), bluePng);
  assert.deepEqual(imageBytes(next, '分镜脚本', 4, 5), redPng);
  assert.deepEqual(imageBytes(next, '人物与场景', 2, 3), greenPng);
});

test('unchanged source images retain user replacements, while later source image and hyperlink conflicts are rejected', async t => {
  const f = fixture(t), [filename] = await f.deliver(await f.candidate());
  const custom = await readWorkbook(fs.readFileSync(filename));
  imageAt(custom, '分镜脚本', 2, 5).buffer = greenPng;
  fs.writeFileSync(filename, Buffer.from(await custom.xlsx.writeBuffer()));
  f.plan.revision++; f.plan.shots[0].prompt.text = '人物站在窗边，双手仍自然垂放。';
  await f.deliver(await f.candidate());
  assert.deepEqual(imageBytes(await readWorkbook(fs.readFileSync(filename)), '分镜脚本', 2, 5), greenPng);
  const before = fs.readFileSync(filename);
  fs.writeFileSync(f.track(path.join(f.directory, 'replacement.png')), bluePng);
  f.context.workflow.images[0] = { shotId: 'S01', path: 'replacement.png', sha256: promptHash(bluePng) };
  f.plan.revision++;
  await assert.rejects(f.deliver(await f.candidate()), /图片冲突/);
  assert.deepEqual(fs.readFileSync(filename), before);

  const sameTarget = await readWorkbook(before);
  imageAt(sameTarget, '分镜脚本', 2, 5).buffer = bluePng;
  sameTarget.getWorksheet('分镜脚本').getCell('E2').value = { text: '查看原图', hyperlink: 'file:///user-selected.png' };
  fs.writeFileSync(filename, Buffer.from(await sameTarget.xlsx.writeBuffer()));
  const linkConflict = fs.readFileSync(filename);
  await assert.rejects(f.deliver(await f.candidate()), /原图链接冲突/);
  assert.deepEqual(fs.readFileSync(filename), linkConflict);
  sameTarget.getWorksheet('分镜脚本').getCell('E2').value = {
    text: '查看原图', hyperlink: (await readWorkbook(before)).getWorksheet('分镜脚本').getCell('E2').value.hyperlink
  };
  fs.writeFileSync(filename, Buffer.from(await sameTarget.xlsx.writeBuffer()));
  await f.deliver(await f.candidate());
  const matched = await readWorkbook(fs.readFileSync(filename));
  assert.deepEqual(imageBytes(matched, '分镜脚本', 2, 5), bluePng);
  assert.equal(matched.getWorksheet('分镜脚本').getCell('E2').value.hyperlink.endsWith('/replacement.png'), true);
});

test('asset image changes and a damaged delivery baseline cannot overwrite the fixed workbook', async t => {
  const f = fixture(t);
  f.context.workflow.assetImages = [{ assetId: 'ROOM', path: 'image.png', sha256: promptHash(png) }];
  const [filename] = await f.deliver(await f.candidate()), before = fs.readFileSync(filename);
  fs.writeFileSync(f.track(path.join(f.directory, 'replacement.png')), bluePng);
  f.context.workflow.assetImages[0] = { assetId: 'ROOM', path: 'replacement.png', sha256: promptHash(bluePng) };
  await assert.rejects(f.deliver(await f.candidate()), /人物或场景参考图/);
  assert.deepEqual(fs.readFileSync(filename), before);
  f.context.workflow.assetImages[0] = { assetId: 'ROOM', path: 'image.png', sha256: promptHash(png) };
  const pointer = JSON.parse(fs.readFileSync(path.join(f.directory, 'excel-delivery.json'), 'utf8'));
  const record = JSON.parse(fs.readFileSync(path.join(f.directory, pointer.record), 'utf8'));
  fs.appendFileSync(path.join(f.directory, record.baseline.path), 'changed');
  await assert.rejects(f.deliver(await f.candidate()), /基线损坏/);
  assert.deepEqual(fs.readFileSync(filename), before);
});
