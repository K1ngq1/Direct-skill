import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadRules, loadRuleSnapshot, loadRuntimeRules, assertRuntimeCapabilities, doctor } from '../scripts/runtime.mjs';

const cli = fileURLToPath(new URL('../scripts/runtime.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '分镜 rules '));
  const references = path.join(root, 'references'); fs.mkdirSync(references);
  const adapters = path.join(root, 'adapters'); fs.mkdirSync(adapters);
  const manifest = { schemaVersion: 1, rulesVersion: 'fixture-v1', core: ['core.md'], stages: { ingest: [], plan: ['plan.md'], prompt: [], review: [], export: [], legacy: ['legacy.md'] }, scripts: ['script.mjs'] };
  const adapterManifest = { schemaVersion: 1, hosts: { default: 'adapters/default.md', codex: 'adapters/codex.md', 'claude-code': 'adapters/claude-code.md', workbuddy: 'adapters/workbuddy.md' }, models: { default: null, glm: 'adapters/glm.md' } };
  fs.writeFileSync(path.join(root, 'core.md'), '核心规则\n', 'utf8');
  fs.writeFileSync(path.join(root, 'plan.md'), '计划规则\n', 'utf8');
  fs.writeFileSync(path.join(root, 'legacy.md'), '旧流程规则\n', 'utf8');
  fs.writeFileSync(path.join(root, 'script.mjs'), '', 'utf8');
  fs.writeFileSync(path.join(references, 'rules-manifest.json'), JSON.stringify(manifest), 'utf8');
  fs.writeFileSync(path.join(adapters, 'manifest.json'), JSON.stringify(adapterManifest), 'utf8');
  fs.writeFileSync(path.join(adapters, 'default.md'), '未知宿主，手动读取共用规则。', 'utf8');
  fs.writeFileSync(path.join(adapters, 'codex.md'), 'Codex 入口约定，能力未验证。', 'utf8');
  fs.writeFileSync(path.join(adapters, 'claude-code.md'), 'Claude Code 入口约定，能力未验证。', 'utf8');
  fs.writeFileSync(path.join(adapters, 'workbuddy.md'), 'WorkBuddy 入口约定，能力未验证。', 'utf8');
  fs.writeFileSync(path.join(adapters, 'glm.md'), 'GLM 是模型；宿主由 adapter 单独指定。', 'utf8');
  t.after(() => {
    fs.unlinkSync(path.join(adapters, 'default.md'));
    fs.unlinkSync(path.join(adapters, 'codex.md'));
    fs.unlinkSync(path.join(adapters, 'claude-code.md'));
    fs.unlinkSync(path.join(adapters, 'workbuddy.md'));
    fs.unlinkSync(path.join(adapters, 'glm.md'));
    fs.unlinkSync(path.join(adapters, 'manifest.json'));
    fs.rmdirSync(adapters);
    fs.unlinkSync(path.join(root, 'core.md'));
    if (fs.existsSync(path.join(root, 'plan.md'))) fs.unlinkSync(path.join(root, 'plan.md'));
    fs.unlinkSync(path.join(root, 'legacy.md'));
    fs.unlinkSync(path.join(root, 'script.mjs'));
    fs.unlinkSync(path.join(references, 'rules-manifest.json'));
    fs.rmdirSync(references);
    fs.rmdirSync(root);
  });
  return { root, manifest, adapterManifest,
    save: () => fs.writeFileSync(path.join(references, 'rules-manifest.json'), JSON.stringify(manifest), 'utf8'),
    saveAdapters: () => fs.writeFileSync(path.join(adapters, 'manifest.json'), JSON.stringify(adapterManifest), 'utf8') };
}

test('rule fingerprints are deterministic, stage-specific and exclude legacy from the new workflow', t => {
  const { root } = fixture(t);
  const first = loadRuleSnapshot({ skillRoot: root });
  assert.deepEqual(loadRuleSnapshot({ skillRoot: root }), first);
  assert.deepEqual(first.files.map(file => file.path), ['core.md', 'plan.md', 'references/rules-manifest.json']);
  assert.ok(first.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  const ingest = loadRules({ skillRoot: root, stage: 'ingest' });
  assert.equal(ingest.files.find(file => file.path === 'core.md').text, '核心规则\n');
  assert.ok(!ingest.files.some(file => file.path === 'plan.md'));
  assert.notEqual(ingest.snapshot.rulesHash, first.rulesHash);
  fs.writeFileSync(path.join(root, 'legacy.md'), '修改旧规则', 'utf8');
  assert.deepEqual(loadRuleSnapshot({ skillRoot: root }), first);
  assert.equal(loadRules({ skillRoot: root, stage: 'legacy' }).files.find(file => file.path === 'legacy.md').text, '修改旧规则');
  fs.appendFileSync(path.join(root, 'plan.md'), '新事实', 'utf8');
  assert.notEqual(loadRuleSnapshot({ skillRoot: root }).rulesHash, first.rulesHash);
});

test('missing, unsupported, malformed and escaping rule sources produce distinct actionable failures', t => {
  const { root, manifest, save } = fixture(t);
  assert.throws(() => loadRules({ skillRoot: root, stage: 'invented' }), error => error.issue.category === 'unsupported');
  fs.unlinkSync(path.join(root, 'plan.md'));
  assert.throws(() => loadRuleSnapshot({ skillRoot: root }), error => error.issue.category === 'runtime' && error.issue.path === 'plan.md');
  manifest.stages.plan = ['../outside.md']; save();
  assert.throws(() => loadRules({ skillRoot: root }), error => error.issue.category === 'structure');
  fs.writeFileSync(path.join(root, 'references/rules-manifest.json'), '{', 'utf8');
  assert.throws(() => loadRules({ skillRoot: root }), error => error.issue.category === 'parse');
  save();
});

test('real rules include the v2 contract and CLI records cannot overwrite existing files', t => {
  const rules = loadRules();
  assert.equal(rules.snapshot.rulesVersion, 'storyboard-rules-v1');
  assert.ok(rules.files.some(file => file.path === 'schemas/visual-plan-v2.json'));
  assert.ok(!rules.files.some(file => file.path.includes('legacy-workbench') || file.path.includes('production-framework')));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '分镜 CLI '));
  const output = path.join(directory, '规则 记录.json');
  t.after(() => { if (fs.existsSync(output)) fs.unlinkSync(output); fs.rmdirSync(directory); });
  const invoke = () => spawnSync(process.execPath, [cli, 'rules', 'prompt', '--output', output], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const result = invoke(); assert.equal(result.status, 0, result.stderr);
  const before = fs.readFileSync(output), record = JSON.parse(before);
  assert.deepEqual(record.canonicalSnapshot, rules.snapshot);
  assert.ok(record.files.some(file => file.path === 'references/humanizer-zh/SKILL.md' && file.text));
  assert.equal(invoke().status, 1);
  assert.deepEqual(fs.readFileSync(output), before);
});

test('doctor distinguishes runtime readiness from content validation and reports missing projects', () => {
  const result = doctor();
  assert.equal(result.hardValidation, '未执行硬校验');
  assert.equal(result.status, result.checks.every(check => check.status === 'passed') ? 'ready' : 'blocked');
  assert.ok(result.checks.some(check => check.name === 'rules' && check.status === 'passed'));
  assert.ok(result.checks.some(check => check.name === 'exceljs' && check.status === 'passed'));
  const missing = doctor({ project: path.join(os.tmpdir(), `missing-storyboard-${process.pid}-${Date.now()}`) });
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.checks.find(check => check.name === 'project').issue.category, 'runtime');
});

