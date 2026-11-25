# Changelog

## 0.12.0 — 2026-11-25

- Reworked the Settings page into a task-grouped named grid: account and appearance share the first row, sign-in security spans the full width with email and SMTP columns, workspace and runtime pair up, voice spans the full width, and security notes close the page.
- Split email verification and SMTP out of the oversized account card. SMTP is collapsed to a host/port/security/source summary by default, expands on demand, and keeps the local `disable-2fa` recovery note beside it.
- Voice providers are now a tab bar with one active provider panel; switching tabs preserves each provider's form state and dramatically shortens the page.
- Responsive settings switch to one column at 1180px; the security columns stack, voice tabs scroll horizontally, and 1280/1024/390 widths have no horizontal overflow.
- Playwright layout smoke covers light/dark modes, SMTP expand, voice tab switching, equal-height paired cards and screenshots; desktop grid height dropped from 3884 to 2402px, mobile from 6200 to 4093px, voice panel from 1452 to 726px.

## 0.11.1 — 2026-11-25

- Email SMTP server settings are now editable in Settings → Administrator account → Email sign-in verification: host, port, SSL/STARTTLS, username, password, From address/name. The password is write-only, stored in `data/mail.json` (0600), and never returned by the API.
- Saving SMTP settings sends a test email with the candidate configuration before writing it, so a broken server change cannot lock out the next email-code login. A blank password preserves the existing one; `MAIL_ENV_FILE` remains the fallback when no local mail settings exist.
- SMTP test/save rate limits are separate from login-code limits, so saving settings does not block an immediate login.

## 0.11.0 — 2026-11-25

- Optional email-code second factor for login. Configure SMTP through `MAIL_ENV_FILE` (0600), enable it under Settings → Administrator account → Email sign-in verification, and log in with password + a 6-digit code (10-minute TTL, five attempts, HMAC storage). `npm run disable-2fa` is the local break-glass path.
- Authenticated-by-default API policy: a global hook now requires the signed-in session cookie for every `/api/*` route except health, sign-in/email-verification, and image attachments. New routes fail closed. `GET /api/auth/status` no longer exposes the administrator username.
- Image attachments are public capability URLs (random session id + random attachment id); non-image attachments still require login. Removed the stale `Cache-Control: immutable` year-long cache in favor of one day.
- Imported Claude sessions and existing session index entries are now re-validated against `ALLOWED_ROOTS` before a runtime starts, closing the resume-by-id allowlist bypass.
- Account lockout now resets the failure counter after a completed lock or idle window, so a single wrong password after expiry can no longer immediately re-lock the only admin.

## 0.10.2 — 2026-11-24

- Fixed the Extensions tab showing `Not found` plus “会话尚未运行……” when the frontend was new but the running server process was still an older build. A 404 from `GET /api/sessions/:id/extensions` now shows a clear “server outdated or not restarted, restart claude-web” hint and suppresses the misleading session-not-running fallback.
- Clarified that rebuilding the server does not hot-reload Fastify routes: restart the `claude-web` service after `npm run build` so new API routes are registered. The smoke test now simulates the old-server 404 and checks the new message.

## 0.10.1 — 2026-11-24

- Bilingual documentation: full English `README.en.md`, Chinese `SECURITY.zh-CN.md` and `CONTRIBUTING.zh-CN.md`, with language switches on every pair.
- Added `docs/README.en.md` as the English documentation index with summaries of the Chinese canonical design documents.
- Recorded the mandatory bilingual policy in `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING*.md` and `docs/I18N.md`: UI strings must update the `EN` dictionary, entry documents must change in pairs, and design-doc changes must update their English summaries.

## 0.10.0 — 2026-11-24

- Added built-in Chinese/English UI switching. A lightweight `web/src/i18n.ts` dictionary plus reactive `t()` covers navigation, login/setup, home, chat controls, approval/question/plan panels, tool cards, voice settings and session settings.
- Language follows browser preference on first visit, persists per browser in `localStorage` (`cw.locale`), and updates `document.documentElement.lang`. Switch from the sidebar bottom, the login card, or Settings → Appearance.
- English mode translates UI chrome and common server errors; Claude/CLI output and unknown server messages remain in their original language.
- Verified with Playwright at 1280×900 and 390×844: login/setup switch, English home/chat/settings, no residual UI Chinese except the target-language toggle label; Chinese mode restored on toggle; persistence after reload.

## 0.9.0 — 2026-11-24

