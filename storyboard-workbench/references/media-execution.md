# 图片批次、LibTV 生成恢复与集中交付

本流程只在用户明确授权对应媒体或入库任务后使用。维护、测试流程不调用媒体工具；测试使用本地假回执。生图与补图共用执行入口，不配置模型 API，不迁移旧生成清单或改写已确认素材。

## 控制上下文与及时交付

控制模型的请求也会携带会话内的工具图片。长会话反复读原图、回传整批内联图片后再进行多轮收尾，会让仅需推进文件操作的请求重复携带大量图像；请求体读取超时不能归为生图耗时。

- 主 Agent 先在文件中冻结当前授权阶段、完整 Prompt、参考路径、版本与批次目录。只处理本轮变化，沿用未变化的规则与启动检查；不反复打印全量 Prompt、脚本源码、历史结果和画面设定来确认同一事实。
- 已累积大量图片或出现大请求超时时，生图使用一个干净的执行上下文，整批复用该上下文。宿主支持子 Agent 且用户未明确禁止时，只启动一个 `fork_turns: "none"` 的批次执行者，传共用规则入口、冻结批次绝对路径、数量/阶段授权和停止条件；不要继承整段对话，也不为每张图创建 Agent。执行者按文件读取同一正文和参考，不另创 Prompt。用户明确禁止子 Agent 时遵从其选择，使用宿主提供的新上下文能力；不能假装本地队列能清除宿主历史。
- 实际参考按工具要求查看一次；图片工具返回后按宿主要求展示，不额外把同一组原图再次 `view_image` 或以内联 base64 回传到主控制上下文。交接使用真实文件路径、小回执和必要问题记录，未核验的画质明确待检查。
- 批次排空后在同一执行单元直接调用 `summarize`，完成文件核验、内部汇总和可点击交付索引。主 Agent 收到紧凑交接即交付已有结果；不要为写最终回复重读全套图片、规则，或额外创作未授权的下游镜头。必要检查保留，非交付前提的后续建议不阻塞本轮交付。
- 出现 HTTP408 `Request body read timed out` 时，先核对控制请求体大小与重试时间。暂停新媒体提交、保存现有任务身份与回执，恢复时仅接手同一批次；不靠增大生成并发、延长超时或重新生成来掩盖大请求重传。

## 一次准备，逐张执行

1. 在本轮开始时核对依赖、目标项目、授权数量、冻结正文和真实参考。已读取且路径和哈希未变的规则不用重读；环境和相关脚本未变不重复跑 doctor。人物与场景确认仍是后续分镜的依赖，不能靠并发跳过。
2. 将本次已就绪的任务写入批次计划。每张有稳定 ID、完整 Prompt、版本或哈希、输入参考和输出位置；同一 Prompt 的已授权候选分别建任务，复用帧不建任务。补图仅包含本次新授权的镜头，以新批次或新尝试 ID 保留旧记录，禁止把未知任务改回 planned 后重新提交。
3. 使用 [generation.mjs](../scripts/generation.mjs) 与 [media_batch.mjs](../scripts/media_batch.mjs) 的共用队列。Codex/imagegen 默认生成并发1，其他工具默认4，用户明确要求优先；收尾并发1、待收尾上限4；单张回传并持久保存最小回执后补位，复制与校验独立推进，不等待其余图片。依赖未就绪不认领、不占生成槽位。真实限流时按回执调整尚未提交的并发，不声明四槽是服务上限。
4. 每张在调用前独占登记，返回后立即复制真实输出原件并记录路径、哈希和工具回执。每张独立捕获生成、保存及回执写入错误；一张失败不结束其他任务，不使用未隔离失败的整批 Promise.all。成功必须有可读取且哈希正确的实际文件，文件保存失败不能标成功。
5. 已提交、成功、失败和未知任务保留原记录。结果未知只恢复原任务或检查已返回原件；恢复本地保存不调用生成工具。没有可查询任务身份时标明未知并交代缺项，不猜测成功、不自动重投。

批次文件是执行证据，不是新的 Prompt 权威。旧 `generation-manifest.json` 继续使用既有字段和校验；成功输出及用户确认按原合同明确关联，不能以新的批次检查冒充旧清单校验或用户确认。

