import { mediaBatchHostSource, runMediaBatchAndSummarize } from './media_batch.mjs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function createGenerationNodeBridge(nodeExecutable) {
  if (!path.isAbsolute(nodeExecutable ?? '')) throw new Error('须提供本机Node可执行文件的绝对路径');
  const script = fileURLToPath(new URL('./generation_bridge.mjs', import.meta.url));
  return request => new Promise((resolve, reject) => {
    const child = execFile(nodeExecutable, [script], { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      try {
        const response = JSON.parse(stdout);
        if (error || response.ok !== true) throw new Error(response.error || '本地图片存储进程失败');
        resolve(response.value);
      } catch (failure) { reject(new Error(failure instanceof SyntaxError ? '本地图片存储没有返回有效JSON；保留原任务，不重投' : failure.message)); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

// Keep the native tool, durable receipt and replacement submission in one running host cell.
export async function runCodexImageBatch({ directory, prepared, authorizedCount, bridge, generateImage, displayImage, onCaptured, onFinalizationCheck }) {
  if (![bridge, generateImage, displayImage].every(fn => typeof fn === 'function')) throw new Error('Codex图片入口缺少文件桥接、原生生图或同步预览函数');
  if (onCaptured !== undefined && typeof onCaptured !== 'function') throw new Error('回执通知须为函数');
  const call = (operation, ...args) => bridge({ operation, directory, args });
  const initial = await bridge({ operation: 'init', directory, prepared, authorizedCount });
  if (initial.tool !== 'imagegen') throw new Error('Codex图片入口只接受imagegen冻结批次');
  const returned = new Map(), preview = { emitted: 0, errors: [] }, report = {};
  try {
    return await runMediaBatchAndSummarize(initial.jobs, {
      batch: initial.batch, run: initial.run, initialStates: initial.initialStates,
      concurrency: initial.concurrency, finalizeConcurrency: 1, maxPendingFinalization: 4,
      callTimeoutMs: 300000, localTimeoutMs: 120000, report,
      readControl: () => call('readControl'),
      acknowledgeControl: control => call('acknowledgeControl', control),
      prepare: (id, context) => call('prepare', id, context),
      execute: async (job, request) => {
        const result = await generateImage(request);
        returned.set(job.id, result);
        return result;
      },
      capture: async (id, envelope) => {
        const saved = await call('capture', id, envelope);
        if (saved?.persisted === true && saved.id === id && returned.has(id)) {
          const result = returned.get(id);
          returned.delete(id);
          try {
            const emitted = displayImage(result);
            // generatedImage is synchronous; an asynchronous viewer must not block durable saving.
            if (emitted && typeof emitted.then === 'function') {
              Promise.resolve(emitted).catch(() => {});
              throw new Error('预览函数须同步发出原生图片，异步查看不能阻塞队列');
            }
            preview.emitted++;
          } catch (error) { preview.errors.push({ id, error: String(error.message ?? error) }); }
        }
        if (saved?.persisted === true && saved.id === id && envelope.status === 'returned') onCaptured?.(id);
        return saved;
      },
      finalize: id => call('finalize', id),
      reconcileFinalization: id => call('reconcileFinalization', id),
      onFinalizationCheck,
      summarize: async (_results, timing) => ({ ...await call('summarize', { ...timing, preview }), preview })
    });
  } finally { returned.clear(); }
}

export function codexImageHostSource() {
  return mediaBatchHostSource() + '\n' + runCodexImageBatch.toString() + '\n' + runCodexImageStream.toString() + '\n';
}

export async function runCodexImageStream({ directory, bridge, generateImage, displayImage, pollIntervalMs = 250 }) {
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 1000) throw new Error('流水线检查间隔须为10..1000毫秒');
  if (![bridge, generateImage, displayImage].every(fn => typeof fn === 'function')) throw new Error('流水线缺少宿主回调');
  const lease = await bridge({ operation: 'stream-acquire', directory });
  const call = (operation, extra = {}) => bridge({ operation, directory, owner: lease.owner, ...extra });
  const batches = [], submissions = [], readyAt = new Map(), active = new Map();
  let firstUsableStoryboardAt = null, slotBusy = false, halted = null;
  let wake, signal = new Promise(resolve => { wake = resolve; });
  const changed = () => { const previous = wake; signal = new Promise(resolve => { wake = resolve; }); previous(); };
  const checking = new Set();
  let finalization = Promise.resolve();
  const streamBridge = async request => {
    if (['init', 'prepare'].includes(request.operation)) {
      while (checking.size && !halted) await signal;
      if (halted) throw new Error(halted);
    }
    if (request.operation !== 'finalize') return bridge(request);
    // One disk finalizer across all live microbatches, while the generation slot advances.
    const work = finalization.then(() => bridge(request)).then(state => {
      if (!['succeeded', 'failed'].includes(state?.status)) { halted = '本地收尾待核对，停止新增派发'; changed(); }
      return state;
    }, error => { if (!halted) checking.add(request.args[0]); changed(); throw error; });
    finalization = work.catch(() => {});
    return work;
  };
  try {
    while (true) {
      if (slotBusy || active.size >= 4 || checking.size) { await signal; continue; }
      const activeIds = [...active.keys()];
      const snapshot = await call('stream-next', { activeIds });
      if (checking.size || activeIds.some(id => !active.has(id))) continue;
      firstUsableStoryboardAt ??= snapshot.firstUsableStoryboardAt;
      if (halted || snapshot.unknown) {
        if (active.size) { await signal; continue; }
        return await call('stream-summary', { report: { statuses: snapshot.statuses, blocked: snapshot.blocked, unknown: snapshot.unknown, batches, submissions,
          halted: halted ?? '原提交待核对，停止新增派发', firstUsableStoryboardAt,
          firstUsableStoryboardMs: firstUsableStoryboardAt ? Date.parse(firstUsableStoryboardAt) - Date.parse(snapshot.startedAt) : null } });
      }
      if (snapshot.next) {
        const next = snapshot.next;
        if (!readyAt.has(next.id)) readyAt.set(next.id, new Date().toISOString());
        slotBusy = true;
        const work = runCodexImageBatch({ ...next, bridge: streamBridge, displayImage,
          onFinalizationCheck: (id, status, reason) => {
            if (status === 'checking') checking.add(id);
            else checking.delete(id);
            if (status === 'stopped') halted ??= reason;
            changed();
          },
          onCaptured: () => { active.get(next.id).ownsSlot = false; slotBusy = false; changed(); },
          generateImage: async request => {
            while (checking.size) await signal;
            if (halted) throw Object.assign(new Error(halted), { notAccepted: true });
            const submittedAt = new Date().toISOString();
            submissions.push({ id: next.id, readyAndSlotAvailableAt: readyAt.get(next.id), submittedAt,
              waitMs: Date.parse(submittedAt) - Date.parse(readyAt.get(next.id)) });
            return generateImage(request);
          }
        }).then(result => {
          batches.push(result);
          if (result.deliveryAllowed !== true || Object.entries(result.counts).some(([status, count]) => count && !['succeeded', 'failed'].includes(status))) halted ??= '原提交或本地收尾待核对，停止新增派发';
        }, error => { halted = String(error.message ?? error); }).finally(() => {
          // Only the batch that still owns generation may release its slot on failure/recovery.
          if (active.get(next.id)?.ownsSlot) slotBusy = false;
          active.delete(next.id); changed();
        });
        const entry = { work, ownsSlot: true };
        active.set(next.id, entry);
      } else if (snapshot.done && !active.size) {
        return await call('stream-summary', { report: { statuses: snapshot.statuses, blocked: snapshot.blocked, unknown: snapshot.unknown, batches,
          firstUsableStoryboardAt, firstUsableStoryboardMs: firstUsableStoryboardAt ? Date.parse(firstUsableStoryboardAt) - Date.parse(snapshot.startedAt) : null,
          submissions, readinessObservation: 'slot-free snapshot; polling upper bound plus bridge latency', pollIntervalMs } });
      } else {
        let timer;
        try { await Promise.race([signal, new Promise(resolve => { timer = setTimeout(resolve, pollIntervalMs); })]); }
        finally { clearTimeout(timer); }
      }
    }
  } finally {
    halted ??= '流水线结束，停止新增派发';
    await Promise.all([...active.values()].map(entry => entry.work));
    await call('stream-release');
  }
}
