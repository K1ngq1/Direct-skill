import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = 'references/rules-manifest.json';
const stages = ['ingest', 'plan', 'prompt', 'review', 'export', 'legacy'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function failure(category, field, message, requirement, code = 'RUNTIME_' + category.toUpperCase()) {
  return Object.assign(new Error(message), { issue: { category, code, path: field, entityId: null, severity: 'error', message, requirement } });
}
function localFile(root, relative, field = manifestPath) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw failure('structure', field, `无效的本地路径：${relative}`, '使用所属目录内的相对路径，禁止越界或绝对路径。', 'LOCAL_PATH_INVALID');
  }
  const filename = path.resolve(root, relative);
  let real;
  try { real = fs.realpathSync(filename); }
  catch { throw failure('runtime', relative, `必需文件不存在或不可读：${relative}`, '恢复对应随包文件后重试。', 'REQUIRED_FILE_MISSING'); }
  const contained = path.relative(fs.realpathSync(root), real);
  if (contained === '..' || contained.startsWith('..' + path.sep) || path.isAbsolute(contained) || !fs.statSync(real).isFile()) {
    throw failure('runtime', relative, `文件必须位于所属目录内：${relative}`, '移除越界链接并提供真实随包文件。', 'LOCAL_PATH_OUTSIDE');
  }
  return filename;
}
function parseJson(bytes, filename) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw failure('parse', filename, `JSON 解析失败：${error.message}`, '修复该文件的 JSON 语法，保留原始内容。', 'JSON_PARSE'); }
}
function readManifest(skillRoot) {
  const bytes = fs.readFileSync(localFile(skillRoot, manifestPath));
  const manifest = parseJson(bytes, manifestPath);
  const paths = value => Array.isArray(value) && value.every(item => typeof item === 'string');
  if (manifest?.schemaVersion !== 1 || typeof manifest.rulesVersion !== 'string' || !manifest.rulesVersion.trim() ||
      !paths(manifest.core) || !manifest.core.length || !paths(manifest.scripts) || !manifest.scripts.length ||
      !manifest.stages || Object.keys(manifest.stages).length !== stages.length || stages.some(stage => !paths(manifest.stages[stage]))) {
    throw failure('structure', manifestPath, '规则清单的版本、core、stages 或 scripts 无效。', '恢复有效的随包规则清单；阶段必须为 ingest/plan/prompt/review/export/legacy。', 'RULE_MANIFEST_INVALID');
  }
  return { manifest, bytes };
}

export function loadRules({ skillRoot = defaultRoot, stage = 'all' } = {}) {
  if (stage !== 'all' && !stages.includes(stage)) throw failure('unsupported', 'stage', `不支持的规则阶段：${stage}`, `选择 all 或 ${stages.join('/')}。`, 'RULE_STAGE_UNSUPPORTED');
  const { manifest, bytes } = readManifest(skillRoot);
  const names = [...new Set([manifestPath, ...manifest.core, ...(stage === 'all' ? stages.filter(name => name !== 'legacy').flatMap(name => manifest.stages[name]) : manifest.stages[stage])])].sort();
  const files = names.map(relative => {
    const content = relative === manifestPath ? bytes : fs.readFileSync(localFile(skillRoot, relative));
    if (relative.endsWith('.json')) parseJson(content, relative);
    return { path: relative, sha256: sha256(content), text: content.toString('utf8') };
  });
  const fingerprints = files.map(({ path: name, sha256: digest }) => ({ path: name, sha256: digest }));
  return {
    snapshot: { rulesVersion: manifest.rulesVersion, rulesHash: sha256(JSON.stringify({ rulesVersion: manifest.rulesVersion, files: fingerprints })), files: fingerprints },
    files
  };
}

export function loadRuleSnapshot(options = {}) { return loadRules(options).snapshot; }

