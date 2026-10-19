import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { contract, digest, sourceHashV2 } from './visual_v2.mjs';
import { loadRuleSnapshot } from './runtime.mjs';

const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const writeNew = (filename, value, created) => {
  const handle = fs.openSync(filename, 'wx');
  try { created?.(); fs.writeFileSync(handle, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
  finally { fs.closeSync(handle); }
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const required = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => digest(a) === digest(b);

export function localFolder(directory, relative) {
  const root = fs.realpathSync(directory), target = path.resolve(root, relative), rel = path.relative(root, target);
  required(rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel), '输出目录不能越出项目');
  let cursor = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor);
    const real = fs.realpathSync(cursor), inside = path.relative(root, real);
    required(inside !== '..' && !inside.startsWith('..' + path.sep) && !path.isAbsolute(inside), '输出目录链接越出项目');
  }
  return target;
}

export function freezeV2(project, plan, explicitlyReviewed = new Set()) {
  for (const shot of plan.shots) {
    if (typeof shot.prompt?.text === 'string') shot.prompt.text = shot.prompt.text.replace(/\r\n?/g, '\n');
    if (typeof shot.videoPrompt === 'string') shot.videoPrompt = shot.videoPrompt.replace(/\r\n?/g, '\n');
    shot.prompt.sourceHash = sourceHashV2(project, plan, shot);
    shot.prompt.textHash = digest(shot.prompt.text);
  }
  for (const shot of plan.shots) {
    if (explicitlyReviewed.has(`${shot.id}:review`) && shot.review) {
      shot.review.sourceHash = shot.prompt.sourceHash; shot.review.promptHash = shot.prompt.textHash;
    }
    if (explicitlyReviewed.has(`${shot.id}:semanticReview`) && shot.semanticReview) {
      shot.semanticReview.sourceHash = shot.prompt.sourceHash; shot.semanticReview.promptHash = shot.prompt.textHash;
    }
  }
}

export function initializeV2(project, input) {
  const plan = structuredClone(input);
  plan.projectId ??= crypto.randomUUID(); plan.sourceSha256 ??= project.source.sha256;
  plan.revision = 1; plan.rules = loadRuleSnapshot();
  plan.sourceResolutions ??= []; plan.repairAttempts = []; plan.changes = [];
  plan.calibration ??= [];
  for (const shot of Array.isArray(plan.shots) ? plan.shots.filter(object) : []) {
    shot.variantId ??= 'default'; shot.selection ??= { by: 'agent-default', reason: '首轮默认方案；未代表用户确认' };
    shot.candidates ??= []; shot.semanticReview ??= null; shot.review ??= null; shot.notApplicable ??= {};
  }
  return plan;
}

export function saveInitialV2(directory, plan, input) {
  const filename = path.join(directory, 'visual-plan.json');
  const lock = path.join(directory, 'visual-plan.lock'), lockHandle = fs.openSync(lock, 'wx');
  let temp, createdSnapshot;
  try {
    required(!fs.existsSync(filename), 'visual-plan.json已存在，不覆盖现有项目');
    const revisions = localFolder(directory, 'visual-revisions'), snapshot = path.join(revisions, '000001.json');
    if (fs.existsSync(snapshot)) {
      const saved = read(snapshot);
      required(saved.planHash === digest(saved.plan) && same(saved.input, input) && same(saved.plan.rules, plan.rules) && saved.plan.sourceSha256 === plan.sourceSha256, '已有未完成初始快照与本次输入不一致；请保留现场并核对');
      plan = saved.plan;
    }
    temp = path.join(directory, `.visual-plan-${crypto.randomUUID()}.tmp`); writeNew(temp, plan);
    if (!fs.existsSync(snapshot)) writeNew(snapshot, { revision: 1, kind: 'seal', reason: '首次归档', at: new Date().toISOString(), input, plan, planHash: digest(plan) }, () => { createdSnapshot = snapshot; });
    fs.renameSync(temp, filename); temp = null;
    return plan;
  } catch (error) {
    if (createdSnapshot && !fs.existsSync(filename)) fs.unlinkSync(createdSnapshot);
    throw error;
  } finally {
    if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
    fs.closeSync(lockHandle); fs.unlinkSync(lock);
  }
}

function applyFields(target, changes, allowed) {
  required(object(changes) && Object.keys(changes).length, 'changes须为非空对象');
  for (const [key, value] of Object.entries(changes)) {
    required(allowed.includes(key), `不可修改字段：${key}`);
    target[key] = structuredClone(value);
  }
}