test('doctor reads optional project data without mutation and never treats a parsed null plan as absent', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '分镜 doctor '));
  const source = path.join(directory, 'script.txt'), project = path.join(directory, 'project.json'), plan = path.join(directory, 'visual-plan.json');
  fs.writeFileSync(source, '原稿', 'utf8');
  const original = JSON.stringify({ shots: [], source: { path: 'script.txt', sha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex') } });
  fs.writeFileSync(project, original, 'utf8');
  t.after(() => { fs.unlinkSync(source); fs.unlinkSync(project); fs.unlinkSync(plan); fs.rmdirSync(directory); });
  const first = doctor({ project: directory }).checks.find(check => check.name === 'project');
  assert.equal(first.status, 'passed');
  assert.equal(first.detail.visualPlan, '尚未创建');
  fs.writeFileSync(plan, 'null', 'utf8');
  assert.equal(doctor({ project: directory }).checks.find(check => check.name === 'project').issue.category, 'structure');
  fs.writeFileSync(plan, '{', 'utf8');
  assert.equal(doctor({ project: directory }).checks.find(check => check.name === 'project').issue.category, 'parse');
  assert.equal(fs.readFileSync(project, 'utf8'), original);
  assert.equal(fs.readFileSync(source, 'utf8'), '原稿');
});

test('doctor checks declared core scripts and errors use the shared issue contract', t => {
  const { root, manifest, save } = fixture(t);
  const realManifest = JSON.parse(loadRules().files.find(file => file.path === 'references/rules-manifest.json').text);
  assert.ok(realManifest.scripts.includes('scripts/visual_v2.mjs'));
  assert.ok(realManifest.scripts.includes('scripts/visual_state.mjs'));
  manifest.scripts.push('scripts/visual_v2.mjs'); save();
  const issue = doctor({ skillRoot: root }).checks.find(check => check.name === 'scripts').issue;
  assert.deepEqual(Object.keys(issue), ['category', 'code', 'path', 'entityId', 'severity', 'message', 'requirement']);
  assert.equal(issue.category, 'runtime');
  assert.equal(issue.code, 'REQUIRED_FILE_MISSING');
  assert.equal(issue.path, 'scripts/visual_v2.mjs');
  assert.equal(issue.entityId, null);
  assert.equal(issue.severity, 'error');
});

test('an explicit Python executable is honored without silently probing a different interpreter', () => {
  const configured = path.join(os.tmpdir(), `missing-python-${process.pid}-${Date.now()}.exe`);
  const result = spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8', env: { ...process.env, STORYBOARD_PYTHON: configured }, windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 1);
  const issue = JSON.parse(result.stdout).checks.find(check => check.name === 'python').issue;
  assert.equal(issue.code, 'PYTHON_UNAVAILABLE');
  assert.ok(issue.message.startsWith(configured + ':'));
  assert.equal(issue.message.includes('\npython'), false);
});

test('explicit host and model selections share identical core rules and do not claim runtime capabilities', t => {
  const { root } = fixture(t), core = loadRules({ skillRoot: root, stage: 'plan' });
  for (const adapter of ['default', 'codex', 'claude-code', 'workbuddy']) {
    const loaded = loadRuntimeRules({ skillRoot: root, stage: 'plan', adapter, model: 'glm' });
    assert.deepEqual(loaded.snapshot, core.snapshot);
    assert.deepEqual(loaded.files, core.files);
    assert.deepEqual(loaded.adaptation.selected, { adapter, model: 'glm' });
    assert.deepEqual(loaded.adaptation.files.map(file => file.path), adapter === 'default'
      ? ['adapters/default.md', 'adapters/glm.md'] : ['adapters/default.md', `adapters/${adapter}.md`, 'adapters/glm.md']);
    assert.ok(loaded.adaptation.files.every(file => file.text && /^[a-f0-9]{64}$/.test(file.sha256)));
    assert.equal(loaded.run.platform, adapter === 'default' ? 'unknown' : adapter);
    assert.equal(loaded.run.model, 'glm');
    assert.ok(Object.values(loaded.run.capabilities).every(value => value === 'unknown'));
    assert.deepEqual(loaded.adaptation.warnings, []);
  }
  const defaults = loadRuntimeRules({ skillRoot: root, stage: 'plan' });
  assert.deepEqual(defaults.adaptation.selected, { adapter: 'default', model: 'default' });
  assert.equal(defaults.run.model, null);
  assert.equal(defaults.adaptation.files.length, 1);
  fs.appendFileSync(path.join(root, 'adapters/codex.md'), '\n更新宿主差异。', 'utf8');
  assert.deepEqual(loadRuntimeRules({ skillRoot: root, stage: 'plan', adapter: 'codex' }).snapshot, core.snapshot);
});

test('registered provider skills load with every host without changing shared contracts or claiming capabilities', () => {
  const registry = JSON.parse(fs.readFileSync(new URL('../adapters/manifest.json', import.meta.url), 'utf8'));
  const core = loadRules({ stage: 'plan' });
  for (const adapter of Object.keys(registry.hosts)) for (const [model, filename] of Object.entries(registry.models)) {
    if (!filename) continue;
    const loaded = loadRuntimeRules({ stage: 'plan', adapter, model });
    assert.deepEqual(loaded.adaptation.selected, { adapter, model });
    assert.deepEqual(loaded.snapshot, core.snapshot);
    assert.deepEqual(loaded.files, core.files);
    assert.equal(loaded.adaptation.files.at(-1).path, filename);
    assert.deepEqual(loaded.adaptation.warnings, []);
    assert.equal(loaded.run.model, model);
    assert.ok(Object.values(loaded.run.capabilities).every(value => value === 'unknown'));
  }
});

test('unknown hosts and models fall back independently and GLM is never guessed to be a host', t => {
  const { root } = fixture(t);
  const mistakenHost = loadRuntimeRules({ skillRoot: root, adapter: 'glm' });
  assert.deepEqual(mistakenHost.adaptation.selected, { adapter: 'default', model: 'default' });
  assert.equal(mistakenHost.adaptation.requested.adapter, 'glm');
  assert.equal(mistakenHost.adaptation.warnings[0].code, 'ADAPTER_FALLBACK');
  assert.equal(mistakenHost.adaptation.warnings[0].severity, 'warning');
  assert.deepEqual(mistakenHost.adaptation.files.map(file => file.path), ['adapters/default.md']);
  const unknownModel = loadRuntimeRules({ skillRoot: root, adapter: 'claude-code', model: 'future-model' });
  assert.equal(unknownModel.run.platform, 'claude-code'); assert.equal(unknownModel.run.model, null);
  assert.equal(unknownModel.adaptation.warnings[0].code, 'MODEL_FALLBACK');
  const both = loadRuntimeRules({ skillRoot: root, adapter: 'future-host', model: 'future-model' });
  assert.equal(both.adaptation.warnings.length, 2);
  assert.deepEqual(both.snapshot, loadRuleSnapshot({ skillRoot: root }));
});

test('broken or escaping registered adapters fail explicitly instead of being hidden by fallback', t => {
  const { root, adapterManifest, saveAdapters } = fixture(t);
  adapterManifest.hosts.codex = 'adapters/missing.md'; saveAdapters();
  assert.throws(() => loadRuntimeRules({ skillRoot: root, adapter: 'codex' }), error => error.issue.code === 'REQUIRED_FILE_MISSING');
  adapterManifest.hosts.codex = 'adapters/../../outside.md'; saveAdapters();
  assert.throws(() => loadRuntimeRules({ skillRoot: root, adapter: 'codex' }), error => error.issue.code === 'LOCAL_PATH_INVALID');
  delete adapterManifest.hosts.default; saveAdapters();
  assert.throws(() => loadRuntimeRules({ skillRoot: root }), error => error.issue.code === 'ADAPTER_MANIFEST_INVALID');
});

test('real adapter CLI accepts either option order, records fallback and rejects malformed options', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '分镜 adapter CLI ')), output = path.join(directory, '显式选择 记录.json');
  t.after(() => { if (fs.existsSync(output)) fs.unlinkSync(output); fs.rmdirSync(directory); });
  const invoke = (...args) => spawnSync(process.execPath, [cli, 'rules', 'plan', ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const result = invoke('--model', 'glm', '--output', output, '--adapter', 'claude-code');
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(fs.readFileSync(output, 'utf8')), summary = JSON.parse(result.stdout);
  assert.equal(record.run.platform, 'claude-code'); assert.equal(record.run.model, 'glm');
  assert.ok(record.adaptation.files.every(file => typeof file.text === 'string'));
  assert.ok(summary.adaptation.files.every(file => !Object.hasOwn(file, 'text')));
  assert.deepEqual(record.canonicalSnapshot, loadRuleSnapshot());
  const fallback = invoke('--adapter', 'glm'); assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(JSON.parse(fallback.stdout).adaptation.warnings[0].code, 'ADAPTER_FALLBACK');
  for (const args of [['--adapter'], ['--model', '--adapter', 'codex'], ['--adapter', 'codex', '--adapter', 'workbuddy'], ['--unknown', 'value']]) {
    const invalid = invoke(...args); assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stderr).issues[0].code, 'RULE_ARGUMENT_INVALID');
  }
});

