import { AttachmentStore } from './attachments.js';
import { config } from './config.js';
import {
  findClaudeSession,
  listClaudeSessions,
  listRecentProjects,
  readClaudeTranscript,
  type ProjectSummary,
} from './claudeHistory.js';
import { convertClaudeTranscript, summarizeForTitle } from './importHistory.js';
import { allRoots } from './workspaces.js';
import { ClaudeRuntime } from './runtime.js';
import { SessionIndex } from './sessionIndex.js';
import { TranscriptStore } from './transcript.js';
import type {
  PermissionDecision,
  PermissionMode,
  RuntimeStatus,
  SessionMeta,
  SessionRuntimeState,
  SessionSummary,
  UiEvent,
} from './types.js';
import { HttpError, nowIso, randomId } from './util.js';

const MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
];

export class SessionManager {
  private runtimes = new Map<string, ClaudeRuntime>();
  private creating = new Map<string, Promise<ClaudeRuntime>>();
  private stateSubscribers = new Map<string, Set<() => void>>();

  constructor(
    readonly index: SessionIndex,
    readonly transcript: TranscriptStore,
    readonly attachments: AttachmentStore,
  ) {}

  hasLive(id: string): boolean {
    return this.runtimes.get(id)?.isAlive() ?? false;
  }

  runtime(id: string): ClaudeRuntime | undefined {
    const runtime = this.runtimes.get(id);
    return runtime?.isAlive() ? runtime : undefined;
  }

  normalizeMode(input?: string): PermissionMode {
    if (input && (MODES as string[]).includes(input)) return input as PermissionMode;
    if (input) throw new HttpError(400, `不支持的权限模式：${input}`);
    return config.defaultPermissionMode as PermissionMode;
  }

  async ensureTranscript(id: string): Promise<SessionMeta> {
    let meta = this.index.get(id);
    if (!meta) {
      const claude = await findClaudeSession(id);
      if (!claude) throw new HttpError(404, '会话不存在');
      meta = {
        id,
        claudeSessionId: id,
        cwd: claude.cwd || '/',
        title: claude.title,
        model: claude.model,
        permissionMode: 'default',
        createdAt: claude.createdAt || claude.updatedAt,
        updatedAt: claude.updatedAt,
        status: 'stopped',
      };
      meta = this.index.upsert(meta);
    }

    if (!this.transcript.exists(id) && meta.claudeSessionId) {
      try {
        const lines = await readClaudeTranscript(meta.claudeSessionId);
        const events = convertClaudeTranscript(lines);
        if (events.length > 0) {
          this.transcript.appendMany(id, events);
          if (!meta.title) {
            const title = summarizeForTitle(events);
            if (title) meta = this.index.update(id, { title }) ?? meta;
          }
        }
      } catch {
        // A failed import leaves a usable empty transcript; the session can still be resumed.
      }
    }
    return meta;
  }

  async ensureRuntime(id: string): Promise<ClaudeRuntime> {
    const existing = this.runtimes.get(id);
    if (existing?.isAlive()) return existing;
    if (existing) this.runtimes.delete(id);
    const inflight = this.creating.get(id);
    if (inflight) return inflight;

    const promise = this.createRuntime(id).finally(() => this.creating.delete(id));
    this.creating.set(id, promise);
    return promise;
  }

  private async createRuntime(id: string): Promise<ClaudeRuntime> {
    const meta = await this.ensureTranscript(id);
    const runtime = new ClaudeRuntime({
      wid: id,
      cwd: meta.cwd,
      claudeSessionId: meta.claudeSessionId,
      permissionMode: meta.permissionMode,
      model: meta.model,
      title: meta.title,
      transcript: this.transcript,
      onMeta: (patch) => {
        this.index.update(id, patch);
      },
    });
    this.runtimes.set(id, runtime);
    runtime.subscribeState(() => this.emitState(id));
    runtime.start();
    this.emitState(id);
    return runtime;
  }

  createSession(input: {
    cwd: string;
    permissionMode?: string;
    model?: string;
    title?: string;
  }): SessionMeta {
    const meta: SessionMeta = {
      id: randomId(),
      cwd: input.cwd,
      title: input.title?.trim() || undefined,
      permissionMode: this.normalizeMode(input.permissionMode),
      model: input.model?.trim() || undefined,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'new',
    };
    return this.index.upsert(meta);
  }

  async resumeSession(id: string): Promise<SessionMeta> {
    const meta = await this.ensureTranscript(id);
    await this.ensureRuntime(id);
    return meta;
  }

  async send(id: string, text: string, attachmentIds: string[] = []): Promise<void> {
    // Resolve first: invalid or oversized attachments should fail before a CLI
    // process is spawned.
    const resolved = this.attachments.resolve(id, attachmentIds);
    const runtime = await this.ensureRuntime(id);
    runtime.sendUserMessage(text, resolved);
  }

  async interrupt(id: string): Promise<boolean> {
    const runtime = this.runtime(id);
    if (!runtime) return false;
    await runtime.interrupt();
    return true;
  }

  async respondPermission(
    id: string,
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: Record<string, unknown>,
  ): Promise<boolean> {
    const runtime = this.runtime(id);
    if (!runtime) return false;
    return runtime.respondPermission(requestId, decision, updatedInput);
  }

