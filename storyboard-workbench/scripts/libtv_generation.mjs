import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runConcurrentJobs, createMediaBatchController, withDeadline } from './media_batch.mjs';
import { assertRuntimeCapabilities } from './runtime.mjs';

// The public MCP response schema is open-ended. The host must map the observed contract explicitly.
export function validateLibTVTask(value, { projectId, taskId, count }) {
  const id = value?.taskId;
  if (!value || value.projectId !== projectId || typeof id !== 'string' || !id.trim() || id.length > 500 || id.startsWith('cop_') || (taskId && id !== taskId)) throw new Error('LibTV 任务或项目身份不匹配');
  if (!['pending', 'succeeded', 'failed', 'cancelled'].includes(value.state)) throw new Error('LibTV 任务状态未被明确识别');
  const outputs = value.outputs ?? [];
  if (!Array.isArray(outputs) || outputs.some(output => !output || !['nodeId', 'resourceId', 'fileRef'].some(key => typeof output[key] === 'string' && output[key].trim()))) throw new Error('LibTV 产物缺少持久身份');
  if (value.state === 'succeeded' && outputs.length !== count) throw new Error('LibTV 实际产物数量与授权数量不符');
  // Keep only opaque references, never pixels, signed URLs, prompts, or arbitrary tool payloads.
  const references = outputs.map(output => Object.fromEntries(['nodeId', 'resourceId', 'fileRef'].flatMap(key => {
    const text = output[key];
    if (text === undefined) return [];
    if (typeof text !== 'string' || !text.trim() || text.length > 1000 || /^(?:data:|https?:)/i.test(text)) throw new Error('LibTV 产物引用无效');
    return [[key, text]];
  })));
  return { projectId, taskId: id, state: value.state, outputs: references };
}

