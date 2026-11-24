#!/usr/bin/env node
/**
 * Emergency password reset for operators with shell access.
 *
 *   node scripts/set-password.mjs <username> <password>
 *
 * Normal users should use the first-run setup screen and the in-app
 * "修改密码" form instead.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');

const [, , username, password] = process.argv;
if (!username || !password) {
  console.error('usage: node scripts/set-password.mjs <username> <password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('password must be at least 8 characters');
  process.exit(1);
}

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const file = path.join(dataDir, 'auth.json');

let existing = null;
try {
  existing = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  existing = null;
}

const next = {
  username,
  passwordHash: bcrypt.hashSync(password, 12),
  sessionVersion: (existing?.sessionVersion || 0) + 1,
  updatedAt: new Date().toISOString(),
};
fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
fs.rmSync(path.join(dataDir, 'initial-password.txt'), { force: true });

console.log(`updated credentials for "${username}" in ${file}`);