### Prompt 阶段准备与 Node 存储入口

正文创作与文本核对完成后立即准备本地请求，聊天默认只展示数量、完成情况和文件入口，用户需要时再展开全文。正式 Excel 仍保留完整正文。只有正文、规格、参考或环境变化才重做对应准备和检查；普通跑批不增加预防性排障或长篇报告。

共用入口为 [generation_bridge.mjs](../scripts/generation_bridge.mjs)，在正常 Node 进程执行锁、复制和落盘；不要在缺少 `process` 的 node_repl 中构造 store。桥接不调用媒体工具。输入为 UTF-8 JSON 文件或标准输入：

```text
node storyboard-workbench/scripts/generation_bridge.mjs "<request-file.json>"
```

所有响应为 `{ok:true,value}` 或 `{ok:false,error,code}`，非零退出或 ok:false 必须抛给队列，不能伪装保存成功。JSON 正文不能嵌入 shell 命令；宿主通过文件工具写入请求文件，或通过真实 stdin 传输。请求文件用唯一名称，读取响应后逐个删除本次临时文件；工具超时则保留原文件和任务身份，先核对原进程。

准备输入 recipe 使用以下结构（路径均为绝对路径，pointer 为 JSON Pointer）：

```json
{
  "batchId":"assets-01", "version":"v1", "phase":"characters", "tool":"imagegen",
  "jobs":[{
    "id":"son-front", "count":1,
    "source":{"path":"<creative-json>","pointer":"/characters/0/base/text"},
    "request":{"transparent_background":false},
    "requiredAssetIds":[], "references":[]
  }]
}
```

`source` 必须指向权威创作正文，request 只提供已确定的真实工具参数；如带 prompt，必须与来源逐字一致。画幅等工具不支持的字段不得自造。每个视图、候选、独立分镜各一项，复用帧不建任务。tool 未确定、request 缺失或参考未确认时仍可保存准备文件，但带 blocked 原因，不能 init；参数后续确定时另存准备版本。imagegen 默认 concurrency:1，其他工具默认4，显式 concurrency 优先；收尾仍为1，最多4项待收尾。准备文件不是媒体授权。

分镜必须声明 requiredAssetIds，并在 references 中覆盖所需人物和场景。每个参考为 `{assetId,path,confirmation:{path,pointer}}`，confirmation 指向 `{assetId,status:"confirmed",by:"user",path,sha256}` 的真实采用记录。若原合同字段不同，只将已有用户证据映射到附属记录，不迁移旧文件、不代替用户确认。准备入口读取并冻结正文及确认来源哈希、参考文件哈希；绑定变动后另存新准备版本，不覆盖旧批次。

| operation | 输入与用途 |
|---|---|
| compile | `{recipe,output}`：读取 recipe 文件，保存全套准备请求，返回 ready/total；不认领、不提交 |
| init | `{directory,prepared,authorizedCount}`：获得用户授权后核对数量、依赖及来源，复用现有 store 初始化批次，返回紧凑 batch/jobs/initialStates/concurrency |
| prepare | `{directory,args:[id,context]}`：提交前核对冻结来源并调用原 store.prepare |
| capture / finalize | `{directory,args:[id,envelope]}` / `{directory,args:[id]}`：保存原回执、原件及哈希 |
| summarize | `{directory,args:[report]}`：从磁盘读取逐张状态并调用原 summarize，不传整批 results |
| snapshot / readControl / setControl / acknowledgeControl | args 与原 store 方法相同，保留阶段控制及恢复语义 |

宿主继续加载 `generation.mjs host-source` 中的 `runMediaBatchAndSummarize`，不另写队列。将 bridge 的 prepare/capture/finalize/readControl/acknowledgeControl/snapshot 接到同名回调；execute 直接调用用户授权的图片工具，按工具要求展示返回图；summarize 回调只传 report，由桥接读取磁盘结果。init 返回的 jobs 仅供调度，完整 request 在 prepare 时读取。固定参考按工具要求在提交前查看一次。

