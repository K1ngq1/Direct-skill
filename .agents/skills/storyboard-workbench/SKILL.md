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
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter codex
node "storyboard-workbench/scripts/runtime.mjs" rules review --adapter codex
```

按共用 Skill 切换后续阶段，读取命令列出的规则。模型由宿主配置；按已知实际模型选择注册表中的 `--model`，例如 OpenAI 用 `--model openai`、GLM 用 `--model glm`，未知用 `default`。实际能力按观察记录，不能由名称推定；无法执行时保留待校验 JSON 并标“未执行硬校验”。

创作与独立核对均按对应阶段读取[共用表达规则](../../../storyboard-workbench/references/prompt-language.md#四步表达核对)，具体要求只在共用文件维护。上述命令沿用默认模型；实际已知时按适配说明追加 --model。
