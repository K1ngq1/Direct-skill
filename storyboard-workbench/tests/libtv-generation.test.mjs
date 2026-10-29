import test from 'node:test';
import assert from 'node:assert/strict';
import { runLibTVGenerationBatch, libtvGenerationHostSource } from '../scripts/libtv_generation.mjs';

const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const job = id => ({ id, count: 1, submitTool: 'generation_submit', submitArgs: { project_id: 'project-test', kind: 'image', idempotency_key: `original-${id}`, request: { model: 'mock-only', prompt: '测试正文，保持原样。', params: { count: 1 } } } });

function harness(jobs) {
  const batch = { batchId: 'mock-generation', version: 'v1', phase: 'scenes' };
  const control = { ...batch, revision: 0, paused: false, concurrency: 4 };
  const receipts = new Map(), calls = [], writes = [], finalized = [], summaries = [], waits = [];
  let acquired = 0, released = 0;
  const options = {
    batch, allowNewSubmissions: true, maxPolls: 2, pollIntervalMs: 0,
    acquire: async () => { acquired++; },
    release: async () => { released++; },
    snapshot: async () => Object.fromEntries([...receipts].map(([id, { state, taskId }]) => [id, { state, ...(taskId ? { taskId } : {}) }])),
    prepare: async id => ({ job: clone(jobs.find(entry => entry.id === id)), receipt: clone(receipts.get(id)), control: clone(control) }),
    writeReceipt: async (id, value, { exclusive = false } = {}) => {
      if (exclusive && receipts.has(id)) throw new Error('receipt already exists');
      receipts.set(id, clone(value)); writes.push({ id, ...clone(value) });
    },
    readControl: async () => clone(control),
    acknowledgeControl: async () => {},
    call: async (name, args) => {
      calls.push([name, clone(args)]);
      if (name === 'generation_submit' || name === 'create_node') {
        const entry = jobs.find(value => JSON.stringify(value.submitArgs) === JSON.stringify(args));
        assert.ok(entry, 'only the frozen request may be submitted');
        assert.equal(receipts.get(entry.id)?.state, 'submitting');
        return { structuredContent: { task_id: `task-${entry.id}` } };
      }
      assert.equal(name, 'task_status');
      const id = args.task_id.replace(/^task-/, '');
      assert.equal(receipts.get(id)?.taskId, args.task_id, 'task identity must be persisted before polling');
      return { testTask: { projectId: args.project_id, taskId: args.task_id, state: 'succeeded', outputs: [{ nodeId: `node-${id}` }] } };
    },
    // This is an explicit mock response contract, not a claim about LibTV's open response schema.
    normalizeTask: async response => response.testTask,
    finalize: async (entry, receipt) => {
      assert.equal(receipt.state, 'generated');
      finalized.push(entry.id);
      return { files: [{ path: `mock/${entry.id}.png`, sha256: 'a'.repeat(64) }] };
    },
    wait: async ms => { waits.push(ms); },
    summarize: async (results, report) => { const summary = clone({ results, report }); summaries.push(summary); return summary; }
  };
  return { options, receipts, calls, writes, finalized, summaries, waits, control, locks: () => ({ acquired, released }) };
}

test('default four outstanding calls refill while the first save and slow peers remain unfinished', { timeout: 3000 }, async () => {
  const jobs = ['A', 'B', 'C', 'D', 'E'].map(job), mock = harness(jobs);
  const firstFour = deferred(), slow = deferred(), saving = deferred(), fifth = deferred();
  let submissions = 0, active = 0, peak = 0, activeFinalizers = 0, peakFinalizers = 0;
  const call = mock.options.call, finalize = mock.options.finalize;
  mock.options.finalize = async (entry, receipt) => {
    activeFinalizers++; peakFinalizers = Math.max(peakFinalizers, activeFinalizers);
    try {
      if (entry.id === 'A') await saving.promise;
      return await finalize(entry, receipt);
    } finally { activeFinalizers--; }
  };
  mock.options.call = async (name, args) => {
    active++; peak = Math.max(peak, active);
    try {
      if (name === 'generation_submit') {
        submissions++;
        if (submissions === 4) firstFour.resolve();
        if (submissions <= 4) await firstFour.promise;
        else fifth.resolve();
      }
      if (name === 'task_status' && ['task-B', 'task-C', 'task-D'].includes(args.task_id)) await slow.promise;
      return await call(name, args);
    } finally { active--; }
  };
  const running = runLibTVGenerationBatch(jobs, mock.options);
  try {
    await fifth.promise;
    assert.equal(mock.receipts.get('A').state, 'generated');
    assert.equal(mock.finalized.includes('A'), false);
    assert.deepEqual(['B', 'C', 'D'].map(id => mock.receipts.get(id).state), ['pending', 'pending', 'pending']);
    assert.equal(peak, 4);
  } finally { slow.resolve(); saving.resolve(); }
  const summary = await running;
  assert.ok(summary.results.every(value => value.status === 'succeeded'));
  assert.equal(summary.report.peakOutstandingCalls, 4);
  assert.equal(peakFinalizers, 1);
  assert.equal(summary.report.observedToolExecutionPeak, null);
  assert.equal(summary.report.serverExecutionPeak, null);
  assert.equal(mock.summaries.length, 1);
  assert.deepEqual(mock.locks(), { acquired: 1, released: 1 });
});

