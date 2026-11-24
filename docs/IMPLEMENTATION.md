# 核心实现说明（SDK 宿主 + Web 视图层）

> 状态: current
> 最后核对: 2026-11-24
> 事实源: `server/src/runtime.ts`、`ws.ts`、`http.ts`、`web/src/views/Chat.vue`、Claude Code CLI / Agent SDK 控制协议
> 关联: [架构](ARCHITECTURE.md) · [VSCode 对照](FEATURE-PARITY.md) · [语音](VOICE-ASR.md)

## 一句话定位

我们做的是 **Claude Code 官方 Agent SDK 的宿主应用 + 浏览器视图层**：

```text
浏览器（Vue SPA）
  │ REST + WebSocket
  ▼
Fastify 服务端（ClaudeRuntime / 会话宿）
  │ @anthropic-ai/claude-agent-sdk query()
  ▼
本机 claude CLI 子进程
  │ stdio: stream-json + control protocol
  ├─ 模型调用、工具执行、读写项目
  └─ ~/.claude/projects/*.jsonl
```

- **Claude 能力**（对话、工具、审批、resume、模型/权限模式、命令/技能）全部来自 CLI。
- **控制台能力**（登录、工作区、事件持久化、WS 回放、文件搜索、语音、页面）由我们自己的服务端/前端实现。
- 不直接调 Anthropic API，不实现 Agent 循环，不写 PTY，不扒 VSCode 插件 webview。

## 为什么选 SDK

| 方案 | 能拿到什么 | 问题 |
|---|---|---|
| PTY + xterm.js | 完整 TUI | 无法结构化工具卡/diff/手机审批；安全面大 |
| 直接调模型 API | 完全可控 | 要重写 Agent 循环、工具、权限、压缩、会话，等于重造 Claude Code |
| 扒 VSCode webview | 现成 UI | 依赖 VS Code API，闭源、会漂移，不可维护 |
| **Agent SDK** | 流式事件、`canUseTool`、resume、skills/MCP、后台任务 | 需要跟随 SDK/CLI 版本（本项目有对照与检查脚本） |

## 1. `/` 命令与 Skill 从哪里来

不是扫目录，也不是硬编码；是 CLI/SDK 自己给的。两条来源：

### A. `initializationResult()`（首条消息之前）

启动会话时创建流式 query，随后立即取控制面初始化结果：

```ts
this.q = query({
  prompt: this.inputStream(), // 一直打开的 AsyncIterable
  options: {
    cwd,
    resume,
    includePartialMessages: true,
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    canUseTool: (...args) => this.canUseTool(...args),
  },
});
const result = await this.q.initializationResult();
// result.commands: [{ name, description, argumentHint }, ...]
```

`commands` 已包含内置斜杠命令、用户/项目 skills、插件与自定义命令入口。实测环境约 167 个。**这个调用在第一条用户消息之前就能返回**，所以菜单不必等首轮对话。

### B. `system/init`（首轮开始后）

CLI 发：

```json
{
  "type": "system",
  "subtype": "init",
  "session_id": "...",
  "model": "...",
  "permissionMode": "default",
  "tools": [],
  "mcp_servers": [],
  "slash_commands": [],
  "skills": []
}
```

服务端归一化为 `session.init`，同时更新运行时状态；首轮之后补全 `skills` / `tools`。

### 服务端与前端

- `ClaudeRuntime` 保存 `slashCommands`、`commandDetails`、`skills`、`tools`。
- `GET /api/sessions/:id` 与 WebSocket `state` 下发。
- `Chat.vue` 的 `slashCommands` computed 优先级：
  1. `commandDetails`（带描述，来自 `initializationResult`）；
  2. `slashCommands` / `skills`（来自 `system/init`）；
  3. 内置兜底（`/clear` `/compact` `/context` `/usage` `/model` `/permissions` `/status` `/config` `/help` `/init` `/review`）。
- 去重、按输入过滤、最多 14 条。
- **菜单负责补全；完整命令名 + Enter 直接执行**。Web 原生命令由 `handleWebCommand()` 拦截，其余 `/xxx` 作为用户消息发给 CLI。