工具等待采用 callTimeoutMs:300000，本地桥接采用 localTimeoutMs:120000；具体宿主有更明确限制时遵循真实能力。不靠延长超时或增加槽位掩盖异常。一个干净执行上下文处理整批，主对话只收简短进度、异常和索引。已有 v2 批次可通过同一入口接手 batch.json，旧 v1 仍走原合同；没有准备记录的历史批次不宣称已做来源预备核验。

prepare 合并独占认领、参数/依赖/参考校验和请求快照；capture 将工具身份、原图位置和错误同步刷盘，再返回 persisted:true，随后释放生成名额；finalize 合并复制、哈希校验和结果登记。原件路径只能来自实际工具回执，格式未知不猜测。每张失败独立登记，不保存 base64。

图片工具等待默认 `callTimeoutMs:300000`，Codex 本地桥接及汇总默认 `localTimeoutMs:120000`，均为可配置的正整数毫秒。工具超时只结束本地等待，不能证明宿主 HTTP 或远端生成已取消；停止新增提交，让已完成项继续保存并汇总交付，当前阶段仍须允许交付。晚到 Promise 不再改变本轮状态。超时不是终态工具回执：v2 存储仅追加 `wait-expired` 事件并保留原 submitting 请求；之后取得同一原任务的真实回执时可 `capture/finalize`，不能重新生图。旧 v1 存储将超时观察独立保存在 claims，原件回执可通过旧 `save/record` 恢复。

收尾超时只阻止新提交，不隐藏其他已保存项；同一批次同一任务的原 `finalize` Promise 尚未结束时，在同一 JS 运行域重新加载 host-source 仍拒绝重复收尾。内置 store 的批次元数据包含规范目录，用于区分不同项目；实际文件收尾另外取得每任务进程锁，覆盖原件复制、文件核验与终态写入。图片及结果先写临时文件，再持锁原子发布，另一进程不能把尚未复制完成的文件登记为失败。`summarize` 挂起时返回 `summaryPersisted:false` 的紧凑交接，包含状态计数与任务身份；只有重新核对当前控制允许交付后才附已保存输出，路径相对于交接中的 directory。不能把该回包称作已写入交付索引，也不能据此强行取消仍未结束的回调。

传入 `run` 后，媒体入口在任何生成调用前检查 `toolUse`，本地图片存储构造时检查 `fileRead/fileWrite`；明确 unsupported 会停止相应操作。未知能力保留兼容行为，仍须先检查宿主实际工具是否存在。规则装载、能力观察及小上下文分块按[适配说明](../adapters/README.md)，不为每张图重复装载。

`summarize` 保留完整内部 JSON，同时写独立 `delivery-<id>.md`。回包只含汇总位置、交付许可、索引绝对路径、状态计数和已验证图片路径；暂停或版本不符时不返回交付链接。文件核验不等于画质审核或用户确认。不要再把 `results/report` 全量打印给模型，也不为读取该小回包额外打开所有原图。

空槽补位的准备和工具调用优先于派发复制，防止串行本地桥接把下一次提交排在复制后面。收尾队列满时，已返回工具暂时保留生成槽位，等待捕获容量，不创建无界后台任务。捕获失败停止新派发，并将未持久化回执保留在返回结果中。依赖只在成功落盘后解锁；失败、未知或暂停的依赖使下游 blocked。先运行能解锁后项的任务，独立任务填充空闲。

### 阶段切换、暂停与恢复

每批只运行一个协调器。用户改变目标时，宿主先调用 `batchStore.setControl({paused:true})`，或 `setControl({version:'v2',phase:'characters',paused:false})`；不能只写自然语言备注。第二参数可传 `{receivedAt:<真实收到指令的UTC时间>}`，否则记录控制入口收到时间。降低并发用 `setControl({concurrency:2})`，不取消在途任务。新版本/阶段使用新批次目录。

控制使用独占短锁和追加的 control-00000001.json 等文件，保留历史；锁冲突或控制不可读时失败关闭，不强删锁。prepare 在认领及准备提交时检查控制；宿主观察控制后，在同一事件回合通过闸门调用工具，旧准备结果不能越过已生效的暂停。control-observed 文件记录 receivedAt、observedAt、effectiveAt。控制请求写入只证明收到，调度器确认后才表示生效；不能声称撤回已有请求。

