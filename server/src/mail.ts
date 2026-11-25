import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { HttpError } from './util.js';

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

const ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

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

/** Read SMTP settings from MAIL_ENV_FILE first, then process env. */
function readConfig(): MailConfig | null {
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
  if (!ADDRESS_RE.test(from)) return null;

  const port = Number(envValue(env, ['SMTP_PORT']) || 465);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const security = (envValue(env, ['SMTP_SECURITY']) || 'ssl').toLowerCase();
  const secure = security !== 'starttls' && security !== 'tls';
  const fromName = envValue(env, ['MAIL_FROM_NAME']) || 'Claude Code Web';

  return {
    host,
    port,
    secure,
    requireTls: !secure,
    user,
    pass,
    from,
    fromName,
    to: envValue(env, ['MAIL_TO']),
  };
}

export function isMailConfigured(): boolean {
  return readConfig() !== null;
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

function assertAddress(value: string, label: string): string {
  const address = clean(value);
  if (!address || address.length > 254 || /[\r\n]/.test(address) || !ADDRESS_RE.test(address)) {
    throw new HttpError(400, `${label}邮箱地址无效`);
  }
  return address;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendMail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<void> {
  const cfg = readConfig();
  if (!cfg) throw new HttpError(503, '邮件服务未配置，无法发送邮箱验证码');
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
  const text = [
    'Claude Code Web 邮件服务测试',
    '',
    '如果你收到这封邮件，说明 SMTP 配置可用于登录邮箱验证。',
    '',
    '这封邮件不包含验证码，不需要回复。',
  ].join('\n');
  const html = `<p>Claude Code Web 邮件服务测试</p>
<p>如果你收到这封邮件，说明 SMTP 配置可用于登录邮箱验证。</p>
<p>这封邮件不包含验证码，不需要回复。</p>`;
  await sendMail({ to, subject: 'Claude Code Web 邮件服务测试', text, html });
}