export function loadRuntimeRules({ skillRoot = defaultRoot, stage = 'all', adapter = 'default', model = 'default' } = {}) {
  const loaded = loadRules({ skillRoot, stage }), adapterManifestPath = 'adapters/manifest.json';
  const bytes = fs.readFileSync(localFile(skillRoot, adapterManifestPath)), manifest = parseJson(bytes, adapterManifestPath);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const entriesValid = (entries, allowDefaultNull) => object(entries) && Object.hasOwn(entries, 'default') && Object.entries(entries).every(([key, value]) =>
    /^[a-z][a-z0-9-]*$/.test(key) && (allowDefaultNull && key === 'default' ? value === null : typeof value === 'string' && value.startsWith('adapters/') && value.endsWith('.md')));
  if (manifest?.schemaVersion !== 1 || !entriesValid(manifest.hosts, false) || !entriesValid(manifest.models, true)) {
    throw failure('structure', adapterManifestPath, '适配清单须分别声明 hosts 与 models，并提供 default。', '宿主指向 adapters 内 Markdown；models.default 为 null，其他模型指向独立差异说明。', 'ADAPTER_MANIFEST_INVALID');
  }
  const warnings = [];
  const select = (requested, entries, field, code) => {
    if (typeof requested !== 'string' || !requested.trim()) throw failure('structure', field, '适配选择须为非空字符串。', '提供显式适配 ID，未指定时使用 default。', 'ADAPTER_SELECTION_INVALID');
    if (Object.hasOwn(entries, requested)) return requested;
    warnings.push({ ...failure('unsupported', field, `未登记的${field === 'adapter' ? '宿主适配器' : '模型适配器'} ${requested}；已回退 default。`, '检查显式 ID 或使用 default；不会根据模型名称、环境变量或工具列表猜测宿主。', code).issue, severity: 'warning' });
    return 'default';
  };
  const selectedAdapter = select(adapter, manifest.hosts, 'adapter', 'ADAPTER_FALLBACK');
  const selectedModel = select(model, manifest.models, 'model', 'MODEL_FALLBACK');
  const names = [...new Set([manifest.hosts.default, manifest.hosts[selectedAdapter], manifest.models[selectedModel]].filter(Boolean))];
  const files = names.map(relative => {
    const content = fs.readFileSync(localFile(skillRoot, relative, adapterManifestPath));
    return { path: relative, sha256: sha256(content), text: content.toString('utf8') };
  });
  return { ...loaded,
    adaptation: { requested: { adapter, model }, selected: { adapter: selectedAdapter, model: selectedModel },
      manifest: { path: adapterManifestPath, sha256: sha256(bytes) }, files, warnings },
    run: { platform: selectedAdapter === 'default' ? 'unknown' : selectedAdapter, model: selectedModel === 'default' ? null : selectedModel,
      capabilities: Object.fromEntries(['fileRead', 'fileWrite', 'scriptExecution', 'imageUnderstanding', 'structuredOutput', 'toolUse'].map(name => [name, 'unknown'])) }
  };
}

