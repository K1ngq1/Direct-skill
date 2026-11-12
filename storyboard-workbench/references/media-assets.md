# LibTV 资产库接入

执行前遵守[媒体共用边界](media-execution.md#共用执行边界)。本文件仅在对应操作被本次用户授权时读取。

首次接入时同时读取[原生传输器](media-transfer.md)。此流程用于资产库目录，直接挂图使用[画布会话](media-canvas-session.md)。

### 资产库接入

使用 [libtv_assets.mjs](../scripts/libtv_assets.mjs) 复用同一并发队列。开始时发现精确项目和目录、读取已有内容索引并处理分页；目录先建立一次，同目录的创建或更新不并发争写。

本地准备使用 `prepareLibTVAssets(projectDirectory, items, {projectId,scope})` 计算真实文件哈希与稳定键，`items` 包含 `{id,name,path,folderId}`。`createLibTVReceiptStore(receiptDirectory)` 提供逐阶段文件回执，由普通 Node 进程执行；不要经 `node_repl` 逐项读取或保存。文件和目录必须是本次获授权目标。已提交的历史批次沿用原键，不重新运行 prepare 推导替代键。不要从普通节点名或任意数字推断目录 ID。

`node storyboard-workbench/scripts/libtv_assets.mjs host-source` 输出完整的同一发现及流水线函数，可按[图片批次的宿主方式](media-image-batch.md#codex-固定执行入口)载入 `functions.exec`。宿主只注入工具和文件边界：

```js
const call = (name, args) => {
  const invoke = tools['mcp__libtv__' + name];
  return invoke(args);
};
const results = await runLibTVAssets(preparedItems, {
  concurrency: 4,
  call,
  discover: context => discoverLibTVAssets(context, call),
  transfer,
  readReceipt,
  writeReceipt
});
```

`discoverLibTVAssets` 已实现目录预读和资产分页，不另写逐张搜索循环。`readReceipt(item,stage)` 与 `writeReceipt(item,stage,value,options)` 通过[小 JSON 文件桥接](media-canvas-session.md)调用存储对象，传本地已准备项的 ID，不反复传整批数据。`transfer(item,ticket)` 由宿主将本地原字节 PUT 到本次票据的精确签名地址，完成后返回 `{status:<HTTP状态码>,bytes:<实际长度>,sha256:<实际字节哈希>}`；不得把发起上传或 HTTP 失败记成成功。传输所用文件须核对准备时的哈希；签名地址、审核和 Resource 全部沿用原票据及回执，不构造私有 API。

- 先对实际文件计算内容哈希，按当前授权空间、项目与目标目录核对既有资产。本批相同内容只入库一次；名称相同不能证明内容相同，不同目录归属也不能自行猜测。
- 资产间有界并发；同一资产按上传凭据、传输、完成上传、审核及挂图、读取源版本、入库、详情回读的依赖顺序推进。不能并发同一资产的依赖步骤，也不能用一个资产的回执推进另一个资产。
- 幂等键从项目、内容与目标身份稳定派生，不手抄。每阶段保存小回执，后续从原回执恢复；不把累积 ledger 或图片 base64 塞进命令行，不为每张图重查整张画布或全部目录。
- MCP `isError`、审核待处理、审核拒绝及未知写入分别记录。未知写只按原 task/operation/幂等键恢复，不换键创建。入库成功后按接口要求读取一次资产详情，核对持久身份和版本；缓存可用于后续本轮步骤，不能冒充跨任务最新状态。

工具方法与返回字段以本次实际 MCP schema 为准。宿主注入工具调用与文件传输；本地模块不绕过 MCP 另接私有 API。独立资产失败不阻断已就绪的其他资产，但来源、空间、版本及实际原件校验保留。
