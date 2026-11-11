import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runConcurrentJobs } from './media_batch.mjs';
import { createProcessLock } from './process_lock.mjs';

export function libtvData(response) {
  if (response?.isError) throw Object.assign(new Error(response.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') || 'LibTV MCP 返回错误'), { status: 'failed' });
  if (response?.structuredContent) return response.structuredContent;
  if (Array.isArray(response?.content)) {
    const text = response.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    try { return JSON.parse(text); } catch { throw new Error('LibTV 回执不是可解析的 JSON'); }
  }
  if (!response || typeof response !== 'object') throw new Error('LibTV 回执无效');
  return response;
}

export async function discoverLibTVAssets({ projectId, scope, folderIds }, call) {
  if (typeof call !== 'function' || !projectId || !['personal', 'team'].includes(scope) || !Array.isArray(folderIds) || folderIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('LibTV 发现请求无效');
  const folders = [...new Set(folderIds)];
  const results = await runConcurrentJobs(folders, async folderId => {
    const context = { projectId, scope }, detail = libtvData(await call('get_asset_folder', { ...context, folderId }));
    if (detail.projectId !== projectId || detail.scope !== scope || detail.folder?.folderId !== folderId) throw new Error('LibTV 目录身份不匹配');
    const assets = [];
    let count = 0;
    for (let page = 1; ; page++) {
      const result = libtvData(await call('search_assets', { ...context, folderId, page, pageSize: 100 }));
      if (result.projectId !== projectId || result.scope !== scope || result.page !== page || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0) throw new Error('LibTV 分页资产回执无效');
      for (const asset of result.items) {
        if (!asset.assetId || asset.folderId !== folderId) throw new Error('LibTV 搜索结果的资产或目录身份不匹配');
        let tags = asset.tags;
        if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = []; } }
        const hashes = (Array.isArray(tags) ? tags : []).filter(tag => typeof tag === 'string' && /^sha256:[a-f0-9]{64}$/.test(tag));
        if (hashes.length > 1) throw new Error('LibTV 资产存在多个内容哈希标签');
        if (hashes.length) assets.push({ sha256: hashes[0].slice(7), assetId: asset.assetId, folderId, resourceIds: (asset.items || []).flatMap(item => item.resourceIds || []) });
      }
      count += result.items.length;
      if (count >= result.total) break;
      if (!result.items.length) throw new Error('LibTV 分页未覆盖已声明的资产总数');
    }
    return assets;
  }, { concurrency: 4 });
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw new Error(String(failed.reason));
  return { projectId, scope, folderIds: folders, assets: results.flatMap(result => result.value) };
}

export function prepareLibTVAssets(directory, items, { projectId, scope = 'personal' } = {}) {
  if (typeof projectId !== 'string' || !projectId.trim() || !['personal', 'team'].includes(scope) || !Array.isArray(items)) throw new Error('LibTV 项目、空间或资产列表无效');
  const root = fs.realpathSync(directory), ids = new Set();
  return items.map(item => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id) || !Number.isSafeInteger(item.folderId) || item.folderId <= 0 || typeof item.name !== 'string' || !item.name.trim() || (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some(tag => typeof tag !== 'string')))) throw new Error('LibTV 资产 ID、目录、名称或标签无效');
    ids.add(item.id);
    const filename = fs.realpathSync(path.resolve(root, item.path));
    const relative = path.relative(root, filename);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('LibTV 资产文件必须位于项目内');
    const bytes = fs.readFileSync(filename), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!bytes.length || (item.mediaType !== undefined && !['image', 'video', 'audio'].includes(item.mediaType))) throw new Error('LibTV 资产文件为空或媒体类型无效');
    if (item.sha256 && item.sha256 !== sha256) throw new Error(`${item.id}文件哈希已变化`);
    const key = action => `libtv-${action}-${crypto.createHash('sha256').update(JSON.stringify([projectId, scope, sha256, action === 'save' ? item.folderId : null])).digest('hex')}`;
    return { ...item, path: filename, fileName: path.basename(filename), size: bytes.length, sha256, sha1: crypto.createHash('sha1').update(bytes).digest('hex'), projectId, scope, uploadKey: key('upload'), saveKey: key('save') };
  });
}

