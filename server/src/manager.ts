import { AttachmentStore, type ResolvedAttachment } from './attachments.js';
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
import { validateCwd } from './paths.js';
import { ClaudeRuntime } from './runtime.js';
import { SessionIndex } from './sessionIndex.js';
import { ToolImageStore } from './toolImages.js';
import {
  startSideQuestion,
  type SideQuestionCallbacks,
  type SideQuestionHandle,
} from './sideQuestion.js';
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

const SIDE_CONTEXT_MAX_CHARS = 24_000;

function clipContext(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  const clean = text.replace(/\r\n/g, '\n').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function toolInputText(input: unknown): string {
  try {
    return clipContext(JSON.stringify(input), 700);
  } catch {
    return '[无法序列化]';
  }
}

function sideContextLine(event: UiEvent): string | null {
  if (event.type === 'user.message') {
    const attachments = event.attachments?.map((item) => item.name).join('、');
    const text = clipContext(event.text, 2_200);
    return `用户：${text}${attachments ? `（附件：${attachments}）` : ''}`;
  }
  if (event.type === 'assistant.message') {
    const parts: string[] = [];
    for (const block of event.blocks) {
      if (block.type === 'text' && block.text?.trim()) {
        parts.push(clipContext(block.text, 2_500));
      } else if (block.type === 'tool_use' && block.name) {
        parts.push(`[调用工具 ${block.name} ${toolInputText(block.input)}]`);
      }
    }
    return parts.length > 0 ? `Claude：${parts.join('\n')}` : null;
  }
  if (event.type === 'tool.result') {
    return `工具结果${event.isError ? '（错误）' : ''}：${clipContext(event.content, 900)}`;
  }
  return null;
}

function buildSideContext(events: UiEvent[], state?: SessionRuntimeState): string {
  const picked: string[] = [];
  let total = 0;
  const active = state?.activeTools ?? [];
  if (active.length > 0) {
    const line = `当前执行状态：${active.map((tool) => tool.name).join('、')}（任务仍在运行）`;
    picked.push(line);
    total += line.length + 1;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const line = sideContextLine(events[i]);
    if (!line) continue;
    if (total + line.length + 1 > SIDE_CONTEXT_MAX_CHARS) break;
    picked.unshift(line);
    total += line.length + 1;
  }
  return picked.join('\n');
}

export class SessionManager {
  private runtimes = new Map<string, ClaudeRuntime>();
  private creating = new Map<string, Promise<ClaudeRuntime>>();
  private stateSubscribers = new Map<string, Set<() => void>>();
  private sideTasks = new Map<string, Set<SideQuestionHandle>>();

  constructor(
    readonly index: SessionIndex,
    readonly transcript: TranscriptStore,
    readonly attachments: AttachmentStore,
    readonly toolImages: ToolImageStore,
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
      // Imported Claude sessions must obey the same workspace allowlist as
      // sessions created by the Web UI. Without this check a known session id
      // could start a runtime in an arbitrary directory outside ALLOWED_ROOTS.
      const cwd = validateCwd(claude.cwd || '/');
      meta = {
        id,
        claudeSessionId: id,
        cwd,
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
        // Historical tool-result images are stored the same way as live ones,
        // so imported sessions also get clickable previews after replay.
        const events = convertClaudeTranscript(lines, (content) =>
          this.toolImages.saveFromContent(id, content),
        );
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
    // Existing index entries may predate a tightened ALLOWED_ROOTS; never
    // launch a runtime outside the current allowlist.
    const cwd = validateCwd(meta.cwd);
    const runtime = new ClaudeRuntime({
      wid: id,
      cwd,
      claudeSessionId: meta.claudeSessionId,
      permissionMode: meta.permissionMode,
      model: meta.model,
      title: meta.title,
      transcript: this.transcript,
      toolImages: this.toolImages,
      onMeta: (patch) => {
        this.index.update(id, patch);
      },
    });
    this.runtimes.set(id, runtime);
    runtime.subscribeState(() => this.emitState(id));
    runtime.start();
    this.recoverShutdownMessages(id, runtime);
    this.emitState(id);
    return runtime;
  }

  /**
   * A message appended during a running turn may still be sitting in the CLI
   * queue when the service is stopped. The shutdown path marks it failed with
   * the reason "服务关闭"; without recovery it would be lost and the browser
   * would keep showing "未送达：服务关闭". On the next runtime start, re-send
   * those messages with their original event id (so the bubble updates in
   * place) and let the normal uuid delivery acknowledgement clear the chip.
   *
   * Only messages explicitly marked queued are recovered, and only when the
   * last state is a shutdown failure. A user-requested stop or an ordinary
   * process exit is not retried automatically.
   */
  private recoverShutdownMessages(id: string, runtime: ClaudeRuntime): void {
    if (!runtime.isAlive()) return;
    const events = this.transcript.readWindow(id, { tail: true, limit: 4000, compact: true });
    interface Pending {
      text: string;
      attachmentIds: string[];
      queued: boolean;
      failedReason?: string;
      delivered: boolean;
    }
    const pending = new Map<string, Pending>();
    for (const event of events) {
      if (event.type === 'user.message') {
        pending.set(event.id, {
          text: event.text,
          attachmentIds: (event.attachments ?? []).map((attachment) => attachment.id),
          queued: event.queued === true,
          delivered: false,
        });
        continue;
      }
      if (event.type === 'user.message.retrying') {
        const item = pending.get(event.id);
        if (item) {
          item.failedReason = undefined;
          item.delivered = false;
        }
        continue;
      }
      if (event.type === 'user.message.delivered') {
        const item = pending.get(event.id);
        if (item) {
          item.failedReason = undefined;
          item.delivered = true;
        }
        continue;
      }
      if (event.type === 'user.message.failed') {
        const item = pending.get(event.id);
        if (item) {
          item.failedReason = event.reason;
          item.delivered = false;
        }
      }
    }

    for (const [eventId, item] of pending) {
      if (!item.queued || item.delivered || item.failedReason !== '服务关闭') continue;
      let resolved: ResolvedAttachment[] = [];
      if (item.attachmentIds.length > 0) {
        try {
          resolved = this.attachments.resolve(id, item.attachmentIds);
        } catch {
          // The text is still worth recovering if an attachment disappeared.
        }
      }
      if (!item.text.trim() && resolved.length === 0) continue;
      try {
        runtime.sendUserMessage(item.text, resolved, { id: eventId, recovered: true });
      } catch {
        // A stopped runtime or a transient enqueue failure leaves the failed
        // marker in place; do not take the whole session down at startup.
      }
    }
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

  /**
   * Ask a side question about the current conversation without running it
   * through the main runtime: a tool-less, non-persisted query over a compact
   * transcript excerpt (never a resume/fork of the full session).
   */
  async sideQuestion(
    id: string,
    question: string,
    callbacks: SideQuestionCallbacks,
  ): Promise<SideQuestionHandle> {
    const clean = question.trim();
    if (!clean) throw new HttpError(400, '旁问内容不能为空');
    if (clean.length > 4000) throw new HttpError(400, '旁问不能超过 4000 字');

    const meta = await this.ensureTranscript(id);
    const runtime = this.runtime(id);
    const active = this.sideTasks.get(id) ?? new Set<SideQuestionHandle>();
    if (active.size >= 2) {
      throw new HttpError(429, '旁问正在回答，请等当前问题结束');
    }

    let settled = false;
    let handle: SideQuestionHandle;
    const cleanup = (): void => {
      active.delete(handle);
      if (active.size === 0) this.sideTasks.delete(id);
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const contextEvents = this.transcript.readWindow(id, {
      tail: true,
      limit: 160,
      compact: true,
    });
    const context = buildSideContext(contextEvents, runtime?.getState());

    const raw = startSideQuestion(
      {
        cwd: runtime?.cwd ?? meta.cwd,
        model: runtime?.model ?? meta.model,
        context,
      },
      clean,
      {
        onDelta: callbacks.onDelta,
        onDone: (result) => finish(() => callbacks.onDone(result)),
        onError: (message) => finish(() => callbacks.onError(message)),
      },
    );
    handle = {
      cancel: () => {
        raw.cancel();
        finish(() => callbacks.onError('旁问已取消'));
      },
    };
    active.add(handle);
    this.sideTasks.set(id, active);
    return handle;
  }

  private cancelSideQuestions(id: string): void {
    const active = this.sideTasks.get(id);
    if (!active) return;
    for (const handle of [...active]) handle.cancel();
    this.sideTasks.delete(id);
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

  async respondQuestion(
    id: string,
    requestId: string,
    answers?: Record<string, unknown>,
    skipped = false,
  ): Promise<boolean> {
    const runtime = this.runtime(id);
    if (!runtime) return false;
    return runtime.respondQuestion(requestId, answers, skipped);
  }

  async respondPlan(
    id: string,
    requestId: string,
    approved: boolean,
    feedback?: string,
  ): Promise<boolean> {
    const runtime = this.runtime(id);
    if (!runtime) return false;
    return runtime.respondPlan(requestId, approved, feedback);
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
    this.cancelSideQuestions(id);
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
    options: {
      after?: number;
      before?: number;
      limit?: number;
      tail?: boolean;
      compact?: boolean;
    },
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
      pendingQuestions: [],
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
    for (const id of [...this.sideTasks.keys()]) this.cancelSideQuestions(id);
    const runtimes = [...this.runtimes.values()];
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop('服务关闭')));
    this.runtimes.clear();
  }
}
