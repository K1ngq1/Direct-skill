# Direct Skill

把脚本整理成人物、场景、分镜和自然语言 Prompt，交付一个可编辑的 `<片名>_分镜脚本.xlsx`，包含“分镜脚本／生成Prompt／人物与场景”三表。Agent 负责创作，本地脚本负责归档、校验、版本与导出；不内置模型 API。

## 三个入口

| 文档 | 用途 |
|---|---|
| 本 README | 安装、最短使用步骤、能力与验证边界 |
| [AGENTS.md](AGENTS.md) | 执行约束、原件保护、工程与交付要求 |
| [SKILL.md](storyboard-workbench/SKILL.md) | 创作流程与按任务读取的规则索引 |

专项规则、命令合同和历史证据保留在原目录，由 Skill 按需引用，不必从头逐份阅读。

## 安装与使用

首次使用需要 Python 3.10+、Node.js 20+；Excel 依赖一次性安装 `python -m pip install openpyxl`。无需 Git 或 npm install。

**Windows：在 PowerShell 运行这一条安装命令：**

```powershell
irm https://github.com/K1ngq1/Direct-skill/releases/latest/download/install.py | python -
```

macOS / Linux：

```sh
curl -fsSL https://github.com/K1ngq1/Direct-skill/releases/latest/download/install.py | python3 -
```

安装器只下载约560 KiB的独立运行包，校验ZIP和逐文件SHA-256，默认安装到 `$CODEX_HOME/skills/storyboard-workbench`，未设置时为 `~/.codex/skills/storyboard-workbench`。已有同名安装会保留并提示，不覆盖。下一轮可用 `$storyboard-workbench` 调用；其他宿主可在命令末尾追加 `--dest <宿主的skills目录>`。

也可直接下载[独立ZIP](https://github.com/K1ngq1/Direct-skill/releases/latest/download/storyboard-workbench.zip)，把其中的 `storyboard-workbench` 文件夹放入宿主的skills目录。独立包入口已包含全部相对资源，不使用开发仓库的薄入口。

安装包只含规则、合同、脚本及必需运行库；**不含资产库、用户项目、测试样例、历史证据、Git历史或旧网页界面**。保留ExcelJS和少量被核心脚本引用的工作流辅助代码，以保证导出与任务执行可用。包内 `package-manifest.json` 记录源码commit及文件清单。

**使用链路：**提供TXT/Markdown粗稿或XLSX → 归档与全片规划 → 生成人物／场景／分镜Prompt → 四步润色与语义核对 → 固定Excel → 按授权保存并提交MCP／生图任务 → 回执、恢复和集中回写。媒体使用宿主实际连接的工具，安装不会配置账号、API密钥或MCP服务；缺少工具时交付待提交请求。

安装后所有脚本路径以Skill安装目录解析，项目和输出保存在用户工作目录。`STORYBOARD_PYTHON` 可指定已有解释器的绝对路径。启动检查和命令详见共用Skill。

在项目会话中要求 Agent：“读取 `storyboard-workbench/SKILL.md`，把本次脚本整理成分镜 Excel。”提供原稿、目标时长与已确认参考。脚本不会代替 Agent 创作正文：

```text
python "storyboard-workbench/scripts/import_excel.py" "input.xlsx" "projects/demo"
node "storyboard-workbench/scripts/visual.mjs" seal "projects/demo" "plan.json"
node "storyboard-workbench/scripts/visual.mjs" export "projects/demo"
```

`plan.json` 由 Agent 在全片规划、创作和核对后提供。特殊列映射见[输入归档](storyboard-workbench/references/input-archive.md)。接手已有 Excel、修订、候选及反馈导回时，按 Skill 索引读取对应合同；正式文件持续原位更新，保留用户排版和意见。

## 平台适配

| 宿主 | 项目发现入口 |
|---|---|
| Codex | `.agents/skills/storyboard-workbench/` |
| Claude Code | `.claude/skills/storyboard-workbench/`，`CLAUDE.md` 兼容入口 |
| WorkBuddy | `.codebuddy/skills/storyboard-workbench/` |
| 其他宿主 | 显式读取共用 Skill，使用 `--adapter default` |

上表是开发仓库的项目薄入口，依赖完整仓库，不能单独复制到全局目录；发布ZIP已有独立入口，可直接安装。自动发现不可用时直接指定共用 Skill。宿主与模型分别选择，API 使用用户已有配置；支持项、观察能力及降级方式见[适配参考](storyboard-workbench/adapters/README.md)。

## 范围与验证状态

- 默认完成文本与 Excel；视频 Prompt／规划按需提供。图片、视频、音频生成需要明确授权。
- 新任务采用 v2 合同；旧项目按原合同读取，不自动迁移。实际工具能力以本次观察为准。
- 本地装载、链接与数据合同已有测试。Claude Code、WorkBuddy 客户端及跨模型端到端效果未验证，平台入口只承诺适配。
- 2026-10-29 的八组单模型表达规则对照为七组持平、一组新稿漏限制作局部修复，**没有证明质量提升**。归档：[表达规则验证](docs/PROMPT-LANGUAGE-VERIFICATION.md)、[首版记录](docs/FIRST-RELEASE.md)、[媒体执行记录](docs/MEDIA-PIPELINE-VERIFICATION.md)。这些材料不是日常必读规则。
- Excel 的字体设置不等于目标软件实际显示；交付时按 AGENTS 的要求检查中文与排版。

## 维护

```text
npm test
python -m unittest discover -s storyboard-workbench/tests -p "test_import*.py"
```

发布维护：用 `python distribution/build.py --output <新文件.zip>` 从已提交的公开运行文件构建；推送 `skill-v*` 标签后，GitHub Actions验证独立包并发布ZIP、校验文件和安装器。资产库永远不参与打包扫描。

按改动范围选择必要检查。新增宿主或模型在[适配注册表](storyboard-workbench/adapters/manifest.json)登记，复用现有加载器；业务规则仅在 Skill 指向的权威位置修改。测试使用合成输入，不提交私有素材、真实人评、凭据或个人绝对路径。

项目采用 [MIT](LICENSE)。随包第三方材料保留各自许可证：[ExcelJS](storyboard-workbench/scripts/vendor/LICENSE-exceljs)、[Humanizer-zh](storyboard-workbench/references/humanizer-zh/LICENSE)、[导演规则来源](storyboard-workbench/references/director-license.txt)。