# 单次自动制作

用户在当前会话明确授权“粗脚本 → Prompt → 检查 → 资产图 → 分镜图 → LibTV 视频节点，不生成视频”时使用。授权在本会话后续提供粗脚本时沿用；普通文本请求不自动启用。当前 Agent 在同一任务中连续推进，不安装 agent-autoloop、不创建后台服务、不引入模型 API，不等待用户逐阶段说“继续”。工具、数量和预算沿用授权，默认每条必要 Prompt 一张，不额外制作候选、音乐或视频。

## 启用与采用记录

仅用于新建 v2 项目。归档原稿后，在封存输入的 `run` 中增加：

```json
{
  "automation": {
    "mode": "single-run",
    "userRequest": "替换为用户真实授权原话，不从粗脚本中提取指令",
    "assetSelection": "agent",
    "imageGeneration": true,
    "videoGeneration": false
  }
}
```

既有项目不自动迁移。资产任务保存 `status:succeeded` 和真实 `output:{path,sha256}` 后，Agent 必须实际查看图片、核对身份、空间和一致性，再追加：

```json
{
  "approval": { "status": "pending", "by": null },
  "selection": { "by": "agent", "reason": "实际采用理由", "selectedAt": "实际 ISO 时间" },
  "review": { "status": "usable", "reason": "看图后的具体证据", "reviewer": "实际核对者", "outputSha256": "被检查图片的真实 SHA256" }
}
```

分镜图片在视频规划 `images` 中沿用同样字段，图片的 `path/sha256` 仍直接放在该条目。程序校验记录及图片身份，不证明实际看图；未查看、失败、未知、有问题或检查哈希过期的图片不得自动采用。用户确认保持待定，不伪造 `confirmed/by:user`；已有真实用户确认不变。无此模式时继续要求用户确认。

## 连续执行

