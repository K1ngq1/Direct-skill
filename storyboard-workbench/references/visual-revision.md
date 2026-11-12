# 定向修订、候选与版本恢复

仅在定向修订、候选、恢复或刷新核对记录时读取。正常新稿使用[封存与验收](visual-seal.md)。

修订请求为：

```json
{
  "baseRevision": 1,
  "actor": "agent",
  "reason": "纠正本镜持物人归属",
  "kind": "repair",
  "shotEdits": [{"id": "V001", "changes": {"shotSchema": "此处填写完整的新Shot Schema对象", "prompt": {"text": "此处填写修正后的完整自然正文"}}}]
}
```

上述示例中的说明文字必须替换为合同规定的真实对象。`changes` 只允许合同 `shotEditable` 中的字段；不修改源镜映射或稳定 ID。`assetEdits:[{kind:"characters"|"locations"|"props",id,changes}]` 定向修改已登记资产；可显式更新 spec、sourceResolutions 或 `refreshRules:true`。后者使旧核对按新规则过期。共享资产只影响实际引用它的镜头和声明的下游依赖。

- `kind:repair` 最多两轮，失败也计数。失败请求和错误保存在修订快照中，主稿保持原内容，状态明确待处理；不会程序调用模型自动改写。
- `kind:review` 仅提交新评分/语义核对，不改画面。`kind:edit` 用于用户新发起的定向修订，必须附非空 `userRequest` 原话，不能把自动纠错改个类别来绕过上限。
- 每次写入检查 baseRevision，使用锁、快照和临时文件原子替换主状态。旧正文、评分、修改请求与受影响镜号留在 `visual-revisions/`。写入失败不假称成功；相同请求可恢复经过哈希核对的未完成快照。进程崩溃遗留锁时，先核实原进程已停止，再只处理该项目一个明确的锁文件。
- `add-candidate <project> <request.json>` 请求包含 baseRevision/actor/reason/shotId 和 `candidate:{id,difference,changes}`。只在用户要求调整时创建；必须明确构图或机位差异，校验候选不采用它。
- `select <project> <request.json>` 请求含 baseRevision、`actor:"user"`、reason、shotId、candidateId。候选绑定来源与正文双哈希，过期不能覆盖新稿。选择保留旧版，不代表用户确认画面质量。
- `restore <project> <request.json>` 请求含 baseRevision、`actor:"user"`、reason、targetRevision。恢复为新的修订号，不抹去修复次数或历史。
