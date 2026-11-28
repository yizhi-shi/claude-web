# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

Claude Code Web 是自托管的 **Claude Code Web 控制台**：Fastify 服务端持有每个会话的 `ClaudeRuntime`（Agent SDK `query()`），Vue 3 前端只负责登录、会话列表、聊天、审批和配置。浏览器通过 WebSocket “附着”到会话；断开 WebSocket 不会停止后台任务，刷新后从事件日志恢复。

服务端启动一个会话时会拉起本机 `claude` CLI；CLI/SDK 的版本契约以 `claude --version` 和 `@anthropic-ai/claude-agent-sdk` 类型为准。

## 常用命令

```bash
npm ci                      # 安装依赖（Node >= 20）
npm run dev:server          # Fastify，默认 :8010，tsx watch
npm run dev:web             # Vite，默认 :5173，代理 /api 和 /ws 到 :8010
npm run build               # build:server + build:web
npm run build:server        # tsc -p tsconfig.server.json → dist/server
npm run build:web           # Vite → web/dist
npm start                   # 跑已构建的 dist/server（需要 web/dist 已存在）

npm run set-password -- <用户名> <新密码>
npm run upstream            # 打印本机 CLI / SDK / VSCode 插件版本
npm run check-secrets       # 扫描当前树里的已知 secret 模式
npm run package:release     # 构建并打包签名 release（默认自带生产依赖）
./install.sh --release      # 安装预构建 release（不执行 npm/build）
node scripts/update/claude-web-update.mjs status   # 独立更新器状态
```

- 开发时同时开 `dev:server` 和 `dev:web`；只开 Vite 不会启动 API。
- `npm run build` 是 CI 的唯一检查（`.github/workflows/ci.yml`），没有 lint 脚本或单元测试框架。`build:server` 做严格 TypeScript 检查；Vite 只打包，不检查 Vue 模板类型。
- 浏览器端 smoke 测试在开发仓库的 `.smoke/*.mjs`，公开导出通常不包含该目录。先 `npm run build`，再直接运行单个脚本，例如：
  ```bash
  node .smoke/attachments-test.mjs
  node .smoke/attachments-ui-test.mjs
  node .smoke/web-commands-ui-test.mjs
  node .smoke/extensions-smoke.mjs
  node .smoke/voice-live-mock.mjs
  node .smoke/interrupt-test.mjs
  node .smoke/update-smoke.mjs
  node .smoke/side-question-test.mjs
  node .smoke/new-session-path-test.mjs
  ```
  多数脚本会自己启动临时服务、临时数据和端口；少数是依赖外部服务/凭证的一次性探测，运行前先读脚本头注释。浏览器脚本需要 Playwright Core + 系统 Chrome；真实 CLI 测试需要已登录的 `claude`，并可能消耗模型额度。
- 安全重启用户服务用 `scripts/restart-service.sh`（可加 `--build` 或 `--defer N`）。不要在由该服务托管的会话里直接 `systemctl --user restart claude-web`，那会杀掉当前对话的 CLI 进程。
- 健康检查：`curl -fsS http://127.0.0.1:8010/api/health`。

## 架构要点

### 服务端

