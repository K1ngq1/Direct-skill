import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkShotSchema } from './project.mjs';
import { loadRuleSnapshot, assertRuntimeCapabilities } from './runtime.mjs';

export const contract = JSON.parse(fs.readFileSync(new URL('../schemas/visual-plan-v2.json', import.meta.url), 'utf8'));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const records = value => list(value).filter(object);
const text = value => typeof value === 'string' && Boolean(value.trim());
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
export const issue = (category, code, field, message, requirement, entityId = null, severity = 'error') => ({ category, code, path: field, entityId, severity, message, requirement });

export function assetPlanHash(plan, kind) {
  const assets = records(plan.productionInventory?.[kind]), assetIds = assets.map(item => item.id);
  const references = records(plan.references).filter(item => assetIds.includes(item.assetId) || records(plan.shots).some(shot => kind === 'characters'
    ? records(shot.shotSchema?.subjects).some(subject => assetIds.includes(subject.assetId) && list(subject.referenceIds).includes(item.id))
    : assetIds.includes(shot.locationId) && list(shot.shotSchema?.referenceIds).includes(item.id)));
  return digest({ projectId: plan.projectId, sourceSha256: plan.sourceSha256, rules: plan.rules, spec: plan.spec, assets, references });
}

export function sourceHashV2(project, plan, shot, visited = new Set()) {
  if (visited.has(shot.id)) throw new Error('镜头依赖存在环');
  const next = new Set([...visited, shot.id]);
  const subjectIds = records(shot.shotSchema?.subjects).map(item => item.assetId);
  const propIds = records(shot.shotSchema?.props).map(item => item.id);
  const referenceIds = new Set([...list(shot.shotSchema?.referenceIds), ...records(shot.shotSchema?.subjects).flatMap(item => list(item.referenceIds)), ...records(shot.shotSchema?.props).flatMap(item => list(item.referenceIds))]);
  const dependencies = [...new Set([...list(shot.transition?.fromShotIds), ...(shot.reuseOf ? [shot.reuseOf] : [])])];
  return digest({
    projectId: plan.projectId, source: project.source, rules: plan.rules, rubricVersion: plan.rubricVersion, spec: plan.spec,
    originals: list(shot.sourceShotIds).map(value => project.shots.find(item => item.id === value)),
    characters: records(plan.productionInventory?.characters).filter(item => subjectIds.includes(item.id)),
    location: records(plan.productionInventory?.locations).find(item => item.id === shot.locationId),
    props: records(plan.props).filter(item => propIds.includes(item.id)), references: records(plan.references).filter(item => referenceIds.has(item.id)),
    shot: Object.fromEntries(['id', 'sourceShotIds', ...contract.shotEditable.filter(key => !['prompt', 'review', 'semanticReview'].includes(key))].map(key => [key, shot[key]])),
    dependencies: dependencies.map(value => {
      const upstream = records(plan.shots).find(item => item.id === value);
      return { id: value, sourceHash: upstream ? sourceHashV2(project, plan, upstream, next) : null, text: upstream?.prompt?.text };
    })
  });
}

export function summarize(issues, plan = null) {
  const status = rows => rows.some(row => row.severity === 'error') ? 'invalid' : rows.length ? 'pending' : 'passed';
  return {
    valid: !issues.length, status: status(issues), issues,
    shots: list(plan?.shots).filter(object).map(shot => {
      const own = issues.filter(row => row.entityId === shot.id || row.entityId === null);
      return { id: shot.id, status: status(own), issues: own, scoreValid: Boolean(shot.review) && !own.some(row => row.severity === 'error' || ['RULES_STALE', 'SCORE_STALE', 'SCORE_INVALID', 'UNREVIEWED_DEPENDENCY'].includes(row.code)) };
    }),
    execution: { hardValidation: 'executed', nodeVersion: process.version, checkedAt: new Date().toISOString(), semanticMeaning: '记录核对，不代表程序理解画面或用户确认' }
  };
}

