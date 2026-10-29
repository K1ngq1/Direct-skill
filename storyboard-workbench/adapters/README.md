# Agent 与模型适配

共用业务规则、工作流和字段合同从 [Skill](../SKILL.md) 与[规则清单](../references/rules-manifest.json)读取。本目录只处理宿主入口、模型差异与能力降级，不各自维护人物、场景、分镜或 Prompt 标准。

## 选择方法

先明确三个独立信息：

| 信息 | 选择项 | 含义 |
|---|---|---|
| Agent 运行环境 | `default`、`codex`、`claude-code`、`workbuddy` | 谁负责读取文件、执行工具和写回结果 |
| 模型层 | `default`、`glm`、`openai`、`anthropic`、`google`、`deepseek`、`qwen`、`kimi` | 厂商或模型系列的差异规则；不负责连接 API |
| 实际能力 | 文件读写、脚本执行、图片理解、结构输出、工具调用 | 逐项根据本次结果记录，不能由前两项推定 |

从仓库根执行；如果 Skill 安装在其他位置，将脚本路径换为该完整 Skill 目录中的对应路径：

```text
node "storyboard-workbench/scripts/runtime.mjs" doctor
node "storyboard-workbench/scripts/runtime.mjs" rules plan --adapter codex --model default
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter claude-code --model glm --output "rules-prompt-001.json"
node "storyboard-workbench/scripts/runtime.mjs" rules plan --adapter workbuddy
node "storyboard-workbench/scripts/runtime.mjs" rules review --adapter codex --model openai
```

显式参数优先。本版不推断进程、环境变量或客户端身份；省略选项即 `default`。未知 adapter 或 model 分别回退到 `default`，保留原请求值并输出 `ADAPTER_FALLBACK` 或 `MODEL_FALLBACK` 告警。已登记文件丢失、规则清单损坏会报错，不能借回退掩盖包损坏。

阶段 `ingest/plan/prompt/review/export/legacy` 沿用共用流程；`all` 只用于规则完整快照。按当前阶段加载，不递归读取本目录所有平台文档。附加内容顺序为 `default.md` → 选定宿主文档 → 选定模型文档，去重；模型 `default` 不增加文件。