## 2. 输入框怎么 hook

普通 `<textarea v-model="draft">`，没有 contenteditable。事件链：

```text
input → onInput() → resizeComposer() → detectMenu()
```

`detectMenu()` 从光标向前找当前 token：

```ts
const caret = textarea.selectionStart;
const before = draft.slice(0, caret);
const match = before.match(/(?:^|\s)([/@])([^\s]*)$/);
```

- `/` 在行首或空白后 → 命令/技能菜单；
- `@` → 文件引用菜单；
- 记录 `tokenStart`、`menuType`、`menuQuery`。

文件搜索由服务端执行，不把整棵树传到前端：

```text
GET /api/fs/search?cwd=<cwd>&q=<query>
  → rg --files --hidden（排除 .git/node_modules/...）
  → 按 query 过滤，返回相对路径
```

没有 `rg` 时退化为受限深度的目录遍历。前端插入 `@package.json`，CLI 在 cwd 下解析。

键盘：菜单打开时优先消费 `ArrowUp/ArrowDown/Enter/Tab/Escape`；若输入的 `/名字` 与某个命令完全匹配，Enter 直接执行该命令，否则 Enter 只补全当前选中项；菜单关闭时 `Enter` 才发送，`Shift+Enter` 换行。工具栏的「命令」「文件」按钮只是先插入 `/` 或 `@` 再触发同一个菜单。

### Web 原生命令与 synthetic 消息

`Chat.vue` 的 `handleWebCommand()` 在发送前拦截以下命令，不把文本交给 CLI：

| 命令 | 行为 |
|---|---|
| `/model` | 打开会话设置的模型 tab |
| `/model <name>` / `/model default` | 通过 `set.model` 切换 / 清除模型覆盖 |
| `/context` | 打开状态 tab，并请求 `GET /api/sessions/:id/context` 刷新上下文用量 |
| `/usage` / `/status` | 打开状态 tab（模型、权限、目录、费用、上下文、活动工具） |
| `/permissions` | 打开权限 tab |
| `/config` | 打开会话设置；其他 CLI 配置提示使用设置页/终端 |
| `/help` | 打开 Web 命令帮助 |

`runtime.refreshContextUsage()` 现在返回 `ContextUsage | undefined`，HTTP 路由把它暴露给前端；它仍然在每次 `turn.result` 后自动刷新。

CLI 对未拦截命令返回的 assistant 消息可能带 `model: "<synthetic>"`（例如 `/context` 的旧输出或 `No response requested.`）。`MessageItem.vue` 把这类消息渲染为「系统」通知，隐藏 `<synthetic>` 模型 chip，并隐藏空文本/`No response requested.`，避免系统输出伪装成 Claude 回复。

### 附件与图片

> 完整的请求/响应、content block、存储与安全边界见 [附件链路](ATTACHMENTS.md)。本节只保留实现摘要。

- 输入入口：工具栏「附件」选择文件、输入框粘贴（剪贴板文件）、在聊天页拖拽文件；三者都调用同一个 `addFiles()`。
- 上传：`POST /api/sessions/:id/attachments`（JSON base64）→ `data/attachments/<sessionId>/<uuid>.<ext>`，同时写一份同名 `.json` 元数据；目录 0700、文件 0600。服务端校验 base64、MIME、单文件大小与文件名（只保留 basename）。
- 发送：WS `user.message` / HTTP messages 增加 `attachments: [id]`。服务端只接受当前会话已上传的 id，重新校验数量与总大小，再交给 `ClaudeRuntime`。
- 进入模型：图片 → Messages API `image` content block（base64，png/jpeg/gif/webp）；≤64KB 的文本类文件 → 内联进 text block；其余文件 → 绝对路径清单，由 Claude 按需用 Read 工具读取。`user.message` 事件只存附件描述（id/name/mime/size/kind），不存文件字节。
- 历史渲染：图片经 `GET /api/sessions/:id/attachments/:attachmentId`（Cookie 鉴权、`private, immutable` 缓存）加载；非图片强制 `application/octet-stream` + `Content-Disposition: attachment`，避免同源 HTML/SVG 被执行。SVG 不作为 image block 发送。
- 限制：`MAX_ATTACHMENTS`（默认 5）、`MAX_ATTACHMENT_MB`（默认 10）、`MAX_TOTAL_ATTACHMENT_MB`（默认 20）；客户端先做一次同样的检查，服务端为准。Fastify `bodyLimit` 固定 18 MB，base64 膨胀后仍要能通过。
- 失败语义：`manager.send()` 先 `AttachmentStore.resolve()` 再 `ensureRuntime()`，坏附件不会拉起 CLI；上传成功的文件不会因为移除 chip 自动删除（清理策略在 Roadmap）。

