# 架构与不变量

> 状态: current
> 最后核对: 2026-11-26
> 事实源: `server/src/`、`web/src/`、`agent-python` 无关；Claude Code CLI 与 Agent SDK 的运行时契约以本机 `claude --version` 和 `@anthropic-ai/claude-agent-sdk` 类型为准
> 关联: [功能对照](FEATURE-PARITY.md) · [核心实现](IMPLEMENTATION.md) · [语音](VOICE-ASR.md) · [附件](ATTACHMENTS.md) · [扩展](EXTENSIONS.md) · [Roadmap](ROADMAP.md)

## 一句话

浏览器只负责展示与输入；**会话进程、事件日志、审批状态都在服务端**。页面刷新等价于“断开再附着”，不是“重开会话”。

```text
┌──────────────────────┐        REST + WebSocket         ┌────────────────────────────┐
│ Vue 3 SPA            │  <─────────────────────────────> │ Fastify                    │
│ 登录 / 会话 / 聊天    │                                 │ auth · sessions · voice    │
│ 审批 / 设置 / 语音    │                                 │ SessionManager             │
└──────────────────────┘                                 └──────────────┬─────────────┘
                                                                        │ subscribe/emit
                                                         ┌──────────────▼─────────────┐
                                                         │ ClaudeRuntime (per session) │
                                                         │ SDK query + canUseTool      │
                                                         │ tasks / tools / context     │
                                                         └──────────────┬─────────────┘
                                                                        │ stream-json
                                                         ┌──────────────▼─────────────┐
                                                         │ claude CLI                  │
                                                         │ ~/.claude/projects/*.jsonl  │
                                                         └────────────────────────────┘

data/
  auth.json          bcrypt 管理员
  session.secret     Cookie/邮件验证码 HMAC
  security.json      邮箱验证收件地址与开关（0600）
  mail.json          设置页保存的 SMTP 配置（0600，密码只写不读）
  workspaces.json    默认/额外工作区
  preferences.json   默认外观（system/dark/light）
  sessions.json      Web 会话索引
  transcripts/       Web 侧 UI 事件（每会话一个 JSONL）
  attachments/       用户附件（每会话一个目录，文件与元数据均 0600）
  tool-images/       工具结果图片（每会话一个目录，文件与元数据均 0600）
  voice.json         语音渠道与密钥（0600）
```

## 关键组件

| 位置 | 职责 |
|---|---|
| `server/src/runtime.ts` | 一个会话一个运行时：流式输入、消息归一化、`canUseTool`、任务/工具状态、空闲休眠 |
| `server/src/manager.ts` | 运行时生命周期、会话导入、列表、状态合并、并发创建去重、旁问紧凑上下文 |
| `server/src/transcript.ts` | UI 事件持久化与窗口读取（`after` / `before` / `tail` / `compact`） |
| `server/src/attachments.ts` | 附件落盘/元数据、大小与类型校验、图片 base64 / 文本内联解析 |
| `server/src/sideQuestion.ts` | 旁问：紧凑上下文、禁工具、不 resume、不落盘的一次性查询 |
| `server/src/importHistory.ts` | Claude 原始 transcript → Web UI 事件；按 messageId 合并 chunk |
| `server/src/ws.ts` | WebSocket 附着、快照 + 增量回放、审批与中断 |
| `server/src/auth.ts` | 首次初始化、登录、Cookie、账号锁定 |
| `server/src/security.ts` | 邮箱验证开关、短期挑战码、发送/验证限流 |
| `server/src/mail.ts` | SMTP 配置读取与验证码邮件发送（`MAIL_ENV_FILE`） |
| `server/src/workspaces.ts` | 允许目录/默认目录的持久化与校验 |
| `server/src/voice.ts` | 语音渠道注册、整段转写、实时渠道配置与可用性 |
| `server/src/voiceLive.ts` | Gemini Live、OpenAI Realtime/分段、火山引擎流式会话 |
| `server/src/runtime.ts` 的扩展方法 | `mcpServerStatus` / `supportedAgents` 安全映射；当前会话 MCP 启停/重连 |
| `web/src/views/Chat.vue` | 事件合并、流式渲染、审批面板、命令/文件/附件/旁问/语音输入、Web 原生系统命令与会话设置 |

## 会话生命周期

1. `POST /api/sessions` 创建索引并返回稳定 `id`（Web 会话 id）。
2. 浏览器 `WS attach`：`SessionManager.ensureRuntime()` 启动 SDK query（流式输入，首条消息前只等待）。
3. 用户消息写入 transcript，随后进入 SDK 异步输入队列。
4. SDK 产出 `system/init`、`stream_event`、`assistant`、`user(tool_result)`、`result`；运行时归一化为 UI 事件并广播。
5. 页面断开：运行时继续；无订阅者不影响执行。
6. 页面刷新：读取最近 240 条事件 + 附着；`lastSeq` 之后的增量由服务端回放。
7. 回合结束：状态 idle，30 分钟后空闲休眠；再次发送自动 `resume`。

## 事件模型

UI 只消费稳定事件，不直接解析 SDK 原始消息：

- `session.init` / `session.status` / `session.meta`
- `user.message`（`queued` 表示发送时回合仍在运行；发给 SDK 的消息使用同一 UUID）
- `user.message.delivered` / `user.message.failed` / `user.message.retrying`（CLI 回显 UUID 即确认；用户停止写失败；服务重启自动重发关服时未确认的追加消息）
- `assistant.delta`（文本/思考增量） / `assistant.message`（final blocks）
- `tool.result`
- `permission.request` / `permission.resolved`
- `question.request` / `question.resolved`（AskUserQuestion；答案走 `updatedInput.answers`）
- `plan.request` / `plan.resolved`（ExitPlanMode；计划正文取前面 assistant 流式文本）
- `turn.result`
- `notice`

