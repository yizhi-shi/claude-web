# 附件链路：从 Web 上传到 Claude Code 接收

> 状态: current
> 最后核对: 2026-11-24
> 事实源: `server/src/attachments.ts`、`server/src/runtime.ts`、`server/src/manager.ts`、`server/src/http.ts`、`server/src/ws.ts`、`web/src/views/Chat.vue`
> 关联: [架构](ARCHITECTURE.md) · [核心实现](IMPLEMENTATION.md) · [UI 设计](UI-DESIGN.md)

## 一句话

浏览器先把文件上传成服务端附件库里的一个**随机 id 资源**；发送消息时只传 `attachments: [id]`。服务端按 id 取文件，把图片变成 Anthropic `image` content block、小文本内联进 `text` block、其他文件变成绝对路径清单，然后通过 Agent SDK 的流式输入交给 Claude Code。transcript 里只保存附件描述，不保存文件字节。

## 端到端流程

```text
[浏览器]
  附件按钮 / 粘贴 / 拖拽
    → Chat.vue addFiles()
    → FileReader 转 base64
    → POST /api/sessions/:id/attachments
         { name, mimeType, dataBase64 }
    ← { attachment: { id, name, mimeType, size, kind } }
    → 输入框上方显示 chip（图片缩略图 / 文件名与大小 / 上传 spinner）
    → 发送时：
         WS  user.message { text, attachments: [id] }
         或 HTTP POST /api/sessions/:id/messages { text, attachments: [id] }

[服务端]
  ws.ts / http.ts
    → SessionManager.send(id, text, attachmentIds)
    → AttachmentStore.resolve(id, attachmentIds)
         - 只接受当前会话目录下的附件
         - 校验数量、单文件/总大小
         - 图片读取为 base64
         - 文本类小文件读取为 UTF-8
         - 其他文件只保留绝对路径
    → ClaudeRuntime.sendUserMessage(text, resolved)
    → 写入 user.message 事件（仅 id/name/mime/size/kind）
    → buildUserContent() 生成 SDK user message
    → SDK query 的流式输入队列

[Claude Code / CLI]
  - 图片：作为 image content block 直接“看到”
  - 小文本：内联在 text block 里，模型直接读到
  - 其他文件：拿到 data/attachments/... 的绝对路径，按需调用 Read 工具

[历史 / 回放]
  transcript 只有附件描述
    → MessageItem 用 /api/sessions/:id/attachments/:attachmentId 渲染
    → Cookie 鉴权后读取文件；图片内联显示，其他文件下载
```

## 1. 浏览器端入口

输入区提供三个入口，最终都走同一个 `addFiles()`：

- 工具栏「附件」按钮 → 隐藏的 `<input type="file" multiple>`；
- 输入框粘贴：`paste` 事件里的 `DataTransferItem.kind === 'file'`；
- 聊天页拖拽：`dragenter/dragover/drop`，拖入文件时显示“松开即可添加附件”遮罩。

`addFiles()` 的行为：

1. 客户端先按 `MAX_ATTACHMENTS`（5）和 `MAX_ATTACHMENT_BYTES`（10 MB）做一次快速检查；
2. 图片（png/jpeg/gif/webp）用 `URL.createObjectURL()` 立即显示缩略图；
3. `FileReader.readAsDataURL()` 得到 base64，逐个调用上传接口；
4. chip 先以 `uploading: true` 出现，上传成功后替换为服务端返回的真实 id；
5. 上传中的附件计入 `uploadingCount`，发送按钮在全部完成前保持禁用；
6. 移除 chip 只移除本地引用，不会删除服务端文件（见“已知限制”）。

## 2. 上传接口与落盘

```http
POST /api/sessions/:id/attachments
Content-Type: application/json
Cookie: cw_session=…

{
  "name": "screenshot.png",
  "mimeType": "image/png",
  "dataBase64": "iVBORw0KGgo…"
}
```

```json
{
  "attachment": {
    "id": "aBcD1234…",
    "name": "screenshot.png",
    "mimeType": "image/png",
    "size": 23871,
    "kind": "image"
  }
}
```

服务端 `AttachmentStore.save()`：

