# 数据与修订契约 v2.0

project.json（schemaVersion=1）是唯一权威状态；revision用于并发保护。每次写入使用锁、历史快照和原子替换，失败不写入项目。Markdown为派生导出。

## 普通故事与默认草案

新增工作流程仅用于新建普通故事项目，不迁移旧项目。workflowMode允许缺省（原人工模式）或agent-default；新故事必须有稳定UUID projectId、promptMode=static、staticPromptFormat=concise-v1及storyPlan。projectId/模式/原稿不可由apply改变，不用标题或源哈希区分同源不同项目的浏览器草稿。

入口为 `node scripts/project.mjs init-story <project> <source.txt|md> <plan.json>`。源文件须为非空、有效UTF-8、最多1MB的TXT/Markdown。计划由当前Agent创作，CLI不拆句或调用模型。程序先校验完整计划，目标目录已存在即拒绝；原文按原字节保存在sources/original.txt或.md，记录SHA256、原文件名、编码与行数，另存来源阅读版与manifest。读取故事项目时核对原件哈希及引文；不修改原件。磁盘异常留下的部分目录不能自动覆盖/清理。

plan.json顶层允许title/overview/aspectRatio/targetDuration/brief/productionInventory/storyPlan/shots，以及可选references/promptSections/sharedConstraints/reviewIssues。初始化镜头只允许id/displayNumber/workingScript/suggestedDuration/characters/scene/purpose/eventIds/dependsOnShotIds/recommendation/variants。每镜初始恰好一个variant，须有完整breakdown和shotSchema；人物摘要从schema的角色名称派生。staticPrompt和人物/姿态、资产/参考映射由程序派生，初始版本1。用户选择/确认强制为空，不接受传入approval等字段。sourceNumber/originalDuration为null，displayNumber为导演拆镜编号；original为关联事件的原文引文，sourceRef记录初始事件ID，不冒充原稿镜号。

```text
storyPlan = { version, events: [], props: [], notes }
event = { id, version, description, information, basis, sourceRef, stateChanges: [] }
sourceRef = { startLine, endLine, quote } | null
stateChange = { entityId, field, before, after }
prop = { id, name, basis }
shot.eventIds = [稳定事件ID]
shot.dependsOnShotIds = [稳定镜头ID]
```

basis允许source/user/proposal/unknown；source事件必须有可核对的原稿行号与引文。其他依据没有原文定位时用null，不伪造来源。stateChange引用已登记人物/场景/道具；同一事件同一实体的同一字段不得重复。ID不超过50个ASCII字母、数字、下划线或连字符；事件、实体和引用不得重复或悬空。每镜至少一个事件，所有事件须有镜头覆盖，依赖不得有环；顺序不是程序自动叙事审核。props只登记稳定道具，当前画面状态仍用shotSchema。程序不保证自然语言before/after的物理合理性，Agent必须核对。

初始真实图片输入为references数组的{id,file,label,role,assetIds,visualStatus,observations,usage,uncertainties,sha256?}。file相对源文件目录或使用明确本地路径，只读实际PNG/JPEG/WebP并复制为项目相对路径，保存实际SHA256；显式提供的哈希不符则拒绝。visualStatus缺省unreviewed，仅实际看图后可设reviewed，不以文件复制代替视觉核验。没有图片就传空数组，不编造参考。

storyPlanEdits=[{id,values}]只能更新现有事件的description/information/basis/stateChanges，不能改ID、version、sourceRef或重排/增删事件。每个变化事件version递增，计划version递增，原文/原镜引文保留，关联镜头与后续依赖标待同步。镜头eventIds/dependsOnShotIds通过现有edits.values更新并在提交前校验；结构性拆并和重排仍先提案，不自动执行。全局patch.project不能整份替换storyPlan。

故事项目的edits、cellEdits及edit-cell可选affectedShotIds：[]表示仅本镜，非空数组表示Agent已核对的连续段后续依赖；只能引用原有后续依赖，不可指向本镜/不相干镜头。省略则沿声明依赖传播核对标记，不直接改写其他镜头文字。默认方案的人物/道具/内容/场景/光影/连续性变化会传播；单独改焦距等不会传播，未采用候选不会使当前方案或后镜失效。全片资产修改继续assetEdits；解除同步仍需完整语义核对，而非只改一格。当前生成清单保留全片审核门槛；故事模式的fingerprint不含未采用variants，避免仅新增/修改备选使已冻结清单失效。

