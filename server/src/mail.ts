import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { atomicWriteJson, HttpError, readJson } from './util.js';

type MailSecurity = 'ssl' | 'starttls';
type MailSource = 'file' | 'env' | 'none';

interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  user: string;
  pass: string;
  from: string;
  fromName: string;
  to: string;
}

interface SavedMailFile {
  version: 1;
  host: string;
  port: number;
  security: MailSecurity;
  user: string;
  pass: string;
  from: string;
  fromName: string;
  updatedAt: string;
}

export interface MailSettingsView {
  configured: boolean;
  source: MailSource;
  host: string;
  port: number;
  security: MailSecurity;
  user: string;
  from: string;
  fromName: string;
  /** The password is write-only; the API never returns it. */
  hasPassword: boolean;
}

export interface MailSettingsInput {
  host?: unknown;
  port?: unknown;
  security?: unknown;
  user?: unknown;
  password?: unknown;
  from?: unknown;
  fromName?: unknown;
}

const ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAIL_FILE = path.join(config.dataDir, 'mail.json');

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return values;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed
      .slice(index + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    values[key] = value;
  }
  return values;
}

function envValue(env: Record<string, string>, names: string[]): string {
  for (const name of names) {
    const value = clean(env[name]);
    if (value) return value;
  }
  return '';
}

function assertAddress(value: string, label: string): string {
  const address = clean(value);
  if (!address || address.length > 254 || /[\r\n]/.test(address) || !ADDRESS_RE.test(address)) {
    throw new HttpError(400, `${label}邮箱地址无效`);
  }
  return address;
}

function normalizeSecurity(value: unknown): MailSecurity {
  const raw = clean(value).toLowerCase();
  return raw === 'starttls' || raw === 'tls' ? 'starttls' : 'ssl';
}

function normalizePort(value: unknown, fallback: number): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    if (value === undefined || value === '') return fallback;
    throw new HttpError(400, 'SMTP 端口无效');
  }
  return port;
}

function makeConfig(input: {
  host: string;
  port: number;
  security: MailSecurity;
  user: string;
  pass: string;
  from: string;
  fromName: string;
  to?: string;
}): MailConfig {
  const host = clean(input.host);
  const user = clean(input.user);
  const pass = clean(input.pass);
  const from = assertAddress(input.from || user, '发件');
  if (!host || /[\s/]/.test(host)) throw new HttpError(400, 'SMTP 服务器地址无效');
  if (!user) throw new HttpError(400, 'SMTP 用户名不能为空');
  if (!pass) throw new HttpError(400, 'SMTP 密码不能为空');
  const secure = input.security === 'ssl';
  return {
    host,
    port: normalizePort(input.port, secure ? 465 : 587),
    secure,
    requireTls: !secure,
    user,
    pass,
    from,
    fromName: clean(input.fromName) || 'Claude Code Web',
    to: clean(input.to),
  };
}

function savedConfig(): { config: MailConfig; source: MailSource } | null {
  const parsed = readJson<SavedMailFile | null>(MAIL_FILE, null);
  if (!parsed || parsed.version !== 1 || typeof parsed !== 'object') return null;
  try {
    const cfg = makeConfig({
      host: parsed.host,
      port: parsed.port,
      security: normalizeSecurity(parsed.security),
      user: parsed.user,
      pass: parsed.pass,
      from: parsed.from,
      fromName: parsed.fromName,
    });
    return { config: cfg, source: 'file' };
  } catch {
    return null;
  }
}

function envConfig(): { config: MailConfig; source: MailSource } | null {
  const file = config.mailEnvFile;
  const fileEnv = file ? parseEnvFile(path.resolve(file)) : {};
  const env: Record<string, string> = { ...fileEnv };
  for (const key of [
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURITY',
    'SMTP_USER',
    'SMTP_PASS',
    'MAIL_FROM',
    'MAIL_FROM_NAME',
    'MAIL_TO',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key] as string;
  }
  const host = envValue(env, ['SMTP_HOST']);
  const user = envValue(env, ['SMTP_USER']);
  const pass = envValue(env, ['SMTP_PASS']);
  const from = envValue(env, ['MAIL_FROM']) || user;
  if (!host || !user || !pass || !from) return null;
  try {
    return {
      config: makeConfig({
        host,
        port: Number(envValue(env, ['SMTP_PORT']) || 465),
        security: normalizeSecurity(envValue(env, ['SMTP_SECURITY'])),
        user,
        pass,
        from,
        fromName: envValue(env, ['MAIL_FROM_NAME']),
        to: envValue(env, ['MAIL_TO']),
      }),
      source: 'env',
    };
  } catch {
    return null;
  }
}

function resolved(): { config: MailConfig; source: MailSource } | null {
  return savedConfig() ?? envConfig();
}

function readConfig(): MailConfig | null {
  return resolved()?.config ?? null;
}

export function isMailConfigured(): boolean {
  return resolved() !== null;
}

export function getMailSettingsView(): MailSettingsView {
  const value = resolved();
  if (!value) {
    return {
      configured: false,
      source: 'none',
      host: '',
      port: 465,
      security: 'ssl',
      user: '',
      from: '',
      fromName: 'Claude Code Web',
      hasPassword: false,
    };
  }
  const cfg = value.config;
  return {
    configured: true,
    source: value.source,
    host: cfg.host,
    port: cfg.port,
    security: cfg.secure ? 'ssl' : 'starttls',
    user: cfg.user,
    from: cfg.from,
    fromName: cfg.fromName,
    hasPassword: true,
  };
}