- 先 `ensureTranscript(id)`，会话必须存在；
- 文件名只保留 basename，去掉控制字符，截断到 180 字符；
- MIME 必须匹配白名单格式 `type/subtype`；
- base64 必须严格合法：长度是 4 的倍数、字符集正确、解码后长度与预期一致；
- 单文件不能超过 `MAX_ATTACHMENT_MB`（默认 10 MB）；
- 用 `randomId()` 生成附件 id 与文件名，**从不使用客户端文件名作为磁盘路径**；
- 图片扩展名从 MIME 映射（png/jpg/gif/webp），其他文件用清洗后的原扩展名，否则 `bin`；
- 文件写入 `data/attachments/<sessionId>/<uuid>.<ext>`，权限 `0600`；
- 同目录写 `<uuid>.json` 侧车元数据，权限 `0600`；目录 `0700`；
- 若侧车写入失败，回滚已写入的文件。

`kind` 只有两种：

| kind | 判定 | 用途 |
|---|---|---|
| `image` | MIME 在 png/jpeg/gif/webp 白名单 | 转成 `image` content block，历史里显示缩略图 |
| `file` | 其他所有类型 | 小文本内联，其余给路径；历史里显示文件 chip，强制下载 |

SVG **不算图片**：它是带脚本潜力的 XML，模型也不能把它当 image block 消费。SVG 会作为普通文件保存并强制下载。

## 3. 发送接口与解析

WebSocket：

```json
{
  "type": "user.message",
  "text": "看一下这张图和日志",
  "attachments": ["aBcD1234", "eFgH5678"]
}
```

HTTP 兼容入口：

```http
POST /api/sessions/:id/messages
{ "text": "…", "attachments": ["aBcD1234"] }
```

`SessionManager.send()` 的顺序很重要：

1. `attachments.resolve(id, ids)` **先执行**，无效 id、越权 id、超出数量或总大小会在启动 CLI 之前失败；
2. 再 `ensureRuntime(id)`，避免坏附件把 CLI 进程拉起来；
3. `runtime.sendUserMessage(text, resolved)` 把附件写入同一条用户消息。

`resolve()` 只读取当前会话目录下的侧车文件，不接受客户端传入的路径；侧车中的 `file` 字段还会用正则再次校验，防止手工篡改侧车造成路径穿越。

附件-only 消息是允许的：`text` 可以为空，新会话标题取第一个附件名（没有附件名时用“附件”）。回合正在运行时发送会走排队逻辑，附件在发送时已经解析，排队事件仍然只带描述。

### 附件如何进入模型

`buildUserContent()` 生成 Anthropic Messages API 的 content 数组：

```jsonc
[
  {
    "type": "text",
    "text": "看一下这张图和日志\n\n附件：\n- app.log（text/plain，2048 字节）：/…/attachments/<sid>/<uuid>.log"
  },
  {
    "type": "image",
    "source": {
      "type": "base64",
      "media_type": "image/png",
      "data": "iVBORw0KGgo…"
    }
  }
]
```

具体规则：

| 附件 | 进入模型的方式 |
|---|---|
| 图片（png/jpeg/gif/webp） | `image` content block，base64，可直接被模型看到 |
| 文本类且 ≤ 64 KB、总内联预算 ≤ 128 KB | 内联到 `text` block，包在 `<attachment name="…" type="…" bytes="…">` 与 `</attachment>` 之间，并附原文件绝对路径 |
| 其他文件、超大文本 | 只在 `text` block 里列 `- 文件名（MIME，字节数）：绝对路径`，由 Claude 按需用 Read 工具读取 |

文本类判定：`text/*`、常见文本 MIME、常见源码/配置扩展名（`txt/md/json/yaml/ts/tsx/vue/py/go/rs/…`），或 `dockerfile/makefile`；同时检查内容不包含 NUL 字节。二进制文件不会被误当文本内联。

这样设计的原因：

- **图片必须走 image block**：模型无法从路径“看”图；
- **小文本内联**：即使当前权限模式拒绝 Read，模型也能看到内容；适合日志片段、配置、报错；
- **大文件/二进制走路径**：避免把大量字节塞进上下文，让 Claude 自己决定读哪一段；
- **绝对路径在 data 目录**：附件不复制进项目工作区，不会污染仓库；Claude 读取该路径时仍受当前权限模式约束，可能需要用户批准。

## 4. 持久化与历史回放

`user.message` 事件只保存：

```json
{
  "type": "user.message",
  "id": "message-id",
  "text": "…",
  "attachments": [
    { "id": "…", "name": "…", "mimeType": "…", "size": 123, "kind": "image" }
  ]
}
```

不保存 base64，也不保存文件字节。历史回放时：

