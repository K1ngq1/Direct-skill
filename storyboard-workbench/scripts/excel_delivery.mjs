import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import ExcelJS from './vendor/exceljs.cjs';
import { ProjectError } from './project.mjs';
import { localFolder } from './visual_state.mjs';
import { textLines } from './export_visual_excel.mjs';
import { doctor } from './runtime.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
const fail = message => { throw new ProjectError(message, 422); };
const value = cell => cell.value === null ? null : typeof cell.value === 'object' ? cell.text : cell.value;
const relative = (directory, filename) => path.relative(directory, filename).split(path.sep).join('/');

function inside(directory, filename) {
  const root = fs.realpathSync(directory), target = path.resolve(root, filename), rel = path.relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) fail('Excel交付路径不能越出项目');
  let cursor = root;
  for (const part of rel.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor)) {
      const resolved = path.relative(root, fs.realpathSync(cursor));
      if (resolved === '..' || resolved.startsWith('..' + path.sep) || path.isAbsolute(resolved)) fail('Excel交付路径链接不能越出项目');
    }
  }
  return target;
}

function immutable(filename, bytes) {
  if (fs.existsSync(filename)) {
    if (!fs.readFileSync(filename).equals(bytes)) fail('内部交付记录冲突，未覆盖历史');
  } else fs.writeFileSync(filename, bytes, { flag: 'wx' });
}

function atomicJson(filename, data) {
  const temporary = filename + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, json(data), { flag: 'wx' }); fs.renameSync(temporary, filename); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

async function load(bytes) {
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes); return workbook;
}

function checkStructure(workbook, data) {
  if (!isDeepStrictEqual(workbook.worksheets.map(sheet => sheet.name), data.sheets.map(sheet => sheet.name))) fail('固定Excel工作表结构已变化');
  for (const definition of data.sheets) {
    const sheet = workbook.getWorksheet(definition.name);
    if (sheet.rowCount !== definition.rows || sheet.columnCount !== definition.columns
      || !isDeepStrictEqual(definition.headers, definition.headers.map((_, index) => value(sheet.getCell(1, index + 1))))) fail('固定Excel行列或表头已变化');
  }
  for (const group of data.groups) {
    const sheet = workbook.getWorksheet(group.sheet);
    if (group.kind === 'row' && value(sheet.getCell(group.rows[0], 1)) !== group.values[0]) fail('固定Excel镜号顺序已变化');
    if (group.kind === 'prompt' && group.rows.some((row, index) =>
      value(sheet.getCell(row, 1)) !== group.values[0] + (index ? `（续${index + 1}）` : '')
      || value(sheet.getCell(row, 2)) !== group.values[1])) fail('固定Excel Prompt分组位置已变化');
    if (group.kind === 'asset' && group.rows.some((row, index) =>
      value(sheet.getCell(row, 1)) !== group.values[0] + (index ? '（续）' : ''))) fail('固定Excel人物或场景分组位置已变化');
  }
}

function fits(sheet, row, column, text) {
  if (text === null || text === '') return true;
  const cell = sheet.getCell(row, column), scale = (cell.font?.size ?? 11) / 11;
  return textLines(String(text), (sheet.getColumn(column).width ?? 20) / scale) * 18 * scale + 18 <= (sheet.getRow(row).height ?? sheet.properties.defaultRowHeight ?? 15);
}

function splitForSlots(sheet, group, text) {
  const paragraphs = text.match(/[^\n]+(?:\n+|$)|\n+/gu) ?? [''];
  const parts = group.rows.map(() => ''); let index = 0;
  for (const paragraph of paragraphs) {
    while (index < parts.length && !fits(sheet, group.rows[index], group.textColumn, parts[index] + paragraph)) index++;
    if (index === parts.length) return null;
    parts[index] += paragraph;
  }
  return parts;
}

