import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

export interface VersionInfo {
  cli: string;
  sdk: string;
  vscodeExtension: string;
  node: string;
  claudeWeb: string;
}

let cached: VersionInfo | null = null;

function readPackageVersion(file: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string };
    return parsed.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function readCliVersion(): string {
  try {
    const out = execFileSync(config.claudeBin || 'claude', ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      env: process.env,
    });
    const match = out.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
    return match?.[1] ?? out.trim().split('\n')[0] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function readExtensionVersion(): string {
  const roots = [
    path.join(os.homedir(), '.vscode-server', 'extensions'),
    path.join(os.homedir(), '.vscode', 'extensions'),
  ];
  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root);
      const hit = entries
        .filter((name) => name.startsWith('anthropic.claude-code-'))
        .sort()
        .pop();
      if (hit) return hit.replace('anthropic.claude-code-', '');
    } catch {
      // try next location
    }
  }
  return 'not-installed';
}

export function getVersions(): VersionInfo {
  if (cached) return cached;
  cached = {
    cli: readCliVersion(),
    sdk: readPackageVersion(
      path.join(config.appRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
    ),
    vscodeExtension: readExtensionVersion(),
    node: process.version.replace(/^v/, ''),
    claudeWeb: config.appVersion,
  };
  return cached;
}