有效用户选择优先，否则用有效recommendation.variantId作为当前草案；无有效默认方案拒绝导出，不用首个方案偷偷替代。页面和Excel/current-draft.md共享此规则。新模式默认总表，旧模式默认quiz，已有保存视图优先。Agent默认、用户已选择、用户已确认是独立事实；更新recommendation不反选用户，也不自动确认。

GET /api/export.xlsx在新模式无须逐镜选择，文件名包含“当前草案”；保持“分镜总览”“总共的Prompt”两张表，方案列名为“当前方案”，增加方案来源/审核状态，保留待同步提示。只放当前方案及匹配补帧，独立内容单列待核对。selected-prompts.md保持用户已选原义，全量static-prompts.md仍保留备选。导出不修改revision、selectedVariantId或approval；LibTV准备仍要求全片真实选择、确认、无阻塞项。后文“全片选择才导出”描述仅适用于原人工模式。

## 原稿、工作稿与方案

原件、original、sourceNumber、originalDuration、sourceRef、图片路径/哈希不可通过编辑接口覆盖。shot可选workingScript与displayNumber为可编辑副本，editVersion记录工作稿版本；未设置时显示原文及源镜号。suggestedDuration是建议秒数，不是原稿时长。

原有方案字段id/title/description/rationale/staticPrompt/motionPrompt、tags/constraints/referenceIds、version/origin保留。breakdown含content/lighting/characters/scene/decision及camera，可选字符串composition/pose/texture/continuity。continuity在详情区编辑与批注，不新增主表列。旧方案缺框架时不自动从Prompt推断参数。

project可选staticPromptFormat目前支持"concise-v1"；新XLSX导入写入此值。缺少该字段的旧项目保持旧汇总格式，读取不会自动切换。格式迁移须经版本化apply提交project.staticPromptFormat与源框架修订，保留旧快照、选择记录和原稿，受影响的旧确认失效，不自动确认新版本。

有breakdown时，staticPrompt是派生快照，由composeStaticPrompt(project, variant)唯一生成。concise-v1按六类汇总：画面瞬间content → 场景环境scene → 镜头与构图camera精简项＋composition → 光影与风格lighting＋texture＋brief.style → 人物与关系shotSchema（旧无schema时characters＋可选pose） → 连续性与限制continuity。空项省略，不输出“待填写”；pose可空，各源字段不重复同一信息。画幅aspectRatio和brief.resolution单列规格，风格仅在光影与风格说明一次；约200–300字为创作目标，不是程序截断或填充阈值。decision、独立description/rationale、工作稿和整套资产人设不拼入。

精简camera使用shotSize/position/focalLength/focus，equipment仅用户提供时写入，否则空省略；不汇总movement/aperture/frameRate/shutter/iso/exposure/reason/conditions。新格式只校验提供的camera键为字符串，允许保留历史13键；旧格式仍要求equipment/shotSize/position/movement/focalLength/aperture/frameRate/shutter/iso/focus/exposure/reason/conditions全部为字符串，并按content、camera全部13项、composition、lighting、pose、characters、scene、texture汇总，画幅、分辨率和风格作为前缀。框架编辑、网页读取/复制、批注前后值、Markdown、Excel和LibTV清单均使用当前项目格式的同一结果。无breakdown旧方案维持独立staticPrompt；补帧、场景和三视图section继续独立编辑，仅使用相应必要内容。

读取旧框架项目时在内存投影派生文字并提供新的内容版本，不写盘；重复读取同一磁盘原文不累加版本。若选定版本旧Prompt不同，其旧审批不能继续有效，旧版本范围批注被拒绝。版本化保存仍留存磁盘原JSON快照。迁移使用完整breakdown patch，增加受影响方案版本，保留旧文案与原稿。不得只改导出文件完成迁移。

variant可选characterAssetIds数组明确记录该拍法实际入镜的角色资产稳定ID；无人物的方案显式用空数组。有shotSchema时由其subjects投影，不另行编辑；旧无schema时由Agent核对维护，不从Prompt关键词或shot.characters全角色名单自动推断。缺少该字段的旧方案继续可读，但不能声称已确认该方案的人物映射。

