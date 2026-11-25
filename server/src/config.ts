import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

function envNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const appRoot = process.cwd();
const dataDir = path.resolve(process.env.DATA_DIR || path.join(appRoot, 'data'));

const PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
]);

function defaultPermissionMode(): string {
  const raw = process.env.DEFAULT_PERMISSION_MODE || 'default';
  return PERMISSION_MODES.has(raw) ? raw : 'default';
}

export const config = {
  appRoot,
  host: process.env.HOST || '0.0.0.0',
  port: envNumber(process.env.PORT, 8010),
  dataDir,
  webDist: path.resolve(process.env.WEB_DIST || path.join(appRoot, 'web', 'dist')),
  mailEnvFile: path.resolve(process.env.MAIL_ENV_FILE || path.join(dataDir, 'mail.env')),
  allowedRootsRaw: (process.env.ALLOWED_ROOTS || os.homedir())
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  defaultWorkspace: (process.env.DEFAULT_WORKSPACE || '').trim(),
  idleMs: envNumber(process.env.SESSION_IDLE_MINUTES, 30) * 60_000,
  permissionTimeoutMs: envNumber(process.env.PERMISSION_TIMEOUT_MINUTES, 30) * 60_000,
  trustProxy: envBool(process.env.TRUST_PROXY, true),
  claudeBin: process.env.CLAUDE_BIN || undefined,
  cookieSecure: (process.env.COOKIE_SECURE || 'auto') as 'auto' | 'always' | 'never',
  sessionCookieDays: envNumber(process.env.SESSION_DAYS, 7),
  maxEventsPerFetch: envNumber(process.env.MAX_EVENTS_PER_FETCH, 50_000),
  maxAttachmentBytes: envNumber(process.env.MAX_ATTACHMENT_MB, 10) * 1024 * 1024,
  maxAttachmentsPerMessage: envNumber(process.env.MAX_ATTACHMENTS, 5),
  maxTotalAttachmentBytes: envNumber(process.env.MAX_TOTAL_ATTACHMENT_MB, 20) * 1024 * 1024,
  loginMaxAttempts: envNumber(process.env.LOGIN_MAX_ATTEMPTS, 8),
  loginWindowMs: envNumber(process.env.LOGIN_WINDOW_MINUTES, 10) * 60_000,
  accountLockAttempts: envNumber(process.env.ACCOUNT_LOCK_ATTEMPTS, 5),
  accountLockMs: envNumber(process.env.ACCOUNT_LOCK_MINUTES, 60) * 60_000,
  defaultPermissionMode: defaultPermissionMode(),
  maxTranscriptImportBytes: envNumber(process.env.MAX_TRANSCRIPT_IMPORT_MB, 128) * 1024 * 1024,
  logLevel: process.env.LOG_LEVEL || 'info',
  // Optional egress proxy for voice/LLM HTTP calls (e.g. the local 129 mihomo).
  voiceProxyUrl: (process.env.VOICE_PROXY_URL || '').trim(),
  geminiLiveUrl: (process.env.GEMINI_LIVE_URL || '').trim(),
  geminiLiveProxyToken: (process.env.GEMINI_LIVE_PROXY_TOKEN || '').trim(),
  geminiLiveModel: (process.env.GEMINI_LIVE_MODEL || 'gemini-3.5-transcribe-live').trim(),
};

export function ensureDataDirs(): void {
  for (const dir of ['', 'transcripts', 'sessions', 'attachments']) {
    fs.mkdirSync(path.join(config.dataDir, dir), { recursive: true, mode: 0o700 });
  }
}

/**
 * The web console usually runs as a systemd service, where the interactive
 * shell environment is absent. Claude Code itself keeps provider wiring in
 * ~/.claude/settings.json (`env`), so mirror that into our process before any
 * SDK query is spawned. Existing process env wins, which lets the service
 * environment override the file.
 */
export function loadClaudeSettingsEnv(): void {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      env?: Record<string, unknown>;
    };
    for (const [key, value] of Object.entries(parsed.env ?? {})) {
      if (process.env[key] !== undefined) continue;
      if (value === null || value === undefined) continue;
      process.env[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  } catch {
    // No settings file is a valid setup (API key can come from the service env).
  }
}

export function childEnv(): Record<string, string> {
  const drop = new Set([
    'CLAUDECODE',
    'CLAUDE_PID',
    'AI_AGENT',
    'CLAUDE_AGENT_SDK_VERSION',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_CHILD_NOTES_DIR',
    'CLAUDE_CODE_AUTO_MODE_SERVER',
    'CLAUDE_CODE_STARTUP_FAILURE_RESULTS',
    'CLAUDE_CODE_EMIT_STARTUP_TIMING',
    'CLAUDE_CODE_SESSION_ATTENDED',
  ]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || drop.has(key)) continue;
    env[key] = value;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'claude-web/0.11.0';
  return env;
}
