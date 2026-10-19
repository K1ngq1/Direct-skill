import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillRoot = fileURLToPath(new URL('..', import.meta.url));
const root = path.resolve(skillRoot, '..');
const entries = [
  ['.agents/skills/storyboard-workbench/SKILL.md', 'codex'],
  ['.claude/skills/storyboard-workbench/SKILL.md', 'claude-code'],
  ['.codebuddy/skills/storyboard-workbench/SKILL.md', 'workbuddy']
];

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink() || ['tests', 'vendor'].includes(entry.name)) return [];
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(filename) : entry.name.toLowerCase().endsWith('.md') ? [filename] : [];
  });
}

function localLinks(filename) {
  const text = fs.readFileSync(filename, 'utf8');
  const links = [];
  for (const match of text.matchAll(/!?\[[^\]\r\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^\r\n]*["'])?\s*\)/g)) {
    const target = match[1] ?? match[2];
    if (target.startsWith('#') || /^(?:https?:|mailto:|app:|codex:|plugin:)/i.test(target)) continue;
    const relative = decodeURIComponent(target.split(/[?#]/, 1)[0]);
    assert.ok(relative && !path.isAbsolute(relative) && !/^file:/i.test(relative), `${path.relative(root, filename)} 使用不可移交路径：${target}`);
    const resolved = path.resolve(path.dirname(filename), relative), within = path.relative(root, resolved);
    assert.ok(within !== '..' && !within.startsWith('..' + path.sep) && !path.isAbsolute(within), `${filename} 链接越出发布根目录：${target}`);
    links.push({ target, resolved });
  }
  return { text, links };
}

test('public Markdown references resolve without private projects, artifacts or Git metadata', () => {
  const filenames = new Set([
    ...markdownFiles(skillRoot),
    ...['README.md', 'AGENTS.md', 'CLAUDE.md', 'docs/FIRST-RELEASE.md', ...entries.map(([filename]) => filename)].map(filename => path.join(root, filename))
  ]);
  const failures = [];
  for (const filename of filenames) {
    if (!fs.existsSync(filename)) {
      failures.push(`发布文件缺失：${path.relative(root, filename)}`);
      continue;
    }
    for (const { target, resolved } of localLinks(filename).links) {
      const relative = path.relative(root, resolved).split(path.sep).join('/');
      if (/^(?:projects|artifacts|libtv-asset-library|creative-memory|creative-vault|director-eval|\.git)(?:\/|$)/.test(relative)) failures.push(`${path.relative(root, filename)} 依赖私有路径 ${target}`);
      else if (!fs.existsSync(resolved)) failures.push(`${path.relative(root, filename)} 缺少链接目标 ${target}`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('each host entry resolves the same canonical Skill and selects its explicit host adapter', () => {
  const canonical = fs.realpathSync(path.join(skillRoot, 'SKILL.md'));
  for (const [relative, adapter] of entries) {
    const filename = path.join(root, relative), { text, links } = localLinks(filename);
    assert.ok(links.some(link => fs.existsSync(link.resolved) && fs.realpathSync(link.resolved) === canonical), `${relative} 未链接到真实 canonical Skill`);
    assert.match(text, new RegExp(`--adapter\\s+["']?${adapter}["']?(?=\\s|$|[\x60])`), `${relative} 缺少显式 ${adapter} 选择命令`);
  }
});
