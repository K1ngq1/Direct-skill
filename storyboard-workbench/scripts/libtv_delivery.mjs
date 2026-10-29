import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { libtvData } from './libtv_assets.mjs';
import { withDeadline } from './media_batch.mjs';
import { assertRuntimeCapabilities } from './runtime.mjs';

export function validateLibTVExistingImage(response, { projectId, taskId, nodeId }) {
  const body = libtvData(response), node = body.node, data = node?.data;
  const binding = body.mediaPersistence?.nodes?.find(item => item.nodeId === nodeId);
  if (body.projectId !== projectId || body.nodeId !== nodeId || node?.id !== nodeId || data?.type !== 'image' || data.taskInfo?.taskId !== taskId) throw new Error('LibTV 已有图片的项目、节点或任务身份不匹配');
  if (data.isStale || data.taskInfo.loading !== false || binding?.bindingStatus !== 'present' || binding.readUrlCount !== 1 || !Array.isArray(data.url) || data.url.length !== 1) throw new Error('LibTV 已有图片绑定不可用或不是单张产物');
  // A persisted node binding does not establish the durable Task's terminal state.
  return { projectId, taskId, nodeId, taskState: 'unknown', binding: 'present' };
}

export function validateLibTVImageDelivery(response, job) {
  const body = libtvData(response);
  if (body.projectId !== job.projectId) throw new Error('LibTV 交付项目身份不匹配');
  if (body.status === 'needs_preference' && body.delivery === 'needs_preference') return { state: 'needs_preference', body };
  if (body.status !== 'ready' || body.delivery !== 'awaiting_host_save' || body.fileCount !== 1 || body.files?.length !== 1 || body.sourceValidation !== 'rechecked-after-preparation') throw new Error('LibTV 交付清单尚未就绪；不能使用节点原始链接代替');
  const file = body.files[0];
  if (file.nodeId !== job.nodeId || file.taskId !== job.taskId || file.outputIndex !== 0 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.mime) || typeof file.sourceIdentity !== 'string' || !file.sourceIdentity.trim()) throw new Error('LibTV 交付图片身份或类型不匹配');
  // The tool host has no URL global; the local downloader also parses this URL before use.
  if (typeof file.url !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:[/?#][^\s]*)?$/i.test(file.url)) throw new Error('LibTV 交付须使用有效 HTTPS 授权 URL，不能含账户凭据');
  if (file.contentHash != null && !/^[a-f0-9]{64}$/i.test(file.contentHash)) throw new Error('LibTV 交付字节哈希格式未识别');
  if (job.watermark === 'remove' && (file.derivation?.kind !== 'watermark' || file.derivation.watermark !== false)) throw new Error('LibTV 未确认本次移除水印选择');
  return { state: 'ready', body, file };
}

export async function runLibTVImageDelivery(job, { call, readReceipt, writeReceipt, saveImage, acquire, release: releaseOwnership, assertOwner, callTimeoutMs = 120000, localTimeoutMs = 300000, report = {}, run } = {}) {
  if (![call, readReceipt, writeReceipt, saveImage].every(fn => typeof fn === 'function')) throw new Error('LibTV 图片交付缺少宿主回调');
  const ownership = [acquire, releaseOwnership, assertOwner];
  if (ownership.some(fn => fn !== undefined) && !ownership.every(fn => typeof fn === 'function')) throw new Error('LibTV 图片交付持久锁需要完整的 acquire/release/assertOwner 回调');
  if (![callTimeoutMs, localTimeoutMs].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 2147483647)) throw new Error('LibTV 图片交付调用期限无效');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(job?.id) || !['projectId', 'taskId', 'nodeId', 'idempotencyKey'].every(key => typeof job[key] === 'string' && job[key].trim()) || job.taskId.startsWith('cop_') || !['account', 'keep', 'remove'].includes(job.watermark)) throw new Error('LibTV 图片交付身份或水印选择无效');
  assertRuntimeCapabilities(run, ['toolUse']);
  const active = globalThis[Symbol.for('storyboard-workbench.libtv-delivery.active')] ??= new Map();
  const activeKey = JSON.stringify([job.projectId, job.id.toLowerCase()]), pending = new Set();
  if (active.has(activeKey)) throw Object.assign(new Error('LibTV 原图片交付回调仍在执行；等待其结束后恢复，不能重复调用'), { code: 'LOCAL_CALLBACK_PENDING' });
  const lease = {};
  active.set(activeKey, lease);
  let finished = false, acquired, releasing;
  const context = () => ({ ...(acquired ? { owner: acquired.owner } : {}), deadlineAt: Date.now() + localTimeoutMs });
  const release = () => {
    if (!finished || pending.size || active.get(activeKey) !== lease) return;
    if (!acquired) { active.delete(activeKey); return; }
    if (!releasing) {
      releasing = Promise.resolve().then(() => releaseOwnership(context()));
      releasing.then(() => active.delete(activeKey), () => {});
    }
    return releasing;
  };
  const local = async action => {
    const ownerContext = context();
    const promise = Promise.resolve().then(async () => {
      if (acquired) await assertOwner(ownerContext);
      if (Date.now() >= ownerContext.deadlineAt) throw Object.assign(new Error('LibTV 图片交付回调期限已过，拒绝晚到操作'), { code: 'CALL_TIMEOUT' });
      return action(ownerContext);
    });
    pending.add(promise);
    const settled = () => { pending.delete(promise); release()?.catch(() => {}); };
    promise.then(settled, settled);
    return withDeadline(promise, localTimeoutMs, 'LibTV 本地交付回调');
  };
  try {
    if (acquire) await local(async ownerContext => {
      acquired = await acquire(ownerContext);
      if (typeof acquired?.owner !== 'string' || !acquired.owner.trim()) throw new Error('LibTV 图片交付持久锁缺少 owner');
    });
    const identity = { projectId: job.projectId, taskId: job.taskId, nodeId: job.nodeId, idempotencyKey: job.idempotencyKey };
    const request = { projectId: job.projectId, idempotencyKey: job.idempotencyKey, items: [{ kind: 'media', nodeId: job.nodeId, outputIndex: 0 }], watermark: job.watermark };
    Object.assign(report, { events: [], remoteCalls: 0, generationCalls: 0, uploadCalls: 0, persistentOwnership: Boolean(acquire) });
    const monotonic = typeof globalThis.performance?.now === 'function';
    const clock = () => monotonic ? globalThis.performance.now() : Date.now();
    const timed = async (stage, action) => {
      const started = clock(), at = new Date().toISOString();
      let outcome = 'failed';
      try { const result = await action(); outcome = 'completed'; return result; }
      finally { report.events.push({ stage, at, durationMs: Math.max(0, clock() - started), durationSource: monotonic ? 'monotonic' : 'wall-clock', outcome }); }
    };
    const invoke = async (tool, args) => {
      if (!['read_node', 'prepare_project_delivery', 'get_web_operation_status'].includes(tool)) throw new Error('已有图片交付禁止生成或上传');
      report.remoteCalls++;
      return timed(tool, () => withDeadline(call(tool, args), callTimeoutMs));
    };
    let receipt = await local(ownerContext => readReceipt(job, 'delivery', ownerContext));
    if (receipt && JSON.stringify(receipt.identity) !== JSON.stringify(identity)) throw new Error('LibTV 交付回执身份已变化');
    if (receipt && (receipt.request?.projectId !== job.projectId || receipt.request.idempotencyKey !== job.idempotencyKey || receipt.request.items?.length !== 1 || receipt.request.items[0].kind !== 'media' || receipt.request.items[0].nodeId !== job.nodeId || (receipt.request.items[0].outputIndex ?? 0) !== 0)) throw new Error('LibTV 缓存交付请求身份不匹配');
    const persist = async value => { await timed('receipt', () => local(ownerContext => writeReceipt(job, 'delivery', value, { exclusive: !receipt, context: ownerContext }))); receipt = value; };
    if (receipt && receipt.request.watermark !== job.watermark && !(receipt.state === 'needs_preference' && receipt.request.watermark === 'account' && ['keep', 'remove'].includes(job.watermark))) throw new Error('LibTV 已提交交付的水印选择不能变化');
    if (receipt && !['needs_preference', 'ready', 'saved'].includes(receipt.state)) {
      const operations = [];
      for (const operationId of receipt.operationIds ?? []) {
        const result = libtvData(await invoke('get_web_operation_status', { projectId: job.projectId, operationId }));
        if (result.projectId !== job.projectId || result.operationId !== operationId || result.operation !== 'prepare_delivery_item') throw new Error('LibTV 原交付操作回读身份不匹配');
        operations.push({ operationId, status: result.status });
      }
      if (operations.length) await persist({ ...receipt, operations });
      const error = new Error('LibTV 交付准备结果未知；仅查询原 operationId，不能重复准备或退回原始链接');
      error.operationIds = receipt.operationIds ?? [];
      throw error;
    }
    if (!receipt || receipt.state === 'needs_preference') {
      if (receipt?.state === 'needs_preference' && job.watermark === 'account') return { state: 'needs_preference', files: [], report };
      const source = validateLibTVExistingImage(await invoke('read_node', { projectId: job.projectId, node: job.nodeId }), job);
      await persist({ identity, request, source, state: 'requesting', startedAt: new Date().toISOString() });
      let response;
      try { response = await invoke('prepare_project_delivery', request); }
      catch (error) { throw Object.assign(new Error('LibTV 交付准备响应未知；保留原请求，不自动重发'), error?.code === 'CALL_TIMEOUT' ? { code: error.code } : {}); }
      // Persist the raw private response before interpreting it, including any recovery operation IDs.
      let body;
      try { body = libtvData(response); } catch { body = {}; }
      await persist({ ...receipt, state: 'unknown', response, operationIds: body?.operationIds ?? [] });
      const checked = validateLibTVImageDelivery(response, job);
      await persist({ ...receipt, state: checked.state });
      if (checked.state === 'needs_preference') return { state: 'needs_preference', files: [], report };
    }
    const { file } = validateLibTVImageDelivery(receipt.response, job);
    const saved = await timed('local-file', () => local(ownerContext => saveImage({ id: job.id, url: file.url, mime: file.mime, sourceIdentity: file.sourceIdentity, ...(file.contentHash ? { expectedSha256: file.contentHash } : {}) }, ownerContext)));
    if (typeof saved?.path !== 'string' || !saved.path.trim() || !/^[a-f0-9]{64}$/i.test(saved.sha256 ?? '') || ![saved.bytes, saved.width, saved.height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('LibTV 本地图片缺少字节、哈希或完整解码证据');
    if (file.contentHash && file.contentHash.toLowerCase() !== saved.sha256.toLowerCase()) throw new Error('LibTV 本地图片与交付字节哈希不一致');
    const files = [{ path: saved.path, sha256: saved.sha256, bytes: saved.bytes, width: saved.width, height: saved.height, mime: file.mime }];
    for (const [stage, durationMs] of Object.entries(saved.timings ?? {})) if (Number.isFinite(durationMs) && durationMs >= 0) report.events.push({ stage, durationMs, durationSource: 'monotonic' });
    await persist({ ...receipt, state: 'saved', files, timings: [...report.events], savedAt: new Date().toISOString() });
    return { state: 'saved', files, reused: saved.reused === true, taskState: receipt.source?.taskState ?? 'unknown', watermark: file.derivation ?? null, report };
  } finally { finished = true; const operation = release(); if (operation) await withDeadline(operation, localTimeoutMs, 'LibTV 图片交付解锁'); }
}

export const libtvDeliveryHostSource = () => [withDeadline, assertRuntimeCapabilities, libtvData, validateLibTVExistingImage, validateLibTVImageDelivery, runLibTVImageDelivery].map(fn => fn.toString()).join('\n\n');

if (typeof process !== 'undefined' && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'host-source') console.log(libtvDeliveryHostSource());
  else { console.error('用法：libtv_delivery.mjs host-source（仅交付已有图片）'); process.exitCode = 2; }
}
