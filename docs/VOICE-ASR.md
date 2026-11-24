# 语音识别渠道：调研与实现

> 状态: current
> 最后核对: 2026-11-24
> 事实源: `server/src/voice.ts`、`server/src/voiceLive.ts`、`server/src/voiceWs.ts`、`web/src/components/VoiceControl.vue`、Gemini/OpenAI/火山引擎公开 API
> 关联: [架构](ARCHITECTURE.md) · [Roadmap](ROADMAP.md)

## 结论

语音输入有两种模式，配置都只在「设置 → 语音识别」做一次，聊天框不再弹出渠道选择/配置面板：

1. **整段转写（默认）**：点击麦克风开始/结束录音，浏览器把整段 WebM 发给服务端，服务端调用当前渠道转写，文本插入光标。短句通常 2–5 秒。
2. **实时流式（可选）**：浏览器采集 PCM16，经服务端 `/ws/voice` 桥接到渠道的实时接口，边说边把文字写进输入框；停止后保留最终结果。三个服务端渠道都支持，浏览器内置 `SpeechRecognition` 本身也是实时的。

麦克风权限只会在点击麦克风时请求，不会在打开页面时触发。未配置渠道时只弹 toast，不请求麦克风。

| 渠道 | 整段转写 | 实时流式 | 实时实现 | 状态 |
|---|---|---|---|---|
| Google Gemini | ✅ `generateContent` | ✅ Gemini Live `BidiGenerateContent` | 16 kHz PCM16 WebSocket；需要支持地区的 WebSocket 中转 | ✅ 实测 |
| OpenAI 官方 | ✅ `/v1/audio/transcriptions` | ✅ Realtime `?intent=transcription` | 24 kHz PCM16；当前 `session.update` 与旧 `transcription_session.update` 双 schema | ✅ 代码完成 |
| OpenAI 兼容（Groq / SiliconFlow / 本地 faster-whisper 等） | ✅ | ✅ 分段实时 | 服务端能量 VAD 断句，逐句调用 `/v1/audio/transcriptions` | ✅ 代码完成 |
| 字节火山引擎 | ✅ `bigmodel_nostream` | ✅ `bigmodel` 双向流式 | 16 kHz PCM16 WebSocket，x-api-key 或 App ID + Access Key | ✅ 代码完成 |
| 浏览器内置 | —（客户端直接识别） | ✅ | 浏览器 `SpeechRecognition`，不经过服务端 | ✅ |

## 配置

设置页每个渠道都有「实时流式识别（边说边写）」开关；保存后聊天框麦克风直接按实时模式工作。未开启或实时不可用时自动回退到整段转写。

### Gemini

- API Key（只显示尾 4 位）、模型（默认 `gemini-3.5-transcribe`）、API 地址、语言。
- 中转开关 + 根地址 + 中转鉴权头（普通 HTTP 转写可经 HTTPS 网关）。
- 实时开关 + Live 模型（默认 `gemini-3.5-transcribe-live`）+ Live 中转地址 + 中转 Token。
- 环境变量：`GEMINI_LIVE_URL`、`GEMINI_LIVE_PROXY_TOKEN`、`GEMINI_LIVE_MODEL`。

### OpenAI 兼容

- API Key、模型（整段转写）、API 地址、语言。
- 实时模式：
  - `auto`（默认）：`api.openai.com` 或已填写 Realtime 地址时走 Realtime，否则走分段实时；
  - `realtime`：连接 `wss://…/v1/realtime?intent=transcription`；
  - `segment`：使用已有 `/v1/audio/transcriptions` 端点做逐句实时。
- 实时模型默认 `gpt-4o-transcribe`；官方也支持 `gpt-live-transcribe`、`gpt-4o-mini-transcribe`、`gpt-realtime-whisper` 等（以账号权限为准）。
- 自定义网关若支持 Realtime，在「Realtime 地址」填写完整 `wss://` 地址；未写 `intent=transcription` 时会自动补上。
- 兼容网关对 Realtime 会话 schema 的实现不一致：服务端优先发当前 `session.update`（`session.type=transcription`、`audio.input.*`），失败后自动回退旧 `transcription_session.update`（`input_audio_format`、`input_audio_transcription`）。

### 火山引擎

- 复用整段转写字段：API Key，或 App ID + Access Key；Resource ID（默认 `volc.bigasr.sauc.duration`）。
- 实时开关 + 实时模型（默认 `bigmodel`）+ 实时地址（默认 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`）。
- 实时链路直接发送 16 kHz PCM16，无需 `ffmpeg`；只有整段转写仍使用 `ffmpeg` 把 WebM 转 PCM。

## 实时链路

```text
浏览器麦克风
  → AudioContext/ScriptProcessor → PCM16
  → 二进制帧到 /ws/voice（登录 Cookie）
  → 服务端按当前渠道创建 LiveSession
     ├─ GeminiLiveSession        → wss 中转 → Gemini BidiGenerateContent
     ├─ OpenAIRealtimeLiveSession → wss → OpenAI Realtime transcription
     ├─ OpenAISegmentLiveSession  → 能量 VAD → POST /v1/audio/transcriptions
     └─ VolcengineLiveSession     → 火山 bigmodel 双向流式
  ← ready / partial / final / error JSON → 前端锚点区间替换