export async function runLibTVGenerationBatch(jobs, {
  batch, acquire, release, snapshot, prepare, writeReceipt, readControl, acknowledgeControl, summarize,
  call, normalizeTask, finalize, concurrency = 4, allowNewSubmissions = false,
  recoverUnknownSubmission = false, maxPolls = 20, pollIntervalMs = 3000, callTimeoutMs = 120000, localTimeoutMs = 300000,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), report = {}, run
} = {}) {
  if (![acquire, release, snapshot, prepare, writeReceipt, readControl, acknowledgeControl, summarize, call, normalizeTask, wait].every(fn => typeof fn === 'function') || (finalize !== undefined && typeof finalize !== 'function')) throw new Error('LibTV 生成缺少持久化或身份解析回调，或可选收尾回调无效');
  if (!batch?.batchId || !batch.version || !['characters', 'scenes', 'storyboards'].includes(batch.phase)) throw new Error('LibTV 批次身份无效');
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(maxPolls) || maxPolls < 1 || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60000 || ![callTimeoutMs, localTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647) || typeof allowNewSubmissions !== 'boolean' || typeof recoverUnknownSubmission !== 'boolean') throw new Error('LibTV 调度参数无效');
  if (!Array.isArray(jobs) || jobs.some(job => !/^[A-Za-z0-9_-]{1,80}$/.test(job?.id) || job.count !== 1) || new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error('LibTV 任务ID或数量无效');
  const byId = new Map(jobs.map(job => [job.id, job])), done = new Set(), visiting = new Set();
  const visit = job => {
    if (visiting.has(job.id)) throw new Error('LibTV 依赖存在循环');
    if (done.has(job.id)) return;
    visiting.add(job.id);
    if (!Array.isArray(job.dependsOn ?? []) || new Set(job.dependsOn ?? []).size !== (job.dependsOn ?? []).length) throw new Error('LibTV 依赖无效');
    for (const id of job.dependsOn ?? []) { if (!byId.has(id)) throw new Error('LibTV 依赖不存在'); visit(byId.get(id)); }
    visiting.delete(job.id); done.add(job.id);
  };
  jobs.forEach(visit);
  const controller = createMediaBatchController(), states = new Map(), pending = [...jobs], finishQueue = [];
  let finishing = null, finishRunning = false, pendingFinalization = 0;
  let dispatchStopped = null, recoveryPass = false;
  let quarantined = null, quarantineError, acquired = false, acquiredOwner, initial = {};
  const effects = new Set(), sessionOwner = `${batch.batchId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let acknowledged = -1, activeCalls = 0, activeJobs = 0, wake, signal = new Promise(resolve => { wake = resolve; });
  const changed = () => { const old = wake; signal = new Promise(resolve => { wake = resolve; }); old(); };
  const monotonic = typeof performance !== 'undefined' && typeof performance.now === 'function';
  const tick = () => monotonic ? performance.now() : Date.now(), started = tick();
  Object.assign(report, { submitted: 0, recoveredSubmissions: 0, polls: 0, localFinalization: typeof finalize === 'function', peakOutstandingCalls: 0, peakPendingFinalization: 0, observedToolExecutionPeak: null, serverExecutionPeak: null, events: [], startedAt: new Date().toISOString(), durationSource: monotonic ? 'monotonic' : 'utc-estimate' });
  const event = (type, id, detail = {}) => report.events.push({ type, id, at: new Date().toISOString(), ...detail });
  const local = async (label, callback, args = [], mutating = false) => {
    if (quarantined) throw Object.assign(new Error('LibTV 批次已隔离；禁止新的宿主回调'), { code: 'BATCH_QUARANTINED' });
    const operation = (async () => callback(...args))();
    if (mutating) {
      effects.add(operation);
      operation.then(() => effects.delete(operation), () => effects.delete(operation));
    }
    try { return await withDeadline(operation, localTimeoutMs, `LibTV ${label}`); }
    catch (error) {
      if (error?.code === 'CALL_TIMEOUT') {
        dispatchStopped = `LibTV ${label}等待超时；停止新派发`;
        controller.stop(dispatchStopped);
        if (mutating) { quarantined = label; quarantineError = error; }
        event('callback-timeout', null, { callback: label, mutating, timeoutMs: localTimeoutMs });
      }
      throw error;
    }
  };
  const initialFor = id => Object.hasOwn(initial, id) ? initial[id] : undefined;
  const resultsNow = () => jobs.map(job => ({ id: job.id, status: initialFor(job.id)?.state ?? 'paused', ...(initialFor(job.id)?.taskId ? { taskId: initialFor(job.id).taskId } : {}), ...states.get(job.id) }));
  const fallback = error => {
    if (quarantineError) error = quarantineError;
    Object.assign(report, { deliveryAllowed: false, stopped: controller.stopped, quarantined, workFinishedAt: new Date().toISOString(), workDurationMs: Math.max(0, tick() - started) });
    const results = resultsNow().map(result => Object.fromEntries(['id', 'status', 'taskId', 'outputs', 'files', 'stage', 'error', 'errorCode'].flatMap(key => result[key] === undefined ? [] : [[key, result[key]]])));
    const ownershipUnknown = effects.size > 0 && (!acquired || quarantined === '协调器解锁');
    return { incomplete: true, persistedSummary: false, deliveryAllowed: false, lockRetained: ownershipUnknown ? null : Boolean(quarantined) && acquired, ownershipUnknown, error: String(error?.message ?? error ?? '宿主副作用尚未结束'), errorCode: error?.code ?? 'BATCH_QUARANTINED', results };
  };
  const ownerContext = () => Object.freeze({ owner: acquiredOwner ?? sessionOwner, deadlineAt: Date.now() + localTimeoutMs });
  const releaseWhenSettled = () => {
    if (quarantined === '协调器解锁') return;
    // A timed-out callback can still write; keep its lock until every side effect has actually settled.
    Promise.allSettled([...effects]).then(async () => {
      if (acquired) await withDeadline((async () => release(ownerContext()))(), localTimeoutMs, 'LibTV 隔离批次解锁');
    }).catch(() => {});
  };
  const observe = async control => {
    if (control?.batchId !== batch.batchId) throw new Error('LibTV 控制批次不匹配');
    controller.observe(control);
    if (controller.state.revision > acknowledged) { await local('控制确认', acknowledgeControl, [controller.state, ownerContext()], true); acknowledged = controller.state.revision; }
    return controller.state;
  };
  const permitted = () => !controller.stopped && controller.state && !controller.state.paused && controller.state.version === batch.version && controller.state.phase === batch.phase;
  const invoke = async (tool, args, id) => {
    if (quarantined) throw Object.assign(new Error('LibTV 批次已隔离；禁止继续调用 MCP'), { code: 'BATCH_QUARANTINED' });
    const start = tick();
    activeCalls++; report.peakOutstandingCalls = Math.max(report.peakOutstandingCalls, activeCalls); event(`${tool}-started`, id);
    try { return await withDeadline(call(tool, args), callTimeoutMs); }
    catch (error) {
      if (error?.code === 'CALL_TIMEOUT') { dispatchStopped = 'MCP 调用超时，停止新增并保留原任务身份'; event('call-timeout', id, { tool, timeoutMs: callTimeoutMs }); }
      throw error;
    }
    finally { activeCalls--; event(`${tool}-returned`, id, { durationMs: Math.max(0, tick() - start) }); }
  };
  const persist = async (id, value, options) => {
    const start = tick();
    try { await local('回执写入', writeReceipt, [id, value, { ...options, context: ownerContext() }], true); }
    catch (error) { controller.stop('LibTV 回执写入失败，停止新派发'); throw error; }
    finally { event('receipt-returned', id, { durationMs: Math.max(0, tick() - start) }); }
  };
  const enqueueFinish = async (entry, job, receipt) => {
    // Task success releases remote capacity independently of optional local file delivery.
    if (!finalize) {
      const projectId = job.projectId ?? job.submitArgs?.project_id ?? job.submitArgs?.projectId;
      const verified = validateLibTVTask({ projectId, taskId: receipt.taskId, state: 'succeeded', outputs: receipt.outputs }, { projectId, taskId: receipt.taskId, count: job.count });
      return { id: entry.id, status: 'generated', taskId: verified.taskId, outputs: verified.outputs };
    }
    while (pendingFinalization >= 4) await signal;
    pendingFinalization++;
    report.peakPendingFinalization = Math.max(report.peakPendingFinalization, pendingFinalization);
    states.set(entry.id, { id: entry.id, status: 'generated', taskId: receipt.taskId });
    finishQueue.push({ entry, job, receipt });
    if (!finishRunning) {
      finishRunning = true;
      finishing = Promise.resolve().then(async () => {
        while (finishQueue.length) {
          const item = finishQueue.shift();
          try {
            const start = tick();
            event('finalize-started', item.entry.id);
            let saved;
            try { saved = await local('本地收尾', finalize, [item.job, item.receipt, ownerContext()], true); }
            finally { event('finalize-returned', item.entry.id, { durationMs: Math.max(0, tick() - start) }); }
            if (!Array.isArray(saved?.files) || saved.files.length !== item.job.count) throw new Error('LibTV 收尾未返回实际文件清单');
            const completed = { ...item.receipt, state: 'succeeded', files: saved.files, savedAt: new Date().toISOString() };
            await persist(item.entry.id, completed);
            states.set(item.entry.id, { id: item.entry.id, ...completed, status: 'succeeded' });
            event('saved', item.entry.id);
          } catch (error) {
            // Preserve the generated checkpoint so a restart retries delivery, never generation.
            if (error?.code === 'CALL_TIMEOUT') dispatchStopped = '交付 MCP 调用超时，停止新增并保留原任务身份';
            states.set(item.entry.id, { id: item.entry.id, status: 'generated', taskId: item.receipt.taskId, error: String(error.message ?? error), stage: 'finalize', ...(error?.code === 'CALL_TIMEOUT' ? { errorCode: error.code } : {}) });
          } finally { pendingFinalization--; changed(); }
        }
        finishRunning = false; changed();
      });
    }
    return { deferred: true };
  };
  const work = async entry => {
    let receipt, taskId, prepared;
    try {
      const prepareStart = tick();
      try { prepared = await local('任务准备', prepare, [entry.id, ownerContext()]); }
      finally { event('prepare-returned', entry.id, { durationMs: Math.max(0, tick() - prepareStart) }); }
      await observe(prepared.control);
      const job = prepared.job;
      if (job?.id !== entry.id || job.count !== entry.count || JSON.stringify(job.dependsOn ?? []) !== JSON.stringify(entry.dependsOn ?? []) || job.existingTaskId !== entry.existingTaskId) throw new Error('LibTV 冻结任务身份不匹配');
      const recoveryOnly = 'existingTaskId' in job;
      const tool = job.submitTool ?? 'generation_submit', args = job.submitArgs;
      if (recoveryOnly && (typeof job.existingTaskId !== 'string' || !job.existingTaskId.trim() || job.existingTaskId.length > 500 || /^(?:cop_|data:|https?:)/i.test(job.existingTaskId) || 'submitTool' in job || 'submitArgs' in job)) throw new Error('LibTV 恢复计划身份无效或混入提交参数');
      if (!recoveryOnly && !['generation_submit', 'create_node'].includes(tool)) throw new Error('LibTV 提交工具不受支持');
      const projectId = recoveryOnly ? job.projectId : tool === 'create_node' ? args?.projectId : args?.project_id;
      if (typeof projectId !== 'string' || !projectId.trim() || (batch.projectId && projectId !== batch.projectId)) throw new Error('LibTV 请求未绑定精确项目');
      receipt = prepared.receipt;
      taskId = receipt?.taskId ?? (recoveryOnly ? job.existingTaskId : undefined);
      if (recoveryOnly && (taskId !== job.existingTaskId || receipt?.state === 'submitting')) throw new Error('LibTV 恢复计划不能替换原任务或提交');
      if (job.outputNodeId && ['generated', 'succeeded'].includes(receipt?.state) && !receipt.outputs?.some(output => output.nodeId === job.outputNodeId)) throw new Error('LibTV 实际产物节点与恢复绑定不一致');
      if (['succeeded', 'failed', 'cancelled'].includes(receipt?.state)) return { id: entry.id, ...receipt, status: receipt.state };
      if (receipt?.state === 'generated') return await enqueueFinish(entry, job, receipt);
      if (recoveryOnly && !receipt) {
        receipt = { state: 'pending', taskId, recoveryAttachedAt: new Date().toISOString() };
        await persist(entry.id, receipt, { exclusive: true });
      }
      if (receipt?.state === 'unknown' && !taskId && !recoverUnknownSubmission) {
        dispatchStopped = '旧任务受理状态未知，先恢复原任务';
        return { id: entry.id, status: 'unknown', stage: 'submission', reason: '原任务身份未知；未授权同键恢复' };
      }
      if (!taskId) {
        if (recoveryOnly) throw new Error('LibTV 已有任务只能恢复，禁止提交');
        const recovery = Boolean(receipt);
        if ((!recovery && (!allowNewSubmissions || recoveryPass || dispatchStopped)) || (recovery && !recoverUnknownSubmission) || !permitted()) return { id: entry.id, status: recovery ? 'unknown' : 'paused' };
        if (!recovery && tool === 'generation_submit' && (args?.kind !== 'image' || typeof args?.request?.prompt !== 'string' || !args.request.prompt.trim() || typeof args.request.model !== 'string' || !args.request.model.trim() || typeof args.request.params !== 'object' || Array.isArray(args.request.params) || args.request.params?.count !== 1)) throw new Error('LibTV 新生成请求须明确 kind:image、request.prompt、model 与单张 params 对象；历史请求只恢复原受理任务');
        if (!receipt) {
          receipt = { state: 'submitting', submittedAt: new Date().toISOString() };
          await persist(entry.id, receipt, { exclusive: true });
        }
        await observe(await local('控制读取', readControl, [ownerContext()]));
        // No await between the final control gate and calling the official MCP tool.
        if (!permitted() || (!recovery && dispatchStopped)) return { id: entry.id, status: 'paused' };
        const responsePromise = invoke(tool, args, entry.id);
        if (recovery) report.recoveredSubmissions++; else report.submitted++;
        const response = await responsePromise;
        // task_id is the only durable submission field documented by both generation routes.
        let body = response?.structuredContent ?? response;
        if (response?.content && !response.structuredContent) {
          try { body = JSON.parse(response.content.filter(part => part.type === 'text').map(part => part.text).join('\n')); } catch { body = {}; }
        }
        if (typeof body?.task_id === 'string' && body.task_id.trim() && !body.task_id.startsWith('cop_') && body.task_id.length <= 500) {
          taskId = body.task_id;
          receipt = { ...receipt, taskId, state: 'pending' };
          await persist(entry.id, receipt);
        }
        if (response?.isError) throw new Error('LibTV 提交返回 MCP 错误；先恢复原任务');
        // A submission receipt is not a completed task. Always reconcile via task_status.
        if (!taskId) throw new Error('LibTV 提交回执缺少可恢复的 task_id');
      }
      for (let poll = 0; poll < maxPolls; poll++) {
        await observe(await local('控制读取', readControl, [ownerContext()]));
        // Pausing stops new submissions; accepted tasks continue to drain under their original IDs.
        if (poll) await local('轮询等待', wait, [pollIntervalMs]);
        const response = await invoke('task_status', { project_id: projectId, task_id: taskId }, entry.id);
        report.polls++;
        if (response?.isError) {
          const code = response.content?.filter(part => part.type === 'text').map(part => part.text).join('\n').match(/\bTASK_[A-Z0-9_]{1,80}\b/)?.[0];
          throw new Error(`LibTV 状态回读失败${code ? ': ' + code : ''}`);
        }
        const task = validateLibTVTask(await local('任务解析', normalizeTask, [response, { projectId, taskId, count: job.count }]), { projectId, taskId, count: job.count });
        if (job.outputNodeId && task.state === 'succeeded' && !task.outputs.some(output => output.nodeId === job.outputNodeId)) throw new Error('LibTV 实际产物节点与恢复绑定不一致');
        const next = { ...receipt, taskId, state: task.state === 'succeeded' ? 'generated' : task.state, outputs: task.outputs };
        if (JSON.stringify(next) !== JSON.stringify(receipt)) await persist(entry.id, next);
        receipt = next;
        if (receipt.state === 'generated') return await enqueueFinish(entry, job, receipt);
        if (['failed', 'cancelled'].includes(receipt.state)) return { id: entry.id, ...receipt, status: receipt.state };
      }
      dispatchStopped = '远端任务仍在运行，停止新增并保留原任务容量';
      return { id: entry.id, status: 'pending', taskId, reason: '达到本轮轮询上限；从原任务恢复' };
    } catch (error) {
      const state = { ...receipt, state: 'unknown', ...(taskId ? { taskId } : {}), error: String(error.message ?? error), ...(error?.code === 'CALL_TIMEOUT' ? { errorCode: error.code } : {}) };
      if (receipt) dispatchStopped = '已提交任务终态未知，停止新增并恢复原身份';
      // No receipt before prepare means a local validation/lock failure, not a dispatched task.
      if (receipt && !controller.stopped) {
        try { await persist(entry.id, state); } catch { /* The original checkpoint remains authoritative. */ }
      }
      return { id: entry.id, status: 'unknown', ...(taskId ? { taskId } : {}), error: state.error, ...(state.errorCode ? { errorCode: state.errorCode } : {}) };
    }
  };
  assertRuntimeCapabilities(run, ['toolUse']);
  try {
    const acquisition = Object.freeze({ owner: sessionOwner, deadlineAt: Date.now() + localTimeoutMs });
    await local('协调器认领', async context => { const value = await acquire(context); acquired = true; acquiredOwner = value?.owner ?? sessionOwner; return value; }, [acquisition], true);
    await observe(await local('控制读取', readControl, [ownerContext()]));
    initial = await local('恢复快照', snapshot, [ownerContext()]);
    if (!initial || typeof initial !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(initial)) || Object.entries(initial).some(([id, state]) => !byId.has(id) || !state || typeof state !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(state)) || (state.id !== undefined && state.id !== id) || !['submitting', 'pending', 'unknown', 'generated', 'succeeded', 'failed', 'cancelled'].includes(state.state))) throw new Error('LibTV 恢复快照无效');
    recoveryPass = jobs.some(job => job.existingTaskId && !initialFor(job.id)) || Object.values(initial).some(value => ['submitting', 'pending', 'unknown'].includes(value.state));
    const settled = await runConcurrentJobs(Array.from({ length: Math.min(concurrency, jobs.length) }, (_, id) => id), async () => {
      while (pending.length) {
        for (let i = pending.length - 1; i >= 0; i--) {
          const item = pending[i];
          if ((item.dependsOn ?? []).some(id => states.has(id) && !['succeeded', 'generated'].includes(states.get(id).status))) { pending.splice(i, 1); states.set(item.id, { id: item.id, status: 'blocked' }); }
        }
        if (!pending.length) break;
        const index = pending.findIndex(item => (item.dependsOn ?? []).every(id => states.get(id)?.status === 'succeeded' || (!finalize && states.get(id)?.status === 'generated')));
        const limit = Math.min(concurrency, controller.state?.concurrency ?? concurrency);
        if (index < 0 || activeJobs >= limit) {
          if (!activeJobs && !pendingFinalization) {
            for (const item of pending.splice(0)) states.set(item.id, { id: item.id, status: 'blocked' });
            break;
          }
          await signal; continue;
        }
        const [entry] = pending.splice(index, 1);
        activeJobs++;
        try { const result = await work(entry); if (!result.deferred) states.set(entry.id, result); }
        finally { activeJobs--; changed(); }
      }
    }, { concurrency });
    const rejected = settled.find(item => item.status === 'rejected');
    if (rejected) throw new Error(rejected.reason);
    if (finishing) await finishing;
    await observe(await local('控制读取', readControl, [ownerContext()]));
    report.deliveryAllowed = permitted(); report.stopped = controller.stopped; report.dispatchStopped = dispatchStopped; report.recoveryPass = recoveryPass;
    report.workFinishedAt = new Date().toISOString(); report.workDurationMs = Math.max(0, tick() - started);
    const results = resultsNow();
    return await local('批次汇总', summarize, [results, report, ownerContext()], true);
  } catch (error) {
    if (error?.code === 'CALL_TIMEOUT' || quarantined) return fallback(error);
    throw error;
  } finally {
    if (quarantined) releaseWhenSettled();
    else if (acquired) {
      try { await local('协调器解锁', release, [ownerContext()], true); }
      catch (error) {
        if (error?.code !== 'CALL_TIMEOUT') throw error;
        releaseWhenSettled();
        return fallback(error);
      }
    }
  }
}

export const libtvGenerationHostSource = () => [withDeadline, assertRuntimeCapabilities, runConcurrentJobs, createMediaBatchController, validateLibTVTask, runLibTVGenerationBatch].map(fn => fn.toString()).join('\n\n');

if (typeof process !== 'undefined' && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'host-source') console.log(libtvGenerationHostSource());
  else { console.error('用法：node libtv_generation.mjs host-source（不提交生成）'); process.exitCode = 2; }
}
