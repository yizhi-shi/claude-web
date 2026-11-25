#!/usr/bin/env node
/**
 * Emergency local override: disable email verification for the admin account.
 *
 * Use this only when SMTP is broken or the mailbox is unavailable and you
 * cannot complete an email-code login. It requires shell access to the data
 * directory, so it must never be exposed through the Web UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const file = path.join(dataDir, 'security.json');
let current = {};
try {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed && typeof parsed === 'object') current = parsed;
} catch {
  // A missing or corrupt file is fine: create a clean disabled record.
}
const next = {
  version: 1,
  email: typeof current.email === 'string' ? current.email : '',
  emailVerificationEnabled: false,
  updatedAt: new Date().toISOString(),
};
const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
fs.renameSync(tmp, file);
console.log(`email verification disabled in ${file}`);
