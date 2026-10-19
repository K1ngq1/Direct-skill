---
name: storyboard-workbench
description: Turn a script into linked characters, scenes, storyboard prompts and an Excel table using this repository's shared workflow and local validation.
---

# Codex 项目入口

先读取[项目规则](../../../AGENTS.md)和[共用 Skill](../../../storyboard-workbench/SKILL.md)，再按[Codex 适配](../../../storyboard-workbench/adapters/codex.md)执行当前阶段。本文件所在目录向上三级是仓库根；已在仓库根时不要再向上定位。此入口依赖完整仓库相对关系，不单独复制到全局目录。

在仓库根执行启动检查，并显式选择宿主：

```text
node "storyboard-workbench/scripts/runtime.mjs" doctor
node "storyboard-workbench/scripts/runtime.mjs" rules ingest --adapter codex
```

按共用 Skill 切换后续阶段，读取命令列出的规则。模型由宿主配置；仅在已知采用 GLM 时附加 `--model glm`。实际能力按观察记录，不能由名称推定；无法执行时保留待校验 JSON 并标“未执行硬校验”。