promptMode允许static或static-motion。旧项目缺少该字段时按static-motion兼容，新XLSX导入写static。static模式只要求静态Prompt完成展示、同步、确认与阅读导出，不创作视频文字；历史motionPrompt仍在项目JSON及快照中，模式切换不删除它。static-motion沿用双段规则。

brief含purpose/deliverables/resolution/style四个字符串，与aspectRatio、targetDuration共同保存对话中取得的目标。productionConstraints六项专业建议保留兼容，不在HTML中作为用户表单。改变目标后相关Prompt待同步。

## 单镜人物、道具与关系

variant可选shotSchema，保存当前拍法实际入镜的人物、道具和关系，不在长Prompt中反向解析：

```text
shotSchema = { referenceIds: [], subjects: [], props: [], relations: [] }
subject = { assetId, referenceIds: [], appearance, clothing, position, orientation, pose, hands, gaze, expression, visibleParts }
prop = { id, name, state, position, holderAssetIds: [], referenceIds: [] }
relation = { id, type, subjectIds: [], propIds: [], description }
```

- subject以角色assetId为稳定标识，名称读取已登记资产；9项描述字符串可空，仅写本镜可见信息。referenceIds指实际人物参考附件，不写资产ID代替图片ID。
- prop以非空字符串稳定id标识，name/state/position描述道具及当前状态，holderAssetIds只引用当前入镜人物；没有持有者可为空。
- relation以非空字符串稳定id标识，type为gaze/contact/occlusion/sameFrame。gaze的subjectIds顺序为[视线发出者,目标人物?]，首位须入镜，目标可为已登记的画外人物；看物件时可只列发出者并用propIds指定目标。界面分别选择发出者和目标。其他关系的人物与所有propIds只引用本schema中的人物、道具；description说明具体关系，不猜缺失事实。
- schema.referenceIds保存场景或通用参考；variant.referenceIds由通用、人物和道具参考合并投影，characterAssetIds由subjects投影。无效资产、持有者、参考、重复ID、悬空关系和未列入subjects的同框人物均拒绝保存，失败不覆盖原稿或草稿。

移除人物或道具后若仍被持有者或关系引用，保留草稿并拒绝保存；须明确修订关联和描述，不静默清空引用留下矛盾文字。

有shotSchema时，它是人物、姿态、道具与关系唯一源，breakdown.characters和pose为只读投影；其他画面、场景、摄影、构图、光影、质感和continuity仍以breakdown为源。程序逐人派生人物文本，再附道具关系，不同时维护第二份自由文字。先填schema，再用随包Humanizer对中文描述做一次信息与语言核对，最后派生六类正文；不得先写冗长Prompt再拆回结构。

主表仍为原十列：八个制作方面及镜号/工作稿。人物与姿态格提供“编辑人物与道具”入口，在现有全文专注对话框打开结构化表单；用户无需手写JSON。有schema时这两格不能自由改写，旧无schema项目继续原编辑方式，不自动迁移。

schema目标使用稳定shotId、variantId及field="shotSchema"读取、编辑与批注；不以数组索引持久化关联或批注。edit-cell的value和expectedValue为规范JSON字符串，服务端解析、校验后保存对象，仍用baseRevision与expectedValue保护冲突；网页表单负责序列化。通过现有cell-comment/range-comment/pending/commentResponses记录原值、版本和前后差异，无新endpoint。Agent patch的values.shotSchema传对象；有schema时不要另改其派生characters、pose或人物/参考数组。

## 角色、场景与三视图

productionInventory={characters,locations,notes}。角色/场景共用id/version/shotIds/name/description/basis；每项必须有name/description/basis。角色可增加identity/age/face/skin/hair/build/clothing/traits；场景可增加layout/props/materials/environment，均为字符串。

id是稳定标识，不随名字或排序变化。旧清单缺ID时内存赋予CHAR_001/LOC_001等ID，第一次保存持久化；旧原始快照保留。旧项无shotIds时修改按全部镜头保守处理，Agent应登记实际关联，不能靠名称猜测关系。

promptSections保留id/category/title/shotIds/tags/options/rationale/prompts/version/origin，prompts为1–10项{label,text}；新增assetIds关联角色/场景。角色、角色三视图、场景三视图、风格内容独立保存，叙事画面与运镜仍属于variant。改资产时其shotIds、variant.characterAssetIds及关联section依赖待同步，其他镜头保留；改名不改变关联。

