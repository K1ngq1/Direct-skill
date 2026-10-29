# Direct-skill 首版实施与验证记录

后续说明（2026-10-29）：本文保留原实施时间与当次结果；当前表达规则、prompt/review 装载约定及单模型对照结论见[表达规则实施与验证边界](PROMPT-LANGUAGE-VERIFICATION.md)。后续结果不追溯改写本文历史验收。

记录日期：2026-10-19。本版在现有 `storyboard-workbench` 中增加多 Agent 适配，保留导入、导演规划、自然 Prompt、校验、修订和 Excel 导出链路。默认交付 Excel；JSON 和检查记录用于内部生产，不新增网页服务或模型 API 服务。

本文说明可公开的实现与验证边界，不包含用户原稿、真实生产项目、个人路径、密钥或私有评价。安装和日常命令以[主 README](../README.md)及 [Skill](../storyboard-workbench/SKILL.md)为入口。

## 改造前的问题

- 项目已经有阶段规则装载、统一 JSON 与 Claude Code 说明，但缺少可执行的宿主/模型选择机制。仅有文档入口不能证明选中了对应适配层。
- 宿主环境、模型系列和文件/工具能力容易混为一谈；使用 GLM 不等于获得文件系统、图片理解或终端权限。
- 新 Excel 与旧网页工作台并存，规则必须按模式加载，不能把旧候选选择、字段拼接和确认门槛加到新任务。
- Scene、Character、Shot 已有稳定 ID 与字段合同。重建同义字段或平行目录会增加迁移和同步风险。
- 文档中已有本机使用说明，不适合作为公开兼容性证据；平台官方支持、程序测试和真实模型质量需要分别报告。

## 保留的目录与职责

没有为目录整齐另建重复的 `workflows/` 或三套对象 Schema。实际共用规则继续放在 `references/`，现有等效字段合同继续由脚本执行。

```text
Direct-skill/
├─ AGENTS.md / CLAUDE.md / README.md
├─ .agents/skills/storyboard-workbench/SKILL.md
├─ .claude/skills/storyboard-workbench/SKILL.md
├─ .codebuddy/skills/storyboard-workbench/SKILL.md
├─ storyboard-workbench/
│  ├─ SKILL.md
│  ├─ adapters/
│  │  ├─ manifest.json / README.md / default.md
│  │  └─ codex.md / claude-code.md / workbuddy.md / glm.md
│  ├─ references/
│  │  ├─ rules-manifest.json / visual-workflow.md
│  │  ├─ directing.md / prompt-language.md / visual-rubric.md
│  │  └─ legacy-workbench.md / data-contract.md
│  ├─ schemas/visual-plan-v2.json
│  ├─ scripts/
│  │  ├─ runtime.mjs / import_excel.py
│  │  ├─ visual.mjs / visual_v2.mjs / visual_state.mjs
│  │  └─ export_visual_excel.mjs / project.mjs / vendor/
│  ├─ tests/
│  └─ assets/web/
└─ docs/FIRST-RELEASE.md
```

平台目录中的 `SKILL.md` 是薄入口，须保留与 canonical Skill 的相对位置；不能只将裸入口复制到另一项目。旧网页资源和独立工具保留，但不作为新版 Excel 交付前提。

## 共用规则、合同与本次变更

业务流程只在 [visual-workflow.md](../storyboard-workbench/references/visual-workflow.md) 与[阶段清单](../storyboard-workbench/references/rules-manifest.json)维护：导入与规范化 → 全片规划 → 场景/人物与镜头结构 → 自然正文 → 硬校验和独立语义核对 → 有限修复 → Excel 总表。导演与表达规则不进入各平台的独立副本。

新数据继续使用 `schemaVersion: 2`、`mode: "visual-excel-v2"`；评分版本仍是 `visual-v2`。不重命名现有 camelCase、`locations`、`characters`、`shots` 或稳定 ID。[字段合同](../storyboard-workbench/schemas/visual-plan-v2.json)说明必填、可空、不适用原因、来源性质与关联；跨实体引用、时序和版本检查由现有校验器执行。这个合同是项目自己的等效结构规范，不宣称是通用 JSON Schema。

| 改动范围 | 结果 |
|---|---|
| Agent/模型注册 | 新增[适配注册表](../storyboard-workbench/adapters/manifest.json)，宿主与模型分别登记 |
| 运行时 | 在现有 [runtime.mjs](../storyboard-workbench/scripts/runtime.mjs) 上增加显式选择、回退告警及适配记录，保留原阶段命令 |
| 平台入口与说明 | Codex、Claude Code、WorkBuddy 引用同一 Skill；GLM 作为独立模型层，默认适配处理未知能力 |
| 结构与校验 | 复用字段合同和校验入口，补充字段覆盖；结构有效与画面语义有效分别记录 |
| 可选视频文字 | `videoPrompt` 仅在明确要求时保存视频 Prompt 文本；静帧仍在 `prompt.text`，动作说明 `motion` 保持原含义，不生成视频；既有十一维评分只评价静态 Prompt |
| 导出 | 共用 Excel 导出显示同一当前方案、静帧正文及有请求时的视频文字；不新增页面配置 |
| 验证 | 扩展现有 runtime 和 visual-v2 测试，使用隔离的合成输入，不用真实项目充当公开测试数据 |

