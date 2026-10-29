import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { bridge, prepareRequests } from '../scripts/generation_bridge.mjs';
import { runMediaBatchAndSummarize } from '../scripts/media_batch.mjs';

const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), 'utf8');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '生图准备-'));
  const source = path.join(root, '正文.json'), recipe = path.join(root, 'recipe.json'), prepared = path.join(root, 'prepared.json'), directory = path.join(root, 'batch');
  write(source, { text: '完整中文构图。'.repeat(4000) });
  const input = { batchId: 'mock', version: 'v1', phase: 'characters', tool: 'imagegen', jobs: [{ id: 'A', count: 1, source: { path: source, pointer: '/text' }, request: { transparent_background: false } }] };
  write(recipe, input);
  return { root, source, recipe, prepared, directory, input };
}

test('preparation derives exact long text without submission; CLI accepts files and stdin', async () => {
  const f = fixture();
  const command = file => spawnSync(process.execPath, ['storyboard-workbench/scripts/generation_bridge.mjs', ...(file ? [file] : [])], { encoding: 'utf8', input: file ? undefined : JSON.stringify({ operation: 'snapshot', directory: f.directory }) });
  const request = path.join(f.root, '请求.json');
  write(request, { operation: 'compile', recipe: f.recipe, output: f.prepared });
  assert.equal(command(request).status, 0);
  assert.equal(fs.existsSync(f.directory), false);
  assert.equal(JSON.parse(fs.readFileSync(f.prepared)).entries[0].job.request.prompt, JSON.parse(fs.readFileSync(f.source)).text);
  const init = await bridge({ operation: 'init', directory: f.directory, prepared: f.prepared, authorizedCount: 1 });
  assert.equal(init.concurrency, 1);
  assert.deepEqual(init.initialStates, {});
  assert.equal(command().status, 0);
  write(f.source, { text: '修改后的正文' });
  await assert.rejects(bridge({ operation: 'prepare', directory: f.directory, args: ['A'] }), /来源已变化/);
});

test('unconfirmed assets, missing bindings and changed references block execution', async () => {
  const f = fixture(), image = path.join(f.root, '参考.png'), confirmation = path.join(f.root, '确认.json');
  fs.writeFileSync(image, 'reference');
  write(confirmation, { status: 'pending' });
  f.input.phase = 'storyboards';
  const entry = f.input.jobs[0];
  entry.requiredAssetIds = ['mother'];
  entry.references = [{ assetId: 'mother', path: image, confirmation: { path: confirmation, pointer: '' } }];
  assert.ok(prepareRequests(f.input).entries[0].blocked.includes('reference-not-confirmed'));
  write(confirmation, { status: 'confirmed', by: 'user', assetId: 'mother', path: image, sha256: digest(image) });
  write(f.prepared, prepareRequests(f.input));
  fs.writeFileSync(image, 'changed');
  await assert.rejects(bridge({ operation: 'init', directory: f.directory, prepared: f.prepared, authorizedCount: 1 }), /来源已变化/);
  delete entry.references;
  assert.ok(prepareRequests(f.input).entries[0].blocked.includes('asset-binding-missing:mother'));
});

test('28 fake images save and summarize through Node storage; restored tasks never resubmit', async () => {
  const f = fixture();
  f.input.jobs = Array.from({ length: 28 }, (_, i) => ({ ...f.input.jobs[0], id: 'A' + i }));
  write(f.prepared, prepareRequests(f.input));
  const initial = await bridge({ operation: 'init', directory: f.directory, prepared: f.prepared, authorizedCount: 28 });
  const original = path.join(f.root, '原图.png');
  fs.writeFileSync(original, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lmN0AAAAASUVORK5CYII=', 'base64'));
  const call = (operation, ...args) => bridge({ operation, directory: f.directory, args });
  let calls = 0;
  const options = { batch: initial.batch, concurrency: initial.concurrency, snapshot: () => call('snapshot'), readControl: () => call('readControl'), acknowledgeControl: value => call('acknowledgeControl', value), prepare: (id, context) => call('prepare', id, context), capture: (id, value) => call('capture', id, value), finalize: id => call('finalize', id), summarize: (_results, report) => call('summarize', report), execute: () => { calls++; return { path: original }; } };
  const summary = await runMediaBatchAndSummarize(initial.jobs, options);
  assert.deepEqual(summary.counts, { succeeded: 28 });
  assert.equal(summary.images.length, 28);
  assert.ok(fs.existsSync(summary.deliveryPath));
  await runMediaBatchAndSummarize(initial.jobs, options);
  assert.equal(calls, 28);
});

test('unknown requests skip; save recovery uses the original capture and retains history', async () => {
  const f = fixture();
  write(f.prepared, prepareRequests(f.input));
  await bridge({ operation: 'init', directory: f.directory, prepared: f.prepared, authorizedCount: 1 });
  const call = (operation, ...args) => bridge({ operation, directory: f.directory, args });
  await call('prepare', 'A');
  assert.equal((await call('prepare', 'A')).action, 'skip');
  const original = path.join(f.root, 'later.png');
  await call('capture', 'A', { status: 'returned', receipt: { path: original } });
  assert.equal((await call('finalize', 'A')).stage, 'save');
  fs.writeFileSync(original, 'original bytes');
  assert.equal((await call('finalize', 'A', { recoverSave: true })).status, 'succeeded');
  assert.ok(fs.readdirSync(path.join(f.directory, 'events')).some(file => JSON.parse(fs.readFileSync(path.join(f.directory, 'events', file))).status === 'save-recovery'));
});