export function changeV2(directory, request, { project, inspect, action = 'revise' }) {
  required(object(request), '修订请求须为对象');
  required(Number.isInteger(request.baseRevision) && request.baseRevision > 0, '缺少baseRevision');
  required(typeof request.reason === 'string' && Boolean(request.reason.trim()), '缺少具体修改原因');
  required(['agent', 'user'].includes(request.actor), 'actor须为agent或user');
  const filename = path.join(directory, 'visual-plan.json'), lock = path.join(directory, 'visual-plan.lock');
  const lockHandle = fs.openSync(lock, 'wx');
  let temp, createdSnapshot, beforeBytes;
  try {
    fs.writeFileSync(lockHandle, String(process.pid));
    const before = read(filename);
    required(before.schemaVersion === 2 && before.mode === 'visual-excel-v2', '仅可修订新版项目，旧项目不自动迁移');
    required(before.revision === request.baseRevision, '版本冲突，请重新读取当前项目后提出修订');
    beforeBytes = fs.readFileSync(filename);
    const revisions = localFolder(directory, 'visual-revisions');
    const pendingSnapshot = path.join(revisions, `${String(before.revision + 1).padStart(6, '0')}.json`);
    if (fs.existsSync(pendingSnapshot)) {
      const saved = read(pendingSnapshot);
      required(saved.planHash === digest(saved.plan) && saved.previousPlanHash === digest(before) && same(saved.request, request), '存在不同请求的未完成快照，请保留现场并使用原请求恢复');
      const report = inspect(saved.plan);
      required(!report.issues.some(row => row.severity === 'error'), '未完成快照当前已不满足结构约束，请保留现场并核对');
      temp = path.join(directory, `.visual-plan-${crypto.randomUUID()}.tmp`); writeNew(temp, saved.plan);
      fs.renameSync(temp, filename); temp = null;
      return { accepted: saved.plan.changes.at(-1).accepted, plan: saved.plan, report, attemptReport: saved.attemptReport, affectedShotIds: saved.plan.changes.at(-1).affectedShotIds, recovered: true };
    }
    let next = structuredClone(before), accepted = true, attemptReport = null;
    const explicitReviews = new Set(), affected = new Set();
    const knownFields = { revise: ['kind', 'shotEdits', 'assetEdits', 'spec', 'sourceResolutions', 'refreshRules', 'userRequest'], 'add-candidate': ['shotId', 'candidate'], select: ['shotId', 'candidateId'], restore: ['targetRevision'] };
    required(Object.hasOwn(knownFields, action), '未知修订操作');
    for (const key of Object.keys(request)) required(['baseRevision', 'actor', 'reason', ...knownFields[action]].includes(key), `未知请求字段：${key}`);
    const findShot = value => { const shot = next.shots.find(row => row.id === value); required(shot, `镜头不存在：${value}`); return shot; };
    const markReviews = (shotId, changes) => { for (const key of ['review', 'semanticReview']) if (Object.hasOwn(changes, key)) explicitReviews.add(`${shotId}:${key}`); };
    if (action === 'revise') {
      required(['repair', 'edit', 'review'].includes(request.kind), 'kind须为repair/edit/review');
      if (request.kind === 'edit') required(typeof request.userRequest === 'string' && request.userRequest.trim(), '定向edit须记录新的userRequest；自动纠错使用repair并受两轮上限约束');
      if (request.kind === 'repair') required(before.repairAttempts.length < 2, '已达两轮自动修复上限，请保留待处理项');
      for (const group of ['shotEdits', 'assetEdits']) if (request[group] !== undefined) required(Array.isArray(request[group]), `${group}须为数组`);
      const edited = new Set();
      for (const edit of request.shotEdits ?? []) {
        required(object(edit) && !edited.has(edit.id), '镜头修改条目无效或重复'); edited.add(edit.id);
        const shot = findShot(edit.id);
        applyFields(shot, edit.changes, request.kind === 'review' ? ['review', 'semanticReview'] : contract.shotEditable);
        markReviews(edit.id, edit.changes); affected.add(edit.id);
      }
      const editedAssets = new Set();
      for (const edit of request.assetEdits ?? []) {
        required(request.kind !== 'review' && ['characters', 'locations', 'props'].includes(edit?.kind), '资产修改类型无效');
        const key = `${edit.kind}:${edit.id}`; required(!editedAssets.has(key), '资产修改重复'); editedAssets.add(key);
        const rows = edit.kind === 'props' ? next.props : next.productionInventory[edit.kind], asset = rows.find(row => row.id === edit.id);
        required(asset, '资产不存在');
        applyFields(asset, edit.changes, edit.kind === 'props' ? ['name', 'description', 'provenance'] : ['name', 'description', 'basis', 'provenance']);
      }
      if (request.spec !== undefined) { required(request.kind !== 'review', 'review不能修改规格'); next.spec = structuredClone(request.spec); }
      if (request.sourceResolutions !== undefined) next.sourceResolutions = structuredClone(request.sourceResolutions);
      if (request.refreshRules !== undefined) { required(request.refreshRules === true, 'refreshRules只接受true'); next.rules = loadRuleSnapshot(); }
      required(!same(next, before), '修订没有实际变化');
    } else if (action === 'add-candidate') {
      const shot = findShot(request.shotId), candidate = request.candidate;
      required(object(candidate) && typeof candidate.difference === 'string' && candidate.difference.trim(), '候选须明确说明构图或机位差异');
      required(candidate.id !== shot.variantId && !shot.candidates.some(row => row.id === candidate.id), '候选ID重复');
      const candidatePlan = structuredClone(next), candidateShot = candidatePlan.shots.find(row => row.id === shot.id);
      applyFields(candidateShot, candidate.changes, contract.candidateEditable);
      required(candidateShot.dimensions?.camera !== shot.dimensions?.camera || candidateShot.dimensions?.composition !== shot.dimensions?.composition, '候选必须具有明确机位或构图差异');
      const candidateReport = inspect(candidatePlan, { sealed: false });
      required(!candidateReport.issues.some(row => row.severity === 'error'), '候选结构不合法：' + candidateReport.issues.filter(row => row.severity === 'error').map(row => `${row.path}: ${row.message}`).join('；'));
      shot.candidates.push({ id: candidate.id, difference: candidate.difference, changes: structuredClone(candidate.changes), baseSourceHash: sourceHashV2(project, before, before.shots.find(row => row.id === shot.id)), basePromptHash: digest(shot.prompt.text) });
    } else if (action === 'select') {
      required(request.actor === 'user', '采用备选须记录用户选择；默认方案无需选择');
      const shot = findShot(request.shotId), candidate = shot.candidates.find(row => row.id === request.candidateId);
      required(candidate, '候选不存在');
      required(candidate.baseSourceHash === sourceHashV2(project, before, before.shots.find(row => row.id === shot.id)) && candidate.basePromptHash === digest(shot.prompt.text), '候选依据或正文已过期，请重新核对后创建候选');
      applyFields(shot, candidate.changes, contract.candidateEditable);
      markReviews(shot.id, candidate.changes); affected.add(shot.id);
      shot.variantId = candidate.id; shot.selection = { by: 'user', reason: request.reason };
      shot.candidates = shot.candidates.filter(row => row.id !== candidate.id);
    } else {
      required(request.actor === 'user' && Number.isInteger(request.targetRevision) && request.targetRevision > 0 && request.targetRevision < before.revision, '回退须明确用户、历史修订号和原因');
      const revisions = localFolder(directory, 'visual-revisions');
      const saved = read(path.join(revisions, `${String(request.targetRevision).padStart(6, '0')}.json`));
      required(saved.planHash === digest(saved.plan), '历史快照哈希不一致');
      required(saved.plan.projectId === before.projectId && saved.plan.sourceSha256 === before.sourceSha256, '历史快照不属于本项目原稿');
      next = structuredClone(saved.plan);
      next.repairAttempts = structuredClone(before.repairAttempts); next.changes = structuredClone(before.changes);
      before.shots.forEach(shot => { if (!same(shot, next.shots.find(row => row.id === shot.id))) affected.add(shot.id); });
    }
    let report = inspect(next, { sealed: false });
    const structuralErrors = report.issues.filter(row => row.severity === 'error');
    if (structuralErrors.length) {
      if (action !== 'revise' || request.kind !== 'repair') {
        const error = new Error('修订校验失败，原状态未修改'); error.report = report; throw error;
      }
      accepted = false; attemptReport = report; next = structuredClone(before);
    }
    if (action === 'revise' && request.kind === 'repair') next.repairAttempts.push({ round: before.repairAttempts.length + 1, status: accepted ? 'applied' : 'rejected', requestHash: digest(request), issues: structuralErrors, reason: request.reason });
    if (accepted) {
      for (const shot of next.shots) {
        const previous = before.shots.find(row => row.id === shot.id);
        if (!previous || sourceHashV2(project, next, shot) !== sourceHashV2(project, before, previous) || shot.prompt.text !== previous.prompt.text) affected.add(shot.id);
      }
      freezeV2(project, next, explicitReviews);
    }
    next.revision = before.revision + 1;
    next.changes.push({ revision: next.revision, action, kind: request.kind ?? action, actor: request.actor, reason: request.reason, accepted, affectedShotIds: [...affected], at: new Date().toISOString() });
    next.sealedAt = new Date().toISOString();
    report = inspect(next);
    const snapshot = path.join(revisions, `${String(next.revision).padStart(6, '0')}.json`);
    required(fs.readFileSync(filename).equals(beforeBytes), '写入前状态发生变化，请重新读取');
    temp = path.join(directory, `.visual-plan-${crypto.randomUUID()}.tmp`);
    writeNew(temp, next);
    writeNew(snapshot, { revision: next.revision, planHash: digest(next), previousPlanHash: digest(before), request, attemptReport, report, plan: next }, () => { createdSnapshot = snapshot; });
    fs.renameSync(temp, filename); temp = null;
    return { accepted, plan: next, report, attemptReport, affectedShotIds: [...affected] };
  } catch (error) {
    if (createdSnapshot && beforeBytes && fs.existsSync(filename) && fs.readFileSync(filename).equals(beforeBytes)) fs.unlinkSync(createdSnapshot);
    throw error;
  } finally {
    fs.closeSync(lockHandle);
    if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
    fs.unlinkSync(lock);
  }
}
