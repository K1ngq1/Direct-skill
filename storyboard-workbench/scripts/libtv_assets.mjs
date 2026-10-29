import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runConcurrentJobs } from './media_batch.mjs';

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
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || !/^[a-z_]+$/.test(stage)) throw new Error('LibTV 回执路径无效');
    return path.join(directory, `${item.id}.${stage}.json`);
  };
  return {
    readReceipt: async (item, stage) => {
      try { return JSON.parse(fs.readFileSync(filename(item, stage), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    writeReceipt: async (item, stage, receipt, { exclusive = false } = {}) => {
      const file = filename(item, stage), text = `${JSON.stringify(receipt, null, 2)}\n`;
      if (exclusive) return fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' });
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' }); fs.renameSync(temporary, file); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
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

export const libtvAssetsHostSource = () => [runConcurrentJobs, libtvData, discoverLibTVAssets, runLibTVAssets].map(fn => fn.toString()).join('\n\n');

if (typeof process !== 'undefined' && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'host-source') process.stdout.write(`${libtvAssetsHostSource()}\n`);
  else { process.stderr.write('用法：libtv_assets.mjs host-source；文件准备和回执存储通过模块导出使用，不自动调用远程服务。\n'); process.exitCode = 1; }
}