补充静帧使用category=shotFrames，必须提供variantId，shotIds恰好一个且该拍法存在；assetIds关联本帧实际人物及场景。主帧继续用variant.staticPrompt；快切的后续帧、表情末帧分别用独立section，不能新增成另一互斥拍法。其他category禁止variantId，旧数据无需迁移。其编辑、批注、同步与审批仅影响绑定拍法；generation-request使用shotFrames时须带variantId。sectionEdits可新增或定向更新上述字段，单元格仍用sectionId及prompts.N.text/label。

exports/static-prompts.md是全量静态阅读版：无须选择就展示所有镜号/拍法主帧、绑定补充帧以及全部sceneViews。网页直接使用原variant/section字段，不复制Prompt。selected-prompts.md仍只表示已选内容，不能拿它判定全片是否已创作。

逐镜答题沿用select动作，保存成功后导航，不触发approve或生图。当前镜用稳定shotId保存在浏览器本地；用户答案仍仅保存在shot.selectedVariantId。回看同一已选方案不重复select，避免清除已有审批。批注仍精确关联原variant/section及字段，未提交草稿跨镜保留；所有镜已选择和所有镜已确认分别统计。

所有项目的创作内容边界见[角色设定与分镜引用](production-framework.md#角色设定与分镜引用)：Agent先建立或复用productionInventory.characters的稳定id及项目内唯一name，再在variant.staticPrompt和breakdown.characters使用实际名称；唯一名称与别名消歧由Agent核对，准备批次会拒绝重复名称，显式人物映射必须引用已登记资产。完整人设留在角色资产及三视图；分镜可写其中本镜必要的可见外貌与服装，逐人写位置、朝向、姿态、手部、视线、表情和道具，再写关系及必须同时可见者。不得臆造外貌、参考绑定、复制整套人设或通过隐藏Prompt另行拼接。新创作、修订、批注、导出和提交均遵守，样例人物名不是通用默认值。

资产shotIds记录镜头关联，variant.characterAssetIds记录方案实际入镜人物，section.assetIds关联独立Prompt，variant.referenceIds关联实际附件；参考记录可选assetIds显式关联已有资产，资产ID不能充作参考图片ID。新增关联不创建图片，也不意味着已视觉核验。资产更名按稳定ID逐项审核，原始记录与快照不替换。外观变化触发的待同步表示需核对关联，不要求将外观文字复制进分镜。提交清单将名称、稳定资产ID、三视图图片参考分开保存。

## 单元格接口

GET /api/project读取完整状态；POST /api/action使用同源Origin、baseRevision和type。新操作：

- edit-cell：target/value/expectedValue。value是文本，秒数单元格转换为正数或null；expectedValue必须匹配当前单元格内容。成功返回完整状态。
- cell-comment：target/text/expectedValue。保存真实目标、contentVersion、baseRevision、originalText和时间，初始pending。
- range-comment：targets为{target,expectedVersion}数组，另带text。逐项校验白名单与内容版本，并在全局baseRevision保护下一次保存为共享groupId的单格批注。任一项冲突整批不保存，浏览器保留草稿；不允许部分提交后隐瞒失败。
- resolve-cell-comment：commentId，由用户标为resolved；不代替方案确认。
- resolve-comment-group：groupId，由用户将该组批注标为resolved；不代替镜头采用或确认。
- prepare-image-batch：shotIds为不重复的镜头ID数组，准备批准方案的本地静态图清单，约束见下节；不调用模型或远端画布。

target白名单形状：

```json
{"kind":"shot","shotId":"S001","field":"workingScript"}
{"kind":"variant","shotId":"S001","variantId":"A","field":"breakdown.continuity"}
{"kind":"variant","shotId":"S001","variantId":"A","field":"shotSchema"}
{"kind":"asset","assetType":"characters","assetId":"CHAR_001","field":"skin"}
{"kind":"section","sectionId":"VIEW_SON","field":"prompts.0.text"}
```

shot允许displayNumber/workingScript/suggestedDuration/purpose/scene；variant允许title/description/rationale/staticPrompt/motionPrompt、shotSchema与breakdown内上述字段，包括continuity；asset仅允许对应角色/场景文本字段；section允许title/rationale及合法索引的prompts.N.label或text。有breakdown的staticPrompt仍可读取、批注，但不能独立改写；写入与派生串不一致的文本会被拒绝。有shotSchema时breakdown.characters和pose同样只读，人物与道具改源schema。禁止任意JSON路径、来源改写或关联ID文本编辑。camera批注精确到子项，continuity与shotSchema沿用现有字段操作，无新endpoint。

批注有pending/addressed/resolved三种状态。新批注用target与originalText；旧批注保留shotId/variantId/variantVersion/category，按整方案读取。范围只是共享groupId的逐格记录，不用屏幕坐标或排序索引持久化；每格仍有独立ID、基线与处理状态。编辑目标后仍保留提交时原文，切换方案或排序不改写历史定位。整组进度由成员状态得到，部分addressed不能把其余pending隐藏或标为已回应。

## Agent patch

入口：node <skill>/scripts/project.mjs apply <project> patch.json。

- baseRevision、reason必填。
- edits沿用{shotId,variantId?,values,addVariants?,resolveCommentIds?}；只提交变化字段，有schema时用values.shotSchema对象维护人物/道具/关系，人物与参考数组由程序投影；旧无schema时可用values.characterAssetIds维护。static模式完整同步提供核对后的breakdown及需要变更的shotSchema，程序派生staticPrompt，不需透传历史motionPrompt；static-motion还需motionPrompt。本轮不创作视频Prompt。新增有breakdown的方案可省略staticPrompt；兼容携带时须等于派生值。
- cellEdits为{target,value}数组，白名单同用户单元格；框架格改动立即重组静态Prompt，static模式不新增普通框架待同步；已存在的工作稿/目标/资产语义待同步仍保留。static-motion仍需核对动作。
- assetEdits为{id,assetType,values}，values允许对应文本字段及shotIds；版本递增，相关镜头及独立Prompt待同步。
- sectionEdits定向更新或新增内容，允许assetIds；提交完整核对的prompts会解除该section的待同步。
- commentResponses为{id,text,unchanged?}。程序核对批注目标字段是否实际变化；未变时必须明确unchanged:true并说明理由。保存reply、before、after及回应版本，状态为addressed。
- project允许title/aspectRatio/targetDuration/brief/promptMode/staticPromptFormat/tags/tagOptions/sharedConstraints/reviewIssues/visualReview/productionConstraints/productionInventory；全局改动影响现有审批，局部修订不重新提交这些默认值。
- references仅允许role/visualStatus/observations/usage/uncertainties及assetIds；assetIds引用已存在的角色/场景资产，实际看图后才设reviewed。

```json
{
  "baseRevision": 8,
  "reason": "按单格批注补充连续性限制并核对Prompt",
  "cellEdits": [{
    "target": {"kind":"variant","shotId":"S002","variantId":"B","field":"breakdown.continuity"},
    "value":"沿用前镜座位与杯子归属，两人都须可见。"
  }],
  "commentResponses": [{"id":"实际批注ID","text":"补充座位、道具归属和同框限制，派生静态Prompt已同步。"}]
}
```

上述最小patch只改目标字段并重组静态文本，不自动确认方案，也不清除其他语义待核对项；完整核对应使用edits提交breakdown，static-motion另需动作文本。已回应不等于用户解决、采用或确认。

pending只读返回revision、promptMode、comments、generationRequests和needsSync；范围批注逐格返回并保留groupId与基线，continuity按同一字段流程读取和回应。needsSync定位待同步variant或section并提供版本。工作稿、目标或共享资产变化仍需Agent核对框架，程序只拼接，不替代导演判断。有框架时edit-prompt只接受完全相等的派生文字用于用户显式核对，不能写另一套静态文本；无框架旧方案沿用独立编辑与同步。批准门槛同时检查目标批注和关联共享Prompt。

## LibTV静态图提交清单

POST /api/action的prepare-image-batch及命令行 `prepare-batch <project> <shotIds逗号分隔>` 共用准备流程。网页默认选当前顺序前三镜，每镜只取已采用方案，不包含A/B/C全部备选。指定镜头必须属于当前项目；准备前检查全片所有镜头已选定、已批准当前版本，且没有任何pending批注、pending修改请求或needsSync内容，不能只检查本批前三镜。

项目imageBatches保存准备快照；status为prepared或stale，executionStatus固定not_submitted。prepared表示本地已准备，全片内容、资产、参考或审核依赖变化后标为stale，原冻结内容保留。清单包含镜头/方案稳定ID、版本、当前格式的派生静态Prompt、有效共享约束及所用参考附件和哈希。characterAssets根据variant.characterAssetIds记录实际入镜资产，只存id/name/version，不额外复制外观字段；characterReferences按显式图片关联记录ready或pending_reference。旧方案没有characterAssetIds时characterAssets为空，characterMappingStatus为needs_review，shot.characters仅列为待核对候选，不假定全部入镜。不得通过共享文本额外拼入整套人设。

item.additionalFrames冻结该已选拍法的shotFrames：sectionId/version/promptIndex/label/text及资产id/name/version。补充帧的独立图片参考尚未绑定时referenceStatus=pending_reference，不自动继承主帧的人物图片；执行前须逐帧核对，不能把清单当生成已完成。

仅从variant.referenceIds提取已reviewed且用途为人物、场景、风格、构图或道具的生图参考；平台标识和叙事结构参考排除并注明原因。实际附件须存在于项目内且哈希一致。人物图片的reference.assetIds必须非空，且全部包含于该方案characterAssetIds，才纳入清单；含未入镜人物的组合参考也排除。缺有效图片的入镜角色标pending_reference。只有三视图Prompt不能当作已有图片。修改参考的资产映射或用途时，引用该附件的已采用方案需要重新审核。

model、quantityPerShot、targetProject初始为null，模型、数量、目标画布与实际输出规格留待执行前确定；交付目标不承诺等于平台原生生成规格。准备清单不扩大生成授权，不表示远端任务已提交。本版不含LibTV生成调用、远端任务ID轮询或后台队列。

exports/libtv-batch.json与libtv-batch.md导出最新批次；无批次时对应HTTP入口返回404并提示先完成全片审核。不能手改导出代替权威状态；重新准备走同一入口，项目JSON保留旧批次及其状态。

## 兼容、冲突与导出

GET `/api/export.xlsx` 只读导出当前已选方案，响应为XLSX二进制及带项目名、“已选分镜”和日期的attachment文件名。与`/api/project`使用相同loadProject及composeStaticPrompt；从项目全部镜号逐镜核验selectedVariantId必须匹配现有方案，未选完返回422及缺少的镜号。仅选择足够，不以approve、promptNeedsSync或图片生成状态为前置。两张表分别为“分镜总览”（每镜一行，仅当前方案框架，保留脚本工作稿、导入原稿与附属字段）及“总共的Prompt”（当前方案主静帧及匹配variantId的补帧；无variantId的独立静态Prompt仍包含）。不取DOM或浏览器视图，不导出未选备选、其补帧或旧视频文字。文本显式字符串，编号保留前导零，秒数等保持数值；实际CRLF/CR在切列前统一为LF，不折叠换行或行内容。超长文字用有序续列完整保留，禁止静默截断。空项目返回422及简短提示。工作表冻首行、自动换行、设置列宽；关联参考图保留路径及链接，不嵌入或外发图片。该接口不更新revision、不落地改写project或Markdown导出。

原有操作project-tags、shot-settings、select、approve、edit-prompt、comment、resolve-issue、edit-section、generation-request、edit-breakdown、production-constraints仍可读取/使用。旧tagGroups与分类请求保留兼容，不做前置交互。generationRequests仍绑定目标、内容版本及范围；resolveRequestIds必须有匹配结果，完整production请求需框架及当前模式要求的Prompt。

409后保留草稿，读取新状态、比较基线与当前值，再明确提交；不得仅抬高baseRevision。网页串行写入，快速输入不丢弃；草稿与未提交批注保存在浏览器本地，不能据此宣称已进入JSON。

遗留写锁先核对写入者与临时文件，不自动清锁。服务只监听本机，内容上限256KB，文件读取限定参考/导出白名单。

exports包含storyboard.md（原稿/工作稿、完整框架、资产细节、批注差异）、selected-prompts.md、pending-comments.md（待处理批注/范围与请求/同步）、project.json，以及批次准备后的libtv-batch.json/.md。静态模式的阅读导出不展示历史视频Prompt，JSON和历史保留完整数据。附件保持相对路径，完整交接必须包括实际附件。
