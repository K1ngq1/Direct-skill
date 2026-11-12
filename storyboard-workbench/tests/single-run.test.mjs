import test from 'node:test';
import assert from 'node:assert/strict';
import { singleRunEnabled, agentImageSelected, userImageConfirmed } from '../scripts/single_run.mjs';

const policy = { mode: 'single-run', userRequest: '自动采用图片并继续，视频只建节点。', assetSelection: 'agent', imageGeneration: true, videoGeneration: false };
const plan = () => ({ schemaVersion: 2, run: { automation: { ...policy } } });
const image = () => ({ status: 'succeeded', output: { path: 'image.png', sha256: 'a'.repeat(64) },
  approval: { status: 'pending', by: null }, selection: { by: 'agent', reason: '检查后采用', selectedAt: '2026-11-11T00:00:00Z' },
  review: { status: 'usable', reason: '人物服装和场景布局与设定一致', reviewer: 'test', outputSha256: 'a'.repeat(64) } });

test('single run is explicit, v2-only and cannot enable video generation', () => {
  assert.equal(singleRunEnabled({ schemaVersion: 2, run: {} }), false);
  assert.equal(singleRunEnabled(plan()), true);
  for (const change of [p => { p.schemaVersion = 1; }, p => { p.run.automation.videoGeneration = true; },
    p => { p.run.automation.userRequest = ''; }, p => { p.run.automation.mode = 'background'; },
    p => { p.run.automation.retry = true; }, p => { p.run.automation = null; }]) {
    const p = plan(); change(p); assert.throws(() => singleRunEnabled(p), /单次自动制作/);
  }
});

test('agent adoption needs a successful, checked output and never impersonates user confirmation', () => {
  const original = image();
  assert.equal(agentImageSelected(plan(), original), true);
  assert.equal(userImageConfirmed(original), false);
  assert.equal(agentImageSelected({ schemaVersion: 2 }, original), false);
  for (const change of [i => { i.status = 'unknown'; }, i => { i.status = 'failed'; },
    i => { i.review.status = 'needs-change'; }, i => { i.review.reason = ''; },
    i => { i.review.outputSha256 = 'b'.repeat(64); }, i => { i.selection.selectedAt = 'unknown'; },
    i => { i.approval = { status: 'confirmed', by: 'agent' }; }]) {
    const i = image(); change(i); assert.equal(agentImageSelected(plan(), i), false);
  }
  const workflowImage = { ...original, ...original.output }; delete workflowImage.output;
  assert.equal(agentImageSelected(plan(), workflowImage), true);
  assert.deepEqual(image(), original);
});
