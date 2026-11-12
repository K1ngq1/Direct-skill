import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bridge } from '../scripts/generation_bridge.mjs';
import { runCodexImageStream, codexImageHostSource } from '../scripts/generation_codex_host.mjs';

const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value), 'utf8');
function fixture(ids, dependencies = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-stream-'));
  const image = path.join(root, 'original.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lmN0AAAAASUVORK5CYII=', 'base64'));
  const tasks = ids.map(id => ({ id, recipe: path.join(root, id + '.json'), dependsOn: dependencies[id] ?? [] }));
  const publish = (id, phase = 'characters', references = []) => {
    const source = path.join(root, id + '-text.json');
    const text = id + ' 完整中文画面';
    const promptSha256 = createHash('sha256').update(JSON.stringify(text)).digest('hex');
    save(source, { text, hard: { status: 'passed', reviewer: 'fixture-validator', promptSha256 }, semantic: { status: 'passed', reviewer: 'fixture-reviewer', promptSha256 } });
    const recipe = { batchId: id, version: 'v1', phase, tool: 'imagegen', checks: { hard: { path: source, pointer: '/hard' }, semantic: { path: source, pointer: '/semantic' } },
      jobs: [{ id, count: 1, source: { path: source, pointer: '/text' }, request: {}, references, requiredAssetIds: references.map(r => r.assetId) }] };
    save(tasks.find(t => t.id === id).recipe, recipe);
    return source;
  };
  return { root, image, tasks, publish,
    init: () => bridge({ operation: 'stream-init', directory: root, tasks, authorizedCount: tasks.length }),
    close: () => bridge({ operation: 'stream-close', directory: root }),
    options: { directory: root, bridge, displayImage: () => {}, pollIntervalMs: 10 } };
}

test('a first shot runs before the delayed beach and late prompts, with one generation slot', async () => {
  const f = fixture(['C', 'R', 'S', 'B', 'L'], { S: ['C', 'R'] });
  const refs = ['C', 'R'].map(id => ({ assetId: id, path: path.join(f.root, id, 'images', id + '.png'), confirmation: { path: path.join(f.root, id + '-adopt.json'), pointer: '' } }));
  f.publish('C'); f.publish('R'); f.publish('S', 'storyboards', refs);
  await f.init();
  const order = []; let active = 0, peak = 0;
  const run = new Function(codexImageHostSource() + '\nreturn runCodexImageStream;')();
  const result = await run({ ...f.options,
    generateImage: async request => {
      const id = request.prompt.split(' ')[0]; order.push(id);
      peak = Math.max(peak, ++active);
      if (id === 'S') {
        assert.equal(fs.existsSync(f.tasks.find(t => t.id === 'L').recipe), false);
        f.publish('B', 'scenes'); f.publish('L'); await f.close();
      }
      await new Promise(resolve => setTimeout(resolve, 5)); active--; return { path: f.image };
    },
    displayImage: () => {
      const id = order.at(-1);
      if (['C', 'R'].includes(id)) save(path.join(f.root, id + '-adopt.json'), { status: 'confirmed', by: 'user', assetId: id,
        path: path.join(f.root, id, 'images', id + '.png'), sha256: createHash('sha256').update(fs.readFileSync(f.image)).digest('hex') });
    }
  });
  assert.deepEqual(order, ['C', 'R', 'S', 'B', 'L']); assert.equal(peak, 1);
  assert.equal(result.statuses.S.status, 'succeeded'); assert.equal(result.submissions.length, 5);
  assert.ok(result.submissions.every(s => s.waitMs >= 0));
  assert.equal(result.startSource, 'first-observation'); assert.equal(result.deliveryWallMs, null);
  const resumed = await run({ ...f.options, generateImage: () => assert.fail('must not regenerate') });
  assert.equal(resumed.submissions.length, 0);
  const delivered = await bridge({ operation: 'stream-delivered', directory: f.root, summary: resumed.path,
    finishedAt: new Date(Date.parse(resumed.finishedAt) + 100).toISOString() });
  assert.equal(delivered.deliveryWallMs, resumed.runWallMs + 100);
});

