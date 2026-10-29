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

需要 Node.js 20+、Python 3.10+。完整克隆仓库，保留相对目录：

```text
git clone https://github.com/K1ngq1/Direct-skill.git
cd Direct-skill
python -m pip install -r requirements.txt
node "storyboard-workbench/scripts/runtime.mjs" doctor
```

ExcelJS 已随包提供，无需 `npm install`。`STORYBOARD_PYTHON` 可指定已有 Python 解释器的绝对路径；导入时使用同一解释器。

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

这些入口依赖完整仓库，不能单独复制到全局目录；跨项目使用须携带完整 Skill 并重新定位。自动发现不可用时直接指定共用 Skill。宿主与模型分别选择，API 使用用户已有配置；支持项、观察能力及降级方式见[适配参考](storyboard-workbench/adapters/README.md)。

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

按改动范围选择必要检查。新增宿主或模型在[适配注册表](storyboard-workbench/adapters/manifest.json)登记，复用现有加载器；业务规则仅在 Skill 指向的权威位置修改。测试使用合成输入，不提交私有素材、真实人评、凭据或个人绝对路径。

项目采用 [MIT](LICENSE)。随包第三方材料保留各自许可证：[ExcelJS](storyboard-workbench/scripts/vendor/LICENSE-exceljs)、[Humanizer-zh](storyboard-workbench/references/humanizer-zh/LICENSE)、[导演规则来源](storyboard-workbench/references/director-license.txt)。