重新初始化同一冻结批次并传 snapshot() 恢复：成功输出核验后复用；returned 仅恢复本地收尾；存在 claimed/submitting/submitted/pending/unknown 时不新增提交，但已有 returned 仍可收尾，已保存项仍可交付。failed/unknown 和保存拒绝不自动重试。新旧 store 均提供 snapshot，展开 store 且未显式提供 initialStates 时，调度器在任何新认领前自动读取一次；跨宿主传输则使用本次读取的 initialStates。自定义旧回调须传 snapshot 或 initialStates 才能获得跨运行容量保护。快照须为普通对象，任务身份和状态须匹配；相同尝试只接受完全一致的重复真实回执。相同 Prompt 的不同任务不错误合并。已有原图但保存被拒绝的任务同样不得重生或自动重试保存。核实原保存失败原因已解决后，可显式调用 finalize(id,{recoverSave:true})；仅恢复 unknown/stage:save，锁内将旧失败记录追加到事件历史，再从原 capture 保存。

report.deliveryAllowed 为 false 时不交付旧阶段结果；为 true 时，写 Excel 前仍须核对最新控制版本与用户文字。新宿主默认流水线，旧批次继续旧入口。回滚先暂停、等生效、核对在途与回执，再切入口；v2 批次不能交给 v1 存储重开，未知或暂停项不无条件重新入队。

### 计时与 mock 验收

事件用 UTC；存储侧 preparedAt/capturedAt/savedAt 含单调时间与 clockId，跨进程重启不相减。prepareMs/finalizeMs 是本地单调耗时。宿主缺少单调时钟时明确 durationSource 为 utc-estimate；服务端接收及排队时间为 null。旧 submittedAt 保留，不当作服务端开始时间。nextSubmissionAfterCaptureMs 是回执后至下一次工具提交的观测间隔，不是服务端排队时间。summarize 在批末增加一次桥接，重新核对成功文件和当前控制，保存独立汇总，不重写历史。

`peakOutstandingCalls` 表示尚未完成的工具调用峰值，旧 `peakGeneration` 为兼容保留同值；两者不能证明模型同时计算了几张。实时队列的 `observedToolExecutionPeak` 保持 null。可离线执行以下只读命令，按会话中 imagegen Extension 的真实起止区间计算观测峰值，不调用媒体工具：

```text
node storyboard-workbench/scripts/generation.mjs audit-execution "<rollout.jsonl>" "<turnId>"
```

未指定 turnId 时读取最后一轮。输出只含任务身份、时间和执行区间，不回传 Prompt、图片或凭据。无事件时峰值为 null；事件区间有重叠才表示宿主可观测执行并发，服务端计算峰值仍为 null。不能将某次观测为1推广成 imagegen 永久上限，也不能将四个挂起 Promise 或 mock 并发宣传为四图同时生成。宿主执行串行时先处理上下文与回执瓶颈，保留通用四槽供其他有并发能力的工具；未经新授权实测不宣称改槽能提速。

运行 `node --test storyboard-workbench/tests/generation-bridge.test.mjs storyboard-workbench/tests/generation-pipeline.test.mjs storyboard-workbench/tests/generation-batch.test.mjs`，只用 mock 与临时图片。16项比较桥接、控制调用、补位、积压、槽位利用率和总耗时；关键断言为“其余三张未返回、首张仍收尾，第五张已提交”。mock 不证明真实容量或提速，真实压测另需任务数与预算授权。

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

`runLibTVGenerationBatch` 与 `runLibTVImageDelivery` 的本地回调使用 `localTimeoutMs`，默认300秒，避免比可选下载的等待预算更短。读取、解析与写入、收尾、汇总、认领、解锁均有期限。写入或收尾回调超时后停止新副作用，批次返回 `incomplete:true/persistedSummary:false` 的身份交接，暂不发布交付链接；原回调真正结束前保留协调器锁，不能强删锁后重跑。认领或解锁超时时物理锁状态可能未知，以 `ownershipUnknown` 为准。只有在原副作用都结束后才按原 owner 尝试释放；进程退出或宿主结束当前隔离执行单元后，不能假设后台清理仍会执行。