test('unadopted reference blocks only its shot and missing prompts end after producer closes', async () => {
  const f = fixture(['C', 'S', 'B', 'L'], { S: ['C'] });
  f.publish('C'); f.publish('B', 'scenes');
  const ref = { assetId: 'C', path: f.image, confirmation: { path: path.join(f.root, 'adopt.json'), pointer: '' } };
  save(ref.confirmation.path, { status: 'pending', assetId: 'C' });
  f.publish('S', 'storyboards', [ref]); await f.init(); await f.close();
  const order = [];
  const result = await runCodexImageStream({ ...f.options, generateImage: async r => { order.push(r.prompt.split(' ')[0]); return { path: f.image }; } });
  assert.deepEqual(order, ['C', 'B']);
  assert.ok(result.blocked.some(b => b.id === 'S')); assert.ok(result.blocked.some(b => b.id === 'L'));
});

test('unknown receipt survives restart and prevents replacement submissions', async () => {
  const f = fixture(['C', 'R']); f.publish('C'); f.publish('R'); await f.init();
  let calls = 0;
  const options = { ...f.options, generateImage: async () => { calls++; throw new Error('outcome unknown'); } };
  assert.equal((await runCodexImageStream(options)).unknown, true);
  assert.equal((await runCodexImageStream(options)).unknown, true); assert.equal(calls, 1);
});

test('prompt revisions invalidate only their frozen job and incomplete checks never submit', async () => {
  const f = fixture(['C', 'R']); const source = f.publish('C'); const other = f.publish('R');
  const doc = JSON.parse(fs.readFileSync(other, 'utf8')); doc.semantic.status = 'pending'; save(other, doc);
  await f.init(); await f.close();
  let calls = 0;
  const options = { ...f.options, generateImage: async () => { calls++; return { path: f.image }; } };
  const result = await runCodexImageStream(options); assert.equal(calls, 1); assert.equal(result.statuses.C.status, 'succeeded');
  const changed = JSON.parse(fs.readFileSync(source, 'utf8')); changed.text = 'revised'; save(source, changed);
  assert.equal((await runCodexImageStream(options)).statuses.C.status, 'stale'); assert.equal(calls, 1);
});

test('active stream lock rejects a second host and cyclic inventories reject before dispatch', async () => {
  const f = fixture(['C']); await f.init();
  const lease = await bridge({ operation: 'stream-acquire', directory: f.root });
  await assert.rejects(runCodexImageStream({ ...f.options, generateImage: () => assert.fail() }), /进程锁/);
  await bridge({ operation: 'stream-release', directory: f.root, owner: lease.owner });
  const cyclic = fixture(['A', 'B'], { A: ['B'], B: ['A'] }); await assert.rejects(cyclic.init(), /循环/);
});

test('returned receipt with a failed local finalizer halts once and resumes saving without regeneration', async () => {
  const f = fixture(['C', 'R']); f.publish('C'); f.publish('R'); await f.init(); await f.close();
  let calls = 0;
  const result = await runCodexImageStream({ ...f.options,
    bridge: r => { if (r.operation === 'finalize') throw new Error('local save unavailable'); return bridge(r); },
    generateImage: async () => { calls++; return { path: f.image }; }
  });
  assert.ok(result.halted); assert.equal(calls, 1);
  await runCodexImageStream({ ...f.options, generateImage: async () => { calls++; return { path: f.image }; } });
  assert.equal(calls, 2);
});

test('the stream releases a dependent image in the same run after a saved finalizer loses its reply', async () => {
  const f = fixture(['C', 'R'], { R: ['C'] });
  f.tasks.forEach(task => f.publish(task.id));
  await f.init(); await f.close();
  const submitted = [], checked = [];
  const result = await runCodexImageStream({ ...f.options,
    bridge: async request => {
      const saved = await bridge(request);
      if (request.operation === 'finalize' && request.args[0] === 'C') throw new Error('saved response lost');
      if (request.operation === 'reconcileFinalization') checked.push(request.args[0]);
      return saved;
    },
    generateImage: async request => { submitted.push(request.prompt.split(' ')[0]); return { path: f.image }; }
  });
  assert.deepEqual(checked, ['C']);
  assert.deepEqual(submitted, ['C', 'R']);
  assert.equal(result.statuses.R.status, 'succeeded');
  const [check] = result.batches.flatMap(batch => batch.finalizationChecks ?? []);
  assert.equal(check.id, 'C');
  assert.ok(check.stopToResumeMs >= 0);
});

