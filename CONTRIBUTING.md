# Contributing

Thanks for helping improve Claude Code Web.

## Development

```bash
npm install
npm run build
DATA_DIR=./data PORT=8010 node dist/server/index.js
```

For UI development:

```bash
npm run dev:server   # Fastify :8010
npm run dev:web      # Vite :5173, proxies /api and /ws
```

## Before opening a PR

1. `npm run build` passes.
2. `node scripts/check-upstream.mjs` still matches the local Claude Code CLI/SDK family.
3. No secrets, `data/`, `.env`, transcripts or personal paths are included.
4. UI changes work in light and dark themes and at 390px width.
5. If the change touches Claude Code behavior, update `docs/FEATURE-PARITY.md` or `docs/IMPLEMENTATION.md`.

## Scope

The core is a **structured web console** for Claude Code, not a terminal replacement or a full IDE. Features that turn it into an unstructered terminal, file editor or multi-agent orchestrator are usually out of scope unless discussed first.

## Commit style

Use `feat:`, `fix:`, `docs:`, `refactor:`, `perf:`, `test:` or `chore:`.

## Security

Do not open a public issue for a vulnerability that exposes command execution, authentication bypass or secret leakage. See [SECURITY.md](SECURITY.md).