function updatesFor(workbook, before, desired) {
  if (!isDeepStrictEqual(before.groups.map(group => [group.id, group.kind]), desired.groups.map(group => [group.id, group.kind]))) fail('本次包含镜头、资产或Prompt分组变更，不能按原有行槽更新');
  checkStructure(workbook, before);
  const updates = [], conflicts = [];
  const put = (sheet, row, column, oldValue, newValue) => {
    if (isDeepStrictEqual(oldValue, newValue)) return;
    const cell = sheet.getCell(row, column), actual = value(cell);
    if (cell.value && typeof cell.value === 'object' && !('hyperlink' in cell.value)) fail(`${sheet.name}!${cell.address}含公式或富文本，未覆盖`);
    const originalBlank = actual === null && oldValue === '';
    if (!originalBlank && !isDeepStrictEqual(actual, oldValue) && !isDeepStrictEqual(actual, newValue)) fail(`${sheet.name}!${cell.address}文案冲突：该格有人工修改，原文件未改动`);
    if (!fits(sheet, row, column, newValue)) { conflicts.push({ sheet: sheet.name, cells: [cell.address], message: '新文案超出已有单元格空间' }); return; }
    if (!isDeepStrictEqual(actual, newValue)) updates.push({ sheet: sheet.name, cell: cell.address, value: newValue });
  };
  const groups = before.groups.map((old, index) => {
    const next = desired.groups[index], sheet = workbook.getWorksheet(old.sheet);
    if (old.kind === 'asset' && old.values[4] !== next.values[4]) fail(`${old.id}使用镜头关系有变化，不能按仅替换文案更新`);
    for (let column = 1; column <= old.values.length; column++) {
      if (isDeepStrictEqual(old.values[column - 1], next.values[column - 1])) continue;
      if (column === old.textColumn) {
        const cells = old.rows.map(row => sheet.getCell(row, column));
        if (cells.some(cell => cell.value && typeof cell.value === 'object')) fail(`${old.id}正文含公式或富文本，未覆盖`);
        const actual = cells.map(cell => cell.text).join('');
        if (actual !== old.values[column - 1] && actual !== next.values[column - 1]) fail(`${old.id}文案冲突：正文有人工修改，原文件未改动`);
        const parts = splitForSlots(sheet, old, next.values[column - 1]);
        if (!parts) { conflicts.push({ groupId: old.id, sheet: sheet.name, cells: cells.map(cell => cell.address), message: '新文案超出已有单元格空间' }); continue; }
        for (const [slot, row] of old.rows.entries()) put(sheet, row, column, value(cells[slot]), parts[slot] || null);
      } else {
        for (const [slot, row] of old.rows.entries()) {
          if (old.kind === 'asset' && column === 3 && slot) continue;
          const suffix = old.kind === 'asset' && column === 1 && slot ? '（续）' : '';
          put(sheet, row, column, suffix ? old.values[column - 1] + suffix : old.values[column - 1],
            suffix ? next.values[column - 1] + suffix : next.values[column - 1]);
        }
      }
    }
    return { ...old, values: next.values };
  });
  if (conflicts.length) {
    const error = new ProjectError(conflicts.map(item => `${item.sheet}!${item.cells.join('、')}${item.message}`).join('；') + '；原文件未改动，需要缩短文案或明确调整局部排版', 422);
    error.conflicts = conflicts; throw error;
  }
  return { updates, source: { ...before, groups } };
}

function imageSlot(workbook, group) {
  const sheet = workbook.getWorksheet(group.sheet), row = group.rows[0], column = group.kind === 'row' ? 5 : 3;
  const cell = sheet.getCell(row, column);
  const images = sheet.getImages().filter(image => image.range.tl?.nativeRow === row - 1 && image.range.tl?.nativeCol === column - 1);
  if (images.length > 1) fail(`${group.id}图片槽包含多张图片，不能确定替换目标`);
  const image = images[0], media = image ? workbook.getImage(image.imageId) : null;
  if (image && !media?.buffer) fail(`${group.id}图片内容无法读取`);
  const buffer = media ? Buffer.from(media.buffer) : null;
  return { sheet, row, column, cell, image, buffer, sha256: buffer ? hash(buffer) : null, hyperlink: cell.value?.hyperlink ?? null };
}

