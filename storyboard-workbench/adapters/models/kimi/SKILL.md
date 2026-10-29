---
name: kimi
description: 本项目导演流程的 Moonshot Kimi 模型层薄入口，仅在已有 Agent 宿主使用 Kimi 系列时加载其 JSON、工具与视觉差异，不配置或调用模型 API。
---

# Kimi 模型层

这里的 Kimi 指 Moonshot AI 模型层，不代表 Kimi Code 或其他宿主。先读取[共用导演 Skill](../../../SKILL.md)及[适配说明](../../README.md)，不复制人物、场景或分镜规则。

在仓库根加载当前阶段，实际宿主已知时将 `default` 换为对应 adapter：

```text
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter default --model kimi
```

按当前宿主和实际服务暴露的能力处理下列差异，不自行配置或发起 API 请求：

- **JSON 输出：**官方区分提示“输出 JSON”与通过 `response_format` 启用 JSON Mode；仅有提示词仍可能返回额外说明或错误格式。JSON Mode 不作为本项目字段、关联及语义检查的替代。[JSON Mode](https://platform.kimi.com/docs/guide/use-json-mode-feature-of-kimi-api)
- **工具回合：**一轮可能包含多个 `tool_calls`，每个都需对应正确 `tool_call_id` 的工具结果；`finish_reason=tool_calls` 时仍可能有普通说明文本。说明不是最终完成结果，缺失或错配应记录工具链错误，由宿主处理。[工具调用](https://platform.kimi.com/docs/guide/use-kimi-api-to-complete-tool-calls)
- **视觉输入：**图片能力属于实际视觉模型与输入通路；官方示例将图片通过 `image_url` 内容块传入，并支持 base64、URL 或文件上传方式。只读到文件名不能宣称已经理解图片，文本托管通路也不能由 Kimi 名称推定支持视觉。[视觉输入](https://platform.kimi.com/docs/guide/use-kimi-vision-model)

具体型号、上下文限制与托管服务差异按本次环境核对。能力记录、失败分类及无法执行脚本时的降级沿用适配说明。

核对日期：2026-10-19。以上为官方文档核对；规则装载不是模型或宿主实测，本文没有调用模型、验证账户或修改 API 配置。

本薄入口依赖完整仓库的共用 Skill、规则、脚本和合同，不能单独复制安装。
