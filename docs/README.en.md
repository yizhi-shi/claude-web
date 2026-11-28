# Documentation

English | [简体中文](README.md)

This page is the English index for the project documentation. The entry documents are fully bilingual; the design documents use Chinese as the canonical text, and the summaries below explain what each one covers.

## Entry documents

| Document | Contents |
|---|---|
| [README](../README.en.md) | Project overview, features, installation, configuration, FAQ |
| [SECURITY](../SECURITY.md) | Threat model, vulnerability reporting, deployment requirements and built-in protections |
| [CONTRIBUTING](../CONTRIBUTING.md) | Development setup, pre-PR checks, code and documentation conventions |

## Design and implementation

| Document | Contents |
|---|---|
| [Architecture and invariants](ARCHITECTURE.md) | How the browser, Fastify, `ClaudeRuntime` and the CLI divide the work; event model, session lifecycle and the invariants that must hold |
| [Core implementation](IMPLEMENTATION.md) | Why the Agent SDK, where commands and skills come from, event normalization, history resume, side questions and common traps |
| [Attachment pipeline](ATTACHMENTS.md) | The full path from browser upload to Claude Code, storage format, limits and security boundaries |
| [Tool-result images and text preview](TOOL-IMAGES.md) | Image storage and authentication, the in-page lightbox, plain-text tool output, and how in-turn messages are confirmed and recovered |
| [Extension management scope](EXTENSIONS.md) | Why the Web UI manages MCP status/reconnect/enable and a read-only subagent list, but not the plugin marketplace, hooks or MCP editing |
| [Deployment guide](DEPLOYMENT.md) | Manual and agent-assisted installation, first login, service management, reverse proxying, voice and attachment storage, troubleshooting |
| [Release packaging and updates](UPDATER.md) | Release bundles, Ed25519 signing, version directories and the `current` symlink, the standalone updater and rollback |
| [Voice recognition](VOICE-ASR.md) | Gemini, Gemini Live, OpenAI Realtime, OpenAI segmented live, Volcengine and browser recognition, with implementation notes and trade-offs |
| [Chinese/English UI](I18N.md) | The `t()` dictionary, language selection and persistence, server-error translation and the bilingual documentation policy |
| [UI design and interaction](UI-DESIGN.md) | Visual direction, desktop/mobile layout, component responsibilities, panels, composer, settings and accessibility |
| [VS Code extension feature parity](FEATURE-PARITY.md) | Capability comparison with the VS Code Claude Code extension and the regression checklist after CLI/SDK upgrades |

## Project and planning

| Document | Contents |
|---|---|
| [Roadmap](ROADMAP.md) | What is already available, known limitations, next priorities and product principles |
| [Competitive research](COMPETITIVE-RESEARCH.md) | Observations from claudecodeui, opcode, Kanna, claude-run and similar projects, plus the trade-offs this project accepts |

## Find a document by task

| I want to… | Start with |
|---|---|
| Install on a Linux machine | [README quick start](../README.en.md#quick-start) or the [deployment guide](DEPLOYMENT.md) |
| Understand why closing the browser does not stop a task | [Architecture and invariants](ARCHITECTURE.md), [Core implementation](IMPLEMENTATION.md) |
| Configure voice input | [README voice input](../README.en.md#voice-input), [Voice recognition](VOICE-ASR.md) |
| Change attachment or tool-image behavior | [Attachment pipeline](ATTACHMENTS.md), [Tool-result images](TOOL-IMAGES.md) |
| Add a native Web command | [Core implementation](IMPLEMENTATION.md), [UI design](UI-DESIGN.md) |
| Publish a release or debug an update | [Release packaging and updates](UPDATER.md) |
| Catch up with a new Claude Code release | [VS Code extension feature parity](FEATURE-PARITY.md) |
| Change UI copy or add a language | [Chinese/English UI](I18N.md), [Contributing](../CONTRIBUTING.md) |

## Keeping the docs consistent

- One home for each fact: architecture, implementation, deployment and update details belong in their design document; the README stays an overview and index.
- When a design document changes, update its entry in this page and in the [Chinese index](README.md). New documents must be added to both indexes.
- Entry documents are maintained as pairs; change the Chinese and English sides together.
- Commands, defaults and paths in the docs should match the code. When behavior changes, fix the relevant document in the same change rather than leaving it for later.