图片文件保存持有按实际输出目录和任务 ID 创建的进程锁；下载即使忽略 abort，或解码仍未真正结束，都不能释放该锁。`saveLibTVImage` 的 `downloadTimeoutMs` 默认120秒，完整解码的 `localTimeoutMs` 默认30秒。下载字节 fsync 后、调用解码前先保存 `image_downloaded`；原进程退出后可核验并复用，不重复下载。正式图片在验证和持锁检查后原子发布，发布前后中断均保留可恢复状态。

独立 `runLibTVImageDelivery` 可提供完整的 `acquire/release/assertOwner` 持久锁桥，三者必须同时提供；可复用[进程锁模块](../scripts/process_lock.mjs)。readReceipt 和 saveImage 的最后一个参数为 context，writeReceipt 的 options.context 也包含本轮令牌；自定义回调须在实际写盘时 assertOwner(context)，不只在开始等待前检查。report.persistentOwnership 表示本次是否接入持久锁。没有这组桥的旧调用仍仅有同一运行域的内存保护，不宣称跨进程安全。异步期限不能终止同步阻塞的 JS 回调，也不证明宿主 HTTP 或服务端任务已取消。

每项任务为 `{id,count:1,dependsOn:[],submitTool,submitArgs}`，两种入口都原样透传：

- `submitTool:'create_node'` 使用宿主核实的图片节点请求：精确 projectId、唯一稳定 idempotencyKey、nodeType=image、run=true、完整 name/prompt、按实时 schema 验证的 params，明确 params.count=1。引用用真实 left/right 节点，不在 params 中伪造媒体列表。2026-10-27 工具公开参数为 unknown，不能再把本地接受字段宣称为完整线上类型契约。
- `submitTool:'generation_submit'` 使用本次实际公开的 project_id、idempotency_key、kind=image 和 request={model,prompt,params}。新计划须有非空 prompt，params.count=1；实际模型参数仍按 get_model.inputContract 核验，不推导 provider 或媒体列表。历史冻结请求只按原键原参数恢复，不自动重写。2026-10-27 只读取得 nebula-ultra 的实时合同，确认 count 允许1/2/4；本地单张任务明确取1，不以此代表已真实提交验收。
- 返回 task_id 后统一查询 `task_status({project_id,task_id})`；cop_ 仅是画布回执，不能用作媒体任务身份。提交成功不等于生成完成。

task_status 同样未公开完整响应结构，必须提供 `normalizeTask(response,{projectId,taskId,count})`，依据实际部署证据映射到本地合同 `{projectId,taskId,state,outputs}`。state 只接受 pending/succeeded/failed/cancelled，outputs 每项只保留 nodeId/resourceId/fileRef，成功数量必须等于授权数量。该映射不能猜测未认识的状态，不能把 HTTP200、节点创建或链接存在视作成功；缺少已核实映射时停止接入。可识别的提交 task_id 先落盘，即使后续解析失败仍保留原任务。离线 mock 只证明本地合同和调度。

`finalize(job,receipt)` 消费原任务引用，通过 prepare_project_delivery 取授权清单，再保存文件并返回绝对路径与实际 SHA256，遵守当前水印、会员和审核规则。存储重新核对数量、类型与哈希；下载或保存失败保留 generated，下次只恢复交付。完整解码由下述图片保存入口校验，画质审核与用户确认另行记录。

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

在生成调度的 finalize 中，从已核实的 receipt.taskId 与 outputs[0].nodeId 构造 deliveryJob，并要求 result.state=saved 后返回 result.files。`node libtv_delivery.mjs host-source` 可将同一入口加载到宿主，文件边界继续用前述 nodeCall 桥接。Task 成功响应仍须有本部署实际证据的 normalizeTask；已有节点和交付清单均不能替代该映射。

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

## LibTV 独立资产并发

使用 [libtv_assets.mjs](../scripts/libtv_assets.mjs) 复用同一并发队列。开始时发现精确项目和目录、读取已有内容索引并处理分页；目录先建立一次，同目录的创建或更新不并发争写。

本地准备使用 `prepareLibTVAssets(projectDirectory, items, {projectId,scope})` 计算真实文件哈希与稳定键，`items` 包含 `{id,name,path,folderId}`。`createLibTVReceiptStore(receiptDirectory)` 提供逐阶段文件回执。两者可由 `node_repl` 从模块导入，文件和目录必须是本次获授权目标。不要从普通节点名或任意数字推断目录 ID。

