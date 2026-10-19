# Codex 适配

用于 Codex 本地工作环境。实际模型、沙箱、文件权限和可用工具以当前会话为准；只读取本文件不表示那些能力已经验证。共用业务入口是 [Skill](../SKILL.md)，通用降级见运行时先加载的 `default.md`。

## 规则与 Skill 加载

Codex 按项目根至当前目录的路径组合项目指令，更靠近当前目录的规则覆盖较早规则；配置的 override、文件名与大小限制会影响结果。原生 Skill 发现使用项目 `.agents/skills/<name>/SKILL.md`，与 `AGENTS.md` 加载是两件事。[官方项目指令](https://developers.openai.com/codex/guides/agents-md)、[官方 Skill](https://developers.openai.com/codex/skills)。

最小使用方式是在仓库根开启会话，明确要求“读取 storyboard-workbench/SKILL.md，并用 codex 适配按阶段执行”。本仓库 `.agents/skills/storyboard-workbench/SKILL.md` 是仅定位 canonical Skill 的薄入口，须保留相对目录关系；Codex 也支持 Skill 目录符号链接。不要同时维护两份业务规则，或只把裸入口复制到另一项目。已发现的 Skill 可通过当前客户端的 Skill 选择器调用，CLI/IDE 支持 `$storyboard-workbench`。

```text
node "storyboard-workbench/scripts/runtime.mjs" doctor
node "storyboard-workbench/scripts/runtime.mjs" rules plan --adapter codex
```

## 执行差异与证据

- 用本会话已有文件和终端工具执行共用脚本；写入、网络与工具操作仍受实际宿主权限约束，不因 Skill 声明就视为可用。
- 正文通过文件写入工具保存为 UTF-8；脚本完成状态和实际输出才是检查证据。若工具返回继续运行的任务，等待实际完成后记录结果。
- `--adapter codex` 记录显式宿主选择，不自动确认图片理解、工具调用或任何具体模型版本；这些能力逐项填实际观察。
- 本项目的本地脚本可在 Codex 工作环境中执行检查，具体结果以对应版本的验收记录为准。此证据不覆盖其他机器、云环境、权限配置或真实模型的画面质量。

官方入口核对日期：2026-10-19。没有本次运行证据的能力保持 `unknown`；内容校验与错误处理仍使用共用脚本。
