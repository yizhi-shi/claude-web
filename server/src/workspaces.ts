import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { atomicWriteJson, HttpError, readJson } from './util.js';

interface WorkspaceFile {
  version: 1;
  defaultRoot?: string;
  extraRoots?: string[];
}

const file = () => path.join(config.dataDir, 'workspaces.json');

let cache: WorkspaceFile | null = null;

function load(): WorkspaceFile {
  if (cache) return cache;
  const parsed = readJson<WorkspaceFile | null>(file(), null);
  cache = {
    version: 1,
    defaultRoot: typeof parsed?.defaultRoot === 'string' ? parsed.defaultRoot : undefined,
    extraRoots: Array.isArray(parsed?.extraRoots)
      ? parsed.extraRoots.filter((item): item is string => typeof item === 'string')
      : [],
  };
  return cache;
}

function save(next: WorkspaceFile): void {
  cache = next;
  atomicWriteJson(file(), next);
}

function realDir(input: string): string | null {
  try {
    const real = fs.realpathSync(path.resolve(input));
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export function envRoots(): string[] {
  const out: string[] = [];
  for (const raw of config.allowedRootsRaw) {
    const real = realDir(raw);
    if (real && !out.includes(real)) out.push(real);
  }
  if (out.length === 0) out.push(os.homedir());
  return out;
}

export function extraRoots(): string[] {
  const out: string[] = [];
  for (const raw of load().extraRoots ?? []) {
    const real = realDir(raw);
    if (real && !out.includes(real)) out.push(real);
  }
  return out;
}

export function allRoots(): string[] {
  return [...new Set([...envRoots(), ...extraRoots()])];
}

export function defaultRoot(): string {
  const roots = allRoots();
  const configured = load().defaultRoot;
  if (configured) {
    const real = realDir(configured);
    if (real && roots.some((root) => isWithin(root, real))) return real;
  }
  const envDefault = config.defaultWorkspace ? realDir(config.defaultWorkspace) : null;
  if (envDefault && roots.some((root) => isWithin(root, envDefault))) return envDefault;
  return roots[0] ?? os.homedir();
}

export interface WorkspaceConfigView {
  defaultRoot: string;
  allowedRoots: string[];
  envRoots: string[];
  extraRoots: string[];
}

export function workspaceConfig(): WorkspaceConfigView {
  return {
    defaultRoot: defaultRoot(),
    allowedRoots: allRoots(),
    envRoots: envRoots(),
    extraRoots: extraRoots(),
  };
}

export function updateWorkspaces(input: {
  defaultRoot?: unknown;
  extraRoots?: unknown;
}): WorkspaceConfigView {
  const next: WorkspaceFile = {
    version: 1,
    defaultRoot: load().defaultRoot,
    extraRoots: [...(load().extraRoots ?? [])],
  };

  if (Array.isArray(input.extraRoots)) {
    const roots: string[] = [];
    for (const item of input.extraRoots) {
      if (typeof item !== 'string' || !item.trim()) continue;
      const real = realDir(item.trim());
      if (!real) throw new HttpError(400, `目录不存在：${item}`);
      if (real === path.parse(real).root) {
        throw new HttpError(400, '不能把文件系统根目录加入工作区');
      }
      if (!roots.includes(real)) roots.push(real);
    }
    next.extraRoots = roots;
  }

  if (typeof input.defaultRoot === 'string' && input.defaultRoot.trim()) {
    const real = realDir(input.defaultRoot.trim());
    if (!real) throw new HttpError(400, '默认工作区目录不存在');
    next.defaultRoot = real;
  }

  const roots = [...new Set([...envRoots(), ...(next.extraRoots ?? [])])];
  if (next.defaultRoot && !roots.some((root) => isWithin(root, next.defaultRoot as string))) {
    throw new HttpError(400, '默认工作区必须在允许的目录范围内');
  }
  if (!next.defaultRoot && roots.length > 0) next.defaultRoot = roots[0];

  save(next);
  return workspaceConfig();
}
