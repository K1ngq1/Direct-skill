# GLM 可选模型层

GLM 是模型系列，不是文件或工具运行宿主。先选择真实 Agent，再按已经配置的模型决定是否加入本层；共用业务规则和输出合同仍来自 [Skill](../SKILL.md)。

```text
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter claude-code --model glm
```

该命令只装载说明，不调用模型、配置 API、选择模型版本或消耗生成额度。不要用 `--adapter glm` 代替宿主选择；宿主无法确定时使用 `--adapter default --model glm`。

## 差异处理

- 智谱官方提供在 Claude Code 中使用 GLM 的接入说明。既有 API 配置由用户管理；不同产品的端点、凭据与计费不能互相假定，也不把 Codex 订阅当作 GLM API 额度。[官方接入说明](https://docs.bigmodel.cn/cn/guide/develop/claude)。
- 记录宿主实际暴露的模型标识；界面显示的 Claude 别名可能经过服务端映射。`run.model: "glm"` 仅表示选择的系列，不能作为真实版本探测结果。
- 结构化输出和工具调用取决于具体模型、API 路径及宿主兼容层。官方 JSON 模式说明要求使用支持该能力的模型，不能据此假定所有 GLM 会话均支持原生 Schema 或工具调用。[结构化输出](https://docs.bigmodel.cn/cn/guide/capabilities/struct-output)、[工具调用](https://docs.bigmodel.cn/cn/guide/capabilities/function-calling)。
- 本流程接受 Agent 写出的普通 JSON 文件，不要求新增 API 参数。字段、稳定 ID 与来源照共用合同保存；Prompt 字段仍是自然语言，不能为满足 JSON 输出而改成关键词堆砌。
- 按阶段读取规则、在文件中保留生产状态；上下文容量与截断由当前模型实际反馈决定，不硬编码系列级上限。发生截断、解析错误或工具拒绝时保留原始输出及错误，按共用有限修复边界处理。
- 图片理解没有实际证据时保持未知；不能用文本推断冒充看图。网络失败、不支持能力和内容问题分别报告，不以换模型名称伪造成功。

官方资料核对日期：2026-10-19。本版没有调用 GLM API，也没有比较模型输出质量；模型层的注册和装载测试不等于接入成功或画面质量验证。