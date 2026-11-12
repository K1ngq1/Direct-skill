# 媒体执行任务索引

## 共用执行边界

- 只执行本次用户授权的工具、数量和阶段。仅准备或连接节点时显式 `run:false`；测试用本地假回执。
- 用户明确允许通过图片或视频节点提交生成任务时，将对应生成调用的 `run` 设为 `true`，通过该媒体的生成入口按已授权节点、数量及阶段执行，并回读实际任务结果。
- JSON 冻结稿是正文来源。使用原项目、原版本、稳定任务 ID 和幂等键；未知提交先核对原身份，保存失败只恢复原返回结果。审核、文件成功、画面检查和用户确认分别记录。
- 沿用已有队列、上传器与存储，依赖就绪后才占槽。Codex/imagegen 默认生成并发 1，其他工具默认 4；具体参数由对应入口维护。
- 主对话只接收计数、路径及必要异常。完整 Prompt、图片和原始回执留在项目文件，已读且哈希未变的规则沿用本轮记录。
- 不配置模型 API，不迁移旧生成清单或改写已确认素材。沿用 AGENTS 的原件、授权、版本与失败处理要求。

## 按当前任务读取

| 当前操作 | 本次需要的文档 |
|---|---|
| 保存图片请求、执行 Codex/imagegen 批次 | [图片批次](media-image-batch.md) |
| 图片暂停、超时、回执或本地收尾异常 | [图片恢复](media-image-recovery.md) |
| 通过 LibTV 实际提交图片生成 | [LibTV 生成](media-libtv-generation.md) |
| 接手原 LibTV 任务或下载已生成原件 | [原任务恢复与交付](media-libtv-recovery.md) |
| 只建立、连接待运行节点 | [画布会话](media-canvas-session.md) |
| 上传本地图片并建立待运行节点 | [画布会话](media-canvas-session.md)、[原生传输](media-transfer.md) |
| 单次制作的首图验证与持续入画布 | [生产入口](media-canvas-production.md)、画布会话、首次接线的原生传输 |
| 保存或恢复资产库内容 | [资产库](media-assets.md)、首次接线的原生传输 |
| 审核等待、画布未知写入或存储异常 | [画布恢复](media-canvas-recovery.md) |
| 阶段结束、集中回写 Excel | [集中交付](media-delivery.md) |
| 上下文过大、大请求超时 | [控制上下文](media-context.md) |
| 计时、性能分析或离线维护验收 | [计时与验收](media-observability.md) |

首次按任务读取对应正文。下列旧标题保留为历史链接入口，每项定位到唯一正文。

## 控制上下文与及时交付

[对应操作合同](media-context.md)。

## 一次准备，逐张执行

[对应操作合同](media-image-batch.md)。

### Prompt 阶段准备与 Node 存储入口

[对应操作合同](media-image-batch.md)。

### Codex 固定执行入口

[对应操作合同](media-image-batch.md)。

### 阶段切换、暂停与恢复

[对应操作合同](media-image-recovery.md)。

### 计时与 mock 验收

[对应操作合同](media-observability.md)。

## LibTV 生成调度与断点恢复

[对应操作合同](media-libtv-generation.md)。

### 冻结与宿主接入

[对应操作合同](media-libtv-generation.md)。

### 已有任务恢复与可选图片交付

[对应操作合同](media-libtv-recovery.md)。

### 恢复、暂停与自动收尾

[对应操作合同](media-libtv-recovery.md)。

## LibTV 独立资产并发

[画布会话](media-canvas-session.md)、[资产库](media-assets.md)。

### 首图验证和持续入画布

[对应操作合同](media-canvas-production.md)。

### 原生 curl 上传（默认入口）

[对应操作合同](media-transfer.md)。

### 资产库接入

[对应操作合同](media-assets.md)。

### 仅上传画布及建立待生成节点

[对应操作合同](media-canvas-session.md)。

## 批次结束后一次交付

[对应操作合同](media-delivery.md)。

## 正常交付与异常报告

[对应操作合同](media-delivery.md)。