export function doctor({ skillRoot = defaultRoot, project } = {}) {
  const checks = [];
  const check = (name, operation) => {
    try { checks.push({ name, status: 'passed', detail: operation() }); }
    catch (error) { checks.push({ name, status: 'failed', issue: error.issue ?? failure('runtime', name, error.message, '修复运行环境后重试；不能标记硬校验已通过。').issue }); }
  };
  let snapshot;
  check('node', () => {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error(`需要 Node.js 20+，当前 ${process.versions.node}`);
    return { version: process.versions.node, executable: process.execPath };
  });
  check('rules', () => { snapshot = loadRuleSnapshot({ skillRoot }); return snapshot; });
  check('scripts', () => {
    const { manifest } = readManifest(skillRoot);
    for (const filename of manifest.scripts) localFile(skillRoot, filename);
    return manifest.scripts;
  });
  check('exceljs', () => {
    const ExcelJS = createRequire(import.meta.url)(localFile(skillRoot, 'scripts/vendor/exceljs.cjs'));
    if (typeof ExcelJS.Workbook !== 'function') throw new Error('随包 ExcelJS 缺少 Workbook。');
    return '随包 ExcelJS 可加载；未写入工作簿。';
  });
  check('python', () => {
    const code = 'import json, sys; import openpyxl; print(json.dumps({"version": list(sys.version_info[:3]), "executable": sys.executable, "openpyxl": openpyxl.__version__}))';
    const attempts = [];
    const configured = process.env.STORYBOARD_PYTHON;
    if (configured && !path.isAbsolute(configured)) throw failure('runtime', 'STORYBOARD_PYTHON', 'STORYBOARD_PYTHON 必须是解释器的绝对路径，不接受命令行参数。', '提供现有 Python 可执行文件的完整路径，或移除本次环境变量以使用标准命令探测。', 'PYTHON_PATH_INVALID');
    const candidates = configured ? [[configured, []]] : [['python', []], ['python3', []], ['py', ['-3']]];
    for (const [command, args] of candidates) {
      const label = [command, ...args].join(' ');
      const result = spawnSync(command, [...args, '-c', code], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      if (result.status === 0) {
        const value = parseJson(result.stdout, label);
        if (value.version[0] > 3 || (value.version[0] === 3 && value.version[1] >= 10)) return { command, args, ...value };
        attempts.push(`${label}: Python ${value.version.join('.')} 低于 3.10`);
      } else attempts.push(`${label}: ${result.error?.message ?? (result.stderr.trim() || '执行失败')}`);
    }
    throw failure('runtime', 'python', attempts.join('\n'), '使用具备 openpyxl 的 Python 3.10+；可通过 STORYBOARD_PYTHON 指定解释器。本命令不修改 PATH 或自动安装依赖。', 'PYTHON_UNAVAILABLE');
  });
  if (project) check('project', () => {
    const directory = path.resolve(project), filename = path.join(directory, 'project.json');
    let archived;
    try { archived = parseJson(fs.readFileSync(filename), filename); }
    catch (error) { throw error.issue ? error : failure('runtime', filename, error.message, '指定含 project.json 的现有项目目录。', 'PROJECT_READ_FAILED'); }
    if (!archived || typeof archived !== 'object' || !Array.isArray(archived.shots)) throw failure('structure', filename, '原稿归档须包含 shots 数组。', '使用现有导入器归档原稿，不将创作方案伪装为 project.json。');
    const sourceFile = localFile(directory, archived.source?.path, 'source.path');
    if (sha256(fs.readFileSync(sourceFile)) !== archived.source?.sha256) throw failure('reference', 'source.sha256', '原稿文件哈希不匹配。', '核对原件与归档，不能继续沿用过期来源。', 'SOURCE_HASH_MISMATCH');
    const visualPath = path.join(directory, 'visual-plan.json');
    const visual = fs.existsSync(visualPath) ? parseJson(fs.readFileSync(visualPath), visualPath) : null;
    if (fs.existsSync(visualPath) && (!visual || typeof visual !== 'object' || Array.isArray(visual) || !Array.isArray(visual.shots))) throw failure('structure', visualPath, '创作方案须为包含 shots 数组的 JSON 对象。', '保留原始输出并修复方案结构，然后运行内容硬校验。');
    return { directory, sourceReadable: true, visualPlan: visual ? '已解析；内容硬校验需另运行 visual.mjs validate' : '尚未创建', projectId: visual?.projectId ?? archived.projectId ?? null };
  });
  return { status: checks.every(item => item.status === 'passed') ? 'ready' : 'blocked', checks, snapshot: snapshot ?? null,
    hardValidation: '未执行硬校验', note: 'doctor 只检查依赖、文件与可选项目的可读性；规则哈希只证明提供的文件版本，不证明 Agent 已阅读或理解。' };
}

function main(args) {
  const [command, ...rest] = args;
  let result;
  if (command === 'doctor' && rest.length <= 1) {
    result = doctor({ project: rest[0] });
    if (result.status !== 'ready') process.exitCode = 1;
  } else if (command === 'rules' && rest.length >= 1) {
    const stage = rest[0], options = {};
    for (let index = 1; index < rest.length; index += 2) {
      const flag = rest[index], value = rest[index + 1], name = flag.slice(2);
      if (!['--adapter', '--model', '--output'].includes(flag) || Object.hasOwn(options, name) || !value || value.startsWith('--')) {
        throw failure('unsupported', 'arguments', `无效、重复或缺值的参数：${flag}`, '使用 --adapter <ID>、--model <ID>、--output <new-file>；每项最多一次，顺序不限。', 'RULE_ARGUMENT_INVALID');
      }
      options[name] = value;
    }
    const loaded = loadRuntimeRules({ stage, adapter: options.adapter, model: options.model });
    result = { status: 'provided', stage, providedAt: new Date().toISOString(), ...loaded,
      canonicalSnapshot: stage === 'all' ? loaded.snapshot : loadRuleSnapshot(),
      note: 'files/snapshot 是共用阶段规则，canonicalSnapshot 是全规则版本，不因适配选择改变；adaptation.files 按 default、宿主、模型顺序提供差异说明。run 仅记录显式选择，能力未探测均为 unknown，模型系列不代表实际版本。提供不代表 Agent 已阅读、理解或平台实测通过。' };
    if (options.output) {
      const target = path.resolve(options.output);
      try { fs.writeFileSync(target, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); }
      catch (error) { throw failure('runtime', target, error.code === 'EEXIST' ? '输出文件已存在，拒绝覆盖。' : error.message, '选择新的记录文件名，并确保父目录已存在。', error.code === 'EEXIST' ? 'RULE_OUTPUT_EXISTS' : 'RULE_OUTPUT_WRITE'); }
      result = { status: 'provided', output: target, stage, snapshot: loaded.snapshot, canonicalSnapshot: result.canonicalSnapshot,
        adaptation: { ...loaded.adaptation, files: loaded.adaptation.files.map(({ path: name, sha256: digest }) => ({ path: name, sha256: digest })) }, run: loaded.run };
    }
  } else throw failure('unsupported', 'command', '用法：runtime.mjs doctor [project] | rules <all|ingest|plan|prompt|review|export|legacy> [--adapter <ID>] [--model <ID>] [--output <new-file>]', '按用法运行；默认不识别宿主，未指定适配使用 default。doctor 不写文件，rules 仅在明确指定新文件时写入。');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(JSON.stringify({ status: 'failed', issues: [error.issue ?? failure('runtime', '', error.message, '保留输入并核对文件权限和运行环境。').issue] }, null, 2) + '\n');
    process.exitCode = 1;
  }
}