- 图片：`<img src="/api/sessions/:id/attachments/:attachmentId">`，带 Cookie；
- 文件：同名下载链接；
- 读取接口校验会话、附件 id 和侧车元数据；
- 图片响应 `Content-Type` 使用白名单 MIME，`Content-Disposition: inline`；
- 非图片强制 `application/octet-stream` + `Content-Disposition: attachment`，避免同源 HTML/SVG 被浏览器执行；
- 附件响应允许 `Cache-Control: private, max-age=31536000, immutable`（文件名是随机 id，内容不可变）；其他 `/api/` 响应仍是 `no-store`。

## 5. 限制与配置

| 配置 | 默认 | 说明 |
|---|---:|---|
| `MAX_ATTACHMENTS` | `5` | 单条消息最多附件数 |
| `MAX_ATTACHMENT_MB` | `10` | 单个附件最大字节数 |
| `MAX_TOTAL_ATTACHMENT_MB` | `20` | 单条消息附件总大小 |
| Fastify `bodyLimit` | `18 MB` | `server/src/index.ts` 固定值；base64 会膨胀约 1/3，10 MB 文件约 13.3 MB JSON，仍能通过 |
| 单文件内联上限 | `64 KB` | 超过则只给路径 |
| 单条消息内联总预算 | `128 KB` | 多个文本附件按顺序消耗预算 |

客户端也做 5 个 / 10 MB 的快速检查，但**服务端为准**。如果调大 `MAX_ATTACHMENT_MB`，要同步确认它经过 base64 膨胀后仍低于 18 MB，或调整 `bodyLimit`。

## 6. 安全边界

- 上传与下载都要求登录 Cookie；附件按会话隔离，不能用其他会话的 id 读当前会话附件；
- 文件名只用于展示与下载头，磁盘名是服务端随机 id；
- 侧车元数据在读取时再次校验 id、文件名正则、MIME、大小和 kind；
- 严格 base64 校验，拒绝畸形数据；
- 图片 MIME 白名单；SVG 不作为图片；
- 非图片强制下载，配合 `X-Content-Type-Options: nosniff`、CSP `img-src 'self' data: blob:`，降低同源 HTML/SVG 执行风险；
- `Content-Disposition` 对文件名做 RFC 6266 兼容处理，避免引号/换行注入；
- 目录 `0700`、文件 `0600`；`data/` 不进 Git；
- 上传接口没有单独的病毒扫描或内容审核；附件内容会进入模型上下文，按不可信输入处理。

## 7. 与其他功能的关系

- **排队消息**：如果回合正在运行，`user.message` 事件带 `queued: true` 立即显示；附件在发送时已经解析。若会话在投递前停止，事件会变成 `user.message.failed`，但附件文件仍留在磁盘。
- **旁问 `/btw`**：前端明确拒绝带附件的旁问（`旁问暂不支持附件`），避免把附件语义混进无工具的 fork 查询。
- **终端历史导入**：从 `~/.claude/projects/*.jsonl` 导入的会话没有 Web 附件描述；原始 transcript 里的 image block 只会转成 `[图片]` 文本。
- **空闲休眠/服务重启**：附件是磁盘文件，不受运行时进程生命周期影响；历史仍可回放。

## 8. 已知限制

- 没有删除附件的 API 或后台清理：上传后移除 chip、切走页面、发送失败都会留下文件；长期使用需要配额/过期清理（Roadmap 已列）。
- 不支持附件重命名、预览文本内容、断点续传或上传取消。
- 图片仅支持 png/jpeg/gif/webp；不支持 HEIC/AVIF/TIFF，也不做 OCR。
- 非图片文件依赖 Claude 的 Read 工具；在 `default` 等需要审批的模式下，读取 `data/attachments` 路径可能触发权限请求。
- 内联文本按 64 KB/128 KB 截断预算，超过部分只给路径，不保证模型一定会读。
- 附件不会复制到工作区；如果手动删除 `data/attachments`，历史消息仍存在但缩略图/下载会 404。
- 上传是逐文件请求，受 Fastify bodyLimit 和代理 `client_max_body_size` 限制；反向代理配置过小时会先于应用返回 413。

## 9. 验证方式

仓库维护者的本地 smoke 测试覆盖：

- `AttachmentStore` 的校验、限额、图片/文本/二进制解析；
- `buildUserContent()` 生成的 text/image blocks；
- 真实 HTTP 上传、鉴权下载、未登录拒绝、越权/未知 id 404；
- Chrome 中文件选择、chip 上传/移除、历史缩略图；
- 真实 Claude Code CLI 回合：附件中的代号只存在于文件里，模型回答出该代号，证明附件确实到达 CLI，而不仅是 HTTP 层。

> 这些测试使用临时 `DATA_DIR`、临时工作区和真实 CLI，不写入当前生产数据；`data/attachments` 只保存本地测试数据。