test('pending and unknown tasks with durable IDs recover only by querying the original task', async () => {
  const jobs = ['A', 'B'].map(job), mock = harness(jobs);
  mock.receipts.set('A', { state: 'pending', taskId: 'task-A' });
  mock.receipts.set('B', { state: 'unknown', taskId: 'task-B', error: 'connection lost' });
  const summary = await runLibTVGenerationBatch(jobs, { ...mock.options, allowNewSubmissions: false });
  assert.deepEqual(mock.calls.map(([name, args]) => [name, args.task_id]), [['task_status', 'task-A'], ['task_status', 'task-B']]);
  assert.ok(summary.results.every(value => value.status === 'succeeded'));
  assert.equal(summary.report.submitted, 0);
  assert.equal(summary.report.recoveredSubmissions, 0);
});

test('unknown submission requires explicit recovery and reuses the exact original tool and arguments', async t => {
  for (const tool of ['generation_submit', 'create_node']) await t.test(tool, async () => {
    const entry = job('A');
    if (tool === 'create_node') Object.assign(entry, { submitTool: tool, submitArgs: { projectId: 'project-test', idempotencyKey: 'original-A', nodeType: 'image', run: true, name: 'A', params: { model: 'mock-only', count: 1 }, prompt: '原始正文。' } });
    const mock = harness([entry]);
    mock.receipts.set('A', { state: 'unknown', submittedAt: '2026-10-23T00:00:00.000Z' });
    const first = await runLibTVGenerationBatch([entry], mock.options);
    assert.equal(first.results[0].status, 'unknown');
    assert.deepEqual(mock.calls, []);
    const call = mock.options.call;
    mock.options.call = async (name, args) => {
      if (name !== 'task_status') {
        assert.equal(name, tool); assert.deepEqual(args, entry.submitArgs);
        mock.calls.push([name, clone(args)]);
        return { structuredContent: { task_id: 'task-A' } };
      }
      return call(name, args);
    };
    const resumed = await runLibTVGenerationBatch([entry], { ...mock.options, allowNewSubmissions: false, recoverUnknownSubmission: true });
    assert.equal(resumed.results[0].status, 'succeeded');
    assert.equal(resumed.report.submitted, 0);
    assert.equal(resumed.report.recoveredSubmissions, 1);
    assert.equal(mock.calls.filter(([name]) => name === tool).length, 1);
  });
});

test('poll budget leaves a durable pending checkpoint and the next run does not resubmit', async () => {
  const entry = job('A'), mock = harness([entry]), call = mock.options.call;
  mock.options.call = async (name, args) => {
    const response = await call(name, args);
    if (name === 'task_status') response.testTask = { ...response.testTask, state: 'pending', outputs: [] };
    return response;
  };
  const first = await runLibTVGenerationBatch([entry], mock.options);
  assert.equal(first.results[0].status, 'pending');
  assert.equal(first.report.polls, 2);
  assert.equal(mock.receipts.get('A').taskId, 'task-A');
  assert.equal(mock.finalized.length, 0);
  assert.equal(mock.waits.length, 1);
  mock.options.call = call;
  const resumed = await runLibTVGenerationBatch([entry], { ...mock.options, allowNewSubmissions: false });
  assert.equal(resumed.results[0].status, 'succeeded');
  assert.equal(mock.calls.filter(([name]) => name === 'generation_submit').length, 1);
});

test('unfinished remote tasks retain the batch budget instead of dispatching all remaining jobs', async t => {
  for (const failure of ['poll-budget', 'query-failure']) await t.test(failure, async () => {
    const jobs = Array.from({ length: 10 }, (_, index) => job(`S${index}`)), mock = harness(jobs);
    const firstFour = deferred(); let submissions = 0;
    const call = mock.options.call;
    mock.options.call = async (name, args) => {
      if (name === 'generation_submit') {
        if (++submissions === 4) firstFour.resolve();
        await firstFour.promise;
      }
      const response = await call(name, args);
      if (name === 'task_status') {
        if (failure === 'query-failure') throw new Error('status connection lost');
        response.testTask = { ...response.testTask, state: 'pending', outputs: [] };
      }
      return response;
    };
    const summary = await runLibTVGenerationBatch(jobs, { ...mock.options, maxPolls: 1 });
    assert.equal(submissions, 4);
    assert.deepEqual(summary.results.slice(0, 4).map(value => value.status), Array(4).fill(failure === 'poll-budget' ? 'pending' : 'unknown'));
    assert.deepEqual(summary.results.slice(4).map(value => value.status), Array(6).fill('paused'));
    assert.ok(summary.results.slice(0, 4).every(value => value.taskId));
    assert.equal(mock.calls.filter(([name]) => name === 'task_status').length, 4);
  });
});

test('restart recovers existing tasks before allowing a fresh batch even when new jobs appear first', async () => {
  const jobs = ['NEW', 'A', 'B', 'C', 'D'].map(job), mock = harness(jobs);
  for (const id of ['A', 'B', 'C', 'D']) mock.receipts.set(id, { state: 'pending', taskId: `task-${id}` });
  const summary = await runLibTVGenerationBatch(jobs, mock.options);
  assert.equal(mock.calls.filter(([name]) => name === 'generation_submit').length, 0);
  assert.deepEqual(summary.results.map(value => value.status), ['paused', 'succeeded', 'succeeded', 'succeeded', 'succeeded']);
  assert.deepEqual(new Set(mock.calls.map(([, args]) => args.task_id)), new Set(['task-A', 'task-B', 'task-C', 'task-D']));
});

