---
name: storyboard-workbench
description: Use this project's shared storyboard workflow to turn a script into character, scene and shot prompts, validate local JSON, and deliver the Excel storyboard table.
---

# 项目导演 Skill 入口

这是薄入口，不保存业务规则副本。先读取[项目规则](../../../AGENTS.md)和[共用 Skill](../../../storyboard-workbench/SKILL.md)。若从本入口文件的实际路径定位，项目根目录是本文件所在目录向上三级；不要在项目根目录再向上三级，不要依赖插件替换路径变量，也不要误读其他项目同名 Skill。此入口依赖完整仓库相对关系，不单独复制到全局目录。自动触发不可用时，用户可以明确要求 Agent 手动读取同一 canonical Skill 并执行，规则不变。

按 canonical Skill 的阶段索引读取规则，并参考[Claude Code 适配](../../../storyboard-workbench/adapters/claude-code.md)执行本地命令：

```text
node "storyboard-workbench/scripts/runtime.mjs" doctor
node "storyboard-workbench/scripts/runtime.mjs" rules ingest --adapter claude-code
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter claude-code
node "storyboard-workbench/scripts/runtime.mjs" rules review --adapter claude-code
```

模型规则按实际配置选择，例如 `--model glm`。无法读取文件或执行脚本时报告实际缺失能力；未执行程序校验须明确标注“未执行硬校验”。本入口不配置模型或 API，不授权额外生成、收费调用或批量评测。

图片理解与工具调用能力取决于用户当前模型和宿主实际支持；不能因使用 GLM、Claude Code 或本入口，就宣称已理解附件或支持多模态。

创作与独立核对均按对应阶段读取[共用表达规则](../../../storyboard-workbench/references/prompt-language.md#四步表达核对)，具体要求只在共用文件维护。上述命令沿用默认模型；实际已知时按适配说明追加 --model。