`assistant.message` 以 `messageId` 合并；历史导入按 messageId 合并 chunk 后标记 final，避免“已完成会话仍显示正在思考”。

历史 HTTP 查询可用 `compact=1` 跳过 `assistant.delta`：实时 WS 仍需要增量，但分页按可渲染事件走，否则一次长回答的 token 增量会占满整个窗口。

## 权限模式

| 模式 | 行为 |
|---|---|
| `default` | 敏感工具经 `canUseTool` 挂起，前端审批 |
| `acceptEdits` | 文件编辑自动通过，命令仍询问 |
| `plan` | 只读规划 |
| `auto` / `dontAsk` | 交给 CLI 分类器/既有规则 |
| `bypassPermissions` | UI 语义为“全部允许” |

**root 限制**：Claude Code 拒绝 root 使用 `--dangerously-skip-permissions`。因此 `bypassPermissions` 在服务端被**等价实现**为：CLI 以 `default` 启动，`canUseTool` 立即 allow。工具调用与结果仍然进入 transcript/审计，便于追溯。`AskUserQuestion` 例外：它需要人的答案，即使 `bypassPermissions` 也走问答面板；`ExitPlanMode` 在 plan 模式下同理。

## 不变量

1. WebSocket 断开不得停止 ClaudeRuntime。
2. transcript 只追加，不因压缩/重连删除；UI 窗口化读取。
3. 会话 id（Web）稳定；Claude session id 只作为 `resume` 参数。
4. 所有 cwd 必须 realpath 后落在允许目录内。
5. 密钥只存在 `data/`（0600）或服务环境变量；API 不回显完整密钥。
6. `bypassPermissions` 不直接透传为 CLI flag（root 会拒绝）。
7. 历史导入必须合并同 messageId 的 assistant chunk，并标记 final。
8. 页面重连必须同时恢复：状态、待审批、待回答的问题、待确认的计划、活动工具、后台任务、最近事件。

## 语音链路

```text
整段转写：MediaRecorder(WebM) → POST /api/voice/transcribe → provider
  ├─ Gemini generateContent（可经 HTTPS 中转）
  ├─ OpenAI 兼容 /audio/transcriptions
  ├─ Volcengine bigmodel_nostream（ffmpeg → 16k PCM）
  └─ browser SpeechRecognition（客户端）
→ 返回 text → 插入输入框光标

实时流式：麦克风 PCM16 → /ws/voice → createLiveSession(active provider)
  ├─ GeminiLiveSession         → BidiGenerateContent（16k）
  ├─ OpenAIRealtimeLiveSession → Realtime transcription（24k，双 schema）
  ├─ OpenAISegmentLiveSession  → 能量 VAD → /audio/transcriptions
  └─ VolcengineLiveSession     → bigmodel 双向流式（16k）
→ ready/partial/final → 前端锚点区间替换 → 停止后只收定稿
```

实时链路与整段转写共用同一份 `data/voice.json` 配置；实时不可用时前端自动回退整段转写。详见 [语音渠道](VOICE-ASR.md)。

## 附件链路

```text
浏览器 File/粘贴/拖拽
  → POST /api/sessions/:id/attachments（JSON base64）
  → data/attachments/<sessionId>/<uuid>.<ext> + <uuid>.json（0600）
  → 输入区 chip（只持有附件 id）
  → 发送：WS/HTTP user.message { text, attachments: [id] }
  → AttachmentStore.resolve()：图片 base64 / 小文本内联 / 其他文件绝对路径
  → ClaudeRuntime.buildUserContent()：text block + image block
  → Agent SDK 流式输入 → Claude Code
  → transcript 只写附件描述；历史经鉴权附件 URL 回放
```

附件按会话隔离，磁盘名由服务端随机生成；客户端永远不传路径。图片只允许 PNG/JPEG/GIF/WebP，SVG 作为普通文件强制下载。详见 [附件链路](ATTACHMENTS.md)。

工具结果里的 image block 走独立链路：`ToolImageStore` 落盘到 `data/tool-images`，transcript 只存描述符，浏览器经需登录的会话端点读取；见 [工具结果图片](TOOL-IMAGES.md)。

## 更新链路

```text
设置页“立即更新”
  → POST /api/update/apply（登录 + 运行中会话确认）
  → 写 data/updates/request.json
  → systemctl start claude-web-update.service（独立 oneshot，不在 Web 进程内）
  → feed latest.json + Ed25519 验签
  → 下载 tarball → sha256 → tar 安全检查 → staging
  → staging 临时 DATA_DIR + 回环端口健康检查
  → stop claude-web.service
  → 原子切换 current 软链
  → start claude-web.service → 真实 /api/health
  → 成功写 installed.json；失败切回上一版本
```

Web 进程永远不替换自己正在运行的文件；版本目录、`current` 软链、`bin/claude-web-update.mjs` 和 `data/` 的关系见 [系统更新](UPDATER.md)。git 开发 checkout 和平铺安装不启用这条自动更新路径。

## 安全边界

控制台 = 服务运行用户的远程终端。认证、HTTPS、反向代理限流、工作区白名单是外围；默认 `default` 权限是内层。公网部署建议叠加统一身份网关。自动更新还额外要求 HTTPS、sha256、Ed25519 验签和 tar 解压校验。
