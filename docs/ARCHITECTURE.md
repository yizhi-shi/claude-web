# 架构与不变量

> 状态: current
> 最后核对: 2026-11-24
> 事实源: `server/src/`、`web/src/`、`agent-python` 无关；Claude Code CLI 与 Agent SDK 的运行时契约以本机 `claude --version` 和 `@anthropic-ai/claude-agent-sdk` 类型为准
> 关联: [功能对照](FEATURE-PARITY.md) · [核心实现](IMPLEMENTATION.md) · [语音](VOICE-ASR.md) · [Roadmap](ROADMAP.md)

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
  session.secret     Cookie HMAC
  workspaces.json    默认/额外工作区
  preferences.json   默认外观（system/dark/light）
  sessions.json      Web 会话索引
  transcripts/       Web 侧 UI 事件（每会话一个 JSONL）
  voice.json         语音渠道与密钥（0600）
```

## 关键组件

| 位置 | 职责 |
|---|---|
| `server/src/runtime.ts` | 一个会话一个运行时：流式输入、消息归一化、`canUseTool`、任务/工具状态、空闲休眠 |
| `server/src/manager.ts` | 运行时生命周期、会话导入、列表、状态合并、并发创建去重 |
| `server/src/transcript.ts` | UI 事件持久化与窗口读取（`after` / `before` / `tail`） |
| `server/src/importHistory.ts` | Claude 原始 transcript → Web UI 事件；按 messageId 合并 chunk |
| `server/src/ws.ts` | WebSocket 附着、快照 + 增量回放、审批与中断 |
| `server/src/auth.ts` | 首次初始化、登录、Cookie、账号锁定 |
| `server/src/workspaces.ts` | 允许目录/默认目录的持久化与校验 |
| `server/src/voice.ts` | 语音渠道注册、整段转写、实时渠道配置与可用性 |
| `server/src/voiceLive.ts` | Gemini Live、OpenAI Realtime/分段、火山引擎流式会话 |
| `web/src/views/Chat.vue` | 事件合并、流式渲染、审批面板、命令/文件/语音输入 |

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
- `user.message`
- `assistant.delta`（文本/思考增量） / `assistant.message`（final blocks）
- `tool.result`
- `permission.request` / `permission.resolved`
- `turn.result`
- `notice`

`assistant.message` 以 `messageId` 合并；历史导入按 messageId 合并 chunk 后标记 final，避免“已完成会话仍显示正在思考”。

## 权限模式

| 模式 | 行为 |
|---|---|
| `default` | 敏感工具经 `canUseTool` 挂起，前端审批 |
| `acceptEdits` | 文件编辑自动通过，命令仍询问 |
| `plan` | 只读规划 |
| `auto` / `dontAsk` | 交给 CLI 分类器/既有规则 |
| `bypassPermissions` | UI 语义为“全部允许” |

**root 限制**：Claude Code 拒绝 root 使用 `--dangerously-skip-permissions`。因此 `bypassPermissions` 在服务端被**等价实现**为：CLI 以 `default` 启动，`canUseTool` 立即 allow。工具调用与结果仍然进入 transcript/审计，便于追溯。

## 不变量

1. WebSocket 断开不得停止 ClaudeRuntime。
2. transcript 只追加，不因压缩/重连删除；UI 窗口化读取。
3. 会话 id（Web）稳定；Claude session id 只作为 `resume` 参数。
4. 所有 cwd 必须 realpath 后落在允许目录内。
5. 密钥只存在 `data/`（0600）或服务环境变量；API 不回显完整密钥。
6. `bypassPermissions` 不直接透传为 CLI flag（root 会拒绝）。
7. 历史导入必须合并同 messageId 的 assistant chunk，并标记 final。
8. 页面重连必须同时恢复：状态、待审批、活动工具、后台任务、最近事件。

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

## 安全边界

控制台 = 服务运行用户的远程终端。认证、HTTPS、反向代理限流、工作区白名单是外围；默认 `default` 权限是内层。公网部署建议叠加统一身份网关。
