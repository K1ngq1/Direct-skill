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
图片或 MCP 提交由宿主已连接且获本次授权的工具执行；安装不会接通服务或授予生成权限。
本包提供新文本／Excel／媒体工作流，旧 HTML 网页服务仅保留在开发仓库。
'''
README = '''# 导演分镜 Skill 安装包

本目录可直接放入宿主的 skills 目录，无需 Git、仓库历史、资产库或 npm install。
调用 $storyboard-workbench，提供粗稿脚本、目标时长及已有参考，按 [SKILL](SKILL.md) 完成规划、Prompt、润色、Excel 与获授权的工具提交。

## 环境

Node.js 20+、Python 3.10+。Excel 读取／更新需要 openpyxl，安装命令为 `python -m pip install -r requirements.txt`。
ExcelJS 已随包提供。首次使用按共用 Skill 运行 doctor；所有项目数据写到用户工作目录。
已有 MCP／生图服务由宿主连接，缺工具时保留待提交请求；本包不包含账号、密钥或素材。

## 范围与验证状态

程序检查不等于创作质量或真实媒体生成验收；本包未声称跨模型质量提升。
实际版本与每个文件的 SHA-256 见 package-manifest.json。历史材料、开发测试和旧网页界面不在安装包中。
'''


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def build(output, ref='HEAD'):
    revision = git('rev-parse', '--verify', ref + '^{commit}').decode().strip()
    names = git('ls-tree', '-r', '--name-only', revision).decode('utf-8').splitlines()
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
    # Legacy teaching examples remain available online without shipping the test fixture library.
    name = 'storyboard-workbench/references/story-planning.md'
    files[name] = re.sub(r'\]\(\.\./tests/fixtures/([^)]*)\)',
                         lambda m: '](https://github.com/K1ngq1/Direct-skill/blob/' + revision + '/storyboard-workbench/tests/fixtures/' + m[1] + ')',
                         files[name].decode('utf-8')).encode('utf-8')
    files['SKILL.md'] = ENTRY.encode('utf-8')
    files['README.md'] = README.encode('utf-8')
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