test('pause stops new submission while accepted tasks drain and delivery stays blocked', async () => {
  const jobs = ['A', 'B', 'C'].map(job), mock = harness(jobs);
  const accepted = deferred(); let submissions = 0;
  mock.control.concurrency = 2;
  const call = mock.options.call;
  mock.options.call = async (name, args) => {
    if (name === 'generation_submit') {
      if (++submissions === 2) { mock.control.paused = true; mock.control.revision++; accepted.resolve(); }
      await accepted.promise;
    }
    return call(name, args);
  };
  const summary = await runLibTVGenerationBatch(jobs, { ...mock.options, concurrency: 2 });
  assert.deepEqual(summary.results.map(value => value.status), ['succeeded', 'succeeded', 'paused']);
  assert.equal(mock.calls.filter(([name]) => name === 'generation_submit').length, 2);
  assert.equal(mock.calls.filter(([name]) => name === 'task_status').length, 2);
  assert.equal(summary.report.deliveryAllowed, false);
});

test('delivery failure resumes only local finalization and failed tasks never trigger replacement generation', async () => {
  const jobs = ['A', 'B'].map(job), mock = harness(jobs);
  const call = mock.options.call, finalize = mock.options.finalize;
  mock.options.call = async (name, args) => {
    const response = await call(name, args);
    if (name === 'task_status' && args.task_id === 'task-B') response.testTask = { ...response.testTask, state: 'failed', outputs: [] };
    return response;
  };
  mock.options.finalize = async () => { throw new Error('local save interrupted'); };
  const first = await runLibTVGenerationBatch(jobs, mock.options);
  assert.deepEqual(first.results.map(value => value.status), ['generated', 'failed']);
  assert.equal(mock.receipts.get('A').state, 'generated');
  const callsBefore = mock.calls.length;
  mock.options.finalize = finalize;
  const resumed = await runLibTVGenerationBatch(jobs, { ...mock.options, allowNewSubmissions: false });
  assert.deepEqual(resumed.results.map(value => value.status), ['succeeded', 'failed']);
  assert.equal(mock.calls.length, callsBefore);
  assert.deepEqual(mock.finalized, ['A']);
});

test('task identity, project, canvas receipts and output quantity fail closed without finalizing', async t => {
  const invalid = [
    ['different task', value => ({ ...value, taskId: 'another-task' })],
    ['different project', value => ({ ...value, projectId: 'another-project' })],
    ['canvas receipt', value => ({ ...value, taskId: 'cop_canvas-write' })],
    ['extra output', value => ({ ...value, outputs: [...value.outputs, { nodeId: 'extra-node' }] })],
    ['unrecognized status', value => ({ ...value, state: 'done-maybe' })],
    ['URL as identity', value => ({ ...value, outputs: [{ nodeId: 'https://example.invalid/image.png' }] })]
  ];
  for (const [name, corrupt] of invalid) await t.test(name, async () => {
    const entry = job('A'), mock = harness([entry]);
    mock.options.normalizeTask = async response => corrupt(response.testTask);
    const summary = await runLibTVGenerationBatch([entry], mock.options);
    assert.equal(summary.results[0].status, 'unknown');
    assert.equal(mock.receipts.get('A').taskId, 'task-A');
    assert.equal(mock.receipts.get('A').state, 'unknown');
    assert.deepEqual(mock.finalized, []);
    assert.equal(mock.calls.filter(([tool]) => tool === 'generation_submit').length, 1);
  });
});

test('submission errors preserve a returned durable identity and never query a cop_ receipt', async t => {
  for (const taskId of ['task-A', 'cop_write-only']) await t.test(taskId, async () => {
    const entry = job('A'), mock = harness([entry]);
    mock.options.call = async (name, args) => { mock.calls.push([name, clone(args)]); return { isError: true, structuredContent: { task_id: taskId } }; };
    const summary = await runLibTVGenerationBatch([entry], mock.options);
    assert.equal(summary.results[0].status, 'unknown');
    assert.equal(mock.receipts.get('A').taskId, taskId === 'task-A' ? taskId : undefined);
    assert.equal(mock.calls.length, 1);
  });
});

test('failure to persist an accepted task stops further submission and retains its ID in the handoff', async () => {
  const jobs = ['A', 'B'].map(job), mock = harness(jobs), writeReceipt = mock.options.writeReceipt;
  mock.options.writeReceipt = async (id, receipt, options) => {
    if (id === 'A' && receipt.taskId) throw new Error('checkpoint disk unavailable');
    return writeReceipt(id, receipt, options);
  };
  const summary = await runLibTVGenerationBatch(jobs, { ...mock.options, concurrency: 1 });
  assert.equal(summary.results[0].status, 'unknown');
  assert.equal(summary.results[0].taskId, 'task-A');
  assert.equal(summary.results[1].status, 'paused');
  assert.equal(mock.calls.filter(([name]) => name === 'generation_submit').length, 1);
  assert.equal(mock.receipts.get('A').state, 'submitting');
  assert.ok(summary.report.stopped);
  assert.equal(summary.report.deliveryAllowed, false);
});