test('observed capabilities drive a standalone guard without inferring capabilities from a model', t => {
  const { root } = fixture(t), observations = {
    toolUse: { status: 'unsupported', evidence: '本次工具请求返回不支持。', observedAt: '2026-10-27T00:00:00Z' },
    fileRead: { status: 'supported', evidence: '本次读回原稿内容。', observedAt: '2026-10-27T00:00:00Z' }
  };
  const loaded = loadRuntimeRules({ skillRoot: root, model: 'glm', observations });
  assert.equal(loaded.run.capabilities.toolUse, 'unsupported');
  assert.equal(loaded.run.capabilities.imageUnderstanding, 'unknown');
  assert.deepEqual(loaded.run.capabilityObservations, observations);
  const standalone = Function(`return (${assertRuntimeCapabilities.toString()})`)();
  standalone(); standalone(loaded.run, ['fileRead']);
  assert.throws(() => standalone(loaded.run, ['toolUse']), error => error.issue.code === 'RUNTIME_CAPABILITY_UNSUPPORTED');
  for (const invalid of [null, { toolUse: true }, { toolUse: { status: 'supported' } }, { invented: observations.fileRead }, { fileRead: { ...observations.fileRead, observedAt: 'yesterday' } }]) {
    assert.throws(() => loadRuntimeRules({ skillRoot: root, observations: invalid }), error => error.issue.code === 'CAPABILITY_OBSERVATION_INVALID');
  }
  standalone({ capabilities: { toolUse: 'supported' } });
  assert.throws(() => standalone({ capabilities: { toolUse: 'unsupported' } }, ['toolUse']), error => error.issue.code === 'RUNTIME_CAPABILITY_UNSUPPORTED');
  assert.throws(() => standalone({ capabilities: { toolUse: 'BANANA' } }), error => error.issue.code === 'CAPABILITY_OBSERVATION_INVALID');
  assert.throws(() => standalone({ capabilities: { toolUse: 'supported' }, capabilityObservations: {} }), error => error.issue.code === 'CAPABILITY_OBSERVATION_INVALID');
});

