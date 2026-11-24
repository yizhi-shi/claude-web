# Security Policy

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
- Same-account lockout after 5 failures for 1 hour; IP login rate limiting.
- Origin checks on state-changing requests and WebSocket handshakes.
- CSP, frame denial, nosniff and no-referrer headers.
- Path allowlist with realpath validation for workspace access.
- Permission timeout and explicit stop semantics.
- Voice keys are masked in API responses and stored server-side only.
- Attachments are stored under `data/attachments/<sessionId>/` with server-generated random names and `0600` permissions; upload/download both require the session cookie and attachment ids are scoped to their session. Client-supplied paths are never used.
- Attachment uploads enforce strict base64 decoding, a MIME syntax check, a display-name basename/sanitization pass, generated disk names, and per-file/count/total size limits server-side. Sidecar metadata is re-validated on every read.
- Only PNG/JPEG/GIF/WebP are treated as images (SVG is deliberately excluded). Non-image files are forced to `application/octet-stream` + `Content-Disposition: attachment`; images use inline disposition with a whitelisted MIME. CSP + `nosniff` further reduce same-origin script execution risk.
- The Fastify request body limit is 18 MB; attachment limits should be kept below it after base64 expansion. Reverse proxies must set a compatible `client_max_body_size`.
- Uploaded files are not virus-scanned and their content enters the model context; treat attachments as untrusted input.
- Side questions run as a forked, non-persisted query with tools removed and every tool request denied; they do not write to the main transcript and are canceled when the requesting socket or session stops.
