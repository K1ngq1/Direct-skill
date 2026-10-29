# Agent 与模型适配参考

仅在接入宿主、选择模型或诊断能力时查阅。创作流程与按需规则由唯一 [Skill](../SKILL.md) 指定；本页不维护平台专用业务标准。

## 选择方法

从完整仓库根运行：

```text
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter codex --model openai --output "rules-prompt-001.json"
```

- `--adapter` 选择宿主：`default/codex/claude-code/workbuddy`；`--model` 独立选择厂商规则，不连接 API、不切换实际模型。省略均为 default，实际未知时不猜。
- 未知值分别保留请求并以 `ADAPTER_FALLBACK/MODEL_FALLBACK` 告警后回退。已登记文件缺失、越界或损坏直接报错，不以回退掩盖。
- 基础正文来自现有规则清单的 `core + stages[stage]`；`onDemand` 只登记专项资源，触发条件由 Skill 维护，执行相关任务前必须补读。`all` 和 `canonicalSnapshot` 包含所有新版基础与按需文件，排除 legacy；旧清单不含 onDemand 时行为不变。
- 适配正文按 `default.md → 所选宿主 → 所选模型` 去重加载；model=default 不追加文件。更换适配组合不改变共用规则。
- `--output` 只创建新记录，完整结果写文件，stdout 为摘要；未给该参数则直接输出完整结果。哈希证明所提供版本，不证明模型已理解。

## 输出与能力观察

`files/snapshot` 保存当前阶段共用正文和指纹；CLI 的 `canonicalSnapshot` 保存全规则指纹。`adaptation` 保存 requested/selected、manifest 指纹、附加 files 和 warnings。`run.platform/model` 仅表示所选宿主与厂商／系列规则，不表示真实服务端版本；`doctor` 检查依赖与文件，不执行内容硬校验。

`--observations <file.json>` 接受本次实际观察，只允许 `fileRead/fileWrite/scriptExecution/imageUnderstanding/structuredOutput/toolUse`。每项含 supported 或 unsupported 状态、非空证据与 ISO 时间：

```json
{"toolUse":{"status":"unsupported","evidence":"本次宿主明确返回工具调用不受支持。","observedAt":"2026-10-27T00:00:00Z"}}
```

输出保存在 `run.capabilityObservations` 并生成 `run.capabilities`，未观察项 unknown。无证据声明、未知能力名或无效时间被拒绝。JS 接口仅接受可无损保存的普通 JSON 对象，拒绝 Map/Date、继承属性、访问器、隐藏字段和显式 undefined。

执行入口调用 `assertRuntimeCapabilities(run, names)`，明确不支持时在工具调用前停止；缺 run 或 unknown 保持旧接口兼容，操作者仍须核验工具。缺原生结构输出时仍按同一合同交接 JSON；缺脚本、文件或读图能力时按 [default 降级表](default.md#能力降级)处理。

历史 v2 中无 observation 的记录可读，但不补造证据或视为实测。新能力声明必须附观察。已有计划用 `revise` 的 `kind:"runtime"` 与非空 run 补丁更新，保留 baseRevision/actor/reason，不计入内容修复轮数：

- 同一 platform/model 按能力名合并，未提及项保留；撤销失效观察时在 reason 说明，显式把该能力设 unknown 且不提交该项新 observation。
- 切换 platform/model 不继承未重新提供的能力；旧版本仍保留。
- failures 仅追加；解决时追加 `failureResolutions:[{failureIndex,reason,resolvedAt}]`，序号从0开始且须指向已有失败，不删除原始错误。

## 限定规则正文大小

小上下文可追加 `--rule-chunk-chars 12000`，默认读第1块，再用 `--chunk 2` 等读取后续。未给预算时完整输出不变；单独给 chunk、越界序号、非整数预算或预算小于2会报错。

分块结果中 files/adaptation.files 只有路径与哈希；`ruleDelivery.parts` 为本块正文，chunks 列出全部片段来源、哈希和起止偏移。预算单位是 UTF-16 code units，保留完整代理对，各块可无损拼回原文。读完全部块再执行；预算不包括元数据、会话、工具载荷，也不等于模型 token 容量。按需补读仍遵循 Skill，不能将一个基础阶段或单块视为全任务规则。

## 各平台入口

| 宿主 | 项目入口与差异 |
|---|---|
| [default](default.md) | 显式定位完整 Skill；实际平台 unknown |
| [Codex](codex.md) | `.agents/skills/`，项目约束由 AGENTS 提供 |
| [Claude Code](claude-code.md) | `.claude/skills/`，CLAUDE 兼容入口 |
| [WorkBuddy](workbuddy.md) | `.codebuddy/skills/` |

薄入口依赖完整仓库相对关系，跨项目安装携带完整 Skill 并重新定位；不能只复制一个裸入口。下载不等于自动启用，自动发现不可用时直接要求读取共用 Skill。客户端自动发现和真实模型执行只按实际证据确认。

## 模型厂商 Skill

| 厂商／系列 | --model | 规则入口 |
|---|---|---|
| OpenAI | openai | [SKILL.md](models/openai/SKILL.md) |
| Anthropic／Claude | anthropic | [SKILL.md](models/anthropic/SKILL.md) |
| Google／Gemini | google | [SKILL.md](models/google/SKILL.md) |
| DeepSeek | deepseek | [SKILL.md](models/deepseek/SKILL.md) |
| 阿里云／Qwen | qwen | [SKILL.md](models/qwen/SKILL.md) |
| 月之暗面／Kimi | kimi | [SKILL.md](models/kimi/SKILL.md) |
| 智谱／GLM | glm | [原有模型规则](glm.md) |

这些资源只补充结构输出、工具和图片输入差异。注册表允许某组合，不代表已接通 API、具备额度或通过创作验收。验证状态统一见[项目 README](../../README.md#范围与验证状态)，历史证据不作为运行依赖。

## 新增适配器

确认差异属于宿主或模型，在本目录写最小接入说明，再在 [manifest.json](manifest.json) 的 hosts/models 登记；模型沿用 models/<ID>/SKILL.md，GLM 原路径保持兼容。复用加载器，补选中项、共同规则不变、缺文件和未知回退检查。真实平台运行另记版本、输入、规则哈希、工具条件与失败，不把静态检查说成端到端验证。