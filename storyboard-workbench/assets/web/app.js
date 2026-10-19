import { draftVariant, variantStatus } from './workflow.mjs';
let project, view = 'quiz', activeShotId, activeVariantId, selectedCell, drawerMode = 'shot', editing, saving = false, failed = false;
let quizShotId, quizBusy = false, quizPendingChoice;
let exportingExcel = false, actionSaving = false;
let drafts = {}, commentDrafts = {}, readonlyPromptDrafts = [], queue = [], serial = Promise.resolve(), draftKey;
let inFlightKey, failedCellKey;
let annotationMode = false, rangeSelection = [], rangeAnchor, rangeCursor, dragging, rangeDrafts = {}, activeRangeKey, focusTarget, focusScroll;
let autoScrollFrame;
const $ = id => document.getElementById(id);
const node = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
function button(text, click, cls = 'secondary') { const e = node('button', text, cls); e.type = 'button'; e.addEventListener('click', click); return e; }
const cameraFields = { equipment: '设备与画幅基准', shotSize: '景别', position: '机位与角度', movement: '镜头运动', focalLength: '焦距', aperture: '光圈 F', frameRate: '帧率', shutter: '快门速度', iso: 'ISO', focus: '对焦与景深', exposure: '进光与曝光处理', reason: '选择理由', conditions: '适用条件' };
const conciseCameraFields = { shotSize: '景别', position: '机位', focalLength: '焦距', focus: '景深', equipment: '设备' };
const characterFields = { name: '角色名称', identity: '身份与外观方向', age: '年龄段', face: '脸型与五官', skin: '肤色与皮肤状态', hair: '发型发色', build: '体型与体态', clothing: '服装与配饰', traits: '辨识特征与气质', description: '完整角色设定', basis: '依据与待确认项' };
const locationFields = { name: '场景名称', layout: '空间布局', props: '陈设与道具', materials: '材质', environment: '环境特征', description: '完整场景描述', basis: '依据与待确认项' };
const topicFields = { content: '镜头内容', composition: '构图与空间层次', lighting: '光影／色调', pose: '姿态与表情', characters: '角色描述', scene: '场景描述', texture: '材质与画面质感', decision: '取舍与适用条件', continuity: '连续性与限制' };
const labels = { displayNumber: '显示镜号', suggestedDuration: '建议秒数', workingScript: '脚本画面（工作稿）', title: '标题', description: '说明', rationale: '设计理由', staticPrompt: '静帧 Prompt', motionPrompt: '动作 Prompt', shotSchema: '人物、道具与关系', ...topicFields };
const views = { quiz: '逐镜选择', staticPrompts: '全部 Prompt', sceneViews: '场景静态 Prompt', shots: '分镜总表', characters: '角色清单', locations: '场景清单', characterViews: '角色三视图' };
const keyOf = t => JSON.stringify(t);
function info(t) {
  let owner;
  if (t.kind === 'shot') owner = project.shots.find(s => s.id === t.shotId);
  if (t.kind === 'variant') owner = project.shots.find(s => s.id === t.shotId).variants.find(v => v.id === t.variantId);
  if (t.kind === 'asset') owner = project.productionInventory[t.assetType].find(e => e.id === t.assetId);
  if (t.kind === 'section') owner = project.promptSections.find(s => s.id === t.sectionId);
  let value = t.field.split('.').reduce((o, k) => o?.[k], owner);
  if (t.field === 'shotSchema') value = value ? JSON.stringify(value, null, 2) : '';
  if (t.field === 'workingScript') value ??= owner.original;
  if (t.field === 'displayNumber') value ??= String(owner.sourceNumber);
  const field = t.field.split('.').at(-1);
  const label = t.field.startsWith('breakdown.camera.') ? (project.staticPromptFormat === 'concise-v1' ? conciseCameraFields[field] : null) || cameraFields[field] : t.kind === 'asset' ? (t.assetType === 'characters' ? characterFields : locationFields)[field] : t.field.startsWith('prompts.') ? owner.prompts[Number(t.field.split('.')[1])].label + (field === 'text' ? ' Prompt' : '名称') : labels[field] || field;
  return { value: String(value ?? ''), owner, version: t.kind === 'shot' ? owner.editVersion ?? 1 : owner.version ?? 1, label, title: t.kind === 'asset' ? owner.name : t.kind === 'section' ? owner.title : '镜 ' + (project.shots.find(s => s.id === t.shotId).displayNumber ?? project.shots.find(s => s.id === t.shotId).sourceNumber) + (t.variantId ? ' / ' + t.variantId : '') };
}
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function isDerivedPrompt(t) { return t.kind === 'variant' && t.field === 'staticPrompt' && !!info(t).owner.breakdown; }
function isSchemaProjection(t) { return t.kind === 'variant' && ['breakdown.characters', 'breakdown.pose'].includes(t.field) && !!info(t).owner.shotSchema; }
function isReadonlyCell(t) { return isDerivedPrompt(t) || isSchemaProjection(t); }
function schemaSummary(value) {
  try {
    const s = JSON.parse(value), name = id => project.productionInventory?.characters?.find(a => a.id === id)?.name || id;
    return [
      `${s.subjects.length} 人物 · ${s.props.length} 道具 · ${s.relations.length} 关系`,
      ...(s.referenceIds.length ? ['通用参考：' + s.referenceIds.join('、')] : []),
      ...s.subjects.map(person => `${name(person.assetId)}[${person.assetId}]：` + ['appearance', 'clothing', 'position', 'orientation', 'pose', 'hands', 'gaze', 'expression', 'visibleParts'].map(key => person[key]).filter(Boolean).join('，') + (person.referenceIds.length ? '；参考' + person.referenceIds.join('、') : '')),
      ...s.props.map(prop => `${prop.name || '未命名道具'}[${prop.id}]：` + [prop.state, prop.position, prop.holderAssetIds.length ? '持有者' + prop.holderAssetIds.map(name).join('、') : '', prop.referenceIds.length ? '参考' + prop.referenceIds.join('、') : ''].filter(Boolean).join('，')),
      ...s.relations.map(relation => relation.description || '待填写的关系')
    ].join('\n');
  }
  catch { return value ? '结构化草稿待核对' : '尚未登记人物、道具与关系'; }
}
function displayValue(t, value) { return t.field === 'shotSchema' ? schemaSummary(value) : value; }
function preserveReadonlyDrafts() {
  const moved = [];
  for (const [key, draft] of Object.entries(drafts)) {
    if (!isReadonlyCell(draft.target)) continue;
    if (!readonlyPromptDrafts.some(d => keyOf(d.target) === key && d.value === draft.value && d.baseValue === draft.baseValue)) readonlyPromptDrafts.push({ ...draft, preservedAt: new Date().toISOString() });
    delete drafts[key]; moved.push(key);
  }
  if (!moved.length) return;
  queue = queue.filter(key => !moved.includes(key));
  if (moved.includes(failedCellKey) && !queue.length) { failed = false; failedCellKey = null; }
  persist();
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); notice('已复制。'); }
  catch { notice('浏览器未允许自动复制，请选中文字后手动复制。', true); }
}
async function openBreakdown(target) {
  if (quizBusy) return;
  if (editing) commit(); await pump();
  if (failed || queue.length) { notice('请先处理保存问题，再进入分镜维度。', true); return; }
  if ($('focus-dialog').open) { $('focus-dialog').close(); focusTarget = null; }
  view = 'shots'; activeShotId = target.shotId; activeVariantId = target.variantId; drawerMode = 'none';
  selectedCell = { kind: 'variant', shotId: target.shotId, variantId: target.variantId, field: 'breakdown.content' };
  rangeSelection = []; activeRangeKey = null; persist(); render();
  requestAnimationFrame(() => { const e = findCell(selectedCell); e?.scrollIntoView({ block: 'center', inline: 'center' }); e?.focus({ preventScroll: true }); });
}
function showReadonlyDrafts() {
  const container = $('legacy-prompt-list'); container.replaceChildren();
  for (const draft of readonlyPromptDrafts) {
    const article = node('article', undefined, 'legacy-prompt-draft'); let data;
    try { data = info(draft.target); } catch {}
    article.append(node('h3', data ? data.title + ' · ' + data.label : '原目标已不存在'));
    const text = node('textarea'); text.readOnly = true; text.value = draft.value; text.setAttribute('aria-label', '保留的旧 Prompt 草稿');
    const convert = button('转为批注', () => {
      $('legacy-prompt-dialog').close(); view = 'quiz'; setQuizShot(draft.target.shotId); render(); openAnnotation([draft.target]);
      const saved = rangeDrafts[activeRangeKey], proposal = '请根据这份旧 Prompt 草稿修改对应分镜维度：\n' + draft.value;
      saved.text = saved.text ? saved.text + '\n\n' + proposal : proposal; persist(); renderDrawer(); saveState();
    }, 'secondary'); convert.disabled = !data;
    article.append(text, button('复制旧草稿', () => copyText(draft.value)), convert); container.append(article);
  }
  $('legacy-prompt-dialog').showModal();
}
function persist() {
  if (!draftKey) return;
  try { localStorage.setItem(draftKey, JSON.stringify({ drafts, commentDrafts, readonlyPromptDrafts, rangeDrafts, activeRangeKey, view, quizShotId, quizPendingChoice, uiVersion: 'quiz-1' })); }
  catch { notice('浏览器无法保存本地草稿；请保留页面并完成保存。', true); }
}
function saveState() {
  const shots = project?.shots ?? [], chosen = shots.filter(s => s.variants.some(v => v.id === s.selectedVariantId)).length;
  const draft = project?.workflowMode === 'agent-default', available = draft ? shots.filter(s => draftVariant(project, s)).length : chosen;
  $('excel-selection-count').textContent = draft ? `草案 ${available}/${shots.length} 镜 · 用户选择 ${chosen}` : `已选 ${chosen}/${shots.length} 镜`;
  $('export-excel').disabled = !shots.length || available !== shots.length || exportingExcel || actionSaving || quizBusy;
  if (!exportingExcel) $('export-excel').textContent = draft ? '导出当前草案' : '导出已选 Excel';
  $('export-excel').title = available === shots.length && shots.length ? draft ? '导出当前草案；Agent默认方案不等于用户已确认' : '导出已选方案和独立静态 Prompt' : draft ? '请先补齐有效默认方案' : '请先为每镜选择方案，再导出 Excel';
  $('save-status').textContent = saving ? '保存中…' : failed ? '保存失败 · 草稿已保留' : Object.keys(drafts).length ? '有未保存草稿' : '已保存';
  $('retry').hidden = !failed && !Object.keys(drafts).length;
  $('restore-annotation').hidden = !Object.values(rangeDrafts).some(d => d.text);
  $('legacy-prompt-drafts').hidden = !readonlyPromptDrafts.length;
  $('legacy-prompt-drafts').textContent = '旧 Prompt 草稿（' + readonlyPromptDrafts.length + '）';
  document.querySelectorAll('[data-quiz-nav], [data-select-variant], #quiz-retry').forEach(e => { e.disabled = quizBusy || saving || e.dataset.unavailable === 'true'; });
  document.querySelectorAll('#main-tags button').forEach(e => { e.disabled = quizBusy; });
  $('shot-quiz').classList.toggle('quiz-busy', quizBusy);
}
async function downloadExcel() {
  if (exportingExcel || !project) return;
  if (actionSaving || quizBusy) { notice('正在保存，请完成后再导出 Excel。'); return; }
  exportingExcel = true; saveState(); $('export-excel').textContent = '正在导出…';
  try {
    if (editing) commit();
    await pump();
    if (actionSaving || quizBusy) throw new Error('正在保存，请完成后再导出 Excel。');
    if (failed || queue.length || Object.keys(drafts).length) throw new Error('请先保存或处理未保存的修改，再导出 Excel。');
    const response = await fetch('/api/export.xlsx');
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || 'Excel导出失败，请重试。');
    }
    if (!response.headers.get('content-type')?.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) throw new Error('服务器返回的文件格式不正确，请重试。');
    const blob = await response.blob();
    if (!blob.size) throw new Error('导出文件为空，请重试。');
    const header = response.headers.get('content-disposition') || '';
    const filename = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const link = document.createElement('a'), url = URL.createObjectURL(blob);
    link.href = url; link.download = filename ? decodeURIComponent(filename) : '分镜工作台.xlsx';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const hasComments = Object.values(commentDrafts).some(Boolean) || Object.values(rangeDrafts).some(d => d.text);
    notice((project.workflowMode === 'agent-default' ? '已下载当前草案，确认状态保留在文件中。' : '已下载全部镜头的当前选择。') + (hasComments ? '未提交的批注草稿不包含在文件中。' : ''));
  } catch (error) { notice(error.message || 'Excel导出失败，请重试。', true); }
  finally { exportingExcel = false; saveState(); }
}
async function post(values) {
  const response = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, baseRevision: project.revision }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  project = result;
  preserveReadonlyDrafts();
}
function queueCell(t) {
  if (isReadonlyCell(t)) { preserveReadonlyDrafts(); saveState(); return; }
  const key = keyOf(t);
  if (!queue.includes(key)) queue.push(key);
  persist(); pump();
}
function pump() {
  preserveReadonlyDrafts();
  if (saving || failed || !queue.length) return serial;
  saving = true; saveState();
  serial = (async () => {
    while (queue.length && !failed) {
      const key = queue.shift(), draft = drafts[key]; if (!draft) continue;
      if (isReadonlyCell(draft.target)) { preserveReadonlyDrafts(); continue; }
      const snapshot = draft.value;
      inFlightKey = key;
      try {
        await post({ type: 'edit-cell', target: draft.target, value: snapshot, expectedValue: draft.baseValue });
        if (drafts[key]?.value === snapshot && editing?.key !== key) delete drafts[key];
        else if (drafts[key]) drafts[key].baseValue = info(draft.target).value;
        persist();
        notice('已保存 · revision ' + project.revision);
      } catch (error) { failed = true; failedCellKey = key; queue.unshift(key); notice(error.message + '。请读取最新结果，在右栏比较后重试。', true); }
      finally { inFlightKey = null; }
    }
  })().finally(() => { saving = false; saveState(); if (!editing && !dragging) render(); if (queue.length && !failed) pump(); });
  return serial;
}
async function action(values, onSuccess) {
  await pump();
  if (failed || queue.length || editing) { notice('请先保存当前编辑并处理保存冲突。', true); return; }
  actionSaving = true; saving = true; saveState();
  try { await post(values); onSuccess?.(); persist(); render(); notice('已保存 · revision ' + project.revision); }
  catch (error) { failed = true; failedCellKey = null; notice(error.message + '。输入已保留，请读取最新结果后重试。', true); }
  finally { actionSaving = false; saving = false; saveState(); if (queue.length && !failed) pump(); }
}
async function refresh(manual = false) {
  if (dragging || annotationMode && !manual || saving || editing && !manual) return;
  if (editing && manual) { commit(); await pump(); }
  try {
    const response = await fetch('/api/project'), latest = await response.json();
    if (!response.ok) throw new Error(latest.error);
    if (!project) {
      project = latest; draftKey = 'storyboard-cells:' + (project.projectId || project.source?.sha256 || project.title);
      view = project.workflowMode === 'agent-default' ? 'shots' : 'quiz';
      try { const stored = JSON.parse(localStorage.getItem(draftKey) || '{}'); drafts = stored.drafts || {}; commentDrafts = stored.commentDrafts || {}; readonlyPromptDrafts = Array.isArray(stored.readonlyPromptDrafts) ? stored.readonlyPromptDrafts : []; rangeDrafts = stored.rangeDrafts || {}; activeRangeKey = stored.activeRangeKey; if (stored.uiVersion === 'quiz-1' && Object.hasOwn(views, stored.view)) view = stored.view; quizShotId = stored.quizShotId; quizPendingChoice = stored.quizPendingChoice; } catch {}
      if (!project.shots.some(s => s.id === quizShotId)) quizShotId = project.shots[0]?.id;
      // Old draft targets are checked against current IDs before being displayed.
      for (const [key, d] of Object.entries(drafts)) { try { info(d.target); } catch { delete drafts[key]; } }
      preserveReadonlyDrafts();
      if (rangeDrafts[activeRangeKey]?.text) { rangeSelection = rangeDrafts[activeRangeKey].targets; selectedCell = rangeSelection[0]?.target; drawerMode = 'comment'; }
      render(); return;
    }
    if (latest.revision < project.revision || latest.revision === project.revision && !manual) return;
    if (!manual && (Object.keys(drafts).length || Object.values(commentDrafts).some(Boolean) || Object.values(rangeDrafts).some(d => d.text))) { notice('Agent 已更新结果；草稿保留。可点击“读取最新结果”比较。'); return; }
    project = latest; preserveReadonlyDrafts(); render();
    if (manual) notice('已读取最新结果；未保存草稿保留，冲突可在批注侧栏比较。');
  } catch (error) { notice('读取失败：' + error.message, true); }
}
function findCell(t) { const scope = $('focus-dialog').open ? $('focus-dialog') : document; return [...scope.querySelectorAll('[data-cell]')].find(e => e.dataset.cell === keyOf(t)); }
function select(t) {
  selectedCell = t;
  for (const e of document.querySelectorAll('[data-cell]')) e.classList.toggle('selected', e.dataset.cell === keyOf(t));
  $('annotate-cell').hidden = annotationMode || !t;
}
function cell(t, compact = false) {
  const data = info(t), key = keyOf(t), derived = isDerivedPrompt(t), projection = isSchemaProjection(t), e = node('div', undefined, 'cell' + (compact ? ' compact' : ''));
  e.dataset.cell = key; e.tabIndex = 0; e.setAttribute('role', 'group'); e.setAttribute('aria-label', data.title + ' · ' + data.label);
  const value = node('div', displayValue(t, (derived || projection ? data.value : drafts[key]?.value ?? data.value)) || (project.staticPromptFormat === 'concise-v1' && t.field.startsWith('breakdown.') ? '—' : '待填写'), 'cell-value');
  const comments = project.comments.filter(c => c.target && keyOf(c.target) === key), count = comments.filter(c => c.status === 'pending').length, responses = comments.filter(c => c.status === 'addressed').length;
  const comment = button(count ? String(count) : responses ? String(responses) : '•', event => { event.stopPropagation(); openAnnotation([t]); }, 'cell-comment');
  comment.setAttribute('aria-label', data.title + ' · ' + data.label + ' · 添加批注');
  comment.hidden = !comments.length;
  const expand = button('展开', event => { event.stopPropagation(); openFocus(t); }, 'cell-expand');
  expand.setAttribute('aria-label', data.title + ' · ' + data.label + ' · 展开全文');
  expand.hidden = compact || data.value.length < 36;
  e.append(value, comment, expand);
  if (derived) {
    e.dataset.derivedPrompt = 'true'; e.setAttribute('aria-description', '由分镜总表自动汇总，只读。');
    const controls = node('div', undefined, 'derived-prompt-tools'), edit = button('编辑分镜维度', event => { event.stopPropagation(); openBreakdown(t); }, 'text-button'); edit.dataset.editBreakdown = key;
    controls.append(node('span', '由分镜总表自动汇总'), edit, button('复制 Prompt', event => { event.stopPropagation(); copyText(info(t).value); }, 'text-button')); e.append(controls);
  }
  if (projection || project.staticPromptFormat === 'concise-v1' && t.kind === 'variant' && ['breakdown.characters', 'breakdown.pose'].includes(t.field)) {
    if (projection) { e.dataset.schemaProjection = 'true'; e.setAttribute('aria-description', '由结构化人物、道具与关系自动汇总，只读。'); }
    const edit = button('编辑人物与道具', event => { event.stopPropagation(); openFocus({ ...t, field: 'shotSchema' }); }, 'text-button'); edit.dataset.editShotSchema = t.variantId;
    e.append(edit);
  }
  e.addEventListener('click', () => { if (!annotationMode) select(t); });
  e.addEventListener('dblclick', event => { if (!annotationMode && !event.target.closest('button,input,textarea,select,form')) startEdit(e, t); });
  e.addEventListener('keydown', event => {
    if (event.target.closest('textarea,button,input,select,form')) return;
    if (!annotationMode && (event.key === 'F2' || event.key === 'Enter')) { event.preventDefault(); startEdit(e, t); }
  });
  e.classList.toggle('selected', !!selectedCell && keyOf(selectedCell) === key);
  if (!derived && !projection && drafts[key]) e.classList.add('has-draft');
  return e;
}
function startEdit(e, t) {
  if (quizBusy) return;
  if (isSchemaProjection(t)) { openFocus({ ...t, field: 'shotSchema' }); return; }
  if (isDerivedPrompt(t)) { select(t); e.focus({ preventScroll: true }); notice('这段 Prompt 由分镜总表自动汇总，请点击“编辑分镜维度”修改。'); return; }
  if (editing) commit();
  const key = keyOf(t), data = info(t), input = node('textarea', undefined, 'cell-input');
  const initialDraft = drafts[key] ? structuredClone(drafts[key]) : null;
  drafts[key] ??= { target: t, value: data.value, baseValue: data.value };
  input.value = drafts[key].value; input.setAttribute('aria-label', data.label + ' 编辑');
  editing = { key, target: t, input, element: e, initialDraft }; select(t); e.classList.add('editing');
  e.querySelector('.cell-value').hidden = true; e.querySelector('.cell-comment').hidden = true; e.querySelector('.cell-expand').hidden = true; e.append(input);
  input.addEventListener('input', () => { drafts[key].value = input.value; persist(); saveState(); });
  if (t.field === 'shotSchema') {
    input.hidden = true;
    try { editing.form = schemaEditor(input); e.append(editing.form); }
    catch { input.hidden = false; input.readOnly = true; notice('结构化草稿无法解析，原文已保留；请在右栏核对或取消本次编辑。', true); }
    editing.form?.querySelector('input,textarea,select,button')?.focus(); persist(); saveState(); return;
  }
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); cancelEdit(); }
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(true); }
    else if (event.key === 'Tab') {
      event.preventDefault(); const scope = e.closest('#focus-dialog') || document, cells = [...scope.querySelectorAll('[data-cell]')].filter(e => e.getClientRects().length), next = cells[cells.indexOf(e) + (event.shiftKey ? -1 : 1)], nextTarget = next ? JSON.parse(next.dataset.cell) : null;
      commit(); if (nextTarget) { const nextCell = findCell(nextTarget); if (nextCell) startEdit(nextCell, nextTarget); }
    }
  });
  input.addEventListener('blur', () => { if (editing?.input === input) commit(); });
  input.focus(); input.setSelectionRange(input.value.length, input.value.length); persist(); saveState();
}
function finishEditor(current) {
  editing = null; current.input.remove(); current.form?.remove(); current.element.classList.remove('editing');
  const display = current.element.querySelector('.cell-value'); display.hidden = false; display.textContent = displayValue(current.target, (isReadonlyCell(current.target) ? info(current.target).value : drafts[current.key]?.value ?? info(current.target).value)) || '待填写';
  current.element.querySelector('.cell-comment').hidden = !project.comments.some(c => c.target && keyOf(c.target) === current.key);
  current.element.querySelector('.cell-expand').hidden = current.element.classList.contains('compact') || display.textContent.length < 36;
}
function commit(keepFocus = false) {
  if (!editing) return;
  const current = editing; drafts[current.key].value = current.input.value;
  finishEditor(current);
  if (isReadonlyCell(current.target)) { preserveReadonlyDrafts(); saveState(); return; }
  if (keepFocus) current.element.focus({ preventScroll: true });
  if (drafts[current.key].value === drafts[current.key].baseValue && inFlightKey !== current.key) { delete drafts[current.key]; persist(); saveState(); }
  else queueCell(current.target);
}
function cancelEdit() {
  if (!editing) return; const current = editing;
  if (current.initialDraft) drafts[current.key] = { ...current.initialDraft, baseValue: drafts[current.key]?.baseValue ?? current.initialDraft.baseValue }; else delete drafts[current.key];
  finishEditor(current); persist(); saveState(); current.element.focus();
}
function schemaEditor(input) {
  const schema = input.value ? JSON.parse(input.value) : { referenceIds: [], subjects: [], props: [], relations: [] };
  const form = node('form', undefined, 'schema-editor'); form.dataset.shotSchemaEditor = '';
  const assets = project.productionInventory?.characters || [], refs = project.references || [];
  const subjectFields = { appearance: '可见外貌', clothing: '服装', position: '画面位置与层次', orientation: '身体朝向', pose: '姿态', hands: '手部动作', gaze: '视线', expression: '表情', visibleParts: '可见部位' };
  const types = { gaze: '视线关系', contact: '接触与道具关联', occlusion: '距离与遮挡', sameFrame: '必须同时可见' };
  const changed = () => { input.value = JSON.stringify(schema, null, 2); input.dispatchEvent(new Event('input')); };
  const field = (container, title, value, update, key) => {
    const label = node('label', title), control = node('textarea'); control.rows = 2; control.value = value || ''; control.setAttribute('aria-label', title); control.dataset.schemaField = key;
    control.addEventListener('input', () => { update(control.value); changed(); }); label.append(control); container.append(label);
  };
  const choices = (container, title, values, options, update, key) => {
    const group = node('fieldset', undefined, 'schema-choices'); group.dataset.schemaChoices = key; group.append(node('legend', title));
    let selected = [...values || []];
    const all = [...options]; for (const id of values || []) if (!all.some(o => o.id === id)) all.push({ id, name: id + '（已失效，需核对）' });
    if (!all.length) group.append(node('p', '暂无可用项', 'muted'));
    for (const option of all) {
      const label = node('label'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.value = option.id; checkbox.checked = (values || []).includes(option.id);
      checkbox.addEventListener('change', () => { selected = checkbox.checked ? selected.includes(option.id) ? selected : [...selected, option.id] : selected.filter(id => id !== option.id); update(selected); changed(); }); label.append(checkbox, document.createTextNode(option.name)); group.append(label);
    }
    container.append(group);
  };
  const referenceOptions = refs.map(r => ({ id: r.id, name: r.id + ' · ' + (r.label || r.id) }));
  const actorOptions = assets.map(a => ({ id: a.id, name: a.name + ' · ' + a.id }));
  const heading = (container, title, remove) => { container.setAttribute('aria-label', title); const header = node('header'); header.append(node('h4', title), button('移除此项', remove, 'text-button')); container.append(header); };
  const render = () => {
    form.replaceChildren(node('p', '每人单独填写本镜可见信息；关系使用已登记人物与本镜道具。参考只可选择当前项目中的实际附件。', 'muted'));
    choices(form, '场景与通用参考', schema.referenceIds, referenceOptions, value => schema.referenceIds = value, 'referenceIds');
    const people = node('section', undefined, 'schema-group'); people.append(node('h3', '入镜人物'));
    for (const subject of schema.subjects) {
      const card = node('fieldset', undefined, 'schema-card'); card.dataset.schemaSubject = subject.assetId;
      heading(card, assets.find(a => a.id === subject.assetId)?.name || subject.assetId, () => { schema.subjects = schema.subjects.filter(s => s !== subject); changed(); render(); });
      const actorLabel = node('label', '角色资产'), selectActor = node('select'); selectActor.setAttribute('aria-label', '角色资产');
      for (const asset of assets.filter(a => a.id === subject.assetId || !schema.subjects.some(s => s.assetId === a.id))) { const option = node('option', asset.name + ' · ' + asset.id); option.value = asset.id; selectActor.append(option); }
      selectActor.value = subject.assetId; selectActor.addEventListener('change', () => { subject.assetId = selectActor.value; changed(); render(); }); actorLabel.append(selectActor); card.append(actorLabel);
      choices(card, '人物参考', subject.referenceIds, referenceOptions, value => subject.referenceIds = value, 'subject.referenceIds');
      const fields = node('div', undefined, 'schema-fields'); for (const [key, title] of Object.entries(subjectFields)) field(fields, title, subject[key], value => subject[key] = value, key); card.append(fields); people.append(card);
    }
    const addSubject = button('添加人物', () => {
      const asset = assets.find(a => !schema.subjects.some(s => s.assetId === a.id)); if (!asset) return;
      schema.subjects.push({ assetId: asset.id, referenceIds: [], ...Object.fromEntries(Object.keys(subjectFields).map(key => [key, ''])) }); changed(); render();
    }); addSubject.dataset.schemaAddSubject = ''; addSubject.disabled = assets.every(a => schema.subjects.some(s => s.assetId === a.id)); people.append(addSubject); form.append(people);
    const props = node('section', undefined, 'schema-group'); props.append(node('h3', '本镜道具'));
    for (const prop of schema.props) {
      const card = node('fieldset', undefined, 'schema-card'); card.dataset.schemaProp = prop.id;
      heading(card, prop.name || '新道具', () => { schema.props = schema.props.filter(p => p !== prop); changed(); render(); });
      card.append(node('p', '道具 ID：' + prop.id, 'muted'));
      const fields = node('div', undefined, 'schema-fields');
      for (const [key, title] of Object.entries({ name: '道具名称', state: '当前状态', position: '道具位置' })) field(fields, title, prop[key], value => prop[key] = value, 'prop.' + key);
      card.append(fields); choices(card, '持有人物', prop.holderAssetIds, actorOptions, value => prop.holderAssetIds = value, 'holderAssetIds');
      choices(card, '道具参考', prop.referenceIds, referenceOptions, value => prop.referenceIds = value, 'prop.referenceIds'); props.append(card);
    }
    const addProp = button('添加道具', () => { schema.props.push({ id: 'PROP-' + crypto.randomUUID(), name: '', state: '', position: '', holderAssetIds: [], referenceIds: [] }); changed(); render(); }); addProp.dataset.schemaAddProp = ''; props.append(addProp); form.append(props);
    const relations = node('section', undefined, 'schema-group'); relations.append(node('h3', '人物与道具关系'));
    for (const relation of schema.relations) {
      const card = node('fieldset', undefined, 'schema-card'); card.dataset.schemaRelation = relation.id;
      heading(card, types[relation.type] || '关系', () => { schema.relations = schema.relations.filter(r => r !== relation); changed(); render(); });
      const label = node('label', '关系类型'), control = node('select'); control.setAttribute('aria-label', '关系类型');
      for (const [value, title] of Object.entries(types)) { const option = node('option', title); option.value = value; control.append(option); }
      control.value = relation.type; control.addEventListener('change', () => { relation.type = control.value; changed(); render(); }); label.append(control); card.append(label);
      if (relation.type === 'gaze') {
        for (const [index, title, options] of [[0, '视线发出者', actorOptions.filter(a => schema.subjects.some(s => s.assetId === a.id))], [1, '视线目标人物', actorOptions]]) {
          const label = node('label', title), select = node('select'), empty = node('option', index ? '无人物目标（可关联道具）' : '请选择入镜人物'); empty.value = ''; select.append(empty); select.setAttribute('aria-label', title); select.dataset.schemaField = index ? 'gaze.target' : 'gaze.source';
          const available = [...options], current = relation.subjectIds[index] || '';
          if (current && !available.some(a => a.id === current)) available.push({ id: current, name: current + '（已失效，需核对）' });
          for (const actor of available) { const option = node('option', actor.name); option.value = actor.id; select.append(option); }
          select.value = current; select.addEventListener('change', () => { if (index && !select.value && relation.subjectIds.length <= 2) relation.subjectIds = relation.subjectIds.slice(0, 1); else relation.subjectIds[index] = select.value; changed(); }); label.append(select); card.append(label);
        }
        if (relation.subjectIds.length > 2) card.append(node('p', '视线关系仍保留多余人物，保存前请核对：' + relation.subjectIds.slice(2).join('、'), 'sync-warning'), button('清除多余关系人物', () => { relation.subjectIds = relation.subjectIds.slice(0, 2); changed(); render(); }, 'secondary'));
      } else choices(card, '关系人物', relation.subjectIds, actorOptions, value => relation.subjectIds = value, 'subjectIds');
      choices(card, '关联道具', relation.propIds, schema.props.map(p => ({ id: p.id, name: p.name || p.id })), value => relation.propIds = value, 'propIds');
      field(card, '关系说明', relation.description, value => relation.description = value, 'relation.description'); relations.append(card);
    }
    const addRelation = button('添加关系', () => { schema.relations.push({ id: 'REL-' + crypto.randomUUID(), type: 'gaze', subjectIds: [], propIds: [], description: '' }); changed(); render(); }); addRelation.dataset.schemaAddRelation = ''; relations.append(addRelation); form.append(relations);
    const controls = node('div', undefined, 'schema-save'); controls.append(button('保存人物与道具', () => { changed(); commit(true); }), button('取消本次编辑', cancelEdit, 'secondary')); form.append(controls);
  };
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); changed(); commit(true); }
  });
  render(); return form;
}
function displayVariant(s) { return s.variants.find(v => s.id === activeShotId && v.id === activeVariantId) || draftVariant(project, s) || (project.workflowMode === 'agent-default' ? undefined : s.variants.find(v => v.id === s.recommendation?.variantId) || s.variants[0]); }
function rangeKey(targets) { return targets.map(e => keyOf(e.target)).sort().join('|'); }
function annotationItem(target) { const data = info(target); return { target, expectedVersion: data.version, originalText: data.value }; }
function openAnnotation(targets, snapshots) {
  if (editing) commit();
  rangeSelection = snapshots || targets.map(annotationItem);
  activeRangeKey = rangeKey(rangeSelection);
  rangeDrafts[activeRangeKey] ??= { targets: rangeSelection, text: targets.length === 1 ? commentDrafts[keyOf(targets[0])] || '' : '' };
  rangeSelection = rangeDrafts[activeRangeKey].targets;
  selectedCell = targets[0]; drawerMode = 'comment'; persist(); paintRange(); renderDrawer();
  if (view === 'quiz' && matchMedia('(max-width: 650px)').matches && !$('focus-dialog').open) requestAnimationFrame(() => {
    const input = $('drawer').querySelector('textarea'); input?.focus({ preventScroll: true }); input?.scrollIntoView({ block: 'center' });
  });
}
function paintRange() {
  const keys = new Set(rangeSelection.map(e => keyOf(e.target)));
  document.querySelectorAll('#shots [data-cell], #shot-quiz [data-cell]').forEach(e => e.classList.toggle('range-selected', keys.has(e.dataset.cell)));
  document.querySelectorAll('#shots td').forEach(td => td.classList.toggle('range-selected-td', [...td.querySelectorAll('[data-cell]')].some(e => keys.has(e.dataset.cell))));
}
function tablePoint(td) { return { row: td.parentElement.sectionRowIndex, col: td.cellIndex }; }
function selectRectangle(from, to) {
  const selected = [];
  for (let r = Math.min(from.row, to.row); r <= Math.max(from.row, to.row); r++) {
    const row = $('shots').rows[r]; if (!row) continue;
    for (let c = Math.min(from.col, to.col); c <= Math.max(from.col, to.col); c++) {
      for (const e of row.cells[c]?.querySelectorAll('[data-cell]') || []) {
        const target = JSON.parse(e.dataset.cell); selected.push(annotationItem(target));
      }
    }
  }
  rangeSelection = selected; paintRange();
}
function visibleCellAt(x, y) {
  return document.elementsFromPoint(x, y).map(e => e.closest('#shots td')).find(Boolean);
}
function moveSelection(event) {
  if (!dragging) return;
  dragging.x = event.clientX; dragging.y = event.clientY;
  const td = visibleCellAt(event.clientX, event.clientY);
  if (td) { dragging.end = tablePoint(td); if (td !== dragging.startTd) dragging.moved = true; selectRectangle(rangeAnchor, dragging.end); }
}
function autoScrollSelection() {
  if (!dragging) return;
  const wrap = document.querySelector('.table-wrap'), rect = wrap.getBoundingClientRect();
  const x = dragging.x, y = dragging.y, margin = 42;
  if (x >= rect.left && x <= rect.right && y >= rect.top - margin && y <= rect.bottom + margin) {
    const dx = x > rect.right - margin ? 20 : x < rect.left + margin ? -20 : 0;
    const dy = y > rect.bottom - margin ? 16 : y < rect.top + margin ? -16 : 0;
    if (dx || dy) { wrap.scrollBy(dx, dy); const td = visibleCellAt(Math.min(rect.right - 4, Math.max(rect.left + 4, x)), Math.min(rect.bottom - 4, Math.max(rect.top + 4, y))); if (td) { dragging.end = tablePoint(td); dragging.moved = true; selectRectangle(rangeAnchor, dragging.end); } }
  }
  autoScrollFrame = requestAnimationFrame(autoScrollSelection);
}
function setAnnotationMode(enabled) {
  if (editing) commit(); annotationMode = enabled;
  $('annotate').textContent = enabled ? '退出标注' : '标注修改'; $('annotate').setAttribute('aria-pressed', String(enabled));
  $('workspace').classList.toggle('annotating', enabled); $('annotate-cell').hidden = enabled || !selectedCell;
  const context = view === 'staticPrompts' ? '全部镜号与拍法，包含补充静帧；尚未采用的方案也可阅读和导出。' : view === 'sceneViews' ? '每个场景视角一条静态 Prompt；各视角独立生成，场景布局提案仍待确认。' : '';
  $('category-hint').textContent = view === 'quiz' ? enabled ? '点击要修改的方案或补充帧，再填写批注。' : '' : enabled ? '拖拽框选多行多列 · 单击批注一格 · Shift+单击／方向键扩选 · Esc 清除选择 · 松开后填写统一修改要求' : context + '单击选中 · 双击 / F2 编辑 · Ctrl+Enter 保存 · 展开阅读全文 · 右上角“标注修改”可框选批注';
  $('category-hint').hidden = view === 'quiz' && !enabled;
}
function staticRows() {
  return project.shots.flatMap(shot => shot.variants.flatMap(variant => [
    { shot, variant, target: { kind: 'variant', shotId: shot.id, variantId: variant.id, field: 'staticPrompt' } },
    ...(project.promptSections || []).filter(s => s.category === 'shotFrames' && s.variantId === variant.id && s.shotIds.includes(shot.id)).flatMap(section => section.prompts.map((_, index) => ({ shot, variant, section, index, target: { kind: 'section', sectionId: section.id, field: 'prompts.' + index + '.text' } })))
  ]));
}
function sceneRows() { return (project.promptSections || []).filter(s => s.category === 'sceneViews').flatMap(section => section.prompts.map((_, index) => ({ section, index, target: { kind: 'section', sectionId: section.id, field: 'prompts.' + index + '.text' } }))); }
function focusFields(t) {
  if (t.kind === 'variant') return ['title', 'rationale', 'description', 'staticPrompt', ...(project.staticPromptFormat === 'concise-v1' ? ['shotSchema'] : []), ...(project.promptMode === 'static' ? [] : ['motionPrompt']), ...Object.keys(topicFields).filter(f => f !== 'continuity' || project.staticPromptFormat === 'concise-v1').map(f => 'breakdown.' + f), ...Object.keys(project.staticPromptFormat === 'concise-v1' ? conciseCameraFields : cameraFields).map(f => 'breakdown.camera.' + f)];
  if (t.kind === 'shot') return ['displayNumber', 'suggestedDuration', 'workingScript', 'purpose', 'scene'];
  if (t.kind === 'asset') return Object.keys(t.assetType === 'characters' ? characterFields : locationFields);
  return ['title', 'rationale', ...info(t).owner.prompts.flatMap((p, i) => ['prompts.' + i + '.label', 'prompts.' + i + '.text'])];
}
function focusNavigate(direction) {
  if (!focusTarget) return;
  const promptRows = view === 'staticPrompts' ? staticRows() : view === 'sceneViews' ? sceneRows() : [];
  const promptIndex = promptRows.findIndex(row => keyOf(row.target) === keyOf(focusTarget));
  if (promptIndex !== -1) { if (promptRows[promptIndex + direction]) openFocus(promptRows[promptIndex + direction].target); return; }
  const next = { ...focusTarget };
  if (next.shotId) { const i = project.shots.findIndex(s => s.id === next.shotId), shot = project.shots[i + direction]; if (!shot) return; next.shotId = shot.id; if (next.variantId) { const v = shot.variants.find(v => v.id === next.variantId) || displayVariant(shot); if (!v) return; next.variantId = v.id; } }
  else if (next.kind === 'asset') { const assets = project.productionInventory[next.assetType], i = assets.findIndex(a => a.id === next.assetId); if (!assets[i + direction]) return; next.assetId = assets[i + direction].id; }
  else { const category = info(next).owner.category, sections = project.promptSections.filter(s => s.category === category), i = sections.findIndex(s => s.id === next.sectionId); if (!sections[i + direction]) return; next.sectionId = sections[i + direction].id; if (!focusFields(next).includes(next.field)) next.field = 'title'; }
  openFocus(next);
}
function openFocus(target) {
  if (editing) commit();
  if (!$('focus-dialog').open) { const wrap = document.querySelector('.table-wrap'); focusScroll = { left: wrap.scrollLeft, top: wrap.scrollTop, target: selectedCell, drawerMode, activeRangeKey, rangeSelection }; $('focus-dialog').showModal(); }
  focusTarget = target; selectedCell = target; drawerMode = 'comment'; rangeSelection = []; activeRangeKey = null;
  renderFocus(); renderDrawer();
  if (!isReadonlyCell(target)) startEdit($('focus-content').firstElementChild, target);
}
function renderFocus() {
  if (!focusTarget || !$('focus-dialog').open || editing?.element?.closest('#focus-dialog')) return;
  const data = info(focusTarget); $('focus-title').textContent = data.title + ' · ' + data.label;
  const derived = isReadonlyCell(focusTarget); $('focus-edit').hidden = derived;
  $('focus-dialog').querySelector('.eyebrow').textContent = derived ? '全文阅读' : '全文专注编辑';
  $('focus-dialog').querySelector('.focus-hint').textContent = derived ? '由分镜总表自动汇总；可复制、批注，或进入分镜维度修改。' : 'Ctrl+Enter 保存 · Esc 取消本次编辑 · 切换或返回自动保存，失败草稿会保留';
  $('focus-content').replaceChildren(cell(focusTarget));
  $('focus-field').replaceChildren(...focusFields(focusTarget).map(field => { const option = node('option', info({ ...focusTarget, field }).label); option.value = field; return option; })); $('focus-field').value = focusTarget.field;
  $('focus-variant').hidden = focusTarget.kind !== 'variant';
  if (focusTarget.kind === 'variant') { const shot = project.shots.find(s => s.id === focusTarget.shotId); $('focus-variant').replaceChildren(...shot.variants.map(v => { const o = node('option', v.id + ' · ' + v.title); o.value = v.id; return o; })); $('focus-variant').value = focusTarget.variantId; }
  const promptNavigation = view === 'staticPrompts' || view === 'sceneViews';
  $('focus-prev').textContent = promptNavigation ? '上一条' : focusTarget.shotId ? '上一镜' : '上一项'; $('focus-next').textContent = promptNavigation ? '下一条' : focusTarget.shotId ? '下一镜' : '下一项';
}
function closeFocus() {
  if (editing) commit(); $('focus-dialog').close(); focusTarget = null;
  if (focusScroll) { selectedCell = focusScroll.target; drawerMode = focusScroll.drawerMode; activeRangeKey = focusScroll.activeRangeKey; rangeSelection = focusScroll.rangeSelection; }
  renderDrawer();
  if (focusScroll) { const wrap = document.querySelector('.table-wrap'); wrap.scrollLeft = focusScroll.left; wrap.scrollTop = focusScroll.top; if (focusScroll.target) findCell(focusScroll.target)?.focus({ preventScroll: true }); }
}
function updateScroll() {
  const wrap = document.querySelector('.table-wrap'); $('scroll-width').style.width = wrap.scrollWidth + 'px'; $('top-scroll').scrollLeft = wrap.scrollLeft;
  document.querySelector('.scroll-tools').hidden = view === 'quiz' || wrap.scrollWidth <= wrap.clientWidth + 1;
}
function renderBatch() {
  const unconfirmed = project.shots.filter(s => { const v = s.variants.find(v => v.id === s.selectedVariantId); return !v || s.approval?.variantId !== v.id || s.approval?.variantVersion !== v.version; }).length;
  const sync = project.shots.flatMap(s => s.variants).filter(v => v.promptNeedsSync).length + (project.promptSections || []).filter(s => s.promptNeedsSync).length;
  const pending = project.comments.filter(c => c.status === 'pending').length + (project.generationRequests || []).filter(r => r.status === 'pending').length;
  $('prepare-batch').disabled = !project.shots.length || !!(unconfirmed || sync || pending);
  $('batch-readiness').textContent = unconfirmed || sync || pending ? [unconfirmed ? unconfirmed + ' 镜尚未确认当前版本' : '', sync ? sync + ' 项待同步' : '', pending ? pending + ' 条修改要求待处理' : ''].filter(Boolean).join(' · ') : '全片已通过，可准备当前顺序的前三镜。准备清单不会提交生成。';
  const batch = project.imageBatches?.at(-1); $('batch-status').replaceChildren();
  if (batch) { const p = node('p', (batch.status === 'stale' ? '待重新核对' : '清单已准备') + ' · ' + batch.id + ' · 未提交生成', 'muted'); const links = node('div', undefined, 'export-links'); for (const ext of ['json', 'md']) { const a = node('a', '下载 LibTV 清单 .' + ext); a.href = '/exports/libtv-batch.' + ext; a.download = ''; links.append(a); } $('batch-status').append(p, node('p', '模型、生成数量和目标画布在执行前确定；人物通过资产与实际三视图参考关联。', 'muted'), links); }
}
function setQuizShot(shotId) {
  quizShotId = shotId; selectedCell = null; rangeSelection = []; rangeAnchor = null; activeRangeKey = null; activeShotId = null;
  $('drawer').hidden = true; persist();
}
async function navigateQuiz(shotId) {
  if (quizBusy || saving || !project.shots.some(s => s.id === shotId)) return;
  quizBusy = true; saveState();
  try {
    if (editing) commit(); await pump();
    if (failed || queue.length || Object.keys(drafts).length) { notice('当前文字尚未保存，请先处理保存问题；仍保留在本镜。', true); return; }
    setQuizShot(shotId); render(); $('quiz-current-shot')?.scrollIntoView({ block: 'start' });
  } finally { quizBusy = false; saveState(); }
}
async function chooseQuiz(shotId, variantId) {
  if (quizBusy || saving) return;
  quizBusy = true; saveState();
  try {
    if (editing) commit(); await pump();
    if (failed || queue.length || Object.keys(drafts).length) { notice('请先处理保存问题，再选择方案；仍保留在本镜。', true); return; }
    const shot = project.shots.find(s => s.id === shotId);
    if (!shot?.variants.some(v => v.id === variantId)) return;
    const advance = () => {
      quizPendingChoice = null;
      if (quizShotId === shotId) { const index = project.shots.findIndex(s => s.id === shotId); setQuizShot(project.shots[index + 1]?.id || shotId); }
      persist();
    };
    if (shot.selectedVariantId === variantId) advance();
    else {
      quizPendingChoice = { shotId, variantId }; persist();
      await action({ type: 'select', shotId, variantId }, advance);
    }
  } finally { quizBusy = false; render(); if (!quizPendingChoice) $('quiz-current-shot')?.scrollIntoView({ block: 'start' }); }
}
function renderQuiz() {
  const root = $('shot-quiz'); root.replaceChildren();
  const shot = project.shots.find(s => s.id === quizShotId) || project.shots[0];
  if (!shot) { root.append(node('p', '还没有可选择的镜头。', 'quiz-empty')); return; }
  quizShotId = shot.id;
  const index = project.shots.indexOf(shot), answered = project.shots.filter(s => s.variants.some(v => v.id === s.selectedVariantId)).length;
  const navigation = node('nav', undefined, 'quiz-navigation'); navigation.id = 'quiz-shot-nav'; navigation.setAttribute('aria-label', '镜号导航');
  for (const item of project.shots) {
    const selected = item.variants.some(v => v.id === item.selectedVariantId);
    const link = button(String(item.displayNumber ?? item.sourceNumber) + (selected ? ' · ' + item.selectedVariantId : ''), () => navigateQuiz(item.id), 'quiz-step secondary');
    link.dataset.shotId = item.id; link.dataset.quizNav = ''; link.setAttribute('aria-label', '镜 ' + (item.displayNumber ?? item.sourceNumber) + (selected ? '，已选 ' + item.selectedVariantId : '，未选择'));
    if (item.id === shot.id) link.setAttribute('aria-current', 'step');
    link.classList.toggle('answered', selected); navigation.append(link);
  }
  const heading = node('div', undefined, 'quiz-heading'), title = node('h2', '镜 ' + (shot.displayNumber ?? shot.sourceNumber)); title.id = 'quiz-current-shot'; title.dataset.shotId = shot.id;
  const previous = button('上一镜', () => navigateQuiz(project.shots[index - 1]?.id), 'secondary'); previous.id = 'quiz-prev'; previous.dataset.quizNav = ''; previous.dataset.unavailable = String(index === 0);
  const next = button('下一镜', () => navigateQuiz(project.shots[index + 1]?.id), 'secondary'); next.id = 'quiz-next'; next.dataset.quizNav = ''; next.dataset.unavailable = String(index === project.shots.length - 1);
  const controls = node('div', undefined, 'quiz-page-controls'); controls.append(previous, next);
  heading.append(title, node('span', '已选择 ' + answered + ' / ' + project.shots.length + ' 镜', 'muted'), controls);
  root.append(navigation, heading, node('p', shot.workingScript ?? shot.original, 'quiz-script'));
  if (answered === project.shots.length) {
    const complete = node('p', '全部镜头选择完成。可以通过上方镜号回看或重新选择；最终确认仍单独保留。', 'quiz-complete'); complete.id = 'quiz-complete'; complete.setAttribute('role', 'status'); root.append(complete);
  }
  if (quizPendingChoice?.shotId === shot.id) {
    const pending = node('div', undefined, 'quiz-unsaved'), retry = button('读取最新并重试选择 ' + quizPendingChoice.variantId, async () => {
      if (quizBusy || saving) return;
      const choice = { ...quizPendingChoice }; await refresh(true);
      if (queue.length || Object.keys(drafts).length) { notice('请先保存或解决正文草稿，再重试选择。', true); return; }
      failed = false; await chooseQuiz(choice.shotId, choice.variantId);
    }, 'secondary'); retry.id = 'quiz-retry';
    pending.append(node('span', '选择 ' + quizPendingChoice.variantId + ' 尚未保存。'), retry); root.append(pending);
  }
  const options = node('div', undefined, 'quiz-options'); options.id = 'quiz-options'; options.setAttribute('role', 'list');
  for (const variant of shot.variants) {
    const card = node('article', undefined, 'quiz-option'); card.dataset.variantId = variant.id; card.dataset.selected = String(shot.selectedVariantId === variant.id); card.setAttribute('role', 'listitem');
    const target = { kind: 'variant', shotId: shot.id, variantId: variant.id, field: 'staticPrompt' };
    const header = node('header', undefined, 'quiz-option-heading'); header.append(node('h3', variant.id + ' · ' + variant.title));
    if (shot.selectedVariantId === variant.id) header.append(node('span', '当前选择', 'quiz-selected-label'));
    const annotate = button('批注 ' + variant.id, () => openAnnotation([target]), 'text-button'); annotate.dataset.commentVariant = variant.id; header.append(annotate);
    card.append(header, cell(target));
    for (const section of (project.promptSections || []).filter(s => s.category === 'shotFrames' && s.variantId === variant.id && s.shotIds.includes(shot.id))) {
      section.prompts.forEach((prompt, promptIndex) => {
        const frame = node('section', undefined, 'quiz-frame'), frameTarget = { kind: 'section', sectionId: section.id, field: 'prompts.' + promptIndex + '.text' };
        const frameHeader = node('header'); frameHeader.append(node('h4', prompt.label));
        const comment = button('批注此帧', () => openAnnotation([frameTarget]), 'text-button'); comment.dataset.commentSection = section.id; frameHeader.append(comment);
        frame.append(frameHeader, cell(frameTarget)); card.append(frame);
      });
    }
    const choose = button('选择 ' + variant.id + (index === project.shots.length - 1 ? ' 并完成' : ' 并继续'), () => chooseQuiz(shot.id, variant.id), 'quiz-choice'); choose.dataset.selectVariant = variant.id;
    card.append(choose); options.append(card);
  }
  if (!shot.variants.length) options.append(node('p', '本镜尚无方案，可通过上方镜号查看其他镜头。', 'quiz-empty'));
  root.append(options);
}
function tableView() {
  const headers = view === 'shots' ? ['镜号／秒数', '脚本画面', '镜头内容', '景别／拍摄方式', '构图与空间层次', '光影／色调', '姿态与表情', '角色描述', '场景描述', '材质与画面质感']
    : view === 'characters' ? Object.values(characterFields) : view === 'locations' ? Object.values(locationFields) : view === 'staticPrompts' ? ['镜号／拍法', '画面／静帧', '静态生图 Prompt', '审核与详情'] : view === 'sceneViews' ? ['场景', '视角', '场景静态生图 Prompt', '依据与状态'] : ['对象／名称', '设计依据', '独立 Prompt'];
  $('shot-head').replaceChildren(...headers.map(h => node('th', h)));
  const table = $('shots').closest('table'); table.className = 'grid-table ' + view;
  if (view === 'staticPrompts' || view === 'sceneViews') {
    table.classList.add('prompt-table');
    const rows = view === 'staticPrompts' ? staticRows() : sceneRows();
    $('shots').replaceChildren(...rows.map(({ shot, variant, section, index, target }) => {
      const row = node('tr'), object = node('td'), title = node('td'), prompt = node('td'), status = node('td');
      row.dataset.promptTarget = keyOf(target);
      if (shot) {
        object.append(node('strong', '镜 ' + (shot.displayNumber ?? shot.sourceNumber)), node('p', variant.id + ' 拍法' + (section ? ' · 补充帧' : ' · 主帧'), 'muted'));
        title.append(cell(section ? { kind: 'section', sectionId: section.id, field: 'prompts.' + index + '.label' } : { kind: 'variant', shotId: shot.id, variantId: variant.id, field: 'title' }));
        status.append(node('p', section?.promptNeedsSync || variant.promptNeedsSync ? '待同步' : project.workflowMode === 'agent-default' ? variantStatus(project, shot, variant) : shot.approval?.variantId === variant.id && shot.approval?.variantVersion === variant.version ? '已确认当前拍法' : shot.selectedVariantId === variant.id ? '已采用 · 待确认' : '备选 · 待审核', 'muted'));
        status.append(button('拍法详情', () => { activeShotId = shot.id; activeVariantId = variant.id; drawerMode = 'shot'; renderDrawer(); }, 'shot-link'));
      } else {
        object.append(cell({ kind: 'section', sectionId: section.id, field: 'title' }));
        title.append(cell({ kind: 'section', sectionId: section.id, field: 'prompts.' + index + '.label' }));
        status.append(node('p', section.promptNeedsSync ? '待同步' : '布局提案 · 待确认', 'muted'), button('查看设计依据', () => openFocus({ kind: 'section', sectionId: section.id, field: 'rationale' }), 'shot-link'));
      }
      prompt.append(cell(target)); status.append(node('p', 'v' + (section?.version ?? variant.version), 'muted'));
      row.append(object, title, prompt, status); return row;
    }));
    if (!rows.length) { const row = node('tr'), empty = node('td', '本视图尚无静态 Prompt，请交给 Agent 补齐。', 'empty-prompts'); empty.colSpan = 4; row.append(empty); $('shots').append(row); }
    return;
  }
  if (['characters', 'locations'].includes(view)) {
    $('shots').replaceChildren(...(project.productionInventory?.[view] || []).map(asset => {
      const row = node('tr');
      for (const field of Object.keys(view === 'characters' ? characterFields : locationFields)) { const td = node('td'); td.append(cell({ kind: 'asset', assetType: view, assetId: asset.id, field })); row.append(td); }
      return row;
    })); return;
  }
  if (view === 'characterViews') {
    $('shots').replaceChildren(...(project.promptSections || []).filter(s => s.category === view).map(section => {
      const row = node('tr'), title = node('td'), reason = node('td'), prompts = node('td');
      title.append(cell({ kind: 'section', sectionId: section.id, field: 'title' }), node('p', section.id + ' · v' + section.version + (section.promptNeedsSync ? ' · 待同步' : ''), 'muted'));
      reason.append(cell({ kind: 'section', sectionId: section.id, field: 'rationale' }));
      section.prompts.forEach((p, i) => { prompts.append(cell({ kind: 'section', sectionId: section.id, field: 'prompts.' + i + '.label' }, true), cell({ kind: 'section', sectionId: section.id, field: 'prompts.' + i + '.text' })); });
      row.append(title, reason, prompts); return row;
    })); return;
  }
  $('shots').replaceChildren(...project.shots.map(s => {
    const row = node('tr'), v = displayVariant(s), number = node('td'), script = node('td');
    number.append(cell({ kind: 'shot', shotId: s.id, field: 'displayNumber' }, true), cell({ kind: 'shot', shotId: s.id, field: 'suggestedDuration' }, true),
      node('span', '秒 · ' + (project.workflowMode === 'agent-default' ? variantStatus(project, s, v) + (v?.promptNeedsSync ? ' · 待同步' : '') : s.status === 'approved' ? '已确认' : '待审核'), 'muted'),
      button(v ? (project.workflowMode === 'agent-default' ? s.selectedVariantId === v.id ? '用户选择 ' : s.recommendation?.variantId === v.id ? 'Agent 默认 ' : '查看备选 ' : s.selectedVariantId ? '采用 ' : '推荐 ') + v.id + ' · 详情' : '填写方案', () => { activeShotId = s.id; activeVariantId = v?.id; drawerMode = 'shot'; renderDrawer(); }, 'shot-link'));
    script.append(cell({ kind: 'shot', shotId: s.id, field: 'workingScript' }), button('查看导入原稿', () => { activeShotId = s.id; activeVariantId = v?.id; drawerMode = 'shot'; renderDrawer(); }, 'text-button'));
    row.append(number, script);
    for (const field of ['content', 'camera', 'composition', 'lighting', 'pose', 'characters', 'scene', 'texture']) {
      const td = node('td');
      if (v) {
        if (field === 'camera') {
          const concise = project.staticPromptFormat === 'concise-v1', parts = node('details');
          parts.append(node('summary', (v.breakdown?.camera?.shotSize || '拍摄方式') + (concise ? ' · 镜头信息' : ' · 参数展开')));
          for (const [key, label] of Object.entries(concise ? conciseCameraFields : cameraFields)) {
            if (concise && key === 'equipment' && !v.breakdown?.camera?.equipment?.trim()) continue;
            parts.append(node('div', label, 'sub-label'), cell({ kind: 'variant', shotId: s.id, variantId: v.id, field: 'breakdown.camera.' + key }, true));
          }
          td.append(parts);
        }
        else td.append(cell({ kind: 'variant', shotId: s.id, variantId: v.id, field: 'breakdown.' + field }));
      } else td.append(node('p', '待 Agent 填写', 'muted'));
      row.append(td);
    }
    return row;
  }));
}
function render() {
  if (dragging) return;
  const focusedCell = document.activeElement?.closest('[data-cell]')?.dataset.cell;
  $('title').textContent = project.title; document.title = project.title + ' · 分镜工作台';
  const b = project.brief;
  $('subtitle').textContent = (b ? [b.purpose, b.deliverables, b.resolution, project.aspectRatio, project.targetDuration ? '约' + project.targetDuration + '秒' : '时长待定', b.style].filter(Boolean).join(' · ') : '目标待 Agent 在对话中询问 · 画幅 ' + (project.aspectRatio || '待定')) + ' · revision ' + project.revision;
  $('progress').textContent = project.shots.length + ' 镜 · ' + project.shots.filter(s => s.status === 'approved').length + ' 已确认 · ' + project.shots.flatMap(s => s.variants).filter(v => v.promptNeedsSync).length + ' 方案待同步';
  $('workbench-title').textContent = view === 'quiz' ? '逐镜选择静态 Prompt' : view === 'staticPrompts' ? '全部镜号静态 Prompt · ' + staticRows().length + ' 条' : view === 'sceneViews' ? '场景静态 Prompt · ' + sceneRows().length + ' 条' : '完整分镜框架';
  $('main-tags').replaceChildren(...Object.entries(views).map(([key, text]) => {
    const e = button(text, () => { if (quizBusy) return; if (editing) commit(); view = key; selectedCell = null; rangeSelection = []; rangeAnchor = null; activeRangeKey = null; activeShotId = null; $('drawer').hidden = true; persist(); render(); document.querySelector('.table-wrap').scrollTo(0, 0); }, 'main-tag'); e.setAttribute('aria-pressed', String(view === key)); return e;
  }));
  document.body.classList.toggle('quiz-view', view === 'quiz'); $('shot-quiz').hidden = view !== 'quiz'; document.querySelector('.table-wrap').hidden = view === 'quiz';
  document.querySelectorAll('main > .auxiliary').forEach(e => { e.hidden = view === 'quiz'; });
  document.querySelector('.prompt-summary').hidden = view === 'quiz';
  if (view === 'quiz') { $('shots').replaceChildren(); renderQuiz(); } else tableView();
  renderDrawer(); renderMetadata(); renderBatch(); renderFocus(); saveState(); paintRange(); setAnnotationMode(annotationMode); requestAnimationFrame(updateScroll);
  if (focusedCell) findCell(JSON.parse(focusedCell))?.focus({ preventScroll: true });
}
function appendCommentHistory(drawer, targets, textarea) {
  const keys = new Set(targets.map(keyOf)), comments = project.comments.filter(c => c.target && keys.has(keyOf(c.target))).slice().reverse(), groups = new Map();
  const names = { pending: '待处理', addressed: '已回应 · 待复核', resolved: '用户已解决' };
  for (const c of comments) { const k = c.groupId || c.id; if (!groups.has(k)) groups.set(k, c.groupId ? project.comments.filter(e => e.groupId === c.groupId) : [c]); }
  for (const [groupId, items] of groups) {
    const card = node('article', undefined, 'comment-card');
    if (items.length > 1) { const pending = items.filter(c => c.status === 'pending').length, addressed = items.filter(c => c.status === 'addressed').length; card.append(node('strong', pending ? `范围批注 · ${pending}/${items.length} 格待处理` : addressed ? '范围批注 · 已回应，待复核' : '范围批注 · 用户已解决'), node('p', items[0].text)); }
    for (const c of items) {
      const detail = node(items.length > 1 ? 'details' : 'div');
      if (items.length > 1) { let label; try { const d = info(c.target); label = d.title + ' · ' + d.label; } catch { label = keyOf(c.target); } detail.append(node('summary', names[c.status] + ' · ' + label)); }
      else detail.append(node('strong', names[c.status]), node('p', c.text));
      detail.append(node('p', '提交于内容 v' + c.contentVersion + ' / revision ' + c.baseRevision, 'muted'), node('p', '提交时原文：' + displayValue(c.target, c.originalText), 'quoted'));
      if (c.reply) detail.append(node('p', 'Agent：' + c.reply), node('p', '修改前：' + displayValue(c.target, c.before), 'diff-before'), node('p', '修改后：' + displayValue(c.target, c.after), 'diff-after'));
      if (c.status !== 'resolved') detail.append(button('标记已解决', () => action({ type: 'resolve-cell-comment', commentId: c.id }), 'text-button'));
      card.append(detail);
    }
    if (items.length > 1 && items.some(c => c.status !== 'resolved')) card.append(button('整组标记已解决', () => action({ type: 'resolve-comment-group', groupId }), 'secondary'));
    card.append(button('继续批注', () => { textarea.value = '继续上一条：'; textarea.dispatchEvent(new Event('input')); textarea.focus(); }, 'text-button'));
    drawer.append(card);
  }
}
function appendRangeDrawer(drawer) {
  const draft = rangeDrafts[activeRangeKey]; if (!draft) return;
  const targets = draft.targets.map(e => e.target);
  drawer.append(node('p', '按稳定镜头、方案和字段记录', 'eyebrow'), node('h2', targets.length === 1 ? info(targets[0]).label : '范围批注 · ' + targets.length + ' 个字段'));
  const range = node('details'); range.open = view !== 'quiz' && targets.length < 4; range.append(node('summary', '查看选中范围与提交基线'));
  for (const item of draft.targets) {
    const data = info(item.target), comparison = node('details');
    comparison.append(node('summary', data.title + ' · ' + data.label + ' · 基线 v' + item.expectedVersion + (data.version !== item.expectedVersion ? ' → 当前 v' + data.version : '')));
    if (typeof item.originalText === 'string') comparison.append(node('p', '选中时原文：' + (displayValue(item.target, item.originalText) || '（空）'), item.originalText === data.value ? 'quoted' : 'diff-before'));
    else comparison.append(node('p', '旧草稿未保存选中时原文，无法恢复原文基线；请核对当前内容。', 'sync-warning'));
    comparison.append(node('p', '当前内容：' + (displayValue(item.target, data.value) || '（空）'), typeof item.originalText === 'string' && item.originalText !== data.value ? 'diff-after' : 'quoted'));
    range.append(comparison);
  }
  drawer.append(range);
  if (targets.length === 1) { const data = info(targets[0]); drawer.append(node('p', displayValue(targets[0], data.value) || '当前为空', 'quoted')); }
  const textarea = node('textarea'); textarea.placeholder = '填写这些字段共同的修改要求，例如：前三镜改为更紧凑的构图，保留人物动作。'; textarea.value = draft.text; textarea.setAttribute('aria-label', targets.length === 1 ? '单元格批注' : '范围批注');
  textarea.addEventListener('input', () => { draft.text = textarea.value; persist(); saveState(); });
  const submit = button(targets.length === 1 ? '提交批注' : '提交范围批注', async () => {
    if (!draft.text.trim()) { notice('请填写批注。', true); return; }
    const key = activeRangeKey; submit.disabled = true;
    await action({ type: 'range-comment', targets: draft.targets.map(({ target, expectedVersion }) => ({ target, expectedVersion })), text: draft.text }, () => { delete rangeDrafts[key]; for (const t of targets) delete commentDrafts[keyOf(t)]; activeRangeKey = null; rangeSelection = []; });
    submit.disabled = false;
  });
  drawer.append(node('label', '统一修改要求'), textarea, submit, node('p', '提交后立即保存。回到当前 Agent 说“处理批注”，再查看逐格修改差异。', 'muted'));
  if (draft.targets.some(item => info(item.target).version !== item.expectedVersion)) drawer.append(node('p', '选中内容已有新版本。草稿已保留，请展开上方范围，逐格核对原文与当前内容后更新基线。', 'sync-warning'), button('已核对，更新批注基线', () => { draft.targets = draft.targets.map(e => annotationItem(e.target)); rangeSelection = draft.targets; failed = false; persist(); renderDrawer(); saveState(); }, 'secondary'));
  appendCommentHistory(drawer, targets, textarea);
}
function renderDrawer() {
  const drawer = focusTarget && $('focus-dialog').open ? $('focus-comments') : $('drawer'); drawer.replaceChildren(); drawer.hidden = true;
  if (drawerMode === 'comment' && selectedCell) {
    const t = selectedCell, key = keyOf(t), data = info(t); drawer.hidden = false;
    drawer.append(button('收起侧栏', () => { if (focusTarget) $('focus-dialog').classList.remove('show-comments'); else { selectedCell = null; rangeSelection = []; activeRangeKey = null; } renderDrawer(); }, 'text-button'));
    if (activeRangeKey && rangeDrafts[activeRangeKey]) { appendRangeDrawer(drawer); $('workspace').classList.toggle('has-drawer', !focusTarget); requestAnimationFrame(updateScroll); return; }
    drawer.append(node('p', data.title, 'eyebrow'), node('h2', data.label), node('p', displayValue(t, data.value) || '当前为空', 'quoted'));
    const draft = drafts[key];
    if (draft) {
      drawer.append(node('h3', '未保存草稿'), node('p', displayValue(t, draft.value), 'quoted'), node('p', '编辑基线：' + displayValue(t, draft.baseValue), 'muted'),
        button('核对当前值并保存此草稿', () => { draft.baseValue = info(t).value; failed = false; queueCell(t); }, 'secondary'));
    }
    const textarea = node('textarea'); textarea.placeholder = '说明这一个单元格希望怎么改…'; textarea.value = commentDrafts[key] || ''; textarea.setAttribute('aria-label', '单元格批注');
    textarea.addEventListener('input', () => { commentDrafts[key] = textarea.value; persist(); });
    const submit = button('提交批注', async () => {
      if (!textarea.value.trim()) { notice('请填写批注。', true); return; }
      const content = textarea.value; submit.disabled = true;
      await action({ type: 'cell-comment', target: t, expectedValue: data.value, text: content }, () => { delete commentDrafts[key]; });
      submit.disabled = false;
    });
    drawer.append(node('label', '修改要求'), textarea, submit, node('p', '保存后回到当前 Agent 说“处理批注”。', 'muted'));
    appendCommentHistory(drawer, [t], textarea);
  } else if (drawerMode === 'shot' && activeShotId) {
    const shot = project.shots.find(s => s.id === activeShotId), v = displayVariant(shot); drawer.hidden = false;
    drawer.append(button('收起侧栏', () => { activeShotId = null; renderDrawer(); }, 'text-button'), node('h2', '镜 ' + (shot.displayNumber ?? shot.sourceNumber) + ' · 拍法与 Prompt'));
    if (shot.variants.length) {
      const choose = node('select'); choose.setAttribute('aria-label', '候选拍法');
      for (const candidate of shot.variants) { const option = node('option', candidate.id + ' · ' + candidate.title); option.value = candidate.id; choose.append(option); }
      choose.value = v.id; choose.addEventListener('change', () => { if (editing) commit(); activeVariantId = choose.value; render(); });
      drawer.append(choose, node('p', shot.recommendation?.reason || '', 'reason'));
      for (const field of ['title', 'rationale', 'description']) drawer.append(node('label', labels[field]), cell({ kind: 'variant', shotId: shot.id, variantId: v.id, field }));
      if (v.promptNeedsSync) drawer.append(node('p', '文字已变更，Prompt待 Agent 同步。', 'sync-warning'));
      for (const field of project.promptMode === 'static' ? ['staticPrompt'] : ['staticPrompt', 'motionPrompt']) drawer.append(node('label', labels[field]), cell({ kind: 'variant', shotId: shot.id, variantId: v.id, field }));
      if (project.staticPromptFormat === 'concise-v1') drawer.append(node('label', '连续性与限制'), cell({ kind: 'variant', shotId: shot.id, variantId: v.id, field: 'breakdown.continuity' }));
      drawer.append(node('label', '取舍与条件'), cell({ kind: 'variant', shotId: shot.id, variantId: v.id, field: 'breakdown.decision' }),
        button(project.promptMode === 'static' ? '我已核对静帧 Prompt，标记同步' : '我已核对两段 Prompt，标记同步', () => action({ type: 'edit-prompt', shotId: shot.id, variantId: v.id, staticPrompt: v.staticPrompt, ...(project.promptMode === 'static' ? {} : { motionPrompt: v.motionPrompt }) }), 'secondary'),
        button(shot.selectedVariantId === v.id ? '确认当前版本' : '采用 ' + v.id + ' 拍法', () => action(shot.selectedVariantId === v.id ? { type: 'approve', shotId: shot.id } : { type: 'select', shotId: shot.id, variantId: v.id })));
    }
    const source = node('details'); source.append(node('summary', '导入原稿与旧批注'), node('p', shot.original, 'quoted'));
    for (const f of shot.originalFields || []) source.append(node('p', f.name + '：' + f.value));
    for (const c of project.comments.filter(c => !c.target && c.shotId === shot.id)) source.append(node('p', c.status + ' · ' + c.text, 'comment-card'));
    drawer.append(source);
  }
  if (drawer === $('drawer')) $('workspace').classList.toggle('has-drawer', !drawer.hidden);
  requestAnimationFrame(updateScroll);
}
function renderMetadata() {
  $('overview').textContent = project.overview || '';
  $('boundary').textContent = '建议合计 ' + project.shots.reduce((n, s) => n + (s.suggestedDuration || 0), 0).toFixed(1) + ' 秒；备选不叠加时长。';
  $('draft-export-link').hidden = project.workflowMode !== 'agent-default';
  $('story-plan-panel').hidden = !project.storyPlan;
  $('story-plan').replaceChildren();
  if (project.storyPlan) {
    const name = id => [...project.productionInventory.characters, ...project.productionInventory.locations, ...project.storyPlan.props].find(a => a.id === id)?.name || id;
    $('story-plan').append(node('p', project.storyPlan.notes, 'muted'));
    for (const event of project.storyPlan.events) {
      const card = node('article', undefined, 'comment-card'), shots = project.shots.filter(s => s.eventIds.includes(event.id)).map(s => s.displayNumber ?? s.id);
      card.append(node('strong', event.description), node('p', '叙事信息：' + event.information), node('p', '关联镜头：' + shots.join('、') + ' · ' + ({ source: '原稿事实', user: '用户补充', proposal: '导演提案', unknown: '待定' })[event.basis], 'muted'));
      if (event.sourceRef) card.append(node('p', `原文第${event.sourceRef.startLine}–${event.sourceRef.endLine}行：${event.sourceRef.quote}`, 'quoted'));
      for (const change of event.stateChanges) card.append(node('p', `${name(change.entityId)} · ${change.field}：${change.before} → ${change.after}`, 'muted'));
      $('story-plan').append(card);
    }
  }
  $('issue-count').textContent = project.reviewIssues.filter(i => !i.resolved).length + ' 项';
  $('issues').replaceChildren(...project.reviewIssues.map(i => node('p', (i.resolved ? '已核对：' : '待核对：') + i.text + (i.resolution ? '；' + i.resolution : ''), 'muted')));
  $('references').replaceChildren(...project.references.map(r => {
    const card = button('', () => { $('large-image').src = '/files/' + r.path; $('large-image').alt = r.label; $('image-title').textContent = r.label; $('image-observations').textContent = r.observations; $('image-usage').textContent = r.usage; $('image-dialog').showModal(); }, 'reference-card');
    const img = node('img'); img.src = '/files/' + r.path; img.alt = r.label; card.append(img, node('strong', r.id + ' · ' + r.label)); return card;
  }));
}
$('refresh').addEventListener('click', () => refresh(true));
$('retry').addEventListener('click', async () => {
  await refresh(true);
  preserveReadonlyDrafts();
  const conflicting = Object.values(drafts).find(d => info(d.target).value !== d.baseValue && info(d.target).value !== d.value);
  if (conflicting) { selectedCell = conflicting.target; activeRangeKey = null; rangeSelection = []; drawerMode = 'comment'; renderDrawer(); notice('这格有新值，请在侧栏核对后保存草稿。', true); return; }
  failed = false;
  for (const d of Object.values(drafts)) { if (info(d.target).value === d.value) delete drafts[keyOf(d.target)]; else queueCell(d.target); }
  persist(); saveState(); pump();
});
$('discard-drafts').addEventListener('click', () => {
  if (saving) return;
  if (!window.confirm('放弃当前可编辑草稿和未提交批注？已保存内容与保留的旧 Prompt 草稿不受影响。')) return;
  editing = null; drafts = {}; commentDrafts = {}; rangeDrafts = {}; rangeSelection = []; activeRangeKey = null; queue = []; failed = false; persist(); render();
});
$('close-image').addEventListener('click', () => $('image-dialog').close());
$('legacy-prompt-drafts').addEventListener('click', showReadonlyDrafts);
$('close-legacy-prompts').addEventListener('click', () => $('legacy-prompt-dialog').close());
$('annotate').addEventListener('click', () => { setAnnotationMode(!annotationMode); if (annotationMode) { $('drawer').hidden = true; $('workspace').classList.remove('has-drawer'); } else { rangeSelection = []; paintRange(); } updateScroll(); });
$('annotate-cell').addEventListener('click', () => { if (selectedCell) openAnnotation([selectedCell]); });
$('restore-annotation').addEventListener('click', () => {
  const entries = Object.entries(rangeDrafts).filter(([, d]) => d.text); if (!entries.length) return;
  const [key, draft] = entries.find(([key]) => key === activeRangeKey) || entries[0]; activeRangeKey = key; rangeSelection = draft.targets; selectedCell = draft.targets[0].target; drawerMode = 'comment'; renderDrawer();
  if (entries.length > 1) { const chooser = node('select'); chooser.setAttribute('aria-label', '批注草稿'); for (const [id, d] of entries) { const option = node('option', d.targets.length + ' 字段 · ' + d.text.slice(0, 30)); option.value = id; chooser.append(option); } chooser.value = key; chooser.addEventListener('change', () => { activeRangeKey = chooser.value; const d = rangeDrafts[activeRangeKey]; rangeSelection = d.targets; selectedCell = d.targets[0].target; renderDrawer(); persist(); }); $('drawer').prepend(chooser); }
});
$('shot-quiz').addEventListener('click', event => {
  if (!annotationMode || quizBusy || event.target.closest('button,textarea,input,select')) return;
  const selected = event.target.closest('[data-cell]'); if (selected) openAnnotation([JSON.parse(selected.dataset.cell)]);
});
$('shots').addEventListener('pointerdown', event => {
  if (!annotationMode || event.button !== 0 || event.target.closest('button,textarea,summary')) return;
  const td = event.target.closest('td'); if (!td) return;
  event.preventDefault(); const point = tablePoint(td), e = event.target.closest('[data-cell]');
  if (!event.shiftKey || !rangeAnchor) rangeAnchor = point;
  rangeCursor = point; dragging = { startTd: td, startTarget: e ? JSON.parse(e.dataset.cell) : null, end: point, x: event.clientX, y: event.clientY, moved: event.shiftKey };
  if (e) e.focus({ preventScroll: true }); selectRectangle(rangeAnchor, point); autoScrollSelection();
});
window.addEventListener('pointermove', moveSelection);
window.addEventListener('pointerup', () => {
  if (!dragging) return;
  const current = dragging; dragging = null; cancelAnimationFrame(autoScrollFrame); rangeCursor = current.end;
  if (!current.moved && current.startTarget) rangeSelection = [annotationItem(current.startTarget)];
  if (rangeSelection.length) openAnnotation(rangeSelection.map(e => e.target), rangeSelection);
});
window.addEventListener('pointercancel', () => { dragging = null; cancelAnimationFrame(autoScrollFrame); rangeSelection = []; paintRange(); });
document.addEventListener('keydown', event => {
  if (!annotationMode || event.target.closest('textarea,input,select') || $('focus-dialog').open) return;
  if (event.key === 'Escape') { event.preventDefault(); dragging = null; cancelAnimationFrame(autoScrollFrame); rangeSelection = []; activeRangeKey = null; selectedCell = null; rangeAnchor = null; $('drawer').hidden = true; $('workspace').classList.remove('has-drawer'); paintRange(); return; }
  const delta = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[event.key];
  if (delta && event.shiftKey && rangeAnchor) { event.preventDefault(); const p = rangeCursor || rangeAnchor; rangeCursor = { row: Math.max(0, Math.min($('shots').rows.length - 1, p.row + delta[0])), col: Math.max(0, Math.min($('shot-head').children.length - 1, p.col + delta[1])) }; selectRectangle(rangeAnchor, rangeCursor); openAnnotation(rangeSelection.map(e => e.target), rangeSelection); }
});
$('focus-field').addEventListener('change', () => openFocus({ ...focusTarget, field: $('focus-field').value }));
$('export-excel').addEventListener('click', downloadExcel);
$('focus-variant').addEventListener('change', () => openFocus({ ...focusTarget, variantId: $('focus-variant').value }));
$('focus-prev').addEventListener('click', () => focusNavigate(-1)); $('focus-next').addEventListener('click', () => focusNavigate(1));
$('focus-edit').addEventListener('click', () => { if (!editing) startEdit($('focus-content').firstElementChild, focusTarget); });
$('focus-comment').addEventListener('click', () => { if (editing) commit(); $('focus-dialog').classList.toggle('show-comments'); renderDrawer(); document.querySelector('#focus-comments textarea')?.focus(); });
$('close-focus').addEventListener('click', closeFocus);
$('focus-dialog').addEventListener('cancel', event => { event.preventDefault(); if (editing) cancelEdit(); else closeFocus(); });
const tableWrap = document.querySelector('.table-wrap');
tableWrap.addEventListener('scroll', () => { $('top-scroll').scrollLeft = tableWrap.scrollLeft; });
$('top-scroll').addEventListener('scroll', () => { tableWrap.scrollLeft = $('top-scroll').scrollLeft; });
$('scroll-left').addEventListener('click', () => tableWrap.scrollBy({ left: -360, behavior: 'auto' })); $('scroll-right').addEventListener('click', () => tableWrap.scrollBy({ left: 360, behavior: 'auto' }));
new ResizeObserver(updateScroll).observe(tableWrap);
$('prepare-batch').addEventListener('click', () => action({ type: 'prepare-image-batch', shotIds: project.shots.slice(0, 3).map(s => s.id) }));
window.addEventListener('beforeunload', e => { if (saving || Object.keys(drafts).length || Object.values(commentDrafts).some(Boolean) || Object.values(rangeDrafts).some(d => d.text)) { e.preventDefault(); e.returnValue = ''; } });
refresh(); setInterval(() => refresh(), 2000);