- `server/src/index.ts`：Fastify 装配（cookie、WebSocket、静态资源），创建 `SessionIndex`、`TranscriptStore`、`AttachmentStore` 和 `SessionManager`。
- `SessionManager`（`manager.ts`）：Web 会话索引与运行时生命周期；一个 Web 会话对应一个 `ClaudeRuntime`。会话可 `resume` 已有 Claude session，历史由 `importHistory.ts` 从 `~/.claude/projects/*.jsonl` 归一化导入。
- `ClaudeRuntime`（`runtime.ts`）：核心。每会话一个 SDK `query()`，使用 **流式输入** 的 async iterable 持续接收用户消息；把 SDK 原始消息归一化为稳定的 UI 事件；维护 `status`、活动工具、后台 task、context usage、费用、待审批/待回答/待确认计划。
- 权限：SDK `canUseTool` 回调把审批请求发给前端并挂起 Promise。`bypassPermissions` 不能直接作为 CLI flag（root 会拒绝），实现是 CLI 用 `default` 启动、回调立即 allow。`AskUserQuestion` / `ExitPlanMode` 走原生问答/计划面板，不因 bypass 跳过。
- 事件持久化：`transcript.ts` 每会话追加一个 JSONL；`ws.ts` 在 attach 时发 snapshot + `lastSeq` 之后的回放。历史查询用 `compact=1` 跳过 `assistant.delta`，但实时 WS 仍保留增量以重建流式内容。
- 排队消息：运行中发送的 `user.message` 立即进 transcript 并带 `queued`；回合边界发 `user.message.delivered`，停止/异常时发 `user.message.failed`。
- 旁问（`/btw`）：`sideQuestion.ts` 用紧凑 transcript 摘要开一个禁工具、不落盘、不 resume 主会话的一次性查询；不要把它改回 fork/resume 整段会话。

### 前端

- `web/src/views/Chat.vue` 是聊天编排层：WebSocket attach/重连、事件合并、滚动、输入框、附件上传、粘贴/拖拽、语音、审批/问答/计划面板、会话设置 popover、Web 原生命令。
- `web/src/chatModel.ts` 把事件流合成 user/assistant/turn 项，并按 `messageId` 合并 assistant chunk；`MessageItem.vue` 负责 Markdown、思考、工具卡片、diff 和附件回放。
- `web/src/api.ts` 是 REST 客户端；`web/src/store.ts` 保存会话列表、主题和 toast；`web/src/i18n.ts` 提供 `t()`、`locale` 和常见服务端错误翻译。
- UI 文案：中文源串写在组件里，通过 `t('中文')` 显示；新增中文文案必须同步在 `web/src/i18n.ts` 的 `EN` 字典加英文。不要翻译 Claude 正文、工具原始输出、路径、模型名和用户数据。
- Web 原生命令：`/model`、`/context`、`/usage`、`/status`、`/permissions`、`/config`、`/mcp`、`/agents`、`/list-agents`、`/help` 由 `handleWebCommand()` 在发送前拦截；其余 `/命令` 和 Skill 原样交给 CLI。CLI 的 `model: "<synthetic>"` 消息渲染成「系统」通知，不显示 `<synthetic>` 模型 chip。
- 附件：`Chat.vue` 上传后只持有 id；服务端 `attachments.ts` 落盘并校验，`runtime.ts` 的 `buildUserContent()` 把图片转 image block、小文本内联、其他文件变成绝对路径。transcript 只保存附件描述。详见 `docs/ATTACHMENTS.md`。
- 扩展：`runtime.extensions()` 调用 `mcpServerStatus()` / `supportedAgents()`，只向浏览器暴露安全字段；扩展 tab 可重连和当前会话启停 MCP，子代理只读。`docs/EXTENSIONS.md` 记录了为什么不做插件市场/Hooks/MCP 编辑。
- 语音：整段转写与实时流式共用 `data/voice.json`；实时 `/ws/voice` 按渠道选择 Gemini Live / OpenAI Realtime / OpenAI 分段 VAD / 火山引擎流式。前端 PCM 采样率：Gemini/火山 16 kHz，OpenAI 24 kHz。详见 `docs/VOICE-ASR.md`。

### 数据与不变量

```text
data/
  auth.json, session.secret, sessions.json
  transcripts/<sessionId>.jsonl
  attachments/<sessionId>/<uuid>.<ext> + <uuid>.json
  voice.json, workspaces.json, preferences.json
```