test('missing required boundaries reject before acquiring or submitting and summary errors release ownership', async () => {
  for (const missing of ['normalizeTask', 'summarize', 'snapshot']) {
    const entry = job('A'), mock = harness([entry]);
    await assert.rejects(runLibTVGenerationBatch([entry], { ...mock.options, [missing]: undefined }), /回调/);
    assert.deepEqual(mock.calls, []);
    assert.deepEqual(mock.locks(), { acquired: 0, released: 0 });
  }
  const invalid = harness([job('A')]);
  await assert.rejects(runLibTVGenerationBatch([job('A')], { ...invalid.options, finalize: null }), /回调/);
  const entry = job('A'), mock = harness([entry]);
  mock.options.summarize = async () => { throw new Error('summary write failed'); };
  await assert.rejects(runLibTVGenerationBatch([entry], mock.options), /summary write failed/);
  assert.equal(mock.receipts.get('A').state, 'succeeded');
  assert.deepEqual(mock.locks(), { acquired: 1, released: 1 });
});

test('host-source executes the same runner without imports and returns only the summary callback value', async () => {
  const source = libtvGenerationHostSource();
  assert.doesNotMatch(source, /^import\s/m);
  const run = new Function(`${source}; return runLibTVGenerationBatch;`)();
  const entry = job('A'), mock = harness([entry]), marker = { deliveryPath: 'mock/delivery.md', counts: { succeeded: 1 } };
  mock.options.summarize = async () => marker;
  assert.equal(await run([entry], mock.options), marker);
  assert.equal(mock.receipts.get('A').state, 'succeeded');
});

test('existing task plans persist identity before querying and can never submit under any recovery switches', async t => {
  for (const allowNewSubmissions of [false, true]) for (const recoverUnknownSubmission of [false, true]) await t.test(`${allowNewSubmissions}/${recoverUnknownSubmission}`, async () => {
    const entry = { id: 'A', count: 1, projectId: 'project-test', existingTaskId: 'task-A', outputNodeId: 'node-A' }, mock = harness([entry]);
    const summary = await runLibTVGenerationBatch([entry], { ...mock.options, allowNewSubmissions, recoverUnknownSubmission });
    assert.equal(summary.results[0].status, 'succeeded');
    assert.deepEqual(mock.calls.map(([name, args]) => [name, args]), [['task_status', { project_id: 'project-test', task_id: 'task-A' }]]);
    assert.equal(mock.writes[0].taskId, 'task-A');
    assert.equal(mock.writes[0].state, 'pending');
    assert.ok(mock.writes[0].recoveryAttachedAt);
    assert.equal(summary.report.submitted, 0);
    assert.equal(summary.report.recoveredSubmissions, 0);
  });
});

test('existing task query failure recovers the same identity and prevents dispatching mixed new jobs', async () => {
  const entry = { id: 'A', count: 1, projectId: 'project-test', existingTaskId: 'task-A' }, jobs = [job('NEW'), entry], mock = harness(jobs);
  const call = mock.options.call;
  mock.options.call = async (name, args) => { mock.calls.push([name, clone(args)]); throw new Error('query disconnected'); };
  const first = await runLibTVGenerationBatch(jobs, { ...mock.options, allowNewSubmissions: true, recoverUnknownSubmission: true });
  assert.deepEqual(first.results.map(item => item.status), ['paused', 'unknown']);
  assert.equal(mock.receipts.get('A').taskId, 'task-A');
  assert.deepEqual(mock.calls.map(([name]) => name), ['task_status']);
  assert.ok(first.report.events.some(event => event.type === 'task_status-returned' && event.durationMs >= 0));
  mock.options.call = call;
  const resumed = await runLibTVGenerationBatch(jobs, { ...mock.options, allowNewSubmissions: true });
  assert.deepEqual(resumed.results.map(item => item.status), ['paused', 'succeeded']);
  assert.deepEqual(mock.calls.map(([name, args]) => [name, args.task_id]), [['task_status', 'task-A'], ['task_status', 'task-A']]);
});

test('recovery plans reject mixed submission fields and mismatched observed output without fabricating success', async t => {
  const entry = { id: 'A', count: 1, projectId: 'project-test', existingTaskId: 'task-A', outputNodeId: 'node-A' };
  for (const corrupt of [{ submitArgs: job('A').submitArgs }, { submitTool: 'create_node' }, { existingTaskId: 'cop_canvas' }, { existingTaskId: '' }]) await t.test(JSON.stringify(corrupt), async () => {
    const invalid = { ...entry, ...corrupt }, mock = harness([invalid]);
    const summary = await runLibTVGenerationBatch([invalid], mock.options);
    assert.equal(summary.results[0].status, 'unknown');
    assert.deepEqual(mock.calls, []);
  });
  const mock = harness([entry]), call = mock.options.call;
  mock.options.call = async (name, args) => {
    const response = await call(name, args);
    response.testTask.outputs = [{ nodeId: 'different-node' }];
    return response;
  };
  const summary = await runLibTVGenerationBatch([entry], mock.options);
  assert.equal(summary.results[0].status, 'unknown');
  assert.deepEqual(mock.finalized, []);
  assert.equal(mock.receipts.get('A').taskId, 'task-A');
});