  async setMode(id: string, mode: string): Promise<void> {
    const runtime = await this.ensureRuntime(id);
    await runtime.setPermissionMode(this.normalizeMode(mode));
  }

  async setModel(id: string, model: string | undefined): Promise<void> {
    const runtime = await this.ensureRuntime(id);
    await runtime.setModel(model?.trim() || undefined);
  }

  async stop(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (runtime) {
      await runtime.stop();
      this.runtimes.delete(id);
    } else {
      this.index.update(id, { status: 'stopped' });
    }
    this.emitState(id);
  }

  events(id: string, after = 0, limit = config.maxEventsPerFetch): UiEvent[] {
    return this.transcript.read(id, after, limit);
  }

  eventsWindow(
    id: string,
    options: { after?: number; before?: number; limit?: number; tail?: boolean },
  ): UiEvent[] {
    return this.transcript.readWindow(id, options);
  }

  lastSeq(id: string): number {
    return this.transcript.last(id);
  }

  state(id: string): SessionRuntimeState {
    const runtime = this.runtime(id);
    const meta = this.index.get(id);
    if (runtime) {
      const state = runtime.getState();
      return {
        ...state,
        createdAt: meta?.createdAt,
        updatedAt: meta?.updatedAt,
        costUsd: state.costUsd ?? meta?.costUsd,
      };
    }
    if (!meta) throw new HttpError(404, '会话不存在');
    const status: RuntimeStatus =
      meta.status === 'new'
        ? 'idle'
        : meta.status === 'running' || meta.status === 'waiting_permission'
          ? 'stopped'
          : meta.status;
    return {
      id: meta.id,
      claudeSessionId: meta.claudeSessionId,
      cwd: meta.cwd,
      title: meta.title,
      model: meta.model,
      permissionMode: meta.permissionMode,
      status,
      statusDetail: meta.lastError,
      live: false,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      costUsd: meta.costUsd,
      tasks: [],
      pendingPermissions: [],
      slashCommands: [],
      skills: [],
      tools: [],
    };
  }

  subscribeState(id: string, fn: () => void): () => void {
    let set = this.stateSubscribers.get(id);
    if (!set) {
      set = new Set();
      this.stateSubscribers.set(id, set);
    }
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }

  private emitState(id: string): void {
    const set = this.stateSubscribers.get(id);
    if (!set) return;
    for (const fn of set) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  }

  async listSummaries(limit = 200): Promise<SessionSummary[]> {
    const roots = allRoots();
    const inRoots = (cwd: string): boolean =>
      !!cwd && roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
    const claudeSessions = await listClaudeSessions(3000);
    const indexed = this.index.list();
    const usedIds = new Set<string>();
    const usedClaudeIds = new Set<string>();
    const out: SessionSummary[] = [];

    for (const meta of indexed) {
      usedIds.add(meta.id);
      if (meta.claudeSessionId) usedClaudeIds.add(meta.claudeSessionId);
      if (!inRoots(meta.cwd)) continue;
      const runtime = this.runtime(meta.id);
      out.push({
        id: meta.id,
        claudeSessionId: meta.claudeSessionId,
        cwd: meta.cwd,
        title: meta.title || '新会话',
        createdAt: meta.createdAt,
        updatedAt: runtime ? new Date(runtime.lastActivityAt).toISOString() : meta.updatedAt,
        status: runtime?.status ?? (meta.status === 'new' ? 'idle' : meta.status),
        live: this.hasLive(meta.id),
        source: 'web',
        costUsd: meta.costUsd,
      });
    }

    for (const session of claudeSessions) {
      if (usedIds.has(session.id) || usedClaudeIds.has(session.id)) continue;
      if (!inRoots(session.cwd)) continue;
      out.push({
        id: session.id,
        claudeSessionId: session.id,
        cwd: session.cwd,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        status: 'stopped',
        live: false,
        source: 'claude',
      });
    }

    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out.slice(0, limit);
  }

  async projects(): Promise<ProjectSummary[]> {
    const roots = allRoots();
    const inRoots = (cwd: string): boolean =>
      !!cwd && roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
    const fromClaude = (await listRecentProjects(100)).filter((project) => inRoots(project.cwd));
    const byCwd = new Map<string, ProjectSummary>(
      fromClaude.map((project) => [project.cwd, project] as [string, ProjectSummary]),
    );
    for (const meta of this.index.list()) {
      if (!inRoots(meta.cwd)) continue;
      const existing = byCwd.get(meta.cwd);
      if (existing) {
        existing.sessions += 1;
        if (meta.updatedAt > existing.lastUpdated) existing.lastUpdated = meta.updatedAt;
      } else {
        byCwd.set(meta.cwd, { cwd: meta.cwd, sessions: 1, lastUpdated: meta.updatedAt });
      }
    }
    return [...byCwd.values()]
      .sort((a, b) => (a.lastUpdated < b.lastUpdated ? 1 : -1))
      .slice(0, 100);
  }

  async shutdown(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop('服务关闭')));
    this.runtimes.clear();
  }
}
