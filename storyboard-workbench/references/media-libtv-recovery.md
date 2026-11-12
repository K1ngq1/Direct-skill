# LibTV 原任务恢复与文件交付

执行前遵守[媒体共用边界](media-execution.md#共用执行边界)。本文件仅在对应操作被本次用户授权时读取。

仅接手已授权的原任务；新生成的正常接入见[LibTV 生成](media-libtv-generation.md)。

### 已有任务恢复与可选图片交付

只有旧任务 ID 时使用恢复计划 `{id,count:1,projectId,existingTaskId,outputNodeId?}`，不补造原 Prompt 或提交参数。此分支与 submitTool/submitArgs 互斥，所有开关组合下都不会提交；首次查询前持久化原 ID，重启继续查询同一任务。outputNodeId 仅校验实际产物，不能替接口构造成功结果。准备、查询、回执和收尾耗时进入内部 summary.events；服务端排队及生成耗时无真实证据时仍为未知。

2026-10-27 对已有任务实测返回 `TASK_CONTEXT_UNAVAILABLE`。调度保留该错误码与原 ID，不把节点的历史 status=2 映射成当前 Task 成功。此时可独立交付已绑定图片，但任务状态仍为 unknown。

以下图片交付只在用户需要本地文件时接入，不是批量提交的前置步骤。`libtv_delivery.mjs` 的 `runLibTVImageDelivery(job, callbacks)` 使用真实观察到的 read_node 与 prepare_project_delivery 响应合同。job 为 `{id,projectId,taskId,nodeId,idempotencyKey,watermark}`；仅单张 PNG/JPEG/WebP 图片。callbacks 的 readReceipt/writeReceipt 复用 `createLibTVReceiptStore`，saveImage 复用 `saveLibTVImage`：

```js
const deliveryStore = createLibTVReceiptStore(receiptDirectory);
const result = await runLibTVImageDelivery(deliveryJob, {
  ...deliveryStore,
  call,
  saveImage: item => saveLibTVImage(outputDirectory, item, { decodeImage })
});
```

`decodeImage(path)` 必须完整解码文件，返回 `{width,height,format}`，不能只读文件头或 metadata。宿主已有 sharp 时可用 `sharp(path,{failOn:'warning'}).raw().toBuffer({resolveWithObject:true})` 强制解码，格式另从 metadata 获取；不为此新增依赖。saveLibTVImage 校验 HTTP、字节长度、SHA256、完整解码和无覆盖保存，validated 检查点先于正式文件公布。重启核验已保存文件后复用，不再次下载。sourceIdentity 是来源身份，不能用作文件字节哈希；contentHash=null 时由宿主实际计算。

请求先持久化，响应先私下保存再解析。needs_preference 时只询问一次 keep/remove，沿用原键，且不修改账户设置；已开始处理后禁止换选择。ready 清单须绑定精确项目、任务、节点与单张输出。未知准备只查询原 get_web_operation_status；仅操作完成但没有完整授权清单时继续保留未知，不重复准备、不拼造清单、不回退节点 URL。ready 后下载失败仅恢复保存；saved 后重新核验本地文件，零远端调用。远端文件名不作为本地路径；签名链接与原始回执只留在私有项目目录，不进入公共 Skill、摘要或通用测试。

在生成调度的 finalize 中，从已核实的 receipt.taskId 与 outputs[0].nodeId 构造 deliveryJob，并要求 result.state=saved 后返回 result.files。`node libtv_delivery.mjs host-source` 可将同一入口加载到宿主，文件边界继续用[图片文件桥接](media-image-batch.md#prompt-阶段准备与-node-存储入口)。Task 成功响应仍须有本部署实际证据的 normalizeTask；已有节点和交付清单均不能替代该映射。

### 恢复、暂停与自动收尾

| 检查点 | 默认行为 |
|---|---|
| 无记录 | allowNewSubmissions 默认 false，不提交新任务 |
| submitting/unknown，无 taskId | 不重投；明确开启 recoverUnknownSubmission 才以原工具、原键、原参数恢复 |
| pending/unknown，有 taskId | 只查询原 task_status，不调用生成入口 |
| generated | 批量模式直接复用远端产物引用；传 finalize 时只恢复文件收尾，不重新查询或提交 |
| succeeded | 核对实际文件后复用，零生成、查询及保存调用 |
| failed/cancelled | 保留终态，不自动补图 |

提交前独占登记并 fsync，收到 taskId 立即落盘；状态变化才追加回执，不反复保存相同 pending。缺失检查点、身份冲突或持久化失败阻止新提交，尽可能在本轮小交接中保留已收到的任务身份。恢复时重开同一 store 后调用同一 runner，不换批次或键伪装恢复。

批次使用单协调器进程锁，记录实际 owner、PID、主机名与认领时间；锁路径现为目录，只有成功移除本 owner 记录的调用才能移除空目录，旧 release 不会删除新 owner 的锁。永久挂起但进程仍存活时禁止抢占，不按时间或本地 deadline 过期强行解锁。

原进程已退出后，使用下面的显式恢复入口；它只接受本机确证不存在的原 PID、精确旧 owner 和非空理由。恢复决定同时写入本项目制作日志，再重开同一冻结批次；这一步不触发生成：

```js
const held = store.inspectLock();
store.recoverLock({ owner: held.owner, reason: '已核实原执行器退出，继续原任务回执。' });
// imagegen 文件收尾：batchStore.inspectFinalization(id) / batchStore.recoverFinalization(id, {owner,reason})
// LibTV 文件保存：createLibTVImageLock(outputDirectory,id).inspect() / .recover({owner,reason})
```

活进程、PID 权限不足、其他主机、记录损坏、空目录或旧格式文件锁均拒绝自动恢复；旧格式不原位迁移。不能手删锁目录绕过检查。若宿主仍有未结束的异步回调，应先让原执行器结束；恢复只解锁原任务的查询或文件收尾，不把 unknown 改成可重新生成。

setControl({paused:true}) 停止新提交，已受理任务按原 ID 排空；暂停或版本/阶段变化时不发布交付链接。并发下调只影响后续认领。轮询次数有上限，到达后保存 pending 并自动汇总；pending 或受理未知不能当作空槽，本轮停止新增派发。启动时先读取小 snapshot，若已有 submitting/pending/unknown，本次仅恢复旧任务；旧任务终态明确后再从同一批次推进剩余新项，避免重启把远端在途量叠加。轮询间隔按服务要求设置。队列排空后在同一调用生成索引，只返回紧凑交接，不返回完整请求或工具载荷。

peakOutstandingCalls 只统计在途 MCP 调用；observedToolExecutionPeak/serverExecutionPeak 保持 null。没有正式服务端起止字段时，不能用四个 taskId、同时 pending 或 mock 宣称四路计算。免费维护验证命令：

```text
node --test storyboard-workbench/tests/libtv-generation.test.mjs storyboard-workbench/tests/libtv-generation-store.test.mjs storyboard-workbench/tests/generation-pipeline.test.mjs
```

测试仅使用模拟 MCP 和临时文件，不触发真实生成、上传、下载或扣费。

`runLibTVGenerationBatch` 与 `runLibTVImageDelivery` 的本地回调使用 `localTimeoutMs`，默认300秒，避免比可选下载的等待预算更短。读取、解析与写入、收尾、汇总、认领、解锁均有期限。写入或收尾回调超时后停止新副作用，批次返回 `incomplete:true/persistedSummary:false` 的身份交接，暂不发布交付链接；原回调真正结束前保留协调器锁，不能强删锁后重跑。认领或解锁超时时物理锁状态可能未知，以 `ownershipUnknown` 为准。只有在原副作用都结束后才按原 owner 尝试释放；进程退出或宿主结束当前隔离执行单元后，不能假设后台清理仍会执行。

图片文件保存持有按实际输出目录和任务 ID 创建的进程锁；下载即使忽略 abort，或解码仍未真正结束，都不能释放该锁。`saveLibTVImage` 的 `downloadTimeoutMs` 默认120秒，完整解码的 `localTimeoutMs` 默认30秒。下载字节 fsync 后、调用解码前先保存 `image_downloaded`；原进程退出后可核验并复用，不重复下载。正式图片在验证和持锁检查后原子发布，发布前后中断均保留可恢复状态。

独立 `runLibTVImageDelivery` 可提供完整的 `acquire/release/assertOwner` 持久锁桥，三者必须同时提供；可复用[进程锁模块](../scripts/process_lock.mjs)。readReceipt 和 saveImage 的最后一个参数为 context，writeReceipt 的 options.context 也包含本轮令牌；自定义回调须在实际写盘时 assertOwner(context)，不只在开始等待前检查。report.persistentOwnership 表示本次是否接入持久锁。没有这组桥的旧调用仍仅有同一运行域的内存保护，不宣称跨进程安全。异步期限不能终止同步阻塞的 JS 回调，也不证明宿主 HTTP 或服务端任务已取消。
