# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for taking the time to improve Claude Code Web. Bug reports, documentation fixes and code contributions are all welcome.

## Ways to help

- Report a bug with the version, reproduction steps and your environment.
- Suggest a feature, describing the use case and what currently gets in the way.
- Improve the documentation, translations or screenshots.
- Submit code, especially tested fixes and small, well-scoped features.

## Before you start

- Small documentation fixes and clear bug fixes can go straight to a pull request.
- For changes to data formats, permission semantics, public APIs or new dependencies, please open an issue first so we can agree on the direction.
- The core is a **structured console for Claude Code**, not a browser terminal or a full IDE. Features that turn it into an unstructured terminal, file editor or multi-agent orchestrator are usually out of scope unless discussed first.

## Local development

You need Node.js 20+ and a logged-in `claude` CLI.

```bash
npm ci
npm run dev:server   # Fastify, :8010
npm run dev:web      # Vite, :5173, proxies /api and /ws
```

Production build and manual run:

```bash
npm run build
DATA_DIR=./data PORT=8010 node dist/server/index.js
```

`npm run build` must pass. `build:server` performs strict TypeScript checking; Vite only bundles and does not type-check Vue templates.

If you have the development tree with `.smoke/*.mjs`, run `npm run build` first and then run one script directly; this repository does not include that directory. Most scripts start their own temporary service and data directory; a few depend on external services or credentials, so read the header comment before running them. Browser tests need Playwright Core and a system Chrome; real CLI tests need a logged-in `claude` and may consume model quota.

## Project layout

```text
server/src    Fastify, Agent SDK host, session runtime, attachments and voice
web/src       Vue 3 single-page app (login, sessions, chat, settings)
scripts       Password reset, upstream version check, release packaging, standalone updater
deploy        systemd / nginx templates, update signing public key
docs          Architecture, implementation, deployment, voice, attachments, extensions
```

## Before opening a PR

1. `npm run build` passes.
2. If the change touches Claude Code behavior, run `node scripts/check-upstream.mjs` and update `docs/FEATURE-PARITY.md` or `docs/IMPLEMENTATION.md`.
3. UI changes have been checked in light and dark themes at 390px width.
4. No `.env`, `data/`, transcripts, attachments or personal paths are part of the diff.
5. Documentation and translations are in sync (see below).

For changes to the runtime, approvals, voice or attachments, also run a real session regression; a passing build does not cover those paths.

## Code and copy

- Keep the strict TypeScript check in `build:server` passing.
- The frontend uses Vue 3 single-file components. Justify new dependencies before adding them, especially anything that becomes a production dependency.
- Comments should explain *why* something is done, not restate what the code does.
- Chinese UI strings live in the components and are displayed through `t('中文')`. When adding or changing copy, update the `EN` dictionary in `web/src/i18n.ts` at the same time. Do not translate Claude messages, raw tool output, paths, model names or user data.

## Documentation and translations

- Entry documents are maintained as pairs: `README.md` ↔ `README.en.md`, `SECURITY.md` ↔ `SECURITY.zh-CN.md`, `CONTRIBUTING.md` ↔ `CONTRIBUTING.zh-CN.md`. Change both sides together and keep the language switch at the top.
- Design documents use Chinese as the canonical text. When changing a `docs/*.md` file, update the matching entry or summary in both `docs/README.md` and `docs/README.en.md`. New design documents must be added to both indexes.
- See [docs/I18N.md](docs/I18N.md) for the full policy.

## Commit messages

Use a `feat:`, `fix:`, `docs:`, `refactor:`, `perf:`, `test:` or `chore:` prefix. Keep each commit focused; for behavior changes, explain the reason and how you verified it.

## Security

Do not open a public issue for vulnerabilities such as command execution, authentication bypass or key disclosure. See [SECURITY.md](SECURITY.md) for the reporting channel.