- Added a native “Extensions” tab for the current session: MCP server status, scope/source, server info, tools, errors, reconnect, and session-scoped enable/disable; subagents are shown read-only with their descriptions and models.
- Added `GET /api/sessions/:id/extensions`, `POST /api/sessions/:id/mcp/toggle` and `POST /api/sessions/:id/mcp/reconnect`, backed by the Agent SDK's `mcpServerStatus()`, `toggleMcpServer()`, `reconnectMcpServer()` and `supportedAgents()`.
- MCP responses expose only safe metadata; config/env/headers/command paths/tokens are never sent to the browser. Enabling/disabling only affects the current runtime and does not edit config files.
- `/mcp`, `/agents` and `/list-agents` open the native Extensions tab; `/reload-plugins` and `/doctor` remain CLI commands, with synthetic output rendered as system notices.
- Deliberately skipped plugin marketplace/install, hooks editing, and MCP add/edit/auth in Web: they are supply-chain/security-sensitive, interactive in the CLI, or lack safe SDK APIs. The rationale and decision matrix are in `docs/EXTENSIONS.md`.
- Added an isolated smoke test with a temporary HOME and a real stdio MCP server (`echo`): status/tools, no path leakage, toggle, reconnect, and the Chrome Extensions panel all pass.

## 0.8.1 — 2026-11-24

- Web-native system/config slash commands: `/model` opens a model panel (current model, sonnet/opus/haiku/fable/best/1M/opusplan presets, custom ID), `/model <name>` switches directly, `/model default` clears the override; `/context`, `/usage`, `/status`, `/permissions`, `/config` and `/help` open native panels instead of sending synthetic CLI text into the conversation.
- Typing a complete slash command name and pressing Enter now executes it; partial input still completes the selected menu item.
- Added `GET /api/sessions/:id/context` backed by `ClaudeRuntime.refreshContextUsage()` so the status panel can refresh context usage on demand.
- `<synthetic>` assistant messages now render as a neutral “系统” notice without a `<synthetic>` model chip; empty / `No response requested.` system messages are hidden.
- Browser smoke test covers `/model`, model preset/default switching, `/help`, `/context`, `/permissions` and synthetic rendering.

## 0.8.0 — 2026-11-24

- Side questions no longer resume or fork the main Claude session. `manager.sideQuestion()` builds a compact context from the latest ~160 renderable events (24k char cap, tool inputs/results truncated, current active tools) and `sideQuestion.ts` runs a fresh, non-persisted, tool-less query with `strictMcpConfig: true` and a read-only system prompt.
- This fixes the live “旁问失败，请稍后重试” failure: a resumed active session could contain an unfinished tool call, causing the model to attempt tools and end with `error_max_turns` (even with `maxTurns: 2` for tool-inviting questions). The compact-context path answers directly and does not compete with the main runtime.
- Side questions are much cheaper on long sessions (one real test dropped from a multi-dollar resumed query to ~$0.03–0.09) and no longer inherit the main session lock/history size.
- Verified against the exact failing 452 KB session: “这个目录里有什么？” returns a context-grounded answer instead of an error; “项目代号是什么？” returns ORANGE-42 from the compact context.
- Error handling and per-turn cost reporting from 0.6.1 remain.

## 0.7.1 — 2026-11-24

- Documentation release for the attachment pipeline: added `docs/ATTACHMENTS.md` covering browser file picker/paste/drag → upload API → `data/attachments` storage → attachment ids on send → `AttachmentStore.resolve()` → `buildUserContent()` text/image blocks → Agent SDK/CLI reception → authenticated history replay.
- Documented upload/send payloads, per-file + total limits, inline-text budgets, image MIME allowlist, SVG/non-image forced-download behavior, path-traversal and XSS mitigations, orphan-file cleanup gap, and reverse-proxy/body-limit constraints.
- README now lists the attachment limits and links the new document; SECURITY, DEPLOYMENT, ARCHITECTURE, IMPLEMENTATION and UI-DESIGN cross-link the canonical attachment flow.

## 0.7.0 — 2026-11-24

- Side-question panel is now resizable: a top handle supports mouse and touch drag to grow it upward; desktop max ~82dvh and mobile ~78dvh, always clamped inside the viewport.
- Height is remembered in `localStorage` (`cw.side.height`) per browser; double-click restores the content height. Keyboard `↑/↓` adjusts by 24px (48px with Shift), `Home` expands to the maximum and `End` collapses to the minimum.
- Mobile layout is a full-width bottom sheet above the composer with a taller touch handle and safe-area offset; desktop remains the floating right-hand panel.
- Smoke-tested with Playwright at 1280×900 and 390×844: drag growth, reload persistence, double-click reset, no horizontal/vertical overflow, and a real side question (`OK。`) on both viewports.

