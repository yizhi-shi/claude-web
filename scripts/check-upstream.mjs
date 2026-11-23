#!/usr/bin/env node
/**
 * Print the locally installed Claude Code versions so feature-parity work is
 * anchored on evidence rather than assumptions.
 *
 * Run after updating the VSCode extension or the CLI:
 *   node scripts/check-upstream.mjs
 *
 * Then compare docs/FEATURE-PARITY.md against the extension's release notes
 * and re-run the smoke script (npm run smoke).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readCliVersion() {
  try {
    const out = execFileSync(process.env.CLAUDE_BIN || 'claude', ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    return out.trim();
  } catch {
    return 'not found';
  }
}

function readExtensionVersions() {
  const roots = [
    path.join(os.homedir(), '.vscode-server', 'extensions'),
    path.join(os.homedir(), '.vscode', 'extensions'),
  ];
  const found = [];
  for (const root of roots) {
    try {
      for (const name of fs.readdirSync(root)) {
        if (!name.startsWith('anthropic.claude-code-')) continue;
        const pkg = readJson(path.join(root, name, 'package.json'));
        found.push({
          dir: name,
          version: pkg?.version || 'unknown',
          path: path.join(root, name),
        });
      }
    } catch {
      // ignore missing location
    }
  }
  return found;
}

function findSdkVersion() {
  const candidates = [
    path.join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
    path.join(process.cwd(), '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
  ];
  for (const file of candidates) {
    const pkg = readJson(file);
    if (pkg?.version) return pkg.version;
  }
  return 'not installed';
}

const report = {
  cli: readCliVersion(),
  sdk: findSdkVersion(),
  vscodeExtensions: readExtensionVersions(),
  featureParityDoc: fs.existsSync(path.join(process.cwd(), 'docs', 'FEATURE-PARITY.md')),
  checkedAt: new Date().toISOString(),
};

console.log(JSON.stringify(report, null, 2));
