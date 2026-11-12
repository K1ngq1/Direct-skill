# 图片批次执行

执行前遵守[媒体共用边界](media-execution.md#共用执行边界)。本文件仅在对应操作被本次用户授权时读取。

暂停、超时、收尾或保存异常时读取[图片恢复](media-image-recovery.md)；计时分析读取[计时与离线验收](media-observability.md)。

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

### Codex 固定执行入口

Codex/imagegen 优先使用 [generation_codex_host.mjs](../scripts/generation_codex_host.mjs) 的 `runCodexImageBatch`，不逐图手写提交、wait、capture 和 finalize。普通 Node 可直接导入；code-mode 用以下命令读取同一入口源码并保留在宿主变量中，不打印回主对话：

```text
node storyboard-workbench/scripts/generation.mjs codex-host-source
```

文件边界使用同文件的 `createGenerationNodeBridge(nodeExecutable)`。传入实际 Node 可执行文件的绝对路径；它通过参数数组和 UTF-8 stdin 调用现有 `generation_bridge.mjs`，不经过 shell，不新增服务。在 node_repl 中只初始化一次，将请求交给该函数并返回 JSON；code-mode 的 `nodeCall` 仅封装这个已初始化的本地调用，解析 `{ok,value}` 的工作已由桥接完成，工具级错误仍须抛出。不要将整个队列放在 node_repl 中等待它回调自身。

宿主的整批调用如下；`hostSource` 是上述命令的原始 stdout，`nodeCall(request)` 返回文件桥接的解析值：

```javascript
const run = new Function(hostSource + '\nreturn runCodexImageBatch;')();
const summary = await run({
  directory: batchDirectory, prepared: preparedFile, authorizedCount,
  bridge: request => nodeCall(request),
  generateImage: request => tools.image_gen__imagegen(request),
  displayImage: result => generatedImage(result)
});
text(summary);
```

`preparedFile` 必须是 compile 已保存的冻结请求，`authorizedCount` 须等于本轮授权任务数。此入口固定原生 imagegen，沿用冻结批次的并发数（默认1）、依赖和恢复合同；每阶段一个持续运行的执行单元。等待/yield 只是读取进度，不是下一张提交或保存的前提；不要把工具调用拆成一个 cell、持久化拆成下一轮 Agent 调用。

每张返回后先刷盘最小回执，再同步发出原生预览，复制与哈希校验由现有收尾队列自动完成。预览回调是 `generatedImage` 这样的同步发出函数，不等待用户或模型查看；预览报错、返回异步 viewer 或挂起，不将已生成图片改成失败、不重投。问题留在 `preview.errors`，成功图仍可保存与交付；预览问题不等于画面已检查。原工具返回只暂存到该张回执保存，批末回包只含索引、状态计数、路径与预览问题，不把整批图片/base64送回控制对话。

Agent 批量创作并核对完整正文；资产出齐后实际看图采用，再提交依赖它的分镜；独立分镜批次完成后集中逐图检查，必要的首尾帧依赖与定向修正仍单独核对。不得用提速跳过看图、变动检查或用户原件保护。Excel 沿用既有封存入口集中导出，不逐张回写。

工具等待采用 callTimeoutMs:300000，本地桥接采用 localTimeoutMs:120000；具体宿主有更明确限制时遵循真实能力。不靠延长超时或增加槽位掩盖异常。一个干净执行上下文处理整批，主对话只收简短进度、异常和索引。已有 v2 批次可通过同一入口接手 batch.json，旧 v1 仍走原合同；没有准备记录的历史批次不宣称已做来源预备核验。

prepare 合并独占认领、参数/依赖/参考校验和请求快照；capture 将工具身份、原图位置和错误同步刷盘，再返回 persisted:true，随后释放生成名额；finalize 合并复制、哈希校验和结果登记。原件路径只能来自实际工具回执，格式未知不猜测。每张失败独立登记，不保存 base64。

传入 `run` 后，媒体入口在任何生成调用前检查 `toolUse`，本地图片存储构造时检查 `fileRead/fileWrite`；明确 unsupported 会停止相应操作。未知能力保留兼容行为，仍须先检查宿主实际工具是否存在。规则装载、能力观察及小上下文分块按[适配说明](../adapters/README.md)，不为每张图重复装载。

`summarize` 保留完整内部 JSON，同时写独立 `delivery-<id>.md`。回包只含汇总位置、交付许可、索引绝对路径、状态计数和已验证图片路径；暂停或版本不符时不返回交付链接。文件核验不等于画质审核或用户确认。不要再把 `results/report` 全量打印给模型，也不为读取该小回包额外打开所有原图。

空槽补位的准备和工具调用优先于派发复制，防止串行本地桥接把下一次提交排在复制后面。收尾队列满时，已返回工具暂时保留生成槽位，等待捕获容量，不创建无界后台任务。捕获失败停止新派发，并将未持久化回执保留在返回结果中。依赖只在成功落盘后解锁；失败、未知或暂停的依赖使下游 blocked。先运行能解锁后项的任务，独立任务填充空闲。