## 0.6.1 — 2026-11-24

- Fixed `/btw` side questions failing on long or currently-running sessions with only "旁问失败，请稍后重试". The forked query now allows a second turn: the model may attempt one tool from the resumed context, get denied, and still produce an answer instead of ending with `error_max_turns`.
- Preserve partial answer text if the side query ends with an error after streaming; surface the underlying `errors` text and translate turn/context-limit errors into actionable messages.
- Report side-question cost from `model_usage_since_last_result` instead of cumulative `total_cost_usd`, so a resumed long session no longer shows its whole-history cost on one side question.
- Added `scripts/restart-service.sh`: builds and restarts the user service safely, refuses to restart from inside the service cgroup (which kills the current conversation), and supports `--defer N` through a transient user unit.
- Verified against the exact large active session that previously returned `error_max_turns`: the fixed forked query returns `OK。` and reports a per-turn cost.

## 0.6.0 — 2026-11-24

- Interactive questions: `AskUserQuestion` now renders a native question panel instead of being auto-allowed with "未回答". Single-select, multi-select, option descriptions/previews, a free-text answer, skip, and per-question timeout are supported.
- Answers are returned to the CLI through `updatedInput.answers`; the tool result is normal, so the model continues the same turn. Questions are shown even when the session default is `bypassPermissions`.
- Plan approval: `ExitPlanMode` now presents the preceding assistant plan (the tool input itself carries no plan body) with approve / keep-planning decisions and optional feedback. Approving leaves plan mode; rejecting returns the feedback to the model.
- Pending questions and plans live in runtime state, so a page refresh or reconnect restores the panel. They are also denied cleanly on stop/interrupt, and time out using `PERMISSION_TIMEOUT_MINUTES`.
- WebSocket messages `question.response` / `plan.response` plus REST fallbacks `POST /api/sessions/:id/question` and `/plan`.
- Public releases are now incremental: `scripts/publish.sh public` clones the existing public history, syncs the sanitized tree, commits as the public identity, pushes without force, and tags the package version.
- Added end-to-end tests for question answering in bypass mode, plan capture, browser panels, and reload restoration.

## 0.5.0 — 2026-11-24

- History pagination now works on renderable events instead of raw events: history queries use `compact=1`, which skips token-level `assistant.delta` records. A long answer no longer fills every history page by itself, so refresh and "load earlier" show the previous messages again.
- Scrolling to the top of the chat now auto-loads earlier messages (the button remains as a fallback); the initial load attaches from the last renderable event so in-flight partial text is rebuilt over the WebSocket.
- Messages sent while a turn is running are appended to the conversation immediately and rendered with a persistent "排队中，等待当前步骤结束" chip. The server emits `user.message.delivered` at the turn boundary (FIFO) and `user.message.failed` when the session stops, so the chip clears or turns into an explicit "未送达" state.
- The model sees the appended message in the running conversation at the next turn boundary; the old transient "消息已排队" notice was removed.
- `/btw` can now be typed into the main composer: it opens the side-question panel, does not go into the main conversation, and the panel still closes with its X. Other slash commands and skills continue through the CLI (`/context` verified end-to-end).
- Public releases now preserve git history: this release is published as an incremental sanitized commit on top of the existing public history instead of a force-pushed mirror.
- Added local smoke tests for compact history pagination, scroll-to-top loading, queued/delivered/failed states, the live queued chip in Chrome, `/btw` from the composer, and `/context` through the WebSocket input path.

## 0.4.0 — 2026-11-24

- Side questions (`/btw`): a new 旁问 entry in the chat header opens a floating panel for one-off questions answered from the current conversation context. The main turn keeps running and is not interrupted.
- Implemented with a forked, ephemeral Agent SDK query (`resume` + `forkSession`, `persistSession: false`, `tools: []`, deny-all `canUseTool`): no tool calls, no writes to the main transcript, and no extra Claude session file.
- Answers stream into the panel with thinking, cost and duration; cancel is supported and a 5-minute timeout guards hung providers. Side-question history stays in browser memory and is not replayed after a reload.
- The server caps concurrent side questions per session and cancels them when the socket, attach target, session or server shuts down.
- Added local smoke tests for SDK fork behavior, a side question during a running `sleep 20` turn, and the real-Chrome panel.

## 0.3.0 — 2026-11-24

