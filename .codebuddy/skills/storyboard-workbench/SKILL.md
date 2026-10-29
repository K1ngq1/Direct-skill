---
name: storyboard-workbench
description: Use the shared storyboard workflow to create linked character, scene and shot prompts, validate local JSON, and deliver an editable Excel table.
---

# WorkBuddy 项目入口

先读取[项目规则](../../../AGENTS.md)和[共用 Skill](../../../storyboard-workbench/SKILL.md)，再按[WorkBuddy 适配](../../../storyboard-workbench/adapters/workbuddy.md)执行当前阶段。本文件所在目录向上三级是仓库根；已在仓库根时不要再向上定位。此入口依赖完整仓库相对关系，不单独复制到全局目录。

在仓库根执行启动检查，并显式选择宿主：

```text
node "storyboard-workbench/scripts/runtime.mjs" doctor
node "storyboard-workbench/scripts/runtime.mjs" rules ingest --adapter workbuddy
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter workbuddy
node "storyboard-workbench/scripts/runtime.mjs" rules review --adapter workbuddy
```

按共用 Skill 切换后续阶段，读取命令列出的规则。WorkBuddy 客户端及实际模型的工具能力需在本次运行验证；无法执行时保留待校验 JSON 并标“未执行硬校验”。模型规则按实际配置显式选择，不接管 API，也不授权额外媒体任务。

创作与独立核对均按对应阶段读取[共用表达规则](../../../storyboard-workbench/references/prompt-language.md#四步表达核对)，具体要求只在共用文件维护。上述命令沿用默认模型；实际已知时按适配说明追加 --model。
