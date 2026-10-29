---
name: anthropic
description: 本项目导演流程使用 Anthropic Claude 模型层或显式选择 --model anthropic 时读取；只补充结构输出、工具调用与失败处理差异，共用导演规则仍由 canonical Skill 提供。
---

# Anthropic 模型层

先读取 [canonical Skill](../../../SKILL.md)，按当前阶段装载共用规则；宿主选择与能力记录见[适配说明](../../README.md)。Claude 模型不等于 Claude Code 宿主，两者分别选择，不能由模型名推定文件与工具能力。

从仓库根执行：

```text
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter default --model anthropic
```

## 差异处理

- JSON outputs 的 `output_config.format` 约束最终回复；strict tool use 的 `strict: true` 约束工具输入。二者是独立能力，不能由工具参数符合 schema 推定最终创作 JSON 合格；仍运行项目共用校验器。
- 客户端工具由模型发出 `tool_use` 请求，宿主执行后回传 `tool_result`。收到请求不等于文件已写入或脚本已运行；本地读写、硬校验与导出必须以实际工具结果为证据。服务端工具的执行位置也不能证明本地脚本已执行。
- `stop_reason: refusal` 或 `max_tokens` 可能使结构输出不符合预期。分别记录拒绝与截断，不把未完成输出当成完整创作结果或已通过的校验记录。

## 使用边界与来源

这是随完整仓库使用的薄模型 Skill，不能只复制本目录作为完整导演 Skill；不复制共用导演规则，不新增 API 调用，也不切换实际模型。规则装载成功只证明文件已提供，不代表真实模型已验证。

官方资料核对日期：2026-10-19。[Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)（最终回复、严格工具输入与失败状态）；[How tool use works](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works)（客户端工具与服务端工具执行流程）。
