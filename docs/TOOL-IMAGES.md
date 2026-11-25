# 工具结果图片、文本预览与运行中追加

> 状态: current
> 最后核对: 2026-11-25
> 事实源: `server/src/toolImages.ts`、`server/src/runtime.ts`、`server/src/manager.ts`、`server/src/http.ts`、`web/src/components/ToolCard.vue`、`web/src/chatModel.ts`
> 关联: [附件链路](ATTACHMENTS.md) · [架构](ARCHITECTURE.md) · [核心实现](IMPLEMENTATION.md) · [UI 设计](UI-DESIGN.md)

本文覆盖三个相邻但独立的能力：

1. Agent 工具返回的图片可以在网页内预览；
2. 工具输出文本可以在新标签页以纯文本打开；
3. 运行中发送的消息按“追加到当前会话”处理，并能在服务重启后恢复因关服丢失的追加消息。

## 1. 工具结果图片

### 问题

Claude Code 的 `Read`、截图类工具或 MCP 工具可以在 `tool_result` 的 content 数组中返回 image block：

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_...",
  "content": [
    { "type": "text", "text": "..." },
    {
      "type": "image",
      "source": { "type": "base64", "media_type": "image/png", "data": "..." }
    }
  ]
}
```

在 0.12.0 之前，`runtime.ts` 的 `toolResultText()` 把它压缩成 `[图片]`，前端只看到这个占位，base64 数据被丢弃。网页端无法像 VSCode Claude Code 插件那样点击缩略图查看原图。

### 存储与事件

`server/src/toolImages.ts` 的 `ToolImageStore` 负责落盘：

```text
data/tool-images/<sessionId>/<uuid>.png
data/tool-images/<sessionId>/<uuid>.json   # 元数据：id/name/mimeType/size/file/createdAt
```

- 目录 `0700`，图片和 sidecar 都是 `0600`。
- 只接受 `image/png`、`image/jpeg`、`image/gif`、`image/webp`；SVG 不进入图片链路。
- 每个 `tool_result` 最多保存 4 张图片；单张上限为 10 MB，同时不超过 `MAX_ATTACHMENT_MB`。
- base64 使用与附件相同的严格校验；解码失败、类型不支持或超限的块会被跳过，不影响工具结果本身。
- transcript **只写描述符**，不写 base64：

```json
{
  "type": "tool.result",
  "toolUseId": "toolu_...",
  "content": "[图片]",
  "images": [
    { "id": "…", "name": "image-1.png", "mimeType": "image/png", "size": 5523 }
  ]
}
```

`content` 仍保留 `[图片]`，因此旧 transcript、旧前端和只消费文本的路径保持兼容；web 端仅在存在 `images` 描述符时隐藏这个占位。

### HTTP 读取

```text
GET /api/sessions/:id/tool-images/:imageId
```

- 必须登录（全局 `/api/*` 鉴权）；工具图片是 agent 数据，**不是**用户附件的公开 capability URL。
- 校验会话存在、会话 id、图片 id、sidecar 中的文件名正则和 MIME 白名单。
- 响应 `Content-Type` 为白名单 MIME，`Content-Disposition: inline`，`Cache-Control: private, max-age=86400`，并带 `X-Content-Type-Options: nosniff`。
- 不把 base64 或文件路径放进 WebSocket / 历史 JSON。

### 前端

- `chatModel.ts` 把 `images` 放进 `ToolResultInfo`，随 `tool_use` 的工具卡一起渲染。
- `ToolCard.vue` 显示缩略图；点击后在页面内打开 lightbox：
  - 支持点击遮罩、关闭按钮和 `Escape` 关闭；
  - lightbox 内可再点「在新标签打开」；
  - 移动端缩略图尺寸单独收紧。
- 旧历史事件只有 `[图片]` 文本时自然回退到原占位，不显示空缩略图。
- 导入终端历史时，`convertClaudeTranscript(lines, saveImages)` 也会把 image block 写入 `ToolImageStore`，所以导入会话同样可预览；没有传入 sink 的测试/调用路径仍只得到 `[图片]`。

## 2. 工具输出在新标签打开

`ToolCard.vue` 的「输出」区域新增「在新标签打开」：

- 用完整输出生成 `Blob(text/plain;charset=utf-8)`，通过临时 blob URL 在新标签打开；60 秒后回收 URL。
- 复制按钮仍复制完整原始输出；代码显示仍受 30,000 字符截断。
- Bash 输出在纯文本预览中会去除 ANSI 颜色转义，避免把 `\x1b[...` 显示给用户。
- 纯客户端实现，没有新增服务端 API；只适用于文本输出，不尝试在浏览器解析二进制/图片（图片走上面的预览链路）。

## 3. 运行中追加消息与关服恢复

### 追加语义

- 回合运行中发送消息时，`sendUserMessage()` 使用与 UI 事件相同的 UUID 作为 SDK 用户消息的 `uuid`。
- Claude Code CLI 会在**当前回合的工具轮次之间**折入队列中的用户消息（`user_message_uuid` / `user_message_uuids` 会回显在 assistant / stream / result 帧上）。服务端收到回显后立即发 `user.message.delivered`，不再等到整个回合结束。
- 因此前端文案从「排队中，等待当前步骤结束」改为「已追加到当前会话」；发送按钮为「追加发送」。
- 不能把消息插入正在执行的单个工具调用内部：正在运行的 Bash/Read 等必须结束或到达下一个工具轮次，CLI 才可能读取追加内容。这是 CLI/模型回合的边界，不是 Web 层可以绕过的队列。

### 服务重启恢复

0.12.0 之前，服务关闭时 `failPendingInputs('服务关闭')` 会给尚未确认的消息写 `user.message.failed`，刷新后一直显示「未送达：服务关闭」。现在：

1. `SessionManager.createRuntime()` 启动 runtime 后扫描最近 4,000 条可渲染事件；
2. 找出 `queued: true` 且最后一次状态是 `user.message.failed`（reason 恰好为「服务关闭」）的消息；
3. 用原始附件 id 重新 `AttachmentStore.resolve()`，调用 `runtime.sendUserMessage(text, attachments, { id, recovered: true })`；
4. runtime 写入 `user.message.retrying`，不重复写 `user.message`；前端把同一条气泡改回「服务重启后正在重新发送」；
5. CLI 回显 UUID 后写 `user.message.delivered`，气泡状态清除。

恢复范围与边界：

- 只恢复 `queued: true` 的消息；用户主动停止（reason「已停止」）、普通进程退出或异常不会自动重发。
- 只扫描最近 4,000 条可渲染事件；极长历史里更早的失败项不会被恢复。
- 附件丢失时退化为纯文本重发；文本和附件都为空时跳过。
- 如果旧 CLI 已消费消息但 echo/result 在进程退出前没有到达，理论上可能重发一次；这是为了“不丢消息”接受的极低概率重复，优先于静默丢失。
- 服务正常运行时，消息仍由 CLI 的队列语义决定何时折入；Web 不伪造“已插入工具调用”的状态。

## 验证

```bash
npm run build
node .smoke/tool-image-test.mjs       # 真实 Read 图片 + 文本新标签 + 鉴权
node .smoke/queue-recovery-test.mjs   # SIGTERM 后重启恢复追加消息
node .smoke/queue-state-test.mjs      # 追加/确认/用户停止失败
node .smoke/queue-ui-test.mjs         # 浏览器气泡与 chip
```

工具图片测试同时断言：transcript 不含图片 base64、文件为 `0600`、未登录读图返回 401、lightbox 可用、`Escape` 可关闭、Bash 输出能在新标签读取。

## 已知限制

- `data/tool-images` 没有配额、过期清理或删除 API；长期使用会随工具图片增长，和附件一样需要后续清理策略。
- 只支持 base64 内联图片；URL 型 image source 不抓取、不代理。
- 文本预览是浏览器端 Blob，不提供服务器端文件下载、语法高亮或权限分享。
- lightbox 不是完整的焦点陷阱对话框；已支持键盘打开、`Escape` 关闭和可见关闭按钮，后续可按需补焦点环。
