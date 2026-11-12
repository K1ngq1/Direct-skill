# 既有 v1 数据与人工评分导入

仅继续既有 visual-excel-v1 项目或导入历史人工评分时读取。新项目使用[v2 字段合同](visual-v2-contract.md)。

## 5. 创作数据合同

数据版本仍为 `schemaVersion: 1`、`mode: "visual-excel-v1"`；新方案必须显式记录 `rubricVersion: "visual-v2"`，含十一维。既有方案未记录 `rubricVersion` 时按 `visual-v1` 十维兼容，正文、指纹、人评和分数不自动迁移。所列维度均须有文本；确实不适用时说明画面原因，不编造人物来填满。评分可用 `null` 表示不适用。

```text
projectId, title, sourceSha256, rubricVersion: "visual-v2"
spec:
  aspectRatio, resolution, style
  duration: {mode: estimate|exact|max|range, seconds?, min?, max?, basis}
productionInventory:
  characters: [{id, name, description, basis}]
  locations: [{id, name, description, basis}]
props: [{id, name, description}]
references: [] 或下列实际参考记录
  用户附件: {id, purpose, userProvided: true}
  已确认生成图: {id, origin: "generated-confirmed", assetId, generationTaskId, path, sha256, purpose, userProvided: false}
designNotes: [本次设计依据及时长/拆并调整]
shots: [{
  id, sourceShotIds: [归档中的镜头ID], locationId, seconds,
  dimensions: {
    moment, appearance, pose, expression, relations,
    camera, optics, composition, scene, lighting, continuity
  },
  shotSchema: {referenceIds, subjects, props, relations},
  transition: {fromShotIds: [更早镜头ID], entry, exit, cut},
  motion: 动作及剪辑编排文本,
  reuseOf: null 或更早镜头ID,
  prompt: {text, sourceHash, textHash},
  review: 评分对象
}]
calibration: [{id, shotId, label, text, sourceHash, textHash, review}]
```

`motion` 是镜头动作与衔接记录，不是本轮另交一套视频生成 Prompt。`shotSchema` 复用 [人物、道具与关系契约](data-contract.md#单镜人物道具与关系)：人物 `assetId/referenceIds`，道具 `id/name/state/position/holderAssetIds/referenceIds`，关系 `id/type/subjectIds/propIds/description`。人物字段可记录 appearance/clothing/position/orientation/pose/hands/gaze/expression/visibleParts；关系类型是 gaze/contact/occlusion/sameFrame。所有持有者都必须在本镜入镜表中。`sameFrame` 必须关联至少两个本镜入镜人物，不能用于一个人物与若干道具的同框；单人物与道具的实际接触或注视使用 `contact` 或 `gaze`，仅说明同框范围时写入构图或正文。

生成结果与用户确认独立保存在项目的 `generation-manifest.json`，不能改写原件归档伪造来源。只有对应任务实际完成、文件可读且用户确认采用后，才将生成图登记为 `generated-confirmed` 并关联正确资产；正文引用变化须形成新版本，旧正文及其评分保留。路径、文件哈希与任务身份必须和实际输出一致，不能仅凭文件存在把图片标为已确认。

`sourceHash` 绑定本镜对应原文、规格、资产、维度内容、Shot Schema 和前后衔接；显式评分版本也进入指纹。`textHash` 单独绑定正文。由 `seal` 计算，Agent 不用伪造或手填哈希。评分对象的 `rubricVersion` 须与计划一致，`promptHash` 须对应其精确正文。

## 6. 冻结、导出与评分导入

```text
node "<skill>/scripts/visual.mjs" seal "<project>" "<plan.json>"
node "<skill>/scripts/visual.mjs" validate "<project>"
node "<skill>/scripts/visual.mjs" export "<project>"
node "<skill>/scripts/visual.mjs" feedback "<project>" "<ratings.xlsx>"
```

`seal` 只把正文中的 CRLF 规范为 LF 后计算哈希，不改字句或语义，也不覆盖已有 `visual-plan.json`。用户授权修订时新建版本目录，保留原件和前版；正常导出只校验，不刷新已过期指纹。修订正文或来源后不能沿用旧评分。校验通过只证明结构、绑定与计算一致，不能代替 Agent 的语义核对或实际图像验收。

v1 数据和评分按原合同读取，重新导出的正式 Excel 也使用[三表脚本规范](visual-workflow.md#正式-excel-与后台日志)。分数、证据、来源和检查过程只进入后台，不新建评分辅助表或隐藏表；原历史导出及真实人评保留。用户明确要求校准时才用 `export-calibration` 另导独立样本，用户分数/原因为可填区域，原稿、正文、样本 ID 和哈希保持冻结。

独立人工校准导出继续检查既有文件；任何人工评分或原因已填写时拒绝覆盖，0 分也视为已填写。保留原文件，先导入或另存用户填写结果，再在新版本中继续；不得清空输入区来绕过保护。普通正式脚本的 `export` 则按[固定文件规则](excel-update.md)更新文案，两者不能混用。

人工评分仅接收用户真实填写的 0–100 数字，0 分不是空值。未知/重复 ID、公式、被改过的正文或背景均拒绝导入，避免把评分绑定错对象；明确报告原因并保留用户文件。导入保存独立、可追溯的反馈记录，不覆盖 Agent 分数或自动重写规则。标准提炼见 [人工评分与版本化标准](visual-rubric.md#人工评分与版本化标准)。

本模式不改旧项目、旧网页和旧导演测评材料。交付时区分已完成的文本/软件检查与未做的媒体生成，不以自评高分宣称 one-shot 达标。