test('new recipes and adoption are discovered while the host waits, recording first usable shot', async () => {
  const f = fixture(['S']);
  const adopted = path.join(f.root, 'shot-adoption.json'); f.tasks[0].adoption = { path: adopted, pointer: '' };
  await f.init();
  const confirmation = path.join(f.root, 'reference.json');
  save(confirmation, { status: 'confirmed', by: 'user', assetId: 'C', path: f.image, sha256: createHash('sha256').update(fs.readFileSync(f.image)).digest('hex') });
  let calls = 0;
  const running = runCodexImageStream({ ...f.options, generateImage: async () => { calls++; return { path: f.image }; }, displayImage: () => {
    setTimeout(() => save(adopted, { status: 'succeeded', approval: { status: 'confirmed', by: 'user', confirmedAt: new Date().toISOString() },
      output: { path: 'S/images/S.png', sha256: createHash('sha256').update(fs.readFileSync(f.image)).digest('hex') } }), 30);
  } });
  setTimeout(() => f.publish('S', 'storyboards', [{ assetId: 'C', path: f.image, confirmation: { path: confirmation, pointer: '' } }]), 30);
  const result = await running;
  assert.equal(calls, 1); assert.ok(result.firstUsableStoryboardMs >= 0); assert.ok(result.firstUsableStoryboardAt);
  const resumed = await runCodexImageStream({ ...f.options, generateImage: () => assert.fail('must not regenerate') });
  assert.equal(resumed.firstUsableStoryboardAt, result.firstUsableStoryboardAt);
});

test('context pointers isolate an unrelated scene edit and invalidate the changed dependency', async () => {
  const f = fixture(['C', 'B']); f.publish('C'); f.publish('B', 'scenes');
  const context = path.join(f.root, 'contexts.json'); save(context, { bedroom: 'bedroom', beach: 'beach' });
  for (const [id, pointer] of [['C', '/bedroom'], ['B', '/beach']]) {
    const file = f.tasks.find(t => t.id === id).recipe, recipe = JSON.parse(fs.readFileSync(file, 'utf8'));
    recipe.jobs[0].contextSources = [{ path: context, pointer }]; save(file, recipe);
  }
  await f.init(); await f.close();
  const options = { ...f.options, generateImage: async () => ({ path: f.image }) };
  await runCodexImageStream(options); save(context, { bedroom: 'bedroom', beach: 'changed beach' });
  const result = await runCodexImageStream({ ...options, generateImage: () => assert.fail('frozen tasks must not regenerate') });
  assert.equal(result.statuses.C.status, 'succeeded'); assert.equal(result.statuses.B.status, 'stale');
});

test('next generation starts during prior finalization and an old completion never releases its slot', { timeout: 5000 }, async () => {
  const f = fixture(['C', 'R', 'L']); f.tasks.forEach(t => f.publish(t.id)); await f.init(); await f.close();
  let release, finalizing = false, generation = 0, peak = 0;
  const barrier = new Promise(resolve => { release = resolve; }), order = [];
  const run = new Function(codexImageHostSource() + '\nreturn runCodexImageStream;')();
  const result = await run({ ...f.options,
    bridge: async request => {
      if (request.operation === 'finalize' && request.args[0] === 'C') { finalizing = true; await barrier; }
      return bridge(request);
    },
    generateImage: async request => {
      const id = request.prompt.split(' ')[0]; order.push(id); peak = Math.max(peak, ++generation);
      if (id === 'R') {
        assert.equal(finalizing, true);
        assert.equal(fs.existsSync(path.join(f.root, 'C', 'results', 'C.json')), false);
        release();
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.deepEqual(order, ['C', 'R']);
      }
      generation--; return { path: f.image };
    }
  });
  assert.equal(peak, 1); assert.deepEqual(order, ['C', 'R', 'L']);
  assert.equal(result.statuses.C.status, 'succeeded'); assert.equal(result.statuses.L.status, 'succeeded');
});

