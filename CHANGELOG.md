# Changelog

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
