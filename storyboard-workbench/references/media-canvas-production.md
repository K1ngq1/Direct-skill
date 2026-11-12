# 首图验证与持续入画布

执行前遵守[媒体共用边界](media-execution.md#共用执行边界)。本文件仅在对应操作被本次用户授权时读取。

本入口复用[画布会话](media-canvas-session.md)和[原生传输器](media-transfer.md)；接入时读取这两份合同。原返回保存、审核或未知写入问题再读[画布恢复](media-canvas-recovery.md)。

### 首图验证和持续入画布

单次自动制作的新批次使用 `node storyboard-workbench/scripts/libtv_canvas_production.mjs host-source`。在有原生 MCP 工具的执行单元一次载入源码，运行 `runCodexCanvasProduction`。本地生图和看图可同时推进。首图沿正式上传路径走完全程；其图片节点及资源 ID 回读通过后即可处理其余图。画布或授权故障保留在本次画布摘要中，本地独立制作可继续。

```js
// source 是上一命令完整的 UTF-8 标准输出。spec 取自本轮冻结的项目输入。
const runCanvas = new Function(source + '\nreturn runCodexCanvasProduction;')();
const result = await runCanvas({
  ...spec,
  call: (name, args) => {
    const invoke = tools['mcp__libtv__' + name];
    return invoke(args);
  },
  transport: { nodeExecutable, assetsScript, directory: receiptDirectory,
    execCommand: tools.exec_command, writeStdin: tools.write_stdin }
});
text(result);
```

- `projectId` 为目标 LibTV 项目；`projectDirectory` 为本地项目绝对路径，`planFile` 为冻结的单次制作计划，`closedFile` 为本轮看图发布完成标记（可使用同一轮的 `closed.json`）。可传用户真实提交时间 `startedAt`，缺失时从首次观测计时。每一轮用专属目录和完成标记。只在本轮看图全部处理完毕或确定余项待处理时发布完成标记。恢复沿用原清单、项目、传输入口、目录及键。
- `sources` 每项含 `{id,name,uploadKey,path,pointer}`，可附画布坐标 `x/y`。`path/pointer` 指向项目内按既有合同保存的图片生成或视频采用记录；根对象的 pointer 为空字符串。图片路径相对该记录文件解析。源文件原子发布，记录可以陆续出现。资格时间取真实选择或用户确认时间。待修、未知和指向不同哈希的文件进入问题清单。发布结束后，仍缺失的记录列为阻塞。
- 有单首帧视频的图片另附 `videos:[{id,args}]`。args 保存已核对的项目、幂等键、模型、完整 Prompt、参数、节点位置以及 `nodeType:"video",run:false`；首帧取实际挂图节点，不预填 nodeId。正文中的 `{{START_FRAME}}` 在提交时替换成真实节点引用，省略时将真实引用置于完整正文前。多个节点可复用同一已验收首帧。模型变更须重新核对实时输入合同。多参考、起止双帧继续走原节点入口。
- 上传的正常路径共用一个持锁 stdio 进程。首图和后续图使用相同 curl、代理环境与回执目录。合法 DNS 恢复项显式设 `recoverDnsFailure:true`；仅允许原单片票据已有 exit 6、HTTP 0 证据的情形。审核恢复沿用原上传身份设 `recoverReview:true`。入库独立项已获继续授权时传 `independentJobs:true`。
- 本轮需要正式工作簿时给 `spec.workflowFile` 填本地项目内的视频规划输入路径。收齐看图结论、可用节点通过批末回读后，入口通过既有封存与 Excel 导出程序一次交付。已封存的同版输入须逐项一致才允许恢复导出，原有排版、反馈、冲突处理和文件回读沿用共享合同。画布待恢复时保留原工作簿；规划尚未就绪时记录 excel 阶段的缺口，可从原回执恢复。只做画布的任务省略该字段。
- 返回 `issues/remaining` 标明待处理项，`verified` 表示已列入摘要的节点通过本轮批末回读。`readback` 提供画布版本与数量，Excel 另以 `excel.exportsUpdated` 和 `excel.acceptance` 验收。私有 `canvas-summary-*.json` 记录总墙钟、首张采用至挂图、最后采用至画布回读的毫秒数和图片数量。缺少时间证据时对应值为 null。生图停派至恢复的实测值取自同批 `finalizationChecks`；并行阶段不相加。
