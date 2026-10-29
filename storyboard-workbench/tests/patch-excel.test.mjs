import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ExcelJS from '../scripts/vendor/exceljs.cjs';
import { doctor } from '../scripts/runtime.mjs';

const pythonCheck = doctor().checks.find(check => check.name === 'python');
assert.equal(pythonCheck.status, 'passed', JSON.stringify(pythonCheck));
const python = pythonCheck.detail;
const script = fileURLToPath(new URL('../scripts/patch_excel.py', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function runPython(args, input) {
  return spawnSync(python.command, [...python.args, ...args], {
    input, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
}
function archiveParts(bytes) {
  const result = runPython(['-c', 'import io,json,sys,zipfile,hashlib; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({n:{"sha256":hashlib.sha256(z.read(n)).hexdigest(),"text":z.read(n).decode("utf-8") if n.endswith((".xml",".rels")) else None} for n in z.namelist()},ensure_ascii=False))'], bytes);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout);
}
function patch(request) {
  const result = runPython([script], JSON.stringify(request));
  assert.equal(result.error, undefined);
  return { ...result, data: JSON.parse(result.stdout) };
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-cell-patch-'));
  const source = path.join(directory, '既有脚本.xlsx'), output = path.join(directory, '候选.xlsx');
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('分镜脚本');
  sheet.columns = [{ width: 23 }, { width: 47 }, { width: 19 }, { width: 31 }, { width: 20 }];
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.addRow(['镜号', '画面', '声音', '用户意见', '其他']);
  sheet.addRow(['S001', '原正文', '原声音', '保留手填意见', '稍后清空']);
  sheet.addRow(['S002', null, '有声']);
  sheet.addRow(['计算', { formula: '1+2', result: 3 }]);
  sheet.addRow(['合并标题']);
  sheet.mergeCells('A5:C5');
  sheet.getRow(2).height = 119;
  sheet.getCell('B2').font = { name: 'Microsoft YaHei', size: 15, bold: true, color: { argb: 'FF264A32' } };
  sheet.getCell('B2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
  sheet.getCell('B2').alignment = { wrapText: true, vertical: 'top' };
  sheet.getCell('B2').note = '保留用户批注';
  sheet.getCell('A2').value = { text: 'S001', hyperlink: 'https://example.com/reference' };
  sheet.getCell('D3').value = true;
  const picture = workbook.addImage({
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    extension: 'png',
  });
  sheet.addImage(picture, 'E2:E3');
  workbook.addWorksheet('生成Prompt').addRow(['必须保留', '另一张工作表']);
  const initial = Buffer.from(await workbook.xlsx.writeBuffer());
  // A nonstandard part name proves that the patcher follows workbook relationships.
  const transform = spawnSync(python.command, [...python.args, '-c', [
    'import io,sys,zipfile',
    'source=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))',
    'buffer=io.BytesIO()',
    'with zipfile.ZipFile(buffer,"w") as target:',
    ' for info in source.infolist():',
    '  data=source.read(info)',
    '  if info.filename=="xl/_rels/workbook.xml.rels": data=data.replace(b"worksheets/sheet1.xml",b"worksheets/sheet7.xml")',
    '  if info.filename=="xl/worksheets/sheet1.xml": info.filename="xl/worksheets/sheet7.xml"',
    '  if info.filename=="xl/worksheets/_rels/sheet1.xml.rels": info.filename="xl/worksheets/_rels/sheet7.xml.rels"',
    '  if info.filename=="[Content_Types].xml": data=data.replace(b"/xl/worksheets/sheet1.xml",b"/xl/worksheets/sheet7.xml")',
    '  target.writestr(info,data)',
    'sys.stdout.buffer.write(buffer.getvalue())',
  ].join('\n')], { input: initial, windowsHide: true });
  assert.equal(transform.status, 0, transform.stderr.toString());
  fs.writeFileSync(source, transform.stdout);
  const expectedSha256 = sha256(transform.stdout);
  t.after(() => {
    const repeat = path.join(directory, '重复.xlsx');
    if (fs.existsSync(repeat)) fs.unlinkSync(repeat);
    if (fs.existsSync(output)) fs.unlinkSync(output);
    fs.unlinkSync(source);
    fs.rmdirSync(directory);
  });
  return { source, output, expectedSha256, original: transform.stdout };
}

test('patch changes only requested cell XML and preserves workbook layout, image, links and comments', async t => {
  const state = await fixture(t);
  const text = '  女孩看向镜头 & 微笑 <自然>\n头发飘起又落下。“你好” 🟦  ';
  const updates = [
    { sheet: '分镜脚本', cell: 'B2', value: text },
    { sheet: '分镜脚本', cell: 'C2', value: 12.5 },
    { sheet: '分镜脚本', cell: 'D3', value: false },
    { sheet: '分镜脚本', cell: 'E2', value: null },
    { sheet: '分镜脚本', cell: 'B3', value: '在已有行的空格里更新' },
  ];
  const result = patch({ ...state, updates });
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(result.data, { updatedCells: 5, changedEntries: ['xl/worksheets/sheet7.xml'] });
  assert.equal(sha256(fs.readFileSync(state.source)), state.expectedSha256);
  const before = archiveParts(state.original), after = archiveParts(fs.readFileSync(state.output));
  assert.deepEqual(Object.keys(before), Object.keys(after));
  for (const part of Object.keys(before)) {
    if (part !== 'xl/worksheets/sheet7.xml') assert.deepEqual(after[part], before[part], part);
  }
  const withoutTargetCells = xml => {
    for (const cell of updates.map(update => update.cell)) {
      xml = xml.replace(new RegExp(`<c\\b[^>]*\\br="${cell}"[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`), '');
    }
    return xml;
  };
  assert.equal(withoutTargetCells(after['xl/worksheets/sheet7.xml'].text), withoutTargetCells(before['xl/worksheets/sheet7.xml'].text));
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(fs.readFileSync(state.output));
  const sheet = workbook.getWorksheet('分镜脚本');
  assert.equal(sheet.getCell('B2').value, text);
  assert.equal(sheet.getCell('C2').value, 12.5);
  assert.equal(sheet.getCell('D3').value, false);
  assert.equal(sheet.getCell('E2').value, null);
  assert.equal(sheet.getCell('B3').value, '在已有行的空格里更新');
  assert.equal(sheet.getCell('D2').value, '保留手填意见');
  assert.equal(sheet.getCell('B2').font.name, 'Microsoft YaHei');
  assert.equal(sheet.getCell('B2').font.size, 15);
  const note = sheet.getCell('B2').note;
  assert.equal(typeof note === 'string' ? note : note.texts[0].text, '保留用户批注');
  assert.equal(sheet.getColumn(2).width, 47);
  assert.equal(sheet.getRow(2).height, 119);
  assert.equal(sheet.getCell('A2').value.hyperlink, 'https://example.com/reference');
  assert.equal(sheet.getImages().length, 1);
  assert.equal(sheet.getCell('B4').formula, '1+2');
  assert.equal(sheet.getCell('B5').master.address, 'A5');
});

test('patch refuses stale input, ambiguous targets, formulas and invalid values without writing', async t => {
  const state = await fixture(t);
  const update = { sheet: '分镜脚本', cell: 'B2', value: '新正文' };
  const cases = [
    [{ expectedSha256: '0'.repeat(64), updates: [update] }, 'STALE_SOURCE'],
    [{ output: state.source, updates: [update] }, 'SAME_PATH'],
    [{ updates: [update, update] }, 'DUPLICATE_CELL'],
    [{ updates: [{ ...update, sheet: '不存在' }] }, 'MISSING_SHEET'],
    [{ updates: [{ ...update, cell: 'B4' }] }, 'FORMULA_CELL'],
    [{ updates: [{ ...update, cell: 'B5' }] }, 'MERGED_CELL'],
    [{ updates: [{ ...update, cell: 'B99' }] }, 'MISSING_ROW'],
    [{ updates: [{ ...update, cell: '$B$2' }] }, 'INVALID_CELL'],
    [{ updates: [{ ...update, cell: 'XFE2' }] }, 'INVALID_CELL'],
    [{ updates: [{ ...update, value: { text: '不接受对象' } }] }, 'INVALID_VALUE'],
    [{ updates: [{ ...update, value: '非法\u0000字符' }] }, 'INVALID_VALUE'],
  ];
  for (const [request, code] of cases) {
    const result = patch({ ...state, ...request });
    assert.equal(result.status, 1, JSON.stringify(request));
    assert.equal(result.data.error.code, code, result.stdout);
    assert.equal(fs.existsSync(state.output), false);
    assert.equal(sha256(fs.readFileSync(state.source)), state.expectedSha256);
  }
  const infinite = runPython([script], JSON.stringify({ ...state, updates: [{ ...update, value: 999 }] }).replace('"value":999', '"value":1e999'));
  assert.equal(infinite.status, 1);
  assert.equal(JSON.parse(infinite.stdout).error.code, 'INVALID_VALUE');
  fs.writeFileSync(state.output, '不要覆盖', 'utf8');
  const existing = patch({ ...state, updates: [update] });
  assert.equal(existing.status, 1);
  assert.equal(fs.readFileSync(state.output, 'utf8'), '不要覆盖');
});

test('XML offsets preserve prefixes, non-value cell metadata and empty-row geometry', () => {
  const result = runPython(['-c', [
    'import runpy,sys',
    'module=runpy.run_path(sys.argv[1]); patch=module["patch_sheet"]',
    'before="""<?xml version="1.0" encoding="UTF-8"?><s:worksheet xmlns:s="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:extra="urn:extra"><s:sheetData><s:row r="1" ht="70"><s:c r="A1" s="7" t=\'s\' cm="2"><s:v>0</s:v><!-- keep --><s:extLst><extra:data label="a &gt; b"/></s:extLst></s:c><s:c r="D1" s="3"/></s:row><s:row r="2" ht="91" customHeight="1"/></s:sheetData></s:worksheet>""".encode("utf-8")',
    'updates=[{"cell":"A1","value":"正文 & <new> _x0041_\\r\\n"},{"cell":"D1","value":True},{"cell":"C2","value":2},{"cell":"A2","value":"空行"}]',
    'after=patch(before,updates)',
    'expected=before.replace(b"t=\\\'s\\\'", b"t=\\\'inlineStr\\\'").replace(b"<s:v>0</s:v>", \'<s:is><s:t xml:space="preserve">正文 &amp; &lt;new&gt; _x005F_x0041_&#13;\\n</s:t></s:is>\'.encode("utf-8"))',
    'expected=expected.replace(b\'<s:c r="D1" s="3"/>\',b\'<s:c r="D1" s="3" t="b"><s:v>1</s:v></s:c>\')',
    'expected=expected.replace(b\'<s:row r="2" ht="91" customHeight="1"/>\', \'<s:row r="2" ht="91" customHeight="1"><s:c r="A2" t="inlineStr"><s:is><s:t xml:space="preserve">空行</s:t></s:is></s:c><s:c r="C2"><s:v>2</s:v></s:c></s:row>\'.encode("utf-8"))',
    'assert after==expected,(after,expected)',
    'try: module["parse_xml"](b\'<?xml version="1.0" encoding="iso-8859-1"?><a/>\')',
    'except module["PatchError"] as error: assert error.code=="INVALID_XML"',
    'else: raise AssertionError("accepted unsupported XML encoding")',
  ].join('\n'), script], '');
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

function pngBase64(red, green, blue) {
  const result = runPython(['-c', [
    'import base64,struct,zlib',
    'chunk=lambda kind,data:struct.pack(">I",len(data))+kind+data+struct.pack(">I",zlib.crc32(kind+data)&0xffffffff)',
    `pixels=(b"\\x00"+bytes([${red},${green},${blue}])*16)*9`,
    'data=b"\\x89PNG\\r\\n\\x1a\\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",16,9,8,2,0,0,0))+chunk(b"IDAT",zlib.compress(pixels))+chunk(b"IEND",b"")',
    'print(base64.b64encode(data).decode("ascii"))',
  ].join('\n')], '');
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function imageFixture(t) {
  const state = await fixture(t), workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(state.original);
  const sheet = workbook.getWorksheet('分镜脚本');
  sheet.getCell('E2').value = { text: '旧原图', hyperlink: 'file:///D:/storyboard/old.png' };
  sheet.getCell('E3').value = '待补图';
  sheet.getRow(3).height = 119;
  state.original = Buffer.from(await workbook.xlsx.writeBuffer());
  state.expectedSha256 = sha256(state.original);
  state.oldImageHash = sha256(workbook.model.media[0].buffer);
  fs.writeFileSync(state.source, state.original);
  return state;
}

test('image patch replaces PNG, fills an existing drawing slot, updates links and is idempotent', async t => {
  const state = await imageFixture(t), before = archiveParts(state.original);
  const red = pngBase64(200, 40, 50), blue = pngBase64(20, 80, 200);
  const anchor = { leftPx: 4, topPx: 22, widthPx: 240, heightPx: 135 };
  const imageUpdates = [
    { sheet: '分镜脚本', cell: 'E2', expectedSha256: state.oldImageHash, newBufferBase64: red, newHyperlink: 'file:///D:/storyboard/new-red.png', anchor },
    { sheet: '分镜脚本', cell: 'E3', expectedSha256: null, newBufferBase64: blue, newHyperlink: 'file:///D:/storyboard/new-blue.png', anchor },
  ];
  const result = patch({ ...state, imageUpdates, updates: [
    { sheet: '分镜脚本', cell: 'E2', value: '查看新原图' },
    { sheet: '分镜脚本', cell: 'E3', value: '查看补入图' },
  ] });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.data.updatedImages, 2);
  assert.equal(result.data.updatedCells, 2);
  assert.equal(sha256(fs.readFileSync(state.source)), state.expectedSha256);
  const bytes = fs.readFileSync(state.output), after = archiveParts(bytes);
  const changed = new Set(result.data.changedEntries);
  for (const part of Object.keys(before)) if (!changed.has(part)) assert.deepEqual(after[part], before[part], part);
  assert.ok(!changed.has('xl/styles.xml'));
  const drawingPart = Object.keys(before).find(name => /^xl\/drawings\/drawing\d+\.xml$/.test(name));
  const oldAnchor = before[drawingPart].text.match(/<xdr:twoCellAnchor\b[\s\S]*?<\/xdr:twoCellAnchor>/)[0];
  assert.ok(after[drawingPart].text.includes(oldAnchor), 'the old anchor remains byte-for-byte identical');
  assert.equal((after[drawingPart].text.match(/<xdr:twoCellAnchor\b/g) ?? []).length, 2);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes);
  const sheet = workbook.getWorksheet('分镜脚本');
  assert.deepEqual(sheet.getCell('E2').value, { text: '查看新原图', hyperlink: imageUpdates[0].newHyperlink });
  assert.deepEqual(sheet.getCell('E3').value, { text: '查看补入图', hyperlink: imageUpdates[1].newHyperlink });
  assert.equal(sheet.getImages().length, 2);
  assert.equal(sheet.getRow(2).height, 119);
  assert.equal(sheet.getRow(3).height, 119);
  assert.equal(sheet.getColumn(5).width, 20);
  assert.equal(sheet.getCell('B2').font.name, 'Microsoft YaHei');
  assert.equal(sheet.getCell('D2').value, '保留手填意见');
  const added = sheet.getImages().find(image => image.range.tl.nativeRow === 2);
  assert.equal(added.range.tl.nativeCol, 4);
  assert.equal(added.range.tl.nativeColOff, 4 * 9525);
  assert.equal(added.range.tl.nativeRowOff, 22 * 9525);
  assert.equal(added.range.br.nativeColOff - added.range.tl.nativeColOff, 240 * 9525);
  assert.equal(added.range.br.nativeRowOff - added.range.tl.nativeRowOff, 135 * 9525);
  assert.deepEqual(workbook.model.media.map(media => sha256(media.buffer)), [sha256(Buffer.from(red, 'base64')), sha256(Buffer.from(blue, 'base64'))]);
  const repeatedOutput = path.join(path.dirname(state.source), '重复.xlsx');
  const stale = patch({ source: state.output, output: repeatedOutput, expectedSha256: sha256(bytes), imageUpdates });
  assert.equal(stale.status, 1);
  assert.equal(stale.data.error.code, 'STALE_IMAGE');
  assert.equal(fs.existsSync(repeatedOutput), false);
  const repeated = patch({ source: state.output, output: repeatedOutput, expectedSha256: sha256(bytes),
    imageUpdates: imageUpdates.map(update => ({ ...update, expectedSha256: sha256(Buffer.from(update.newBufferBase64, 'base64')) })) });
  assert.equal(repeated.status, 0, repeated.stdout);
  assert.deepEqual(repeated.data.changedEntries, []);
  assert.deepEqual(fs.readFileSync(repeatedOutput), bytes);
});

test('image patch refuses invalid PNG, occupied slots, shared media and ambiguous anchors', async t => {
  const state = await imageFixture(t);
  const update = { sheet: '分镜脚本', cell: 'E2', expectedSha256: state.oldImageHash,
    newBufferBase64: pngBase64(1, 2, 3), newHyperlink: 'file:///D:/storyboard/new.png',
    anchor: { leftPx: 4, topPx: 22, widthPx: 240, heightPx: 135 } };
  const corruptPng = Buffer.from(update.newBufferBase64, 'base64'); corruptPng[corruptPng.length - 1] ^= 1;
  const cases = [
    [[{ ...update, expectedSha256: '0'.repeat(64) }], 'STALE_IMAGE'],
    [[{ ...update, expectedSha256: null }], 'IMAGE_SLOT_CHANGED'],
    [[{ ...update, cell: 'E3' }], 'IMAGE_SLOT_CHANGED'],
    [[update, update], 'DUPLICATE_IMAGE'],
    [[{ ...update, newBufferBase64: Buffer.from('not a PNG').toString('base64') }], 'INVALID_PNG'],
    [[{ ...update, newBufferBase64: corruptPng.toString('base64') }], 'INVALID_PNG'],
    [[{ ...update, sheet: '生成Prompt', cell: 'A1', expectedSha256: null }], 'MISSING_DRAWING'],
    [[{ ...update, anchor: { ...update.anchor, widthPx: -1 } }], 'INVALID_IMAGE_UPDATE'],
  ];
  for (const [imageUpdates, code] of cases) {
    const result = patch({ ...state, imageUpdates });
    assert.equal(result.status, 1);
    assert.equal(result.data.error.code, code, result.stdout);
    assert.equal(fs.existsSync(state.output), false);
    assert.equal(sha256(fs.readFileSync(state.source)), state.expectedSha256);
  }
  for (const [range, code] of [['E2:E3', 'AMBIGUOUS_IMAGE_SLOT'], ['D3:E4', 'SHARED_IMAGE']]) {
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(state.original);
    const sheet = workbook.getWorksheet('分镜脚本');
    sheet.addImage(sheet.getImages()[0].imageId, range);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    fs.writeFileSync(state.source, bytes);
    const result = patch({ ...state, expectedSha256: sha256(bytes), imageUpdates: [update] });
    assert.equal(result.status, 1);
    assert.equal(result.data.error.code, code, result.stdout);
    assert.equal(fs.existsSync(state.output), false);
    assert.deepEqual(fs.readFileSync(state.source), bytes);
  }
});
