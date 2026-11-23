import path from 'node:path';
import type { SessionMeta } from './types.js';
import { atomicWriteJson, nowIso, readJson } from './util.js';

interface IndexFile {
  version: 1;
  sessions: Record<string, SessionMeta>;
}

export class SessionIndex {
  private sessions = new Map<string, SessionMeta>();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'sessions.json');
    const parsed = readJson<IndexFile | null>(this.file, null);
    if (parsed?.sessions) {
      for (const [id, meta] of Object.entries(parsed.sessions)) {
        if (!meta || typeof meta !== 'object') continue;
        const normalized: SessionMeta = {
          ...meta,
          id,
          cwd: meta.cwd || '/',
          permissionMode: meta.permissionMode || 'default',
          createdAt: meta.createdAt || nowIso(),
          updatedAt: meta.updatedAt || nowIso(),
          status:
            meta.status === 'running' || meta.status === 'waiting_permission' ? 'stopped' : meta.status,
          lastError:
            meta.status === 'running' || meta.status === 'waiting_permission'
              ? '服务重启，后台任务已中断；发送新消息可继续该会话。'
              : meta.lastError,
        };
        this.sessions.set(id, normalized);
      }
      this.save();
    }
  }

  get(id: string): SessionMeta | undefined {
    return this.sessions.get(id);
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()];
  }

  upsert(meta: SessionMeta): SessionMeta {
    const next = { ...meta, updatedAt: meta.updatedAt || nowIso() };
    this.sessions.set(next.id, next);
    this.save();
    return next;
  }

  update(id: string, patch: Partial<SessionMeta>): SessionMeta | undefined {
    const existing = this.sessions.get(id);
    if (!existing) return undefined;
    const next: SessionMeta = {
      ...existing,
      ...patch,
      id,
      updatedAt: patch.updatedAt || nowIso(),
    };
    this.sessions.set(id, next);
    this.save();
    return next;
  }

  remove(id: string): void {
    if (!this.sessions.delete(id)) return;
    this.save();
  }

  private save(): void {
    const data: IndexFile = {
      version: 1,
      sessions: Object.fromEntries(this.sessions),
    };
    atomicWriteJson(this.file, data);
  }
}