test('capability guards reject unpersistable records before interpreting observed support', t => {
  const { root } = fixture(t), row = { status: 'supported', evidence: '本次工具读取成功。', observedAt: '2026-10-27T00:00:00Z' };
  const invalid = [
    null, [], new Date(), new Map(), Object.create({ capabilities: { toolUse: 'supported' } }),
    { capabilities: undefined }, { capabilityObservations: undefined },
    { capabilities: new Map([['toolUse', 'unsupported']]) },
    { capabilities: Object.create({ toolUse: 'unsupported' }) },
    Object.defineProperty({}, 'capabilities', { value: { toolUse: 'unsupported' } }),
    { capabilities: { get toolUse() { throw new Error('能力访问器不应执行'); } } },
    { capabilities: { toolUse: 'supported' }, capabilityObservations: Object.create({ toolUse: row }) },
    { capabilities: { toolUse: 'supported' }, capabilityObservations: { toolUse: Object.create(row) } },
    { capabilities: { toolUse: 'supported' }, capabilityObservations: { toolUse: Object.defineProperty({ ...row }, 'evidence', { value: row.evidence, enumerable: false }) } },
    { capabilities: { [Symbol('toolUse')]: 'unsupported' } },
    { capabilities: { toolUse: 'unknown' }, capabilityObservations: { toolUse: undefined } }
  ];
  for (const guard of [assertRuntimeCapabilities, Function(`return (${assertRuntimeCapabilities.toString()})`)()]) {
    for (const run of invalid) assert.throws(() => guard(run, ['toolUse']), error => error.issue.code === 'CAPABILITY_OBSERVATION_INVALID');
    assert.throws(() => guard(undefined, new Array(1)), /能力检查名称无效/);
    guard(undefined, ['toolUse']);
    guard({ capabilities: Object.assign(Object.create(null), { toolUse: 'supported' }), capabilityObservations: Object.assign(Object.create(null), { toolUse: row }) }, ['toolUse']);
  }
  for (const observations of [new Date(), new Map(), Object.create({ toolUse: row }), { toolUse: Object.create(row) }]) {
    assert.throws(() => loadRuntimeRules({ skillRoot: root, observations }), error => error.issue.code === 'CAPABILITY_OBSERVATION_INVALID');
  }
});

