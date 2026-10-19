import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { draftVariant, variantStatus } from '../assets/web/workflow.mjs';

export class ProjectError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = message => { throw new ProjectError(message); };
const text = (value, max = 30000) => {
  if (typeof value !== 'string' || value.length > max) fail('文本格式错误或内容过长');
  return value;
};
const tags = value => {
  if (!Array.isArray(value) || value.length > 40) fail('标签应为最多40项的数组');
  return [...new Set(value.map(v => text(v, 100)).filter(Boolean))];
};
const duration = value => {
  if (value !== null && (!Number.isFinite(value) || value <= 0 || value > 3600)) fail('秒数须大于0且不超过3600');
  return value;
};
const stableId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(value)) fail('稳定ID无效');
  return value;
};
function checkKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}应为对象`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}字段不可修改：${key}`);
}
function checkedIds(values, allowed, label) {
  if (!Array.isArray(values) || values.length > 1000 || new Set(values).size !== values.length || values.some(id => !allowed.includes(id))) fail(`${label}引用不存在或重复`);
}
function validateStoryPlan(project) {
  const plan = project.storyPlan;
  if (project.workflowMode !== 'agent-default') {
    if (plan !== undefined) fail('故事计划需要agent-default工作流程');
    return;
  }
  if (typeof project.projectId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(project.projectId)) fail('故事项目需要稳定projectId');
  if (promptMode(project) !== 'static' || project.staticPromptFormat !== 'concise-v1') fail('故事项目使用精简静态Prompt');
  checkKeys(plan, ['version', 'events', 'props', 'notes'], '故事计划');
  if (!Number.isInteger(plan.version) || plan.version < 1) fail('故事计划版本无效');
  if (!Array.isArray(plan.events) || !plan.events.length || plan.events.length > 1000 || !Array.isArray(plan.props) || plan.props.length > 100) fail('故事计划需要事件与道具清单');
  text(plan.notes, 5000);
  for (const prop of plan.props) {
    checkKeys(prop, ['id', 'name', 'basis'], '故事道具'); stableId(prop.id);
    if (!text(prop.name, 100).trim()) fail('故事道具名称不能为空');
    text(prop.basis, 5000);
  }
  const entities = [...allAssets(project).map(a => a.id), ...plan.props.map(p => p.id)];
  if (new Set(entities).size !== entities.length) fail('故事实体ID重复');
  for (const kind of ['characters', 'locations']) {
    const names = project.productionInventory[kind].map(a => a.name.trim());
    if (names.some(name => !name) || new Set(names).size !== names.length) fail('故事角色与场景须使用唯一非空名称');
  }
  const eventIds = plan.events.map(e => e?.id), shotIds = project.shots.map(s => s.id);
  if (new Set(eventIds).size !== eventIds.length) fail('故事事件ID重复');
  for (const event of plan.events) {
    checkKeys(event, ['id', 'version', 'description', 'information', 'basis', 'sourceRef', 'stateChanges'], '故事事件'); stableId(event.id);
    if (!Number.isInteger(event.version) || event.version < 1) fail('事件版本无效');
    if (!['source', 'user', 'proposal', 'unknown'].includes(event.basis)) fail('事件依据无效');
    for (const key of ['description', 'information']) if (!text(event[key], 5000).trim()) fail('事件描述与叙事信息不能为空');
    if (event.sourceRef !== null) {
      checkKeys(event.sourceRef, ['startLine', 'endLine', 'quote'], '故事来源定位');
      const { startLine, endLine, quote } = event.sourceRef;
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || !text(quote).trim()) fail('故事来源定位无效');
    } else if (event.basis === 'source') fail('原稿事件必须有来源定位');
    if (!Array.isArray(event.stateChanges) || event.stateChanges.length > 100) fail('事件状态变化应为数组');
    const keys = [];
    for (const change of event.stateChanges) {
      checkKeys(change, ['entityId', 'field', 'before', 'after'], '事件状态变化');
      if (!entities.includes(change.entityId)) fail('事件状态引用未登记实体');
      if (!text(change.field, 100).trim()) fail('状态字段不能为空');
      text(change.before, 5000); text(change.after, 5000); keys.push(change.entityId + ':' + change.field);
    }
    if (new Set(keys).size !== keys.length) fail('事件状态字段重复');
  }
  const covered = new Set();
  for (const shot of project.shots) {
    stableId(shot.id);
    checkedIds(shot.eventIds, eventIds, '镜头事件');
    if (!shot.eventIds.length) fail('每镜必须关联故事事件');
    shot.eventIds.forEach(id => covered.add(id));
    checkedIds(shot.dependsOnShotIds, shotIds, '镜头依赖');
    if (!shot.recommendation || !draftVariant(project, shot)) fail('故事镜头需要有效默认方案');
    if (shot.variants.some(v => !v.breakdown || !v.shotSchema)) fail('故事拍法需要完整框架与人物道具结构');
    for (const variant of shot.variants) {
      const b = variant.breakdown;
      if (['content', 'scene', 'composition', 'lighting'].some(key => !b[key]?.trim()) || ['shotSize', 'position', 'focalLength', 'focus'].some(key => !b.camera[key]?.trim())) fail('故事拍法需要完整画面、构图、光影与摄影四项');
      if (variant.shotSchema.props.some(p => !plan.props.some(item => item.id === p.id))) fail('镜头道具须登记于故事计划');
    }
  }
  if (eventIds.some(id => !covered.has(id))) fail('存在没有镜头覆盖的故事事件');
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail('镜头依赖存在环');
    if (visited.has(id)) return;
    visiting.add(id); findShot(project, id).dependsOnShotIds.forEach(visit); visiting.delete(id); visited.add(id);
  }
  shotIds.forEach(visit);
}
export const categoryNames = { frame: '分镜画面', camera: '镜头位置与运动', character: '角色细节', characterViews: '角色三视图', sceneViews: '场景三视图', shotFrames: '镜头补充静帧', style: '整体风格', production: '完整分镜框架' };
const category = value => { if (!Object.hasOwn(categoryNames, value)) fail('主Tag不存在'); return value; };
export const cameraFields = { equipment: '设备与画幅基准', shotSize: '景别', position: '机位与角度', movement: '镜头运动', focalLength: '焦距', aperture: '光圈 F', frameRate: '帧率', shutter: '快门速度', iso: 'ISO', focus: '对焦与景深', exposure: '进光与曝光处理', reason: '参数选择理由', conditions: '适用条件与待测项' };
export const conciseCameraFields = { shotSize: '景别', position: '机位', focalLength: '焦距', focus: '景深', equipment: '设备' };
export const constraintFields = { equipment: '可用设备与镜头', frameRate: '帧率与快门约束', lighting: '可用光源与拍摄环境', style: '画面风格目标', continuity: '人物与场景连续性', priority: '取舍优先级' };
export const staticFields = { composition: '构图与空间层次', pose: '姿态与表情', texture: '材质与画面质感' };
export const characterFields = { name: '角色名称', identity: '身份与外观方向', age: '年龄段', face: '脸型与五官', skin: '肤色与皮肤状态', hair: '发型发色', build: '体型与体态', clothing: '服装与配饰', traits: '辨识特征与气质', description: '完整角色设定', basis: '依据与待确认项' };
export const locationFields = { name: '场景名称', layout: '空间布局', props: '陈设与道具', materials: '材质', environment: '环境特征', description: '完整场景描述', basis: '依据与待确认项' };
const subjectTextFields = ['appearance', 'clothing', 'position', 'orientation', 'pose', 'hands', 'gaze', 'expression', 'visibleParts'];
const schemaReferences = schema => [...new Set([...(schema.referenceIds ?? []), ...schema.subjects.flatMap(s => s.referenceIds), ...schema.props.flatMap(p => p.referenceIds)])];
export function checkShotSchema(schema, project) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) fail('Shot Schema应为对象');
  for (const key of Object.keys(schema)) if (!['referenceIds', 'subjects', 'props', 'relations'].includes(key)) fail(`不可修改Shot Schema字段：${key}`);
  for (const key of ['subjects', 'props', 'relations']) if (!Array.isArray(schema[key]) || schema[key].length > 40) fail('人物、道具、关系应为最多40项的数组');
  const ids = (values, allowed, message) => {
    tags(values);
    if (new Set(values).size !== values.length || values.some(id => !allowed.includes(id))) fail(message);
  };
  const references = project.references.map(r => r.id), assets = (project.productionInventory?.characters ?? []).map(a => a.id);
  ids(schema.referenceIds, references, '通用参考引用不存在或重复');
  const checkKeys = (row, allowed) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('Shot Schema条目应为对象');
    for (const key of Object.keys(row)) if (!allowed.includes(key)) fail(`不可修改Shot Schema字段：${key}`);
  };
  for (const subject of schema.subjects) {
    checkKeys(subject, ['assetId', 'referenceIds', ...subjectTextFields]);
    if (!assets.includes(subject.assetId)) fail('入镜人物必须引用已登记的角色资产');
    ids(subject.referenceIds, references, '人物参考引用不存在或重复');
    for (const key of subjectTextFields) if (subject[key] !== undefined) text(subject[key], 5000);
  }
  const visible = schema.subjects.map(s => s.assetId);
  if (new Set(visible).size !== visible.length) fail('入镜人物资产重复');
  for (const prop of schema.props) {
    checkKeys(prop, ['id', 'name', 'state', 'position', 'holderAssetIds', 'referenceIds']);
    if (typeof prop.id !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(prop.id)) fail('道具ID无效');
    if (!text(prop.name, 100).trim()) fail('道具名称不能为空');
    for (const key of ['state', 'position']) if (prop[key] !== undefined) text(prop[key], 5000);
    ids(prop.holderAssetIds, visible, '道具持有者必须是当前入镜人物');
    ids(prop.referenceIds, references, '道具参考引用不存在或重复');
  }
  const props = schema.props.map(p => p.id);
  if (new Set(props).size !== props.length) fail('道具ID重复');
  for (const relation of schema.relations) {
    checkKeys(relation, ['id', 'type', 'subjectIds', 'propIds', 'description']);
    if (typeof relation.id !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(relation.id)) fail('关系ID无效');
    if (!['gaze', 'contact', 'occlusion', 'sameFrame'].includes(relation.type)) fail('关系类型无效');
    ids(relation.subjectIds, assets, '关系引用未登记人物或人物重复');
    ids(relation.propIds, props, '关系引用不存在的道具或道具重复');
    if (!relation.subjectIds.length && !relation.propIds.length) fail('关系需要关联人物或道具');
    if (relation.type === 'gaze' && (relation.subjectIds.length > 2 || !visible.includes(relation.subjectIds[0]))) fail('视线关系按入镜发出者、目标人物排列，最多两人');
    if (relation.type === 'sameFrame' && (relation.subjectIds.length < 2 || relation.subjectIds.some(id => !visible.includes(id)))) fail('必须同框的所有人物须在入镜表中');
    if (relation.type === 'contact' && relation.subjectIds.some(id => !visible.includes(id))) fail('接触关系中的人物须在入镜表中');
    if (!text(relation.description, 5000).trim()) fail('关系描述不能为空');
  }
  if (new Set(schema.relations.map(r => r.id)).size !== schema.relations.length) fail('关系ID重复');
}
export function formatShotSchema(project, schema, part = 'all') {
  const name = id => project.productionInventory?.characters?.find(a => a.id === id)?.name || id;
  const join = values => values.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()).join('，');
  const propDetails = prop => join([prop.state, prop.position, ...(prop.referenceIds.length ? ['参考' + prop.referenceIds.join('、')] : [])]);
  const lines = schema.subjects.map(s => {
    const identity = [s.appearance, s.clothing, s.visibleParts, s.position, s.orientation];
    const performance = [s.pose, s.hands, s.gaze, s.expression];
    const held = schema.props.filter(p => p.holderAssetIds.includes(s.assetId)).map(p => `${p.name}[${p.id}]${propDetails(p) ? '（' + propDetails(p) + '）' : ''}`);
    const details = join(part === 'pose' ? performance : [...identity, ...(part === 'all' ? performance : []), ...(held.length ? ['持有' + held.join('、')] : []), ...(s.referenceIds.length ? ['参考' + s.referenceIds.join('、')] : [])]);
    return details ? `${name(s.assetId)}[${s.assetId}]：${details}` : part === 'pose' ? '' : `${name(s.assetId)}[${s.assetId}]`;
  }).filter(Boolean);
  if (part !== 'pose') {
    for (const prop of schema.props) {
      if (prop.holderAssetIds.length) continue;
      const details = propDetails(prop);
      lines.push(`${prop.name}[${prop.id}]${details ? '：' + details : ''}`);
    }
    lines.push(...schema.relations.map(r => r.description.trim()));
  }
  return lines.join('\n');
}
function projectShotSchema(project, variant) {
  if (!variant.shotSchema) return;
  checkShotSchema(variant.shotSchema, project);
  variant.characterAssetIds = variant.shotSchema.subjects.map(s => s.assetId);
  variant.referenceIds = schemaReferences(variant.shotSchema);
  if (variant.breakdown) {
    variant.breakdown.characters = formatShotSchema(project, variant.shotSchema, 'identity');
    variant.breakdown.pose = formatShotSchema(project, variant.shotSchema, 'pose');
  }
}
export function formatCamera(project, camera, separator = '\n') {
  const concise = project.staticPromptFormat === 'concise-v1';
  return Object.entries(concise ? conciseCameraFields : cameraFields)
    .filter(([key]) => !concise || camera?.[key]?.trim())
    .map(([key, label]) => `${label}：${camera?.[key] || '待填写'}`).join(separator);
}
export function composeStaticPrompt(project, variant) {
  if (!variant.breakdown) return variant.staticPrompt;
  const value = v => typeof v === 'string' && v.trim() ? v : '待填写';
  const b = variant.breakdown;
  if (project.staticPromptFormat === 'concise-v1') {
    const join = values => values.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()).join('\n');
    return [
      ...Object.entries({ 画幅: project.aspectRatio, 分辨率: project.brief?.resolution }).filter(([, v]) => v?.trim()).map(([label, v]) => `${label}：${v}`),
      ...Object.entries({
        画面瞬间: b.content,
        场景环境: b.scene,
        镜头与构图: join([formatCamera(project, b.camera, '；'), b.composition]),
        光影与风格: join([project.brief?.style, b.lighting, b.texture]),
        人物与关系: variant.shotSchema ? formatShotSchema(project, variant.shotSchema) : join([b.characters, b.pose]),
        连续性与限制: b.continuity
      }).filter(([, v]) => v?.trim()).map(([label, v]) => `${label}：${v.trim()}`)
    ].join('\n\n');
  }
  return [
    `画幅：${value(project.aspectRatio)}`,
    ...(project.brief ? [`分辨率：${value(project.brief.resolution)}`, `视觉风格：${value(project.brief.style)}`] : []),
    `镜头内容：${value(b.content)}`,
    '景别／拍摄方式：\n' + Object.entries(cameraFields).map(([key, label]) => `${label}：${value(b.camera?.[key])}`).join('\n'),
    `构图与空间层次：${value(b.composition)}`, `光影／色调：${value(b.lighting)}`,
    `姿态与表情：${value(b.pose)}`, `角色描述：${value(b.characters)}`,
    `场景描述：${value(b.scene)}`, `材质与画面质感：${value(b.texture)}`
  ].join('\n\n');
}
function refreshStaticPrompts(project, advanceVersions = false) {
  for (const shot of project.shots) for (const variant of shot.variants) if (variant.breakdown) {
    projectShotSchema(project, variant);
    const composed = composeStaticPrompt(project, variant);
    if (variant.staticPrompt !== composed) {
      if (advanceVersions) variant.version++;
      if (shot.selectedVariantId === variant.id) invalidate(shot);
    }
    variant.staticPrompt = composed;
  }
  if (project.imageBatches?.some(b => b.status === 'prepared')) {
    const fingerprint = batchFingerprint(project);
    for (const batch of project.imageBatches) if (batch.status === 'prepared' && batch.dependencyFingerprint !== fingerprint) {
      batch.status = 'stale'; batch.staleReason = '当前框架内容或审核状态与冻结清单不一致，请重新核对后准备';
    }
  }
  return project;
}
function stringFields(value, fields, required = true) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('框架字段应为对象');
  for (const key of Object.keys(value)) if (!Object.hasOwn(fields, key)) fail(`不可修改框架字段：${key}`);
  for (const key of Object.keys(required ? fields : value)) text(value[key], 5000);
}
function checkBreakdown(value, project) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('分镜框架应为对象');
  for (const key of Object.keys(value)) if (!['content', 'camera', 'lighting', 'characters', 'scene', 'decision', 'continuity', ...Object.keys(staticFields)].includes(key)) fail(`不可修改框架字段：${key}`);
  for (const key of ['content', 'lighting', 'characters', 'scene', 'decision']) text(value[key], 5000);
  for (const key of [...Object.keys(staticFields), 'continuity']) if (value[key] !== undefined) text(value[key], 5000);
  stringFields(value.camera, cameraFields, project.staticPromptFormat !== 'concise-v1');
}
function validateSection(section, project) {
  if (!section || !/^[A-Za-z0-9_-]{1,50}$/.test(section.id)) fail('内容ID无效');
  category(section.category); text(section.title, 200); text(section.rationale); tags(section.tags); tags(section.options);
  if (['frame', 'camera', 'production'].includes(section.category)) fail('画面与运镜内容应保存到拍法方案');
  if (!Array.isArray(section.shotIds) || !section.shotIds.length || section.shotIds.some(id => !project.shots.some(s => s.id === id))) fail('内容引用镜头不存在');
  if (section.category === 'shotFrames') {
    if (section.shotIds.length !== 1 || !section.variantId) fail('补充静帧必须绑定一个镜头及其拍法');
    findVariant(findShot(project, section.shotIds[0]), section.variantId);
  } else if (section.variantId !== undefined) fail('只有补充静帧可绑定拍法');
  if (!Array.isArray(section.prompts) || !section.prompts.length || section.prompts.length > 10) fail('需要1至10段独立Prompt');
  for (const prompt of section.prompts) { if (!prompt || typeof prompt !== 'object') fail('Prompt格式错误'); text(prompt.label, 100); if (!text(prompt.text).trim()) fail('Prompt不能为空'); }
  if (!Number.isInteger(section.version) || section.version < 1) fail('内容版本无效');
  if (section.assetIds !== undefined && (!Array.isArray(section.assetIds) || section.assetIds.some(id => !allAssets(project).some(e => e.id === id)))) fail('三视图关联资产不存在');
}
const variantFields = ['title', 'description', 'rationale', 'staticPrompt', 'motionPrompt', 'constraints', 'tags', 'referenceIds', 'characterAssetIds', 'tagGroups', 'breakdown', 'shotSchema'];
export const promptMode = project => project.promptMode ?? 'static-motion';
const hasSyncedPrompts = (project, values) => (!!values.breakdown || typeof values.staticPrompt === 'string') && (promptMode(project) === 'static' || typeof values.motionPrompt === 'string');
const validateVariant = (variant, project) => {
  if (!variant || !/^[A-Za-z0-9_-]{1,50}$/.test(variant.id)) fail('方案ID无效');
  if (variant.shotSchema !== undefined) {
    if (project.staticPromptFormat !== 'concise-v1' || !variant.breakdown) fail('Shot Schema需要精简格式和基础分镜框架');
    checkShotSchema(variant.shotSchema, project);
    const visible = variant.shotSchema.subjects.map(s => s.assetId);
    if (JSON.stringify(variant.characterAssetIds) !== JSON.stringify(visible) || JSON.stringify(variant.referenceIds) !== JSON.stringify(schemaReferences(variant.shotSchema))) fail('人物与参考映射须与Shot Schema一致');
  }
  for (const key of variantFields) {
    if (key === 'staticPrompt' && variant.breakdown && variant[key] === undefined) continue;
    if (key === 'staticPrompt' && variant.breakdown) { text(variant[key], 150000); continue; }
    if (key === 'motionPrompt' && variant[key] === undefined && promptMode(project) === 'static') continue;
    if (key === 'characterAssetIds') {
      if (variant[key] !== undefined) {
        tags(variant[key]);
        if (variant[key].some(id => !project.productionInventory?.characters?.some(a => a.id === id))) fail('方案入镜人物资产不存在');
      }
      continue;
    }
    if (key === 'breakdown') { if (variant.breakdown !== undefined) checkBreakdown(variant.breakdown, project); continue; }
    if (key === 'shotSchema') continue;
    if (key === 'tagGroups') {
      if (variant.tagGroups !== undefined && !Array.isArray(variant.tagGroups)) fail('分类标签应为数组');
      if (new Set((variant.tagGroups ?? []).map(g => g?.category)).size !== (variant.tagGroups ?? []).length) fail('方案主Tag重复');
      for (const group of variant.tagGroups ?? []) { category(group.category); tags(group.tags); tags(group.options); text(group.reason); }
      continue;
    }
    if (['constraints', 'tags', 'referenceIds'].includes(key)) tags(variant[key]);
    else text(variant[key]);
  }
  if (!composeStaticPrompt(project, variant)?.trim()) fail('静帧prompt不能为空');
  if (variant.referenceIds.some(id => !project.references.some(r => r.id === id))) fail('方案引用不存在的参考图');
};
export function validateProject(project) {
  if (project.schemaVersion !== 1 || !Number.isInteger(project.revision) || project.revision < 1) fail('不支持的项目格式');
  if (project.workflowMode !== undefined && project.workflowMode !== 'agent-default') fail('工作流程模式无效');
  if (!['static', 'static-motion'].includes(promptMode(project))) fail('Prompt模式无效');
  if (project.staticPromptFormat !== undefined && project.staticPromptFormat !== 'concise-v1') fail('静帧Prompt格式无效');
  if (!Array.isArray(project.shots) || !Array.isArray(project.references) || !Array.isArray(project.comments)) fail('项目缺少镜头、参考图或批注');
  if (new Set(project.shots.map(s => s.id)).size !== project.shots.length) fail('镜头ID重复');
  if (new Set(project.references.map(r => r.id)).size !== project.references.length) fail('参考图ID重复');
  for (const shot of project.shots) {
    text(shot.original); duration(shot.suggestedDuration);
    for (const key of ['workingScript', 'displayNumber']) if (shot[key] !== undefined) text(shot[key], 5000);
    if (shot.editVersion !== undefined && (!Number.isInteger(shot.editVersion) || shot.editVersion < 1)) fail('工作稿版本无效');
    if (shot.originalFields) for (const field of shot.originalFields) { text(field.name); text(field.value); text(field.cell); }
    if (new Set(shot.variants.map(v => v.id)).size !== shot.variants.length) fail('方案ID重复');
    for (const v of shot.variants) {
      validateVariant(v, project);
      if (!Number.isInteger(v.version) || v.version < 1) fail('方案版本无效');
      if (v.promptNeedsSync !== undefined && typeof v.promptNeedsSync !== 'boolean') fail('Prompt同步状态无效');
    }
    if (shot.selectedVariantId && !shot.variants.some(v => v.id === shot.selectedVariantId)) fail('选定方案不存在');
    if (shot.recommendation) { findVariant(shot, shot.recommendation.variantId); text(shot.recommendation.reason, 5000); }
  }
  tags(project.tags); duration(project.targetDuration);
  if (project.brief) stringFields(project.brief, { purpose: 1, deliverables: 1, resolution: 1, style: 1 });
  if (project.productionConstraints) stringFields(project.productionConstraints, constraintFields);
  if (project.productionInventory) {
    for (const key of Object.keys(project.productionInventory)) if (!['characters', 'locations', 'notes'].includes(key)) fail('资产清单字段无效');
    for (const name of ['characters', 'locations']) {
      const entries = project.productionInventory[name];
      if (!Array.isArray(entries) || entries.length > 100) fail('资产清单应为不超过100项的数组');
      for (const [index, entry] of entries.entries()) {
        const fields = name === 'characters' ? characterFields : locationFields;
        entry.id ??= (name === 'characters' ? 'CHAR_' : 'LOC_') + String(index + 1).padStart(3, '0');
        entry.version ??= 1;
        if (!/^[A-Za-z0-9_-]{1,50}$/.test(entry.id) || !Number.isInteger(entry.version) || entry.version < 1) fail('资产ID或版本无效');
        for (const key of Object.keys(entry)) if (!Object.hasOwn(fields, key) && !['id', 'version', 'shotIds'].includes(key)) fail('不可修改资产字段');
        for (const key of ['name', 'description', 'basis']) text(entry[key], 5000);
        for (const key of Object.keys(fields)) if (entry[key] !== undefined) text(entry[key], 5000);
        if (entry.shotIds !== undefined && (!Array.isArray(entry.shotIds) || entry.shotIds.some(id => !project.shots.some(s => s.id === id)))) fail('资产关联镜头不存在');
      }
    }
    if (new Set(allAssets(project).map(e => e.id)).size !== allAssets(project).length) fail('资产ID重复');
    text(project.productionInventory.notes, 5000);
  }
  for (const key of ['sharedConstraints', 'tagOptions', 'reviewIssues']) if (!Array.isArray(project[key])) fail(`项目${key}应为数组`);
  project.sharedConstraints.forEach(v => text(v));
  for (const group of project.tagOptions) { text(group.label, 100); tags(group.options); }
  for (const r of project.references) {
    if (!/^references\/[A-Za-z0-9_.-]+$/.test(r.path)) fail('参考图路径无效');
    text(r.label); text(r.observations); text(r.usage); text(r.uncertainties);
    if (r.assetIds !== undefined && (!Array.isArray(r.assetIds) || r.assetIds.some(id => !allAssets(project).some(a => a.id === id)))) fail('参考图片关联资产不存在');
  }
  if (project.promptSections !== undefined && !Array.isArray(project.promptSections)) fail('分类内容应为数组');
  const sections = project.promptSections ?? [];
  if (new Set(sections.map(s => s.id)).size !== sections.length) fail('内容ID重复');
  sections.forEach(s => validateSection(s, project));
  if (project.generationRequests !== undefined && !Array.isArray(project.generationRequests)) fail('生成需求应为数组');
  for (const request of project.generationRequests ?? []) {
    category(request.category); tags(request.tags); text(request.text, 5000);
    const shot = findShot(project, request.shotId);
    if (request.variantId) findVariant(shot, request.variantId);
    if (request.category === 'shotFrames' && !request.variantId) fail('补充静帧需求必须指定拍法');
    if (request.sectionId && !sections.some(s => s.id === request.sectionId && s.category === request.category && sectionApplies(s, shot.id, request.variantId))) fail('需求与分类内容不匹配');
    if (!['pending', 'addressed'].includes(request.status)) fail('需求状态无效');
  }
  for (const c of project.comments) {
    if (c.target) { cellInfo(project, c.target); text(c.originalText, 150000); }
    if (c.groupId !== undefined) text(c.groupId, 100);
    if (!['pending', 'addressed', 'resolved'].includes(c.status)) fail('批注状态无效');
    text(c.text, 5000);
  }
  if (project.imageBatches !== undefined && !Array.isArray(project.imageBatches)) fail('图片提交清单应为数组');
  for (const batch of project.imageBatches ?? []) {
    if (!['prepared', 'stale'].includes(batch.status) || batch.executionStatus !== 'not_submitted') fail('图片提交清单状态无效');
    text(batch.id, 100); text(batch.dependencyFingerprint, 64);
    if (!Array.isArray(batch.items) || !batch.items.length) fail('图片提交清单不能为空');
  }
  validateStoryPlan(project);
  return project;
}
export function loadProject(directory) {
  const project = validateProject(JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf8')));
  if (project.workflowMode === 'agent-default') checkStorySource(directory, project);
  return refreshStaticPrompts(project, true);
}
function checkStoryQuotes(project, sourceText) {
  const lines = sourceText.replace(/\r\n?/g, '\n').split('\n');
  for (const event of project.storyPlan.events) if (event.sourceRef) {
    const { startLine, endLine, quote } = event.sourceRef;
    if (endLine > lines.length || !lines.slice(startLine - 1, endLine).join('\n').includes(quote.replace(/\r\n?/g, '\n'))) fail(`事件 ${event.id} 的来源引文与原稿不符`);
  }
}
function checkStorySource(directory, project) {
  if (!/^sources\/original\.(txt|md)$/.test(project.source?.path)) fail('故事原稿路径无效');
  const root = fs.realpathSync(directory), filename = fs.realpathSync(path.join(root, project.source.path));
  if (!filename.startsWith(root + path.sep)) fail('故事原稿超出项目目录');
  const bytes = fs.readFileSync(filename);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== project.source.sha256) fail('故事原稿哈希已变化');
  checkStoryQuotes(project, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export function initializeStoryProject(directory, sourceFile, plan) {
  if (fs.existsSync(directory)) fail('目标目录已存在，拒绝覆盖；请使用新项目目录');
  const extension = path.extname(sourceFile).toLowerCase();
  if (!['.txt', '.md'].includes(extension)) fail('故事输入仅支持UTF-8 TXT或Markdown');
  const bytes = fs.readFileSync(sourceFile);
  if (!bytes.length || bytes.length > 1000000) fail('故事原稿应为非空且不超过1MB的文本');
  let sourceText;
  try { sourceText = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('故事原稿须使用有效UTF-8编码'); }
  if (!sourceText.trim()) fail('故事原稿不能为空');
  checkKeys(plan, ['title', 'overview', 'aspectRatio', 'targetDuration', 'brief', 'productionInventory', 'storyPlan', 'shots', 'references', 'promptSections', 'sharedConstraints', 'reviewIssues'], '创作计划');
  if (!Array.isArray(plan.shots) || !plan.shots.length) fail('创作计划需要完整分镜');
  if (!plan.brief || !plan.productionInventory) fail('创作计划需要目标和角色场景资产');
  const project = {
    schemaVersion: 1, revision: 1, projectId: crypto.randomUUID(), workflowMode: 'agent-default', promptMode: 'static', staticPromptFormat: 'concise-v1',
    title: text(plan.title, 200), overview: text(plan.overview ?? '', 30000), aspectRatio: text(plan.aspectRatio, 100), targetDuration: duration(plan.targetDuration),
    brief: structuredClone(plan.brief), productionInventory: structuredClone(plan.productionInventory), storyPlan: structuredClone(plan.storyPlan),
    source: { originalName: path.basename(sourceFile), path: 'sources/original' + extension, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), format: 'text', encoding: 'UTF-8', lineCount: sourceText.replace(/\r\n?/g, '\n').split('\n').length },
    tags: [], tagOptions: [], sharedConstraints: structuredClone(plan.sharedConstraints ?? []), reviewIssues: structuredClone(plan.reviewIssues ?? []),
    visualReview: { status: 'unreviewed', reviewer: '', evidence: '本项目只有文本草案，未生成或核验图像。' },
    shots: [], references: [], comments: [], promptSections: structuredClone(plan.promptSections ?? []), generationRequests: [], imageBatches: [],
    lastChange: { actor: 'agent', reason: '从普通故事建立完整默认草案；未替用户选择或确认', at: new Date().toISOString() }
  };
  const attachments = [];
  if (plan.references !== undefined && !Array.isArray(plan.references)) fail('参考输入应为数组');
  for (const input of plan.references ?? []) {
    checkKeys(input, ['id', 'file', 'sha256', 'label', 'role', 'assetIds', 'visualStatus', 'observations', 'usage', 'uncertainties'], '参考输入'); stableId(input.id);
    const file = path.resolve(path.dirname(sourceFile), text(input.file));
    const suffix = path.extname(file).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(suffix)) fail('参考须为实际PNG、JPEG或WebP文件');
    const data = fs.readFileSync(file), sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const imageHeader = suffix === '.png' ? data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : suffix === '.webp' ? data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP'
      : data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
    if (!imageHeader) fail('参考文件格式头与图片扩展名不符');
    if (input.sha256 !== undefined && input.sha256 !== sha256) fail('参考输入哈希不符');
    if (!['unreviewed', 'reviewed'].includes(input.visualStatus ?? 'unreviewed')) fail('参考视觉状态无效');
    const ref = { id: input.id, path: 'references/' + input.id + suffix, sha256, label: text(input.label, 200), role: text(input.role ?? 'unknown', 100),
      assetIds: input.assetIds ?? [], visualStatus: input.visualStatus ?? 'unreviewed', observations: text(input.observations ?? ''), usage: text(input.usage ?? ''), uncertainties: text(input.uncertainties ?? ''), sourceRef: { originalName: path.basename(file) } };
    project.references.push(ref); attachments.push({ path: ref.path, data });
  }
  for (const [index, input] of plan.shots.entries()) {
    checkKeys(input, ['id', 'displayNumber', 'workingScript', 'suggestedDuration', 'characters', 'scene', 'purpose', 'eventIds', 'dependsOnShotIds', 'recommendation', 'variants'], '初始镜头');
    if (!Array.isArray(input.variants) || input.variants.length !== 1) fail('初始故事每镜须有一套默认方案');
    const events = input.eventIds?.map(id => project.storyPlan?.events?.find(e => e.id === id));
    if (!events?.length || events.some(e => !e)) fail('初始镜头引用不存在的事件');
    const shot = { ...structuredClone(input), displayNumber: text(input.displayNumber ?? String(index + 1).padStart(2, '0'), 100), sourceNumber: null,
      original: events.map(e => e.sourceRef?.quote ?? '').filter(Boolean).join('\n'), sourceRef: { eventIds: [...input.eventIds] }, originalFields: [], originalDuration: null,
      workingScript: text(input.workingScript, 5000), suggestedDuration: duration(input.suggestedDuration), durationOrigin: 'director_suggestion', tags: [], editVersion: 1,
      selectedVariantId: null, approval: null, status: 'needs_review' };
    for (const variant of shot.variants) {
      checkKeys(variant, ['id', ...variantFields], '初始拍法');
      if (variant.motionPrompt?.trim()) fail('静态故事不新增视频Prompt');
      variant.version = 1; variant.origin = 'director_interpretation'; variant.promptNeedsSync = false;
      projectShotSchema(project, variant); variant.staticPrompt = composeStaticPrompt(project, variant);
    }
    shot.characters = shot.variants[0].characterAssetIds.map(id => project.productionInventory.characters.find(a => a.id === id).name);
    project.shots.push(shot);
  }
  validateProject(project); checkStoryQuotes(project, sourceText);
  fs.mkdirSync(path.dirname(path.resolve(directory)), { recursive: true });
  fs.mkdirSync(directory);
  for (const name of ['sources', 'references', 'revisions']) fs.mkdirSync(path.join(directory, name));
  fs.writeFileSync(path.join(directory, project.source.path), bytes);
  fs.writeFileSync(path.join(directory, 'sources', 'manifest.json'), JSON.stringify({ ...project.source, references: project.references }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(directory, 'sources', 'source.md'), `# 原始故事：${project.source.originalName}\n\n原件：[${path.basename(project.source.path)}](${path.basename(project.source.path)})；SHA256 ${project.source.sha256}\n\n${sourceText}\n`, 'utf8');
  for (const attachment of attachments) fs.writeFileSync(path.join(directory, attachment.path), attachment.data);
  exportProject(directory, project);
  fs.writeFileSync(path.join(directory, 'project.json'), JSON.stringify(project, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return project;
}
function findShot(project, id) {
  const shot = project.shots.find(s => s.id === id);
  if (!shot) fail('镜头不存在');
  return shot;
}
function findVariant(shot, id) {
  const variant = shot.variants.find(v => v.id === id);
  if (!variant) fail('方案不存在');
  return variant;
}
function allAssets(project) { return [...(project.productionInventory?.characters ?? []), ...(project.productionInventory?.locations ?? [])]; }
function sectionApplies(section, shotId, variantId) { return section.shotIds.includes(shotId) && (section.category !== 'shotFrames' || section.variantId === variantId); }
export function cellInfo(project, target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) fail('需要单元格目标');
  const keys = { shot: ['kind', 'shotId', 'field'], variant: ['kind', 'shotId', 'variantId', 'field'], asset: ['kind', 'assetType', 'assetId', 'field'], section: ['kind', 'sectionId', 'field'] };
  if (!Object.hasOwn(keys, target.kind) || Object.keys(target).some(k => !keys[target.kind].includes(k))) fail('单元格目标无效');
  let owner, allowed, label, version;
  if (target.kind === 'shot') {
    owner = findShot(project, target.shotId); allowed = ['displayNumber', 'workingScript', 'suggestedDuration', 'purpose', 'scene'];
    label = '镜 ' + (owner.displayNumber ?? owner.sourceNumber); version = owner.editVersion ?? 1;
  } else if (target.kind === 'variant') {
    owner = findVariant(findShot(project, target.shotId), target.variantId);
    allowed = ['title', 'description', 'rationale', 'staticPrompt', 'motionPrompt', 'shotSchema', ...['content', 'lighting', 'characters', 'scene', 'decision', 'continuity', ...Object.keys(staticFields)].map(k => 'breakdown.' + k), ...Object.keys(cameraFields).map(k => 'breakdown.camera.' + k)];
    label = target.shotId + ' / ' + target.variantId; version = owner.version;
  } else if (target.kind === 'asset') {
    if (!['characters', 'locations'].includes(target.assetType)) fail('资产类型无效');
    owner = project.productionInventory?.[target.assetType]?.find(e => e.id === target.assetId);
    if (!owner) fail('资产不存在');
    allowed = Object.keys(target.assetType === 'characters' ? characterFields : locationFields); label = owner.name; version = owner.version;
  } else {
    owner = project.promptSections?.find(s => s.id === target.sectionId);
    if (!owner) fail('独立Prompt不存在');
    allowed = ['title', 'rationale', ...owner.prompts.flatMap((p, i) => [`prompts.${i}.label`, `prompts.${i}.text`])]; label = owner.title; version = owner.version;
  }
  if (!allowed.includes(target.field)) fail('不可修改单元格字段');
  let value = target.field.split('.').reduce((o, key) => o?.[key], owner);
  if (target.kind === 'variant' && target.field === 'shotSchema') value = owner.shotSchema ? JSON.stringify(owner.shotSchema, null, 2) : '';
  if (target.kind === 'variant' && owner.shotSchema && ['breakdown.characters', 'breakdown.pose'].includes(target.field)) value = formatShotSchema(project, owner.shotSchema, target.field === 'breakdown.pose' ? 'pose' : 'identity');
  if (target.kind === 'variant' && target.field === 'staticPrompt') value = composeStaticPrompt(project, owner);
  if (target.kind === 'shot' && target.field === 'workingScript') value ??= owner.original;
  if (target.kind === 'shot' && target.field === 'displayNumber') value ??= String(owner.sourceNumber);
  return { owner, value: value ?? '', version, label, field: target.field };
}
function dependentShots(project, target) {
  if (['shot', 'variant'].includes(target.kind)) return [target.shotId];
  if (target.kind === 'section') return project.promptSections.find(s => s.id === target.sectionId).shotIds;
  const asset = cellInfo(project, target).owner;
  return [...new Set([...(asset.shotIds ?? project.shots.map(s => s.id)), ...project.shots.filter(s => s.variants.some(v => v.characterAssetIds?.includes(asset.id))).map(s => s.id), ...(project.promptSections ?? []).filter(s => s.assetIds?.includes(asset.id)).flatMap(s => s.shotIds)])];
}
function downstreamShots(project, ids) {
  if (project.workflowMode !== 'agent-default') return [];
  const affected = new Set(ids), result = [];
  for (let index = 0, queue = [...ids]; index < queue.length; index++) {
    for (const shot of project.shots) if (!affected.has(shot.id) && shot.dependsOnShotIds.includes(queue[index])) {
      affected.add(shot.id); result.push(shot.id); queue.push(shot.id);
    }
  }
  return result;
}
function markShotSync(project, id) {
  const shot = findShot(project, id);
  for (const variant of shot.variants) variant.promptNeedsSync = true;
  for (const section of project.promptSections ?? []) if (section.category === 'shotFrames' && section.shotIds.includes(id)) section.promptNeedsSync = true;
  invalidate(shot);
}
function markDownstream(project, ids, affectedShotIds) {
  const dependent = downstreamShots(project, ids);
  if (affectedShotIds !== undefined) {
    if (project.workflowMode !== 'agent-default') fail('显式修订范围仅用于故事项目');
    checkedIds(affectedShotIds, dependent, '修订影响范围');
  }
  for (const id of affectedShotIds ?? dependent) markShotSync(project, id);
}
function markDependent(project, target, needsSync = true, affectedShotIds) {
  const variantId = target.kind === 'variant' ? target.variantId : target.kind === 'section' ? project.promptSections.find(s => s.id === target.sectionId).variantId : null;
  for (const id of dependentShots(project, target)) {
    const shot = findShot(project, id);
    if (needsSync) for (const v of shot.variants) if (!variantId || v.id === variantId) v.promptNeedsSync = true;
    if (!variantId || !shot.selectedVariantId || shot.selectedVariantId === variantId) invalidate(shot);
  }
  if (needsSync && (target.kind !== 'variant' || draftVariant(project, findShot(project, target.shotId))?.id === target.variantId)) {
    markDownstream(project, dependentShots(project, target), affectedShotIds);
  }
  if (needsSync && project.workflowMode === 'agent-default' && ['shot', 'variant'].includes(target.kind)) {
    for (const section of project.promptSections ?? []) if (section.category === 'shotFrames' && section.shotIds.includes(target.shotId) && (!variantId || section.variantId === variantId)) section.promptNeedsSync = true;
  }
  if (needsSync && target.kind === 'asset') for (const s of project.promptSections ?? []) if (s.assetIds?.includes(target.assetId)) s.promptNeedsSync = true;
}
function editCell(project, target, value, expectedValue, affectedShotIds) {
  const info = cellInfo(project, target); text(value, target.kind === 'variant' && ['staticPrompt', 'shotSchema'].includes(target.field) ? 150000 : 30000);
  if (expectedValue !== undefined && String(info.value) !== String(expectedValue)) throw new ProjectError('该单元格已变化，请比较新值后再保存；草稿保留', 409);
  if (target.kind === 'variant') {
    const shot = findShot(project, target.shotId);
    if (target.field === 'shotSchema') {
      let schema;
      try { schema = JSON.parse(value); } catch { fail('Shot Schema格式错误，草稿已保留'); }
      editVariant(project, shot, info.owner, { shotSchema: schema }, false, affectedShotIds);
    } else if (info.owner.shotSchema && ['breakdown.characters', 'breakdown.pose'].includes(target.field)) fail('人物与姿态由Shot Schema生成，请编辑人物与道具');
    else if (target.field.startsWith('breakdown.')) {
      const b = structuredClone(info.owner.breakdown ?? { content: '', lighting: '', characters: '', scene: '', decision: '', camera: Object.fromEntries(Object.keys(project.staticPromptFormat === 'concise-v1' ? conciseCameraFields : cameraFields).map(k => [k, ''])) });
      const parts = target.field.split('.').slice(1); if (parts.length === 2) b.camera[parts[1]] = value; else b[parts[0]] = value;
      editVariant(project, shot, info.owner, { breakdown: b }, false, affectedShotIds);
    } else { editVariant(project, shot, info.owner, { [target.field]: value }, false, affectedShotIds); if (['description', 'motionPrompt'].includes(target.field) || target.field === 'staticPrompt' && !info.owner.breakdown) info.owner.promptNeedsSync = true; }
  } else if (target.kind === 'shot') {
    info.owner[target.field] = target.field === 'suggestedDuration' ? duration(value.trim() ? Number(value) : null) : text(value, 5000);
    if (target.field === 'suggestedDuration') info.owner.durationOrigin = 'user_suggestion';
    info.owner.editVersion = info.version + 1;
    if (target.field !== 'displayNumber') markDependent(project, target, true, affectedShotIds);
  } else if (target.kind === 'asset') {
    info.owner[target.field] = text(value, 5000); info.owner.version++;
    markDependent(project, target);
  } else {
    const parts = target.field.split('.');
    if (parts[0] === 'prompts') info.owner.prompts[Number(parts[1])][parts[2]] = value; else info.owner[target.field] = value;
    info.owner.version++; info.owner.promptNeedsSync = true; markDependent(project, target);
  }
}
export function pendingProject(project) {
  return { revision: project.revision, promptMode: promptMode(project), ...(project.workflowMode ? { workflowMode: project.workflowMode, storyPlanVersion: project.storyPlan.version } : {}), ...(project.staticPromptFormat ? { staticPromptFormat: project.staticPromptFormat } : {}), comments: project.comments.filter(c => c.status === 'pending'), generationRequests: (project.generationRequests ?? []).filter(r => r.status === 'pending'),
    needsSync: [...project.shots.flatMap(s => s.variants.filter(v => v.promptNeedsSync).map(v => ({ kind: 'variant', shotId: s.id, variantId: v.id, version: v.version, workingScript: s.workingScript ?? s.original, ...(s.eventIds ? { eventIds: s.eventIds, dependsOnShotIds: s.dependsOnShotIds } : {}) }))), ...(project.promptSections ?? []).filter(s => s.promptNeedsSync).map(s => ({ kind: 'section', sectionId: s.id, version: s.version, ...(s.variantId ? { shotId: s.shotIds[0], variantId: s.variantId } : {}), assetIds: s.assetIds ?? [] }))] };
}
function invalidate(shot) { shot.approval = null; shot.status = 'needs_review'; }
export function imageBatchReadiness(project) {
  const approved = project.shots.filter(s => {
    const v = s.variants.find(v => v.id === s.selectedVariantId);
    return v && s.approval?.variantId === v.id && s.approval.variantVersion === v.version;
  }).length;
  const pending = pendingProject(project), reasons = [];
  if (!project.shots.length || approved !== project.shots.length) reasons.push(`全片确认 ${approved}/${project.shots.length}，须确认每镜当前选定版本`);
  if (pending.comments.length || pending.generationRequests.length) reasons.push('仍有待处理批注或修改请求');
  if (pending.needsSync.length) reasons.push('仍有待同步内容');
  return { ready: !reasons.length, approved, total: project.shots.length, reasons };
}
function batchFingerprint(project) {
  // Approval timestamps and comment replies do not change an already frozen creative decision.
  const dependency = {
    promptMode: promptMode(project), ...(project.staticPromptFormat ? { staticPromptFormat: project.staticPromptFormat } : {}), aspectRatio: project.aspectRatio, brief: project.brief, targetDuration: project.targetDuration,
    constraints: project.sharedConstraints, productionConstraints: project.productionConstraints,
    inventory: project.productionInventory, sections: project.promptSections, references: project.references,
    shots: project.shots.map(s => ({ id: s.id, displayNumber: s.displayNumber, workingScript: s.workingScript ?? s.original,
      duration: s.suggestedDuration, characters: s.characters, scene: s.scene, selectedVariantId: s.selectedVariantId,
      approved: !!s.approval && s.approval.variantId === s.selectedVariantId && s.approval.variantVersion === s.variants.find(v => v.id === s.selectedVariantId)?.version,
      variants: s.variants.filter(v => project.workflowMode !== 'agent-default' || v.id === s.selectedVariantId).map(v => { const copy = { ...v, staticPrompt: composeStaticPrompt(project, v) }; if (promptMode(project) === 'static') delete copy.motionPrompt; return copy; }) })),
    ready: imageBatchReadiness(project).ready
  };
  return crypto.createHash('sha256').update(JSON.stringify(dependency)).digest('hex');
}
function prepareImageBatch(directory, project, shotIds) {
  const readiness = imageBatchReadiness(project);
  if (!readiness.ready) fail(readiness.reasons.join('；'));
  if (!Array.isArray(shotIds) || !shotIds.length || shotIds.length > project.shots.length || new Set(shotIds).size !== shotIds.length) fail('提交清单需要不重复的镜头ID');
  const characters = project.productionInventory?.characters ?? [];
  if (new Set(characters.map(a => a.name)).size !== characters.length) fail('人物资产名称重复，请先消解名称映射');
  const items = shotIds.map(id => {
    const shot = findShot(project, id), variant = findVariant(shot, shot.selectedVariantId);
    const mapped = Array.isArray(variant.characterAssetIds);
    const candidateAssets = mapped ? [] : (shot.characters ?? []).map(name => {
      const asset = characters.find(a => a.name === name);
      if (!asset) fail(`镜头 ${id} 的人物“${name}”尚未登记对应资产`);
      return asset;
    });
    const assets = mapped ? variant.characterAssetIds.map(id => characters.find(a => a.id === id)) : [];
    const included = [], excludedReferences = [];
    for (const refId of variant.referenceIds) {
      const ref = project.references.find(r => r.id === refId);
      // Only explicitly classified generation references travel to the image provider.
      if (ref.visualStatus !== 'reviewed' || !/^(character(?:_[a-z]+)*|location|scene|style|composition|prop)$/.test(ref.role ?? '')) {
        excludedReferences.push({ id: ref.id, reason: '尚未视觉核验或用途不属于生图参考' }); continue;
      }
      if (/^character/.test(ref.role) && (!ref.assetIds?.length || !ref.assetIds.every(id => assets.some(a => a.id === id)))) {
        excludedReferences.push({ id: ref.id, reason: '未明确关联本拍法人物，或参考含有本拍法未入镜人物' }); continue;
      }
      const filename = path.resolve(directory, ref.path), root = fs.realpathSync(directory);
      if (!fs.existsSync(filename)) fail(`参考附件不存在：${ref.id}`);
      if (!fs.realpathSync(filename).startsWith(root + path.sep)) fail('参考附件超出项目目录');
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
      if (sha256 !== ref.sha256) fail(`参考附件哈希已变化：${ref.id}`);
      included.push({ id: ref.id, path: ref.path, sha256, role: ref.role, usage: ref.usage, assetIds: ref.assetIds ?? [] });
    }
    return { shotId: shot.id, variantId: variant.id, variantVersion: variant.version, staticPrompt: composeStaticPrompt(project, variant), ...(variant.shotSchema ? { shotSchema: structuredClone(variant.shotSchema) } : {}),
      constraints: [...project.sharedConstraints, ...variant.constraints], characterAssets: assets.map(a => ({ id: a.id, name: a.name, version: a.version })),
      characterMappingStatus: mapped ? 'mapped' : 'needs_review',
      ...(mapped ? {} : { candidateCharacterAssets: candidateAssets.map(a => ({ id: a.id, name: a.name, version: a.version })), characterMappingNote: '镜头人物为待核对候选，须登记本拍法characterAssetIds后才能作为生图身份关联' }),
      characterReferences: assets.map(a => ({ assetId: a.id, name: a.name,
        referenceIds: included.filter(r => /^character/.test(r.role) && r.assetIds.includes(a.id)).map(r => r.id),
        status: included.some(r => /^character/.test(r.role) && r.assetIds.includes(a.id)) ? 'ready' : 'pending_reference',
        note: included.some(r => /^character/.test(r.role) && r.assetIds.includes(a.id)) ? '已关联实际身份参考附件' : '人物资产三视图图片参考待生成或待登记关联' })),
      referenceIds: included.map(r => r.id), references: included, excludedReferences,
      additionalFrames: (project.promptSections ?? []).filter(s => s.category === 'shotFrames' && sectionApplies(s, shot.id, variant.id)).flatMap(s => s.prompts.map((p, promptIndex) => ({
        sectionId: s.id, version: s.version, promptIndex, label: p.label, text: p.text,
        assets: (s.assetIds ?? []).map(id => { const a = allAssets(project).find(a => a.id === id); return { id: a.id, name: a.name, version: a.version }; }),
        assetMappingStatus: Array.isArray(s.assetIds) ? 'mapped' : 'needs_review',
        references: [], referenceStatus: 'pending_reference', referenceNote: '补充静帧尚未登记独立图片参考映射，执行前须核对，不沿用主帧人物参考。'
      }))) };
  });
  const batch = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), sourceRevision: project.revision,
    promptMode: promptMode(project), ...(project.staticPromptFormat ? { staticPromptFormat: project.staticPromptFormat } : {}), status: 'prepared', executionStatus: 'not_submitted',
    aspectRatio: project.aspectRatio, resolution: project.brief?.resolution ?? null, model: null, quantityPerShot: null, targetProject: null,
    items, dependencyFingerprint: batchFingerprint(project) };
  (project.imageBatches ??= []).push(batch);
}
function continuityInput(variant) {
  const b = variant.breakdown;
  return JSON.stringify({ schema: variant.shotSchema, content: b?.content, scene: b?.scene, continuity: b?.continuity, lighting: b?.lighting,
    ...(variant.shotSchema ? {} : { characters: b?.characters, pose: b?.pose }) });
}
function editVariant(project, shot, variant, values, frameworkReviewed = false, affectedShotIds) {
  const previous = continuityInput(variant), current = draftVariant(project, shot)?.id === variant.id;
  if (promptMode(project) === 'static' && Object.hasOwn(values, 'motionPrompt') && values.motionPrompt !== variant.motionPrompt) fail('静态模式保留历史视频Prompt，不接受新增或改写');
  for (const [key, value] of Object.entries(values)) {
    if (!variantFields.includes(key)) fail(`不可修改字段：${key}`);
    variant[key] = ['tagGroups', 'breakdown', 'shotSchema'].includes(key) ? value : ['constraints', 'tags', 'referenceIds', 'characterAssetIds'].includes(key) ? tags(value) : text(value, key === 'staticPrompt' ? 150000 : 30000);
  }
  projectShotSchema(project, variant);
  if (variant.breakdown) {
    const composed = composeStaticPrompt(project, variant);
    if (Object.hasOwn(values, 'staticPrompt') && values.staticPrompt !== composed) fail('静态Prompt由分镜框架自动生成，请修改对应框架字段');
    variant.staticPrompt = composed;
    if (values.breakdown && promptMode(project) !== 'static') variant.promptNeedsSync = true;
    if (frameworkReviewed && values.breakdown && hasSyncedPrompts(project, values)) variant.promptNeedsSync = false;
  } else if (hasSyncedPrompts(project, values)) variant.promptNeedsSync = false;
  validateVariant(variant, project);
  variant.version++;
  if (shot.selectedVariantId === variant.id) invalidate(shot);
  if (current && previous !== continuityInput(variant)) {
    for (const section of project.promptSections ?? []) if (project.workflowMode === 'agent-default' && section.category === 'shotFrames' && sectionApplies(section, shot.id, variant.id)) section.promptNeedsSync = true;
    markDownstream(project, [shot.id], affectedShotIds);
  } else if (affectedShotIds !== undefined) checkedIds(affectedShotIds, [], '无状态变化的修订范围');
}
export function mutateProject(directory, baseRevision, actor, reason, operation) {
  const lockPath = path.join(directory, '.write.lock');
  let lock;
  try { lock = fs.openSync(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new ProjectError('另一个写入正在进行；若进程崩溃，请先核对后移除单个锁文件', 409); throw error; }
  try {
    const project = loadProject(directory);
    if (project.revision !== baseRevision) throw new ProjectError('版本已变化，请刷新后重新提交；当前草稿不会自动覆盖', 409);
    operation(project);
    refreshStaticPrompts(project, true);
    const fingerprint = batchFingerprint(project);
    for (const batch of project.imageBatches ?? []) if (batch.status === 'prepared' && batch.dependencyFingerprint !== fingerprint) {
      batch.status = 'stale'; batch.staleAt = new Date().toISOString(); batch.staleReason = '全片内容、资产或审核状态已变化，请重新核对后准备清单';
    }
    project.revision++;
    project.lastChange = { actor, reason, at: new Date().toISOString() };
    validateProject(project);
    const history = path.join(directory, 'revisions');
    fs.mkdirSync(history, { recursive: true });
    const old = path.join(history, `${String(baseRevision).padStart(6, '0')}.json`);
    if (!fs.existsSync(old)) fs.copyFileSync(path.join(directory, 'project.json'), old);
    const temporary = path.join(directory, 'project.json.tmp');
    fs.writeFileSync(temporary, JSON.stringify(project, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, path.join(directory, 'project.json'));
    exportProject(directory, project);
    return project;
  } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}
export function applyAction(directory, action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) fail('操作格式无效');
  return mutateProject(directory, action.baseRevision, 'user', action.type, project => {
    const shot = action.shotId ? findShot(project, action.shotId) : null;
    switch (action.type) {
      case 'edit-cell':
        if (!Object.hasOwn(action, 'expectedValue')) fail('保存单元格需要基线内容');
        editCell(project, action.target, action.value, action.expectedValue, action.affectedShotIds); break;
      case 'cell-comment': {
        const info = cellInfo(project, action.target), commentText = text(action.text, 5000).trim();
        if (!commentText) fail('批注不能为空');
        if (!Object.hasOwn(action, 'expectedValue') || String(info.value) !== String(action.expectedValue)) throw new ProjectError('批注单元格已变化，请读取新值；批注草稿保留', 409);
        project.comments.push({ id: crypto.randomUUID(), target: action.target, shotId: action.target.shotId ?? null, variantId: action.target.variantId ?? null,
          contentVersion: info.version, baseRevision: project.revision, originalText: String(info.value), category: '单元格批注', text: commentText, status: 'pending', at: new Date().toISOString() });
        markDependent(project, action.target, false); break;
      }
      case 'range-comment': {
        const commentText = text(action.text, 5000).trim();
        if (!commentText) fail('批注不能为空');
        if (!Array.isArray(action.targets) || !action.targets.length || action.targets.length > 5000) fail('范围批注需要1至5000个单元格');
        const unique = new Map();
        for (const item of action.targets) {
          const info = cellInfo(project, item?.target);
          if (!Number.isInteger(item.expectedVersion) || item.expectedVersion !== info.version) throw new ProjectError('批注范围内单元格已变化，请核对新版本；批注草稿保留', 409);
          const target = item.target, key = [target.kind, target.shotId, target.variantId, target.assetType, target.assetId, target.sectionId, target.field].join('|');
          unique.set(key, { target, info });
        }
        const groupId = crypto.randomUUID(), at = new Date().toISOString();
        for (const { target, info } of unique.values()) {
          project.comments.push({ id: crypto.randomUUID(), groupId, target, shotId: target.shotId ?? null, variantId: target.variantId ?? null,
            contentVersion: info.version, baseRevision: project.revision, originalText: String(info.value), category: '范围批注', text: commentText, status: 'pending', at });
          markDependent(project, target, false);
        }
        break;
      }
      case 'resolve-cell-comment': {
        const c = project.comments.find(c => c.id === action.commentId && c.target && c.status !== 'resolved');
        if (!c) fail('单元格批注不存在或已解决');
        c.status = 'resolved'; c.resolvedAt = new Date().toISOString(); break;
      }
      case 'resolve-comment-group': {
        const comments = project.comments.filter(c => c.groupId === action.groupId && c.status !== 'resolved');
        if (typeof action.groupId !== 'string' || !comments.length) fail('范围批注不存在或已解决');
        for (const c of comments) { c.status = 'resolved'; c.resolvedAt = new Date().toISOString(); }
        break;
      }
      case 'prepare-image-batch': prepareImageBatch(directory, project, action.shotIds); break;
      case 'project-tags':
        project.tags = tags(action.tags);
        for (const s of project.shots) if (s.variants.length) invalidate(s);
        break;
      case 'production-constraints':
        stringFields(action.values, constraintFields); project.productionConstraints = action.values;
        for (const s of project.shots) if (s.variants.length) { invalidate(s); for (const v of s.variants) v.promptNeedsSync = true; }
        break;
      case 'edit-breakdown':
        if (!shot) fail('需要指定镜头');
        checkBreakdown(action.breakdown, project);
        editVariant(project, shot, findVariant(shot, action.variantId), { breakdown: action.breakdown });
        break;
      case 'shot-settings':
        if (!shot) fail('需要指定镜头');
        shot.tags = tags(action.tags);
        shot.suggestedDuration = duration(action.duration);
        shot.durationOrigin = 'user_suggestion';
        shot.editVersion = (shot.editVersion ?? 1) + 1;
        invalidate(shot);
        break;
      case 'select':
        if (!shot) fail('需要指定镜头');
        findVariant(shot, action.variantId);
        if (draftVariant(project, shot)?.id !== action.variantId) for (const id of downstreamShots(project, [shot.id])) markShotSync(project, id);
        shot.selectedVariantId = action.variantId; invalidate(shot);
        break;
      case 'approve': {
        if (!shot?.selectedVariantId) fail('请先选择方案');
        const v = findVariant(shot, shot.selectedVariantId);
        if (v.promptNeedsSync) fail(promptMode(project) === 'static' ? '框架或约束已修改，请先同步并核对静帧Prompt' : '框架或约束已修改，请先同步并核对静帧与动作Prompt');
        if ((project.promptSections ?? []).some(s => s.promptNeedsSync && sectionApplies(s, shot.id, v.id))) fail('关联三视图或共享Prompt待同步');
        if (project.comments.some(c => c.target && c.status === 'pending' && dependentShots(project, c.target).includes(shot.id) && (c.target.kind !== 'variant' || c.target.variantId === v.id) && (c.target.kind !== 'section' || sectionApplies(project.promptSections.find(s => s.id === c.target.sectionId), shot.id, v.id)))) fail('该方案还有待处理单元格批注');
        if (project.comments.some(c => c.status === 'pending' && c.shotId === shot.id && c.variantId === v.id) || (project.generationRequests ?? []).some(r => r.status === 'pending' && (r.shotId === shot.id && (!r.variantId || r.variantId === v.id) || project.promptSections?.some(s => s.id === r.sectionId && sectionApplies(s, shot.id, v.id))))) fail('该方案还有待处理批注或生成需求');
        shot.approval = { variantId: v.id, variantVersion: v.version, projectRevision: project.revision + 1, at: new Date().toISOString() };
        shot.status = 'approved'; break;
      }
      case 'edit-prompt':
        if (!shot) fail('需要指定镜头');
        editVariant(project, shot, findVariant(shot, action.variantId), { staticPrompt: action.staticPrompt, ...(promptMode(project) === 'static' ? {} : { motionPrompt: action.motionPrompt }) });
        findVariant(shot, action.variantId).promptNeedsSync = false;
        break;
      case 'comment': {
        if (!shot) fail('需要指定镜头');
        const variant = findVariant(shot, action.variantId);
        const commentText = text(action.text, 5000).trim();
        if (!commentText) fail('批注不能为空');
        if (!['改角度', '保留动作', '缩短秒数', '重新提出方案', '其他'].includes(action.category)) fail('批注类型无效');
        project.comments.push({ id: crypto.randomUUID(), shotId: shot.id, variantId: variant.id,
          variantVersion: variant.version, baseRevision: project.revision, category: action.category,
          text: commentText, status: 'pending', at: new Date().toISOString() });
        if (!shot.selectedVariantId || shot.selectedVariantId === variant.id) invalidate(shot);
        break;
      }
      case 'edit-section': {
        const section = project.promptSections?.find(s => s.id === action.sectionId);
        if (!section) fail('分类内容不存在');
        section.tags = tags(action.tags); section.prompts = action.prompts; section.version++; section.promptNeedsSync = false;
        validateSection(section, project);
        markDependent(project, { kind: 'section', sectionId: section.id }, false);
        break;
      }
      case 'generation-request': {
        if (!shot) fail('需要指定镜头');
        category(action.category);
        if (action.variantId && !['frame', 'camera', 'production', 'shotFrames'].includes(action.category)) fail('此类别不使用拍法ID');
        if (action.category === 'shotFrames' && !action.variantId) fail('补充静帧需求必须指定拍法');
        const variant = action.variantId ? findVariant(shot, action.variantId) : null;
        const section = action.sectionId ? project.promptSections?.find(s => s.id === action.sectionId && s.category === action.category && sectionApplies(s, shot.id, variant?.id)) : null;
        if (action.sectionId && !section) fail('需求与分类内容不匹配');
        (project.generationRequests ??= []).push({ id: crypto.randomUUID(), category: action.category, shotId: shot.id,
          variantId: variant?.id ?? null, sectionId: section?.id ?? null, contentVersion: section?.version ?? variant?.version ?? null,
          tags: tags(action.tags), text: text(action.text, 5000), baseRevision: project.revision, status: 'pending', at: new Date().toISOString() });
        for (const id of section?.shotIds ?? [shot.id]) { const s = findShot(project, id); if (s.variants.length && (!variant || !s.selectedVariantId || s.selectedVariantId === variant.id)) invalidate(s); }
        break;
      }
      case 'resolve-issue': {
        const issue = project.reviewIssues.find(i => i.id === action.issueId);
        if (!issue) fail('核对项不存在');
        issue.resolved = true; issue.resolution = text(action.resolution, 5000).trim();
        if (!issue.resolution) fail('请填写核对结果');
        break;
      }
      default: fail('操作不存在');
    }
  });
}
export function applyAgentPatch(directory, patch) {
  return mutateProject(directory, patch.baseRevision, 'agent', text(patch.reason, 2000), project => {
    const commentValues = new Map(project.comments.filter(c => c.target && c.status === 'pending').map(c => [c.id, String(cellInfo(project, c.target).value)]));
    if (patch.project) {
      const previousMode = promptMode(project);
      const allowed = ['title', 'aspectRatio', 'targetDuration', 'tags', 'tagOptions', 'sharedConstraints', 'reviewIssues', 'visualReview', 'productionConstraints', 'productionInventory', 'brief', 'promptMode', 'staticPromptFormat'];
      for (const key of Object.keys(patch.project)) if (!allowed.includes(key)) fail(`不可修改项目字段：${key}`);
      Object.assign(project, patch.project);
      for (const s of project.shots) if (s.variants.length) invalidate(s);
      if (previousMode === 'static' && promptMode(project) === 'static-motion') for (const shot of project.shots) for (const v of shot.variants) { v.motionPrompt ??= ''; v.promptNeedsSync = true; }
      if (['productionConstraints', 'brief', 'aspectRatio', 'targetDuration', 'staticPromptFormat'].some(key => Object.hasOwn(patch.project, key))) {
        for (const s of project.shots) for (const v of s.variants) v.promptNeedsSync = true;
        for (const section of project.promptSections ?? []) section.promptNeedsSync = true;
      }
      validateProject(project);
    }
    if (patch.storyPlanEdits !== undefined) {
      if (project.workflowMode !== 'agent-default' || !Array.isArray(patch.storyPlanEdits)) fail('故事事件修订需要agent-default项目与数组');
      if (new Set(patch.storyPlanEdits.map(e => e?.id)).size !== patch.storyPlanEdits.length) fail('同一事件不可重复修订');
      let changed = false;
      for (const edit of patch.storyPlanEdits) {
        checkKeys(edit, ['id', 'values'], '事件修订');
        const event = project.storyPlan.events.find(e => e.id === edit.id);
        if (!event) fail('只能定向修订现有故事事件');
        checkKeys(edit.values, ['description', 'information', 'basis', 'stateChanges'], '事件修订值');
        if (Object.keys(edit.values).length && Object.entries(edit.values).some(([key, value]) => JSON.stringify(event[key]) !== JSON.stringify(value))) {
          Object.assign(event, structuredClone(edit.values)); event.version++; changed = true;
          for (const shot of project.shots.filter(s => s.eventIds.includes(event.id))) markDependent(project, { kind: 'shot', shotId: shot.id, field: 'workingScript' });
        }
      }
      if (changed) project.storyPlan.version++;
      validateStoryPlan(project);
    }
    for (const edit of patch.assetEdits ?? []) {
      const target = { kind: 'asset', assetType: edit.assetType, assetId: edit.id, field: 'description' }, info = cellInfo(project, target);
      const prior = dependentShots(project, target);
      const fields = edit.assetType === 'characters' ? characterFields : locationFields;
      for (const [key, value] of Object.entries(edit.values)) {
        if (key === 'shotIds') { if (!Array.isArray(value) || value.some(id => !project.shots.some(s => s.id === id))) fail('资产关联镜头不存在'); info.owner.shotIds = value; }
        else if (Object.hasOwn(fields, key)) info.owner[key] = text(value, 5000);
        else fail('不可修改资产字段');
      }
      info.owner.version++; markDependent(project, target);
      for (const id of prior) { const s = findShot(project, id); invalidate(s); for (const v of s.variants) v.promptNeedsSync = true; }
    }
    for (const edit of patch.cellEdits ?? []) editCell(project, edit.target, edit.value, undefined, edit.affectedShotIds);
    for (const refPatch of patch.references ?? []) {
      const ref = project.references.find(r => r.id === refPatch.id);
      if (!ref) fail('参考图不存在');
      const previous = JSON.stringify(ref);
      for (const [key, value] of Object.entries(refPatch)) {
        if (key === 'id') continue;
        if (!['role', 'visualStatus', 'observations', 'usage', 'uncertainties', 'assetIds'].includes(key)) fail('不能改写参考图原件或来源');
        ref[key] = key === 'assetIds' ? tags(value) : text(value);
      }
      if (JSON.stringify(ref) !== previous) for (const shot of project.shots) {
        const selected = shot.variants.find(v => v.id === shot.selectedVariantId);
        if (selected?.referenceIds.includes(ref.id)) invalidate(shot);
      }
    }
    for (const edit of patch.edits ?? []) {
      const shot = findShot(project, edit.shotId);
      if (edit.variantId) editVariant(project, shot, findVariant(shot, edit.variantId), edit.values, true, edit.affectedShotIds);
      else {
        const previousDraft = draftVariant(project, shot)?.id;
        for (const [key, value] of Object.entries(edit.values ?? {})) {
          if (['characters', 'tags'].includes(key)) shot[key] = tags(value);
          else if (key === 'suggestedDuration') { shot[key] = duration(value); shot.durationOrigin = 'director_suggestion'; }
          else if (['scene', 'purpose', 'workingScript', 'displayNumber'].includes(key)) {
            shot[key] = text(value);
            if (key === 'workingScript' || project.workflowMode === 'agent-default' && key === 'scene') markDependent(project, { kind: 'shot', shotId: shot.id, field: key }, true, edit.affectedShotIds);
          }
          else if (key === 'recommendation') shot[key] = value;
          else if (['eventIds', 'dependsOnShotIds'].includes(key) && project.workflowMode === 'agent-default') {
            checkedIds(value, key === 'eventIds' ? project.storyPlan.events.map(e => e.id) : project.shots.map(s => s.id), key);
            shot[key] = value; markDependent(project, { kind: 'shot', shotId: shot.id, field: key });
          }
          else fail(`不可修改镜头字段：${key}`);
        }
        if (Object.keys(edit.values ?? {}).length) shot.editVersion = (shot.editVersion ?? 1) + 1;
        if (project.workflowMode !== 'agent-default' || Object.keys(edit.values ?? {}).some(key => key !== 'recommendation') || previousDraft !== draftVariant(project, shot)?.id) invalidate(shot);
        if (previousDraft !== draftVariant(project, shot)?.id) for (const id of downstreamShots(project, [shot.id])) markShotSync(project, id);
      }
      if (edit.addVariants) {
        for (const v of edit.addVariants) {
          projectShotSchema(project, v);
          if (v.breakdown) {
            const composed = composeStaticPrompt(project, v);
            if (v.staticPrompt !== undefined && v.staticPrompt !== composed) fail('静态Prompt由分镜框架自动生成，请省略或提交一致的派生文本');
            v.staticPrompt = composed;
          }
          validateVariant(v, project);
          if (promptMode(project) === 'static' && v.motionPrompt?.trim()) fail('静态模式不新增视频Prompt');
          if (shot.variants.some(existing => existing.id === v.id)) fail('新增方案ID重复；修改请使用variantId');
          shot.variants.push({ ...v, version: 1, origin: 'director_interpretation' });
        }
        if (project.workflowMode !== 'agent-default') invalidate(shot);
      }
      for (const id of edit.resolveCommentIds ?? []) {
        const c = project.comments.find(c => c.id === id && c.status === 'pending');
        if (!c || c.shotId !== shot.id || c.variantId !== edit.variantId) fail('批注与修订方案不匹配');
        c.status = 'addressed'; c.addressedAt = new Date().toISOString(); c.addressedRevision = project.revision + 1;
      }
    }
    for (const value of patch.sectionEdits ?? []) {
      for (const key of Object.keys(value)) if (!['id', 'category', 'title', 'rationale', 'tags', 'options', 'shotIds', 'variantId', 'prompts', 'assetIds'].includes(key)) fail(`不可修改分类字段：${key}`);
      const sections = project.promptSections ??= [];
      const existing = sections.find(s => s.id === value.id);
      const section = { ...existing, ...value, version: (existing?.version ?? 0) + 1, origin: 'director_interpretation' };
      if (value.prompts) section.promptNeedsSync = false;
      validateSection(section, project);
      if (existing) sections[sections.indexOf(existing)] = section; else sections.push(section);
      for (const affected of [existing, section].filter(Boolean)) for (const id of affected.shotIds) { const s = findShot(project, id); if (s.variants.length && (!s.selectedVariantId || sectionApplies(affected, id, s.selectedVariantId))) invalidate(s); }
    }
    for (const id of patch.resolveRequestIds ?? []) {
      const request = project.generationRequests?.find(r => r.id === id && r.status === 'pending');
      if (!request) fail('生成需求不存在或已处理');
      const targeted = ['frame', 'camera', 'production'].includes(request.category)
        ? patch.edits?.some(e => e.shotId === request.shotId && (request.variantId ? e.variantId === request.variantId : e.addVariants?.length) && (request.category !== 'production' || (request.variantId ? e.values?.breakdown && hasSyncedPrompts(project, e.values) : e.addVariants?.every(v => v.breakdown && hasSyncedPrompts(project, v)))))
        : patch.sectionEdits?.some(e => { const s = project.promptSections.find(s => s.id === e.id); return s.category === request.category && sectionApplies(s, request.shotId, request.variantId) && (!request.sectionId || request.sectionId === e.id); });
      if (!targeted) fail('生成需求与修订目标不匹配');
      request.status = 'addressed'; request.addressedRevision = project.revision + 1;
    }
    for (const response of patch.commentResponses ?? []) {
      const c = project.comments.find(c => c.id === response.id && c.target && c.status === 'pending');
      if (!c) fail('单元格批注不存在或已处理');
      const before = commentValues.get(c.id), after = String(cellInfo(project, c.target).value);
      if (before === after && response.unchanged !== true) fail('批注目标字段未修改；保留原值需明确说明');
      c.reply = text(response.text, 5000); if (!c.reply.trim()) fail('批注回应不能为空');
      c.before = before; c.after = after; c.status = 'addressed'; c.addressedAt = new Date().toISOString(); c.addressedRevision = project.revision + 1;
    }
  });
}
const escapeTable = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
export function exportProject(directory, project = loadProject(directory)) {
  project = refreshStaticPrompts(structuredClone(project));
  const output = path.join(directory, 'exports');
  fs.mkdirSync(output, { recursive: true });
  const header = [`# ${project.title}`, '', `派生自 project.json revision ${project.revision}；请勿直接修改本导出代替项目状态。`, '',
    `画幅：${project.aspectRatio}；目标约 ${project.targetDuration ?? '待确认'} 秒。`, `标签：${project.tags.join('、')}`, '',
    '## 待核对项', ...project.reviewIssues.map(i => `- [${i.resolved ? 'x' : ' '}] ${i.text}${i.resolution ? '；' + i.resolution : ''}`), '',
    '## 原稿与导演对照', '', '| 镜号 | 建议秒数 | 原稿 | 工作稿 | 导演目的 | 选择 | 状态 |', '|---|---|---|---|---|---|---|'];
  if (project.brief) header.splice(4, 0, `目标：${project.brief.purpose}；交付：${project.brief.deliverables}；分辨率：${project.brief.resolution}；风格：${project.brief.style}`);
  for (const s of project.shots) {
    const original = [s.original, ...(s.originalFields || []).map(f => `${f.name}（${f.cell}）：${f.value}`)].join('\n');
    header.push(`| ${escapeTable(s.displayNumber ?? s.sourceNumber)} (${s.id}) | ${s.suggestedDuration ?? '待规划'} | ${escapeTable(original)} | ${escapeTable(s.workingScript ?? s.original)} | ${escapeTable(s.purpose)} | ${s.selectedVariantId ?? '待选择'} | ${s.status} |`);
  }
  if (project.storyPlan) {
    header.push('', '## 全片事件与连续性计划', `计划版本：${project.storyPlan.version}；原稿：${project.source.originalName}；SHA256 ${project.source.sha256}`, project.storyPlan.notes);
    for (const event of project.storyPlan.events) header.push('', `### ${event.id} v${event.version} · ${event.description}`,
      `依据：${{ source: '原稿事实', user: '用户补充', proposal: '导演提案', unknown: '待定' }[event.basis]}；叙事信息：${event.information}`,
      `关联镜头：${project.shots.filter(s => s.eventIds.includes(event.id)).map(s => s.id).join('、')}`,
      ...(event.sourceRef ? [`原文第${event.sourceRef.startLine}–${event.sourceRef.endLine}行：${event.sourceRef.quote}`] : []),
      ...event.stateChanges.map(c => `- ${c.entityId} / ${c.field}：${c.before} → ${c.after}`));
    header.push('', '镜头依赖：', ...project.shots.map(s => `- ${s.id}：${s.dependsOnShotIds.join('、') || '无前镜依赖'}`));
  }
  if (project.productionConstraints) header.push('', '## 项目拍摄约束', ...Object.entries(constraintFields).map(([key, label]) => `- ${label}：${project.productionConstraints[key]}`));
  if (project.productionInventory) {
    const inventory = project.productionInventory;
    header.push('', `## 角色与场景清单（${inventory.characters.length}个角色 / ${inventory.locations.length}个场景分组）`, inventory.notes);
    for (const kind of ['characters', 'locations']) for (const entry of inventory[kind]) header.push('', `### ${entry.name} (${entry.id} v${entry.version})`, `关联：${entry.shotIds?.join('、') ?? '旧项目关联待登记'}`, ...Object.entries(kind === 'characters' ? characterFields : locationFields).filter(([key]) => key !== 'name').map(([key, label]) => `- ${label}：${entry[key] ?? '待询问/填写'}`));
  }
  header.push('', '## 固定分镜框架', '', '采用用户选定方案；未选择时显示Agent推荐方案，推荐不等于用户已采用。', '', '| 镜号 / 方案 | 镜头内容 | 景别、拍摄参数 | 构图与空间层次 | 光影、色调 | 姿态与表情 | 角色描述 | 场景描述 | 材质与画面质感 | 推荐理由 |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const s of project.shots) {
    const v = draftVariant(project, s) || (project.workflowMode === 'agent-default' ? undefined : s.variants.find(v => v.id === s.recommendation?.variantId) || s.variants[0]), b = v?.breakdown;
    const camera = b ? formatCamera(project, b.camera) : '待Agent填写';
    header.push(`| ${s.id} / ${v?.id ?? '待规划'} | ${escapeTable(b?.content)} | ${escapeTable(camera)} | ${escapeTable(b?.composition)} | ${escapeTable(b?.lighting)} | ${escapeTable(b?.pose)} | ${escapeTable(b?.characters)} | ${escapeTable(b?.scene)} | ${escapeTable(b?.texture)} | ${escapeTable(s.recommendation?.reason)} |`);
  }
  const selected = ['# 选定 Prompt', '', `revision ${project.revision}；选定不等于已确认，状态见各镜头。`, ''];
  const currentDraft = [`# ${project.title} — 当前草案`, '', `revision ${project.revision}；用户选择优先，否则使用Agent默认方案。默认方案不等于用户选择或确认。`, ''];
  for (const s of project.shots) {
    for (const v of s.variants) {
      const lines = [`## ${s.id} / ${v.id} ${v.title}`, '', `方案版本：${v.version}；标签：${v.tags.join('、')}`, `理由：${v.rationale}`, '', v.description, '',
        ...(v.tagGroups ?? []).map(g => `主Tag：${categoryNames[g.category]}；子Tag：${g.tags.join('、')}；依据：${g.reason}`), '',
        '### 静帧 Prompt', v.staticPrompt, '', ...(promptMode(project) === 'static' ? [] : ['### 动作 Prompt', v.motionPrompt, '']), '### 约束', ...[...project.sharedConstraints, ...v.constraints].map(c => '- ' + c),
        '', '### 参考图', ...v.referenceIds.map(id => { const r = project.references.find(r => r.id === id); return `![${id} ${r.label}](../${r.path})`; }), ''];
      header.push(...lines);
      if (s.selectedVariantId === v.id) selected.push(`状态：${s.status}；建议 ${s.suggestedDuration ?? '待确认'} 秒。`, ...lines);
      if (draftVariant(project, s)?.id === v.id) currentDraft.push(`状态：${variantStatus(project, s, v)}${v.promptNeedsSync ? '；待同步' : ''}；建议 ${s.suggestedDuration ?? '待确认'} 秒。`, ...lines);
      if (v.breakdown) {
        const b = v.breakdown;
        const framework = ['### 分镜框架与拍摄建议', `镜头内容：${b.content}`, formatCamera(project, b.camera), ...Object.entries(staticFields).map(([key, label]) => `${label}：${b[key] ?? (project.staticPromptFormat === 'concise-v1' ? '' : '待填写')}`), `光影色调：${b.lighting}`, `角色描述：${b.characters}`, `场景描述：${b.scene}`, ...(b.continuity ? [`连续性与限制：${b.continuity}`] : []), `取舍：${b.decision}`, `框架与Prompt同步：${v.promptNeedsSync ? '待同步核对' : '当前版本已填写，仍待用户审核'}`, ''];
        header.push(...framework);
        if (s.selectedVariantId === v.id) selected.push(...framework);
      }
    }
  }
  const pending = ['# 待处理批注', '', `revision ${project.revision}；由 Agent 读取批注并用定向 patch 修改。`, ''];
  for (const c of project.comments) {
    const lines = c.target ? [`## ${cellInfo(project, c.target).label} / ${c.target.field}`, `批注ID：${c.id}；${c.groupId ? '范围组：' + c.groupId + '；' : ''}状态：${c.status}；内容版本：${c.contentVersion}；基线：${c.baseRevision}`, `提交时原文：${c.originalText}`, c.text, ...(c.reply ? [`回应：${c.reply}`, `修改前：${c.before}`, `修改后：${c.after}`] : []), ''] : [`## ${c.shotId} / ${c.variantId} v${c.variantVersion}`, `批注ID：${c.id}；状态：${c.status}`, `类型：${c.category}`, '', c.text, ''];
    header.push(...lines); if (c.status === 'pending') pending.push(...lines);
  }
  pending.push('## 待同步内容', ...pendingProject(project).needsSync.map(item => '- ' + JSON.stringify(item)), '');
  for (const section of project.promptSections ?? []) {
    const lines = [`## ${categoryNames[section.category]} / ${section.title}`, `内容ID：${section.id}；v${section.version}；适用镜头：${section.shotIds.join('、')}${section.variantId ? '；拍法：' + section.variantId : ''}`, `子Tag：${section.tags.join('、')}`, `依据与边界：${section.rationale}`, '', ...section.prompts.flatMap(p => [`### ${p.label}`, p.text, ''])];
    header.push(...lines);
    if (section.shotIds.some(id => { const v = findShot(project, id).selectedVariantId; return v && sectionApplies(section, id, v); })) selected.push(...lines);
    if (!section.variantId || section.shotIds.every(id => draftVariant(project, findShot(project, id))?.id === section.variantId)) currentDraft.push(...lines);
  }
  for (const r of (project.generationRequests ?? []).filter(r => r.status === 'pending')) pending.push(`## ${r.shotId} / ${categoryNames[r.category]} 生成需求`, `需求ID：${r.id}；方案：${r.variantId ?? '无'}；内容：${r.sectionId ?? '新内容'}；基线版本：${r.contentVersion ?? '无'}`, `子Tag：${r.tags.join('、')}`, '', r.text || '按照原稿及所选子Tag生成或修订本类内容。', '');
  const staticPrompts = [`# ${project.title} — 全部静态生图 Prompt`, '', `revision ${project.revision}；包含全部拍法，不以用户选择作为展示条件。`,
    '本导出只有 Prompt，未生成图片；未确认方案仍需用户审核。补充静帧属于对应拍法，不是互斥候选，也不另加镜头时长。',
    `画幅：${project.aspectRatio}；分辨率：${project.brief?.resolution || '待确认'}。`, '', '## 镜号静态 Prompt', ''];
  for (const shot of project.shots) {
    staticPrompts.push(`### 镜 ${shot.displayNumber ?? shot.sourceNumber}（${shot.sourceNumber == null ? '导演拆镜编号' : '原镜号 ' + shot.sourceNumber} / ${shot.id}）`, '', `工作稿：${shot.workingScript ?? shot.original}`, '');
    if (!shot.variants.length) staticPrompts.push('静态 Prompt 待补齐。', '');
    for (const variant of shot.variants) {
      const approved = shot.selectedVariantId === variant.id && shot.approval?.variantId === variant.id && shot.approval.variantVersion === variant.version;
      staticPrompts.push(`#### 拍法 ${variant.id} · ${variant.title}（v${variant.version}）`, `状态：${project.workflowMode === 'agent-default' ? variantStatus(project, shot, variant) : approved ? '用户已确认' : shot.selectedVariantId === variant.id ? '已选择，未确认当前版本' : '未采用／未确认'}${variant.promptNeedsSync ? '；待同步' : ''}`, '', '主静帧：', variant.staticPrompt, '');
      for (const section of (project.promptSections ?? []).filter(s => s.category === 'shotFrames' && sectionApplies(s, shot.id, variant.id))) {
        staticPrompts.push(`补充静帧：${section.title}（${section.id} v${section.version}${section.promptNeedsSync ? '；待同步' : ''}）`, `依据与边界：${section.rationale}`, '');
        for (const p of section.prompts) staticPrompts.push(`- ${p.label}`, '', p.text, '');
      }
      staticPrompts.push('生图约束：', ...[...project.sharedConstraints, ...variant.constraints].map(c => '- ' + c), '');
    }
  }
  staticPrompts.push('## 场景静态 Prompt', '', '以下场景多视角为独立图片 Prompt；沿用同一空间布局，不与叙事镜头相加。', '');
  const sceneSections = (project.promptSections ?? []).filter(s => s.category === 'sceneViews');
  if (!sceneSections.length) staticPrompts.push('场景静态 Prompt 待补齐。', '');
  for (const section of sceneSections) {
    staticPrompts.push(`### ${section.title}（${section.id} v${section.version}）`, `关联镜号：${section.shotIds.map(id => { const s = findShot(project, id); return `${s.displayNumber ?? s.sourceNumber}（${id}）`; }).join('、')}；${section.promptNeedsSync ? '待同步' : '待用户核对'}`, `依据与边界：${section.rationale}`, '');
    for (const p of section.prompts) staticPrompts.push(`#### ${p.label}`, p.text, '');
  }
  for (const [name, lines] of [['storyboard.md', header], ['selected-prompts.md', selected], ['pending-comments.md', pending], ['static-prompts.md', staticPrompts]]) fs.writeFileSync(path.join(output, name), lines.join('\n') + '\n', 'utf8');
  if (project.workflowMode === 'agent-default') fs.writeFileSync(path.join(output, 'current-draft.md'), currentDraft.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(output, 'project.json'), JSON.stringify(project, null, 2) + '\n', 'utf8');
  const batch = project.imageBatches?.at(-1);
  if (batch) {
    fs.writeFileSync(path.join(output, 'libtv-batch.json'), JSON.stringify(batch, null, 2) + '\n', 'utf8');
    const lines = ['# LibTV 静态图片提交准备清单', '', `清单：${batch.id}；源版本：${batch.sourceRevision}；状态：${batch.status === 'stale' ? '待重新核对' : '已准备'}。`,
      '尚未提交，也不代表已授权生图。执行前确定模型、每镜数量、目标画布和实际输出规格。', `交付目标：${batch.aspectRatio} / ${batch.resolution ?? '待确定'}`, '',
      ...batch.items.flatMap(item => [`## ${item.shotId} / ${item.variantId} v${item.variantVersion}`, '', item.staticPrompt, '',
        '人物资产：' + (item.characterAssets.map(a => `${a.name} (${a.id} v${a.version})`).join('、') || '无'),
        ...(item.characterMappingStatus === 'needs_review' ? [item.characterMappingNote, '待核对候选：' + item.candidateCharacterAssets.map(a => a.name).join('、')] : []),
        ...item.characterReferences.map(r => `- ${r.name}：${r.note}`), ...item.constraints.map(c => '- ' + c),
        ...item.references.map(r => `- 附件：${r.id} / ${r.path} / SHA256 ${r.sha256}；用途：${r.usage}`),
        ...item.excludedReferences.map(r => `- 未提交附件：${r.id}；${r.reason}`), '',
        ...(item.additionalFrames ?? []).flatMap(f => [`### 补充静帧：${f.label}（${f.sectionId} v${f.version}）`, f.text, '资产：' + (f.assets.map(a => `${a.name} (${a.id} v${a.version})`).join('、') || '无／待核对'), f.referenceNote, ''])])];
    fs.writeFileSync(path.join(output, 'libtv-batch.md'), lines.join('\n') + '\n', 'utf8');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, directory, patchFile, planFile] = process.argv.slice(2);
    if (!directory) fail('用法：node project.mjs export|apply|pending|prepare-batch <项目目录> [patch.json|镜头ID,镜头ID]；或 init-story <项目目录> <原文.txt|md> <计划.json>');
    if (command === 'export') exportProject(directory);
    else if (command === 'apply') applyAgentPatch(directory, JSON.parse(fs.readFileSync(patchFile, 'utf8')));
    else if (command === 'pending') console.log(JSON.stringify(pendingProject(loadProject(directory)), null, 2));
    else if (command === 'init-story') {
      if (!patchFile || !planFile) fail('init-story 需要原文文件和Agent创作计划JSON');
      const project = initializeStoryProject(directory, patchFile, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(planFile))));
      console.log(JSON.stringify({ projectId: project.projectId, revision: project.revision, shots: project.shots.length, events: project.storyPlan.events.length, workflowMode: project.workflowMode, status: 'draft_not_approved' }, null, 2));
    }
    else if (command === 'prepare-batch') {
      if (!patchFile) fail('prepare-batch 需要逗号分隔的镜头ID');
      const project = applyAction(directory, { baseRevision: loadProject(directory).revision, type: 'prepare-image-batch', shotIds: patchFile.split(',').map(s => s.trim()) });
      console.log(JSON.stringify(project.imageBatches.at(-1), null, 2));
    }
    else fail('未知命令');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