export function inspectV2(directory, project, plan, { sealed = true, checkReview, checkGeneratedReference, validateLocalImage } = {}) {
  const issues = [];
  const add = (category, code, field, message, requirement, entity = null, severity = 'error') => issues.push(issue(category, code, field, message, requirement, entity, severity));
  const pending = (code, field, message, entity = null, requirement = '核对具体依据，记录结果；不要伪造已确认状态。') => add('semantic', code, field, message, requirement, entity, 'pending');
  function fields(value, name, field, entity = null) {
    if (!object(value)) { add('structure', 'OBJECT_REQUIRED', field, '须为对象', '提供合同规定的对象。', entity); return false; }
    for (const key of Object.keys(value)) if (!Object.hasOwn(contract[name], key)) add('structure', 'UNKNOWN_FIELD', `${field}.${key}`, '未定义字段', '按字段合同更正；不要静默忽略模型输出。', entity);
    for (const [key, rule] of Object.entries(contract[name])) {
      const optional = rule.endsWith('?'), type = optional ? rule.slice(0, -1) : rule, item = value[key];
      if (optional && item === undefined) continue;
      const valid = ({ text, id, sha256: sha, array: Array.isArray, object,
        positiveInteger: v => Number.isInteger(v) && v > 0,
        nonnegativeInteger: v => Number.isInteger(v) && v >= 0,
        positiveNumber: v => typeof v === 'number' && Number.isFinite(v) && v > 0,
        nullableId: v => v === null || id(v), nullableObject: v => v === null || object(v), nullableText: v => v === null || text(v),
        '2': v => v === 2, 'visual-excel-v2': v => v === 'visual-excel-v2', 'visual-v2': v => v === 'visual-v2'
      })[type];
      if (!valid?.(item)) add('structure', 'FIELD_TYPE', `${field}.${key}`, `字段须为 ${type}`, '按字段合同补齐或更正类型。', entity);
    }
    return true;
  }
  const duplicates = (values, field, entity = null) => {
    const seen = new Set();
    for (const value of values) { if (seen.has(value)) add('reference', 'DUPLICATE_ID', field, `重复 ID：${value}`, '保留稳定身份并消解重复条目。', entity); seen.add(value); }
  };
  const refs = (values, allowed, field, entity = null) => {
    if (!Array.isArray(values)) { add('structure', 'ARRAY_REQUIRED', field, '须为数组', '使用明确 ID 数组；无人/无参考时写空数组。', entity); return; }
    duplicates(values, field, entity);
    for (const value of values) if (!allowed.includes(value)) add('reference', 'UNKNOWN_REFERENCE', field, `引用不存在或顺序无效：${value}`, '引用已登记且符合前后顺序的 ID。', entity);
  };
  if (!fields(plan, 'plan', '$')) return summarize(issues, plan);
  fields(plan.run, 'run', '$.run'); fields(plan.spec, 'spec', '$.spec');
  const originals = list(project.shots).map(item => item.id);
  if (plan.sourceSha256 !== project.source?.sha256) add('source', 'SOURCE_MISMATCH', '$.sourceSha256', '计划与归档原稿不一致', '读取正确原稿重新核对，不能改归档来匹配旧稿。');
  try {
    const current = loadRuleSnapshot();
    if (digest(plan.rules) !== digest(current)) pending('RULES_STALE', '$.rules', '规则快照缺失或与当前共用规则不一致', null, '通过 revise 的 refreshRules 刷新规则；重新核对受影响内容。');
  } catch (error) { add('runtime', 'RULES_UNAVAILABLE', '$.rules', error.message, '恢复缺失规则或依赖后重新运行，不由模型声称已加载。'); }
  if (!text(plan.run?.platform) || !(plan.run?.model === null || text(plan.run?.model))) add('structure', 'RUN_METADATA', '$.run', '须记录实际宿主和可见模型标识；未知模型用 null', '填写 platform、model，不把配置名称当成已验证模型能力。');
  try { assertRuntimeCapabilities(plan.run); }
  catch (error) { issues.push(error.issue); }
  const failureResolutions = list(plan.run?.failureResolutions), failures = list(plan.run?.failures);
  const resolved = new Set();
  for (const resolution of failureResolutions) {
    fields(resolution, 'failureResolution', '$.run.failureResolutions');
    if (!Number.isInteger(resolution?.failureIndex) || resolution.failureIndex < 0 || resolution.failureIndex >= failures.length || !text(resolution.reason) || !/^\d{4}-\d{2}-\d{2}T/u.test(resolution.resolvedAt ?? '') || !Number.isFinite(Date.parse(resolution.resolvedAt)) || resolved.has(resolution.failureIndex)) add('structure', 'FAILURE_RESOLUTION_INVALID', '$.run.failureResolutions', '失败解决记录须唯一引用已有失败，并记录理由和有效时间', '保留失败原文，追加实际恢复结果。');
    else resolved.add(resolution.failureIndex);
  }
  for (const [index, failure] of failures.entries()) {
    if (resolved.has(index)) continue;
    const category = contract.issueCategories.includes(failure?.category) ? failure.category : 'unknown';
    add(category, 'HOST_FAILURE', '$.run.failures', failure?.message || '宿主报告失败，原因未知', '保留原始错误；恢复工具或网络后另行记录结果。', null, 'pending');
  }
  for (const key of ['aspectRatio', 'resolution', 'style']) if (!text(plan.spec?.[key])) add('structure', 'SPEC_REQUIRED', `$.spec.${key}`, '规格字段缺失', '记录本次明确规格或导演设计。');
  if (!Array.isArray(plan.designNotes) || plan.designNotes.some(value => !text(value))) add('structure', 'DESIGN_NOTES', '$.designNotes', '须为文本数组', '设定依据独立保存。');
  const provenance = (rows, required, field, entity) => {
    const seen = [];
    for (const row of list(rows)) {
      if (!fields(row, 'provenance', field, entity)) continue;
      seen.push(row.field);
      if (!contract.provenanceKinds.includes(row.kind)) add('structure', 'PROVENANCE_KIND', `${field}.kind`, '依据类型无效', '使用 source/user/director/unknown。', entity);
      refs(row.sourceShotIds, originals, `${field}.sourceShotIds`, entity);
      if (row.kind === 'source' && !row.sourceShotIds?.length) add('source', 'SOURCE_LOCATION_REQUIRED', field, '原文事实缺少源镜定位', '绑定实际源镜，其单元格/行号沿用归档。', entity);
      if (row.kind === 'unknown') pending('UNKNOWN_FACT', field, `待确认：${row.basis}`, entity);
    }
    duplicates(seen, field, entity);
    for (const value of required) if (!seen.includes(value)) add('source', 'PROVENANCE_REQUIRED', field, `缺少 ${value} 的依据`, '分别记录原文事实、用户确认、导演补全和未知项。', entity);
  };
  const entities = [];
  for (const kind of ['characters', 'locations']) {
    const rows = plan.productionInventory?.[kind];
    if (!Array.isArray(rows)) add('structure', 'ASSETS_REQUIRED', `$.productionInventory.${kind}`, '资产清单缺失', '使用数组登记稳定 ID。');
    duplicates(list(rows).map(item => item?.name), `$.productionInventory.${kind}.name`);
    list(rows).forEach(item => { if (fields(item, 'asset', `$.productionInventory.${kind}`, null)) { entities.push(item.id); provenance(item.provenance, contract.assetProvenanceFields, `$.productionInventory.${kind}.${item.id}.provenance`, null); } });
  }
  list(plan.props).forEach(item => { if (fields(item, 'prop', '$.props')) { entities.push(item.id); provenance(item.provenance, contract.assetProvenanceFields, `$.props.${item.id}.provenance`, null); } });
  duplicates(entities, '$.productionInventory');
  duplicates(list(plan.references).map(item => item?.id), '$.references');
  for (const reference of list(plan.references)) {
    if (!object(reference) || !id(reference.id) || !text(reference.purpose)) { add('structure', 'REFERENCE_REQUIRED', '$.references', '参考须有 ID 与实际用途', '登记实际附件，不虚构引用。'); continue; }
    try {
      if (reference.assetId !== undefined && !entities.includes(reference.assetId)) throw new Error('参考绑定的资产不存在');
      if (reference.origin === 'generated-confirmed') checkGeneratedReference(directory, plan, reference);
      else {
        const archived = list(project.references).find(item => item.id === reference.id);
        if (!archived || reference.userProvided !== true || (reference.origin && reference.origin !== 'user-provided')) throw new Error('参考不属于本次用户附件');
        if (reference.path !== archived.path || reference.sha256 !== archived.sha256 || reference.url !== archived.url) throw new Error('参考路径/哈希/URL与归档不一致');
        if (archived.path) validateLocalImage(directory, archived);
        else pending('REFERENCE_NOT_LOCAL', `$.references.${reference.id}`, '远程附件未进行本地可读性与图像理解核验');
      }
    } catch (error) { add('reference', 'REFERENCE_INVALID', `$.references.${reference.id}`, error.message, '恢复实际文件及正确用途/确认记录，不靠改 ID 伪造绑定。'); }
  }
  const sourceIssues = list(project.reviewIssues);
  const resolutions = list(plan.sourceResolutions);
  duplicates(resolutions.map(row => row?.issueId), '$.sourceResolutions');
  for (const row of resolutions) if (!sourceIssues.some(item => item.id === row?.issueId) || !['resolved', 'excluded'].includes(row?.decision) || !text(row?.reason)) add('source', 'SOURCE_RESOLUTION_INVALID', '$.sourceResolutions', '来源问题处理记录无效', '引用归档问题 ID 并记录解决或明确排除的理由。');
  for (const row of sourceIssues) if (row.resolved !== true && !resolutions.some(item => item?.issueId === row.id)) pending('SOURCE_UNRESOLVED', '$.sourceResolutions', `原稿问题未处理：${row.id ?? '无ID'} ${row.text ?? row.message ?? row.description ?? row.type ?? ''}`);
  if (list(plan.repairAttempts).length > 2) add('structure', 'REPAIR_LIMIT', '$.repairAttempts', '自动修复不得超过两轮', '停止自动修复并保留待处理项。');
  for (const [index, attempt] of list(plan.repairAttempts).entries()) if (!object(attempt) || attempt.round !== index + 1 || !['applied', 'rejected'].includes(attempt.status) || !sha(attempt.requestHash) || !text(attempt.reason)) add('structure', 'REPAIR_RECORD_INVALID', `$.repairAttempts.${index}`, '修复记录无效', '修复记录由程序生成，不手改次数或结果。');
  if (list(plan.changes).at(-1)?.accepted === false) pending('REPAIR_REJECTED', '$.repairAttempts', '最近一次修复未通过，原始内容与失败请求已保留');
  const covered = new Set(), earlier = [];
  if (!list(plan.shots).length) add('structure', 'SHOTS_REQUIRED', '$.shots', '至少需要一镜', '保留完整原稿覆盖关系。');
  duplicates(list(plan.shots).map(row => row?.id), '$.shots');
  for (const shot of list(plan.shots)) {
    const entity = id(shot?.id) ? shot.id : null, field = `$.shots.${entity ?? '?'}`;
    if (!fields(shot, 'shot', field, entity)) continue;
    fields(shot.prompt, 'prompt', `${field}.prompt`, entity); fields(shot.transition, 'transition', `${field}.transition`, entity); fields(shot.selection, 'selection', `${field}.selection`, entity);
    for (const key of Object.keys(object(shot.dimensions) ? shot.dimensions : {})) if (!contract.dimensions.includes(key)) add('structure', 'UNKNOWN_FIELD', `${field}.dimensions.${key}`, '未定义画面维度', '使用当前十一维字段。', entity);
    refs(shot.sourceShotIds, originals, `${field}.sourceShotIds`, entity);
    if (!list(shot.sourceShotIds).length) add('source', 'SOURCE_REQUIRED', `${field}.sourceShotIds`, '镜头必须关联原稿', '拆镜保留同源 ID；合镜保留多个源 ID。', entity);
    list(shot.sourceShotIds).forEach(value => covered.add(value));
    if (!records(plan.productionInventory?.locations).some(row => row.id === shot.locationId)) add('reference', 'LOCATION_UNKNOWN', `${field}.locationId`, '场景未登记', '引用同一项目的场景 ID。', entity);
    for (const key of contract.dimensions) if (!text(shot.dimensions?.[key])) add('structure', 'DIMENSION_REQUIRED', `${field}.dimensions.${key}`, '必需画面信息缺失', '补充本镜可见要求；不适用时明确原因。', entity);
    fields(shot.optics, 'optics', `${field}.optics`, entity);
    if (object(shot.optics) && text(shot.prompt?.text)) {
      for (const token of [`${shot.optics.focalLengthMm}mm`, `f/${shot.optics.aperture}`]) if (!shot.prompt.text.replace(/\s+/g, '').toLowerCase().includes(token.toLowerCase())) pending('OPTICS_TEXT_MISMATCH', `${field}.prompt.text`, `正文未包含当前摄影要求 ${token}`, entity, '自然写入本镜焦距、光圈和清晰范围；不得冒充实拍参数。');
    }
    provenance(shot.provenance, contract.shotProvenanceFields, `${field}.provenance`, entity);
    try { checkShotSchema(shot.shotSchema, plan); } catch (error) { add('reference', 'SHOT_SCHEMA_INVALID', `${field}.shotSchema`, error.message, '按具体人物、持物和关系 ID 修复本镜结构。', entity); }
    const naKeys = new Set();
    for (const subject of list(shot.shotSchema?.subjects)) {
      for (const key of contract.subjectRequired) if (!text(subject?.[key])) add('structure', 'SUBJECT_REQUIRED', `${field}.shotSchema.subjects.${subject?.assetId}.${key}`, '人物必要可见状态缺失', '逐人记录位置、朝向、姿态和可见部位。', entity);
      for (const key of contract.subjectConditional) {
        const na = `subjects.${subject?.assetId}.${key}`; naKeys.add(na);
        if (!text(subject?.[key]) && !text(shot.notApplicable?.[na])) add('structure', 'SUBJECT_APPLICABILITY', `${field}.shotSchema.${na}`, '缺少描述或不适用理由', '可见则写清；不可见或参考已确定则在 notApplicable 记录依据。', entity);
      }
      for (const refId of list(subject?.referenceIds)) {
        const reference = records(plan.references).find(row => row.id === refId);
        if (reference?.assetId && reference.assetId !== subject.assetId) add('reference', 'SUBJECT_REFERENCE_MISMATCH', `${field}.shotSchema.subjects.${subject.assetId}.referenceIds`, '角色图片错绑', '绑定该角色实际确认的身份图。', entity);
      }
    }
    for (const refId of list(shot.shotSchema?.referenceIds)) {
      const reference = records(plan.references).find(row => row.id === refId);
      if (reference?.assetId && reference.assetId !== shot.locationId && !records(shot.shotSchema?.subjects).some(subject => subject.assetId === reference.assetId && list(subject.referenceIds).includes(refId))) add('reference', 'SCENE_REFERENCE_MISMATCH', `${field}.shotSchema.referenceIds`, '场景参考或角色通用参考映射不一致', '场景参考绑定本镜场景，角色参考同时绑定对应入镜人物。', entity);
    }
    for (const [key, value] of Object.entries(object(shot.notApplicable) ? shot.notApplicable : {})) if (!naKeys.has(key) || !text(value)) add('structure', 'NOT_APPLICABLE_INVALID', `${field}.notApplicable.${key}`, '不适用记录无效', '只针对本镜人物的条件字段填写具体理由。', entity);
    for (const prop of list(shot.shotSchema?.props)) {
      if (!records(plan.props).some(row => row.id === prop?.id && row.name === prop?.name)) add('reference', 'PROP_UNKNOWN', `${field}.shotSchema.props`, '道具未登记或名称不匹配', '使用本项目稳定道具 ID 和名称。', entity);
      for (const key of ['state', 'position']) if (!text(prop?.[key])) add('structure', 'PROP_STATE_REQUIRED', `${field}.shotSchema.props.${prop?.id}.${key}`, '道具状态/位置缺失', '写清当前状态、位置与持有者。', entity);
      for (const refId of list(prop?.referenceIds)) {
        const reference = records(plan.references).find(row => row.id === refId);
        if (reference?.assetId && reference.assetId !== prop.id) add('reference', 'PROP_REFERENCE_MISMATCH', `${field}.shotSchema.props.${prop.id}.referenceIds`, '道具参考资产映射不一致', '绑定该道具的实际附件。', entity);
      }
    }
    refs(shot.transition?.fromShotIds, earlier, `${field}.transition.fromShotIds`, entity);
    for (const key of ['entry', 'exit', 'cut']) if (!text(shot.transition?.[key])) add('structure', 'TRANSITION_REQUIRED', `${field}.transition.${key}`, '连续性信息缺失', '记录进入、结束状态和切换依据。', entity);
    if (shot.reuseOf !== null) {
      if (!earlier.includes(shot.reuseOf)) add('reference', 'REUSE_ORDER', `${field}.reuseOf`, '只能复用更早镜头', '绑定明确已存在的前镜。', entity);
      else if (shot.prompt?.text !== records(plan.shots).find(row => row.id === shot.reuseOf)?.prompt?.text) add('reference', 'REUSE_TEXT', `${field}.prompt.text`, '复用帧正文不一致', '复用同一画面；后期变化写入 motion。', entity);
    }
    if (!text(shot.prompt?.text)) add('structure', 'PROMPT_REQUIRED', `${field}.prompt.text`, '最终自然正文缺失', '写一个确定静态瞬间。', entity);
    if (!['agent-default', 'user'].includes(shot.selection?.by) || !text(shot.selection?.reason)) add('structure', 'SELECTION_INVALID', `${field}.selection`, '当前采用来源缺失', '记录默认采用或用户选择及原因；不自动记为确认。', entity);
    duplicates([shot.variantId, ...list(shot.candidates).map(row => row?.id)], `${field}.candidates`, entity);
    for (const candidate of list(shot.candidates)) {
      fields(candidate, 'candidate', `${field}.candidates`, entity);
      if (!object(candidate?.changes) || Object.keys(candidate.changes).some(key => !contract.candidateEditable.includes(key))) add('structure', 'CANDIDATE_INVALID', `${field}.candidates`, '备选方案结构无效', '提供明确构图/机位差异和允许修改的画面字段。', entity);
      if (object(candidate?.changes) && Object.hasOwn(candidate.changes, 'videoPrompt') && !text(candidate.changes.videoPrompt)) add('structure', 'FIELD_TYPE', `${field}.candidates.${candidate.id}.changes.videoPrompt`, '视频Prompt须为非空文本', '填写完整视频Prompt；无需视频文本时省略该字段。', entity);
    }
    let currentHash;
    try { currentHash = sourceHashV2(project, plan, shot); } catch (error) { add('reference', 'DEPENDENCY_CYCLE', `${field}.transition`, error.message, '移除循环并保持前镜依赖。', entity); }
    if (sealed && (shot.prompt?.sourceHash !== currentHash || shot.prompt?.textHash !== digest(shot.prompt?.text ?? ''))) add('source', 'PROMPT_STALE', `${field}.prompt`, '正文或来源指纹失效', '通过有版本检查的 revise 显式修订；不要手改哈希。', entity);
    if (!shot.review) pending('SCORE_MISSING', `${field}.review`, '尚未提供本版文本评分', entity);
    else {
      try { checkReview(shot.review, shot.prompt?.text, shot.id, true, plan.rubricVersion); } catch (error) { pending('SCORE_INVALID', `${field}.review`, error.message, entity); }
      if (shot.review.sourceHash !== currentHash) pending('SCORE_STALE', `${field}.review.sourceHash`, '评分来源已变化或未绑定本版来源', entity);
    }
    const semantic = shot.semanticReview;
    if (semantic) { fields(semantic, 'semanticReview', `${field}.semanticReview`, entity); for (const row of list(semantic.checks)) { fields(row, 'semanticCheck', `${field}.semanticReview.checks`, entity); if (!contract.semanticRules.includes(row?.rule)) add('structure', 'SEMANTIC_RULE_UNKNOWN', `${field}.semanticReview.checks`, '未知语义核对项', '使用合同列出的核对项。', entity); } }
    if (!semantic) pending('SEMANTIC_MISSING', `${field}.semanticReview`, '未记录独立语义核对', entity);
    else if (semantic.sourceHash !== currentHash || semantic.promptHash !== digest(shot.prompt?.text ?? '') || !text(semantic.reviewer)) pending('SEMANTIC_STALE', `${field}.semanticReview`, '语义核对未绑定当前正文及来源', entity);
    else {
      duplicates(list(semantic.checks).map(row => row?.rule), `${field}.semanticReview.checks`, entity);
      for (const rule of contract.semanticRules) {
        const row = list(semantic.checks).find(item => item?.rule === rule);
        if (!row || !['pass', 'issue', 'not-applicable'].includes(row.status) || !text(row.evidence) || !text(row.reason)) pending('SEMANTIC_INCOMPLETE', `${field}.semanticReview.${rule}`, '核对项缺少结果或具体证据', entity);
        else if (row.status === 'issue') pending('SEMANTIC_ISSUE', `${field}.semanticReview.${rule}`, row.reason, entity, row.evidence);
      }
    }
    earlier.push(shot.id);
  }
  for (const value of originals) if (!covered.has(value)) add('source', 'UNCOVERED_SOURCE', '$.shots', `源镜未覆盖：${value}`, '补齐对应镜头或保留拆并映射。');
  const duration = plan.spec?.duration, total = list(plan.shots).reduce((sum, shot) => sum + (Number.isFinite(shot?.seconds) ? shot.seconds : 0), 0);
  if (!duration || !['estimate', 'exact', 'max', 'range'].includes(duration.mode) || !text(duration.basis)) add('structure', 'DURATION_INVALID', '$.spec.duration', '时长要求无效', '记录用户目标或本片估算依据。');
  else {
    const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
    const invalid = ['exact', 'max'].includes(duration.mode) ? !positive(duration.seconds) : duration.mode === 'range' && (!positive(duration.min) || !positive(duration.max) || duration.min > duration.max);
    if (invalid) add('structure', 'DURATION_INVALID', '$.spec.duration', '时长数值无效', '使用正数与有效上下限。');
    else if ((duration.mode === 'exact' && Math.abs(total - duration.seconds) > 0.01) || (duration.mode === 'max' && total > duration.seconds + 0.01) || (duration.mode === 'range' && (total < duration.min - 0.01 || total > duration.max + 0.01))) pending('DURATION_TARGET', '$.spec.duration', `当前总时长 ${Math.round(total * 1000) / 1000} 秒不符合目标`, null, '调整本片编排和停留时长，保留原稿与源映射。');
  }
  duplicates(list(plan.calibration).map(row => row?.id), '$.calibration');
  for (const sample of list(plan.calibration)) {
    const shot = records(plan.shots).find(row => row.id === sample?.shotId);
    if (!id(sample?.id) || !shot || !text(sample?.text) || !text(sample?.label)) { add('structure', 'CALIBRATION_INVALID', '$.calibration', '校准样本结构或绑定错误', '使用稳定样本 ID、源镜和正文。'); continue; }
    if (sealed) {
      try {
        if (sample.sourceHash !== sourceHashV2(project, plan, shot) || sample.textHash !== digest(sample.text)) pending('CALIBRATION_STALE', '$.calibration', `校准样本 ${sample.id} 已过期，旧人评不能复用`);
      } catch (error) { add('reference', 'CALIBRATION_DEPENDENCY_INVALID', '$.calibration', error.message, '先修复关联镜头的依赖，再核对样本来源。'); }
    }
    if (sample.review) try { checkReview(sample.review, sample.text, sample.id, false, plan.rubricVersion); } catch (error) { pending('CALIBRATION_SCORE_INVALID', '$.calibration', error.message); }
  }
  return { ...summarize(issues, plan), totalSeconds: Math.round(total * 1000) / 1000 };
}

export function parseFailure(error, field = '$') {
  const category = error instanceof SyntaxError ? 'parse' : ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? 'runtime' : 'structure';
  const report = summarize([issue(category, category === 'parse' ? 'JSON_PARSE_FAILED' : 'READ_OR_VALIDATE_FAILED', field, error.message, '保留输入文件，按错误修正该输入或环境后重新执行。')]);
  report.execution.hardValidation = 'not-completed';
  return report;
}