test('stage timing covers failed finalization and each restart measures only its own run', async () => {
  const entry = { id: 'A', count: 1, projectId: 'project-test', existingTaskId: 'task-A' }, mock = harness([entry]);
  const finalize = mock.options.finalize;
  mock.options.finalize = async () => { throw new Error('download interrupted'); };
  const first = await runLibTVGenerationBatch([entry], mock.options);
  assert.equal(first.results[0].status, 'generated');
  for (const type of ['prepare-returned', 'task_status-returned', 'receipt-returned', 'finalize-returned']) assert.ok(first.report.events.some(event => event.type === type && Number.isFinite(event.durationMs) && event.durationMs >= 0));
  assert.ok(['monotonic', 'utc-estimate'].includes(first.report.durationSource));
  assert.ok(first.report.workDurationMs >= 0);
  mock.options.finalize = finalize;
  const resumed = await runLibTVGenerationBatch([entry], mock.options);
  assert.equal(resumed.results[0].status, 'succeeded');
  assert.equal(resumed.report.events.some(event => event.type === 'task_status-started'), false);
  assert.equal(mock.calls.length, 1);
  assert.ok(resumed.report.workDurationMs >= 0);
  assert.ok(resumed.report.events.some(event => event.type === 'finalize-returned' && event.durationMs >= 0));
});

test('expired remote task context remains unknown with its exact error code and original task identity', async () => {
  const entry = { id: 'A', count: 1, projectId: 'project-test', existingTaskId: 'task-A' }, mock = harness([entry]);
  mock.options.call = async (name, args) => {
    mock.calls.push([name, clone(args)]);
    return { isError: true, content: [{ type: 'text', text: 'Error executing tool task_status: TASK_CONTEXT_UNAVAILABLE: Task context is absent or expired' }] };
  };
  const summary = await runLibTVGenerationBatch([entry], mock.options);
  assert.equal(summary.results[0].status, 'unknown');
  assert.equal(mock.receipts.get('A').taskId, 'task-A');
  assert.match(mock.receipts.get('A').error, /TASK_CONTEXT_UNAVAILABLE/);
  assert.deepEqual(mock.calls, [['task_status', { project_id: 'project-test', task_id: 'task-A' }]]);
  assert.deepEqual(mock.finalized, []);
  assert.equal(summary.report.submitted, 0);
});

test('eight remote-only jobs roll through four slots without any download callback', { timeout: 3000 }, async () => {
  const jobs = [...'ABCDEFGH'].map(job), mock = harness(jobs), gates = new Map(jobs.map(entry => [entry.id, deferred()]));
  const firstFour = deferred(), fifth = deferred(), call = mock.options.call;
  const { finalize, ...options } = mock.options;
  let remoteActive = 0, peakRemoteActive = 0, submissions = 0;
  options.call = async (tool, args) => {
    if (tool === 'generation_submit') {
      remoteActive++; peakRemoteActive = Math.max(peakRemoteActive, remoteActive);
      if (++submissions === 4) firstFour.resolve();
      if (submissions === 5) {
        assert.equal(mock.receipts.get('A').state, 'generated');
        assert.equal(mock.receipts.get('A').files, undefined);
        fifth.resolve();
      }
    } else {
      assert.equal(tool, 'task_status');
      await gates.get(args.task_id.slice(5)).promise;
      remoteActive--;
    }
    return call(tool, args);
  };
  const running = runLibTVGenerationBatch(jobs, options);
  try {
    await firstFour.promise;
    assert.equal(submissions, 4);
    gates.get('A').resolve();
    await fifth.promise;
    assert.deepEqual(['B', 'C', 'D'].map(id => mock.receipts.get(id).state), ['pending', 'pending', 'pending']);
    assert.equal(peakRemoteActive, 4);
  } finally { for (const gate of gates.values()) gate.resolve(); }
  const summary = await running;
  assert.equal(submissions, 8); assert.equal(remoteActive, 0); assert.equal(peakRemoteActive, 4);
  assert.ok(summary.results.every(item => item.status === 'generated' && item.outputs.length === 1));
  assert.ok([...mock.receipts.values()].every(item => item.state === 'generated' && item.files === undefined));
  assert.equal(summary.report.localFinalization, false);
  assert.equal(summary.report.peakPendingFinalization, 0);
  assert.equal(summary.report.events.some(event => event.type.startsWith('finalize-')), false);
  assert.deepEqual(mock.finalized, []);
  assert.ok(mock.calls.every(([tool]) => ['generation_submit', 'task_status'].includes(tool)));
});

test('remote-only dependency unlocks after persisted task success and generated restart makes no remote call', async () => {
  const jobs = [{ ...job('B'), dependsOn: ['A'] }, job('A')], mock = harness(jobs), call = mock.options.call;
  const { finalize, ...options } = mock.options;
  options.call = async (tool, args) => {
    if (tool === 'generation_submit' && args.idempotency_key === 'original-B') {
      assert.equal(mock.receipts.get('A').state, 'generated');
      assert.equal(mock.receipts.get('A').files, undefined);
    }
    return call(tool, args);
  };
  const first = await runLibTVGenerationBatch(jobs, options);
  assert.deepEqual(first.results.map(item => item.status), ['generated', 'generated']);
  const before = mock.calls.length;
  const resumed = await runLibTVGenerationBatch(jobs, { ...options, call: () => { throw new Error('generated task must not call remote'); } });
  assert.deepEqual(resumed.results.map(item => item.status), ['generated', 'generated']);
  assert.equal(mock.calls.length, before);
  assert.equal(resumed.report.polls, 0); assert.equal(resumed.report.submitted, 0);
  assert.deepEqual(mock.finalized, []);
});

