# LibTV 图片生成调度

执行前遵守[媒体共用边界](media-execution.md#共用执行边界)。本文件仅在对应操作被本次用户授权时读取。

原任务恢复、文件交付及本地回调异常按[LibTV 恢复与交付](media-libtv-recovery.md)。只准备待运行节点时使用[画布会话](media-canvas-session.md)。

## LibTV 生成调度与断点恢复

生成使用 [libtv_generation.mjs](../scripts/libtv_generation.mjs) 的 `runLibTVGenerationBatch`，本地状态使用 [libtv_generation_store.mjs](../scripts/libtv_generation_store.mjs) 的 `createLibTVGenerationStore`。复用共用有界 worker 与控制校验，不把素材入库脚本当成生成调度。默认最多四个在途任务；用户只需批量提交时省略 finalize，权威任务成功且原始产物引用落盘后立即补位，依赖按远端 generated 解锁，不下载、不处理水印、不上传。仅收到 task_id 或任务仍 pending 不算完成，不能因此释放远端容量。

用户另行需要本地文件时才传 finalize，沿用单路文件收尾和最多四个待收尾结果，依赖等前项实际保存成功后解锁。两个模式使用同一队列与原回执，不建立第二套批量提交实现。

**网络边界：**脚本仍调用官方 MCP，不绕过代理、OAuth 或服务端队列。参考上传一次后使用真实节点引用，大文件使用官方上传票据和交付清单；控制上下文只接收任务 ID、计数和索引。读取工具声明时只取本次需要的部分，避免每次重复打印全部工作流摘要。

### 冻结与宿主接入

先按当前 LibTV 流程核对身份、精确项目、实时模型 schema 和引用，一批复用有效发现结果。新批次目录必须为空，输入 jobs.json 放在目录外；重开使用同一冻结输入，不能由队列重新拼 Prompt 或猜测节点。

```js
const store = createLibTVGenerationStore(batchDirectory, frozenJobs, {
  batchId, version, phase: 'scenes', projectId, concurrency: 4
});
for (const name of new Set(['task_status', ...frozenJobs.map(job => job.submitTool).filter(Boolean)])) {
  if (typeof tools['mcp__libtv__' + name] !== 'function') throw new Error('当前宿主未注册 LibTV 工具：' + name);
}
const summary = await runLibTVGenerationBatch(store.jobs, {
  ...store,
  run: executionRun,
  call: (name, args) => {
    const invoke = tools['mcp__libtv__' + name];
    return invoke(args);
  },
  normalizeTask, // 依据实际响应合同编写并离线验证的纯函数
  allowNewSubmissions: true, // 仅本次已明确授权生成时开启
  recoverUnknownSubmission: false,
  maxPolls: 20, pollIntervalMs: 3000, callTimeoutMs: 120000, localTimeoutMs: 300000
});
text(summary);
```

`tools` 由宿主提供，不是独立 Node CLI。LibTV 使用其原有存储接入；若宿主 node_repl 不提供 process，须由正常 Node 进程执行文件锁操作，不直接构造 store。仅返回 batch/jobs 调度元数据，并桥接 `acquire/release/snapshot/prepare/writeReceipt/readControl/acknowledgeControl/summarize`。`node storyboard-workbench/scripts/libtv_generation.mjs host-source` 输出同一调度函数，供 functions.exec 加载。整批在一个执行单元完成，不把每次状态查询拆成模型往返。完整请求仅 prepare 时传入执行器，不打印回主对话。

所有协调器桥接须透传本轮捕获的 context，不能在晚到回调执行时改取 store 的当前 owner。认领为 `acquire(context)`，解锁为 `release(context)`；实际锁令牌以 acquire 返回的 owner 为准，每次认领重新生成，输入 owner 仅关联原请求。其他签名如下，旧函数忽略额外参数的行为保留；真实 store 的协调写入会拒绝缺失、过期或不匹配的 context：

```js
readControl: context => nodeCall('store.readControl(' + JSON.stringify(context) + ')'),
snapshot: context => nodeCall('store.snapshot(' + JSON.stringify(context) + ')'),
prepare: (id, context) => nodeCall('store.prepare(' + JSON.stringify(id) + ',' + JSON.stringify(context) + ')'),
acknowledgeControl: (control, context) => nodeCall('store.acknowledgeControl(' + JSON.stringify(control) + ',' + JSON.stringify(context) + ')'),
writeReceipt: (id, value, options) => nodeCall('store.writeReceipt(' + JSON.stringify(id) + ',' + JSON.stringify(value) + ',' + JSON.stringify(options) + ')'),
summarize: (results, report, context) => nodeCall('store.summarize(' + JSON.stringify(results) + ',' + JSON.stringify(report) + ',' + JSON.stringify(context) + ')')
```

writeReceipt 的 options 包含原 exclusive 及 `context:{owner,deadlineAt}`；可选 finalize 的第三参数为同一 context，自定义持久化须在真正写入前再次验证。无参纯读取仍可用于诊断，setControl 仍是独立的用户控制入口。一旦 store 已参与协调，不能在解锁后用无 context 的旧回调重新写入。

`callTimeoutMs` 独立限制每次提交、查询或交付 MCP 调用，默认120秒；`maxPolls` 仍只限制查询次数。远端超时保留原任务 ID 或受理未知状态，停止新增派发，汇总已完成项；晚到响应不续写本轮回执。云端产物模式只检查 `toolUse`，不会因缺少本地文件能力被错误禁止。

每项任务为 `{id,count:1,dependsOn:[],submitTool,submitArgs}`，两种入口都原样透传：

- `submitTool:'create_node'` 使用宿主核实的图片节点请求：精确 projectId、唯一稳定 idempotencyKey、nodeType=image、run=true、完整 name/prompt、按实时 schema 验证的 params，明确 params.count=1。引用用真实 left/right 节点，不在 params 中伪造媒体列表。2026-10-27 工具公开参数为 unknown，不能再把本地接受字段宣称为完整线上类型契约。
- `submitTool:'generation_submit'` 使用本次实际公开的 project_id、idempotency_key、kind=image 和 request={model,prompt,params}。新计划须有非空 prompt，params.count=1；实际模型参数仍按 get_model.inputContract 核验，不推导 provider 或媒体列表。历史冻结请求只按原键原参数恢复，不自动重写。2026-10-27 只读取得 nebula-ultra 的实时合同，确认 count 允许1/2/4；本地单张任务明确取1，不以此代表已真实提交验收。
- 返回 task_id 后统一查询 `task_status({project_id,task_id})`；cop_ 仅是画布回执，不能用作媒体任务身份。提交成功不等于生成完成。

task_status 同样未公开完整响应结构，必须提供 `normalizeTask(response,{projectId,taskId,count})`，依据实际部署证据映射到本地合同 `{projectId,taskId,state,outputs}`。state 只接受 pending/succeeded/failed/cancelled，outputs 每项只保留 nodeId/resourceId/fileRef，成功数量必须等于授权数量。该映射不能猜测未认识的状态，不能把 HTTP200、节点创建或链接存在视作成功；缺少已核实映射时停止接入。可识别的提交 task_id 先落盘，即使后续解析失败仍保留原任务。离线 mock 只证明本地合同和调度。

`finalize(job,receipt)` 消费原任务引用，通过 prepare_project_delivery 取授权清单，再保存文件并返回绝对路径与实际 SHA256，遵守当前水印、会员和审核规则。存储重新核对数量、类型与哈希；下载或保存失败保留 generated，下次只恢复交付。完整解码由[图片保存入口](media-libtv-recovery.md#已有任务恢复与可选图片交付)校验，画质审核与用户确认另行记录。
