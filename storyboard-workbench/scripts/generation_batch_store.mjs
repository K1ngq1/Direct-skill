import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ProjectError } from './project.mjs';
import { validateLocalImage } from './local_image.mjs';
import { digest } from './visual_v2.mjs';
import { localFolder } from './visual_state.mjs';
import { mediaReceipt } from './media_batch.mjs';
import { assertRuntimeCapabilities } from './runtime.mjs';
import { createProcessLock } from './process_lock.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const fail = message => { throw new ProjectError(message, 422); };

function sourceImagePath(source) {
  return typeof source === 'string' ? source : source?.path || source?.outputPath || / as ([^\r\n]+) by default\.(?:\r?\n|$)/u.exec(source?.output_hint ?? '')?.[1];
}

const finalizationLock = (root, id) => createProcessLock(path.join(root, `.image-${id}.lock`));
const pendingImage = (root, id, owner) => path.join(root, 'images', `.${id}-${digest(owner)}.part`);

function saveBatchImage(root, job, source, owner) {
  const sourcePath = sourceImagePath(source);
  if (!sourcePath) fail('imagegen回执中没有可识别的原图路径；保留回执，不能重提生成');
  const extension = path.extname(sourcePath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension) || !fs.statSync(sourcePath).isFile()) fail('返回的原图文件不可用');
  const images = localFolder(root, 'images');
  const output = { path: `images/${job.id}${extension}`, sha256: digest(fs.readFileSync(sourcePath)) };
  const target = path.join(images, job.id + extension);
  if (fs.existsSync(target)) { validateLocalImage(root, output); return output; }
  const temporary = pendingImage(root, job.id, owner);
  try {
    fs.copyFileSync(sourcePath, temporary, fs.constants.COPYFILE_EXCL);
    validateLocalImage(root, { ...output, path: path.relative(root, temporary) });
    const fd = fs.openSync(temporary, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // All batch writers hold the same task lock; existing targets are verified, never replaced.
    if (fs.existsSync(target)) validateLocalImage(root, output);
    else fs.renameSync(temporary, target);
    validateLocalImage(root, output);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return output;
}

function recoverFinalization(root, id, context) {
  const recovered = finalizationLock(root, id).recover(context);
  if (recovered) for (const filename of [pendingImage(root, id, context.owner), path.join(root, 'results', `.${id}-${digest(context.owner)}.tmp`)]) {
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
  }
  return recovered;
}

export function createGenerationBatchStore(directory, jobs, { run } = {}) {
  assertRuntimeCapabilities(run, ['fileRead', 'fileWrite']);
  if (!Array.isArray(jobs) || jobs.some(job => !job || !/^[A-Za-z0-9_-]{1,80}$/.test(job.id) || job.count !== 1) || new Set(jobs.map(job => job.id)).size !== jobs.length) fail('批次须使用唯一任务ID，每任务一张');
  fs.mkdirSync(directory, { recursive: true });
  const root = fs.realpathSync(directory), planFile = path.join(root, 'batch.json');
  const plan = { schemaVersion: 1, jobs };
  if (fs.existsSync(planFile)) {
    if (digest(read(planFile)) !== digest(plan)) fail('批次输入已变化；保留原批次并为新授权另建批次');
  } else fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  const claims = localFolder(root, 'claims'), results = localFolder(root, 'results');
  const inputHashes = new Map(jobs.map(job => [job.id, digest(job)]));
  const jobHash = job => {
    const expected = inputHashes.get(job.id);
    if (!expected || expected !== digest(job)) fail('任务输入与已登记批次不一致');
    return expected;
  };
  const checkRecord = (job, value) => {
    if (value.id !== job.id || value.inputHash !== jobHash(job)) fail('任务记录与Prompt、引用或数量不匹配');
    return value;
  };
  const load = job => {
    jobHash(job);
    const completed = path.join(results, job.id + '.json');
    if (fs.existsSync(completed)) return checkRecord(job, read(completed));
    const claim = path.join(claims, job.id + '.json'), timeout = path.join(claims, job.id + '.timeout.json');
    const original = fs.existsSync(claim) ? checkRecord(job, read(claim)) : null;
    if (!fs.existsSync(timeout)) return original;
    if (!original) fail('任务超时观察缺少原提交登记');
    const observed = checkRecord(job, read(timeout));
    if (observed.status !== 'unknown' || observed.errorCode !== 'CALL_TIMEOUT') fail('任务超时观察状态无效');
    return observed;
  };
  return {
    run,
    load,
    snapshot() {
      return Object.fromEntries(jobs.flatMap(job => {
        const state = load(job);
        if (!state) return [];
        if (!['submitted', 'claimed', 'submitting', 'unknown', 'succeeded', 'failed'].includes(state.status)) fail('批次恢复快照状态无效');
        if (state.status === 'succeeded') validateLocalImage(root, state.output);
        return [[job.id, { id: job.id, status: state.status, ...(state.errorCode ? { errorCode: state.errorCode } : {}) }]];
      }));
    },
    claim(job, state) {
      const inputHash = jobHash(job), filename = path.join(claims, job.id + '.json');
      if (state?.id !== job.id || state.status !== 'submitted') fail('提交登记状态无效');
      const completed = path.join(results, job.id + '.json');
      if (fs.existsSync(completed)) { checkRecord(job, read(completed)); return false; }
      try { fs.writeFileSync(filename, JSON.stringify({ ...state, inputHash }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        checkRecord(job, read(filename));
        return false;
      }
      return true;
    },
    save(job, source) {
      jobHash(job);
      const lock = finalizationLock(root, job.id), context = lock.acquire();
      try { return saveBatchImage(root, job, source, context.owner); }
      finally { lock.release(context); }
    },
    inspectFinalization(id) { if (!inputHashes.has(id)) fail('未知批次任务'); return finalizationLock(root, id).inspect(); },
    recoverFinalization(id, context) { if (!inputHashes.has(id)) fail('未知批次任务'); return recoverFinalization(root, id, context); },
    record(job, state) {
      const inputHash = jobHash(job), filename = path.join(results, job.id + '.json');
      checkRecord(job, read(path.join(claims, job.id + '.json')));
      if (state?.id !== job.id || !['succeeded', 'failed', 'unknown'].includes(state.status)) fail('任务结果状态无效');
      if (state.status === 'succeeded') validateLocalImage(root, state.output);
      const value = { ...state, inputHash };
      // A local deadline cannot seal the original task before its actual response arrives.
      if (state.status === 'unknown' && state.errorCode === 'CALL_TIMEOUT') {
        const timeout = path.join(claims, job.id + '.timeout.json');
        if (fs.existsSync(timeout)) {
          if (digest(checkRecord(job, read(timeout))) !== digest(value)) fail('已有超时观察不能覆盖');
        } else fs.writeFileSync(timeout, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        return value;
      }
      if (fs.existsSync(filename)) {
        if (digest(read(filename)) !== digest(value)) fail('已有逐张结果不能覆盖');
      } else fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      return value;
    }
  };
}

// New execution records never reinterpret or migrate a legacy batch.
export function createGenerationPipelineStore(directory, jobs, { batchId, version, phase, concurrency = 4, run } = {}) {
  assertRuntimeCapabilities(run, ['fileRead', 'fileWrite']);
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
  const phases = ['characters', 'scenes', 'storyboards'];
  if (!validId(batchId) || !validId(version) || !phases.includes(phase) || !Number.isInteger(concurrency) || concurrency < 1) fail('批次身份、版本、阶段或并发数无效');
  jobs = JSON.parse(JSON.stringify(jobs));
  if (!Array.isArray(jobs) || jobs.some(job => !validId(job?.id) || job.count !== 1 || !job.request || typeof job.request.prompt !== 'string' || !job.request.prompt.trim() || (job.attempt !== undefined && (!Number.isSafeInteger(job.attempt) || job.attempt < 1))) || new Set(jobs.map(job => job.id)).size !== jobs.length) fail('流水线任务须包含唯一ID、单张数量及完整请求');
  const byId = new Map(jobs.map(job => [job.id, job]));
  const visit = (job, visiting = new Set(), done = new Set()) => {
    if (done.has(job.id)) return;
    if (visiting.has(job.id)) fail('任务依赖存在循环');
    visiting.add(job.id);
    if (!Array.isArray(job.dependsOn ?? []) || new Set(job.dependsOn ?? []).size !== (job.dependsOn ?? []).length) fail('任务依赖无效');
    for (const id of job.dependsOn ?? []) { if (!byId.has(id)) fail('任务依赖不存在'); visit(byId.get(id), visiting, done); }
    visiting.delete(job.id); done.add(job.id);
  };
  for (const job of jobs) visit(job);
  fs.mkdirSync(directory, { recursive: true });
  const root = fs.realpathSync(directory), planFile = path.join(root, 'batch.json');
  const plan = { schemaVersion: 2, batchId, version, phase, jobs };
  if (fs.existsSync(planFile) && digest(read(planFile)) !== digest(plan)) fail('批次输入或记录版本已变化；不能迁移或覆盖旧批次');
  if (fs.existsSync(planFile) && ['references.json', 'control.json'].some(name => !fs.existsSync(path.join(root, name)))) fail('批次检查点缺失；停止新派发，不能重建控制状态');
  const folders = Object.fromEntries(['claims', 'requests', 'captures', 'results', 'events'].map(name => [name, localFolder(root, name)]));
  const clockId = randomUUID();
  const stamp = () => ({ utc: new Date().toISOString(), monotonicMs: performance.now(), clockId });
  const writeOnce = (filename, value) => {
    const fd = fs.openSync(filename, 'wx');
    try { fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const file = (folder, id) => path.join(folders[folder], `${id}.json`);
  const jobFor = id => { const job = byId.get(typeof id === 'string' ? id : id?.id); if (!job) fail('未知批次任务'); return job; };
  const identity = job => ({ schemaVersion: 2, batchId, version, phase, id: job.id, attempt: job.attempt ?? 1, inputHash: digest(job) });
  const checked = (job, value) => {
    for (const [key, expected] of Object.entries(identity(job))) if (value[key] !== expected) fail('记录与任务身份或输入摘要不一致');
    return value;
  };
  const event = (job, status, extra = {}) => {
    const value = { ...identity(job), status, ...extra, time: stamp() };
    writeOnce(path.join(folders.events, `${job.id}-${randomUUID()}.json`), value);
    return value.time;
  };
  const refs = job => {
    const paths = job.request.referenced_image_paths ?? [];
    if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) fail('参考图须使用真实绝对路径');
    if (job.request.transparent_background !== undefined && typeof job.request.transparent_background !== 'boolean') fail('透明背景参数须为布尔值');
    const recent = job.request.num_last_images_to_include;
    if (recent != null && (!Number.isInteger(recent) || recent < 1 || recent > 5 || paths.length)) fail('最近参考图数量无效或与路径参考冲突');
    return paths;
  };
  for (const job of jobs) refs(job);
  const isDependencyPath = (job, p) => (job.dependsOn ?? []).some(id => path.dirname(p) === path.join(root, 'images') && path.basename(p, path.extname(p)) === id);
  const referenceFile = path.join(root, 'references.json');
  const references = fs.existsSync(referenceFile) ? read(referenceFile) : Object.fromEntries(jobs.map(job => [job.id, refs(job).filter(p => !isDependencyPath(job, p)).map(p => ({ path: p, sha256: digest(fs.readFileSync(p)) }))]));
  if (!fs.existsSync(planFile)) writeOnce(planFile, plan);
  if (!fs.existsSync(referenceFile)) writeOnce(referenceFile, references);
  const controlFile = path.join(root, 'control.json');
  if (!fs.existsSync(controlFile)) writeOnce(controlFile, { batchId, revision: 0, version, phase, paused: false, concurrency, receivedAt: new Date().toISOString() });
  const readControl = () => {
    const revisions = fs.readdirSync(root).filter(name => /^control-\d{8}\.json$/.test(name)).sort();
    const value = read(revisions.length ? path.join(root, revisions.at(-1)) : controlFile);
    if (value.batchId !== batchId || !Number.isSafeInteger(value.revision) || value.revision < 0 || !validId(value.version) || !phases.includes(value.phase) || typeof value.paused !== 'boolean' || !Number.isInteger(value.concurrency) || value.concurrency < 1) fail('执行控制状态无效；停止新派发');
    return value;
  };
  const allowed = control => !control.paused && control.version === version && control.phase === phase;
  const load = id => {
    const job = jobFor(id);
    for (const folder of ['results', 'captures', 'requests', 'claims']) if (fs.existsSync(file(folder, job.id))) return checked(job, read(file(folder, job.id)));
    return null;
  };
  return {
    run,
    jobs: JSON.parse(JSON.stringify(jobs)),
    batch: { batchId, version, phase, directory: root },
    snapshot() {
      return Object.fromEntries(jobs.flatMap(job => {
        const state = load(job.id);
        if (state?.status === 'succeeded') validateLocalImage(root, state.output);
        if (!state) return [];
        const { request, resolvedReferences, ...summary } = state;
        return [[job.id, summary]];
      }));
    },
    readControl, load,
    setControl(change, { receivedAt = new Date().toISOString() } = {}) {
      if (!change || Object.keys(change).some(key => !['version', 'phase', 'paused', 'concurrency'].includes(key))) fail('控制变更字段无效');
      if (!Number.isFinite(Date.parse(receivedAt))) fail('控制指令时间无效');
      const lock = path.join(root, 'control.lock'), fd = fs.openSync(lock, 'wx');
      try {
        const previous = readControl(), next = { ...previous, ...change, revision: previous.revision + 1, receivedAt };
        if (!validId(next.version) || !phases.includes(next.phase) || typeof next.paused !== 'boolean' || !Number.isInteger(next.concurrency) || next.concurrency < 1) fail('控制变更无效');
        writeOnce(path.join(root, `control-${String(next.revision).padStart(8, '0')}.json`), next); return next;
      } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
    },
    acknowledgeControl(control) {
      if (control.batchId !== batchId || !Number.isSafeInteger(control.revision) || !control.observedAt || !control.effectiveAt) fail('控制确认无效');
      const filename = path.join(root, `control-observed-${control.revision}.json`);
      if (!fs.existsSync(filename)) writeOnce(filename, control);
    },
    summarize(results, report) {
      if (!Array.isArray(results) || results.length !== jobs.length || new Set(results.map(item => item.id)).size !== jobs.length) fail('汇总须逐一覆盖批次任务');
      for (const item of results) {
        jobFor(item.id);
        if (item.status === 'succeeded') {
          const saved = load(item.id);
          if (saved?.status !== 'succeeded' || digest(saved.output) !== digest(item.output)) fail('汇总成功项缺少实际保存结果');
          validateLocalImage(root, saved.output);
        }
      }
      const control = readControl(), summaryId = randomUUID(), filename = `summary-${summaryId}.json`;
      const deliveryAllowed = report?.deliveryAllowed === true && allowed(control);
      writeOnce(path.join(root, filename), { schemaVersion: 2, batchId, version, phase, results, report: { ...report, deliveryAllowed }, control, finishedAt: new Date().toISOString() });
      const countsByStatus = new Map();
      for (const item of results) countsByStatus.set(item.status, (countsByStatus.get(item.status) ?? 0) + 1);
      const counts = Object.fromEntries(countsByStatus);
      const images = deliveryAllowed ? results.filter(item => item.status === 'succeeded').map(item => ({ id: item.id, path: path.resolve(root, item.output.path) })) : [];
      const deliveryPath = path.join(root, `delivery-${summaryId}.md`);
      const note = deliveryAllowed ? '本索引仅完成文件核验，不代表画质审核或用户确认。画面检查、用户确认请查看项目独立记录。' : '当前控制不允许交付；保留内部记录，不交付旧阶段图片。';
      writeOnce(deliveryPath, [
        '# 图片批次交付索引', '', `批次：${batchId} / ${version} / ${phase}`, '',
        `任务状态：${JSON.stringify(counts)}`, '', note, '',
        ...images.flatMap(item => [`### ${item.id}`, '', `![${item.id}](<${item.path.replaceAll('\\', '/')}>)`, '', `[原件](<${item.path.replaceAll('\\', '/')}>)`, '']), ''
      ].join('\n'));
      return { path: filename, deliveryAllowed, deliveryPath: deliveryAllowed ? deliveryPath : null, counts, images };
    },
    prepare(id, context = {}) {
      const job = jobFor(id), started = stamp();
      let control = readControl();
      const existing = load(id);
      if (existing) {
        if (existing.status === 'succeeded') validateLocalImage(root, existing.output);
        return { action: existing.status === 'returned' ? 'finalize' : 'skip', state: existing, control };
      }
      if (!allowed(control)) return { action: 'paused', control };
      for (const dep of job.dependsOn ?? []) {
        const state = load(dep);
        if (state?.status !== 'succeeded') return { action: 'blocked', control };
        validateLocalImage(root, state.output);
      }
      const resolvedReferences = refs(job).map(p => {
        const sha256 = digest(fs.readFileSync(p));
        const frozen = references[job.id]?.find(ref => ref.path === p);
        if (!isDependencyPath(job, p) && (!frozen || frozen.sha256 !== sha256)) fail('固定参考图已变化');
        if (isDependencyPath(job, p)) {
          const dep = (job.dependsOn ?? []).find(dep => path.basename(p, path.extname(p)) === dep), state = load(dep);
          if (fs.realpathSync(p) !== fs.realpathSync(path.resolve(root, state.output.path)) || sha256 !== state.output.sha256) fail('依赖参考图与已保存结果不一致');
        }
        return { path: p, sha256 };
      });
      try { writeOnce(file('claims', job.id), { ...identity(job), status: 'claimed', readyAt: context.readyAt ?? null, claimedAt: started.utc }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; return { action: 'skip', state: load(id), control }; }
      control = readControl();
      if (!allowed(control)) { event(job, 'paused'); return { action: 'paused', control }; }
      const preparedAt = stamp();
      const request = { ...identity(job), status: 'submitting', request: job.request, resolvedReferences, preparedAt, prepareMs: preparedAt.monotonicMs - started.monotonicMs, readyAt: context.readyAt ?? null, claimedAt: started.utc, serverReceivedAt: null, serverQueueMs: null };
      writeOnce(file('requests', job.id), request);
      return { action: 'execute', request: JSON.parse(JSON.stringify(job.request)), control, identity: identity(job) };
    },
    capture(id, envelope) {
      const job = jobFor(id), request = checked(job, read(file('requests', job.id)));
      if (!['returned', 'failed', 'unknown'].includes(envelope?.status)) fail('工具回执状态无效');
      const filename = file('captures', job.id);
      const payloadHash = digest(envelope);
      if (fs.existsSync(filename)) { const old = checked(job, read(filename)); if (old.payloadHash !== payloadHash) fail('同一尝试收到冲突回执'); return old; }
      const receipt = mediaReceipt(envelope.receipt);
      const sourcePath = sourceImagePath(receipt) ?? null;
      const value = { ...identity(job), status: envelope.status, stage: envelope.stage ?? 'execute', error: envelope.error ?? null, receipt, sourcePath, payloadHash, readyAt: request.readyAt, claimedAt: request.claimedAt, prepareMs: request.prepareMs, callStartedAt: envelope.callStartedAt, toolReturnedAt: envelope.toolReturnedAt, capturedAt: stamp(), originalAvailableAt: sourcePath && fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile() ? stamp() : null, serverReceivedAt: null, serverQueueMs: null, durationSource: 'host-utc-events; local-monotonic-checkpoints', persisted: true };
      // A local deadline is an observation, not an immutable terminal tool receipt.
      if (envelope.status === 'unknown' && envelope.errorCode === 'CALL_TIMEOUT') {
        const timeout = { ...value, errorCode: 'CALL_TIMEOUT', waitEndedAt: envelope.waitEndedAt };
        event(job, 'wait-expired', { observation: timeout });
        return timeout;
      }
      writeOnce(filename, value);
      return value;
    },
    finalize(id, { recoverSave = false } = {}) {
      const job = jobFor(id), filename = file('results', job.id);
      const lock = finalizationLock(root, id);
      let context;
      try { context = lock.acquire(); }
      catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('原进程仍持有图片收尾锁；不能重复收尾'), { code: 'FINALIZE_PENDING' }); throw error; }
      try {
      if (fs.existsSync(filename)) {
        const old = checked(job, read(filename));
        if (old.status === 'succeeded') validateLocalImage(root, old.output);
        if (!recoverSave || old.status !== 'unknown' || old.stage !== 'save') return old;
        event(job, 'save-recovery', { previous: old });
        fs.unlinkSync(filename);
      }
      const captured = checked(job, read(file('captures', job.id)));
      const start = event(job, 'finalizing');
      let state = captured;
      if (captured.status === 'returned') {
        try { state = { ...captured, status: 'succeeded', stage: 'finalize', output: saveBatchImage(root, job, captured.sourcePath, context.owner) }; }
        catch (error) { state = { ...captured, status: 'unknown', stage: 'save', error: String(error.message ?? error) }; }
      }
      const finished = stamp();
      state = { ...state, finishedAt: finished.utc, savedAt: state.status === 'succeeded' ? finished : null, finalizeMs: finished.monotonicMs - start.monotonicMs };
      const temporary = path.join(folders.results, `.${id}-${digest(context.owner)}.tmp`);
      try { writeOnce(temporary, state); fs.renameSync(temporary, filename); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      return state;
      } finally { lock.release(context); }
    },
    inspectFinalization(id) { jobFor(id); return finalizationLock(root, id).inspect(); },
    recoverFinalization(id, context) { jobFor(id); return recoverFinalization(root, id, context); }
  };
}

