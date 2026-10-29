---
name: storyboard-workbench
description: Use this repository's shared storyboard Skill to create and validate linked prompts and an editable Excel deliverable.
---

# Claude Code 适配入口

读取[项目约束](../../../AGENTS.md)与唯一[共用 Skill](../../../storyboard-workbench/SKILL.md)，按其阶段索引执行；[宿主差异](../../../storyboard-workbench/adapters/claude-code.md)仅处理接入。本入口依赖完整仓库，不单独复制到全局目录。

在仓库根执行 `node "storyboard-workbench/scripts/runtime.mjs" rules ingest --adapter claude-code`，后续替换实际阶段。已知模型追加 `--model`，未知用 default；模型与 API 由宿主配置，能力按实际观察记录。