# 画布上传与待运行节点

执行前遵守[媒体共用边界](media-execution.md#共用执行边界)。本文件仅在对应操作被本次用户授权时读取。

只有本地文件需要上传时读取[原生传输器](media-transfer.md)；仅创建和连接节点时沿用本文件受限会话。回执冲突、未知写入、审核待处理或保存失败时读取[画布恢复](media-canvas-recovery.md)。

### 仅上传画布及建立待生成节点

此路径复用 `libtv_assets.mjs` 的存储与 `media_batch.mjs` 队列，使用 `createLibTVCanvasSession({projectId,bridge,call,paused:true})`。工厂不调用远端，默认暂停；用户明确恢复后才 `setPaused(false)`。不能套用要求资产库目录的 `runLibTVAssets()`，也不能把 `run:false` 节点交给图片生成 store。完整源代码仍由 `libtv_assets.mjs host-source` 提供，宿主只注入文件桥接和正式 MCP 调用。

新批次的文件传输使用[原生 curl 入口](media-transfer.md)：`savedCall('upload_ticket', ...) → transfer(item,ticket) → savedCall('upload_complete', ...) → savedCall('upload_media', ...)`。前一步失败时不执行后一步；传输回包必须 `ok:true` 且完成证明已保存。四路就绪任务在一个协调器内自动推进，模型只接收最终汇总与必要异常。

文件桥接输入只走 UTF-8 请求文件或标准输入，正文不插入 shell 命令：

```text
node storyboard-workbench/scripts/libtv_assets.mjs receipts "<request.json>"
node storyboard-workbench/scripts/libtv_assets.mjs receipts --stdio "<receipt-directory>"
```

单次请求返回 `{ok,value}`；失败返回 `{ok:false,error,code}` 并以非零退出。stdio 每行一个请求，回包带原 `requestId`，`close` 释放本进程锁退出。该进程只服务本批本地存储，不建立网络服务。Windows 宿主若普通管道立即 EOF，应使用 `tty:true`；TTY 回包将 UTF-8 JSON 编码为 base64，以 `~B64` 加48个字符分段、`~END` 结束，避免 ConHost 换行及行尾空格丢失改变正文或回执身份。`~MORE` 后只发送 `{"operation":"drain"}` 取原响应剩余部分，不重发业务请求。去除终端控制符后拼接 base64 分段，完整解码 UTF-8 后再解析 JSON；旧 `~DATA` 仅保留读取兼容，禁止把截断或部分回包当成功。TTY 写入成功只返回 `saved/receiptSavedAt/receiptSaveMs`，宿主用原 value 加该保存时间恢复回执对象，避免重复传回完整 Prompt。

| operation | 输入与结果 |
|---|---|
| snapshot | `{directory}`：一次读取回执，返回 `{receipts:{key:receipt}}`；不把计划正文和图片带回主对话 |
| read | `{directory,key}`：仅用于按需核对、保存应答丢失恢复；不存在返回 null |
| write | `{directory,key,value,expected,exclusive?}`：比较原记录后原子保存，冲突停止；返回保存证据 |
| verify | `{directory,items:[{id,path,size,sha256}]}`：一次核对冻结原件长度和哈希，不调用媒体工具 |

key 沿用原文件名去掉 `.json`，例如 `S01.ticket`、`S01.complete`、`S01.upload`、`S01.upload.error`。原错误文件只读，后续错误及原状态在新回执历史中保留。直接模块调用仍保留旧 `createLibTVReceiptStore()` 签名；CLI 写操作及批次 stdio 共用进程锁，持锁、未知 owner 或目录冲突不强制清除。

仅允许上传、完成上传、挂图、创建节点和创建分组；节点调用必须显式 `run:false`，生成、升级及导出执行工具均被拒绝。审核通过、文件成功、画面检查、用户确认仍分别记录。批次结束集中回读真实节点/资源/连线，不因工具返回 completed 就省略交付核对。

用户要求整批异步推进时，一次冻结全部上传与节点任务，在同一执行单元调用 `runConcurrentJobs(jobs, worker, {concurrency:4, dependsOn:job=>job.dependsOn})`。每项使用唯一 `id`；节点依赖真实上传任务，后续说明依赖相应节点。调度器只让就绪项占槽，先完成的上传可立即解锁其节点，不等整批图片收齐；单项拒绝只阻塞其依赖，结束时集中汇总一次。依赖不存在、重复身份或循环会在任何调用前拒绝。

这是客户端的有界异步编排，不是服务端批量接口：每张图片仍按票据、字节上传、完成上传及审核挂图的顺序执行。当前宿主执行单元被中断后不承诺继续后台调度；恢复使用已保存的同一批次，而不是重新提交整批。进度只给紧凑计数，完整结果在批次收尾时回传；文件哈希仅在冻结与实际传输边界核对，不逐次MCP调用重读原图。
