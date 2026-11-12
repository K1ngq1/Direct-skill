import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createLibTVCanvasSession, libtvData, libtvAssetsHostSource } from './libtv_assets.mjs';
import { readCanvasImage, verifyCanvasBatch, libtvReadbackHostSource } from './libtv_canvas_readback.mjs';
import { openLibTVCanvasBridge, libtvCanvasBridgeHostSource } from './libtv_canvas_bridge.mjs';

// Called inside the MCP host. Reviews arrive independently from the image production process.
export async function runLibTVCanvasProduction({ projectId, sources, projectDirectory, planFile, closedFile,
  call, local, independentJobs = false, pollIntervalMs = 1000, startedAt, workflowFile }) {
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
  if (!projectId || !projectDirectory || !planFile || !closedFile || typeof call !== 'function' ||
    ![local?.bridge, local?.transfer, local?.checkLocal].every(fn => typeof fn === 'function') ||
    !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || !Array.isArray(sources) || !sources.length) throw new Error('画布生产入口参数无效');
  const ids = new Set(), keys = new Set();
  for (const source of sources) {
    if (!validId(source.id) || ids.has(source.id) || !source.path || typeof source.pointer !== 'string' ||
      source.pointer && !source.pointer.startsWith('/') || !source.name || !source.uploadKey || keys.has(source.uploadKey)) throw new Error('画布任务缺少唯一身份、看图来源或上传键');
    ids.add(source.id); keys.add(source.uploadKey);
    for (const video of source.videos ?? []) {
      if (!validId(video.id) || ids.has(video.id) || !video.args?.idempotencyKey || keys.has(video.args.idempotencyKey) ||
        video.args.projectId !== projectId || video.args.nodeType !== 'video' || video.args.run !== false ||
        !video.args.model || !video.args.prompt?.trim() || video.args.startFrameNode || video.args.endFrameNode ||
        video.args.referenceImageNodes?.length || /\{\{Node\s/.test(video.args.prompt)) throw new Error('视频节点须冻结唯一身份、目标项目、正文、模型及 run:false，首帧由本项绑定');
      ids.add(video.id); keys.add(video.args.idempotencyKey);
    }
  }
  const pending = new Map(sources.map(source => [source.id, source]));
  const observedAt = Date.now(), batchStart = startedAt === undefined ? observedAt : Date.parse(startedAt);
  if (!Number.isFinite(batchStart) || batchStart > observedAt) throw new Error('本轮开始时间无效');
  const images = [], videos = [], issues = [], usable = [], active = new Set(), returnedTransfers = {};
  let stage = 'doctor', session, pilotPassed = false, halt = false, verifiedAt;
  let readback;
  const stopDispatch = () => { halt = true; session?.setPaused(true); };
  const recordError = (id, stage, error) => issues.push({ id, stage, status: error.status ?? 'blocked', reason: String(error.message ?? error) });
  const read = async (name, args) => libtvData(await call(name, args));
  const saved = async (name, key, args, recover = false) => {
    try { return await session.savedCall(name, key, args, { recover }); }
    catch (error) {
      if (error.pendingSaveKey !== key) throw error;
      // Only reconcile the returned value. recoverSave never invokes the remote operation.
      try { return await session.recoverSave(key); }
      catch (failure) { stopDispatch(); throw failure; }
    }
  };
  const deliver = async (source, item, pilotReady) => {
    let step = 'upload_ticket', subject = item.id;
    try {
      const ticket = await saved(step, item.id + '.ticket', { projectId, file_name: item.fileName, file_size: item.size, sha1_hex: item.sha1 });
      step = 'PUT';
      if (halt) throw new Error('已停止新增传输，保留原票据');
      const proof = await local.transfer({ ...item, projectId }, ticket, { recoverDnsFailure: source.recoverDnsFailure === true });
      if (!Number.isInteger(proof?.status) || proof.status < 200 || proof.status >= 300 || proof.bytes !== item.size || proof.sha256 !== item.sha256) throw new Error('直传缺少匹配本图的完成证明');
      step = 'upload_complete';
      const complete = await saved(step, item.id + '.complete', { path: ticket.path, upload_id: ticket.uploadId });
      step = 'upload_media';
      const uploaded = await saved(step, item.id + '.upload', { projectId, fileRef: complete.file_ref, name: source.name, mediaType: 'image',
        idempotencyKey: source.uploadKey, ...(source.x == null ? {} : { x: source.x }), ...(source.y == null ? {} : { y: source.y }) }, source.recoverReview === true);
      step = 'read_node';
      const image = { id: item.id, nodeId: uploaded.nodeId, resourceId: uploaded.resourceId ?? uploaded.resource.resource_id };
      if (pilotReady) {
        await readCanvasImage(call, projectId, image);
        pilotPassed = true;
        pilotReady();
      }
      images.push(image);
      for (const video of source.videos ?? []) {
        subject = video.id;
        step = 'create_node';
        const marker = '{{Node ' + image.nodeId + '}}';
        const prompt = video.args.prompt.includes('{{START_FRAME}}') ? video.args.prompt.replaceAll('{{START_FRAME}}', marker) : marker + '\n' + video.args.prompt;
        const args = { ...video.args, prompt, startFrameNode: image.nodeId };
        const result = await saved(step, video.id + '.node', args);
        videos.push({ id: video.id, nodeId: result.plan?.nodeId ?? result.operationResult.subjectNodeId, firstFrameNodeId: image.nodeId, args });
      }
    } catch (error) {
      if (step === 'PUT' && error.returned) { returnedTransfers[item.id] = error.returned; stopDispatch(); }
      recordError(subject, step, error);
      if (!pilotPassed || !independentJobs || error.storageFailed) stopDispatch();
    } finally { pilotReady?.(); }
  };
  try {
    const checks = await Promise.allSettled([read('doctor', {}), local.checkLocal()]);
    if (checks[0].status === 'rejected') throw checks[0].reason;
    if (checks[0].value.status !== 'ready') throw new Error('LibTV 身份或连接未就绪');
    stage = 'curl';
    if (checks[1].status === 'rejected') throw checks[1].reason;
    stage = 'target_project';
    if ((await read(stage, { projectId, openInBrowser: false })).projectId !== projectId) throw new Error('目标项目身份不匹配');
    stage = 'receipts';
    session = await createLibTVCanvasSession({ projectId, bridge: local.bridge, call, paused: false, independentJobs });
    stage = 'canvas-ready';
    while (pending.size && !halt) {
      if (active.size >= 4) { await Promise.race(active); continue; }
      const decisions = await local.bridge({ operation: 'canvas-ready', projectDirectory, planFile, closedFile,
        limit: pilotPassed ? 4 - active.size : 1,
        sources: [...pending.values()].map(({ id, path, pointer }) => ({ id, path, pointer })) });
      for (const item of decisions) {
        const source = pending.get(item.id);
        if (!source) throw new Error('看图返回不在冻结任务中');
        if (item.status !== 'usable') {
          pending.delete(item.id);
          issues.push({ id: item.id, stage: 'review', status: item.status, reason: item.error ?? item.status });
          continue;
        }
        while (active.size >= 4) await Promise.race(active);
        if (halt) break;
        pending.delete(item.id);
        usable.push(item);
        let signalPilot;
        const pilot = pilotPassed ? null : new Promise(resolve => { signalPilot = resolve; });
        const work = deliver(source, item, signalPilot).finally(() => active.delete(work));
        active.add(work);
        if (pilot) await pilot;
        if (halt) break;
      }
      if (!decisions.length && !halt) await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  } catch (error) { stopDispatch(); recordError(null, stage, error); }
  await Promise.all(active);
  if (images.length) {
    try { readback = await verifyCanvasBatch(call, projectId, images, videos); verifiedAt = Date.now(); }
    catch (error) { recordError(null, 'canvas-readback', error); }
  }
  const qualified = usable.map(item => Date.parse(item.qualifiedAt)).filter(Number.isFinite);
  const snapshot = session?.snapshot();
  const mounted = images.map(image => Date.parse(snapshot.receipts[image.id + '.upload']?.toolReturnedAt)).filter(Number.isFinite);
  const duration = (a, b) => Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
  const summary = { projectId, startedAt: new Date(batchStart).toISOString(), startSource: startedAt === undefined ? 'first-observation' : 'provided', pilotPassed, images,
    videos: videos.map(({ args, ...item }) => item), issues, remaining: [...pending.keys()], verified: Boolean(verifiedAt),
    usableCount: usable.length, needsChangeCount: issues.filter(issue => issue.status === 'needs-change').length,
    firstQualifiedToMountedMs: duration(Math.min(...qualified), Math.min(...mounted)), lastQualifiedToReadbackMs: duration(Math.max(...qualified), verifiedAt),
    wallMs: Date.now() - batchStart, readback };
  const pendingSaves = snapshot?.pendingSaves;
  const canvasComplete = summary.verified && !pending.size && issues.every(issue => issue.stage === 'review');
  if (workflowFile && canvasComplete) {
    try {
      summary.excel = await local.bridge({ operation: 'canvas-export', projectDirectory, workflowFile });
      if (!summary.excel.exportsUpdated || summary.excel.acceptance !== 'passed') throw new Error(summary.excel.failure?.message ?? '正式工作簿未通过文件验收');
    } catch (error) { recordError(null, 'excel', error); }
  } else if (workflowFile) summary.excel = { exportsUpdated: false, reason: '画布仍有待恢复或待回读的任务' };
  summary.wallMs = Date.now() - batchStart;
  const result = await local.bridge({ operation: 'canvas-summary', summary: { ...summary, pendingSaves, returnedTransfers } });
  return { ...summary, path: result.path };
}

export async function runCodexCanvasProduction({ transport, ...production }) {
  const local = await openLibTVCanvasBridge(transport);
  try { return await runLibTVCanvasProduction({ ...production, local }); }
  finally { await local.close(); }
}

export const canvasProductionHostSource = () => [libtvAssetsHostSource(), libtvReadbackHostSource(),
  libtvCanvasBridgeHostSource(), runLibTVCanvasProduction.toString(), runCodexCanvasProduction.toString()].join('\n\n');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === 'host-source') {
  process.stdout.write(canvasProductionHostSource());
}
