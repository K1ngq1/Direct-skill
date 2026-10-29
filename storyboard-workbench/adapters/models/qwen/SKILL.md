---
name: qwen
description: 本项目导演流程的阿里 Qwen 模型层薄入口，仅在已有 Agent 宿主使用 Qwen 系列时加载其结构输出与工具差异，不配置或调用模型 API。
---

# Qwen 模型层

这里的 Qwen 是阿里模型层，不是 Qwen Code 等宿主。先读取[共用导演 Skill](../../../SKILL.md)及[适配说明](../../README.md)，不另维护导演规则。

在仓库根加载当前阶段，实际宿主已知时将 `default` 换为对应 adapter：

```text
node "storyboard-workbench/scripts/runtime.mjs" rules prompt --adapter default --model qwen
```

以下依据阿里云百炼官方接口文档；其他托管服务须重新核对，不自行切换服务或参数：

- **结构输出：**JSON Object 只约束合法 JSON，JSON Schema 才约束指定结构；两者支持的模型与思考模式范围不同。不能由“Qwen”或请求未报错推定 Schema 已生效，仍使用项目硬校验。[结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)
- **视觉与结构的组合：**当前文档说明多模态输入下 `json_schema` 会降级为 `json_object`，Schema 约束不生效。处理参考图片时记录实际输入与结构能力，不能将纯文本路径的保证套到图片请求。[多模态结构输出限制](https://help.aliyun.com/zh/model-studio/qwen-structured-output)
- **工具与图片回传：**Function Calling 返回名称和入参，函数由宿主执行；模型也可能直接返回普通回复。工具结果中的图片须通过内容数组的图片部分传入，普通字符串里的图片 URL 不会按图片解析；不能把工具请求当执行成功或视觉证据。[Function Calling](https://help.aliyun.com/zh/model-studio/qwen-function-calling)

只记录本次宿主真实暴露的能力；型号、限制、服务地域与托管差异不固化在此。失败及脚本不可执行时的处理沿用适配说明。

核对日期：2026-10-19。以上为官方文档核对；规则装载不是模型或宿主实测，本文没有调用模型、验证账户或修改 API 配置。

本薄入口依赖完整仓库的共用 Skill、规则、脚本和合同，不能单独复制安装。
