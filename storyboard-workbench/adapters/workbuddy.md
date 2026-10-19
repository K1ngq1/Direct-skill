# WorkBuddy 适配

用于 WorkBuddy 的项目工作目录与本地工具，不将其他 CodeBuddy 产品的能力直接当作 WorkBuddy 实测结论。共用业务入口是 [Skill](../SKILL.md)，本文件只说明 WorkBuddy 的加载差异。

## 入口

WorkBuddy 自身官方项目文档明确：代码开发项目可读取 `.codebuddy/rules/`、`.codebuddy/skills/<name>/SKILL.md` 等项目配置，兼容 `AGENTS.md`；项目配置的 Skill 与项目指令也可供项目任务使用。[WorkBuddy 官方项目说明](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Project)。

在 WorkBuddy 打开能访问本仓库的项目工作目录，先明确要求读取 `storyboard-workbench/SKILL.md`。本仓库 `.codebuddy/skills/storyboard-workbench/SKILL.md` 是仅定位 canonical Skill 的薄入口；保留相对目录关系，不把裸入口复制到其他项目，不复制整套业务规则。不同客户端界面的“项目资料/技能”不一定等同本地工作目录，先核对任务能否读取完整 Skill 及输入文件。

```text
node "storyboard-workbench/scripts/runtime.mjs" doctor
node "storyboard-workbench/scripts/runtime.mjs" rules plan --adapter workbuddy
```

`--adapter workbuddy` 显式选择宿主说明，不安装 WorkBuddy、不验证登录状态，也不由目录名推断模型。

## 能力与失败

- 文件读写、终端、图片理解和工具调用按当前任务实际暴露能力记录。不要把项目配置支持推定为 Node/Python 或任意模型工具调用一定可用。
- 支持本地终端时执行共用脚本和字段校验；不支持时按 `default.md` 提供待校验 JSON 与终端命令，明确“未执行硬校验”。
- 模型未知保持默认；仅明确接入 GLM 时增加 `--model glm`，不根据 WorkBuddy 名称或界面推测服务端模型。
- 官方文档入口已核对（2026-10-19）；本版未启动 WorkBuddy 客户端，未验证其自动载入、脚本执行或最终创作质量。静态注册与模拟输出测试只能证明本项目适配合同。

具体安装客户端和项目配置按上述 WorkBuddy 自身官方入口操作。本适配不要求用户运行其他 CodeBuddy 产品，也不声称下载此仓库即可在所有 WorkBuddy 会话自动生效。