继续保留原稿归档、源指纹、修订历史、人评保护、当前方案与用户确认的区分。旧版与旧工作台按[旧入口](../storyboard-workbench/references/legacy-workbench.md)读取，不自动迁移或重算评分；不会因为新流程不调用旧功能就删除它们。

## 适配选择与失败记录

```text
node "storyboard-workbench/scripts/runtime.mjs" doctor
node "storyboard-workbench/scripts/runtime.mjs" rules plan --adapter codex
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter claude-code --model glm
node "storyboard-workbench/scripts/runtime.mjs" rules plan --adapter workbuddy --output "rules-plan-001.json"
```

显式 `--adapter` 选择宿主，`--model` 选择可选模型说明。本版不探测客户端或自动切换 API；省略参数使用 `default`。未知值分别回退并保留告警，已登记文件缺失或包损坏则报错，不能用回退掩盖损坏。

共用 `files/snapshot/canonicalSnapshot` 与适配 `adaptation` 分开记录。适配内容按 default → 宿主 → 模型加载并去重，包含请求值、实际选择、注册表/文件哈希与告警。`run` 记录显式选择；真实能力初始为 `unknown`，不能由型号或宿主名称推断。完整说明见[适配 README](../storyboard-workbench/adapters/README.md)。

不能执行脚本时标“未执行硬校验”，保留待校验 JSON 并给出相同终端命令；不能写文件时不声称已生成 Excel。解析、引用、语义、环境、网络和能力错误分别报告，局部修复仍遵守共用最多两轮的边界，不因评分低而循环重写。

## 测试覆盖与兼容性边界

测试数据为合成最小输入与合成三镜产品需求。它们检查规则、字段、状态和导出，不证明模型具备导演能力，也不是人工确认的优质创作样例。

| 测试入口 | 覆盖重点 |
|---|---|
| [runtime.test.mjs](../storyboard-workbench/tests/runtime.test.mjs) | 阶段规则、所有已登记宿主及 GLM 层、共用规则哈希一致、未知项回退、文件缺失、越界、CLI 选项和旧命令兼容 |
| [visual-v2.test.mjs](../storyboard-workbench/tests/visual-v2.test.mjs) | 缺字段、错误类型/引用、来源与连续性记录、有限修复、版本保护、候选应用、可选视频文字及合成三镜导出 |
| [visual-v2-export.test.mjs](../storyboard-workbench/tests/visual-v2-export.test.mjs) | 当前方案、正文、检查状态和 Excel 展示契约 |
| [visual.test.mjs](../storyboard-workbench/tests/visual.test.mjs)及既有回归 | 旧格式校验、文本冻结、导出与人工反馈保护等原有行为 |
| 静态检查 | UTF-8 回读、本地文档引用、适配注册文件、公开内容边界与入口相对路径 |

2026-10-19 本地执行结果：`npm test` 63/63 通过；Python 导入测试 10/10 通过；`runtime.mjs doctor` 的 Node、规则、脚本、ExcelJS 与 Python 五项均通过。环境为 Windows、Node.js 24.16.0、Python 3.12.14、openpyxl 3.1.5。发布契约中的两个测试已包含在 63 项内；未执行真实模型或媒体生成。

仓库 CI 使用 Node.js 22、Python 3.12 在 Windows 与 Ubuntu 的公开检出上重复同一套检查；远端结果以 GitHub Actions 为准，不能用本地成功代替。

| 环境/能力 | 本版可以证明的范围 | 未验证范围 |
|---|---|---|
| Codex | 本地文件和脚本检查可在当前 Codex 工作环境执行 | 其他客户端/云环境/权限配置；所有模型的创作质量 |
| Claude Code | 官方加载机制核对、项目薄入口和装载契约 | 实际插件会话、GLM 兼容层及端到端创作 |
| WorkBuddy | WorkBuddy 自身官方文档核对、注册及本地契约 | 客户端启动、自动加载、终端与工具执行 |
| GLM | 模型层装载、与宿主独立组合、共用输出合同 | 真实 API、额度、模型版本、图片理解和生成质量 |
| 跨模型比较 | 相同规则与结构可通过程序比较 | 人工可用率、修改量、匿名 A/B 与最终图片/视频质量 |

本次不调用模型 API、不做付费或批量生成，不将模拟输出、JSON 通过或 AI 自评分写成真实平台验收。

## 新适配、发布与回退

新增环境时先判断差异属于宿主还是模型，在 `adapters/` 写最小差异说明并登记到现有注册表；继续引用同一工作流和字段合同。补上注册、共用规则不变、缺文件和回退测试，再按实际拥有的客户端能力补运行证据。不要新建一套导演规则、API 后台或平行数据状态。

首版软件版本为 `0.1.0`，发布目标为本仓库的 `main` 分支；对应 Git 提交和远端状态以仓库历史为准。本次交付源码首版，不将版本号视为已创建 Git 标签或 GitHub Release。

回退使用上一版本的代码与入口，创作状态通过对应版本的历史快照恢复；不要用新脚本静默重写旧数据。回退前保留原件、用户反馈和当前历史，不批量删除目录。若只是宿主适配不适用，可显式选择 `default` 后继续同一共用流程，实际未完成的检查仍保持未执行。
