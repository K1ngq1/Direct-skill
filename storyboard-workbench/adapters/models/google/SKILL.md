---
name: google
description: 本项目导演流程使用 Google Gemini 模型层或显式选择 --model google 时读取；只补充结构输出、工具调用与图片输入差异，共用导演规则仍由 canonical Skill 提供。
---

# Google 模型层

先读取 [canonical Skill](../../../SKILL.md)，按当前阶段装载共用规则；宿主选择与能力记录见[适配说明](../../README.md)。Gemini 模型不等于 Agent 宿主：文件读写、脚本执行和图片传入能力由本次实际环境确认。

从仓库根执行：

```text
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter default --model google
```

## 差异处理

- Structured outputs 支持 JSON Schema 的子集，过大或过深的结构可能被拒绝。原生结构输出不保证字段值的语义正确；宿主已有结构输出适配时复用它，项目关联、来源和完整性仍交给共用校验器。
- Structured outputs 用于约束最终回复，function calling 用于请求应用执行动作。不能把函数调用请求当成导出完成，也不能因工具参数合格就跳过最终创作 JSON 的检查。
- 图片理解要求宿主实际传入支持的图片输入，例如内联图片数据或 Files API 引用。文字中的本地文件名不等于图片已传入；未观察到有效输入和结果时，将图片理解能力记为未知，不声称已看过参考图。

## 使用边界与来源

这是随完整仓库使用的薄模型 Skill，不能只复制本目录作为完整导演 Skill；不复制共用导演规则，不新增 API 调用，也不切换实际模型。规则装载成功只证明文件已提供，不代表真实模型已验证。

官方资料核对日期：2026-10-19。[Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)（schema 支持范围、语义限制及与 function calling 的区别）；[Image understanding](https://ai.google.dev/gemini-api/docs/image-understanding)（图片输入方式）。