test('explicit rule chunks preserve every source character, fingerprints and surrogate pairs', t => {
  const { root } = fixture(t);
  fs.appendFileSync(path.join(root, 'core.md'), '😀中文规则，不能截断或遗漏。\n', 'utf8');
  const complete = loadRuntimeRules({ skillRoot: root, stage: 'plan', adapter: 'codex', model: 'glm' });
  const first = loadRuntimeRules({ skillRoot: root, stage: 'plan', adapter: 'codex', model: 'glm', ruleChunkChars: 7 });
  assert.equal(first.ruleDelivery.index, 1);
  assert.ok(first.files.every(file => !Object.hasOwn(file, 'text')));
  assert.ok(first.adaptation.files.every(file => !Object.hasOwn(file, 'text')));
  assert.deepEqual(first.snapshot, complete.snapshot);
  const reconstructed = new Map();
  for (let chunk = 1; chunk <= first.ruleDelivery.count; chunk++) {
    const part = loadRuntimeRules({ skillRoot: root, stage: 'plan', adapter: 'codex', model: 'glm', ruleChunkChars: 7, chunk });
    assert.ok(part.ruleDelivery.parts.reduce((count, row) => count + row.text.length, 0) <= 7);
    for (const row of part.ruleDelivery.parts) {
      assert.equal(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(row.text), false);
      const key = row.scope + ':' + row.path;
      assert.equal(row.start, (reconstructed.get(key) ?? '').length);
      reconstructed.set(key, (reconstructed.get(key) ?? '') + row.text);
    }
  }
  for (const [scope, files] of [['rules', complete.files], ['adaptation', complete.adaptation.files]]) for (const file of files) assert.equal(reconstructed.get(scope + ':' + file.path), file.text);
  for (const args of [{ ruleChunkChars: 1 }, { ruleChunkChars: 4, chunk: 0 }, { ruleChunkChars: 4, chunk: null }, { chunk: 1 }, { ruleChunkChars: 7, chunk: first.ruleDelivery.count + 1 }]) {
    assert.throws(() => loadRuntimeRules({ skillRoot: root, ...args }), error => error.issue.code === 'RULE_CHUNK_INVALID');
  }
});

