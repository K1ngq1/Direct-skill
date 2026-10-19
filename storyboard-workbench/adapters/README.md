# Agent 与模型适配

共用业务规则、工作流和字段合同从 [Skill](../SKILL.md) 与[规则清单](../references/rules-manifest.json)读取。本目录只处理宿主入口、模型差异与能力降级，不各自维护人物、场景、分镜或 Prompt 标准。

## 选择方法

先明确三个独立信息：

| 信息 | 选择项 | 含义 |
|---|---|---|
| Agent 运行环境 | `default`、`codex`、`claude-code`、`workbuddy` | 谁负责读取文件、执行工具和写回结果 |
| 模型层 | `default`、`glm` | 已有宿主背后的模型系列；不负责连接 API |
| 实际能力 | 文件读写、脚本执行、图片理解、结构输出、工具调用 | 逐项根据本次结果记录，不能由前两项推定 |

从仓库根执行；如果 Skill 安装在其他位置，将脚本路径换为该完整 Skill 目录中的对应路径：

```text
node "storyboard-workbench/scripts/runtime.mjs" doctor
node "storyboard-workbench/scripts/runtime.mjs" rules plan --adapter codex --model default
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter claude-code --model glm --output "rules-prompt-001.json"
node "storyboard-workbench/scripts/runtime.mjs" rules plan --adapter workbuddy
```

显式参数优先。本版不推断进程、环境变量或客户端身份；省略选项即 `default`。未知 adapter 或 model 分别回退到 `default`，保留原请求值并输出 `ADAPTER_FALLBACK` 或 `MODEL_FALLBACK` 告警。已登记文件丢失、规则清单损坏会报错，不能借回退掩盖包损坏。

阶段 `ingest/plan/prompt/review/export/legacy` 沿用共用流程；`all` 只用于规则完整快照。按当前阶段加载，不递归读取本目录所有平台文档。附加内容顺序为 `default.md` → 选定宿主文档 → 选定模型文档，去重；模型 `default` 不增加文件。

## 输出与证据

- `files`、`snapshot`、`canonicalSnapshot` 继续表示共用规则及其哈希；更换 adapter 不更改导演规则或字段含义。
- `adaptation.requested` 与 `adaptation.selected` 分别记录请求和实际选择，`adaptation.manifest` 记录适配注册表版本哈希，`adaptation.files` 记录附加文件的路径、哈希和正文，`adaptation.warnings` 保存回退告警。
- `run.platform`、`run.model` 是显式选择的记录，不是自动探测；`glm` 只表示系列，不表示实际服务端版本。`run.capabilities` 初始全部为 `unknown`，只按真实观察更新。
- `--output` 只写新文件，不覆盖旧记录；stdout 是摘要，完整记录保留所提供的规则正文。提供和哈希校验不等于模型已理解或遵守规则。
- `doctor` 检查依赖和文件，不执行内容硬校验；内容检查仍用共用 `visual.mjs report/validate`。

同一输入下可以用本地契约测试验证规则、字段、回退与导出一致性。这不能证明不同模型具有相同创作质量，也不能证明未启动的宿主会正确调用工具。

## 各平台入口

| 使用环境 | 入口说明 | 本版验证边界 |
|---|---|---|
| [default](default.md) | 明确读取完整 Skill 后运行同一脚本 | 通用降级约定与本地契约；不表示任何宿主已通过 |
| [Codex](codex.md) | `AGENTS.md` 项目规则；原生 Skill 发现目录为 `.agents/skills/` | 本地脚本可在 Codex 工作环境中检查；不推广到所有 Codex 配置 |
| [Claude Code](claude-code.md) | `CLAUDE.md` 引用共用规则；`.claude/skills/` 项目入口 | 文件及契约检查，未运行 Claude Code/GLM 端到端会话 |
| [WorkBuddy](workbuddy.md) | 代码项目的 `.codebuddy/skills/` 与规则目录 | WorkBuddy 官方文档支持；未运行其客户端 |
| [GLM 模型层](glm.md) | 与实际宿主组合，如 `--adapter claude-code --model glm` | 不调用模型、验证额度或调整 API 配置 |

下载仓库不会自动把 Skill 安装到所有客户端。可先在对应项目会话中明确要求读取 `storyboard-workbench/SKILL.md` 并运行上述命令；本仓库的 `.agents/skills/`、`.claude/skills/`、`.codebuddy/skills/` 提供项目薄入口，须保留它们与 canonical Skill 的相对目录关系。不要把裸入口复制到其他项目；跨项目安装应携带完整 Skill，并按目标平台重新定位。薄入口不复制业务规则或保存个人绝对路径。

## 新增适配器

1. 确认差异属于宿主还是模型；只写实际入口、工具约束、结构输出差异和未知能力，引用现有共用规则。
2. 在本目录 [manifest.json](manifest.json) 的 `hosts` 或 `models` 登记文件，复用 `runtime.mjs` 选择逻辑；不增加远端服务或平行状态。共用阶段规则清单继续只管业务规则。
3. 给现有 runtime 测试补齐选中项、共用规则快照不变、文件缺失及未知项回退；按统一字段合同校验同一最小输入。
4. 若没有真实客户端或模型调用，只报告静态检查/契约测试。新增宿主运行证据时记录版本、输入、规则哈希、实际工具条件及失败项，不将模拟输出标为真实生成。

当前交付范围以项目要求为准：默认 Excel；JSON 与检查记录是内部生产资料。本适配不启动网页或媒体生成，视频 Prompt 仅在明确要求时作为文本按共用流程处理。
