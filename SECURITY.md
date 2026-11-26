# Security Policy

English | [简体中文](SECURITY.zh-CN.md)

## Threat model

Claude Code Web runs a local `claude` CLI as the service user. Anyone who can use the console can execute commands and modify files with that user's permissions. Treat it as a **remote terminal**, not a read-only dashboard.

## Deployment requirements

- Never expose port 8010 directly to the public internet.
- Use HTTPS and a reverse proxy; prefer an additional identity layer such as a single sign-on gateway.
- Run as a dedicated, least-privileged user when possible.
- Keep `ALLOWED_ROOTS` narrow.
- The default permission mode is `default`; `bypassPermissions` is dangerous and should be explicit.
- `data/` contains credentials and transcripts; keep it `0600` and out of Git.

## Reporting

Please use GitHub's **private vulnerability reporting / security advisory** for this repository. Do not include real tokens, passwords, private IPs or customer data in a public issue.

Include:

- affected version/commit;
- reproduction steps;
- impact;
- suggested fix (if known).

## Built-in mitigations

- First-run administrator setup; no default password.
- bcrypt password hashes; HMAC-signed HttpOnly cookies; SameSite=Strict.
- Optional email-code second factor for login. The code is 6 digits, expires after 10 minutes, allows five attempts and is stored only as an HMAC. SMTP can be configured in Settings (saved to `data/mail.json`, 0600) or through `MAIL_ENV_FILE` (0600) as a fallback; the SMTP password is write-only and never returned by the API. Saving SMTP settings sends a test message with the candidate config before committing it.
- Same-account lockout after 5 failures for 1 hour; the counter resets after a completed lock/idle window; IP login rate limiting.
- All `/api/*` routes require the signed-in session token by default. Only health, sign-in/email verification, and image attachments are public; future routes fail closed.
- The unauthenticated `/api/auth/status` response deliberately does not include the administrator username.
- Origin checks on state-changing requests and WebSocket handshakes.
- CSP, frame denial, nosniff and no-referrer headers.
- Path allowlist with realpath validation for workspace access, including sessions imported from Claude history; runtime startup re-validates the cwd.
- Permission timeout and explicit stop semantics.
- Voice keys are masked in API responses and stored server-side only.
- Attachments are stored under `data/attachments/<sessionId>/` with server-generated random names and `0600` permissions; ids are scoped to their session and client-supplied paths are never used. Image attachments are intentionally public capability URLs (random session id + random attachment id) for inline rendering; non-image attachments still require the session token.
- Attachment uploads enforce strict base64 decoding, a MIME syntax check, a display-name basename/sanitization pass, generated disk names, and per-file/count/total size limits server-side. Sidecar metadata is re-validated on every read.
- Only PNG/JPEG/GIF/WebP are treated as images (SVG is deliberately excluded). Non-image files are forced to `application/octet-stream` + `Content-Disposition: attachment`; images use inline disposition with a whitelisted MIME. CSP + `nosniff` further reduce same-origin script execution risk.
- The Fastify request body limit is 18 MB; attachment limits should be kept below it after base64 expansion. Reverse proxies must set a compatible `client_max_body_size`.
- Uploaded files are not virus-scanned and their content enters the model context; treat attachments as untrusted input.
- Tool-result images (images read or produced by the agent) are separate from user attachments: they live under `data/tool-images`, only PNG/JPEG/GIF/WebP are accepted, and reads require a signed-in session and are session-scoped — never a public capability URL.
- Side questions run as an isolated, non-persisted query (`settingSources: []`, no plugins) with tools removed and every tool request denied; they do not write to the main transcript and are canceled when the requesting socket or session stops. A first-event timeout and a total timeout prevent an offline/slow provider from leaving the panel stuck.
- Auto-update is opt-in and disabled for git/flat installs. Release updates require HTTPS, SHA-256 and an Ed25519-signed manifest, validate tar paths/types/links, stage and smoke-test the new release before stopping the service, switch an atomic `current` symlink, and roll back on failure. The web process never replaces its own files; the updater runs as a separate systemd oneshot. The UI cannot supply a feed URL or command.
- MCP status responses are allowlisted: server name/status/scope/source/server info/error/tool names and descriptions only. MCP `config`, `env`, HTTP headers, command paths and tokens are never sent to the browser. Enable/disable and reconnect act on the current SDK session only; the Web UI does not edit MCP config or agent/plugin files.