test('CLI uses an explicit observation file and returns only the selected bounded rule body', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '分镜 capability CLI '));
  const observations = path.join(directory, '观察.json'), output = path.join(directory, '规则块.json');
  fs.writeFileSync(observations, JSON.stringify({ toolUse: { status: 'unsupported', evidence: '本次明确不支持工具。', observedAt: '2026-10-27T00:00:00Z' } }), 'utf8');
  t.after(() => { fs.unlinkSync(observations); if (fs.existsSync(output)) fs.unlinkSync(output); fs.rmdirSync(directory); });
  const invoke = (...args) => spawnSync(process.execPath, [cli, 'rules', 'plan', ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const result = invoke('--observations', observations, '--rule-chunk-chars', '1024', '--chunk', '2', '--output', output);
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(fs.readFileSync(output, 'utf8')), summary = JSON.parse(result.stdout);
  assert.equal(saved.run.capabilities.toolUse, 'unsupported');
  assert.equal(saved.ruleDelivery.index, 2);
  assert.ok(saved.ruleDelivery.parts.reduce((count, row) => count + row.text.length, 0) <= 1024);
  assert.ok(summary.ruleDelivery.parts.every(row => !Object.hasOwn(row, 'text')));
  for (const args of [['--chunk', '1'], ['--rule-chunk-chars', '1'], ['--rule-chunk-chars', '1e3'], ['--rule-chunk-chars', '1024', '--chunk', '999999']]) {
    const invalid = invoke(...args); assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stderr).issues[0].code, 'RULE_CHUNK_INVALID');
  }
});
