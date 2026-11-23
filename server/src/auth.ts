import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import type { AuthFile } from './types.js';
import { atomicWriteJson, readJson, safeEqual } from './util.js';

const AUTH_FILE = path.join(config.dataDir, 'auth.json');
const SECRET_FILE = path.join(config.dataDir, 'session.secret');
const COOKIE_NAME = 'cw_session';

let authFile: AuthFile | null = null;
let secret: Buffer = Buffer.alloc(0);

interface SessionTokenPayload {
  u: string;
  v: number;
  exp: number;
}

export function initAuth(): void {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

  const existing = readJson<AuthFile | null>(AUTH_FILE, null);
  authFile = existing && existing.username && existing.passwordHash ? existing : null;

  if (fs.existsSync(SECRET_FILE)) {
    secret = fs.readFileSync(SECRET_FILE);
  } else {
    secret = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  }
}

export function isSetupRequired(): boolean {
  return authFile === null;
}

const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;

export function setupAdmin(username: string, password: string): void {
  if (authFile) {
    const err = new Error('管理员账号已初始化');
    (err as Error & { statusCode?: number }).statusCode = 409;
    throw err;
  }
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    const err = new Error('用户名只能包含字母、数字、点、下划线、@ 或短横线，长度 1–64');
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
  if (typeof password !== 'string' || password.length < 8) {
    const err = new Error('密码至少 8 位');
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
  authFile = {
    username,
    passwordHash: bcrypt.hashSync(password, 12),
    sessionVersion: 1,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(AUTH_FILE, authFile);
  fs.rmSync(path.join(config.dataDir, 'initial-password.txt'), { force: true });
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function encodeToken(payload: SessionTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function decodeToken(token: string): SessionTokenPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!safeEqual(mac, sign(body))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionTokenPayload;
    if (!parsed || typeof parsed.u !== 'string' || typeof parsed.exp !== 'number') return null;
    if (parsed.exp < Date.now()) return null;
    if (!authFile || parsed.v !== authFile.sessionVersion || parsed.u !== authFile.username) return null;
    return parsed;
  } catch {
    return null;
  }
}

function cookieSecure(req: FastifyRequest): boolean {
  if (config.cookieSecure === 'always') return true;
  if (config.cookieSecure === 'never') return false;
  return req.protocol === 'https';
}

export function issueSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
  if (!authFile) throw new Error('auth is not initialized');
  const payload: SessionTokenPayload = {
    u: authFile.username,
    v: authFile.sessionVersion,
    exp: Date.now() + config.sessionCookieDays * 86_400_000,
  };
  reply.setCookie(COOKIE_NAME, encodeToken(payload), {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieSecure(req),
    maxAge: config.sessionCookieDays * 86_400,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

export interface AuthUser {
  username: string;
}

export function authenticate(req: FastifyRequest): AuthUser | null {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  const payload = decodeToken(token);
  return payload ? { username: payload.u } : null;
}

export function requireAuth(req: FastifyRequest, reply: FastifyReply): AuthUser | null {
  const user = authenticate(req);
  if (!user) {
    void reply.code(401).send({ error: '未登录或会话已过期' });
    return null;
  }
  return user;
}

export async function verifyCredentials(username: string, password: string): Promise<boolean> {
  if (!authFile) return false;
  if (typeof username !== 'string' || typeof password !== 'string') return false;
  if (username !== authFile.username) {
    // Keep the timing similar to a real bcrypt comparison.
    await bcrypt.compare(password, authFile.passwordHash);
    return false;
  }
  return bcrypt.compare(password, authFile.passwordHash);
}

export function getUsername(): string {
  return authFile?.username ?? '';
}

export async function changePassword(current: string, next: string): Promise<void> {
  if (!authFile) throw new Error('auth is not initialized');
  const ok = await bcrypt.compare(current, authFile.passwordHash);
  if (!ok) {
    const err = new Error('当前密码不正确');
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
  if (typeof next !== 'string' || next.length < 8) {
    const err = new Error('新密码至少 8 位');
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
  authFile = {
    ...authFile,
    passwordHash: bcrypt.hashSync(next, 12),
    sessionVersion: authFile.sessionVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(AUTH_FILE, authFile);
  try {
    fs.rmSync(path.join(config.dataDir, 'initial-password.txt'), { force: true });
  } catch {
    // ignore
  }
}

interface Attempt {
  count: number;
  resetAt: number;
}

interface AccountAttempt {
  count: number;
  lockedUntil: number;
  lastFailure: number;
}

const attempts = new Map<string, Attempt>();
const accountAttempts = new Map<string, AccountAttempt>();

function accountKey(username: string): string {
  return username.trim().toLowerCase();
}

export function loginAllowed(ip: string): boolean {
  const entry = attempts.get(ip);
  if (!entry) return true;
  if (Date.now() > entry.resetAt) {
    attempts.delete(ip);
    return true;
  }
  return entry.count < config.loginMaxAttempts;
}

/** Milliseconds until the account may try again; 0 means not locked. */
export function accountLockRemaining(username: string): number {
  const entry = accountAttempts.get(accountKey(username));
  if (!entry) return 0;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

export function recordLoginFailure(ip: string, username: string): number {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + config.loginWindowMs });
  } else {
    entry.count += 1;
  }

  const key = accountKey(username);
  if (!key) return 0;
  const account = accountAttempts.get(key);
  if (!account) {
    accountAttempts.set(key, {
      count: 1,
      lockedUntil: 0,
      lastFailure: now,
    });
    return 0;
  }
  if (account.lockedUntil > now) return account.lockedUntil - now;
  account.count += 1;
  account.lastFailure = now;
  if (account.count >= config.accountLockAttempts) {
    account.lockedUntil = now + config.accountLockMs;
    return account.lockedUntil - now;
  }
  return 0;
}

export function clearLoginFailures(ip: string, username?: string): void {
  attempts.delete(ip);
  if (username) accountAttempts.delete(accountKey(username));
}

export function clearAccountLock(username: string): void {
  accountAttempts.delete(accountKey(username));
}