test('remote-only mode retains pending and unknown capacity until the original task is reconciled', async t => {
  for (const failure of ['pending', 'unknown']) await t.test(failure, async () => {
    const jobs = [...'ABCDEFGH'].map(job), mock = harness(jobs), call = mock.options.call, firstFour = deferred();
    const { finalize, ...options } = mock.options;
    let submissions = 0;
    options.call = async (tool, args) => {
      if (tool === 'generation_submit') { if (++submissions === 4) firstFour.resolve(); await firstFour.promise; }
      const response = await call(tool, args);
      if (tool === 'task_status') {
        if (failure === 'unknown') throw new Error('status unavailable');
        response.testTask.state = 'pending'; response.testTask.outputs = [];
      }
      return response;
    };
    const first = await runLibTVGenerationBatch(jobs, { ...options, maxPolls: 1 });
    assert.equal(submissions, 4);
    assert.deepEqual(first.results.slice(0, 4).map(item => item.status), Array(4).fill(failure));
    assert.deepEqual(first.results.slice(4).map(item => item.status), Array(4).fill('paused'));
    const resumed = await runLibTVGenerationBatch(jobs, { ...options, call });
    assert.deepEqual(resumed.results.slice(0, 4).map(item => item.status), Array(4).fill('generated'));
    assert.deepEqual(resumed.results.slice(4).map(item => item.status), Array(4).fill('paused'));
    assert.equal(mock.calls.filter(([tool]) => tool === 'generation_submit').length, 4);
    assert.equal(mock.calls.filter(([tool]) => !['generation_submit', 'task_status'].includes(tool)).length, 0);
  });
});

test('new submissions reject outdated image request shapes without rewriting them', async t => {
  for (const change of [args => { delete args.kind; }, args => { delete args.request.prompt; }, args => { args.request.params = JSON.stringify(args.request.params); }]) await t.test('legacy shape', async () => {
    const entry = job('A'); change(entry.submitArgs);
    const original = clone(entry.submitArgs), mock = harness([entry]);
    const { finalize, ...options } = mock.options;
    const first = await runLibTVGenerationBatch([entry], options);
    assert.equal(first.results[0].status, 'unknown');
    assert.deepEqual(mock.calls, []); assert.deepEqual(entry.submitArgs, original);
    mock.receipts.set('A', { state: 'unknown', submittedAt: '2026-10-23T00:00:00.000Z' });
    options.call = async (tool, args) => {
      if (tool !== 'generation_submit') return mock.options.call(tool, args);
      assert.deepEqual(args, original); mock.calls.push([tool, clone(args)]);
      return { structuredContent: { task_id: 'task-A' } };
    };
    const resumed = await runLibTVGenerationBatch([entry], { ...options, recoverUnknownSubmission: true, allowNewSubmissions: false });
    assert.equal(resumed.results[0].status, 'generated');
    assert.deepEqual(mock.calls[0], ['generation_submit', original]);
    assert.equal(resumed.report.recoveredSubmissions, 1);
  });
});

test('host-source also supports submission tracking with finalize absent', async () => {
  const run = new Function(`${libtvGenerationHostSource()}; return runLibTVGenerationBatch;`)();
  const entry = job('A'), mock = harness([entry]), { finalize, ...options } = mock.options;
  const summary = await run([entry], options);
  assert.equal(summary.results[0].status, 'generated');
  assert.deepEqual(summary.results[0].outputs, [{ nodeId: 'node-A' }]);
  assert.equal(mock.finalized.length, 0);
});

test('invalid generated checkpoint is summarized as unknown instead of escaping the batch error boundary', async () => {
  const entry = job('A'), mock = harness([entry]), { finalize, ...options } = mock.options;
  mock.receipts.set('A', { state: 'generated', taskId: 'task-A', outputs: [{ nodeId: 'https://example.invalid/not-an-id' }] });
  const summary = await runLibTVGenerationBatch([entry], options);
  assert.equal(summary.results[0].status, 'unknown');
  assert.equal(mock.receipts.get('A').taskId, 'task-A');
  assert.deepEqual(mock.calls, []);
});