### 旁问（/btw）

- 入口：会话头部的「旁问」打开浮动面板；同一时间只跑一个前端请求，面板保留本次页面内的问答历史。
- 协议：WS `side.question {requestId, text}` → `side.started` / `side.delta` / `side.done` / `side.error`；`side.cancel {requestId}` 取消。旁问事件不是 `UiEvent`，不写 transcript，也不广播给其他标签页。
- 实现：`manager.sideQuestion()` 从最近 160 条可渲染 UI 事件生成最多 24k 字符的紧凑上下文（用户消息、assistant 文本、工具名/输入摘要、工具结果摘要，以及运行中的工具状态），把它放进 `<conversation>` 标签，再交给 `server/src/sideQuestion.ts`。旁问查询**不 resume、不 fork 主会话**，而是新建 `persistSession: false` 的一次性查询：`tools: []`、`strictMcpConfig: true`、`canUseTool` 一律 deny、`maxTurns: 2`、自定义只读 system prompt。主 runtime、主输入队列、主 transcript 都不参与。
- 为什么不再 fork：fork 会把主会话的完整历史和未完成的工具调用带进旁问。模型容易继续调工具（被 deny 后仍可能重试），`maxTurns` 很快耗尽，且 30MB+ 的会话会带来巨大 token 成本。紧凑上下文把旁问限制在“读最近发生了什么”，与主任务隔离，也避免与运行中的 Claude 会话争锁。
- 上下文边界：只取最近事件，主回合正在流式输出且尚未落盘的 token 不在上下文里；工具输出会截断到约 900 字符；更早的历史可能缺失。需要完整历史时应回主对话查看。
- 错误与费用：`result.is_error` 但已有正文时按部分答案返回；错误信息会带 `errors` 并翻译 `error_max_turns` / 上下文过长；费用使用 `model_usage_since_last_result` 的单回合费用，不计入主会话 `costUsd`。
- 并发与清理：每会话最多 2 个旁问；socket 断开、重新 attach、会话 stop、服务 shutdown 都会取消；5 分钟超时。

### 历史分页、排队消息与运行中追加

- 历史接口 `GET /api/sessions/:id/events` 新增 `compact=1`：`TranscriptStore.readWindow` 跳过 `assistant.delta`，只返回可渲染事件。一次长回答可能产生数千条 token 增量；过去按原始事件分页时，240 条窗口会被当前回合的 delta 占满，用户消息和更早历史因此“加载不出来”。
- 首次载入使用 `compact=1&tail=1`；前端把 `lastSeq` 设为最后一条可渲染事件的 seq，再 attach WebSocket，服务端从该点回放 delta，正在流式输出的部分文本仍能重建。
- 「加载更早」仍用 `before=firstSeq&compact=1`；聊天区滚动到距顶部 80px 且内容足够长时自动加载，按钮保留为兜底。加载后按高度差补偿滚动位置，避免视口跳动。
- 发送时如果回合正在运行，`user.message` 事件带 `queued: true` 并立即写入 transcript/广播；前端在气泡内显示「排队中，等待当前步骤结束」。
- SDK 会**立即预取**流式输入，所以“进入输入队列”不等于“模型已经看到”。服务端改为在每次 `turn.result` 时确认最早一条排队消息，发 `user.message.delivered`（FIFO）；会话 stop、进程结束或异常时对剩余消息发 `user.message.failed`。前端据此清除 chip 或显示「未送达」。
- 模型在下一回合边界看到追加消息；无需 `priority` 也能追加进同一会话上下文，避免额外产生空回合。
- `/btw` 在主输入框被前端拦截并转到旁问面板（不是 CLI 命令）；其他 `/命令` 和 Skill 仍按 CLI `system/init` 的 `slash_commands` 原样发送，`/context` 已做端到端验证。

