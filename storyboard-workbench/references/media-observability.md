# 媒体计时与离线验收

执行前遵守[媒体共用边界](media-execution.md#共用执行边界)。本文件仅在对应操作被本次用户授权时读取。

仅在计时分析、性能验收或维护对应脚本时读取；具体媒体执行使用任务索引选择入口。

### 计时与 mock 验收

事件用 UTC；存储侧 preparedAt/capturedAt/savedAt 含单调时间与 clockId，跨进程重启不相减。prepareMs/finalizeMs 是本地单调耗时。宿主缺少单调时钟时明确 durationSource 为 utc-estimate；服务端接收及排队时间为 null。旧 submittedAt 保留，不当作服务端开始时间。nextSubmissionAfterCaptureMs 是回执后至下一次工具提交的观测间隔，不是服务端排队时间。summarize 在批末增加一次桥接，重新核对成功文件和当前控制，保存独立汇总，不重写历史。

`peakOutstandingCalls` 表示尚未完成的工具调用峰值，旧 `peakGeneration` 为兼容保留同值；两者不能证明模型同时计算了几张。实时队列的 `observedToolExecutionPeak` 保持 null。可离线执行以下只读命令，按会话中 imagegen Extension 的真实起止区间计算观测峰值，不调用媒体工具：

```text
node storyboard-workbench/scripts/generation.mjs audit-execution "<rollout.jsonl>" "<turnId>"
```

未指定 turnId 时读取最后一轮。输出只含任务身份、时间和执行区间，不回传 Prompt、图片或凭据。无事件时峰值为 null；事件区间有重叠才表示宿主可观测执行并发，服务端计算峰值仍为 null。不能将某次观测为1推广成 imagegen 永久上限，也不能将四个挂起 Promise 或 mock 并发宣传为四图同时生成。宿主执行串行时先处理上下文与回执瓶颈，保留通用四槽供其他有并发能力的工具；未经新授权实测不宣称改槽能提速。

运行 `node --test storyboard-workbench/tests/generation-bridge.test.mjs storyboard-workbench/tests/generation-pipeline.test.mjs storyboard-workbench/tests/generation-batch.test.mjs`，只用 mock 与临时图片。16项比较桥接、控制调用、补位、积压、槽位利用率和总耗时；关键断言为“其余三张未返回、首张仍收尾，第五张已提交”。mock 不证明真实容量或提速，真实压测另需任务数与预算授权。

明确启用[单次自动制作](single-run.md)的 v2 项目，资产实际看图通过后由 Agent 采用并继续，用户确认保留待定；视频只走待运行节点交付，不走生成队列。未启用时沿用用户确认要求。

批次 report 和汇总 timing 增加 `returnToCaptureMs`（工具返回到持久化回执回调结束），沿用 `nextSubmissionAfterCaptureMs`（回执回调结束到下一次工具调用）和 `batchWallMs`；本地单调耗时、宿主 UTC 与 GPU 时间继续分开。查看预览不是计时结束条件。下一次实际授权制作时核对前两项 P95，目标分别为10秒、5秒；缺失样本记未知，依赖等待、暂停和未返回任务单列，不伪称实测达标。端到端墙钟、人工介入、可用图数和返工量另记；不得把并行耗时相加或拿离线 mock 速度承诺生产提速。LibTV 暂不纳入本次图片提速验收，不为测速追加生图。

计时保留 `startedAt/toolStartedAt/toolReturnedAt/receiptSavedAt`。`toolWaitMs` 与 `receiptSaveMs` 是分项累计；`elapsedWallMs` 是会话墙钟，`wallMs` 扣除显式暂停时段。等待用户时先暂停；没有记录的等待不能擅自扣除。宿主无单调时钟则标 `utc-estimate`，不把在途 MCP 数当作远端生成并发。模拟验收运行 `node --test storyboard-workbench/tests/libtv-receipts.test.mjs`，不消耗媒体额度。
