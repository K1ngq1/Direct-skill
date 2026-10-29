---
name: openai
description: 本项目导演流程使用 OpenAI 模型层或显式选择 --model openai 时读取；只补充结构输出与失败处理差异，共用导演规则仍由 canonical Skill 提供。
---

# OpenAI 模型层

先读取 [canonical Skill](../../../SKILL.md)，按当前阶段装载共用规则；宿主选择与能力记录见[适配说明](../../README.md)。模型厂商不等于 Agent 宿主：文件读写、脚本执行和结果回写由实际宿主提供。

从仓库根执行：

```text
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter default --model openai
```

## 差异处理

- JSON mode 只保证 JSON 语法；Structured Outputs 才按支持的 JSON Schema 约束结构。宿主未明确启用对应能力时，不把提示词中的“按 JSON 输出”视为结构保证。项目字段合同仍由共用校验器检查。
- 原生 Structured Outputs 只支持 JSON Schema 的子集；不能把项目说明文档或未经适配的字段合同直接当作服务端 schema。是否支持由实际模型、宿主和调用结果确认，本入口不创建 API 配置。
- 拒绝回答与输出截断可能无法形成要求的完整结构。保留拒绝或未完成状态，分别报告能力、调用或内容问题，不把这类失败算成创作评分，也不宣称本地校验通过。

## 使用边界与来源

这是随完整仓库使用的薄模型 Skill，不能只复制本目录作为完整导演 Skill；不复制共用导演规则，不新增 API 调用，也不切换实际模型。规则装载成功只证明文件已提供，不代表真实模型已验证。

官方资料核对日期：2026-10-19。[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)（JSON mode 区别、schema 支持范围、拒绝与不完整输出）。
