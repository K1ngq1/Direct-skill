# 图片批次暂停与恢复

执行前遵守[媒体共用边界](media-execution.md#共用执行边界)。本文件仅在对应操作被本次用户授权时读取。

按原批次和原身份核对。正常图片执行见[图片批次](media-image-batch.md)。

### 阶段切换、暂停与恢复

每批只运行一个协调器。用户改变目标时，宿主先调用 `batchStore.setControl({paused:true})`，或 `setControl({version:'v2',phase:'characters',paused:false})`；不能只写自然语言备注。第二参数可传 `{receivedAt:<真实收到指令的UTC时间>}`，否则记录控制入口收到时间。降低并发用 `setControl({concurrency:2})`，不取消在途任务。新版本/阶段使用新批次目录。

控制使用独占短锁和追加的 control-00000001.json 等文件，保留历史；锁冲突或控制不可读时失败关闭，不强删锁。prepare 在认领及准备提交时检查控制；宿主观察控制后，在同一事件回合通过闸门调用工具，旧准备结果不能越过已生效的暂停。control-observed 文件记录 receivedAt、observedAt、effectiveAt。控制请求写入只证明收到，调度器确认后才表示生效；不能声称撤回已有请求。

重新初始化同一冻结批次并传 snapshot() 恢复：成功输出核验后复用；returned 仅恢复本地收尾；存在 claimed/submitting/submitted/pending/unknown 时不新增提交，但已有 returned 仍可收尾，已保存项仍可交付。failed/unknown 和保存拒绝不自动重试。新旧 store 均提供 snapshot，展开 store 且未显式提供 initialStates 时，调度器在任何新认领前自动读取一次；跨宿主传输则使用本次读取的 initialStates。自定义旧回调须传 snapshot 或 initialStates 才能获得跨运行容量保护。快照须为普通对象，任务身份和状态须匹配；相同尝试只接受完全一致的重复真实回执。相同 Prompt 的不同任务不错误合并。已有原图但保存被拒绝的任务同样不得重生或自动重试保存。核实原保存失败原因已解决后，可显式调用 finalize(id,{recoverSave:true})；仅恢复 unknown/stage:save，锁内将旧失败记录追加到事件历史，再从原 capture 保存。

report.deliveryAllowed 为 false 时不交付旧阶段结果；为 true 时，写 Excel 前仍须核对最新控制版本与用户文字。新宿主默认流水线，旧批次继续旧入口。回滚先暂停、等生效、核对在途与回执，再切入口；v2 批次不能交给 v1 存储重开，未知或暂停项不无条件重新入队。

图片工具等待默认 `callTimeoutMs:300000`，Codex 本地桥接及汇总默认 `localTimeoutMs:120000`，均为可配置的正整数毫秒。工具超时只结束本地等待，不能证明宿主 HTTP 或远端生成已取消；停止新增提交，让已完成项继续保存并汇总交付，当前阶段仍须允许交付。晚到 Promise 不再改变本轮状态。超时不是终态工具回执：v2 存储仅追加 `wait-expired` 事件并保留原 submitting 请求；之后取得同一原任务的真实回执时可 `capture/finalize`，不能重新生图。旧 v1 存储将超时观察独立保存在 claims，原件回执可通过旧 `save/record` 恢复。

收尾超时只阻止新提交，不隐藏其他已保存项；同一批次同一任务的原 `finalize` Promise 尚未结束时，在同一 JS 运行域重新加载 host-source 仍拒绝重复收尾。内置 store 的批次元数据包含规范目录，用于区分不同项目；实际文件收尾另外取得每任务进程锁，覆盖原件复制、文件核验与终态写入。图片及结果先写临时文件，再持锁原子发布，另一进程不能把尚未复制完成的文件登记为失败。`summarize` 挂起时返回 `summaryPersisted:false` 的紧凑交接，包含状态计数与任务身份；只有重新核对当前控制允许交付后才附已保存输出，路径相对于交接中的 directory。不能把该回包称作已写入交付索引，也不能据此强行取消仍未结束的回调。