- Composer attachments: paste images, drag files onto the chat, or use the new Attach button; chips show image thumbnails or file name/size, upload progress and a remove action.
- Server-side attachment store under `data/attachments/<sessionId>/` (files and metadata 0600); uploads are validated for base64, MIME, file name and size, and messages reference attachments by id rather than client-supplied paths.
- Sending: images become Anthropic `image` content blocks (PNG/JPEG/GIF/WebP); text-like files up to 64 KB are inlined; other files are listed by absolute path so Claude can read them on demand. Attachment-only messages are allowed.
- Persistence and replay: `user.message` events carry attachment descriptors; history renders authenticated thumbnails/file chips through `GET /api/sessions/:id/attachments/:attachmentId`. Non-image files are forced to `application/octet-stream` downloads; SVG is never sent as an image block.
- New limits: `MAX_ATTACHMENTS` (default 5), `MAX_ATTACHMENT_MB` (default 10), `MAX_TOTAL_ATTACHMENT_MB` (default 20).
- Verified with local smoke tests: attachment storage/HTTP, a real-Chrome upload flow, and a real CLI round-trip where the model answered from an attached text file.

## 0.2.0 — 2026-11-24

- Voice input is configured only in Settings; the chat mic starts/stops dictation directly (no config popup or caret).
- Real-time dictation is now available for all three server-side providers:
  - Gemini Live (16 kHz PCM16 over `/ws/voice`, relay-friendly);
  - OpenAI Realtime transcription (`?intent=transcription`, current and legacy session schemas) for official OpenAI and compatible gateways;
  - OpenAI-compatible segmented live mode for Groq/SiliconFlow/local faster-whisper and any `/v1/audio/transcriptions` endpoint;
  - Volcengine/Doubao streaming ASR (`/api/v3/sauc/bigmodel`) with 16 kHz PCM and no ffmpeg dependency.
- Live partial text is written into the composer anchor while speaking; finalized text is kept on stop and the anchor survives multiple utterances.
- Live capture starts immediately (and buffers early PCM while setup is in flight), so the first words after clicking are not lost; stop-before-ready is handled.
- Stop now settles dictation immediately: late partials are ignored, the final transcript is applied at most once, and a second click cancels the remaining flush.
- Typing into the composer during dictation replaces only the dictated segment, preserving the user edit without re-inserting the finalized sentence.
- Stop-turn UX: optimistic “停止中…” state, stop buttons in both the run strip and composer, `Esc` shortcut, pending permission denied before interrupt, and a force-stop escape hatch after 2.5s. Measured interrupt latency for an active Bash tool: ~51 ms.
- Composer layout reorganized into one input + one bottom bar (commands/files/voice, send, stop), removing the duplicate toolbar row and reducing vertical space; mobile keeps icon-only tools and safe-area padding.
- Fixed `audio/webm;codecs=opus` being rejected as an unsupported audio type (client/server MIME normalization).
- Streaming thinking now auto-scrolls its inner pane to the bottom; the chat also follows content resizes while pinned to the bottom.
- Settings voice cards now work on desktop and mobile; added live mode/model/relay fields and a per-provider live connection test.
- `DEFAULT_WORKSPACE` is now actually honored as the new-session default (previously it was only documented).
- Optional `VOICE_PROXY_URL` for voice HTTP egress; optional `GEMINI_LIVE_URL` / `GEMINI_LIVE_PROXY_TOKEN` / `GEMINI_LIVE_MODEL`.
- Documented the optional, token-protected WebSocket relay for Gemini Live; relay deployment details stay out of the public export.
- Added end-to-end mock tests for OpenAI Realtime, OpenAI segmented live, and Volcengine streaming (`/.smoke/voice-live-mock.mjs`).

## 0.1.0 — 2026-11-23

First open-source release.

- Self-hosted web console for the local Claude Code CLI via the Agent SDK.
- Persistent server-side sessions; page refresh/reconnect does not stop a running turn.
- Streaming assistant text/thinking, tool cards, command output and file diffs.
- Permission approvals with allow once / allow session / deny and timeout handling.
- Session history scanning, resume, recent-window loading.
- Live execution state: active tools, elapsed time, background tasks, context usage, cost.
- Slash commands and skills from `initializationResult()` / `system/init`; `@` file references.
- Workspace configuration: allowed roots, default root, in-app folder creation.
- Pluggable voice input: Gemini 3.5 Transcribe, OpenAI-compatible endpoints, Volcengine, browser SpeechRecognition.
- Responsive desktop/mobile layout; system/light/dark appearance with a server-wide default.
- Clean user-level and system-level installer, systemd service, uninstaller.
- Documentation: architecture, implementation, feature parity, voice research, roadmap, deployment.