```

### 采样率

| 渠道 | 客户端上行 | 说明 |
|---|---|---|
| Gemini | 16 kHz PCM16 | Live 要求 |
| 火山引擎 | 16 kHz PCM16 | 单包约 200 ms（服务端按 6400 字节聚合） |
| OpenAI Realtime | 24 kHz PCM16 | 当前 `audio/pcm` 与旧 `pcm16` 均按 24 kHz |
| OpenAI 分段 | 24 kHz PCM16 | 服务端补 WAV 头后上传 |

前端在 `AudioContext` 的主线程 `ScriptProcessor` 内做平均下采样/重采样，兼容性优先；后续可换 AudioWorklet。

### partial / final 语义

- Gemini：`interimInputTranscription.text` 是当前这段话内的累计全文；`inputTranscription.text` 是最终文本。服务端给 interim 拼上已定稿前缀，前端按锚点区间替换。
- OpenAI Realtime：`delta` 是增量、`completed.transcript` 是整段定稿。服务端按 `item_id` 维护每个已提交 item 的文本，完成事件乱序也不会错位；停止时提交 `input_audio_buffer.commit`。
- 火山引擎：`result.text` 是整场累计文本；每个包返回 partial，最后一包（final 标志）返回定稿。
- OpenAI 分段：每句话定稿后发一次 `final`（累计文本）；没有 partial。
- 前端在停止后忽略迟到的 partial，只接受最多一次 final，然后立即收尾；因此不会出现“点了结束还在不停改写输入框”的情况。

### 停止与失败

- 点击结束：停止采集 → 通知服务端 `stop` → 等待定稿（最多 3.5 秒）→ 关闭连接并释放锚点。
- 停止等待期间按钮显示「处理中」，再次点击立即取消。
- Live 未启用、凭据缺失或连接失败：提示原因并回退整段转写；不会请求两次麦克风。
- 服务端 Live 会话在客户端断开时关闭上游连接；`/ws/voice` 受登录和每分钟 60 次限流。

## 实测与延迟

- Gemini Live（经支持地区中转）：WS 建立约 0.7s，`setupComplete` 约 1.1s，首个 partial 约 0.5–1s，停止后 final 约 0.5–0.7s。
- OpenAI Realtime：本地 mock 端到端通过（`/.smoke/voice-live-mock.mjs`）；真实官方端点需要账号权限，按官方文档应为首字亚秒级。
- 火山引擎：本地 mock 端到端通过；真实端点需要凭证。
- OpenAI 分段：mock HTTP 通过；延迟 ≈ 静音断句 650ms + 一次 `/audio/transcriptions` 往返。
- Gemini 整段转写：中文 8 秒音频约 2.8–4.8 秒返回。

## 数据与安全

- 服务端响应头必须包含 `Permissions-Policy: microphone=(self)`；写成 `microphone=()` 会在权限弹窗之前直接 `NotAllowedError`。
- `data/voice.json`（0600）保存 provider 配置与密钥；页面 API 只返回 `hasApiKey` / `••••尾4位`。
- 转写请求受登录与每分钟 60 次限流；审计只记录 provider、字节数、延迟，不记录音频与文本。
- 不要把 `data/voice.json` 提交到 Git。公网部署时，语音 Key 是服务端资产，不要下发到浏览器。

## 新增渠道

1. 在 `server/src/voice.ts` 扩展 `VoiceProviderId`、默认配置、`maskedVoiceConfig`、`updateVoiceConfig`、`liveAvailability`。
2. 实现 `xxxTranscribe(cfg, audioBase64, mimeType)`，返回 `{text, provider, model, latencyMs}`。
3. 在 `transcribeAudio` 分发；在 `testVoiceProvider` 增加连接测试。
4. 在 `server/src/voiceLive.ts` 实现 `VoiceLiveSession`（`sendAudio` / `endAudio` / `close`），在 `createLiveSession` 注册，并在 `testVoiceLive` 增加回调。
5. 在 `web/src/types.ts` 扩展 provider 字段；在 `VoiceSettings.vue` 增加表单与测试入口；`VoiceControl.vue` 只负责采集/渲染，不放大段配置。
6. 更新本文件与 README 的渠道表。

## 已知限制

- Gemini Live 依赖支持地区的 WebSocket 中转；中转不可用时回退整段转写。
- OpenAI Realtime 的兼容网关 schema 差异较大；服务端做了一次自动回退，仍不保证所有网关可用。纯 HTTP 兼容服务请使用分段实时。
- OpenAI 分段实时的断句由能量 VAD 决定，强噪声环境可能切得太碎；目前阈值固定，后续可做设置项。
- 火山引擎实时链路标记为“代码完成，待真实凭证实测”；mock 已覆盖协议收发。
- 浏览器内置 `SpeechRecognition` 的中间结果由浏览器实现，跨设备一致性不如服务端实时链路。