## 3. 关闭页面为什么不停止后台

这是架构红线：**WebSocket 连接只是订阅，不是任务宿主。**

浏览器连接后发送：

```json
{ "type": "attach", "sessionId": "...", "lastSeq": 123 }
```

服务端把 socket 加入 `ClaudeRuntime` 的订阅者集合。关闭页面只触发：

```ts
unsubscribeEvents();
unsubscribeState();
```

不会调用 `runtime.stop()`。因此 CLI 进程、SDK 事件、审批状态、事件写入 `data/transcripts/<id>.jsonl` 都继续。

刷新恢复：

1. `GET /api/sessions/:id/events?limit=240&tail=1` 取最近窗口；
2. WebSocket `attach(lastSeq)`；
3. 服务端先订阅，再读 `lastSeq` 之后的事件，发 `snapshot`（含 status/activeTools/tasks/pendingPermissions），然后继续推实时事件。

### 用户动作与效果

| 动作 | 效果 |
|---|---|
| 关闭标签页 / 切手机 / 锁屏 | 只断开订阅，任务继续 |
| 输入区/状态条「停止」 | 先拒绝挂起的权限请求，再 `q.interrupt()`；只停当前回合，进程还在。前端立即显示“停止中…”，2.5 秒未生效提供强制结束 |
| 会话设置「结束后台进程」 | `runtime.stop()`：abort、关输入流、拒绝待审批、`q.return()`，状态 stopped |
| 空闲 30 分钟 | 运行时自动 stop，释放进程；下次发送 `resume` |
| Node 服务 SIGTERM | 遍历运行时优雅停止（服务生命周期，不是页面行为） |

没有做“点击关闭浏览器页面”的按钮：普通标签页的 `window.close()` 基本无效。产品语义是“关页面安全，停止必须显式点按钮”。

## 4. 审批：CLI 发起，SDK 回调，我们 resolve

审批**不是**往 CLI stdin 写用户消息，也不进入输入流；它是 SDK 控制协议的一次 Promise 结算。

```text
CLI
 ── control_request(can_use_tool, request_id) ──>
Agent SDK
 ── options.canUseTool(toolName, input, opts) ──>
ClaudeRuntime
 ── 挂起 Promise；发 permission.request 给浏览器 ──>
浏览器
 ── 允许/拒绝 ──> WebSocket / REST ──>
ClaudeRuntime.respondPermission()
 ── pending.resolve(PermissionResult) ──>
Agent SDK
 ── control_response(request_id) ──>
CLI
 ── 执行或拒绝工具
```

### 挂起点

```ts
private async canUseTool(toolName, input, opts): Promise<PermissionResult> {
  if (this.autoAllowAll) {
    return { behavior: 'allow', updatedInput: input, toolUseID: opts.toolUseID };
  }
  const requestId = opts.requestId || randomId();
  this.emit({ type: 'permission.request', requestId, toolName, input, ... });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ behavior: 'deny', message: '等待用户批准超时', toolUseID: opts.toolUseID });
      this.emit({ type: 'permission.resolved', requestId, decision: 'timeout' });
    }, config.permissionTimeoutMs);
    this.pending.set(requestId, { resolve, timer, input, toolUseId: opts.toolUseID, ... });
  });
}
```

CLI 的工具调用此时是停住的，等 Promise 结算。

### 两个入口

- 主路径 WebSocket：`{ type: 'permission.response', requestId, decision, updatedInput? }`
- 兜底 REST：`POST /api/sessions/:id/permission`

两者都调用 `runtime.respondPermission()`。

### 真正“输入给 SDK”的地方

```ts
pending.resolve({
  behavior: 'allow',
  updatedInput: updatedInput ?? pending.input,
  toolUseID: pending.toolUseId,
  updatedPermissions, // allow_session 时
});
```

