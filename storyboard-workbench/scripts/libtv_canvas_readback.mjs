import { libtvData } from './libtv_assets.mjs';
import { runConcurrentJobs } from './media_batch.mjs';

export async function readCanvasImage(call, projectId, { nodeId, resourceId }) {
  if (!projectId || !nodeId || !resourceId) throw new Error('首张入库图片缺少项目、节点或资源身份');
  const detail = libtvData(await call('read_node', { projectId, node: nodeId }));
  const binding = detail.mediaPersistence?.nodes?.find(entry => entry.nodeId === nodeId);
  const resources = detail.node?.data?.resourceIds;
  if (detail.projectId !== projectId || detail.nodeId !== nodeId || detail.node?.id !== nodeId ||
      detail.node.type !== 'image' || binding?.bindingStatus !== 'present' ||
      !Array.isArray(resources) || resources.length !== 1 || resources[0] !== resourceId) {
    throw new Error(`${nodeId} 图片回读与挂图节点或资源不匹配`);
  }
  return { nodeId, resourceId };
}

export async function verifyCanvasBatch(call, projectId, images, videos) {
  let revision;
  const readPages = async section => {
    const rows = [];
    let total;
    do {
      const offset = rows.length;
      const result = libtvData(await call('get_project_snapshot', { projectId, section, offset, limit: 100,
        ...(revision ? { expectedRevision: revision } : {}) }));
      const token = result.revision?.token;
      if (!token || (revision && revision !== token) || result.project?.projectId !== projectId ||
          result.section !== section || result.page?.offset !== offset || !Number.isSafeInteger(result.page.total) ||
          result.page.total < 0 || (total !== undefined && result.page.total !== total) ||
          !Array.isArray(result.items) || offset + result.items.length > result.page.total ||
          (offset < result.page.total && !result.items.length)) throw new Error(`画布 ${section} 快照版本或分页不完整`);
      revision = token;
      total = result.page.total;
      rows.push(...result.items);
    } while (rows.length < total);
    return rows;
  };
  const graph = await readPages('graph');
  const nodes = new Map(graph.filter(row => row.itemType === 'node').map(row => [row.nodeId, row]));
  const edges = graph.filter(row => row.itemType === 'edge');
  const imageIds = new Set(images.map(image => image.nodeId));
  if (new Set([...images, ...videos].map(item => item.nodeId)).size !== images.length + videos.length) {
    throw new Error('回读清单中有重复节点');
  }
  const videoChecks = await runConcurrentJobs(videos, async ({ id, nodeId, firstFrameNodeId, args }) => {
    const node = nodes.get(nodeId);
    const incoming = edges.filter(edge => edge.target === nodeId);
    if (node?.type !== 'video' || !node.task || Object.keys(node.task).length ||
        args?.projectId !== projectId || args.nodeType !== 'video' || args.run !== false ||
        !args.model || !args.prompt || args.startFrameNode !== firstFrameNodeId ||
        !imageIds.has(firstFrameNodeId) || incoming.length !== 1 || incoming[0].source !== firstFrameNodeId) {
      throw new Error(`${id} 待运行视频节点、任务或首帧连线不匹配`);
    }
    const detail = libtvData(await call('read_node', { projectId, node: nodeId }));
    const data = detail.node?.data, params = data?.params;
    const binding = detail.mediaPersistence?.nodes?.find(entry => entry.nodeId === nodeId);
    const expectedPrompt = args.prompt.replaceAll(`{{Node ${firstFrameNodeId}}}`, '{{Image 1}}');
    if (detail.projectId !== projectId || detail.nodeId !== nodeId || detail.node?.id !== nodeId ||
        detail.node.type !== 'video' || params?.model !== args.model || params.prompt !== expectedPrompt ||
        params.imageList?.length !== 1 || params.imageList[0].nodeId !== firstFrameNodeId ||
        !Array.isArray(data.url) || data.url.length || binding?.persistedUrlCount !== 0 ||
        binding.persistedResourceIdCount !== 0 || data.taskInfo?.loading) {
      throw new Error(`${id} 视频正文、模型、首帧或空输出回读不匹配`);
    }
    for (const [key, expected] of Object.entries(args.params ?? {})) {
      const actual = Object.hasOwn(params, key) ? params[key] :
        Object.hasOwn(params.settings ?? {}, key) ? params.settings[key] : params.advancedSettings?.[key];
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${id} 视频参数 ${key} 回读不匹配`);
    }
  });
  const failed = videoChecks.find(result => result.status === 'rejected');
  if (failed) throw new Error(failed.reason);
  // Anchor the final media page to the graph revision after the individual node reads.
  const media = new Map((await readPages('media')).map(item => [item.nodeId, item]));
  for (const { id, nodeId, resourceId } of images) {
    const row = media.get(nodeId);
    if (!resourceId || nodes.get(nodeId)?.type !== 'image' || row?.type !== 'image' ||
        row.identity?.state !== 'resource' || row.identity.resourceIds?.length !== 1 ||
        row.identity.resourceIds[0] !== resourceId) throw new Error(`${id} 批末图片节点或资源不匹配`);
  }
  return { projectId, revision, imageCount: images.length, videoNodeCount: videos.length, edgeCount: videos.length,
    verifiedAt: new Date().toISOString(), videoGenerated: false };
}

export const libtvReadbackHostSource = () => [readCanvasImage, verifyCanvasBatch].map(fn => fn.toString()).join('\n\n');
