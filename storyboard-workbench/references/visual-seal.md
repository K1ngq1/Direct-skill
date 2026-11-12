# 新稿封存与文件验收

正文和语义核对完成后读取。正式表结构及文件保护按[Excel 交付合同](excel-delivery.md)，接手已有正式文件时追加[更新与冲突合同](excel-update.md)。

### 封存、检查与局部修订

```text
node "<skill>/scripts/visual.mjs" seal "<project>" "<plan.json>" --brief
node "<skill>/scripts/visual.mjs" deliver "<project>"
node "<skill>/scripts/visual.mjs" verify-excel "<project>"
node "<skill>/scripts/visual.mjs" report "<project>"
node "<skill>/scripts/visual.mjs" validate "<project>"
node "<skill>/scripts/visual.mjs" export "<project>"
node "<skill>/scripts/visual.mjs" revise "<project>" "<request.json>"
```

`seal` 仅接受结构可用的新计划；输入文件不改写。`report/validate` 返回结构化问题，`passed/pending/invalid` 分别表示当前检查通过、有待处理项、存在结构/绑定错误；有问题时退出码非零。每项包含 `category/code/path/entityId/severity/message/requirement`。语法失败保留原始输入，不伪造镜头。仅解析 JSON 不算硬校验；无脚本能力时必须标记“未执行硬校验”，交接同一 JSON 及上述命令到可执行环境。

新项目先创作并核对完整正文，`seal --brief` 初始化默认方案、项目身份与指纹，返回一次汇总的问题和本版 `assetBindings`。把已核对的人物数组与 `assetBindings.characters` 合成 `{...assetBindings.characters, characters}`，场景同理用 `{...assetBindings.locations, locations}`，以仅新建方式分别保存为人物和场景资产文件。已有绑定的资产沿用原版本核对规则。评分、语义证据和正文由评审者提供。

随后执行 `deliver`。它调用原有导出入口并回读实际文件，一次返回计划检查 `validation`、文件验收 `acceptance` 和文件路径。两项均通过才报告验收完成。已导出的项目可单独执行只读的 `verify-excel`，视频项目追加对应的视频修订文件路径。程序按源镜覆盖、秒数、工作表、分组及完整正文集中核对，回报字体换行统计、内部链接数和实际文件回读毫秒数。用户自定排版按已有文件合同保留。规则版本变化仍按计划检查记录，只读复核不会刷新旧评分。

视频规划用 `video.mjs finalize` 一次封存、导出并回读。`export` 继续用于单独导出，`report/validate` 用于诊断。程序检查完成后，按具体镜头、字段或单元格处理问题。模型另行核对人物关系、光线与切点等语义，保留核对者和文本证据。

评分 review 沿用原合同。独立 `semanticReview` 为 `{reviewer,checks:[{rule,status,evidence,reason}]}`；rule 必须完整覆盖 `relationships/staticMoment/lighting/continuity`，status 为 `pass/issue/not-applicable`。核对必须有具体证据和原因；不适用也须说明。程序为显式提交的 review/semanticReview 绑定当前正文与来源哈希；旧核对不因修订自动刷新。AI 核对记录不等于独立人工验收，也不用于证明跨模型迁移成功。
