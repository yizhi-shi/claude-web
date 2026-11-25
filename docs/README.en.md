# Documentation (English)

[简体中文](../README.md#文档) | English

This is the English entry point for the project documentation. The detailed design documents are maintained in Chinese as the single source of truth; the summaries below explain what each one covers and link to the canonical page.

For full bilingual user-facing documents, see:

| Document | Chinese | English |
|---|---|---|
| Project overview, install, configuration | [README.md](../README.md) | [README.en.md](../README.en.md) |
| Security policy | [SECURITY.zh-CN.md](../SECURITY.zh-CN.md) | [SECURITY.md](../SECURITY.md) |
| Contributing | [CONTRIBUTING.zh-CN.md](../CONTRIBUTING.zh-CN.md) | [CONTRIBUTING.md](../CONTRIBUTING.md) |

## Design documents

### [Architecture and invariants](ARCHITECTURE.md) (Chinese)

Explains the core split: the browser only renders and captures input, while the session process, event log and approval state live on the server. Includes the component map, session lifecycle, event model, permission modes, the invariants that must not be broken, and the voice/attachment/security boundaries.

### [Core implementation](IMPLEMENTATION.md) (Chinese)

A host application for the official Claude Code Agent SDK plus a browser view layer. Covers why the SDK was chosen over PTY/xterm, where slash commands and skills come from, how the composer hooks into the SDK, why closing the page does not stop work, how `canUseTool` approvals are resolved, where file diffs come from, event normalization, history resume, and the most common traps.

### [Attachment pipeline](ATTACHMENTS.md) (Chinese)

End-to-end flow from browser upload to Claude Code: attachment button/paste/drag → upload API → `data/attachments/<sessionId>/` → message references attachment ids → `AttachmentStore.resolve()` → image blocks / inlined text / absolute paths → history replay. Also documents limits, storage format, path-traversal and XSS mitigations, and known gaps.

### [Extension management scope](EXTENSIONS.md) (Chinese)

Why the Web UI manages MCP status, reconnect and session-scoped enable/disable, and shows subagents read-only, while deliberately skipping plugin marketplace/install, hooks editing, and MCP add/edit/auth. Includes the decision matrix, APIs, security allowlist and verification; a stale server that lacks the extensions route is reported as a restart hint instead of "session not running".

### [Deployment guide](DEPLOYMENT.md) (Chinese)

Manual and agent-assisted installation: prerequisites, user-level install, first login, service management, upgrades, reverse proxy/HTTPS, voice and attachment storage, uninstall, troubleshooting and security recommendations.

### [Voice recognition](VOICE-ASR.md) (Chinese)

Provider research and implementation for whole-utterance transcription and real-time streaming: Gemini, Gemini Live, OpenAI Realtime, OpenAI-compatible segmented live, Volcengine streaming, and browser SpeechRecognition. Covers sampling rates, partial/final semantics, stop/failure handling, measured latency, data handling and how to add a provider.

### [UI design and interaction decisions](UI-DESIGN.md) (Chinese)

Visual direction, desktop/mobile layout, component responsibilities, dialog panels, composer/stop interactions, native Web commands and session settings, the grouped Settings layout (account/appearance, full-width sign-in security with SMTP disclosure, paired workspace/runtime, voice provider tabs), diff/code readability, the language switch, and accessibility details.

### [VS Code extension feature parity](FEATURE-PARITY.md) (Chinese)

Capability-by-capability comparison with the VS Code Claude Code extension, plus the upstream follow-up process and regression checklist used after CLI/SDK/extension upgrades.

### [Roadmap](ROADMAP.md) (Chinese)

What is already available, known limitations, next priorities and product principles. Checkpoints/rewind, file tree/editor, Git panel and multi-agent orchestration are intentionally deferred.

### [Competitive research](COMPETITIVE-RESEARCH.md) (Chinese)

Survey of comparable open-source projects (claudecodeui, opcode, Kanna, claude-run, etc.), the core requirements extracted from them, layout conclusions, and what this project deliberately does not build.

### [Chinese/English UI (i18n)](I18N.md) (Chinese)

How the built-in Chinese/English switching works: coverage, language detection and persistence, the `t()` dictionary, server-error mapping, copy maintenance rules, limitations, and the bilingual documentation policy.

## Keeping translations in sync

- User-facing UI strings must update both the Chinese source string and the `EN` dictionary in `web/src/i18n.ts`.
- The three fully bilingual entry documents must be changed as a pair; the language switch at the top of each file makes the counterpart explicit.
- Design documents use Chinese as the canonical text. When a design document changes, update its summary on this page in the same change.
- The policy is also recorded in [CONTRIBUTING.md](../CONTRIBUTING.md) and [I18N.md](I18N.md).
