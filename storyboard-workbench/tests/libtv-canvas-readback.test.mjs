import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCanvasImage, verifyCanvasBatch } from '../scripts/libtv_canvas_readback.mjs';

const image = { id: 'A', nodeId: 'i-A', resourceId: 'r-A' };
const video = { id: 'V', nodeId: 'v-V', firstFrameNodeId: 'i-A', args: {
  projectId: 'P', run: false, nodeType: 'video', startFrameNode: 'i-A', prompt: 'Pan from {{Node i-A}}',
  model: 'model', params: { count: 1, duration: 5 }
} };

function fixture() {
  const graph = [{ itemType: 'node', nodeId: 'i-A', type: 'image' },
    { itemType: 'node', nodeId: 'v-V', type: 'video', task: {} },
    { itemType: 'edge', source: 'i-A', target: 'v-V' }];
  const media = [{ type: 'image', nodeId: 'i-A', identity: { state: 'resource', resourceIds: ['r-A'] } }];
  const params = { model: 'model', prompt: 'Pan from {{Image 1}}', imageList: [{ nodeId: 'i-A' }], count: 1,
    settings: { duration: 5 } };
  const call = async (name, args) => {
    if (name === 'get_project_snapshot') {
      const rows = args.section === 'graph' ? graph : media;
      if (args.offset || args.section === 'media') assert.equal(args.expectedRevision, 'rev');
      return { project: { projectId: 'P' }, revision: { token: 'rev' }, section: args.section,
        page: { offset: args.offset, total: rows.length }, items: rows.slice(args.offset, args.offset + 2) };
    }
    assert.equal(name, 'read_node');
    const id = args.node;
    return { projectId: 'P', nodeId: id, node: { id, type: id === 'i-A' ? 'image' : 'video',
      data: { resourceIds: ['r-A'], url: [], params } }, mediaPersistence: { nodes: [
      { nodeId: id, bindingStatus: id === 'i-A' ? 'present' : 'missing', persistedUrlCount: 0, persistedResourceIdCount: 0 }
    ] } };
  };
  return { call, media, graph, params };
}

test('首张图片校验精确资源，批末按同一版本分页核对正文、首帧与参数', async () => {
  const { call } = fixture();
  assert.equal((await readCanvasImage(call, 'P', image)).resourceId, 'r-A');
  await assert.rejects(readCanvasImage(call, 'P', { ...image, resourceId: 'r-B' }), /回读/);
  const result = await verifyCanvasBatch(call, 'P', [image], [video]);
  assert.equal(result.edgeCount, 1);
  assert.equal(result.videoGenerated, false);
});

test('拒绝变更的资源、连线、提示词、参数或已经派发的视频', async () => {
  for (const mutate of [
    f => { f.media[0].identity.resourceIds = ['r-B']; },
    f => { f.graph[2].source = 'i-B'; },
    f => { f.graph[1].task = { status: 'running' }; },
    f => { f.params.prompt += 'x'; },
    f => { f.params.imageList[0].nodeId = 'i-C'; },
    f => { f.params.settings.duration = 8; }
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(verifyCanvasBatch(f.call, 'P', [image], [video]), /不匹配/);
  }
});
