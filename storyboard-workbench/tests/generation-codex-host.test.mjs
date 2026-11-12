import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bridge, prepareRequests } from '../scripts/generation_bridge.mjs';
import { runCodexImageBatch, createGenerationNodeBridge } from '../scripts/generation_codex_host.mjs';

function fixture(count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-image-host-'));
  const source = path.join(root, 'source.json'), prepared = path.join(root, 'prepared.json'), directory = path.join(root, 'batch');
  fs.writeFileSync(source, JSON.stringify({ text: '中文完整构图与摄影正文。' }), 'utf8');
  fs.writeFileSync(prepared, JSON.stringify(prepareRequests({ batchId: 'codex-test', version: 'v1', phase: 'characters', tool: 'imagegen',
    jobs: Array.from({ length: count }, (_, i) => ({ id: 'A' + i, count: 1, source: { path: source, pointer: '/text' }, request: { transparent_background: false } })) })), 'utf8');
  const image = path.join(root, 'original.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lmN0AAAAASUVORK5CYII=', 'base64'));
  return { root, source, image, options: { directory, prepared, authorizedCount: count, bridge, displayImage: () => {} } };
}

test('CLI host-source saves before preview and continues without a model reading each result', async () => {
  const f = fixture(4);
  const cli = spawnSync(process.execPath, ['storyboard-workbench/scripts/generation.mjs', 'codex-host-source'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const run = new Function(cli.stdout + '\nreturn runCodexImageBatch;')();
  let calls = 0, previews = 0;
  const result = await run({ ...f.options, bridge: createGenerationNodeBridge(process.execPath),
    generateImage: async request => {
      assert.equal(request.prompt, '中文完整构图与摄影正文。');
      if (calls) assert.equal(fs.existsSync(path.join(f.options.directory, 'captures', 'A' + (calls - 1) + '.json')), true);
      calls++;
      return { path: f.image, image_url: 'data:image/png;base64,not-for-journal' };
    },
    displayImage: () => {
      assert.equal(fs.existsSync(path.join(f.options.directory, 'captures', 'A' + previews + '.json')), true);
      previews++;
      if (previews === 1) throw new Error('viewer unavailable');
      if (previews === 2) return new Promise(() => {});
    }
  });
  assert.equal(calls, 4);
  assert.equal(previews, 4);
  assert.deepEqual(result.counts, { succeeded: 4 });
  assert.equal(result.preview.errors.length, 2);
  assert.equal(result.preview.emitted, 2);
  assert.equal(result.images.length, 4);
  for (const image of result.images) assert.ok(fs.readFileSync(image.path).equals(fs.readFileSync(f.image)));
  const summary = JSON.parse(fs.readFileSync(path.join(f.options.directory, result.path), 'utf8'));
  assert.equal(summary.report.returnToCaptureMs.length, 4);
  assert.equal(summary.report.nextSubmissionAfterCaptureMs.length, 3);
  assert.equal(summary.report.timing.batchWallMs, summary.report.totalMs);
  assert.equal(JSON.stringify(summary).includes('data:image'), false);
  await run({ ...f.options, generateImage: () => { throw new Error('successful output must not regenerate'); } });
});

test('interruption after capture resumes original saving without generation or preview replay', async () => {
  const f = fixture();
  await bridge({ ...f.options, operation: 'init' });
  await bridge({ operation: 'prepare', directory: f.options.directory, args: ['A0'] });
  await bridge({ operation: 'capture', directory: f.options.directory, args: ['A0', { status: 'returned', receipt: { path: f.image } }] });
  const result = await runCodexImageBatch({ ...f.options,
    generateImage: () => { throw new Error('never regenerate'); }, displayImage: () => { throw new Error('no raw receipt preview replay'); }
  });
  assert.deepEqual(result.counts, { succeeded: 1 });
  assert.equal(result.preview.emitted, 0);
});

test('unknown generation remains unknown and stops new submissions on restart', async () => {
  const f = fixture(2);
  let calls = 0;
  const options = { ...f.options, generateImage: () => { calls++; throw new Error('network outcome unknown'); } };
  const first = await runCodexImageBatch(options);
  assert.equal(first.counts.unknown, 1);
  assert.equal(calls, 1);
  await runCodexImageBatch(options);
  assert.equal(calls, 1);
});

test('source changes and wrong tools cannot reach native generation', async () => {
  const f = fixture();
  fs.writeFileSync(f.source, JSON.stringify({ text: 'changed' }), 'utf8');
  await assert.rejects(runCodexImageBatch({ ...f.options, generateImage: () => assert.fail('changed source') }), /来源已变化/);
  await assert.rejects(runCodexImageBatch({ ...f.options, bridge: async () => ({ tool: 'other' }), generateImage: () => assert.fail('wrong tool') }), /只接受imagegen/);
  assert.throws(() => createGenerationNodeBridge('node'), /绝对路径/);
  await assert.rejects(createGenerationNodeBridge(process.execPath)({ operation: 'invalid', directory: path.join(f.root, 'missing') }));
});