`requestId` 必须原样回传，SDK 靠它匹配 CLI 的 `control_request`。我们**不拼 control_response，也不写 CLI stdin**，由 SDK 完成。

### 决策语义

| 决策 | 返回给 SDK | 效果 |
|---|---|---|
| 允许一次 | `{ behavior:'allow', updatedInput }` | 只放行这次 |
| 本次会话允许 | `{ behavior:'allow', updatedPermissions }` | 优先用 CLI 的 suggestions（如 `setMode: acceptEdits`），否则加 session 级 toolName 规则 |
| 拒绝 | `{ behavior:'deny', message }` | 工具不执行，模型收到拒绝 |
| 超时 | 同 deny | 自动拒绝，避免 CLI 永久等待 |

### 刷新、多标签、停止

- `permission.request/resolved` 写入 transcript；`pendingPermissions` 在状态里；刷新后重新下发。
- `pending` 是服务端 Map；多标签第一个响应 resolve，后续返回 `ok:false`（已失效）。
- `runtime.stop()` 把所有 pending resolve 成 deny，避免 CLI 挂死。
- 并行工具的多个 Promise 全部处理完，状态才从 `waiting_permission` 回到 `running`。

### “全部允许”模式

root 下 CLI 拒绝 `--dangerously-skip-permissions`，所以 `bypassPermissions` 被等价实现为：

```ts
permissionMode: 'default'
canUseTool: () => ({ behavior: 'allow', updatedInput: input })
```

仍走 SDK → CLI 的控制响应，只是没有人工环节。

### AskUserQuestion / ExitPlanMode

这两个工具也走 `canUseTool`，但语义不是“允许/拒绝工具”，而是“把用户的输入交给工具”：

```ts
// AskUserQuestion: 原输入 + answers 作为 updatedInput
pending.resolve({
  behavior: 'allow',
  updatedInput: { ...pending.input, answers }, // key = question 原文
  toolUseID,
});

// ExitPlanMode: 批准时原样 allow；拒绝时 deny + 修改意见
pending.resolve(
  approved
    ? { behavior: 'allow', updatedInput: pending.input, toolUseID }
    : { behavior: 'deny', message: feedback, toolUseID },
);
```

- `AskUserQuestion` 的输入包含 1–4 个问题，每个问题 2–4 个选项；`multiSelect` 时答案用逗号拼接。问题必须**始终**展示给人，即使会话是 `bypassPermissions`，否则 CLI 只能收到“未回答”。
- `ExitPlanMode` 的 tool input 只有 `{}`（`allowedPrompts` 已废弃），计划正文在前一条 assistant 消息里。运行时在流式 `text_delta` 时维护 `lastAssistantText`，控制请求到达时直接取用；不能等 `message_stop`，否则面板会拿到旧文本或空文本。
- 两类挂起项分别存在 `pendingQuestions` / `pendingPlan`，随 `question.request` / `plan.request` 事件写入 transcript；`session.state` 同时携带它们，所以刷新/重连能恢复面板。
- 超时分别按“跳过问题、让 Claude 自行判断”和“拒绝计划、继续完善”处理；停止/中断时全部 deny，避免 CLI 挂死。
- 前端面板在输入区上方：`QuestionPanel`（单选/多选/自由输入/跳过）和 `PlanPanel`（Markdown 计划/修改意见/批准/退回）。答案经 WS `question.response` / `plan.response` 或 REST 兜底提交。

## 5. 文件 diff 从哪里来

diff 不在服务端读文件生成，也不把整份文件传来传去；它直接来自 CLI 的 `tool_use` 输入。

```text
claude CLI
  └─ assistant message: tool_use
       Edit      { file_path, old_string, new_string }
       MultiEdit { file_path, edits:[{old_string,new_string}] }
       Write     { file_path, content }
  → SDK assistant message blocks
  → ClaudeRuntime 归一化 assistant.message
  → 前端 presentTool()
       Edit  → diffLines(old_string, new_string)
       Write → diffLines('', content)
  → ToolCard / PermissionPanel 渲染 +/− 行
```