`node storyboard-workbench/scripts/libtv_assets.mjs host-source` 输出完整的同一发现及流水线函数，可按上面的方式载入 `functions.exec`。宿主只注入工具和文件边界：

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

`discoverLibTVAssets` 已实现目录预读和资产分页，不另写逐张搜索循环。`readReceipt(item,stage)` 与 `writeReceipt(item,stage,value,options)` 通过上述小 JSON 桥接调用存储对象，传本地已准备项的 ID，不反复传整批数据。`transfer(item,ticket)` 由宿主将本地原字节 PUT 到本次票据的精确签名地址，完成后返回 `{status:<HTTP状态码>,bytes:<实际长度>,sha256:<实际字节哈希>}`；不得把发起上传或 HTTP 失败记成成功。传输所用文件须核对准备时的哈希；签名地址、审核和 Resource 全部沿用原票据及回执，不构造私有 API。

- 先对实际文件计算内容哈希，按当前授权空间、项目与目标目录核对既有资产。本批相同内容只入库一次；名称相同不能证明内容相同，不同目录归属也不能自行猜测。
- 资产间有界并发；同一资产按上传凭据、传输、完成上传、审核及挂图、读取源版本、入库、详情回读的依赖顺序推进。不能并发同一资产的依赖步骤，也不能用一个资产的回执推进另一个资产。
- 幂等键从项目、内容与目标身份稳定派生，不手抄。每阶段保存小回执，后续从原回执恢复；不把累积 ledger 或图片 base64 塞进命令行，不为每张图重查整张画布或全部目录。
- MCP `isError`、审核待处理、审核拒绝及未知写入分别记录。未知写只按原 task/operation/幂等键恢复，不换键创建。入库成功后按接口要求读取一次资产详情，核对持久身份和版本；缓存可用于后续本轮步骤，不能冒充跨任务最新状态。

工具方法与返回字段以本次实际 MCP schema 为准。宿主注入工具调用与文件传输；本地模块不绕过 MCP 另接私有 API。独立资产失败不阻断已就绪的其他资产，但来源、空间、版本及实际原件校验保留。

## 批次结束后一次交付

每张的完成回调只保存原件、状态和必要的具体画面问题，不导出 Excel、不重跑整片评分或建立整套项目副本。图片核对可在其他图继续生成时进行；LibTV 可消费已经保存的成功项。

收齐本轮各项结果后，统一列出成功、失败和未知项，完成一次变化项核对，再通过既有共享入口集中更新固定 Excel。失败或未知项保留旧图或待补图标记；不能为了凑齐数量自动补交。

同版未变化正文与已验证文件沿用本轮检查；正文、引用、来源或实际文件变更时检查受影响部分。写入前的版本、用户文字冲突、空间和原件哈希检查不可省略，正式文件布局与用户意见仍受原合同保护。所有空间冲突一次列出具体位置，再统一修正文案，不逐格试错导出。

完成后保存一份批次汇总和必要制作日志；渲染本次变化区域一次。只有新改动、新失败或尚未解决的显示问题才重复检查，不重复全片渲染、评分、全套开发测试或无变化导出。未完成项在同一次交付说明，不把重复收尾当成进度。

## 正常交付与异常报告

正常批次自动保存原件、最小回执和哈希，集中核对数量、可读性及引用对应关系后立即交付预览。详细美术审查不作为普通预览交付前提；用户明确要求的审查仍须完成。文件成功、画面检查、用户确认分别记录，未做画面审查标待检查，资产仍须确认后才能进入分镜。Excel 按原规范在阶段收齐后集中更新一次。

只有真实异常发生时排障：报告任务ID、卡点、已完成数、错误证据、影响范围、未知部分和恢复措施。保存失败恢复原输出；汇总或 Excel 失败先交付已有图片和索引。未知任务不重投、不自动释放容量，继续独立项须有已记录授权；不强删执行锁。计时分别记录准备、工具等待、回执保存及汇总，排除用户等待；远端GPU耗时不可观测时保持未知，不承诺固定批次用时。
