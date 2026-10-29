---
name: deepseek
description: 本项目导演流程的 DeepSeek 模型层薄入口，仅在已有 Agent 宿主使用 DeepSeek 系列时加载其结构输出、工具与视觉差异，不配置或调用模型 API。
---

# DeepSeek 模型层

本入口用于模型层选择，不是 Agent 宿主。先读取[共用导演 Skill](../../../SKILL.md)及[适配说明](../../README.md)，导演规则与字段合同只引用共用版本。

在仓库根加载当前阶段，实际宿主已知时将 `default` 换为对应 adapter：

```text
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter default --model deepseek
```

按当前宿主暴露的能力处理下列差异，不自行配置请求参数或另接 API：

- **JSON 输出：**官方 JSON Output 要求提示中包含 JSON 并说明期望格式；还明确提示可能返回空内容或被截断。仅能解析不表示符合项目合同；空响应、截断分别保留为实际失败，不当成完成稿。[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)
- **工具约束：**工具调用的 `strict` 模式有独立启用条件，服务端只接受其支持的 JSON Schema 子集；不能把普通工具调用当作已启用 strict，也不能假定宿主透传了该能力。[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)
- **视觉输入：**官方视觉接口要求实际图片内容块，Chat Completions、Responses 与 Anthropic 格式各有表示方式。先确认当前模型与宿主支持的输入通路；只出现文件路径或文字链接不算已经看图。[Vision](https://api-docs.deepseek.com/guides/vision/)

具体型号、限制和第三方托管差异按当前服务核对，不由系列名推定。能力记录、失败分类及无法执行脚本时的降级沿用适配说明。

核对日期：2026-10-19。以上为官方文档核对；规则装载不是模型或宿主实测，本文没有调用模型、验证账户或修改 API 配置。

本薄入口依赖完整仓库的共用 Skill、规则、脚本和合同，不能单独复制安装。