- 用 `diff` 包的 `diffLines` 做行级比较，不依赖服务端文件系统。
- 好处：看到的就是模型即将写入/已写入的内容，不会因为文件已被别人改动而展示另一份 diff。
- 权限审批面板和聊天里的工具卡使用同一个 `presentMaybeDiff` 数据源；审批时先看 diff，再决定允许/拒绝。
- 限制：`replace_all` 等参数只在输入 JSON 中保留，不单独展开；超大 diff 在 UI 截断（聊天 400 行、审批 200 行）。

## 6. 事件归一化

- `stream_event`：`message_start` / `content_block_*` / `message_delta` / `message_stop`
- `assistant`：完整 block（文本/思考/tool_use）
- `user`：主要是 `tool_result`
- `result`：回合结束、费用、耗时

服务端按 `messageId` 维护累加器：

- 文本/思考增量 → `assistant.delta`
- `message_stop` → `assistant.message`（final blocks）
- `tool_result` → `tool.result`，前端按 `toolUseId` 挂到工具卡
- `result` → `turn.result`，状态 idle，刷新上下文用量/费用

## 7. 历史会话

扫描 `~/.claude/projects/*/*.jsonl`：读 cwd、首条用户文本、模型、时间；把原始 transcript 转成 Web 事件；同一 `messageId` 的 assistant chunk **合并**并标 `final:true`；续聊用 `resume: claudeSessionId`。大历史只取最近 240 条，可“加载更早”。

## 8. 哪些不是 CLI

| 能力 | 实现 |
|---|---|
| 登录 / 首次初始化 / 锁定 | Fastify + bcrypt + HMAC Cookie + 内存计数 |
| 会话索引 / transcript / WS 回放 | `sessions.json` + `transcripts/*.jsonl` |
| 工作区 | `ALLOWED_ROOTS` + `workspaces.json` + realpath 校验 |
| `@` 文件搜索 | 服务端 `rg --files` |
| 语音 | 整段：Gemini / OpenAI 兼容 / 火山引擎 / 浏览器内置；实时：Gemini Live / OpenAI Realtime / OpenAI 分段 / 火山引擎流式 |
| 页面/审批 UI/主题/移动 | Vue 3 + CSS token；默认外观由 `preferences.json` 下发 |

## 9. 最容易踩的坑

1. **`system/init` 不是启动就发**：流式输入下通常等首条用户消息；菜单必须先用 `initializationResult()`。
2. **历史 assistant 是 chunk**：同 messageId 多条且夹着 tool_result；不合并会出现“每个工具后正在思考”。
3. **断开 ≠ 停止**：WS close 只能取消订阅；停止必须 `interrupt()` 或 `runtime.stop()`。
4. **审批不是用户消息**：不要往输入流 yield；走 `PermissionResult`。
5. **root bypass 限制**：用 `default + canUseTool 自动 allow` 等价实现。
6. **浏览器麦克风**：需要 HTTPS 或 localhost；反向代理/WAF 的 WebSocket 空闲超时通常约 100s，前端 25s 心跳。

## 10. 代码地图

| 文件 | 职责 |
|---|---|
| `server/src/runtime.ts` | SDK query、输入队列、canUseTool、累加器、任务/工具状态 |
| `server/src/ws.ts` | attach/snapshot/回放、审批与中断消息 |
| `server/src/http.ts` | REST、认证、工作区、语音、会话 |
| `server/src/importHistory.ts` | Claude transcript → UI 事件，chunk 合并 |
| `server/src/voiceLive.ts` | Gemini Live / OpenAI Realtime（双 schema）/ OpenAI 分段 VAD / 火山引擎流式会话、partial/final 归一化、代理 |
| `server/src/voiceWs.ts` | `/ws/voice`：登录鉴权、二进制 PCM 上行、JSON 事件下行 |
| `web/src/views/Chat.vue` | 事件合并、流式渲染、菜单 hook、审批面板、语音锚点替换 |
| `web/src/chatModel.ts` | 前端消息合并与 final 收敛 |
