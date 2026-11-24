import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { nowIso } from './util.js';

const auditFile = path.join(config.dataDir, 'audit.jsonl');

export function audit(action: string, detail: Record<string, unknown> = {}, ip?: string): void {
  try {
    fs.appendFileSync(
      auditFile,
      `${JSON.stringify({ ts: nowIso(), action, ip: ip ?? null, ...detail })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Auditing must never take the console down.
  }
}
