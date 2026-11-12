# 原生 curl 文件上传

执行前遵守[媒体共用边界](media-execution.md#共用执行边界)。本文件仅在对应操作被本次用户授权时读取。

首次接入字节上传时读取，已接线且本轮未变的传输器继续复用。回执异常见[画布恢复](media-canvas-recovery.md)。

### 原生 curl 上传（默认入口）

新上传统一使用 [libtv_upload.mjs](../scripts/libtv_upload.mjs)，Windows 调用 `curl.exe`，其他平台调用 `curl`。不再复制项目里的临时 Python 传输器，也不为每批重写 PUT 脚本。Node 与 curl 已有即可使用，无需部署服务或安装 Python requests。旧批次保留原传输器和回执，不能换入口把未知 PUT 当作新上传。

开始批次时先运行一次 `node storyboard-workbench/scripts/libtv_upload.mjs doctor`，只检查本机程序与 HTTPS 能力，零网络请求；检查失败不申请票据。整批在同一执行单元运行已有队列，默认四项并发，每项取得票据后立即传输并推进完成上传，不等其他图片；实际限流时调整后续并发。不得每张上传后返回模型再决定下一张，也不预先申请远超当前槽位数量的票据。curl 不改变现有代理环境，不关闭 TLS 校验、不跟随重定向、不自动重试、不替换签名域名。

正常 Node 宿主直接接入[资产队列](media-assets.md)的 `transfer` 回调；同一进程只检测一次 curl：

```js
import { checkLibTVCurl, transferLibTVFile } from './libtv_upload.mjs';
await checkLibTVCurl(); // 在申请第一张上传票据前执行。
const transfer = (item, ticket) => transferLibTVFile(receiptDirectory, item, ticket, {
  allowUpload: true // 仅在本次上传已获授权时传入；默认 false，只复用完成证明。
});
```

只有 MCP 能力的宿主通过普通 Node 进程桥接此回调，使用 `execFile` 参数数组及 UTF-8 stdin，不把 JSON、图片字节或签名地址放进 shell 命令。CLI 为 `node storyboard-workbench/scripts/libtv_upload.mjs upload "<request.json>"`，或 `upload -` 从 stdin 读取。输入为 `{directory,item,ticket,allowUpload:true}`：directory 和 item.path 是绝对路径；item 包含 `{id,projectId,path,size,sha256,sha1?}`；ticket 是同项 `upload_ticket` 的真实原始结果，保留 `uploadId/path/parts` 和原分片长度，不猜测多片大小。宿主调用示例：

```js
const transfer = (item, ticket) => new Promise((resolve, reject) => {
  const child = execFile(process.execPath, [uploadScript, 'upload', '-'], {
    windowsHide: true, encoding: 'utf8'
  }, (error, stdout) => {
    try {
      const result = JSON.parse(stdout);
      if (error || !result.ok) throw Object.assign(new Error(result.error || '本地上传进程失败'), { returned: result.returned });
      resolve(result.value);
    } catch (failure) { reject(failure); }
  });
  child.stdin.on('error', () => {}); // 退出与完整 JSON 回包由上面的回调判定。
  child.stdin.end(JSON.stringify({ directory: receiptDirectory, item, ticket, allowUpload: true }));
});
```

执行器读取并核对一次实际字节，直接送进 curl stdin，不生成临时图片、不将图片送回模型；临时配置只含当次签名地址，正常结束逐个删除。单文件按官方分片顺序上传，文件之间由现有队列并发。默认连接期限15秒、每片总期限90秒；可用 `timeoutSeconds` 调整每片总期限，不能用延长等待掩盖连接故障。成功必须同时满足 curl 正常退出、HTTP 2xx、实际上传字节数匹配；只返回小证明 `{status,bytes,sha256,transport,transferMs,wallMs,reused}`。

本地 `.libtv-upload-receipts` 使用共用原子回执存储和每项进程锁，不以全批上传锁串行化文件。`curl_submitted` 在首次 PUT 前独占保存，`curl_completed` 保存原票据绑定的完成证明；同项重入核对原件、项目与票据后复用，零网络调用。连接失败、HTTP 错误或中断留下原 submitted/unknown，不自动重投。若已成功但保存失败，CLI 错误回包保留 `returned`；先保存原返回证据，只恢复本地回执，不能重新 PUT。只有完成证明才能继续 `upload_complete`，字节传输成功不等于 LibTV 入库成功。旧外层回执为 unknown 时仍按原流程核对恢复，不把更换传输器当作解锁依据。

离线验证：`node --test storyboard-workbench/tests/libtv-upload.test.mjs storyboard-workbench/tests/libtv-assets.test.mjs`；模拟网络不证明真实带宽或端到端提速。用户计时仍记录提交需求到最终验收的总时长，curl 分项耗时只用于排障。
