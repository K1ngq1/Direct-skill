@AGENTS.md

本项目导演流程的唯一 Skill 正文是 `storyboard-workbench/SKILL.md`。执行相关任务时先读取该文件，再按 `storyboard-workbench/references/rules-manifest.json` 加载当前阶段规则。Claude Code 运行说明见 `storyboard-workbench/adapters/claude-code.md`；模型和 API 连接继续使用用户已有配置。

创作与独立评审分别加载 prompt / review 阶段，两者均读取[共用表达规则](storyboard-workbench/references/prompt-language.md#四步表达核对)。规则与验收边界见[项目 README](README.md)，本兼容入口不复制规则正文。
