import ExcelJS from './vendor/exceljs.cjs';
import { ProjectError, composeStaticPrompt, formatCamera, categoryNames } from './project.mjs';
import { draftVariant, variantStatus } from '../assets/web/workflow.mjs';

const CELL_LIMIT = 32767;
const list = value => Array.isArray(value) ? value : [];
const joined = value => list(value).join('\n');
const json = value => value == null ? '' : JSON.stringify(value, null, 2);
const idText = value => value == null ? '' : String(value);
const shotNumber = shot => idText(shot?.displayNumber ?? shot?.sourceNumber ?? shot?.id);
const error = message => { throw new ProjectError(message, 422); };
// Literal OOXML escape-like text must be shielded from reader interpretation.
const excelText = value => value.replace(/_x[0-9a-f]{4}_/gi, match => `_x005F_${match.slice(1)}`);

// Excel counts UTF-16 units. A continuation starts after a complete Unicode character.
function chunks(value, context) {
  if (value == null) return [null];
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) error(`${context}包含非有限数值，无法导出`);
    return [value];
  }
  if (typeof value === 'boolean') return [value];
  // Normalize before splitting so CRLF cannot straddle continuation cells.
  const string = (typeof value === 'string' ? value : json(value)).replace(/\r\n?/g, '\n');
  for (const ch of string) {
    const code = ch.codePointAt(0);
    if (!(code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xD7FF || code >= 0xE000 && code <= 0xFFFD || code >= 0x10000 && code <= 0x10FFFF)) {
      error(`${context}包含 Excel XML 不允许的字符 U+${code.toString(16).toUpperCase().padStart(4, '0')}；请修正该内容后导出`);
    }
  }
  const result = [];
  for (let start = 0; start < string.length;) {
    let end = Math.min(start + CELL_LIMIT, string.length);
    if (end < string.length && string.charCodeAt(end - 1) >= 0xD800 && string.charCodeAt(end - 1) <= 0xDBFF) end--;
    result.push(string.slice(start, end)); start = end;
  }
  return result.length ? result : [''];
}

function columnWidth(label) {
  if (/Prompt|原文|原值|工作稿|脚本画面|完整|说明|理由|描述|差异|修改前|修改后|批注正文|回应|字段值|镜头内容/.test(label)) return 66;
  if (/光影|层次|表情|质感|拍摄方式|设定|来源|布局|陈设|皮肤|五官|服装/.test(label)) return 42;
  if (/秒数|版本|序号|宽度|高度|数量/.test(label)) return 12;
  if (/ID|状态|镜号/.test(label)) return 20;
  return 28;
}