test('a stalled submission hands off completed peers, releases ownership and ignores its late response', { timeout: 2000 }, async () => {
  const jobs = ['A', 'B'].map(job), mock = harness(jobs), late = deferred(), call = mock.options.call;
  mock.options.call = async (tool, args) => {
    if (tool === 'generation_submit' && args.idempotency_key === 'original-A') {
      mock.calls.push([tool, clone(args)]);
      return late.promise;
    }
    return call(tool, args);
  };
  const summary = await runLibTVGenerationBatch(jobs, { ...mock.options, callTimeoutMs: 20 });
  assert.deepEqual(summary.results.map(value => value.status), ['unknown', 'succeeded']);
  assert.equal(summary.results[0].errorCode, 'CALL_TIMEOUT');
  assert.equal(mock.receipts.get('A').state, 'unknown');
  assert.equal(mock.receipts.get('A').taskId, undefined);
  assert.ok(summary.report.dispatchStopped);
  assert.equal(mock.summaries.length, 1);
  assert.deepEqual(mock.locks(), { acquired: 1, released: 1 });
  const before = clone([...mock.receipts]), writesBefore = mock.writes.length;
  late.resolve({ structuredContent: { task_id: 'late-task-A' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...mock.receipts], before);
  assert.equal(mock.writes.length, writesBefore);
  assert.equal(mock.calls.filter(([tool]) => tool === 'generation_submit').length, 2);
});

test('a stalled original task query preserves its identity and stops subsequent new submissions', { timeout: 2000 }, async () => {
  const jobs = ['A', 'NEW'].map(job), mock = harness(jobs), late = deferred();
  mock.options.call = async (tool, args) => {
    mock.calls.push([tool, clone(args)]);
    if (tool === 'generation_submit') return { structuredContent: { task_id: 'task-A' } };
    return late.promise;
  };
  const summary = await runLibTVGenerationBatch(jobs, { ...mock.options, concurrency: 1, callTimeoutMs: 20 });
  assert.deepEqual(summary.results.map(value => value.status), ['unknown', 'paused']);
  assert.equal(summary.results[0].taskId, 'task-A');
  assert.equal(mock.receipts.get('A').taskId, 'task-A');
  assert.equal(mock.receipts.get('A').errorCode, 'CALL_TIMEOUT');
  assert.deepEqual(mock.calls.map(([tool]) => tool), ['generation_submit', 'task_status']);
  assert.deepEqual(mock.locks(), { acquired: 1, released: 1 });
  const before = clone([...mock.receipts]);
  late.resolve({ testTask: { projectId: 'project-test', taskId: 'task-A', state: 'succeeded', outputs: [{ nodeId: 'node-A' }] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...mock.receipts], before);
  assert.deepEqual(mock.finalized, []);
});

test('host-source applies call deadlines and invalid deadlines reject before taking ownership', { timeout: 2000 }, async () => {
  const entry = job('A'), mock = harness([entry]);
  for (const callTimeoutMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
    await assert.rejects(runLibTVGenerationBatch([entry], { ...mock.options, callTimeoutMs }), /调度参数/);
  }
  assert.deepEqual(mock.locks(), { acquired: 0, released: 0 });
  const run = new Function(`${libtvGenerationHostSource()}; return runLibTVGenerationBatch;`)();
  const summary = await run([entry], { ...mock.options, callTimeoutMs: 20, call: () => new Promise(() => {}) });
  assert.equal(summary.results[0].errorCode, 'CALL_TIMEOUT');
  assert.deepEqual(mock.locks(), { acquired: 1, released: 1 });
});

test('observed tool capability is checked before ownership and remote-only jobs need no local file capabilities', async () => {
  const entry = job('A'), mock = harness([entry]);
  const runtime = capabilities => ({ capabilities, capabilityObservations: Object.fromEntries(Object.entries(capabilities).map(([name, status]) => [name, { status, evidence: 'local mock capability observation', observedAt: '2026-10-27T00:00:00.000Z' }])) });
  for (const run of [runLibTVGenerationBatch, new Function(`${libtvGenerationHostSource()}; return runLibTVGenerationBatch;`)()]) {
    await assert.rejects(run([entry], { ...mock.options, run: runtime({ toolUse: 'unsupported' }) }), error => error.issue?.code === 'RUNTIME_CAPABILITY_UNSUPPORTED');
  }
  assert.deepEqual(mock.locks(), { acquired: 0, released: 0 });
  assert.deepEqual(mock.calls, []);
  const { finalize, ...options } = mock.options;
  const summary = await runLibTVGenerationBatch([entry], { ...options, run: runtime({ toolUse: 'supported', fileRead: 'unsupported', fileWrite: 'unsupported' }) });
  assert.equal(summary.results[0].status, 'generated');
});

test('pure host callbacks have bounded waits and cannot restore delivery after losing control', { timeout: 3000 }, async t => {
  for (const boundary of ['readControl', 'snapshot', 'prepare', 'normalizeTask', 'wait']) await t.test(boundary, async () => {
    const entry = job('A'), mock = harness([entry]), late = deferred();
    if (boundary === 'wait') {
      const call = mock.options.call;
      mock.options.call = async (tool, args) => { const response = await call(tool, args); if (tool === 'task_status') { response.testTask.state = 'pending'; response.testTask.outputs = []; } return response; };
    }
    mock.options[boundary] = () => late.promise;
    const result = await runLibTVGenerationBatch([entry], { ...mock.options, localTimeoutMs: 20 });
    assert.equal(result.deliveryAllowed ?? result.report?.deliveryAllowed, false);
    assert.deepEqual(mock.locks(), { acquired: 1, released: 1 });
    if (['readControl', 'snapshot'].includes(boundary)) {
      assert.equal(result.incomplete, true);
      assert.equal(result.lockRetained, false);
      assert.equal(mock.summaries.length, 0);
    }
    const before = clone([...mock.receipts]), writesBefore = mock.writes.length;
    late.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...mock.receipts], before);
    assert.equal(mock.writes.length, writesBefore);
  });
});

test('a stalled prepare retains an existing task identity in the bounded handoff', { timeout: 2000 }, async () => {
  const entry = job('A'), mock = harness([entry]);
  mock.receipts.set('A', { state: 'pending', taskId: 'task-original' });
  mock.options.prepare = () => new Promise(() => {});
  const result = await runLibTVGenerationBatch([entry], { ...mock.options, localTimeoutMs: 20 });
  assert.equal(result.results[0].status, 'unknown');
  assert.equal(result.results[0].taskId, 'task-original');
  assert.deepEqual(mock.calls, []);
  assert.deepEqual(mock.locks(), { acquired: 1, released: 1 });
});

