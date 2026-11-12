# v2 创作状态与字段合同

编写新 v2 创作 JSON 时读取，并配合[机器可读合同](../schemas/visual-plan-v2.json)。新稿封存转到[封存与验收](visual-seal.md)，定向修改转到[修订合同](visual-revision.md)。

## 新版程序入口与合同

旧 `visual-excel-v1` 继续使用[既有 v1 合同](visual-legacy.md)，不自动迁移；首次正式交付按[三表规范](excel-delivery.md)，已绑定的正式文件继续保留其排版，历史文件保持原件。新版使用本节与 [机器可读字段合同](../schemas/visual-plan-v2.json)，其他章节的导演、静帧和图片授权规则继续适用。一次创作后做独立语义核对；发现具体结构或语义错误时最多两轮局部修复，不按低分反复改稿。Excel 首表用于顺着镜序阅读故事，评分与检查过程保留在后台制作日志。

### 启动与阶段规则

启动与阶段读取统一按[共用 Skill](../SKILL.md#启动与规则读取)；能力观察、规则分块与参数说明见[适配参考](../adapters/README.md)。本页仅提供新稿字段合同；封存、修订与 Excel 交付分别按任务入口读取。

### 唯一创作状态

执行效率与计时遵守[项目约束](../../AGENTS.md#执行效率与计时)。提速只减少重复读取、正文搬运、无变化导出和不必要的模型往返，不改变下述创作、版本、评分和检查合同。共用人物与场景先就绪，同阶段一次写入完整正文；Excel 直接消费同版 JSON。记录正文完成、核对完成、导出开始/结束及交付核验时间，区分模型创作与实际 Excel 程序耗时；从零重跑另建项目，仅导入本次授权原稿，不读取旧创作稿或生成回执作为答案。

继续使用原稿 `project.json` 与创作 `visual-plan.json`。不改原件、单元格来源或历史正文。字段定义由随包合同供程序读取，不要求模型接口原生支持 JSON Schema。

- 计划保留原有 `title/spec/productionInventory/props/references/designNotes/shots/calibration`。新增 `rules/run/revision/sourceResolutions/repairAttempts/changes`；`run` 至少包含 `{platform, model}`，未知模型用 `null`。宿主明确暴露的失败可写 `run.failures:[{category,message}]`，类别区分 network/unsupported/runtime/unknown 等；不可见的信息不推断。
- `seal` 初始化稳定 `projectId`、原件哈希、规则快照、revision=1 和修订记录。不沿用另一项目 ID；后续修订保持该身份。`run` 是操作者记录，不是平台能力实测证明。
- 运行环境恢复或更换模型时用 `revise` 的 `kind:"runtime"` 与非空 `run` 补丁更新记录，保留 `baseRevision/actor/reason`；只修改运行信息，不消耗两轮内容修复，也不使未变镜头评分过期。`failures` 保留原文并只追加，恢复时追加 `failureResolutions:[{failureIndex,reason,resolvedAt}]`；序号从0开始，必须指向已有失败。新能力声明需附观察依据，切换宿主或模型后不能默认继承旧能力。
- 资产沿用 `characters[].id`、`locations[].id`；镜头沿用 `id/sourceShotIds/locationId`。每个角色、场景和道具新增 `provenance`，原有 name/description/basis 保留，道具不要求 basis。
- 每镜保留原十一维、Shot Schema、transition、motion、reuseOf、prompt 与 review；增加 `intent`（画面目的）、`optics`、`provenance`、`notApplicable`、`semanticReview`、`variantId/selection/candidates`。默认方案由程序初始化，无需人工选择。新增字段不进入旧字段拼接器。
- 用户要求视频 Prompt 时可增加 `videoPrompt` 非空文本，写动作起止、时间变化、节奏与运镜，与静态 `prompt.text` 分开。未要求时省略，不用空串或 null 充数；`motion` 仍是动作及剪辑编排记录。视频文字沿用同一人物、场景、道具、时长及连续性，进入修订和候选校验与来源哈希；正文更改使相应检查和评分过期。现有十一维评分只评价静态 Prompt，不代表视频文本质量。完整视频正文进入“生成Prompt”，主表呈现可阅读的动作和运镜；字段不触发媒体调用。需要图片验收、视频镜头和时间线规划时按[视频工作流](video-workflow.md)绑定独立版本状态，不复制既有权威正文。
- `optics` 为 `{focalLengthMm,aperture,focus,depthOfField,frameBasis,basis}`：前两项为正数，其余为文本。正文自然表达同一焦距、f/值和清晰范围；数值一致不能证明物理拍摄成立。
- 人物 position/orientation/pose/visibleParts 必须逐人记录。appearance/clothing/hands/gaze/expression 若不适用，在本镜 `notApplicable` 用 `subjects.<assetId>.<field>` 写原因；不强造不可见面孔。无人镜的 subjects 为空。道具逐个写 state、position 和 holderAssetIds。
- 依据记录为 `{field,kind,basis,sourceShotIds}`，kind 为 `source/user/director/unknown`。原文事实必须绑定源镜；用户确认应在 basis 保存具体要求；导演设计须明确说明；unknown 阻止显示为已完成。资产至少为 description 记录依据；镜头至少覆盖 intent、dimensions.moment、dimensions.camera、dimensions.composition、dimensions.lighting、optics、shotSchema。可在 basis 中分别列明该字段内部的原事实和补全，不把混合内容一律称原文。
- 原稿 reviewIssues 不静默丢弃。通过 `sourceResolutions:[{issueId,decision:"resolved"|"excluded",reason}]` 记录处理；排除工作表须说明实际内容和理由，不清空原稿问题列表。

### 资产、总表与交接

场景资产写作前，先完成[场景美术与陈设设计](scene-art-direction.md)，流程为“场景信息 → 场景美术与陈设设计 → 场景 Prompt”。按稳定场景 ID 保存一份共用设定，各机位与分镜引用其可见部分；六项设计、已有正负约束冲突审查、确认后变更及跨镜核对统一按该规则执行。设计维度不由程序拼接成正文。

新版人物/场景文件仍分别使用 `character-prompts.json`、`scene-prompts.json`。`report.assetHashes.characters/locations` 提供对应 `sourcePlanHash`，绑定该类资产依赖而不是整个计划 JSON；仅评分或修订号变化不会使资产正文过期。原 v1 文件继续使用完整计划哈希。新文件需覆盖全部登记资产；人物不需头像或被阻塞时分别写 not-required/blocked，不能漏行。无人项目无需人物文件。
