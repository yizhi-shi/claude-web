import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HttpError } from './util.js';
import { allRoots, defaultRoot } from './workspaces.js';

const execFileAsync = promisify(execFile);

export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export function validateCwd(input: string): string {
  if (!input || typeof input !== 'string') {
    throw new HttpError(400, '缺少工作目录');
  }
  const abs = path.resolve(expandHome(input));
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new HttpError(400, `目录不存在：${input}`);
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new HttpError(400, `不是目录：${input}`);
  }
  const roots = allRoots();
  if (!roots.some((root) => isWithin(root, real))) {
    throw new HttpError(403, `目录不在允许范围内：${real}`);
  }
  return real;
}

export function createWorkspaceDir(parentInput: string, name: string): string {
  const parent = validateCwd(parentInput);
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean || clean === '.' || clean === '..' || clean.length > 64) {
    throw new HttpError(400, '文件夹名称不合法');
  }
  if (!/^[\p{L}\p{N}._ -]+$/u.test(clean)) {
    throw new HttpError(400, '文件夹名称只能包含文字、数字、空格、点、下划线和短横线');
  }
  const target = path.join(parent, clean);
  if (fs.existsSync(target)) throw new HttpError(409, '同名目录已存在');
  try {
    fs.mkdirSync(target, { recursive: false });
    return fs.realpathSync(target);
  } catch {
    throw new HttpError(500, '创建目录失败');
  }
}

export interface DirEntry {
  name: string;
  path: string;
  isGit: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  roots: string[];
  entries: DirEntry[];
}

const HIDDEN_SKIP = new Set(['node_modules', '__pycache__', 'target', 'dist', 'build', '.git', '.cache']);

export function listDirectory(input?: string): DirListing {
  const roots = allRoots();
  const start = input ? validateCwd(input) : defaultRoot();
  const real = fs.realpathSync(start);
  const entries: DirEntry[] = [];
  try {
    for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
      if (entries.length >= 300) break;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (HIDDEN_SKIP.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
      const full = path.join(real, entry.name);
      let childReal: string;
      try {
        childReal = fs.realpathSync(full);
        if (!fs.statSync(childReal).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!roots.some((root) => isWithin(root, childReal))) continue;
      entries.push({
        name: entry.name,
        path: childReal,
        isGit: fs.existsSync(path.join(childReal, '.git')),
      });
    }
  } catch {
    throw new HttpError(403, `无法读取目录：${real}`);
  }
  entries.sort((a, b) => {
    if (a.isGit !== b.isGit) return a.isGit ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  const containingRoot = roots
    .filter((root) => isWithin(root, real))
    .sort((a, b) => b.length - a.length)[0];
  const parent = containingRoot && real !== containingRoot ? path.dirname(real) : null;

  return { path: real, parent, roots, entries };
}

export interface FileSearchResult {
  files: string[];
  truncated: boolean;
}

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  '__pycache__',
  '.cache',
  '.venv',
]);

function walkFiles(root: string, limit: number): string[] {
  const out: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && out.length < limit) {
    const current = queue.shift();
    if (!current) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || current.depth >= 5) continue;
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      } else if (entry.isFile()) {
        out.push(path.relative(root, path.join(current.dir, entry.name)));
      }
    }
  }
  return out;
}

export async function searchFiles(
  cwd: string | undefined,
  query: string,
  limit = 50,
): Promise<FileSearchResult> {
  if (!cwd) throw new HttpError(400, '缺少 cwd');
  const root = validateCwd(cwd);
  const q = query.trim().toLowerCase();
  const capped = Math.min(Math.max(limit, 1), 100);

  let files: string[] = [];
  try {
    const { stdout } = await execFileAsync(
      'rg',
      [
        '--files',
        '--hidden',
        '--glob',
        '!.git/**',
        '--glob',
        '!node_modules/**',
        '--glob',
        '!dist/**',
        '--glob',
        '!target/**',
        '--glob',
        '!build/**',
      ],
      { cwd: root, timeout: 6000, maxBuffer: 8 * 1024 * 1024 },
    );
    files = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    files = walkFiles(root, 5000);
  }

  const filtered = q ? files.filter((file) => file.toLowerCase().includes(q)) : files;
  return {
    files: filtered.slice(0, capped),
    truncated: filtered.length > capped,
  };
}
