import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { audit } from './audit.js';
import { getUsername, hmacHex, verifyCurrentPassword } from './auth.js';
import { config } from './config.js';
import {
  defaultMailRecipient,
  isMailConfigured,
  maskEmail,
  sendLoginCode,
  sendSecurityNotice,
  sendSecurityTest as sendMailTest,
} from './mail.js';
import { atomicWriteJson, HttpError, safeEqual } from './util.js';

const SECURITY_FILE = path.join(config.dataDir, 'security.json');
const CODE_TTL_MS = 10 * 60_000;
const CODE_MAX_ATTEMPTS = 5;
const SEND_COOLDOWN_MS = 60_000;
const SEND_WINDOW_MS = 15 * 60_000;
const SEND_WINDOW_MAX = 5;
const ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export interface SecurityView {
  email: string;
  emailVerificationEnabled: boolean;
  emailConfigured: boolean;
}

interface SecurityFile {
  version: 1;
  email: string;
  emailVerificationEnabled: boolean;
  updatedAt: string;
}

interface Challenge {
  id: string;
  username: string;
  email: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  sentAt: number;
  sendCount: number;
}

interface SendWindow {
  windowStart: number;
  count: number;
  lastSentAt: number;
}

let security: SecurityFile | null = null;
const challenges = new Map<string, Challenge>();
const sendWindows = new Map<string, SendWindow>();

function normalizeEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email) return '';
  if (email.length > 254 || /[\r\n]/.test(email) || !ADDRESS_RE.test(email)) {
    throw new HttpError(400, '邮箱地址无效');
  }
  return email;
}

function loadFile(): SecurityFile {
  if (!fs.existsSync(SECURITY_FILE)) {
    return {
      version: 1,
      email: defaultMailRecipient(),
      emailVerificationEnabled: false,
      updatedAt: '',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(SECURITY_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取 ${SECURITY_FILE}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('security.json 格式无效');
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.emailVerificationEnabled !== 'boolean') {
    throw new Error('security.json 格式无效');
  }
  const email = normalizeEmail(raw.email);
  if (raw.emailVerificationEnabled && !email) {
    throw new Error('security.json 已开启邮箱验证但缺少邮箱地址');
  }
  return {
    version: 1,
    email,
    emailVerificationEnabled: raw.emailVerificationEnabled,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

export function initSecurity(): void {
  security = loadFile();
  if (security.emailVerificationEnabled && !isMailConfigured()) {
    console.warn(
      '[claude-web] email verification is enabled but SMTP is not configured; logins will fail closed',
    );
  }
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, challenge] of challenges) {
      if (challenge.expiresAt <= now) challenges.delete(id);
    }
  }, 5 * 60_000);
  timer.unref?.();
}

function state(): SecurityFile {
  if (!security) security = loadFile();
  return security;
}

function save(next: SecurityFile): void {
  security = next;
  atomicWriteJson(SECURITY_FILE, next);
}

export function isEmailVerificationEnabled(): boolean {
  return state().emailVerificationEnabled;
}

export function getSecurityView(): SecurityView {
  const current = state();
  return {
    email: current.email,
    emailVerificationEnabled: current.emailVerificationEnabled,
    emailConfigured: isMailConfigured(),
  };
}

async function requireCurrentPassword(password: unknown): Promise<void> {
  const value = typeof password === 'string' ? password : '';
  if (!(await verifyCurrentPassword(value))) {
    throw new HttpError(400, '当前密码不正确');
  }
}

function sendWindow(username: string): SendWindow | null {
  const now = Date.now();
  const entry = sendWindows.get(username);
  if (!entry) return null;
  if (entry.lastSentAt && now - entry.lastSentAt < SEND_COOLDOWN_MS) {
    throw new HttpError(429, `请 ${Math.ceil((SEND_COOLDOWN_MS - (now - entry.lastSentAt)) / 1000)} 秒后再试`);
  }
  if (now - entry.windowStart >= SEND_WINDOW_MS) {
    sendWindows.set(username, { windowStart: now, count: 0, lastSentAt: entry.lastSentAt });
    return sendWindows.get(username) ?? null;
  }
  if (entry.count >= SEND_WINDOW_MAX) {
    throw new HttpError(429, '验证码发送过于频繁，请稍后再试');
  }
  return entry;
}

function markSend(username: string): void {
  const now = Date.now();
  const entry = sendWindows.get(username);
  if (!entry || now - entry.windowStart >= SEND_WINDOW_MS) {
    sendWindows.set(username, { windowStart: now, count: 1, lastSentAt: now });
    return;
  }
  entry.count += 1;
  entry.lastSentAt = now;
}

function newChallengeId(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function codeHash(challengeId: string, code: string): string {
  return hmacHex(`${challengeId}:${code}`);
}

function makeCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export async function updateSecurity(input: {
  enabled?: unknown;
  email?: unknown;
  currentPassword?: unknown;
}): Promise<SecurityView> {
  await requireCurrentPassword(input.currentPassword);
  const current = state();
  const enabled =
    typeof input.enabled === 'boolean' ? input.enabled : current.emailVerificationEnabled;
  const email = input.email === undefined ? current.email : normalizeEmail(input.email);
  if (enabled && !email) throw new HttpError(400, '开启邮箱验证前请填写邮箱地址');
  if (enabled && !isMailConfigured()) {
    throw new HttpError(503, '服务端未配置 SMTP，暂时无法开启邮箱验证');
  }
  const notify = enabled && (!current.emailVerificationEnabled || email !== current.email);
  if (notify) {
    try {
      await sendSecurityNotice(email, true);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, '邮箱验证通知发送失败，设置未保存');
    }
  }
  const next: SecurityFile = {
    version: 1,
    email,
    emailVerificationEnabled: enabled,
    updatedAt: new Date().toISOString(),
  };
  save(next);
  audit('security.email_verification', {
    enabled,
    email: maskEmail(email),
  });
  return getSecurityView();
}