prompt 与 review 阶段均从共用清单加载[表达与关系规则](../references/prompt-language.md#四步表达核对)；独立评审也须读取完整正文。宿主和模型薄入口仅作定位，不保存厂商专用的平行润色标准。本轮装载检查与小样本质量结论见[实施说明](../../docs/PROMPT-LANGUAGE-VERIFICATION.md)，不能将单模型结果推广到其他适配组合。

## 输出与证据

- `files`、`snapshot`、`canonicalSnapshot` 继续表示共用规则及其哈希；更换 adapter 不更改导演规则或字段含义。
- `adaptation.requested` 与 `adaptation.selected` 分别记录请求和实际选择，`adaptation.manifest` 记录适配注册表版本哈希，`adaptation.files` 记录附加文件的路径、哈希和正文，`adaptation.warnings` 保存回退告警。
- `run.platform`、`run.model` 是显式选择的记录，不是自动探测；模型 ID 只表示选用的厂商或系列规则，不表示实际服务端版本。`run.capabilities` 未观察项为 `unknown`，已观察项仅使用带证据的 `supported/unsupported`。
- `--output` 只写新文件，不覆盖旧记录；stdout 是摘要，完整记录保留所提供的规则正文。提供和哈希校验不等于模型已理解或遵守规则。
- `doctor` 检查依赖和文件，不执行内容硬校验；内容检查仍用共用 `visual.mjs report/validate`。

同一输入下可以用本地契约测试验证规则、字段、回退与导出一致性。这不能证明不同模型具有相同创作质量，也不能证明未启动的宿主会正确调用工具。

## 观察能力与执行降级

`--observations <file.json>` 接受本次能力观察，键只能为 `fileRead/fileWrite/scriptExecution/imageUnderstanding/structuredOutput/toolUse`。每项必须提供 `status`（`supported` 或 `unsupported`）、非空 `evidence` 和 ISO 日期时间 `observedAt`，例如：

```json
{"toolUse":{"status":"unsupported","evidence":"本次宿主明确返回工具调用不受支持。","observedAt":"2026-10-27T00:00:00Z"}}
```

```text
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter codex --model openai --observations "observations.json"
```

输出将观察保存为 `run.capabilityObservations`，并据此生成 `run.capabilities`；没有证据的已支持声明、未知能力名或无效时间会被拒绝。它记录提供的观察，不替代宿主实测。模型厂商名称不会启用能力。执行入口调用共用 `assertRuntimeCapabilities(run, names)`：明确不支持所需能力时，在工具调用前停止；未提供 `run` 或状态未知时保持旧入口兼容，操作者仍须核验实际工具。缺原生结构输出时继续交接同一 JSON 并运行本地合同校验，不降低字段要求；缺脚本能力时标记“未执行硬校验”；缺读图能力时不声称已核验图像。

历史 v2 中没有 `capabilityObservations` 的能力元数据继续可读，不补造证据，也不把旧声明当成能力实测证明；新提交的非 unknown 能力状态必须带观察依据。

运行能力记录须为普通 JSON 对象，字段须为自身可枚举的数据属性；JS 接口也拒绝 `Map/Date`、继承属性、访问器、隐藏字段和显式 `undefined`，避免保存后丢失拒绝状态或观察证据。省略整个可选 `run` 的旧接口行为不变。

已有新版计划可通过 `revise` 的 `kind:"runtime"` 与非空 `run` 补丁登记结果，仍要求 `baseRevision/actor/reason`，只能修改运行记录，不计入两轮内容修复。`failures` 只能追加，解决时追加 `failureResolutions:[{failureIndex,reason,resolvedAt}]`；`failureIndex` 是失败数组从0开始的序号。原失败和原版本保留，仅有有效解决记录的失败不再标为 pending。更换 platform/model 时，未在补丁中重新提供的能力记录会清除，避免沿用另一环境的结论。

同一 platform/model 下，`capabilities` 与 `capabilityObservations` 按能力名合并，未提到的能力和证据保留。若原观察已不适用，在修订 `reason` 说明原因并显式提交该能力为 `unknown`，同时省略该项新 observation；程序只撤销该能力的旧证据，历史版本仍保留。切换 platform/model 时不合并旧能力，只接受本次重新提供的记录。

## 限定规则正文大小

小上下文环境可显式给出 `--rule-chunk-chars <N>`；未给预算时完整输出行为不变。给预算后默认只提供第1块，用 `--chunk <N>` 读取后续块；单独给 `--chunk`、越界序号、非整数预算或预算小于2会报错。

```text
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter codex --model openai --rule-chunk-chars 12000
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter codex --model openai --rule-chunk-chars 12000 --chunk 2
```

分块时 `files/adaptation.files` 仅保留路径与哈希，所选正文在 `ruleDelivery.parts`；`ruleDelivery.chunks` 列出全部块及各片段来源、哈希和起止偏移。偏移与预算使用 UTF-16 code units，保留中文、标点、换行和完整代理对，全部片段可无损拼回原文件；共用规则快照不变，不另造精简规则。先按清单读完全部块再执行，不能把单块视为完整规则。这个预算只限制规则正文，不计算元数据、当前对话、工具载荷或模型 token 数；由实际宿主余量决定预算，不由模型品牌推定容量。带 `--output` 时仍只创建新文件，保存本块完整内容，stdout 仅显示摘要。

## 各平台入口

| 使用环境 | 入口说明 | 本版验证边界 |
|---|---|---|
| [default](default.md) | 明确读取完整 Skill 后运行同一脚本 | 通用降级约定与本地契约；不表示任何宿主已通过 |
| [Codex](codex.md) | `AGENTS.md` 项目规则；原生 Skill 发现目录为 `.agents/skills/` | 本地脚本可在 Codex 工作环境中检查；不推广到所有 Codex 配置 |
| [Claude Code](claude-code.md) | `CLAUDE.md` 引用共用规则；`.claude/skills/` 项目入口 | 文件及契约检查，未运行 Claude Code/GLM 端到端会话 |
| [WorkBuddy](workbuddy.md) | 代码项目的 `.codebuddy/skills/` 与规则目录 | WorkBuddy 官方文档支持；未运行其客户端 |
| [GLM 模型层](glm.md) | 与实际宿主组合，如 `--adapter claude-code --model glm` | 不调用模型、验证额度或调整 API 配置 |

下载仓库不会自动把 Skill 安装到所有客户端。可先在对应项目会话中明确要求读取 `storyboard-workbench/SKILL.md` 并运行上述命令；本仓库的 `.agents/skills/`、`.claude/skills/`、`.codebuddy/skills/` 提供项目薄入口，须保留它们与 canonical Skill 的相对目录关系。不要把裸入口复制到其他项目；跨项目安装应携带完整 Skill，并按目标平台重新定位。薄入口不复制业务规则或保存个人绝对路径。

## 模型厂商 Skill

以下入口随完整仓库使用，位于 `models/<ID>/SKILL.md`，由 `--model` 加载。它们引用同一 canonical Skill，只补充各厂商的结构输出、工具调用或图片输入差异；不会自动安装到客户端、切换模型或调用 API。不能只复制一个子目录当作完整导演 Skill。

| 厂商／模型系列 | `--model` | 模型规则入口 |
|---|---|---|
| OpenAI | `openai` | [SKILL.md](models/openai/SKILL.md) |
| Anthropic／Claude | `anthropic` | [SKILL.md](models/anthropic/SKILL.md) |
| Google／Gemini | `google` | [SKILL.md](models/google/SKILL.md) |
| DeepSeek | `deepseek` | [SKILL.md](models/deepseek/SKILL.md) |
| 阿里云／通义千问 Qwen | `qwen` | [SKILL.md](models/qwen/SKILL.md) |
| 月之暗面／Kimi | `kimi` | [SKILL.md](models/kimi/SKILL.md) |
| 智谱／GLM | `glm` | [原有模型规则](glm.md)，路径保持兼容 |

```text
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter codex --model openai
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter claude-code --model anthropic
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter default --model qwen
```

按实际配置选择组合；注册表允许装载不代表该宿主已接通对应厂商。未知宿主用 `default`，未知模型保持 `default`。各模型入口注明官方资料来源；本地装载、链接和字段合同检查不等于真实模型创作验收。

## 新增适配器

1. 确认差异属于宿主还是模型；只写实际入口、工具约束、结构输出差异和未知能力，引用现有共用规则。
2. 宿主在本目录写差异文档；新模型可按 `models/<ID>/SKILL.md` 建立带 `name/description` 的薄入口。在 [manifest.json](manifest.json) 的 `hosts` 或 `models` 登记，复用 `runtime.mjs` 选择逻辑；不增加远端服务或平行状态。共用阶段规则清单继续只管业务规则。
3. 给现有 runtime 测试补齐选中项、共用规则快照不变、文件缺失及未知项回退；按统一字段合同校验同一最小输入。
4. 若没有真实客户端或模型调用，只报告静态检查/契约测试。新增宿主运行证据时记录版本、输入、规则哈希、实际工具条件及失败项，不将模拟输出标为真实生成。

当前交付范围以项目要求为准：默认 Excel；JSON 与检查记录是内部生产资料。本适配不启动网页或媒体生成，视频 Prompt 仅在明确要求时作为文本按共用流程处理。