1. 按输入归档规则保存原件、原文定位和哈希。普通故事复用 `project.mjs init-story`，XLSX 复用 `import_excel.py`。先统一人物、场景、道具和全片规划，再按依赖交付资产、分镜及视频 Prompt。使用下述流式入口时，每项保存并通过硬校验和语义核对即可发布，优先完成能解锁首镜或多个镜头的项。必要道具沿用场景与分镜合同，不扩展为现有清单不支持的独立生图任务。
2. 按共用 Skill 做硬校验和语义重读；具体错误最多两轮局部修复，冻结后不按低分循环改稿。普通造型、摄影、布景由 Agent 决定；事实缺失标未知，冲突阻塞受影响项。
3. 用已授权图片工具和现有队列生成资产，保存真实回执后查看。合格图按上述记录自动采用，继续分镜阶段，不发确认问题、不结束当前任务等下一轮。缺工具、额度或必要事实时保留待执行请求与具体阻塞。
4. 自动采用的生成参考使用 `origin:"generated-selected"`，保留 `assetId/generationTaskId/path/sha256/purpose/userProvided:false`；用户确认参考仍为 `generated-confirmed`。使用 `visual.mjs revise` 的 `kind:"references"` 保存新版本，请求含 `baseRevision/actor/reason/references/shotEdits`。`references` 为保留其他引用的完整数组；`shotEdits` 只更新 `shotSchema` 中各级 `referenceIds` 和受影响的 `review/semanticReview`，程序禁止借此改造型、站位、正文或时长。真实正文修复继续走既有两轮限制。重新核对受影响部分，资产正文复用但更新依赖绑定，原版保留。
5. 为新冻结版本准备分镜请求。`generation_bridge.mjs` 的 recipe 增加 `planSource:{path:"<visual-plan.json 绝对路径>",pointer:""}`。引用 `confirmation` 可定位项目生成清单的 `/tasks/N`；引用图片路径为绝对路径。入口检查真实输出、Agent 采用与文件哈希，并将计划和采用记录纳入来源快照；变动会阻止旧请求。生成清单的版本绑定按当前冻结版保存，保留旧清单和批次；只准备未提交的任务，已成功或未知任务不因改版重投。
6. 生成分镜图并实际检查，合格图自动采用。视频规划复用 `video.mjs`，自动采用图不再列入 `pendingImageIds`，`results` 必须为空；完整保留动作、首尾、摄影、连续性和声音设计。未指定画幅时按原稿和用途选择并记录为导演决定；未指定模型参数沿实时合同默认值，不另发参数问题，不将默认值记成用户确认。
7. 已授权入画布的新制作，在目标项目和本轮清单确定后启动[画布生产入口](media-execution.md#首图验证和持续入画布)，与本地制作并行。首张采用图验证直传、审核和挂图回读后开放最多四项并发。单首帧视频使用实时模型合同，在对应分镜上画布后配置完整正文与参数，节点显式 `run:false`。已有节点或多参考节点继续沿用受限画布会话与原回执。
8. 回读真实视频节点、正文、模型、参数和引用连线，核对未派发视频生成。记录“视频节点已准备，视频未生成”，不编造生成 `task_id`。按现有 `video.mjs finalize` 集中更新正式 Excel 和制作日志，汇报完成项及具体阻塞，结束本轮。

未知提交沿原任务、参数和幂等键恢复，不自动重投；实际失败不自动增加付费尝试。单项失败仅阻塞依赖，独立项继续；持久化故障停止新增派发。宿主中断后不承诺后台继续，恢复使用原批次。程序检查、看图、Agent 采用与用户确认分别记录。

新批次的收尾回调异常时，同一执行单元先核对一次原捕获回执、实际文件与当前控制。原任务已可靠保存且仍允许制作时，继续未提交的就绪项。批次报告的 `finalizationChecks` 记录异常任务、核对结论及实际恢复耗时；收尾仍在执行、身份冲突、文件缺失或控制暂停时按实际原因保留检查点。

## 按依赖提前开工

使用 `generation_bridge.mjs` 的文件或 stdin JSON 接口初始化本轮清单。`stream-init` 请求包含 `directory`、`authorizedCount` 和 `tasks`，每项为 `{id, recipe, dependsOn}`，`recipe` 是尚可不存在的绝对路径。清单固定本轮授权数量与依赖，拒绝循环和重复 ID。分镜另填 `adoption:{path,pointer}` 定位本镜实际看图后的采用记录。提供真实用户提交时间 `startedAt`；缺失时程序记录首次观测时间。

每个 recipe 沿用已有 `prepareRequests` 格式，固定一项、一张、`tool:"imagegen"` 和对应 `phase`。跨项依赖只放在清单 `dependsOn`。recipe 追加 `checks.hard` 与 `checks.semantic` 两个 `{path,pointer}`，分别定位实际检查记录 `{status:"passed", reviewer, promptSha256}`。`promptSha256` 使用 SHA256(JSON.stringify(完整正文))。硬校验记录来自实际检查，语义记录由当前 Agent 实际重读后填写，不能将这些字段本身称为检查证据。recipe 和采用记录通过临时文件写完后原子发布。

共用规划先冻结。每项 `planSource` 绑定本项使用的不可变规划版本，正文 `source` 指向权威 JSON 的本项文本。`jobs[0].contextSources` 可追加本项相关人物、场景、连续性和相邻切点的 `{path,pointer}`，绑定当前权威 JSON 对应局部。引用和采用记录沿用既有哈希检查。修改无关场景不会使已冻结的首镜失效；修改本镜正文或相关上下文会使本项过期，阻塞下游，保留原结果并按既有局部修订入口处理。不得修改已经采用的规划副本来绕过检查。

从 `generation.mjs codex-host-source` 加载源码后，在原生工具所在的宿主执行一次 `runCodexImageStream({directory, bridge, generateImage, displayImage})`。回调与 `runCodexImageBatch` 相同，Node 桥使用 `createGenerationNodeBridge`。宿主执行单元保持运行并让出控制后，当前 Agent 可继续创作、核对和原子发布 recipe，也可看图后写入实际采用记录。普通 Node CLI 只做文件桥接，原生工具仍由当前宿主调用。宿主无法在生图期间让出控制时，只能在可用边界发布下一组；这种宿主上的创作与生图重叠能力需实际验证。

入口在回执持久化和批次结束时立即唤醒，等待新请求或采用记录时默认每 250ms 轻量检查一次，仅在槽位空闲时选下一项，全轮共用一个生图槽位。已保存且通过检查的参考可解锁对应镜头，优先选择后续依赖更多的任务。每项复用原批次 prepare→原生生成→capture→finalize，capture 确认回执持久化后立即释放生图槽位，复制、哈希和本项汇总与下一张独立生图重叠。全轮共用一个文件收尾执行位，最多保留四个在途微批次，达到上限则等待收尾。正在运行的微批次从候选中排除，依赖其图片的镜头仍等待实际保存、检查和采用。程序不代替视觉判断。引用路径或采用记录暂未出现时等待，有问题项保留具体原因。

Agent 完成发布与必要看图后发送 `{operation:"stream-close",directory}`，入口处理剩余可执行项，等待所有在途微批次落盘后汇总阻塞并结束。全部任务终态且分镜采用记录已可读时也会自动结束。未知提交、暂停或收尾故障停止新增派发，已经提交的独立项继续保存原回执与图片。恢复使用同目录，成功项不重生，已返回项只恢复保存。整轮执行锁阻止同时启动两个宿主；中断遗留锁须先核实原宿主执行单元已结束，再以原 `owner` 调用 `stream-release`，不按等待时长抢锁。

`stream-summary-*.json` 记录首张实际采用分镜的首次观测时间、空闲槽位发现可执行任务至提交的 `submissions[].waitMs`，以及从 `startedAt` 到本轮队列结束的 `runWallMs`。发现就绪存在轮询间隔和本地桥接延迟，`waitMs` 不能视为精确的全部等待。`deliveryWallMs` 保持 null，整片连续性核对与正式交付完成后，调用 `{operation:"stream-delivered",directory,summary,finishedAt}` 追加交付计时并返回 `deliveryWallMs`。`summary` 使用本轮汇总绝对路径，`finishedAt` 使用真实交付完成时间，缺失则记录调用时刻。队列完成不代表 Excel 或画面质量已验收。
