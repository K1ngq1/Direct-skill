import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './visual_v2.mjs';
import { validateLocalImage } from './local_image.mjs';
import { validateLibTVTask } from './libtv_generation.mjs';
import { createProcessLock } from './process_lock.mjs';

const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const phases = ['characters', 'scenes', 'storyboards'];
const states = ['submitting', 'pending', 'unknown', 'generated', 'succeeded', 'failed', 'cancelled'];
const fail = message => { throw new Error(message); };
const writeOnce = (filename, value) => {
  const fd = fs.openSync(filename, 'wx');
  try { fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
};

export function createLibTVGenerationStore(directory, inputJobs, { batchId, version, phase, projectId, concurrency = 4 } = {}) {
  if (!validId(batchId) || !validId(version) || !phases.includes(phase) || typeof projectId !== 'string' || !projectId.trim() || !Number.isInteger(concurrency) || concurrency < 1) fail('LibTV 批次身份、项目或并发数无效');
  const jobs = JSON.parse(JSON.stringify(inputJobs)), batch = { batchId, version, phase, projectId };
  const previousPlanFile = path.join(directory, 'batch.json');
  const frozenBefore = fs.existsSync(previousPlanFile) && digest(read(previousPlanFile).jobs) === digest(jobs);
  const recoveryIdentity = job => typeof job?.existingTaskId === 'string' && !!job.existingTaskId.trim() && job.existingTaskId.length <= 500 && !/^(?:cop_|data:|https?:)/i.test(job.existingTaskId);
  const submitIdentity = job => {
    const args = job?.submitArgs, tool = job?.submitTool ?? 'generation_submit';
    if (tool === 'create_node') return { project: args?.projectId, key: args?.idempotencyKey, valid: args?.nodeType === 'image' && args.run === true && args.params?.count === 1 && typeof args.name === 'string' && !!args.name.trim() && typeof args.prompt === 'string' && !!args.prompt.trim() };
    // Model-specific controls still require the host's observed inputContract; old frozen requests are not rewritten.
    if (tool === 'generation_submit') {
      let params = args?.request?.params;
      if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = null; } }
      return { project: args?.project_id, key: args?.idempotency_key, valid: typeof args?.request?.model === 'string' && !!args.request.model.trim() && params?.count === 1 && (frozenBefore || (args?.kind === 'image' && typeof args.request.prompt === 'string' && !!args.request.prompt.trim() && typeof args.request.params === 'object' && !Array.isArray(args.request.params))) };
    }
    return {};
  };
  if (!Array.isArray(jobs) || jobs.some(job => {
    if (!validId(job?.id) || job.count !== 1) return true;
    if ('existingTaskId' in job) return !recoveryIdentity(job) || job.projectId !== projectId || 'submitTool' in job || 'submitArgs' in job || (job.outputNodeId !== undefined && (typeof job.outputNodeId !== 'string' || !job.outputNodeId.trim() || job.outputNodeId.length > 1000 || /^(?:data:|https?:)/i.test(job.outputNodeId)));
    const input = submitIdentity(job);
    return 'outputNodeId' in job || input.project !== projectId || typeof input.key !== 'string' || !input.key.trim() || !input.valid;
  }) || new Set(jobs.map(job => job.id)).size !== jobs.length) fail('LibTV 任务须包含唯一 ID、幂等键、单项目与明确单张请求，或互斥的已有任务恢复身份');
  const submissions = jobs.filter(job => !('existingTaskId' in job)), recoveries = jobs.filter(job => 'existingTaskId' in job);
  if (new Set(submissions.map(job => submitIdentity(job).key)).size !== submissions.length || new Set(recoveries.map(job => job.existingTaskId)).size !== recoveries.length) fail('LibTV 任务须包含唯一 ID、幂等键或已有任务身份');
  const byId = new Map(jobs.map(job => [job.id, job])), done = new Set(), visiting = new Set();
  const visit = job => {
    if (done.has(job.id)) return;
    if (visiting.has(job.id)) fail('LibTV 任务依赖存在循环');
    visiting.add(job.id);
    if (!Array.isArray(job.dependsOn ?? []) || new Set(job.dependsOn ?? []).size !== (job.dependsOn ?? []).length) fail('LibTV 任务依赖无效');
    for (const id of job.dependsOn ?? []) { if (!byId.has(id)) fail('LibTV 任务依赖不存在'); visit(byId.get(id)); }
    visiting.delete(job.id); done.add(job.id);
  };
  for (const job of jobs) visit(job);
  fs.mkdirSync(directory, { recursive: true });
  const root = fs.realpathSync(directory), planFile = path.join(root, 'batch.json'), controlFile = path.join(root, 'control.json'), receipts = path.join(root, 'receipts');
  const plan = { schemaVersion: 1, provider: 'libtv', ...batch, jobs };
  if (fs.existsSync(planFile)) {
    if (digest(read(planFile)) !== digest(plan)) fail('LibTV 冻结输入已变化；不能覆盖或迁移原批次');
    if (!fs.existsSync(controlFile) || !fs.existsSync(receipts)) fail('LibTV 批次检查点缺失；不能重建后重新提交');
  } else {
    if (fs.readdirSync(root).length) fail('LibTV 目录已有记录但缺少冻结批次；不能重新初始化');
    writeOnce(planFile, plan);
    fs.mkdirSync(receipts);
    writeOnce(controlFile, { batchId, revision: 0, version, phase, paused: false, concurrency, receivedAt: new Date().toISOString() });
  }
  const jobFor = id => byId.get(id) ?? fail('未知 LibTV 批次任务');
  const identity = job => ({ schemaVersion: 1, ...batch, id: job.id, inputHash: digest(job) });
  const checkIdentity = (job, value) => {
    for (const [key, expected] of Object.entries(identity(job))) if (value?.[key] !== expected) fail('LibTV 回执与冻结任务身份不一致');
    if ('existingTaskId' in job && (value.state === 'submitting' || (value.state !== undefined && value.taskId !== job.existingTaskId))) fail('LibTV 恢复计划只能使用原 taskId，不能提交');
    if (job.outputNodeId && ['generated', 'succeeded'].includes(value.state) && !value.outputs?.some(output => output.nodeId === job.outputNodeId)) fail('LibTV 实际产物节点与恢复绑定不一致');
  };
  const validateReceiptResult = (job, value) => {
    if (value.state === 'generated') validateLibTVTask({ projectId, taskId: value.taskId, state: 'succeeded', outputs: value.outputs }, { projectId, taskId: value.taskId, count: job.count });
    if (value.state !== 'succeeded') return;
    if (!Array.isArray(value.files) || value.files.length !== job.count) fail('LibTV 成功回执缺少实际交付文件或数量不符');
    for (const file of value.files) {
      if (typeof file?.path !== 'string' || !path.isAbsolute(file.path)) fail('LibTV 交付文件须为绝对路径');
      validateLocalImage(path.dirname(file.path), { path: path.basename(file.path), sha256: file.sha256 });
    }
  };
  const readReceipt = id => {
    const job = jobFor(id), prefix = `${id}-`;
    const names = fs.readdirSync(receipts).filter(name => name.startsWith(prefix));
    const checkpoints = names.filter(name => /^\d{8}\.checkpoint\.json$/.test(name.slice(prefix.length))).sort();
    const records = names.filter(name => /^\d{8}\.json$/.test(name.slice(prefix.length))).sort();
    if (records.length !== checkpoints.length) fail('LibTV 回执检查点缺失；停止恢复提交');
    let latest = null;
    for (let index = 0; index < records.length; index++) {
      const stem = `${id}-${String(index + 1).padStart(8, '0')}`;
      if (records[index] !== `${stem}.json` || checkpoints[index] !== `${stem}.checkpoint.json`) fail('LibTV 回执历史不连续');
      const checkpoint = read(path.join(receipts, checkpoints[index])), value = read(path.join(receipts, records[index]));
      checkIdentity(job, checkpoint); checkIdentity(job, value);
      if (value.sequence !== index + 1 || checkpoint.payloadHash !== digest(value) || !states.includes(value.state)) fail('LibTV 回执内容或状态已变化');
      latest = value;
    }
    if (latest) validateReceiptResult(job, latest);
    return latest;
  };
  const validateControl = value => {
    if (value?.batchId !== batchId || !Number.isSafeInteger(value.revision) || value.revision < 0 || !validId(value.version) || !phases.includes(value.phase) || typeof value.paused !== 'boolean' || !Number.isInteger(value.concurrency) || value.concurrency < 1 || !Number.isFinite(Date.parse(value.receivedAt))) fail('LibTV 控制检查点无效；停止新提交');
    return value;
  };
  const readControl = context => {
    if (context !== undefined) coordinator.assertOwner(context);
    const initial = validateControl(read(controlFile));
    if (initial.revision !== 0) fail('LibTV 初始控制检查点已变化');
    const names = fs.readdirSync(root).filter(name => /^control-\d{8}\.json$/.test(name)).sort();
    let value = initial;
    for (let index = 0; index < names.length; index++) {
      value = validateControl(read(path.join(root, names[index])));
      if (value.revision !== index + 1 || names[index] !== `control-${String(index + 1).padStart(8, '0')}.json`) fail('LibTV 控制历史不连续');
    }
    return value;
  };
  const allowed = control => !control.paused && control.version === version && control.phase === phase;
  let owner = null, coordinated = false;
  const coordinator = createProcessLock(path.join(root, 'coordinator.lock'));
  const assertMutationOwner = context => {
    if (context !== undefined) return coordinator.assertOwner(context);
    if (coordinated || coordinator.inspect()) fail('LibTV 协调器写入须透传本轮 owner context');
  };
  const release = (context = {}) => {
    if (context.owner !== undefined && context.owner !== owner) return false;
    if (!owner) return false;
    const released = coordinator.release({ ...context, owner });
    if (released) owner = null;
    return released;
  };
  readControl();
  for (const job of jobs) readReceipt(job.id);
  return {
    batch,
    jobs: jobs.map(({ id, count, dependsOn = [], existingTaskId }) => ({ id, count, dependsOn: [...dependsOn], ...(existingTaskId ? { existingTaskId } : {}) })),
    acquire(context = {}) {
      const acquired = coordinator.acquire(context); owner = acquired.owner; coordinated = true; return acquired;
    },
    release,
    inspectLock: () => coordinator.inspect(),
    recoverLock: options => coordinator.recover(options),
    readControl,
    setControl(change, { receivedAt = new Date().toISOString() } = {}) {
      if (!change || Object.keys(change).some(key => !['version', 'phase', 'paused', 'concurrency'].includes(key))) fail('LibTV 控制变更字段无效');
      const lock = path.join(root, 'control.lock');
      writeOnce(lock, { owner: randomUUID() });
      try {
        const previous = readControl(), next = validateControl({ ...previous, ...change, revision: previous.revision + 1, receivedAt });
        writeOnce(path.join(root, `control-${String(next.revision).padStart(8, '0')}.json`), next);
        return next;
      } finally { fs.unlinkSync(lock); }
    },
    acknowledgeControl(control, context) {
      assertMutationOwner(context);
      validateControl(control);
      const original = read(control.revision ? path.join(root, `control-${String(control.revision).padStart(8, '0')}.json`) : controlFile);
      if (Object.keys(original).some(key => original[key] !== control[key]) || !Number.isFinite(Date.parse(control.observedAt)) || !Number.isFinite(Date.parse(control.effectiveAt))) fail('LibTV 控制确认无效');
      const filename = path.join(root, `control-observed-${control.revision}.json`);
      if (!fs.existsSync(filename)) writeOnce(filename, control);
    },
    prepare(id, context) { if (context !== undefined) coordinator.assertOwner(context); const job = jobFor(id); return { job: JSON.parse(JSON.stringify(job)), receipt: readReceipt(id), control: readControl() }; },
    readReceipt,
    snapshot(context) {
      if (context !== undefined) coordinator.assertOwner(context);
      return Object.fromEntries(jobs.flatMap(job => {
        const receipt = readReceipt(job.id);
        return receipt ? [[job.id, { state: receipt.state, ...(receipt.taskId ? { taskId: receipt.taskId } : {}) }]] : [];
      }));
    },
    writeReceipt(id, value, { exclusive = false, context } = {}) {
      assertMutationOwner(context);
      const job = jobFor(id), previous = readReceipt(id);
      if (exclusive && previous) fail('LibTV 任务已有提交回执，不能重复认领');
      if (!states.includes(value?.state)) fail('LibTV 回执状态无效');
      if ('existingTaskId' in job && (value.state === 'submitting' || value.taskId !== job.existingTaskId)) fail('LibTV 恢复计划只能使用原 taskId，不能提交');
      if (job.outputNodeId && ['generated', 'succeeded'].includes(value.state) && !value.outputs?.some(output => output.nodeId === job.outputNodeId)) fail('LibTV 实际产物节点与恢复绑定不一致');
      if (value.taskId != null && (typeof value.taskId !== 'string' || !value.taskId.trim() || value.taskId.startsWith('cop_'))) fail('LibTV taskId 须为媒体任务身份，不能使用画布回执');
      if (previous?.taskId && value.taskId !== previous.taskId) fail('LibTV 恢复不能替换原 taskId');
      if (['pending', 'generated', 'succeeded'].includes(value.state) && (typeof value.taskId !== 'string' || !value.taskId.trim())) fail('LibTV 已受理任务缺少原 taskId');
      if (previous && ['succeeded', 'failed', 'cancelled'].includes(previous.state) && previous.state !== value.state) fail('LibTV 终态不能重新提交');
      validateReceiptResult(job, value);
      const sequence = (previous?.sequence ?? 0) + 1, record = { ...value, ...identity(job), sequence, recordedAt: new Date().toISOString() };
      const stem = path.join(receipts, `${id}-${String(sequence).padStart(8, '0')}`);
      writeOnce(`${stem}.checkpoint.json`, { ...identity(job), sequence, payloadHash: digest(record) });
      writeOnce(`${stem}.json`, record);
      return record;
    },
    summarize(results, report, context) {
      assertMutationOwner(context);
      if (!Array.isArray(results) || results.length !== jobs.length || new Set(results.map(value => value?.id)).size !== jobs.length) fail('LibTV 汇总须覆盖所有任务');
      const references = new Map();
      for (const item of results) {
        const job = jobFor(item.id);
        if (![...states, 'blocked', 'paused'].includes(item.status) || (item.taskId != null && (typeof item.taskId !== 'string' || !item.taskId.trim() || item.taskId.startsWith('cop_')))) fail('LibTV 汇总状态或任务身份无效');
        if (item.status === 'succeeded') {
          const saved = readReceipt(item.id);
          if (saved?.state !== 'succeeded' || saved.taskId !== item.taskId) fail('LibTV 汇总成功项缺少持久交付回执');
          validateReceiptResult(job, saved);
        }
        if (item.status === 'generated') {
          const generated = readReceipt(item.id);
          if (generated?.state !== 'generated' || generated.taskId !== item.taskId) fail('LibTV 汇总生成项缺少持久任务成功回执');
          const verified = validateLibTVTask({ projectId, taskId: generated.taskId, state: 'succeeded', outputs: generated.outputs }, { projectId, taskId: item.taskId, count: job.count });
          references.set(item.id, verified.outputs);
        }
      }
      const control = readControl(), deliveryAllowed = report?.deliveryAllowed === true && allowed(control), summaryId = randomUUID();
      const filename = path.join(root, `summary-${summaryId}.json`), deliveryPath = path.join(root, `delivery-${summaryId}.md`);
      const localFinalization = report?.localFinalization !== false;
      const counts = {}, tasks = results.map(item => { counts[item.status] = (counts[item.status] ?? 0) + 1; return { id: item.id, status: item.status, taskId: item.taskId ?? null, ...(deliveryAllowed && references.has(item.id) ? { outputs: references.get(item.id) } : {}) }; });
      writeOnce(filename, { schemaVersion: 1, ...batch, results, report: { ...report, deliveryAllowed }, control, finishedAt: new Date().toISOString() });
      const links = deliveryAllowed && localFinalization ? results.filter(item => item.status === 'succeeded').flatMap(item => readReceipt(item.id).files.map(file => `- [${item.id}](<${file.path.replaceAll('\\', '/')}>)`)) : [];
      const remoteItems = deliveryAllowed && !localFinalization ? tasks.filter(item => item.outputs).map(item => `- ${item.id}：${item.taskId}；${JSON.stringify(item.outputs)}`) : [];
      writeOnce(deliveryPath, [localFinalization ? '# LibTV 批次交付索引' : '# LibTV 批次任务索引', '', `批次：${batchId} / ${version} / ${phase}`, '', `任务状态：${JSON.stringify(counts)}`, '', !deliveryAllowed ? '当前控制不允许交付，保留内部记录。' : localFinalization ? '本索引确认文件与哈希；画质及用户确认另行记录。' : '本轮仅跟踪远端任务和已核实产物引用，未执行本地下载；画质及用户确认另行记录。', '', ...links, ...remoteItems, ''].join('\n'));
      return { path: filename, deliveryAllowed, counts, tasks, deliveryPath: deliveryAllowed ? deliveryPath : null };
    }
  };
}
