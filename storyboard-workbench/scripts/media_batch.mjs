import { assertRuntimeCapabilities } from './runtime.mjs';

export function mediaReceipt(result) {
  return Object.fromEntries(['task_id', 'taskId', 'id', 'output_hint', 'path', 'outputPath', 'image_url'].flatMap(key => {
    const value = result?.[key];
    return typeof value === 'string' && value.length <= 4000 && !value.startsWith('data:') ? [[key, value]] : [];
  }));
}

export async function withDeadline(promise, timeoutMs, label = '工具调用') {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('调用期限须为1..2147483647毫秒');
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label}等待超过${timeoutMs}毫秒；远端结果仍未知`), { code: 'CALL_TIMEOUT' })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export async function runConcurrentJobs(jobs, worker, { concurrency = 4 } = {}) {
  if (!Array.isArray(jobs) || typeof worker !== 'function' || !Number.isInteger(concurrency) || concurrency < 1) throw new Error('任务数组、worker或并发数无效');
  const results = new Array(jobs.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const index = cursor++;
      try { results[index] = { status: 'fulfilled', value: await worker(jobs[index], index) }; }
      catch (error) { results[index] = { status: 'rejected', reason: String(error?.message ?? error) }; }
    }
  }));
  return results;
}

export async function runMediaBatch(jobs, options = {}) {
  if (options.prepare) return runMediaPipeline(jobs, options);
  assertRuntimeCapabilities(options.run, ['toolUse']);
  const { concurrency = 4, claim, execute, save, record, initialStates, snapshot, callTimeoutMs = 300000, localTimeoutMs = 30000 } = options;
  if (!Array.isArray(jobs) || jobs.some(job => !job || !/^[A-Za-z0-9_-]{1,80}$/.test(job.id)) || new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error('生成任务ID无效或重复');
  if ([claim, execute, save, record].some(callback => typeof callback !== 'function')) throw new Error('生成任务缺少claim/execute/save/record回调');
  if (![callTimeoutMs, localTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647)) throw new Error('调用期限无效');
  if (snapshot !== undefined && typeof snapshot !== 'function') throw new Error('批次恢复snapshot回调无效');
  const initial = initialStates !== undefined ? initialStates : snapshot ? await withDeadline(snapshot(), localTimeoutMs, '批次恢复快照') : {};
  const ids = new Set(jobs.map(job => job.id));
  if (!initial || typeof initial !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(initial)) || Object.entries(initial).some(([id, state]) => !ids.has(id) || !state || typeof state !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(state)) || (state.id !== undefined && state.id !== id) || !['submitted', 'claimed', 'submitting', 'unknown', 'succeeded', 'failed'].includes(state.status))) throw new Error('批次恢复快照的任务身份或状态无效');
  let dispatchStopped = Object.values(initial).some(state => ['submitted', 'claimed', 'submitting', 'unknown'].includes(state.status)) ? '已有未明任务；先核对原任务' : null;
  const settled = await runConcurrentJobs(jobs, async job => {
    if (Object.hasOwn(initial, job.id)) return { id: job.id, status: 'skipped', originalStatus: initial[job.id].status, reason: '已登记任务；保留原结果或原任务身份' };
    if (dispatchStopped) return { id: job.id, status: 'paused', reason: dispatchStopped };
    const submitted = { id: job.id, status: 'submitted', submittedAt: new Date().toISOString() };
    let claimed;
    try { claimed = await withDeadline(claim(job, submitted), localTimeoutMs, '任务登记'); }
    catch (error) {
      dispatchStopped = '任务登记结果未知；先核对原任务';
      return { id: job.id, status: 'unknown', stage: 'claim', error: String(error?.message ?? error), ...(error?.code === 'CALL_TIMEOUT' ? { errorCode: error.code } : {}), persisted: false };
    }
    if (claimed !== true) return { id: job.id, status: 'skipped' };
    if (dispatchStopped) return { ...submitted, status: 'paused', stage: 'dispatch', claimed: true, executed: false, reason: '同批任务结果未明；本任务已登记但未调用生成工具' };
    let state, result, receipt;
    try {
      result = await withDeadline(execute(job), callTimeoutMs);
      receipt = mediaReceipt(result);
    } catch (error) {
      const message = String(error?.message ?? error);
      const rejected = error?.status === 'failed' || error?.notAccepted === true || /"code"\s*:\s*"moderation_blocked"/u.test(message.replace(/\\"/g, '"'));
      if (!rejected) dispatchStopped = '已有任务受理结果未知；先核对原任务';
      state = { status: rejected ? 'failed' : 'unknown', stage: 'execute', error: message, ...(error?.code === 'CALL_TIMEOUT' ? { errorCode: error.code } : {}) };
    }
    if (!state) {
      try {
        const output = await withDeadline(save(job, result), localTimeoutMs, '图片保存');
        if (typeof output?.path !== 'string' || !/^[a-f0-9]{64}$/i.test(output.sha256 ?? '')) throw new Error('保存回调未返回实际图片路径和SHA256');
        state = { status: 'succeeded', output, receipt };
      } catch (error) {
        if (error?.code === 'CALL_TIMEOUT') dispatchStopped = '图片保存超时；先核对原结果';
        state = { status: 'unknown', stage: 'save', error: String(error?.message ?? error), receipt, ...(error?.code === 'CALL_TIMEOUT' ? { errorCode: error.code } : {}) };
      }
    }
    state = { ...submitted, ...state, finishedAt: new Date().toISOString() };
    try { await withDeadline(record(job, state), localTimeoutMs, '任务记录'); }
    catch (error) {
      if (error?.code === 'CALL_TIMEOUT') dispatchStopped = '任务记录超时；先核对原结果';
      return { ...state, status: 'unknown', stage: 'record', persistenceError: String(error?.message ?? error), ...(error?.code === 'CALL_TIMEOUT' ? { errorCode: error.code } : {}), persisted: false };
    }
    return { ...state, persisted: true };
  }, { concurrency });
  return settled.map((entry, index) => entry.status === 'fulfilled' ? entry.value : { id: jobs[index].id, status: 'unknown', error: entry.reason, persisted: false });
}

export async function runMediaBatchAndSummarize(jobs, { summarize, report = {}, ...options } = {}) {
  if (typeof summarize !== 'function') throw new Error('批次缺少自动收尾summarize回调');
  const results = await runMediaBatch(jobs, { ...options, report });
  try { return await withDeadline(summarize(results, report), options.localTimeoutMs ?? 30000, '批次汇总'); }
  catch (error) {
    if (error?.code !== 'CALL_TIMEOUT') throw error;
    let deliveryAllowed = false;
    if (report.deliveryAllowed === true && options.batch && typeof options.readControl === 'function') {
      try {
        const control = await withDeadline(options.readControl(), options.localTimeoutMs ?? 30000, '交付控制复核');
        deliveryAllowed = control?.batchId === options.batch.batchId && control.version === options.batch.version && control.phase === options.batch.phase && control.paused === false;
      } catch { /* Without current control evidence only task identities can be handed off. */ }
    }
    const counts = {}, tasks = results.map(item => {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
      return { id: item.id, status: item.status, ...(deliveryAllowed && item.status === 'succeeded' && item.persisted === true ? { output: item.output } : {}) };
    });
    return { summaryPersisted: false, recoveryRequired: true, errorCode: error.code, error: String(error.message), deliveryAllowed, directory: options.batch?.directory ?? null, counts, tasks };
  }
}

export function mediaBatchHostSource() {
  return [assertRuntimeCapabilities, mediaReceipt, withDeadline, runConcurrentJobs, runMediaBatch, runMediaBatchAndSummarize, createMediaBatchController, runMediaPipeline].map(fn => fn.toString()).join('\n\n') + '\n';
}

export function createMediaBatchController() {
  let state = null, stopped = null;
  return {
    get state() { return state; },
    get stopped() { return stopped; },
    stop(reason) { stopped = String(reason); },
    observe(control) {
      if (!control || !Number.isSafeInteger(control.revision) || control.revision < 0 || typeof control.paused !== 'boolean' || !Number.isInteger(control.concurrency) || control.concurrency < 1 || !control.batchId || !control.version || !['characters', 'scenes', 'storyboards'].includes(control.phase)) throw new Error('调度控制状态无效');
      if (state && state.batchId !== control.batchId) throw new Error('调度控制批次不匹配');
      if (state && control.revision === state.revision && ['version', 'phase', 'paused', 'concurrency'].some(key => state[key] !== control[key])) throw new Error('同一控制版本包含冲突内容');
      if (state && control.revision <= state.revision) return null;
      const at = new Date().toISOString();
      state = Object.freeze({ ...control, observedAt: at, effectiveAt: at });
      return state;
    }
  };
}

export async function runMediaPipeline(inputJobs, {
  prepare, execute, capture, finalize, readControl, acknowledgeControl,
  batch, initialStates, snapshot, concurrency = 4, finalizeConcurrency = 1, maxPendingFinalization = 4,
  callTimeoutMs = 300000, localTimeoutMs = 30000,
  controller = createMediaBatchController(), report = {}, run
} = {}) {
  assertRuntimeCapabilities(run, ['toolUse']);
  if (![prepare, execute, capture, finalize, readControl, acknowledgeControl].every(fn => typeof fn === 'function')) throw new Error('流水线缺少prepare/execute/capture/finalize或控制回调');
  if (!batch?.batchId || !batch.version || !['characters', 'scenes', 'storyboards'].includes(batch.phase)) throw new Error('流水线缺少冻结批次身份');
  if (![concurrency, finalizeConcurrency, maxPendingFinalization].every(n => Number.isInteger(n) && n > 0)) throw new Error('流水线并发数或收尾上限无效');
  if (![callTimeoutMs, localTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647)) throw new Error('调用期限无效');
  const jobs = JSON.parse(JSON.stringify(inputJobs));
  if (!Array.isArray(jobs) || jobs.some(job => !job || !/^[A-Za-z0-9_-]{1,80}$/.test(job.id)) || new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error('生成任务ID无效或重复');
  const byId = new Map(jobs.map(job => [job.id, job]));
  if (snapshot !== undefined && typeof snapshot !== 'function') throw new Error('批次恢复snapshot回调无效');
  initialStates = initialStates !== undefined ? initialStates : snapshot ? await withDeadline(snapshot(), localTimeoutMs, '批次恢复快照') : {};
  if (!initialStates || typeof initialStates !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(initialStates)) || Object.entries(initialStates).some(([id, value]) => !byId.has(id) || !value || typeof value !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(value)) || (value.id !== undefined && value.id !== id) || !['claimed', 'submitting', 'submitted', 'pending', 'returned', 'succeeded', 'failed', 'unknown', 'paused', 'blocked'].includes(value.status))) throw new Error('流水线恢复快照无效');
  const initialFor = id => Object.hasOwn(initialStates, id) ? initialStates[id] : undefined;
  const checked = new Set(), visiting = new Set();
  const checkDependencies = id => {
    if (visiting.has(id)) throw new Error('任务依赖存在循环');
    if (checked.has(id)) return;
    visiting.add(id);
    const deps = byId.get(id).dependsOn ?? [];
    if (!Array.isArray(deps) || new Set(deps).size !== deps.length || deps.some(dep => !byId.has(dep))) throw new Error('任务依赖无效');
    for (const dep of deps) checkDependencies(dep);
    visiting.delete(id); checked.add(id);
  };
  for (const job of jobs) checkDependencies(job.id);
  const descendants = id => {
    const seen = new Set();
    const visit = parent => { for (const job of jobs) if ((job.dependsOn ?? []).includes(parent) && !seen.has(job.id)) { seen.add(job.id); visit(job.id); } };
    visit(id); return seen.size;
  };
  const priorities = new Map(jobs.map(job => [job.id, descendants(job.id)]));
  const pending = jobs.filter(job => !initialFor(job.id)).sort((a, b) => priorities.get(b.id) - priorities.get(a.id));
  const states = new Map(), generating = new Set(), finishing = new Set(), queue = [];
  const recovery = jobs.filter(job => initialFor(job.id)?.status === 'returned');
  // A timed-out callback still owns its side effects until the original promise settles.
  const finalizers = globalThis[Symbol.for('storyboard-workbench.pending-image-finalizers')] ??= new Map();
  const finalizerKey = id => JSON.stringify([batch.directory ?? null, batch.batchId, batch.version, batch.phase, id]);
  let dispatchStopped = Object.values(initialStates).some(state => ['claimed', 'submitting', 'submitted', 'pending', 'unknown'].includes(state.status)) ? '存在未明的原任务；仅恢复已返回结果，停止新提交' : null;
  if (jobs.some(job => finalizers.has(finalizerKey(job.id)))) dispatchStopped = '原收尾回调尚未结束；停止新提交';
  for (const job of jobs) if (initialFor(job.id) && initialFor(job.id).status !== 'returned') states.set(job.id, initialFor(job.id));
  const now = () => new Date().toISOString();
  const monotonic = typeof performance !== 'undefined' && typeof performance.now === 'function';
  const tick = () => monotonic ? performance.now() : Date.now();
  const start = tick();
  Object.assign(report, { bridgeCalls: 0, controlCalls: 0, peakGeneration: 0, peakOutstandingCalls: 0, observedToolExecutionPeak: null, peakPendingFinalization: 0, peakFinalizing: 0, generationBusyMs: 0, events: [], durationSource: monotonic ? 'monotonic' : 'utc-estimate' });
  const emit = (type, id, extra = {}) => report.events.push({ type, id, at: now(), elapsedMs: tick() - start, ...extra });
  const readyTimes = new Map();
  let wake, signal = new Promise(resolve => { wake = resolve; }), reservations = 0, inFlight = 0, preparing = 0;
  const changed = () => { const resolve = wake; signal = new Promise(done => { wake = done; }); resolve(); };
  let acknowledgedRevision = -1;
  const observe = async value => {
    controller.observe(value);
    const observed = controller.state;
    if (observed.revision > acknowledgedRevision) { acknowledgedRevision = observed.revision; report.controlCalls++; await withDeadline(acknowledgeControl(observed), localTimeoutMs, '控制确认'); emit('control-effective', null, observed); }
  };
  const expected = batch;
  try { report.controlCalls++; const initial = await withDeadline(readControl(), localTimeoutMs, '控制读取'); if (initial.batchId !== batch.batchId) throw new Error('批次控制身份不匹配'); await observe(initial); }
  catch (error) { controller.stop(error.message ?? error); }
  const permitted = () => !controller.stopped && controller.state && !controller.state.paused && controller.state.version === expected?.version && controller.state.phase === expected?.phase;
  const call = async (callback, ...args) => { report.bridgeCalls++; return withDeadline(callback(...args), localTimeoutMs, '本地任务记录'); };
  const finish = async job => {
    try {
      const key = finalizerKey(job.id);
      if (finalizers.has(key)) throw Object.assign(new Error('原收尾回调尚未结束，不能重复收尾'), { code: 'FINALIZE_PENDING' });
      report.bridgeCalls++;
      const pending = Promise.resolve().then(() => finalize(job.id));
      finalizers.set(key, pending);
      const settled = () => { if (finalizers.get(key) === pending) finalizers.delete(key); };
      pending.then(settled, settled);
      const state = await withDeadline(pending, localTimeoutMs, '图片收尾');
      if (state?.id !== job.id || state.persisted !== true || !['succeeded', 'failed', 'unknown'].includes(state.status) || (state.status === 'succeeded' && (typeof state.output?.path !== 'string' || !/^[a-f0-9]{64}$/i.test(state.output.sha256 ?? '')))) throw new Error('收尾回调未返回已持久化的实际结果');
      states.set(job.id, state); emit('finalized', job.id, { status: state.status });
    }
    catch (error) { states.set(job.id, { id: job.id, status: 'unknown', stage: 'finalize', persisted: false, error: String(error.message ?? error), ...(error?.code ? { errorCode: error.code } : {}) }); dispatchStopped = '收尾记录未完成；先核对原回执'; }
  };
  const generate = async (job, token) => {
    let envelope, reserved = false, preparingThisJob = true;
    preparing++;
    const dispatchDone = () => { if (preparingThisJob) { preparingThisJob = false; preparing--; changed(); } };
    try {
      const readyAt = readyTimes.get(job.id); emit('prepare-started', job.id);
      const prepared = await call(prepare, job.id, { readyAt });
      await observe(prepared.control);
      if (prepared.action === 'skip') {
        states.set(job.id, prepared.state);
        if (['claimed', 'submitting', 'submitted', 'pending', 'unknown'].includes(prepared.state?.status)) dispatchStopped = '存在未明的原任务；停止新提交';
        return;
      }
      if (prepared.action === 'paused' || prepared.action === 'blocked') { states.set(job.id, { id: job.id, status: prepared.action }); return; }
      if (prepared.action === 'finalize') {
        dispatchDone();
        while (queue.length + reservations >= maxPendingFinalization) await signal;
        queue.push(job); return;
      }
      if (prepared.action !== 'execute') throw new Error('任务准备返回未知操作');
      // No await between this gate and invoking the tool: a stale prepare cannot dispatch after an observed pause.
      if (!permitted() || dispatchStopped) { states.set(job.id, { id: job.id, status: 'paused' }); return; }
      const callStartedAt = now(), began = tick();
      // Outstanding promises do not measure tool execution or server compute concurrency.
      inFlight++; report.peakOutstandingCalls = report.peakGeneration = Math.max(report.peakGeneration, inFlight); emit('call-started', job.id);
      try {
        const response = execute(job, prepared.request);
        dispatchDone();
        const result = await withDeadline(response, callTimeoutMs);
        envelope = { status: 'returned', receipt: mediaReceipt(result), callStartedAt, toolReturnedAt: now() };
      } catch (error) {
        const message = String(error.message ?? error);
        const rejected = error.status === 'failed' || error.notAccepted === true || /"code"\s*:\s*"moderation_blocked"/u.test(message.replace(/\\"/g, '"'));
        if (!rejected) dispatchStopped = '工具受理结果未明；停止新提交，先核对原任务';
        // A deadline ends local waiting, not remote execution; late results cannot mutate this run.
        envelope = { status: rejected ? 'failed' : 'unknown', stage: 'execute', error: message, callStartedAt, toolReturnedAt: error.code === 'CALL_TIMEOUT' ? null : now(), ...(error.code === 'CALL_TIMEOUT' ? { errorCode: error.code, waitEndedAt: now() } : {}) };
      } finally { dispatchDone(); inFlight--; report.generationBusyMs += tick() - began; }
      emit(envelope.errorCode === 'CALL_TIMEOUT' ? 'call-timeout' : 'tool-returned', job.id);
      // Returned tools retain their slot while the bounded receipt/finalization queue is full.
      while (queue.length + reservations >= maxPendingFinalization) await signal;
      reservations++; reserved = true;
      try {
        const receipt = await call(capture, job.id, envelope);
        if (receipt?.id !== job.id || receipt.persisted !== true) throw new Error('回执回调未确认持久化');
        if (envelope.errorCode === 'CALL_TIMEOUT') {
          states.set(job.id, { ...receipt, id: job.id, status: 'unknown', stage: 'execute', errorCode: 'CALL_TIMEOUT' });
          return;
        }
      }
      catch (error) {
        controller.stop('回执持久化失败；停止新派发');
        states.set(job.id, { id: job.id, ...envelope, status: 'unknown', stage: 'capture', persisted: false, persistenceError: String(error.message ?? error) });
        return;
      }
      queue.push(job); report.peakPendingFinalization = Math.max(report.peakPendingFinalization, queue.length); emit('captured', job.id);
    } catch (error) {
      controller.stop(error.message ?? error);
      states.set(job.id, { id: job.id, status: 'unknown', stage: 'prepare', persisted: false, error: String(error.message ?? error), ...(envelope ? { receipt: envelope.receipt } : {}) });
    } finally { generating.delete(token); if (reserved) reservations--; dispatchDone(); }
  };
  const launch = (set, work) => {
    const token = {};
    set.add(token);
    work(token).finally(() => { set.delete(token); changed(); });
  };
  while (pending.length || generating.size || finishing.size || queue.length || recovery.length) {
    while (recovery.length && queue.length + reservations < maxPendingFinalization) queue.push(recovery.shift());
    report.peakPendingFinalization = Math.max(report.peakPendingFinalization, queue.length);
    for (let index = pending.length - 1; index >= 0; index--) {
      const job = pending[index];
      const failedDependency = (job.dependsOn ?? []).some(dep => states.has(dep) && states.get(dep).status !== 'succeeded');
      if (failedDependency) { pending.splice(index, 1); states.set(job.id, { id: job.id, status: 'blocked', stage: 'dependency' }); }
      else if (!readyTimes.has(job.id) && (job.dependsOn ?? []).every(dep => states.get(dep)?.status === 'succeeded')) { readyTimes.set(job.id, now()); emit('ready', job.id); }
    }
    while (permitted() && !dispatchStopped && generating.size < controller.state.concurrency && queue.length + reservations < maxPendingFinalization) {
      const index = pending.findIndex(job => (job.dependsOn ?? []).every(dep => states.get(dep)?.status === 'succeeded'));
      if (index < 0) break;
      const [job] = pending.splice(index, 1); launch(generating, token => generate(job, token));
    }
    // Prioritize replacement submissions before sending copy work through a serialized host bridge.
    while (!preparing && queue.length && finishing.size < finalizeConcurrency) {
      const job = queue.shift(); launch(finishing, () => finish(job));
      report.peakFinalizing = Math.max(report.peakFinalizing, finishing.size); changed();
    }
    if (!generating.size && !finishing.size && !queue.length && !recovery.length) break;
    await signal;
  }
  for (const job of pending) states.set(job.id, { id: job.id, status: permitted() && !dispatchStopped ? 'blocked' : 'paused', reason: controller.stopped ?? dispatchStopped });
  try { report.controlCalls++; await observe(await withDeadline(readControl(), localTimeoutMs, '控制读取')); }
  catch (error) { controller.stop(error.message ?? error); }
  report.totalMs = tick() - start;
  report.nextSubmissionAfterCaptureMs = report.events.flatMap((event, index) => {
    if (event.type !== 'captured') return [];
    const next = report.events.slice(index + 1).find(candidate => candidate.type === 'call-started');
    return next ? [next.elapsedMs - event.elapsedMs] : [];
  });
  report.stopped = controller.stopped;
  report.dispatchStopped = dispatchStopped;
  report.deliveryAllowed = permitted();
  return jobs.map(job => ({ id: job.id, ...states.get(job.id) }));
}