export function addSheet(workbook, name, headers, rows) {
  if (!name || name.length > 31 || /[\\/*?:\[\]]/.test(name) || workbook.getWorksheet(name)) error(`工作表名称无效或重复：${name}`);
  const counts = headers.map(() => 1);
  const prepared = rows.map((row, rowIndex) => headers.map((header, i) => {
    const parts = chunks(row[i], `${name}第${rowIndex + 2}行「${header}」`);
    counts[i] = Math.max(counts[i], parts.length);
    return parts;
  }));
  const expandedHeaders = headers.flatMap((header, i) => Array.from({ length: counts[i] }, (_, n) => n ? `${header}（续${n + 1}）` : header));
  if (expandedHeaders.length > 16384 || rows.length > 1048575) error(`${name}数据超出 Excel 工作表容量`);
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, ...(name === '分镜总览' ? { xSplit: 2 } : {}) }] });
  sheet.columns = expandedHeaders.map(header => ({ header, width: columnWidth(header) }));
  sheet.properties.defaultRowHeight = 60;
  sheet.getRow(1).height = 36;
  sheet.getRow(1).eachCell(cell => {
    cell.font = { name: '等线', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF183B59' } };
  });
  for (const row of prepared) {
    const values = row.flatMap((parts, i) => Array.from({ length: counts[i] }, (_, n) => typeof parts[n] === 'string' ? excelText(parts[n]) : parts[n] ?? null));
    const excelRow = sheet.addRow(values);
    excelRow.eachCell(cell => {
      // Explicit string values remain text even if they begin with =, +, - or @.
      if (typeof cell.value === 'string') cell.numFmt = '@';
      cell.font = { name: '等线', size: 11, color: { argb: 'FF182C3B' } };
    });
  }
  sheet.eachRow(row => row.eachCell(cell => { cell.alignment = { vertical: 'top', wrapText: true }; }));
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: expandedHeaders.length } };
  return sheet;
}

/** Agent drafts and user choices share one resolver; exporting never changes either. */
export async function exportExcel(project, date = new Date()) {
  if (!project || typeof project !== 'object' || !list(project.shots).length) error('项目暂无可导出的分镜');
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) error('导出日期无效');
  const shots = project.shots;
  const draft = project.workflowMode === 'agent-default';
  const missing = shots.filter(shot => !draftVariant(project, shot));
  if (missing.length) error(draft ? `当前草案缺少有效默认方案；镜号：${missing.map(shotNumber).join('、')}` : `请先选择全部镜头的 Prompt；未选镜号：${missing.map(shotNumber).join('、')}`);
  const selected = new Map(shots.map(shot => [shot.id, draftVariant(project, shot)]));
  const metadata = (shot, variant) => draft ? [shot.selectedVariantId === variant.id ? '用户选择' : 'Agent 默认方案', variantStatus(project, shot, variant) + (variant.promptNeedsSync ? '；待同步' : '')] : [];
  const references = list(project.references);
  const referencePaths = ids => list(ids).map(id => references.find(ref => ref.id === id)).filter(Boolean).flatMap(ref => [ref.path, ref.url].filter(Boolean)).join('\n');
  const originalFields = [...new Set(shots.flatMap(shot => list(shot.originalFields).map(field => field.name).filter(Boolean)))];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '分镜工作台'; workbook.created = date; workbook.modified = date;
  workbook.title = project.title || '分镜项目';

  const overview = [], prompts = [];
  for (const shot of shots) {
    const variant = selected.get(shot.id), b = variant.breakdown;
    const camera = b ? formatCamera(project, b.camera) : '';
    overview.push([
      shotNumber(shot), shot.suggestedDuration ?? null, shot.workingScript ?? shot.original ?? '', shot.original ?? '', idText(shot.sourceNumber),
      ...originalFields.map(name => list(shot.originalFields).filter(field => field.name === name).map(field => field.value ?? '').join('\n')),
      b?.content ?? '', camera, b?.composition ?? '', b?.lighting ?? '', b?.pose ?? '', b?.characters ?? '', b?.scene ?? '', b?.texture ?? '',
      idText(variant.id), variant.title ?? '', shot.purpose ?? '', referencePaths(variant.referenceIds), idText(shot.id), ...metadata(shot, variant)
    ]);
    prompts.push(['分镜主静帧', shotNumber(shot), shot.suggestedDuration ?? null, idText(variant.id), variant.title ?? '', '主静帧',
      composeStaticPrompt(project, variant), idText(shot.id), '', variant.version ?? null, joined(variant.characterAssetIds), referencePaths(variant.referenceIds), ...metadata(shot, variant)]);
  }
  for (const section of list(project.promptSections)) {
    const shotIds = list(section.shotIds);
    if (section.category === 'shotFrames' && !section.variantId) continue;
    if (section.variantId && (!shotIds.length || !shotIds.every(id => selected.get(id)?.id === section.variantId))) continue;
    const numbers = shotIds.map(id => shotNumber(shots.find(shot => shot.id === id)) || id).join('\n');
    const pathIds = list(section.referenceIds).length ? section.referenceIds
      : references.filter(ref => list(ref.assetIds).some(id => list(section.assetIds).includes(id))).map(ref => ref.id);
    for (const prompt of list(section.prompts)) prompts.push([
      categoryNames[section.category] ?? section.category ?? '独立静态Prompt', numbers,
      section.category === 'shotFrames' ? shots.find(shot => shot.id === shotIds[0])?.suggestedDuration ?? null : null,
      idText(section.variantId), section.title ?? '', prompt.label ?? '', prompt.text ?? '', joined(shotIds), idText(section.id),
      section.version ?? null, joined(section.assetIds), referencePaths(pathIds),
      ...(draft ? section.variantId ? [metadata(shots.find(s => s.id === shotIds[0]), selected.get(shotIds[0]))[0], section.promptNeedsSync ? '补帧待同步' : '补帧待核对'] : ['独立内容', section.promptNeedsSync ? '待同步' : '待核对'] : [])
    ]);
  }
  addSheet(workbook, '分镜总览', ['镜号', '建议秒数', '脚本画面工作稿', '导入原稿', '原镜号', ...originalFields,
    '镜头内容', '景别／拍摄方式', '构图与空间层次', '光影／色调', '姿态与表情', '角色描述', '场景描述', '材质与画面质感',
    draft ? '当前方案ID' : '已选方案ID', draft ? '当前方案名称' : '已选方案名称', '叙事目的', '参考图路径／链接', '镜头ID', ...(draft ? ['方案来源', '审核状态'] : [])], overview);
  addSheet(workbook, '总共的Prompt', ['类型', '关联镜号', '镜头秒数（补帧不累加）', draft ? '当前方案ID' : '已选方案ID', '内容标题', '帧名称／视角',
    '静态Prompt', '关联镜头ID', '内容ID', '内容版本', '关联资产ID', '参考图路径／链接', ...(draft ? ['方案来源', '审核状态'] : [])], prompts);
  const datePart = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const safeTitle = Array.from(String(project.title || '分镜项目').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim().replace(/[. ]+$/g, '')).slice(0, 80).join('') || '分镜项目';
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { buffer, filename: `${safeTitle}-${draft ? '当前草案' : '已选分镜'}-${datePart}.xlsx` };
}
