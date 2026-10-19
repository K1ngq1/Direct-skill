# Claude Code 适配

用于 Claude Code，包括 VS Code 官方扩展。共用业务入口是 [Skill](../SKILL.md)；GLM 是可选模型层，按实际配置与本宿主组合，见 [GLM](glm.md)。本项目不修改模型、API、密钥或扩展配置，也不要求已有扩展用户另装 CLI。

## 规则与 Skill 加载

在 VS Code 安装并打开 Anthropic 官方 Claude Code 扩展后，以本仓库作为工作目录；已经安装时沿用现有配置。[官方 VS Code 说明](https://code.claude.com/docs/en/vs-code)。

项目 Skill 的官方目录是 `.claude/skills/<name>/SKILL.md`。本仓库薄入口定位 `storyboard-workbench/SKILL.md`，须保留相对目录关系，不能只将裸入口复制到另一项目；也可在会话中明确要求读取 canonical Skill。原生 Skill 可以用 `/storyboard-workbench` 调用。[官方 Skill 加载](https://code.claude.com/docs/en/skills)。

根 `CLAUDE.md` 保留 `@AGENTS.md` 引用作为兼容入口。最新 Claude Code 文档也描述了原生 `AGENTS.md` 的条件加载；不同版本或已有 CLAUDE 文件会影响结果，所以不能仅凭文件存在推断当前会话已加载。可在当前版本支持时用 `/context` 检查指令文件列表。[官方指令加载](https://code.claude.com/docs/en/memory#agents-md)。

## 执行

从仓库根运行；Shell 路径含中文或空格时独立引用：

```text
node "storyboard-workbench/scripts/runtime.mjs" doctor
node "storyboard-workbench/scripts/runtime.mjs" rules plan --adapter claude-code
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter claude-code --model glm --output "rules-prompt-001.json"
```

最后一条仅在实际使用 GLM 时采用。选项决定附加规则，不建立 API 连接、不切换服务端模型。

使用扩展已有文件与终端工具执行共用脚本。解释器选择以 `doctor` 返回的 `command/args` 为准；需要时按共用运行说明指定现有 `STORYBOARD_PYTHON`，不把个人路径写入本适配或自动安装依赖。Node 的 `runtime.mjs doctor` 是本项目检查命令，不是 Claude 的 `/doctor`。

## 验证边界

官方入口核对日期：2026-10-19。项目入口和规则装载可以做本地文件/契约检查；本版没有运行 Claude Code/GLM 端到端会话。图片理解、工具调用、上下文和结构输出可靠性依赖具体模型与兼容层，保持未知直至实际验证。运行失败按 `default.md` 降级，不能将终端不可用写成模型内容低分。