- 浏览器是视图，不是任务宿主：WebSocket 断开不得停止 `ClaudeRuntime`。
- transcript 只追加；不要为了重连或压缩删除历史。页面重连必须恢复状态、待审批、待回答、待确认计划、活动工具、后台任务和最近事件。
- 所有工作区 cwd 必须 realpath 后落在 `ALLOWED_ROOTS`（或 `data/workspaces.json` 的额外目录）内。
- `data/` 是运行时状态，已 gitignore；不要提交 auth、transcript、附件、语音 Key 或 `.env`。
- 对外 API 不回显完整密钥、MCP config/env/HTTP headers/命令路径；MCP 只暴露白名单状态。
- 公共导出是脱敏镜像；共享文件、文档、截图里不要写真实域名、IP、token、账号。私有的 `.smoke/`、`docs/private/`、`scripts/publish.sh`、`scripts/export-oss.sh` 等可能不在公开树中。

## 改动落点

| 要改什么 | 主要位置 |
|---|---|
| 新增/修改 UI 事件 | `server/src/types.ts` → `runtime.ts` 归一化/emit → `web/src/types.ts` → `chatModel.ts` / `MessageItem.vue` |
| 新增 Web 原生命令 | `Chat.vue` 的 `webCommands`、`handleWebCommand()`、`builtinCommands`、会话设置/帮助面板；必要时加 REST/WS 能力 |
| 新增语音渠道 | `server/src/voice.ts`（配置/整段转写/可用性）→ `voiceLive.ts`（实时会话）→ `voiceWs.ts` → `web/src/types.ts`、`VoiceSettings.vue`、`VoiceControl.vue` → `docs/VOICE-ASR.md` |
| 改附件行为 | `server/src/attachments.ts` → `runtime.ts:buildUserContent()` → `http.ts` 上传/下载 → `Chat.vue` 输入区 / `MessageItem.vue` → `docs/ATTACHMENTS.md` |
| 改 MCP/子代理面板 | `runtime.ts:extensions()` / `toggleMcpServer()` / `reconnectMcpServer()` → `http.ts` → `web/src/api.ts` → `Chat.vue` 扩展 tab → `docs/EXTENSIONS.md` |
| 改权限/问答/计划 | `runtime.ts` 的挂起与 resolve → `ws.ts` / `http.ts` → `PermissionPanel.vue` / `QuestionPanel.vue` / `PlanPanel.vue` |
| 改主题/国际化 | `web/src/store.ts`、`web/src/i18n.ts`、相关组件；i18n 规则见 `docs/I18N.md` |
| 升级 CLI/SDK 后对齐能力 | `docs/FEATURE-PARITY.md`、`scripts/check-upstream.mjs`、`docs/IMPLEMENTATION.md` |

## 文档与发布

- `docs/ARCHITECTURE.md`、`IMPLEMENTATION.md`、`ATTACHMENTS.md`、`VOICE-ASR.md`、`EXTENSIONS.md`、`I18N.md`、`UPDATER.md` 是专项事实源；改行为时同步对应文档和 `README.md` / `CHANGELOG.md`。文档索引入口是 `docs/README.md` 与 `docs/README.en.md`，新增、重命名或删除文档时同步更新两个索引。
- **文档双语（强制）**：
  - 入口文档成对维护：`README.md` ↔ `README.en.md`、`SECURITY.md` ↔ `SECURITY.zh-CN.md`、`CONTRIBUTING.md` ↔ `CONTRIBUTING.zh-CN.md`；改一份必须同步另一份，并保留顶部语言切换。
  - 设计文档以中文为事实源；修改 `docs/*.md` 时必须同步更新 `docs/README.md` 和 `docs/README.en.md` 中对应的条目/摘要；新增设计文档必须同时加入两个索引。
  - UI 文案规则见上文：中文源串与 `web/src/i18n.ts` 的 `EN` 字典同时更新。
  - 完整策略与检查清单：`docs/I18N.md`。
- 私有开发树如存在 `scripts/export-oss.sh` / `scripts/publish.sh`，发布必须走脚本，不要手工复制到公开仓库；公开树是脱敏导出。