function imageSources(workbook, data) {
  return data.groups.filter(group => group.kind === 'row' || group.kind === 'asset').map(group => {
    const slot = imageSlot(workbook, group);
    return { id: group.id, sha256: slot.sha256, hyperlink: slot.sha256 ? slot.hyperlink : null };
  });
}

function imageUpdatesFor(workbook, baseline, candidate, before, desired, nextSources) {
  // Source slots describe the director's inputs; the actual baseline may also contain preserved user edits.
  const oldSources = before.imageSlots ?? imageSources(baseline, before);
  if (!before.imageSlots && !isDeepStrictEqual(before.mediaHashes, (baseline.model.media ?? []).map(item => hash(item.buffer)))) {
    if (isDeepStrictEqual(before.mediaHashes, desired.mediaHashes)) return { updates: [], sources: nextSources };
    fail('旧Excel基线包含人工换图且缺少源图槽记录，不能确定本次图片冲突；原文件未改动');
  }
  const oldById = new Map(oldSources.map(slot => [slot.id, slot])), nextById = new Map(nextSources.map(slot => [slot.id, slot]));
  const desiredById = new Map(desired.groups.map(group => [group.id, group])), updates = [];
  for (const group of before.groups.filter(group => group.kind === 'row' || group.kind === 'asset')) {
    const old = oldById.get(group.id), next = nextById.get(group.id);
    if (!old || !next) fail(`${group.id}缺少源图槽记录`);
    if (old.sha256 === next.sha256 && old.hyperlink === next.hyperlink) continue;
    if (group.kind === 'asset') fail(`${group.id}人物或场景参考图有变化，本次仅允许更新分镜图片`);
    if (!next.sha256) fail(`${group.id}本次不能移除已有图片，原文件未改动`);
    const actual = imageSlot(workbook, group), target = imageSlot(candidate, desiredById.get(group.id));
    if (![old.sha256, next.sha256].includes(actual.sha256)) fail(`${group.id}图片冲突：该槽有人工修改，原文件未改动`);
    if (![old.hyperlink, next.hyperlink].includes(actual.hyperlink)) fail(`${group.id}原图链接冲突：该格有人工修改，原文件未改动`);
    if (actual.sha256 === next.sha256 && actual.hyperlink === next.hyperlink) continue;
    const buffer = target.buffer;
    if (!buffer || buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail(`${group.id}原位换图目前仅支持PNG`);
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    if (!width || !height || !target.hyperlink?.startsWith('file:')) fail(`${group.id}图片尺寸或原图文件链接无效`);
    const availableHeight = (actual.sheet.getRow(actual.row).height ?? actual.sheet.properties.defaultRowHeight ?? 15) * 4 / 3 - 26;
    const availableWidth = (actual.sheet.getColumn(actual.column).width ?? 8.43) * 7 + 5 - 8;
    const widthPx = actual.image ? Math.min(240, 480 * width / height) : Math.min(240, availableWidth, availableHeight * width / height);
    const heightPx = widthPx * height / width;
    if (!actual.image && (widthPx <= 0 || heightPx <= 0)) fail(`${group.id}现有单元格空间不足以补图，原文件未改动`);
    updates.push({ sheet: group.sheet, cell: actual.cell.address, expectedSha256: actual.sha256,
      newBufferBase64: buffer.toString('base64'), newHyperlink: target.hyperlink,
      anchor: { leftPx: 4, topPx: 22, widthPx, heightPx } });
  }
  return { updates, sources: nextSources };
}

async function checkBinding(bytes, file) {
  const actual = await load(bytes), expected = await load(file.buffer);
  checkStructure(actual, file.deliveryData);
  for (const sheet of expected.worksheets) {
    const target = actual.getWorksheet(sheet.name);
    for (let row = 1; row <= sheet.rowCount; row++) for (let column = 1; column <= sheet.columnCount; column++) {
      if (sheet.name === '分镜脚本' && row > 1 && column === 10) continue;
      const cell = target.getCell(row, column);
      if (cell.value && typeof cell.value === 'object' && !('hyperlink' in cell.value)) fail('绑定文件含公式或富文本，未改动原文件');
      if (!isDeepStrictEqual(value(sheet.getCell(row, column)), value(cell))) fail('绑定文件文案与指定版本不一致');
    }
    const images = worksheet => worksheet.getImages().map(item => item.imageId);
    if (!isDeepStrictEqual(images(sheet), images(target))) fail('绑定文件图片归属与指定版本不一致');
  }
  if (!isDeepStrictEqual((actual.model.media ?? []).map(item => hash(item.buffer)), file.deliveryData.mediaHashes)) fail('绑定文件图片与指定版本不一致');
}

function recover(directory, pointerFile, pendingFile) {
  if (!fs.existsSync(pendingFile)) return;
  const pending = read(pendingFile), workbook = inside(directory, pending.pointer.path);
  const current = fs.existsSync(workbook) ? hash(fs.readFileSync(workbook)) : null;
  if (current === pending.afterHash) atomicJson(pointerFile, pending.pointer);
  else if (current !== pending.beforeHash) fail('上次Excel更新未完成且文件另有变化，保留文件与恢复记录');
  fs.unlinkSync(pendingFile);
}

export async function deliverExcel(directory, { file, log, planHash, workflowHash = null, bindWorkbook = null, outputDirectory }) {
  directory = fs.realpathSync(directory);
  const pointerFile = inside(directory, 'excel-delivery.json'), pendingFile = inside(directory, 'excel-delivery.pending.json');
  const lock = inside(directory, 'excel-delivery.lock');
  let handle;
  try { handle = fs.openSync(lock, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') fail('Excel交付锁已存在；请先确认另一导出是否仍在运行，异常退出时核实锁中进程后再处理遗留锁');
    throw error;
  }
  let temporary;
  try {
    fs.writeFileSync(handle, json({ pid: process.pid, startedAt: new Date().toISOString() }));
    recover(directory, pointerFile, pendingFile);
    const pointer = fs.existsSync(pointerFile) ? read(pointerFile) : null;
    if (pointer && bindWorkbook && inside(directory, bindWorkbook) !== inside(directory, pointer.path)) fail('项目已有固定Excel，不自动改绑另一份文件');
    const workbookPath = pointer ? inside(directory, pointer.path) : bindWorkbook ? inside(directory, bindWorkbook)
      : inside(directory, path.join(outputDirectory, file.filename));
    if (!pointer && !bindWorkbook && fs.existsSync(workbookPath)) fail('此Excel已存在，请用bind-excel绑定，不覆盖原件');
    const candidate = await load(file.buffer), nextImages = imageSources(candidate, file.deliveryData);
    let source = { ...file.deliveryData, imageSlots: nextImages }, bytes = pointer || bindWorkbook ? fs.readFileSync(workbookPath) : file.buffer;
    const originalBytes = bytes;
    const beforeHash = pointer || bindWorkbook ? hash(bytes) : null;
    let inheritedOpinions = [];
    if (pointer) {
      const record = read(inside(directory, pointer.record)), workbook = await load(bytes);
      if (record.projectId !== file.deliveryData.projectId) fail('固定Excel属于不同项目');
      const baselineBytes = fs.readFileSync(inside(directory, record.baseline.path));
      if (hash(baselineBytes) !== record.baseline.sha256) fail('实际交付基线损坏，不能更新固定Excel');
      const baseline = await load(baselineBytes);
      inheritedOpinions = record.inheritedOpinions ?? [];
      if (record.planHash !== planHash || record.workflowHash !== workflowHash) {
        const sheet = workbook.getWorksheet('分镜脚本');
        inheritedOpinions = record.source.groups.filter(group => group.kind === 'row').flatMap(group => {
          const note = sheet.getCell(group.rows[0], 10).value;
          return note === null || note === '' ? [] : [{ shotId: group.values[0], note }];
        });
      }
      const changed = updatesFor(workbook, record.source, file.deliveryData); source = changed.source;
      const images = imageUpdatesFor(workbook, baseline, candidate, record.source, file.deliveryData, nextImages);
      source = { ...source, mediaHashes: file.deliveryData.mediaHashes, imageSlots: images.sources };
      if (changed.updates.length || images.updates.length) {
        const runtime = doctor().checks.find(check => check.name === 'python');
        if (runtime?.status !== 'passed') fail('未找到可用Python，固定Excel未改动：' + (runtime?.issue?.message ?? '未知原因'));
        const python = runtime.detail;
        temporary = workbookPath + '.' + crypto.randomUUID() + '.tmp';
        const result = spawnSync(python.command, [...python.args, fileURLToPath(new URL('./patch_excel.py', import.meta.url))], {
          input: JSON.stringify({ source: workbookPath, output: temporary, expectedSha256: beforeHash, updates: changed.updates, imageUpdates: images.updates }),
          encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024
        });
        if (result.status !== 0) fail('Excel原位更新失败，原文件未改动：' + (result.error?.message ?? (result.stdout.trim() || result.stderr.trim())));
        bytes = fs.readFileSync(temporary);
      }
    } else if (bindWorkbook) await checkBinding(bytes, file);
    const afterHash = hash(bytes), snapshots = localFolder(directory, 'excel-delivery/snapshots'), records = localFolder(directory, 'excel-delivery/records');
    if (beforeHash) immutable(path.join(snapshots, beforeHash + '.xlsx'), originalBytes);
    const snapshot = path.join(snapshots, afterHash + '.xlsx');
    immutable(snapshot, bytes);
    const record = { schemaVersion: 1, projectId: source.projectId, workbookPath: relative(directory, workbookPath),
      planHash, workflowHash, source, inheritedOpinions, baseline: { path: relative(directory, snapshot), sha256: afterHash }, logHash: hash(log.buffer) };
    const recordId = hash(json(record)), recordFile = path.join(records, recordId + '.json'), logFile = path.join(records, recordId + '.md');
    immutable(recordFile, json(record)); immutable(logFile, log.buffer);
    const nextPointer = { schemaVersion: 1, projectId: source.projectId, path: relative(directory, workbookPath), record: relative(directory, recordFile) };
    if (!pointer && !bindWorkbook) {
      localFolder(directory, relative(directory, path.dirname(workbookPath)));
      temporary = workbookPath + '.' + crypto.randomUUID() + '.tmp';
      fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    }
    if (temporary) {
      atomicJson(pendingFile, { beforeHash, afterHash, pointer: nextPointer });
      const currentHash = fs.existsSync(workbookPath) ? hash(fs.readFileSync(workbookPath)) : null;
      if (currentHash !== beforeHash) fail('Excel在更新期间被其他程序修改，未覆盖该文件');
      try { fs.renameSync(temporary, workbookPath); temporary = null; }
      catch (error) { fail('无法写入固定Excel，请关闭占用该文件的程序后重试：' + error.message); }
    } else if (hash(fs.readFileSync(workbookPath)) !== beforeHash) fail('Excel在绑定期间发生变化，未更新绑定记录');
    atomicJson(pointerFile, nextPointer);
    if (fs.existsSync(pendingFile)) fs.unlinkSync(pendingFile);
    return [workbookPath, logFile];
  } finally {
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    fs.closeSync(handle); fs.unlinkSync(lock);
  }
}

export async function deliveryBaseline(directory, workflowHash, withRecord = false) {
  const pointerFile = inside(directory, 'excel-delivery.json');
  if (!fs.existsSync(pointerFile)) return null;
  if (fs.existsSync(inside(directory, 'excel-delivery.pending.json'))) fail('Excel交付更新尚未完成，请先重新执行导出恢复记录');
  const records = inside(directory, 'excel-delivery/records'), current = read(pointerFile).record;
  const candidates = [inside(directory, current), ...fs.readdirSync(records).filter(name => name.endsWith('.json')).map(name => path.join(records, name))];
  for (const filename of new Set(candidates)) {
    const record = read(filename);
    if (record.workflowHash !== workflowHash) continue;
    const bytes = fs.readFileSync(inside(directory, record.baseline.path));
    if (hash(bytes) !== record.baseline.sha256) fail('实际交付基线损坏，不能导入反馈');
    return withRecord ? { buffer: bytes, record } : bytes;
  }
  return null;
}
