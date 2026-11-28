# Security Policy

English | [简体中文](SECURITY.zh-CN.md)

## Supported versions

Security fixes land in the latest release. Before reporting, please check whether the issue still reproduces on the latest version; older versions are usually best upgraded.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security → Report a vulnerability) or a security advisory for this repository. Do not discuss the issue in a public ticket.

Include as much of the following as you can:

- affected version or commit;
- reproduction steps;
- impact (command execution, authentication bypass, information disclosure, etc.);
- a suggested fix, if you have one.

I will confirm and follow up as soon as I can. I will ask before naming you in any public credit.

## Threat model

Claude Code Web starts the local `claude` CLI as the service user. Anyone who can sign in to the console can execute commands and read or modify files with that user's permissions. Treat it as a **remote terminal**, not a read-only dashboard.

Workspaces, uploaded attachments and tool output that the console can reach are equally part of that user's accessible data.

## Deployment requirements

- Never expose port 8010 directly to the public internet.
- Use HTTPS and a reverse proxy; prefer an additional identity layer such as a single sign-on gateway.
- Run as a dedicated, least-privileged user when possible.
- Keep `ALLOWED_ROOTS` narrow.
- Keep the default permission mode (`default`); `bypassPermissions` must be explicit and belongs only on a personal trusted machine.
- `data/` contains accounts, SMTP settings, voice keys and transcripts. Keep the directory `0700` and its files `0600`, and protect it like an SSH private key.

## Built-in protections

### Sign-in and sessions

- The administrator account is created on first run; there is no default password.
- Passwords are bcrypt-hashed. The login cookie is HMAC-signed and set with HttpOnly and SameSite=Strict.
- Optional email-code second factor. The code is 6 digits, expires after 10 minutes, allows five attempts and is stored only as an HMAC. SMTP can be configured in Settings (saved to `data/mail.json`, 0600) or through `MAIL_ENV_FILE` (0600) as a fallback; the SMTP password is write-only and never returned by the API. Saving SMTP settings sends a test message with the candidate config first.
- Five consecutive failures lock the account for one hour; the counter resets after a completed lock or idle window. The login endpoint is also rate-limited per IP.
- The unauthenticated `/api/auth/status` response does not include the administrator username.

### API and browser

- All `/api/*` routes require the signed-in session token by default. Only health, sign-in/email verification and image attachments are public; new routes fail closed.
- Origin checks on state-changing requests and WebSocket handshakes.
- CSP, frame denial, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` headers.

### Workspaces and execution

- Workspace access uses a realpath-validated path allowlist, including sessions imported from Claude history; runtime startup re-validates the cwd.
- Permission approvals have a timeout and explicit stop semantics.
- Voice keys are masked in API responses and stored server-side only.

### Files and attachments

- Attachments are stored under `data/attachments/<sessionId>/` with server-generated random names and `0600` permissions. Attachment ids are scoped to their session, and client-supplied paths are not used.
- Image attachments are public capability URLs by design (random session id + random attachment id) for inline rendering; non-image attachments still require the session token.
- Uploads enforce strict base64 decoding, a MIME syntax check, a display-name basename/sanitization pass, generated disk names, and per-file/count/total size limits server-side. Sidecar metadata is re-validated on every read.
- Only PNG/JPEG/GIF/WebP are treated as images; SVG is not. Non-image files are forced to `application/octet-stream` + `Content-Disposition: attachment`; images use inline disposition with a whitelisted MIME. CSP + `nosniff` further reduce same-origin script execution risk.
- The Fastify request body limit is 18 MB; keep attachment limits below it after base64 expansion. Reverse proxies must set a compatible `client_max_body_size`.
- Tool-result images are separate from user attachments: they live under `data/tool-images`, only PNG/JPEG/GIF/WebP are accepted, and reads require a signed-in session and are session-scoped; they are not public capability URLs.

### Side questions and extensions

- Side questions run as an isolated, non-persisted query (`settingSources: []`, no plugins) with tools removed and every tool request denied. They do not write to the main transcript and are canceled when the requesting socket or session stops. A first-event timeout and a total timeout prevent an offline or slow provider from leaving the panel stuck.
- MCP status responses are allowlisted: server name, status, scope, source, server info, error, tool names and descriptions only. MCP `config`, `env`, HTTP headers, command paths and tokens are not sent to the browser. Enable/disable and reconnect act on the current SDK session only; the Web UI does not edit MCP config or agent/plugin files.

### Auto-update

- Auto-update is opt-in and disabled for git and flat installs.
- Release updates require HTTPS, SHA-256 and an Ed25519-signed manifest, validate tar paths, types and links, stage and smoke-test the new release before stopping the service, switch an atomic `current` symlink, and roll back on failure.
- The web process does not replace its own files; the updater runs as a separate systemd oneshot. The UI cannot supply a feed URL or command.

## Handling your data

- Uploaded files are not virus-scanned and their content enters the model context; treat attachments as untrusted input.
- Transcripts, attachment metadata and tool output live under `data/`. Treat backups and migrations as sensitive data.
- If you suspect a leak, rotate the affected keys (voice providers, SMTP, model providers) first, then review `data/` permissions and reverse-proxy logs.