export function createLibTVReceiptStore(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const filename = (item, stage) => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || (stage !== undefined && !/^[a-z_]+(?:\.error)?$/.test(stage))) throw new Error('LibTV 回执路径无效');
    const file = path.join(directory, `${item.id}${stage === undefined ? '' : '.' + stage}.json`);
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('LibTV 回执不能是链接');
    return file;
  };
  return {
    readReceipt: async (item, stage) => {
      try { return JSON.parse(fs.readFileSync(filename(item, stage), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    writeReceipt: async (item, stage, receipt, { exclusive = false } = {}) => {
      const file = filename(item, stage), text = `${JSON.stringify(receipt, null, 2)}\n`;
      const durableWrite = target => {
        const fd = fs.openSync(target, 'wx');
        try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      };
      if (exclusive) return durableWrite(file);
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try { durableWrite(temporary); fs.renameSync(temporary, file); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
  };
}

// File-only boundary: no MCP or media calls, and no conversion of legacy receipt bodies.
export async function receiptBridge(input) {
  if (!input || !path.isAbsolute(input.directory ?? '')) throw new Error('LibTV 回执目录须为绝对路径');
  const store = createLibTVReceiptStore(input.directory);
  const parseKey = key => {
    const match = typeof key === 'string' && /^([A-Za-z0-9_-]{1,80})(?:\.([a-z_]+(?:\.error)?))?$/.exec(key);
    if (!match) throw new Error('LibTV 回执 key 无效');
    return [{ id: match[1] }, match[2]];
  };
  if (input.operation === 'snapshot') {
    const receipts = {};
    for (const filename of fs.readdirSync(input.directory)) {
      if (!/^[A-Za-z0-9_-]{1,80}(?:\.[a-z_]+(?:\.error)?)?\.json$/.test(filename)) continue;
      const key = filename.slice(0, -5), value = await store.readReceipt(...parseKey(key));
      if (value && !Array.isArray(value) && ['tool', 'status', 'state', 'error'].some(field => Object.hasOwn(value, field))) receipts[key] = value;
    }
    return { receipts };
  }
  if (input.operation === 'verify') {
    if (!Array.isArray(input.items) || new Set(input.items.map(item => item.id)).size !== input.items.length) throw new Error('LibTV 文件清单无效');
    for (const item of input.items) {
      if (!path.isAbsolute(item.path ?? '') || !Number.isSafeInteger(item.size) || item.size <= 0 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) throw new Error('LibTV 文件身份无效');
      const bytes = fs.readFileSync(item.path);
      if (bytes.length !== item.size || crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`${item.id} 文件长度或哈希已变化`);
    }
    return { verified: input.items.length };
  }
  if (!['read', 'write'].includes(input.operation)) throw new Error('未知 LibTV 回执操作');
  const key = parseKey(input.key);
  if (input.operation === 'read') return store.readReceipt(...key);
  const started = performance.now();
  const previous = await store.readReceipt(...key);
  if (Object.hasOwn(input, 'expected') && JSON.stringify(previous) !== JSON.stringify(input.expected)) throw new Error(`${input.key} 回执已变化；拒绝覆盖`);
  if (!input.value || typeof input.value !== 'object' || Array.isArray(input.value)) throw new Error('LibTV 回执须为对象');
  if (previous?.tool && (input.value.tool !== previous.tool || JSON.stringify(input.value.args) !== JSON.stringify(previous.args))) throw new Error(`${input.key} 原请求身份不匹配`);
  if (input.key.endsWith('.error') && previous) throw new Error('历史错误回执不可覆盖');
  const receipt = { ...input.value, receiptSavedAt: new Date().toISOString() };
  await store.writeReceipt(...key, receipt, { exclusive: input.exclusive === true });
  return { receipt, receiptSavedAt: new Date().toISOString(), receiptSaveMs: performance.now() - started };
}

// A host injects its existing MCP boundary and normal-Node bridge; this never starts work itself.
export async function createLibTVCanvasSession({ projectId, bridge, call, paused = true, independentJobs = false }) {
  if (!projectId || typeof bridge !== 'function' || typeof call !== 'function') throw new Error('LibTV 画布会话缺少项目或宿主边界');
  if (typeof independentJobs !== 'boolean') throw new Error('独立任务隔离开关须为布尔值');
  const monotonic = typeof performance !== 'undefined' && typeof performance.now === 'function';
  const now = () => monotonic ? performance.now() : Date.now();
  const clone = value => JSON.parse(JSON.stringify(value));
  const started = now(), initial = await bridge({ operation: 'snapshot' });
  const receipts = clone(initial.receipts), pendingSaves = new Map(), active = new Set();
  let stopped = paused, storageFailed = false, pausedAt = paused ? now() : null, pausedMs = 0, outstanding = 0;
  const timing = { preparationMs: now() - started, toolWaitMs: 0, receiptSaveMs: 0, toolCalls: 0, peakOutstandingCalls: 0, durationSource: monotonic ? 'monotonic' : 'utc-estimate' };
  const issue = (message, status = 'unknown') => Object.assign(new Error(message), { status });
  const save = async (key, receipt, expected) => {
    try {
      const result = await bridge({ operation: 'write', key, value: receipt, expected, exclusive: expected === null });
      if (!result?.receipt) throw new Error('存储未返回持久化回执');
      receipts[key] = result.receipt;
      timing.receiptSaveMs += result.receiptSaveMs ?? 0;
      return result.receipt;
    } catch (error) { storageFailed = true; throw error; }
  };
  const validate = (name, key, args) => {
    if (!['upload_ticket', 'upload_complete', 'upload_media', 'create_node', 'manage_group'].includes(name)) throw issue('禁止的画布交付工具：' + name, 'failed');
    const assetId = key.split('.')[0];
    if (name === 'upload_complete') {
      const ticket = receipts[assetId + '.ticket'];
      if (!(ticket?.tool === 'upload_ticket' && ticket.status === 'completed' && ticket.args.projectId === projectId && ticket.value.path === args?.path && ticket.value.uploadId === args?.upload_id)) throw issue('上传完成请求未匹配同项原票据', 'failed');
    } else if (args?.projectId !== projectId) throw issue('LibTV 项目身份不匹配', 'failed');
    if (name === 'upload_media') {
      const completed = receipts[assetId + '.complete'], ticket = receipts[assetId + '.ticket'];
      if (!(completed?.tool === 'upload_complete' && completed.status === 'completed' && ticket?.args.projectId === projectId && ticket.status === 'completed' && completed.args.path === ticket.value.path && completed.args.upload_id === ticket.value.uploadId && completed.value.file_ref === args.fileRef)) throw issue('图片引用未匹配同项上传凭据', 'failed');
    }
    if (name === 'create_node' && (args.run !== false || !['image', 'video', 'audio', 'text'].includes(args.nodeType))) throw issue('画布节点须显式 run:false，且类型有效', 'failed');
    if (name === 'manage_group' && args.action !== 'create') throw issue('画布交付只允许创建分组', 'failed');
  };
  const deliver = receipt => {
    if (receipt.status !== 'completed') throw issue(`${receipt.tool} 返回 ${receipt.status}`, receipt.status);
    return clone(receipt.value);
  };
  const responseStatus = (name, args, value) => {
    if (value?.status && value.status !== 'completed') return value.status;
    if (name === 'upload_ticket') return value?.uploadId && value.path && Array.isArray(value.parts) && value.parts.length ? 'completed' : 'unknown';
    if (name === 'upload_complete') return value?.file_ref && value.path === args.path ? 'completed' : 'unknown';
    if (name === 'upload_media') {
      const review = value?.resource?.review?.state;
      if (review === 'rejected') return 'review_rejected';
      if (review === 'pending') return 'review_pending';
      if (review !== 'passed' || value?.projectId !== projectId || !value.nodeId || !(value.resourceId || value.resource?.resource_id)) return 'unknown';
    }
    if (name === 'create_node' && (value?.projectId !== projectId || !(value.plan?.nodeId || value.operationResult?.subjectNodeId))) return 'unknown';
    return value?.status ?? 'unknown';
  };
  const savedCall = async (name, key, args, { recover = false } = {}) => {
    if (!/^[A-Za-z0-9_-]{1,80}(?:\.[a-z_]+)?$/.test(key)) throw issue('LibTV 回执 key 无效', 'failed');
    validate(name, key, args);
    args = clone(args);
    const previous = receipts[key] ?? null;
    if (previous && (previous.tool !== name || JSON.stringify(previous.args) !== JSON.stringify(args))) throw issue(key + ' 原请求身份不匹配', 'failed');
    if (previous?.status === 'completed') return deliver(previous);
    if (stopped) throw issue('批次已暂停', 'paused');
    if (storageFailed || [...pendingSaves.keys()].some(id => !active.has(id))) throw issue('先恢复原返回结果的保存，禁止新增提交');
    if (active.has(key)) throw issue(key + ' 已有在途调用');
    if (previous && ['failed', 'review_rejected', 'rejected', 'cancelled'].includes(previous.status)) throw issue(key + ' 保留失败终态，不自动重试', previous.status);
    if (previous && previous.status !== 'prepared' && !(recover && name === 'upload_media' && args.idempotencyKey)) throw issue(key + ' 结果未知，只允许按原上传身份显式恢复');
    if (!previous && Object.entries(receipts).some(([id, receipt]) => !id.endsWith('.error') && !active.has(id) && (!independentJobs || id.split('.')[0] === key.split('.')[0]) && ['submitted', 'unknown', 'pending', 'review_pending'].includes(receipt.status))) throw issue('已有未知或审核等待项，禁止增加新提交');
    active.add(key);
    try {
      const submitted = await save(key, { ...previous, tool: name, args, status: 'submitted', startedAt: previous?.startedAt ?? new Date().toISOString(), ...(previous ? { previous } : {}) }, previous);
      if (stopped) {
        await save(key, { ...submitted, status: 'prepared', notCalledAt: new Date().toISOString() }, submitted);
        throw issue('批次已暂停，已登记的请求未调用远端', 'paused');
      }
      const toolStartedAt = new Date().toISOString(), toolStarted = now();
      let value, error;
      timing.toolCalls++;
      timing.peakOutstandingCalls = Math.max(timing.peakOutstandingCalls, ++outstanding);
      try {
        const raw = await call(name, args);
        // Preserve isError evidence without guessing whether a transport failure was accepted.
        if (raw?.isError) throw Object.assign(new Error('LibTV MCP 返回错误'), { evidence: raw });
        value = libtvData(raw);
        if (value?.ok === false) throw Object.assign(new Error('LibTV 返回 ok:false'), { evidence: raw });
      } catch (caught) { error = caught; }
      outstanding--;
      const toolReturnedAt = new Date().toISOString();
      timing.toolWaitMs += Math.max(0, now() - toolStarted);
      const status = error ? 'unknown' : responseStatus(name, args, value);
      const receipt = { ...submitted, status, toolStartedAt, toolReturnedAt, finishedAt: toolReturnedAt,
        ...(error ? { error: String(error.message ?? error), ...(error.evidence ? { evidence: error.evidence } : {}) } : { value }) };
      pendingSaves.set(key, { receipt, expected: submitted });
      await save(key, receipt, submitted);
      pendingSaves.delete(key);
      return deliver(receipt);
    } finally { active.delete(key); }
  };
  return {
    savedCall,
    setPaused(value) {
      if (typeof value !== 'boolean') throw new Error('paused 须为布尔值');
      if (value !== stopped) { if (value) pausedAt = now(); else { pausedMs += Math.max(0, now() - pausedAt); pausedAt = null; } }
      stopped = value;
    },
    async recoverSave(key) {
      const pending = pendingSaves.get(key);
      if (!pending) throw new Error('没有可恢复的原返回结果');
      const stored = await bridge({ operation: 'read', key });
      const withoutSaveTime = receipt => { const value = { ...receipt }; delete value.receiptSavedAt; return JSON.stringify(value); };
      if (stored && withoutSaveTime(stored) === withoutSaveTime(pending.receipt)) receipts[key] = stored;
      else if (JSON.stringify(stored) === JSON.stringify(pending.expected)) await save(key, pending.receipt, pending.expected);
      else throw new Error('原返回结果保存发生冲突；保留回执，不重投');
      pendingSaves.delete(key);
      storageFailed = pendingSaves.size > 0;
      return deliver(pending.receipt);
    },
    snapshot() {
      const end = now(), excludedPauseMs = pausedMs + (pausedAt === null ? 0 : Math.max(0, end - pausedAt));
      const summary = { receipts: clone(receipts), pendingSaves: clone(Object.fromEntries(pendingSaves)), paused: stopped, active: [...active], timing: { ...timing, wallMs: Math.max(0, end - started - excludedPauseMs), elapsedWallMs: Math.max(0, end - started), excludedPauseMs, serverExecutionPeak: null } };
      summary.timing.summaryMs = Math.max(0, now() - end);
      return summary;
    }
  };
}

// This function is also loaded verbatim by hosts without filesystem/import access.
export async function runLibTVAssets(items, { discover, call, transfer, readReceipt, writeReceipt, concurrency = 4 } = {}) {
  const issue = (message, status = 'unknown') => Object.assign(new Error(message), { status });
  const unwrap = libtvData;
  if (![discover, call, transfer, readReceipt, writeReceipt].every(value => typeof value === 'function')) throw new Error('LibTV 流水线缺少宿主工具或持久化回调');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('LibTV 并发数无效');
  if (!Array.isArray(items) || new Set(items.map(item => item?.id)).size !== items.length || items.some(item => !item || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || !/^[a-f0-9]{64}$/.test(item.sha256) || !/^[a-f0-9]{40}$/.test(item.sha1) || !item.uploadKey || !item.saveKey || typeof item.path !== 'string' || typeof item.fileName !== 'string' || typeof item.name !== 'string' || !item.name.trim() || !Number.isSafeInteger(item.folderId) || item.folderId <= 0 || !Number.isSafeInteger(item.size) || item.size <= 0 || (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some(tag => typeof tag !== 'string'))))) throw new Error('请先用 prepareLibTVAssets 读取并校验本地资产');
  if (!items.length) return [];
  const context = { projectId: items[0].projectId, scope: items[0].scope };
  if (!context.projectId || !['personal', 'team'].includes(context.scope) || items.some(item => item.projectId !== context.projectId || item.scope !== context.scope)) throw new Error('一个 LibTV 批次只能使用同一项目和空间');
  const inventory = await discover({ ...context, folderIds: [...new Set(items.map(item => item.folderId))] });
  if (inventory.projectId !== context.projectId || inventory.scope !== context.scope || !Array.isArray(inventory.folderIds) || !Array.isArray(inventory.assets) || items.some(item => !inventory.folderIds.includes(item.folderId))) throw new Error('LibTV 预读的项目、空间或目录不匹配');
  const unique = [], originals = new Map();
  for (const item of items) {
    const original = originals.get(item.sha256);
    if (original && original.folderId !== item.folderId) throw new Error('相同文件被分配到不同目录；请明确保留一个库资产的位置');
    if (!original) { originals.set(item.sha256, item); unique.push(item); }
  }
  const results = await runConcurrentJobs(unique, async item => {
    let activeStage;
    const stage = async (name, request, validate, { readOnly = false, invoke = () => call(name, request) } = {}) => {
      activeStage = name;
      const identity = { projectId: item.projectId, scope: item.scope, sha256: item.sha256, folderId: item.folderId, request };
      let receipt = await readReceipt(item, name);
      if (receipt && JSON.stringify(receipt.identity) !== JSON.stringify(identity)) throw issue(`${item.id}/${name}回执与本次请求不一致`, 'failed');
      if (receipt?.state === 'failed') throw issue(receipt.error || `${name}已失败`, 'failed');
      if (receipt?.state === 'completed') {
        if (validate(receipt.response) !== 'completed') throw issue(`${item.id}/${name}缓存回执不再满足完成条件`);
        return receipt.response;
      }
      const submitted = { schemaVersion: 1, identity, state: 'submitted', startedAt: receipt?.startedAt || new Date().toISOString() };
      if (!receipt) await writeReceipt(item, name, submitted, { exclusive: true });
      try {
        let response;
        if (!receipt || readOnly) response = unwrap(await invoke());
        else if (name === 'upload_media') response = unwrap(await call(name, request));
        else if (name === 'save_asset_from_node' && receipt.response?.operationId) response = unwrap(await call('get_web_operation_status', { projectId: item.projectId, operationId: receipt.response.operationId }));
        else throw issue(`${item.id}/${name}结果未知，保留原回执等待按原身份恢复`);
        const state = validate(response);
        receipt = { ...submitted, state, response, finishedAt: new Date().toISOString() };
        await writeReceipt(item, name, receipt);
        if (state !== 'completed') throw issue(`${item.id}/${name}${state === 'failed' ? '被拒绝' : '尚未完成'}`, state === 'failed' ? 'failed' : 'pending');
        return response;
      } catch (error) {
        if (!receipt || receipt.state === 'submitted') {
          await writeReceipt(item, name, { ...submitted, state: error.status === 'failed' ? 'failed' : 'unknown', error: String(error.message || error), finishedAt: new Date().toISOString() });
        }
        throw error;
      }
    };
    const complete = response => {
      if (['failed', 'rejected', 'review_rejected', 'cancelled'].includes(response.status)) return 'failed';
      return response.status === 'completed' ? 'completed' : 'pending';
    };
    const detail = async (assetId, expectedResourceId) => {
      const response = await stage('get_asset', { ...context, assetId }, data => {
        const asset = data.asset;
        if (data.projectId !== item.projectId || data.scope !== item.scope || asset?.assetId !== assetId || asset.folderId !== item.folderId || !asset.assetVersion) throw issue('LibTV 资产详情的身份、目录或持久版本不匹配');
        let tags = asset.tags;
        if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = []; } }
        if (!Array.isArray(tags) || !tags.includes(`sha256:${item.sha256}`)) throw issue('LibTV 资产详情缺少本地内容哈希绑定');
        if (expectedResourceId && !asset.items?.some(item => item.resourceIds?.includes(expectedResourceId))) throw issue('LibTV 资产详情未绑定本次审核通过的原始 Resource');
        return 'completed';
      }, { readOnly: true });
      return { id: item.id, status: 'succeeded', sha256: item.sha256, assetId, assetVersion: response.asset.assetVersion, folderId: item.folderId };
    };
    try {
      const existing = inventory.assets.filter(asset => asset.sha256 === item.sha256);
      if (existing.length > 1 || existing.some(asset => asset.folderId !== item.folderId)) throw issue('LibTV 内容查重发现多个资产或目录冲突', 'failed');
      if (existing.length) return await detail(existing[0].assetId);
      const ticket = await stage('upload_ticket', { projectId: item.projectId, file_name: item.fileName, file_size: item.size, sha1_hex: item.sha1 }, data => {
        if (!data.uploadId || !data.path || !Array.isArray(data.parts) || !data.parts.length) throw issue('LibTV 上传票据缺少原身份或分片');
        return 'completed';
      });
      await stage('transfer', { path: item.path, sha256: item.sha256, uploadId: ticket.uploadId, remotePath: ticket.path }, data => {
        if (!Number.isInteger(data.status) || data.status < 200 || data.status >= 300 || data.bytes !== item.size || data.sha256 !== item.sha256) throw issue('LibTV 直传字节或哈希未核验');
        return 'completed';
      }, { invoke: () => transfer(item, ticket) });
      const completed = await stage('upload_complete', { path: ticket.path, upload_id: ticket.uploadId }, data => {
        if (!data.file_ref || data.path !== ticket.path) throw issue('LibTV 上传完成回执缺少原文件凭据');
        return 'completed';
      });
      const uploaded = await stage('upload_media', { projectId: item.projectId, fileRef: completed.file_ref, name: item.name, mediaType: item.mediaType || 'image', idempotencyKey: item.uploadKey, ...(item.x == null ? {} : { x: item.x }), ...(item.y == null ? {} : { y: item.y }) }, data => {
        const state = complete(data);
        if (state !== 'completed') return state;
        if (data.resource?.review?.state === 'rejected') return 'failed';
        if (data.projectId !== item.projectId || !data.nodeId || !data.resource?.resource_id || data.resource.review?.state !== 'passed') throw issue('LibTV 节点或审核通过证据不完整');
        return 'completed';
      });
      const node = await stage('read_node', { projectId: item.projectId, node: uploaded.nodeId }, data => {
        if (data.projectId !== item.projectId || ![data.nodeId, data.node?.id, data.node?.nodeId, data.id].includes(uploaded.nodeId)) throw issue('LibTV 回读节点身份不匹配');
        return 'completed';
      }, { readOnly: true });
      const saved = await stage('save_asset_from_node', { ...context, folderId: item.folderId, nodeId: uploaded.nodeId, name: item.name, tags: [...new Set([...(item.tags || []), `sha256:${item.sha256}`])], idempotencyKey: item.saveKey, ...(node.sourceVersion ? { expectedSourceVersion: node.sourceVersion } : {}) }, data => {
        const state = complete(data);
        if (state === 'completed' && (data.projectId !== item.projectId || !data.result?.asset?.assetId)) throw issue('LibTV 保存回执缺少资产身份');
        return state;
      });
      return await detail(saved.result.asset.assetId, uploaded.resource.resource_id);
    } catch (error) {
      return { id: item.id, status: error.status || 'unknown', stage: activeStage, sha256: item.sha256, error: String(error.message || error) };
    }
  }, { concurrency });
  const byHash = new Map(unique.map((item, index) => [item.sha256, results[index].status === 'fulfilled' ? results[index].value : { id: item.id, status: 'unknown', error: String(results[index].reason) }]));
  return items.map(item => ({ ...byHash.get(item.sha256), id: item.id, ...(originals.get(item.sha256).id === item.id ? {} : { reusedFrom: originals.get(item.sha256).id }) }));
}

export const libtvAssetsHostSource = () => [runConcurrentJobs, libtvData, discoverLibTVAssets, runLibTVAssets, createLibTVCanvasSession].map(fn => fn.toString()).join('\n\n');

if (typeof process !== 'undefined' && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'host-source') process.stdout.write(`${libtvAssetsHostSource()}\n`);
  else if (process.argv[2] === 'receipts') {
    const framed = process.argv[3] === '--stdio' && process.stdin.isTTY;
    let output = '', outputOffset = 0;
    const drain = () => {
      const end = Math.min(output.length, outputOffset + 48 * 1024);
      let chunk = '';
      for (; outputOffset < end; outputOffset += 48) chunk += '~B64 ' + output.slice(outputOffset, outputOffset + 48) + '\n';
      chunk += outputOffset >= output.length ? '~END\n' : '~MORE\n';
      process.stdout.write(chunk);
      if (outputOffset >= output.length) { output = ''; outputOffset = 0; }
    };
    const respond = value => {
      if (!framed) return process.stdout.write(JSON.stringify(value) + '\n');
      // ConHost can trim trailing spaces even on short lines; base64 preserves exact JSON bytes.
      output = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
      outputOffset = 0;
      drain();
    };
    let lock, owner;
    const release = () => { if (owner) { lock.release({ owner: owner.owner }); owner = null; } };
    try {
      if (process.argv[3] === '--stdio') {
        const directory = process.argv[4];
        if (!path.isAbsolute(directory ?? '')) throw new Error('LibTV 回执目录须为绝对路径');
        fs.mkdirSync(directory, { recursive: true });
        lock = createProcessLock(path.join(directory, '.libtv-receipts.lock'));
        owner = lock.acquire();
        process.once('SIGINT', () => { release(); process.exit(130); });
        process.once('SIGTERM', () => { release(); process.exit(143); });
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        respond({ ok: true, value: { ready: true, owner: owner.owner } });
        const { createInterface } = await import('node:readline');
        const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line.trim()) continue;
          let input;
          try {
            input = JSON.parse(line);
            if (input.operation === 'drain') { if (output) drain(); else respond({ ok: false, error: '没有待取回的本地响应' }); continue; }
            if (output) { process.stdout.write('~WAIT\n'); continue; }
            if (input.operation === 'close') { respond({ requestId: input.requestId, ok: true, value: { closed: true } }); lines.close(); break; }
            if (input.directory && path.resolve(input.directory) !== path.resolve(directory)) throw new Error('不能切换持锁目录');
            lock.assertOwner({ owner: owner.owner });
            const value = await receiptBridge({ ...input, directory });
            const result = framed && input.operation === 'write' ? { saved: true, receiptSavedAt: value.receipt.receiptSavedAt, receiptSaveMs: value.receiptSaveMs } : value;
            respond({ requestId: input.requestId, ok: true, value: result });
          } catch (error) { respond({ requestId: input?.requestId, ok: false, error: error.message, code: error.code }); }
        }
      } else {
        const input = JSON.parse(fs.readFileSync(process.argv[3] ?? 0, 'utf8'));
        if (input.operation === 'write') {
          if (!path.isAbsolute(input.directory ?? '')) throw new Error('LibTV 回执目录须为绝对路径');
          fs.mkdirSync(input.directory, { recursive: true });
          lock = createProcessLock(path.join(input.directory, '.libtv-receipts.lock'));
          owner = lock.acquire();
        }
        respond({ ok: true, value: await receiptBridge(input) });
      }
    } catch (error) { respond({ ok: false, error: error.message, code: error.code }); process.exitCode = 1; }
    finally { release(); }
  }
  else { process.stderr.write('用法：libtv_assets.mjs host-source | receipts [request.json] | receipts --stdio <directory>；只操作本地回执。\n'); process.exitCode = 1; }
}
