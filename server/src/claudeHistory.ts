import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { config } from './config.js';
import { truncate } from './util.js';

export interface ClaudeSessionSummary {
  id: string;
  cwd: string;
  title: string;
  model?: string;
  createdAt?: string;
  updatedAt: string;
  file: string;
  size: number;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: ClaudeSessionSummary;
}

const projectsDir = path.join(os.homedir(), '.claude', 'projects');
const cache = new Map<string, CacheEntry>();

function firstText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

function cleanTitle(text: string): string {
  const stripped = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .trim();
  return truncate(stripped || text, 80) || '未命名会话';
}

async function parseSummary(file: string): Promise<ClaudeSessionSummary | null> {
  const stat = await fsp.stat(file);
  const id = path.basename(file, '.jsonl');
  const summary: ClaudeSessionSummary = {
    id,
    cwd: '',
    title: '',
    updatedAt: stat.mtime.toISOString(),
    file,
    size: stat.size,
  };

  let lines = 0;
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lines += 1;
      if (lines > 500) break;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const createdAt = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
      if (!summary.createdAt && createdAt) summary.createdAt = createdAt;
      if (!summary.cwd && typeof entry.cwd === 'string') summary.cwd = entry.cwd;
      if (entry.isSidechain === true || entry.isMeta === true) continue;
      const message = entry.message as
        | { role?: string; model?: string; content?: unknown }
        | undefined;
      if (!summary.model && typeof message?.model === 'string') summary.model = message.model;
      if (!summary.title && entry.type === 'user' && message?.role === 'user') {
        const text = firstText(message.content);
        if (text.trim()) summary.title = cleanTitle(text);
      }
      if (summary.cwd && summary.title) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  summary.title = summary.title || '未命名会话';
  return summary;
}

export async function listClaudeSessions(limit = 500): Promise<ClaudeSessionSummary[]> {
  let dirs: fs.Dirent[];
  try {
    dirs = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: ClaudeSessionSummary[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(projectsDir, dir.name);
    let files: fs.Dirent[];
    try {
      files = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const full = path.join(dirPath, file.name);
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      const cached = cache.get(full);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        out.push(cached.summary);
        continue;
      }
      try {
        const summary = await parseSummary(full);
        if (summary) {
          cache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
          out.push(summary);
        }
      } catch {
        // skip unreadable file
      }
    }
  }

  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out.slice(0, limit);
}

export async function findClaudeSession(id: string): Promise<ClaudeSessionSummary | null> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  const sessions = await listClaudeSessions(5000);
  return sessions.find((session) => session.id === id) ?? null;
}

export async function readClaudeTranscript(id: string): Promise<Record<string, unknown>[]> {
  const summary = await findClaudeSession(id);
  if (!summary) return [];
  if (summary.size > config.maxTranscriptImportBytes) {
    throw new Error(
      `会话文件过大（${Math.round(summary.size / 1024 / 1024)}MB），暂不导入，可在终端继续该会话`,
    );
  }
  const raw = await fsp.readFile(summary.file, 'utf8');
  const lines: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') lines.push(parsed);
    } catch {
      // ignore torn line
    }
  }
  return lines;
}

export interface ProjectSummary {
  cwd: string;
  sessions: number;
  lastUpdated: string;
}

export async function listRecentProjects(limit = 50): Promise<ProjectSummary[]> {
  const sessions = await listClaudeSessions(2000);
  const map = new Map<string, ProjectSummary>();
  for (const session of sessions) {
    if (!session.cwd) continue;
    const existing = map.get(session.cwd);
    if (existing) {
      existing.sessions += 1;
      if (session.updatedAt > existing.lastUpdated) existing.lastUpdated = session.updatedAt;
    } else {
      map.set(session.cwd, { cwd: session.cwd, sessions: 1, lastUpdated: session.updatedAt });
    }
  }
  return [...map.values()]
    .sort((a, b) => (a.lastUpdated < b.lastUpdated ? 1 : -1))
    .slice(0, limit);
}