/** Default recipient when the admin has not saved one yet. */
export function defaultMailRecipient(): string {
  return readConfig()?.to ?? '';
}

export function maskEmail(value: string): string {
  const email = clean(value);
  const at = email.lastIndexOf('@');
  if (at <= 0) return email ? '***' : '';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain) return '***';
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(2, Math.min(6, local.length - visible.length)))}@${domain}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendMailWith(
  cfg: MailConfig,
  input: { to: string; subject: string; text: string; html?: string },
): Promise<void> {
  const to = assertAddress(input.to, '收件');
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTls,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
    tls: { minVersion: 'TLSv1.2' },
  });
  try {
    await transport.sendMail({
      from: { name: cfg.fromName, address: cfg.from },
      to,
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
    });
  } catch (error) {
    // Do not include the SMTP password; the response to the browser is generic.
    console.error(
      '[claude-web] mail send failed:',
      error instanceof Error ? error.message : String(error),
    );
    throw new HttpError(502, '邮件发送失败，请检查 SMTP 配置或稍后重试');
  } finally {
    transport.close();
  }
}

async function sendMail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<void> {
  const cfg = readConfig();
  if (!cfg) throw new HttpError(503, '邮件服务未配置，无法发送邮箱验证码');
  await sendMailWith(cfg, input);
}

/** Build a candidate config for validation/testing without saving it. */
export function prepareMailSettings(input: MailSettingsInput): MailConfig {
  const current = readConfig();
  const password = clean(input.password) || current?.pass || '';
  return makeConfig({
    host: clean(input.host) || current?.host || '',
    port: normalizePort(input.port, current?.port ?? 465),
    security:
      input.security === undefined || input.security === ''
        ? current
          ? current.secure
            ? 'ssl'
            : 'starttls'
          : 'ssl'
        : normalizeSecurity(input.security),
    user: clean(input.user) || current?.user || '',
    pass: password,
    from: clean(input.from) || current?.from || '',
    fromName: clean(input.fromName) || current?.fromName || 'Claude Code Web',
  });
}

export async function testMailConfig(cfg: MailConfig, to: string): Promise<void> {
  const text = [
    'Claude Code Web 邮件服务测试',
    '',
    '如果你收到这封邮件，说明当前的 SMTP 配置可用于登录邮箱验证。',
    '',
    '这封邮件不包含验证码，不需要回复。',
  ].join('\n');
  const html = `<p>Claude Code Web 邮件服务测试</p>
<p>如果你收到这封邮件，说明当前的 SMTP 配置可用于登录邮箱验证。</p>
<p>这封邮件不包含验证码，不需要回复。</p>`;
  await sendMailWith(cfg, { to, subject: 'Claude Code Web 邮件服务测试', text, html });
}

export async function updateMailSettings(
  input: MailSettingsInput,
  testRecipient?: string,
): Promise<MailSettingsView> {
  const cfg = prepareMailSettings(input);
  if (testRecipient) await testMailConfig(cfg, testRecipient);
  const saved: SavedMailFile = {
    version: 1,
    host: cfg.host,
    port: cfg.port,
    security: cfg.secure ? 'ssl' : 'starttls',
    user: cfg.user,
    pass: cfg.pass,
    from: cfg.from,
    fromName: cfg.fromName,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(MAIL_FILE, saved);
  return getMailSettingsView();
}

export async function sendLoginCode(
  to: string,
  code: string,
  expiresMinutes: number,
): Promise<void> {
  const safeCode = String(code).replace(/\D/g, '').slice(0, 6);
  const text = [
    'Claude Code Web 登录验证',
    '',
    `你的邮箱验证码是：${safeCode}`,
    '',
    `验证码 ${expiresMinutes} 分钟内有效，只能使用一次。`,
    '如果这不是你本人的操作，请忽略这封邮件并考虑修改密码。',
  ].join('\n');
  const html = `<p>Claude Code Web 登录验证</p>
<p>你的邮箱验证码是：<strong style="font-size:22px;letter-spacing:4px">${escapeHtml(safeCode)}</strong></p>
<p>验证码 ${expiresMinutes} 分钟内有效，只能使用一次。</p>
<p>如果这不是你本人的操作，请忽略这封邮件并考虑修改密码。</p>`;
  await sendMail({ to, subject: 'Claude Code Web 登录验证码', text, html });
}

export async function sendSecurityNotice(to: string, enabled: boolean): Promise<void> {
  const title = enabled ? '邮箱验证已开启' : '邮箱验证已关闭';
  const text = [
    `Claude Code Web：${title}`,
    '',
    enabled
      ? '以后登录时，输入密码后还需要输入发送到本邮箱的验证码。'
      : '以后登录只需要密码。',
    '',
    '如果这不是你本人的操作，请立即修改密码并检查服务器。',
  ].join('\n');
  const html = `<p>Claude Code Web：<strong>${escapeHtml(title)}</strong></p>
<p>${escapeHtml(enabled ? '以后登录时，输入密码后还需要输入发送到本邮箱的验证码。' : '以后登录只需要密码。')}</p>
<p>如果这不是你本人的操作，请立即修改密码并检查服务器。</p>`;
  await sendMail({ to, subject: `Claude Code Web：${title}`, text, html });
}

export async function sendSecurityTest(to: string): Promise<void> {
  const cfg = readConfig();
  if (!cfg) throw new HttpError(503, '邮件服务未配置，无法发送测试邮件');
  await testMailConfig(cfg, to);
}
