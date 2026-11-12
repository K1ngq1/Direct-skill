---
name: storyboard-workbench
description: Turn scripts into linked characters, scenes, storyboards and natural-language prompts, with local validation and a persistent Excel deliverable.
---

# 导演分镜与 Excel

先读一次[项目约束](../AGENTS.md)。本页负责选路，Agent 创作完整自然正文，程序保存来源、校验、版本和 Excel。当前用户要求决定本轮范围。

## 启动与规则读取

在仓库根运行；安装版按 Skill 的真实目录解析脚本，项目保存在用户工作目录。

```text
node "storyboard-workbench/scripts/runtime.mjs" doctor
node "storyboard-workbench/scripts/runtime.mjs" rules plan --adapter codex --output "rules-plan-001.json"
```

依赖与环境未变时复用本轮 doctor。宿主与模型按[适配参考](adapters/README.md)显式选择，未知时用 default。rules 记录保存实际提供的正文与哈希；使用 --output 后按输出路径读取当前任务正文。只有实际阅读才可记为已读。

| 本轮操作 | rules 选择 | 何时执行 |
|---|---|---|
| 导入本次原稿 | ingest | 新项目或新来源 |
| 整片规划、人物与场景设计 | plan | 新创作或相关设计变更 |
| 写或润色 Prompt | prompt | 本镜结构已就绪 |
| 语义核对与冻结评分 | review | 核对本版完整成稿 |
| 封存新 v2 正文 | seal | 写入权威 JSON 与资产正文 |
| 正式 Excel 导出与回读 | export | 正文完成或受影响内容修订后 |
| 已有 Excel 绑定、意见、冲突 | excel-update | 本次确需维护现有文件 |
| 生成人物、场景、分镜图 | image-batch | 获得图片生成授权 |
| 上传现有图、连接待运行节点 | canvas | 获得对应画布写入授权 |
| LibTV 原生生成 | libtv-generation | 获得该媒体生成授权 |
| 保存至 LibTV 资产库 | assets | 明确要求资产库入库 |
| 执行故障或未知状态恢复 | 对应 recovery 路线 | 按[媒体索引](references/media-execution.md)选择原路径 |
| 继续旧项目 | legacy | 沿用该项目原合同 |

读完当前路线提供的必要正文再执行。引用链接用于定位，只有本轮操作触发才继续读其专项合同。摄影、实际参考、视频、单次自动制作的附加规则按下表选择。all 用于版本盘点与审计；canonicalSnapshot 记录全包指纹，按当前路线选择正文。

| 触发条件 | 附加规则 |
|---|---|
| 规划摄影或处理实际参考 | [表达规则](references/prompt-language.md)中的摄影、人物指代、确定参考 |
| 视频 Prompt、首尾与剪辑衔接 | [视频工作流](references/video-workflow.md) |
| 已明确授权一次完成生图并准备视频节点 | [单次自动制作](references/single-run.md) |
| 中文文章润色或需通用表达示例 | rules humanizer |
| 人工评分与校准 | [评分规则](references/visual-rubric.md#人工评分与版本化标准)，只读取本次指定真实记录 |

## 创作与验收底线

十一维持续有效，依次核对主体与关键瞬间、外貌服装、姿态动作、表情视线、人物道具关系、景别机位取景、摄影约束、构图空间、场景美术材质、光影色调、跨镜连续性。权重以[评分合同](references/visual-rubric.md)为准，不适用项按依据记录。

先建立共用人物、场景和道具设定，场景经过六项美术设计，再展开各镜。内部结构记录源事实、用户锁定、导演补全与未知项。静帧选一个时刻，视频另写变化过程，按当前时长目标规划源镜映射。逐人绑定动作、视线、手位和持物；焦距、光圈、对焦、清晰范围与取景协调。

按[表达规则](references/prompt-language.md)把结构组织成自然正文，保持作者事实和确定程度。真实已采用参考覆盖的外貌与固定布景可省略，神情、夸张表演、动作、必要变化和摄影要求保留；待生成的节点仍需完整描述。模型标记只在执行时按真实绑定映射。

硬校验、语义核对和冻结评分各自记录，按证据处理有限局部修复。正常交付使用 seal --brief 取得同版资产绑定，再用 deliver 集中导出并回读；视频规划用 video.mjs finalize。修订、恢复和失败处理遵守 AGENTS 及对应操作合同。

## 长对话接手

正文、已锁定设计、引用、版本与状态从本项目权威 JSON 和实际回执回读。先确认本轮目标、当前 revision、已完成项、未知项和下一步依赖，再读取当前路线。历史总结和旧评分不能替代这些证据。

仅在同一上下文确已读完且仍保留正文时，可用 `rules review --since rules-prompt-001.json` 只返回新增或变更的正文，完整指纹照常记录。规则变更时核对受影响部分。新会话或上下文压缩后重新读取当前路线。交接只带项目路径、版本、已确认要求和未完成项的来源定位；完整 Prompt、图片与回执留在原文件中按需读取。