test('slow disk backpressure caps live microbatches at four with one finalizer', { timeout: 5000 }, async () => {
  const f = fixture(['A', 'B', 'C', 'D', 'E', 'F']); f.tasks.forEach(t => f.publish(t.id)); await f.init(); await f.close();
  let release, diskActive = 0, peakDisk = 0;
  const barrier = new Promise(resolve => { release = resolve; }), calls = [];
  const result = await runCodexImageStream({ ...f.options,
    bridge: async request => {
      if (request.operation !== 'finalize') return bridge(request);
      peakDisk = Math.max(peakDisk, ++diskActive);
      try { if (request.args[0] === 'A') await barrier; return await bridge(request); }
      finally { diskActive--; }
    },
    generateImage: async request => { calls.push(request.prompt.split(' ')[0]); return { path: f.image }; },
    displayImage: () => {
      if (calls.length === 4) setTimeout(() => {
        assert.equal(calls.length, 4); release();
      }, 30);
    }
  });
  assert.equal(peakDisk, 1); assert.equal(calls.length, 6); assert.equal(result.batches.length, 6);
});

test('a late disk failure drains the already submitted peer and blocks further tools', { timeout: 5000 }, async () => {
  const f = fixture(['C', 'R', 'L']); f.tasks.forEach(t => f.publish(t.id)); await f.init(); await f.close();
  let release;
  const barrier = new Promise(resolve => { release = resolve; }), calls = [];
  const result = await runCodexImageStream({ ...f.options,
    bridge: async request => {
      if (request.operation === 'finalize' && request.args[0] === 'C') { await barrier; throw new Error('disk failure'); }
      return bridge(request);
    },
    generateImage: async request => {
      const id = request.prompt.split(' ')[0]; calls.push(id);
      if (id === 'R') { release(); await new Promise(resolve => setTimeout(resolve, 20)); }
      return { path: f.image };
    }
  });
  assert.ok(result.halted); assert.deepEqual(calls, ['C', 'R']);
  assert.equal(result.statuses.C.status, 'returned'); assert.equal(result.statuses.R.status, 'succeeded');
});

test('a prompt published during disk finalization starts without waiting for the disk', { timeout: 5000 }, async () => {
  const f = fixture(['C', 'R']); f.publish('C'); await f.init();
  let release;
  const barrier = new Promise(resolve => { release = resolve; }), calls = [];
  const result = await runCodexImageStream({ ...f.options,
    bridge: async request => {
      if (request.operation === 'finalize' && request.args[0] === 'C') {
        setTimeout(() => { f.publish('R'); void f.close(); }, 30);
        await barrier;
      }
      return bridge(request);
    },
    generateImage: async request => {
      const id = request.prompt.split(' ')[0]; calls.push(id);
      if (id === 'R') {
        assert.equal(fs.existsSync(path.join(f.root, 'C', 'results', 'C.json')), false); release();
      }
      return { path: f.image };
    }
  });
  assert.deepEqual(calls, ['C', 'R']); assert.equal(result.statuses.R.status, 'succeeded');
});

test('failed receipt persistence never releases the generation slot for a peer', async () => {
  const f = fixture(['C', 'R']); f.tasks.forEach(t => f.publish(t.id)); await f.init(); await f.close();
  let calls = 0;
  const result = await runCodexImageStream({ ...f.options,
    bridge: request => { if (request.operation === 'capture') throw new Error('receipt persistence failed'); return bridge(request); },
    generateImage: async () => { calls++; return { path: f.image }; }
  });
  assert.equal(calls, 1); assert.ok(result.halted); assert.equal(result.unknown, true);
});
