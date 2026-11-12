"""Build a small, reproducible skill ZIP from committed public runtime files."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NAME = 'storyboard-workbench'
ENTRY = '''---
name: storyboard-workbench
description: Turn rough scripts into linked storyboard Prompts, refine their wording, export Excel, and submit authorized tasks through the host's connected image or MCP tools.
---

# 导演分镜 Skill

先读取[执行约束](AGENTS.md)和唯一[创作流程](storyboard-workbench/SKILL.md)，按阶段继续。
本目录是独立安装包根目录。资源与脚本相对路径从这里定位，执行命令时换成绝对路径；项目和输出放在用户工作目录。
图片或 MCP 提交由宿主已连接且获本次授权的工具执行；安装器可配置 Codex 的 LibTV MCP 并引导用户授权，手动解压不会配置连接。安装不授予媒体生成权限。
本包提供新文本／Excel／媒体工作流，旧 HTML 网页服务仅保留在开发仓库。
'''

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def package_readme(text, revision, files):
    def link(match):
        target = match[1]
        if target.startswith(('#', 'https:', 'http:', 'mailto:')):
            return match[0]
        filename = target.split('#', 1)[0]
        if filename in files:
            return match[0]
        return '](https://github.com/K1ngq1/Direct-skill/blob/' + revision + '/' + target + ')'
    return re.sub(r'\]\(([^\s)]+)\)', link, text)


def build(output, ref='HEAD'):
    revision = git('rev-parse', '--verify', ref + '^{commit}').decode().strip()
    names = git('ls-tree', '-r', '--name-only', revision).decode('utf-8').splitlines()
    allowed = set(json.loads(git('show', revision + ':distribution/public-files.json'))['files'])
    unexpected = sorted(set(names) - allowed)
    if unexpected:
        raise ValueError('Commit contains files outside public runtime scope: ' + ', '.join(unexpected))
    selected = []
    for name in names:
        public = name in ['AGENTS.md', 'LICENSE', 'requirements.txt', 'storyboard-workbench/SKILL.md', 'storyboard-workbench/assets/web/workflow.mjs']
        public |= name.startswith(('storyboard-workbench/references/', 'storyboard-workbench/adapters/', 'storyboard-workbench/schemas/'))
        public |= name.startswith('storyboard-workbench/scripts/') and name != 'storyboard-workbench/scripts/server.mjs'
        if public:
            if Path(name).suffix.lower() in ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.aep', '.xlsx'] or '__pycache__' in name or 'node_modules' in name:
                raise ValueError('Non-runtime asset in allowlist: ' + name)
            selected.append(name)
    files = {name: git('show', revision + ':' + name) for name in selected}
    files['SKILL.md'] = ENTRY.encode('utf-8')
    files['AGENTS.md'] = package_readme(files['AGENTS.md'].decode('utf-8'), revision, files).encode('utf-8')
    files['README.md'] = package_readme(git('show', revision + ':README.md').decode('utf-8'), revision, files).encode('utf-8')
    files['agents/openai.yaml'] = git('show', revision + ':storyboard-workbench/agents/openai.yaml')
    manifest = {'schemaVersion': 1, 'sourceRevision': revision, 'files': [
        {'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in sorted(files.items())]}
    files['package-manifest.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(NAME + '/' + name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compresslevel=9)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_name(output.name + '.sha256').write_text(digest + '  ' + output.name + '\n', encoding='ascii')
    return {'sourceRevision': revision, 'files': len(files), 'unpackedBytes': sum(map(len, files.values())), 'zipBytes': output.stat().st_size, 'sha256': digest, 'archive': str(output)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--ref', default='HEAD')
    args = parser.parse_args()
    print(json.dumps(build(args.output, args.ref), indent=2))