test('mutating callback deadlines hand off without claiming a persisted summary and retain ownership until settlement', { timeout: 3000 }, async t => {
  for (const boundary of ['acknowledgeControl', 'writeReceipt', 'finalize', 'summarize', 'release']) await t.test(boundary, async () => {
    const entry = job('A'), mock = harness([entry]), late = deferred(), released = deferred();
    const callback = mock.options[boundary], release = mock.options.release;
    mock.options.release = async (...args) => { await release(...args); released.resolve(); };
    const wrapped = boundary === 'release' ? mock.options.release : callback;
    mock.options[boundary] = async (...args) => { await late.promise; return wrapped(...args); };
    const result = await runLibTVGenerationBatch([entry], { ...mock.options, localTimeoutMs: 20 });
    assert.equal(result.incomplete, true);
    assert.equal(result.persistedSummary, false);
    assert.equal(result.deliveryAllowed, false);
    assert.equal(result.lockRetained, boundary === 'release' ? null : true);
    assert.equal(result.ownershipUnknown, boundary === 'release');
    assert.equal(result.errorCode, 'CALL_TIMEOUT');
    assert.equal(mock.locks().released, 0);
    if (boundary !== 'release') assert.equal(mock.summaries.length, 0);
    late.resolve();
    await released.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(mock.locks().released, 1, 'a late release must never be called a second time');
  });
});

test('host-source bounds a never-returning finalizer and validates the local callback deadline', { timeout: 2000 }, async () => {
  const run = new Function(`${libtvGenerationHostSource()}; return runLibTVGenerationBatch;`)();
  const entry = job('A'), mock = harness([entry]);
  for (const localTimeoutMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) await assert.rejects(run([entry], { ...mock.options, localTimeoutMs }), /调度参数/);
  const result = await run([entry], { ...mock.options, localTimeoutMs: 20, finalize: () => new Promise(() => {}) });
  assert.equal(result.incomplete, true);
  assert.equal(result.results[0].status, 'generated');
  assert.equal(result.results[0].taskId, 'task-A');
  assert.deepEqual(mock.locks(), { acquired: 1, released: 0 });
  assert.equal(mock.summaries.length, 0);
});

test('recovery snapshots reject non-plain objects and mismatched IDs before any submission', async () => {
  const invalid = [new Map(), new Date(), Object.create({ inherited: true }), { A: new Map() }, { A: Object.assign(Object.create({ inherited: true }), { state: 'pending' }) }, { A: { id: 'other', state: 'pending' } }];
  for (const initial of invalid) {
    const entry = job('A'), mock = harness([entry]);
    await assert.rejects(runLibTVGenerationBatch([entry], { ...mock.options, snapshot: () => initial }), /恢复快照无效/);
    assert.deepEqual(mock.calls, []);
    assert.deepEqual(mock.locks(), { acquired: 1, released: 1 });
  }
  const entry = job('A'), mock = harness([entry]);
  mock.receipts.set('A', { state: 'pending', taskId: 'task-A' });
  const initial = Object.assign(Object.create(null), { A: Object.assign(Object.create(null), { state: 'pending', taskId: 'task-A' }) });
  const result = await runLibTVGenerationBatch([entry], { ...mock.options, snapshot: () => initial });
  assert.equal(result.results[0].status, 'succeeded');
  assert.ok(mock.calls.every(([tool]) => tool === 'task_status'));
});

test('a constructor-named existing task reserves the recovery pass even with an empty plain snapshot', async () => {
  const recovery = { id: 'constructor', count: 1, projectId: 'project-test', existingTaskId: 'task-constructor' };
  const jobs = [job('NEW'), recovery], mock = harness(jobs);
  const result = await runLibTVGenerationBatch(jobs, mock.options);
  assert.deepEqual(result.results.map(item => item.status), ['paused', 'succeeded']);
  assert.equal(result.report.recoveryPass, true);
  assert.deepEqual(mock.calls.map(([tool, args]) => [tool, args.task_id]), [['task_status', 'task-constructor']]);
});

test('every store bridge receives its immutable captured owner context through finalization and release', async () => {
  const entry = job('A'), mock = harness([entry]), owners = [], seen = new Set();
  const contextIndex = { acquire: 0, readControl: 0, snapshot: 0, prepare: 1, acknowledgeControl: 1, writeReceipt: 2, finalize: 2, summarize: 2, release: 0 };
  for (const [name, index] of Object.entries(contextIndex)) {
    const callback = mock.options[name];
    mock.options[name] = async (...args) => {
      const context = name === 'writeReceipt' ? args[index].context : args[index];
      assert.equal(Object.isFrozen(context), true);
      assert.ok(context.deadlineAt > Date.now());
      assert.equal(typeof context.owner, 'string');
      owners.push(context.owner); seen.add(name);
      const value = await callback(...args);
      return name === 'acquire' ? { owner: context.owner } : value;
    };
  }
  const result = await runLibTVGenerationBatch([entry], mock.options);
  assert.equal(result.results[0].status, 'succeeded');
  assert.equal(new Set(owners).size, 1);
  assert.deepEqual(seen, new Set(Object.keys(contextIndex)));
});