export async function sendSecurityTest(currentPassword: unknown): Promise<void> {
  await requireCurrentPassword(currentPassword);
  const current = state();
  if (!current.email) throw new HttpError(400, '请先填写邮箱地址');
  if (!isMailConfigured()) throw new HttpError(503, '服务端未配置 SMTP');
  const username = getUsername();
  sendWindow(username);
  markSend(username);
  try {
    await sendMailTest(current.email);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, '测试邮件发送失败');
  }
  audit('security.email_test', { email: maskEmail(current.email) });
}

export interface LoginChallengeView {
  challengeId: string;
  emailHint: string;
  expiresAt: number;
  resendAfterMs: number;
}

export async function beginLoginChallenge(username: string): Promise<LoginChallengeView> {
  const current = state();
  if (!current.emailVerificationEnabled) {
    throw new HttpError(409, '邮箱验证未开启');
  }
  if (!current.email) throw new HttpError(503, '邮箱验证缺少收件地址');
  if (!isMailConfigured()) throw new HttpError(503, '邮件服务未配置，无法登录');
  sendWindow(username);
  const id = newChallengeId();
  const code = makeCode();
  const expiresAt = Date.now() + CODE_TTL_MS;
  markSend(username);
  try {
    await sendLoginCode(current.email, code, CODE_TTL_MS / 60_000);
  } catch (error) {
    audit('login.email_send.failed', { username });
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, '验证码发送失败，请稍后重试');
  }
  const challenge: Challenge = {
    id,
    username,
    email: current.email,
    codeHash: codeHash(id, code),
    expiresAt,
    attempts: 0,
    sentAt: Date.now(),
    sendCount: 1,
  };
  // Only one live challenge per account; older codes stop working.
  for (const [key, value] of challenges) {
    if (value.username === username) challenges.delete(key);
  }
  challenges.set(id, challenge);
  audit('login.email_sent', { username, email: maskEmail(current.email) });
  return {
    challengeId: id,
    emailHint: maskEmail(current.email),
    expiresAt,
    resendAfterMs: SEND_COOLDOWN_MS,
  };
}

export async function resendLoginChallenge(challengeId: string): Promise<LoginChallengeView> {
  const challenge = challenges.get(challengeId);
  if (!challenge || challenge.expiresAt <= Date.now()) {
    challenges.delete(challengeId);
    throw new HttpError(400, '验证码已失效，请重新登录');
  }
  const key = challenge.username;
  sendWindow(key);
  const code = makeCode();
  markSend(key);
  try {
    await sendLoginCode(challenge.email, code, CODE_TTL_MS / 60_000);
  } catch (error) {
    audit('login.email_resend.failed', { username: key });
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, '验证码发送失败，请稍后重试');
  }
  challenge.codeHash = codeHash(challenge.id, code);
  challenge.expiresAt = Date.now() + CODE_TTL_MS;
  challenge.sentAt = Date.now();
  challenge.sendCount += 1;
  audit('login.email_resent', { username: key, email: maskEmail(challenge.email) });
  return {
    challengeId: challenge.id,
    emailHint: maskEmail(challenge.email),
    expiresAt: challenge.expiresAt,
    resendAfterMs: SEND_COOLDOWN_MS,
  };
}

export interface VerifiedChallenge {
  username: string;
  email: string;
}

export async function verifyLoginChallenge(
  challengeId: string,
  code: string,
): Promise<VerifiedChallenge> {
  const challenge = challenges.get(challengeId);
  if (!challenge || challenge.expiresAt <= Date.now()) {
    challenges.delete(challengeId);
    throw new HttpError(400, '验证码已失效，请重新登录');
  }
  if (challenge.attempts >= CODE_MAX_ATTEMPTS) {
    challenges.delete(challengeId);
    throw new HttpError(429, '验证码错误次数过多，请重新登录');
  }
  const normalized = typeof code === 'string' ? code.trim() : '';
  const matches =
    /^\d{6}$/.test(normalized) &&
    safeEqual(codeHash(challengeId, normalized), challenge.codeHash);
  if (!matches) {
    challenge.attempts += 1;
    const remaining = CODE_MAX_ATTEMPTS - challenge.attempts;
    audit('login.email_failed', {
      username: challenge.username,
      attempts: challenge.attempts,
    });
    if (remaining <= 0) {
      challenges.delete(challengeId);
      throw new HttpError(429, '验证码错误次数过多，请重新登录');
    }
    throw new HttpError(401, `邮箱验证码不正确，还可尝试 ${remaining} 次`);
  }
  challenges.delete(challengeId);
  audit('login.email_verified', {
    username: challenge.username,
    email: maskEmail(challenge.email),
  });
  return { username: challenge.username, email: challenge.email };
}
