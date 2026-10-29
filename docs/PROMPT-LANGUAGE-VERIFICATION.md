# Prompt 表达规则实施与验证边界

更新日期：2026-10-29。共用表达规则已实现并接入创作和独立评审；本次小样本没有验证出质量提升，质量验收仍待通过。

## 规则入口与职责

- [表达规则](../storyboard-workbench/references/prompt-language.md#四步表达核对)维护人物、场景、静帧与视频的四步核对及关系检查，具体判断不复制到平台入口。
- [视频规则](../storyboard-workbench/references/video-workflow.md#视频正文参数与声音)补充动作交接、运动分工、风格与定格边界。
- [阶段清单](../storyboard-workbench/references/rules-manifest.json)在 prompt 与 review 阶段加载同一表达文件；独立评审须读取实际正文，文件哈希只证明提供的版本。
- [项目规则](../AGENTS.md)、[共用 Skill](../storyboard-workbench/SKILL.md)、[适配说明](../storyboard-workbench/adapters/README.md)与各平台薄入口共同引用上述资源。

运行方法：

```text
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter codex --model openai
node "storyboard-workbench/scripts/runtime.mjs" rules review --adapter codex --model openai
node --test "storyboard-workbench/tests/runtime.test.mjs" "storyboard-workbench/tests/release.test.mjs"
```

adapter/model 按实际环境选择；省略则沿用 default，不建立 API 连接或切换实际模型。不能执行时标记“未执行硬校验”，不能把读取入口视为已完成语义核对。

## 已实现的要求

四步核对内明确语言歧义、设计缺口与事实冲突的区别，集中处理动作归属、修饰范围、信息轻重及等义保真。关系检查覆盖主体与动作、空间与方向、动作与可见范围、摄影与清晰范围、光线与材质。

已清楚的正文保留；新增拍法或布局属于导演补全，不能以润色名义覆盖用户锁定要求。视频分别交代人物、摄影机与环境变化，尊重固定机位、超现实与定格意图。完整细则以规则入口为准。

没有新增 API、CLI、生产 JSON 字段或评分维度。schemaVersion、rulesVersion 与十一维评分沿用原合同，内容哈希记录规则差异；历史项目不自动迁移、重写或重评分。没有安装远端 Skill，也没有引入通用负面词、固定字数或强制模型语言表。

## 本次实际验证

使用八个原创虚构任务，先冻结任务、事实与检查点，再分别用旧规则、新规则运行。两组使用独立上下文与继承的 gpt-6.1-sol，每组仅运行一次；温度、seed 和 reasoning effort 未暴露，不能声称这些值已完全控制。

冻结输出后逐题随机交换 A/B，由不读取版本映射的独立模型评审核对事实、关系与语言，结论附可回查的文本引文。未使用私人原稿、案例、图片、人评或 style.md；模型评审不等于人类验收。

| 验证项 | 实际结果 |
|---|---|
| 首次匿名对照 | 八组中七组持平，一组新规则退步；没有明确改善组 |
| 退步原因 | 信封交接样本遗漏“不补其他动作”的限制 |
| 局部修复 | 仅补回该限制，首次输出与评审原件保留；修复未重新盲评、不计为胜场 |
| 正确文本控制 | 人物稿与超现实定格稿在两组均逐字保留 |
| 规则装载与运行时 | 当次 prompt/review 正文与哈希核对通过，runtime 测试16项通过 |
| 质量提升门槛 | 六个问题样本至少三组改善且无退步；未达到，仍待验收 |

本地原始证据保存在 artifacts 下的 prompt-language-eval-20261029 目录，含规则快照、任务、原始输出、匿名材料与映射、评审、局部修复、差异和核对记录。该目录是验收材料，不是发布包运行依赖；本文只保留可移交的结果摘要。

## 适用范围

结果仅涉及本机单模型、单轮、八个合成文本任务，未估计随机波动，未验证跨模型迁移、图片或视频生成效果，也未验证完整生产项目的最终创作质量。

后续文档链接与入口同步不等于重新完成语言对照；冻结快照对应其原始时间点。规则已实现、程序检查通过与质量提升获验证是三个不同结论，不能互相替代。
