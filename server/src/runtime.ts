import {
  query,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode as SdkPermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ResolvedAttachment } from './attachments.js';
import { config, childEnv } from './config.js';
import type { ToolImageStore } from './toolImages.js';
import { TranscriptStore } from './transcript.js';
import type {
  AgentInfoView,
  AttachmentRef,
  ContentBlock,
  ContextUsage,
  ExtensionsView,
  McpServerView,
  McpToolView,
  PermissionMode,
  PendingPermissionView,
  PendingPlanView,
  PendingQuestionView,
  QuestionItem,
  QuestionOption,
  RuntimeStatus,
  SessionMeta,
  SessionRuntimeState,
  TaskView,
  ToolImageRef,
  UiEvent,
  UiEventInput,
} from './types.js';
import { errorMessage, nowIso, parseJsonObject, randomId, truncate } from './util.js';

interface RuntimeOptions {
  wid: string;
  cwd: string;
  claudeSessionId?: string;
  permissionMode: PermissionMode;
  model?: string;
  title?: string;
  transcript: TranscriptStore;
  /** Session-scoped storage for base64 image blocks returned by tools. */
  toolImages: ToolImageStore;
  onMeta: (patch: Partial<SessionMeta>) => void;
}

interface PendingPermission {
  view: PendingPermissionView;
  suggestions?: unknown[];
  input: Record<string, unknown>;
  toolUseId?: string;
  resolve: (result: PermissionResult) => void;
  timer: NodeJS.Timeout;
}

interface PendingQuestion {
  view: PendingQuestionView;
  input: Record<string, unknown>;
  toolUseId?: string;
  resolve: (result: PermissionResult) => void;
  timer: NodeJS.Timeout;
}

interface PendingPlan {
  view: PendingPlanView;
  input: Record<string, unknown>;
  toolUseId?: string;
  resolve: (result: PermissionResult) => void;
  timer: NodeJS.Timeout;
}

interface MessageAccumulator {
  parentKey: string;
  messageId: string;
  model?: string;
  usage?: unknown;
  blocks: Map<number, ContentBlock>;
  order: number[];
  toolIdToIndex: Map<string, number>;
}

function parentKeyOf(parentToolUseId: unknown): string {
  return typeof parentToolUseId === 'string' && parentToolUseId ? parentToolUseId : 'main';
}

function questionOptions(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) return [];
  const options: QuestionOption[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.label !== 'string' || !row.label.trim()) continue;
    const option: QuestionOption = {
      label: row.label.trim().slice(0, 120),
      description: typeof row.description === 'string' ? row.description.slice(0, 2000) : '',
    };
    if (typeof row.preview === 'string' && row.preview.trim()) {
      option.preview = row.preview.slice(0, 8000);
    }
    options.push(option);
    if (options.length >= 4) break;
  }
  return options;
}

/** Normalize the AskUserQuestion input; the CLI guarantees the shape, but a host must not trust it. */
function parseQuestions(value: unknown): QuestionItem[] {
  if (!Array.isArray(value)) return [];
  const questions: QuestionItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.question !== 'string' || !row.question.trim()) continue;
    const options = questionOptions(row.options);
    if (options.length < 2) continue;
    questions.push({
      question: row.question.trim().slice(0, 4000),
      header:
        typeof row.header === 'string' && row.header.trim()
          ? row.header.trim().slice(0, 48)
          : '问题',
      options,
      multiSelect: row.multiSelect === true,
    });
    if (questions.length >= 4) break;
  }
  return questions;
}

function questionAnswers(
  questions: QuestionItem[],
  answers: Record<string, unknown> | undefined,
  skipped: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of questions) {
    const raw = answers?.[item.question];
    const value = typeof raw === 'string' ? raw.trim().slice(0, 4000) : '';
    out[item.question] = value || (skipped ? '用户跳过了这个问题，请按你的最佳判断继续。' : '');
  }
  return out;
}

function normalizeBlock(value: unknown): ContentBlock | null {
  if (!value || typeof value !== 'object') return null;
  const block = value as Record<string, unknown>;
  if (typeof block.type !== 'string') return null;
  const out: ContentBlock = { type: block.type };
  if (block.type === 'text') out.text = typeof block.text === 'string' ? block.text : '';
  if (block.type === 'thinking') {
    out.thinking = typeof block.thinking === 'string' ? block.thinking : '';
    if (typeof block.signature === 'string') out.signature = block.signature;
  }
  if (block.type === 'tool_use') {
    if (typeof block.id === 'string') out.id = block.id;
    if (typeof block.name === 'string') out.name = block.name;
    out.input = parseJsonObject(block.input);
  }
  if (block.type === 'redacted_thinking') out.data = block.data;
  return out;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (content === undefined || content === null) return '';
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[图片]');
    else parts.push(`[${String(block.type ?? 'content')}]`);
  }
  return parts.join('\n');
}

function attachmentNote(attachment: ResolvedAttachment): string {
  const { ref, text } = attachment;
  if (text !== undefined) {
    const name = ref.name
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
    return [
      `<attachment name="${name}" type="${ref.mimeType}" bytes="${ref.size}">`,
      text,
      '</attachment>',
      `（原文件：${attachment.path}）`,
    ].join('\n');
  }
  return `- ${ref.name}（${ref.mimeType}，${ref.size} 字节）：${attachment.path}`;
}

/**
 * Turn a user message into Anthropic content blocks. Images go as image
 * blocks (the model sees them directly); small text files are inlined; other
 * files are listed by absolute path so Claude can Read them on demand.
 */
export function buildUserContent(
  text: string,
  attachments: ResolvedAttachment[],
): SDKUserMessage['message']['content'] {
  const blocks: Array<Record<string, unknown>> = [];
  const notes = attachments
    .filter((attachment) => attachment.ref.kind !== 'image' || !attachment.base64)
    .map(attachmentNote);

  const body = [text, notes.length > 0 ? `附件：\n${notes.join('\n\n')}` : '']
    .filter((part) => part.trim())
    .join('\n\n');
  if (body.trim()) blocks.push({ type: 'text', text: body });

  for (const attachment of attachments) {
    if (attachment.ref.kind !== 'image' || !attachment.base64) continue;
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.ref.mimeType,
        data: attachment.base64,
      },
    });
  }

  return blocks as unknown as SDKUserMessage['message']['content'];
}

function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

const MCP_STATUSES = new Set(['connected', 'failed', 'needs-auth', 'pending', 'disabled']);

/** Never expose MCP config/env/headers; only safe status metadata. */
function mapMcpStatus(value: unknown): McpServerView | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const name = safeText(raw.name, 200);
  if (!name) return null;
  const rawStatus = safeText(raw.status, 40) ?? '';
  const status = (MCP_STATUSES.has(rawStatus) ? rawStatus : 'pending') as McpServerView['status'];
  const info = raw.serverInfo && typeof raw.serverInfo === 'object'
    ? (raw.serverInfo as Record<string, unknown>)
    : undefined;
  const tools: McpToolView[] = [];
  if (Array.isArray(raw.tools)) {
    for (const item of raw.tools.slice(0, 200)) {
      if (!item || typeof item !== 'object') continue;
      const tool = item as Record<string, unknown>;
      const toolName = safeText(tool.name, 200);
      if (!toolName) continue;
      const annotations = tool.annotations && typeof tool.annotations === 'object'
        ? (tool.annotations as Record<string, unknown>)
        : undefined;
      tools.push({
        name: toolName,
        ...(safeText(tool.description, 300) ? { description: safeText(tool.description, 300) } : {}),
        ...(annotations?.readOnly === true ? { readOnly: true } : {}),
        ...(annotations?.destructive === true ? { destructive: true } : {}),
      });
    }
  }
  return {
    name,
    status,
    ...(safeText(raw.scope, 80) ? { scope: safeText(raw.scope, 80) } : {}),
    ...(safeText(raw.source, 80) ? { source: safeText(raw.source, 80) } : {}),
    ...(safeText(info?.name, 120) ? { serverName: safeText(info?.name, 120) } : {}),
    ...(safeText(info?.version, 80) ? { serverVersion: safeText(info?.version, 80) } : {}),
    ...(safeText(raw.error, 500) ? { error: safeText(raw.error, 500) } : {}),
    tools,
  };
}

function mapAgentInfo(value: unknown): AgentInfoView | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const name = safeText(raw.name, 120);
  if (!name) return null;
  return {
    name,
    description: safeText(raw.description, 500) ?? '',
    ...(safeText(raw.model, 120) ? { model: safeText(raw.model, 120) } : {}),
  };
}

export class ClaudeRuntime {
  readonly wid: string;
  readonly cwd: string;
  claudeSessionId?: string;
  permissionMode: PermissionMode;
  model?: string;
  title?: string;
  status: RuntimeStatus = 'idle';
  /**
   * Claude Code refuses --dangerously-skip-permissions for root. We emulate
   * "allow everything" by running the CLI in default mode and auto-allowing
   * every canUseTool request, which also works when the service is non-root.
   */
  private autoAllowAll = false;
  statusDetail?: string;
  costUsd?: number;
  turnStartedAt?: number;
  contextUsage?: ContextUsage;
  claudeVersion?: string;
  slashCommandCount = 0;
  skillCount = 0;
  slashCommands: string[] = [];
  commandDetails: { name: string; description?: string }[] = [];
  skills: string[] = [];
  tools: string[] = [];
  lastActivityAt = Date.now();

  private q?: Query;
  private abortController = new AbortController();
  private stopped = false;
  private inputClosed = false;
  private inputQueue: SDKUserMessage[] = [];
  /** Event ids aligned with inputQueue, so the UI can clear its queued chip. */
  private pendingInputIds: string[] = [];
  private inputWaiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private accumulators = new Map<string, MessageAccumulator>();
  private activeMessage = new Map<string, string>();
  private pending = new Map<string, PendingPermission>();
  private pendingQuestions = new Map<string, PendingQuestion>();
  private pendingPlan?: PendingPlan;
  /** Latest main-thread assistant text; ExitPlanMode carries no plan in its input. */
  private lastAssistantText = '';
  private tasks = new Map<string, TaskView>();
  private currentTool?: { name: string; toolUseId?: string; startedAt: number; elapsedSeconds?: number };
  private activeTools = new Map<
    string,
    { name: string; startedAt: number; elapsedSeconds?: number }
  >();
  private eventSubscribers = new Set<(event: UiEvent) => void>();
  private stateSubscribers = new Set<() => void>();
  private idleTimer?: NodeJS.Timeout;
  private notifyTimer?: NodeJS.Timeout;
  private lastNotify = 0;
  private consumePromise?: Promise<void>;

  constructor(
    private readonly options2: RuntimeOptions,
  ) {
    this.wid = options2.wid;
    this.cwd = options2.cwd;
    this.claudeSessionId = options2.claudeSessionId;
    this.permissionMode = options2.permissionMode;
    this.autoAllowAll = options2.permissionMode === 'bypassPermissions';
    this.model = options2.model;
    this.title = options2.title;
  }

  isAlive(): boolean {
    return !this.stopped && !!this.q;
  }

  start(): void {
    if (this.q) return;
    try {
      this.q = query({
        prompt: this.inputStream(),
        options: {
          cwd: this.cwd,
          resume: this.claudeSessionId,
          includePartialMessages: true,
          settingSources: ['user', 'project', 'local'],
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          permissionMode: (this.autoAllowAll
            ? 'default'
            : this.permissionMode) as SdkPermissionMode,
          canUseTool: (toolName, input, opts) =>
            this.canUseTool(toolName, input, opts as unknown as PermissionOptions),
          abortController: this.abortController,
          env: childEnv(),
          ...(this.model ? { model: this.model } : {}),
          ...(config.claudeBin ? { pathToClaudeCodeExecutable: config.claudeBin } : {}),
        },
      });
    } catch (error) {
      this.setStatus('error', errorMessage(error));
      this.emit({ type: 'notice', level: 'error', text: `启动 Claude Code 失败：${errorMessage(error)}` });
      return;
    }
    void this.q
      .initializationResult()
      .then((result) => {
        const commands = Array.isArray(result?.commands)
          ? (result.commands as Array<{ name?: unknown; description?: unknown }>)
          : [];
        const details = commands
          .filter((command) => typeof command.name === 'string')
          .map((command) => ({
            name: String(command.name),
            description:
              typeof command.description === 'string' ? command.description : undefined,
          }));
        if (details.length > 0) {
          this.commandDetails = details;
          this.slashCommands = details.map((command) => command.name);
          this.slashCommandCount = details.length;
          this.notifyState(true);
        }
      })
      .catch(() => {
        // capabilities are best-effort before the first turn
      });
    this.consumePromise = this.consume();
    this.notifyState();
  }

  private async consume(): Promise<void> {
    if (!this.q) return;
    try {
      for await (const message of this.q) {
        this.handleMessage(message as unknown as Record<string, unknown>);
      }
      if (!this.stopped) {
        this.failPendingInputs('Claude Code 进程已结束');
        this.setStatus('stopped', 'Claude Code 进程已结束');
        this.emit({ type: 'session.status', status: 'stopped', detail: 'Claude Code 进程已结束' });
      }
    } catch (error) {
      if (this.stopped) return;
      const detail = errorMessage(error);
      this.failPendingInputs(detail);
      this.setStatus('error', detail);
      this.emit({ type: 'notice', level: 'error', text: `会话异常：${detail}` });
      this.options2.onMeta({ lastError: detail });
    }
  }

  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    while (!this.inputClosed) {
      const next = await this.nextInput();
      if (next.done) return;
      yield next.value;
    }
  }

  private nextInput(): Promise<IteratorResult<SDKUserMessage>> {
    const queued = this.inputQueue.shift();
    if (queued) return Promise.resolve({ value: queued, done: false });
    if (this.inputClosed) {
      return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
    }
    return new Promise((resolve) => this.inputWaiters.push(resolve));
  }

  private enqueue(message: SDKUserMessage, eventId?: string): void {
    if (this.inputClosed) return;
    // The SDK writes stream input to the CLI eagerly, so "handed to the SDK"
    // is not the same as "the CLI consumed it". Keep the event id until a
    // frame echoes the message uuid (or, on older CLIs, a turn result).
    if (eventId) this.pendingInputIds.push(eventId);
    const waiter = this.inputWaiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.inputQueue.push(message);
  }

  private markInputDelivered(): void {
    const id = this.pendingInputIds.shift();
    if (id) this.emit({ type: 'user.message.delivered', id });
  }

  /**
   * The CLI stamps assistant/stream/result frames with the client uuid of the
   * user message(s) it has consumed. This is the earliest reliable delivery
   * signal: a message sent during a running turn can be folded in between
   * tool rounds, well before the turn's final result. Marking it here makes
   * the "added to this conversation" chip clear at that point instead of
   * waiting for the next turn boundary.
   */
  private markConsumedInputs(raw: Record<string, unknown>): void {
    const listed = raw.user_message_uuids;
    if (Array.isArray(listed)) {
      const ids = listed.filter((value): value is string => typeof value === 'string');
      if (ids.length > 0) {
        this.markInputIdsDelivered(ids);
        return;
      }
    }
    const single = raw.user_message_uuid;
    if (typeof single === 'string') this.markInputIdsDelivered([single]);
  }

  private markInputIdsDelivered(ids: string[]): void {
    for (const id of ids) {
      const index = this.pendingInputIds.indexOf(id);
      if (index < 0) continue;
      this.pendingInputIds.splice(index, 1);
      this.emit({ type: 'user.message.delivered', id });
    }
  }

  private failPendingInputs(reason: string): void {
    const ids = this.pendingInputIds.splice(0);
    this.inputQueue.length = 0;
    for (const id of ids) {
      this.emit({ type: 'user.message.failed', id, reason });
    }
  }

  subscribeEvents(fn: (event: UiEvent) => void): () => void {
    this.eventSubscribers.add(fn);
    return () => this.eventSubscribers.delete(fn);
  }

  subscribeState(fn: () => void): () => void {
    this.stateSubscribers.add(fn);
    return () => this.stateSubscribers.delete(fn);
  }

  private emit(event: UiEventInput): UiEvent {
    const stored = this.options2.transcript.append(this.wid, event);
    this.lastActivityAt = stored.ts;
    for (const fn of this.eventSubscribers) {
      try {
        fn(stored);
      } catch {
        // a broken socket must not break the run
      }
    }
    return stored;
  }

  notifyState(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastNotify < 800) {
      if (this.notifyTimer) return;
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = undefined;
        this.notifyState(true);
      }, 800);
      return;
    }
    this.lastNotify = now;
    for (const fn of this.stateSubscribers) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  }

  getState(): SessionRuntimeState {
    return {
      id: this.wid,
      claudeSessionId: this.claudeSessionId,
      cwd: this.cwd,
      title: this.title,
      model: this.model,
      permissionMode: this.permissionMode,
      status: this.status,
      statusDetail: this.statusDetail,
      live: this.isAlive(),
      costUsd: this.costUsd,
      turnStartedAt: this.turnStartedAt,
      currentTool: this.currentTool,
      activeTools: [...this.activeTools.entries()].map(([toolUseId, tool]) => ({
        ...tool,
        toolUseId,
      })),
      tasks: [...this.tasks.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-30),
      contextUsage: this.contextUsage,
      pendingPermissions: [...this.pending.values()].map((p) => p.view),
      pendingQuestions: [...this.pendingQuestions.values()].map((p) => p.view),
      pendingPlan: this.pendingPlan?.view,
      claudeVersion: this.claudeVersion,
      slashCommandCount: this.slashCommandCount,
      skillCount: this.skillCount,
      slashCommands: this.slashCommands,
      commandDetails: this.commandDetails,
      skills: this.skills,
      tools: this.tools,
    };
  }

  private setStatus(status: RuntimeStatus, detail?: string): void {
    if (this.status === status && this.statusDetail === detail) return;
    this.status = status;
    this.statusDetail = detail;
    this.options2.onMeta({ status });
    this.notifyState(true);
  }

  private scheduleIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.status === 'idle' && this.pending.size === 0) {
        this.emit({ type: 'notice', level: 'info', text: '会话已空闲，后台进程已休眠；下次发送会自动恢复。' });
        void this.stop('空闲休眠');
      }
    }, config.idleMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  sendUserMessage(
    text: string,
    attachments: ResolvedAttachment[] = [],
    options: { id?: string; recovered?: boolean } = {},
  ): void {
    if (this.stopped) throw new Error('会话进程已停止');
    const clean = text.trim();
    if (!clean && attachments.length === 0) return;
    const refs: AttachmentRef[] = attachments.map((attachment) => attachment.ref);
    const wasRunning = this.status === 'running' || this.status === 'waiting_permission';
    const eventId = options.id ?? randomId();
    this.lastAssistantText = '';
    this.clearIdleTimer();
    if (options.recovered) {
      // The original user.message (and its failed marker) is already in the
      // transcript. Update that bubble in place instead of appending a
      // duplicate message.
      this.emit({ type: 'user.message.retrying', id: eventId });
    } else {
      this.emit({
        type: 'user.message',
        id: eventId,
        text: clean,
        ...(refs.length > 0 ? { attachments: refs } : {}),
        ...(wasRunning ? { queued: true } : {}),
      });
    }
    if (!this.title || this.title === '新会话') {
      this.title = truncate(clean || refs[0]?.name || '附件', 80);
      this.options2.onMeta({ title: this.title });
    }
    this.status = 'running';
    this.turnStartedAt = Date.now();
    this.statusDetail = undefined;
    this.options2.onMeta({ status: 'running' });
    this.emit({ type: 'session.status', status: 'running' });
    this.notifyState(true);
    this.enqueue(
      {
        type: 'user',
        message: { role: 'user', content: buildUserContent(clean, attachments) },
        parent_tool_use_id: null,
        session_id: this.claudeSessionId ?? '',
        // The CLI echoes this uuid on frames for the turn that consumes the
        // message, including a mid-turn fold. Keep it aligned with the event id
        // so delivery can be confirmed without waiting for a turn boundary.
        uuid: eventId,
      } as SDKUserMessage,
      eventId,
    );
  }

  async interrupt(): Promise<void> {
    if (!this.q) return;
    // A pending canUseTool promise blocks the SDK's interrupt path. Denying
    // it first makes "stop" work immediately when the turn is waiting for a
    // permission decision.
    this.denyAllPending('已请求停止当前回合');
    this.statusDetail = '正在停止…';
    this.notifyState(true);
    this.emit({ type: 'notice', level: 'warn', text: '已请求停止当前回合。' });
    try {
      const interrupted = await Promise.race([
        this.q.interrupt().then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 2_500);
          timer.unref?.();
        }),
      ]);
      if (!interrupted) {
        this.statusDetail = '停止请求已发出，等待当前工具退出；仍未停止可强制结束进程';
        this.emit({
          type: 'notice',
          level: 'warn',
          text: '停止请求已发出，但当前工具仍在退出；仍未停止可在会话设置里强制结束进程。',
        });
      } else {
        this.statusDetail = '正在停止…';
      }
      this.notifyState(true);
    } catch (error) {
      this.emit({ type: 'notice', level: 'error', text: `停止失败：${errorMessage(error)}` });
      this.notifyState(true);
    }
  }

  private denyAllPending(message: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ behavior: 'deny', message, toolUseID: pending.toolUseId });
      this.emit({ type: 'permission.resolved', requestId, decision: 'deny' });
    }
    this.pending.clear();
    for (const [requestId, pending] of this.pendingQuestions) {
      clearTimeout(pending.timer);
      pending.resolve({ behavior: 'deny', message, toolUseID: pending.toolUseId });
      this.emit({ type: 'question.resolved', requestId, skipped: true, reason: message });
    }
    this.pendingQuestions.clear();
    if (this.pendingPlan) {
      const pending = this.pendingPlan;
      clearTimeout(pending.timer);
      pending.resolve({ behavior: 'deny', message, toolUseID: pending.toolUseId });
      this.emit({
        type: 'plan.resolved',
        requestId: pending.view.requestId,
        approved: false,
        reason: message,
      });
      this.pendingPlan = undefined;
    }
    if (this.status === 'waiting_permission') {
      this.status = 'running';
      this.statusDetail = undefined;
      this.emit({ type: 'session.status', status: 'running' });
    }
    this.notifyState(true);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.permissionMode === mode) return;
    try {
      const allowAll = mode === 'bypassPermissions';
      if (this.q && !this.stopped) {
        await this.q.setPermissionMode((allowAll ? 'default' : mode) as SdkPermissionMode);
      }
      this.autoAllowAll = allowAll;
      this.permissionMode = mode;
      if (allowAll) this.resolveAllPendingAllow();
      this.options2.onMeta({ permissionMode: mode });
      this.emit({ type: 'session.meta', model: this.model, permissionMode: mode, costUsd: this.costUsd });
      this.notifyState(true);
    } catch (error) {
      this.emit({ type: 'notice', level: 'error', text: `切换权限模式失败：${errorMessage(error)}` });
    }
  }

  private resolveAllPendingAllow(): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
        toolUseID: pending.toolUseId,
      });
      this.emit({ type: 'permission.resolved', requestId, decision: 'allow_once' });
    }
    this.pending.clear();
    if (this.status === 'waiting_permission') {
      this.status = 'running';
      this.emit({ type: 'session.status', status: 'running' });
    }
  }

  async setModel(model: string | undefined): Promise<void> {
    try {
      if (this.q && !this.stopped) await this.q.setModel(model);
      this.model = model;
      this.options2.onMeta({ model });
      this.emit({ type: 'session.meta', model, permissionMode: this.permissionMode, costUsd: this.costUsd });
      this.notifyState(true);
    } catch (error) {
      this.emit({ type: 'notice', level: 'error', text: `切换模型失败：${errorMessage(error)}` });
    }
  }

  async respondPermission(
    requestId: string,
    decision: 'allow_once' | 'allow_session' | 'deny',
    updatedInput?: Record<string, unknown>,
  ): Promise<boolean> {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    const input = updatedInput ?? pending.input;
    let result: PermissionResult;
    if (decision === 'deny') {
      result = {
        behavior: 'deny',
        message: '用户拒绝了这次操作',
        toolUseID: pending.toolUseId,
      };
    } else {
      const updatedPermissions: PermissionUpdate[] | undefined =
        decision === 'allow_session'
          ? Array.isArray(pending.suggestions) && pending.suggestions.length > 0
            ? (pending.suggestions as PermissionUpdate[])
            : [
                {
                  type: 'addRules',
                  rules: [{ toolName: pending.view.toolName }],
                  behavior: 'allow',
                  destination: 'session',
                },
              ]
          : undefined;
      result = {
        behavior: 'allow',
        updatedInput: input,
        toolUseID: pending.toolUseId,
        ...(updatedPermissions ? { updatedPermissions } : {}),
      };
    }
    pending.resolve(result);
    this.emit({
      type: 'permission.resolved',
      requestId,
      decision,
    });
    if (this.pending.size === 0 && this.status === 'waiting_permission') {
      this.status = 'running';
      this.emit({ type: 'session.status', status: 'running' });
    }
    this.notifyState(true);
    return true;
  }

  async respondQuestion(
    requestId: string,
    answers?: Record<string, unknown>,
    skipped = false,
  ): Promise<boolean> {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingQuestions.delete(requestId);
    const normalized = questionAnswers(pending.view.questions, answers, skipped);
    pending.resolve({
      behavior: 'allow',
      updatedInput: { ...pending.input, answers: normalized },
      toolUseID: pending.toolUseId,
    });
    this.emit({
      type: 'question.resolved',
      requestId,
      answers: normalized,
      ...(skipped ? { skipped: true } : {}),
    });
    this.finishWaitingIfIdle();
    return true;
  }

  async respondPlan(
    requestId: string,
    approved: boolean,
    feedback?: string,
  ): Promise<boolean> {
    const pending = this.pendingPlan;
    if (!pending || pending.view.requestId !== requestId) return false;
    clearTimeout(pending.timer);
    this.pendingPlan = undefined;
    const note = typeof feedback === 'string' ? feedback.trim().slice(0, 4000) : '';
    if (approved) {
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
        toolUseID: pending.toolUseId,
      });
    } else {
      pending.resolve({
        behavior: 'deny',
        message: note || '用户暂不批准该计划，请继续完善计划后再提交。',
        toolUseID: pending.toolUseId,
      });
    }
    this.emit({
      type: 'plan.resolved',
      requestId,
      approved,
      ...(note && !approved ? { feedback: note } : {}),
    });
    this.finishWaitingIfIdle();
    return true;
  }

  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    opts: PermissionOptions,
  ): Promise<PermissionResult> {
    // AskUserQuestion is not a permission prompt: even in "allow everything"
    // mode the user must answer it, otherwise the CLI reports "未回答".
    if (toolName === 'AskUserQuestion') {
      return this.askQuestion(input, opts);
    }
    // ExitPlanMode carries no plan body; the plan is the preceding assistant
    // message. Present it before letting the CLI leave plan mode.
    if (toolName === 'ExitPlanMode' && !this.autoAllowAll) {
      return this.approvePlan(input, opts);
    }
    if (this.autoAllowAll) {
      return { behavior: 'allow', updatedInput: input, toolUseID: opts.toolUseID };
    }
    this.clearIdleTimer();
    const requestId = opts.requestId || randomId();
    const view: PendingPermissionView = {
      requestId,
      toolUseId: opts.toolUseID,
      toolName,
      input,
      title: opts.title,
      description: opts.description,
      suggestions: opts.suggestions,
      defaultToNo: opts.defaultToNo,
      suppressAlwaysAllowRule: opts.suppressAlwaysAllowRule,
      createdAt: Date.now(),
    };
    this.emit({ type: 'permission.request', ...view });
    this.setWaiting(`等待批准：${toolName}`);
    this.notifyState(true);

    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        resolve({
          behavior: 'deny',
          message: '等待用户批准超时',
          toolUseID: opts.toolUseID,
        });
        this.emit({ type: 'permission.resolved', requestId, decision: 'timeout' });
        this.finishWaitingIfIdle();
        this.notifyState(true);
      }, config.permissionTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, {
        view,
        suggestions: opts.suggestions,
        input,
        toolUseId: opts.toolUseID,
        resolve,
        timer,
      });
    });
  }

  private setWaiting(detail: string): void {
    this.status = 'waiting_permission';
    this.statusDetail = detail;
    this.emit({ type: 'session.status', status: 'waiting_permission', detail });
    this.notifyState(true);
  }

  private finishWaitingIfIdle(): void {
    if (
      this.pending.size === 0 &&
      this.pendingQuestions.size === 0 &&
      !this.pendingPlan &&
      this.status === 'waiting_permission'
    ) {
      this.status = 'running';
      this.statusDetail = undefined;
      this.emit({ type: 'session.status', status: 'running' });
    }
    this.notifyState(true);
  }

  private async askQuestion(
    input: Record<string, unknown>,
    opts: PermissionOptions,
  ): Promise<PermissionResult> {
    const questions = parseQuestions(input.questions);
    if (questions.length === 0) {
      // Malformed or an older CLI shape: let the tool handle it rather than
      // blocking the turn. The CLI will send its own unanswered result.
      return { behavior: 'allow', updatedInput: input, toolUseID: opts.toolUseID };
    }
    this.clearIdleTimer();
    const requestId = opts.requestId || randomId();
    const view: PendingQuestionView = {
      requestId,
      toolUseId: opts.toolUseID,
      questions,
      createdAt: Date.now(),
    };
    this.emit({ type: 'question.request', ...view });
    this.setWaiting(`等待回答：${questions[0]?.header || '问题'}`);

    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pendingQuestions.has(requestId)) return;
        this.pendingQuestions.delete(requestId);
        const answers = questionAnswers(questions, undefined, true);
        resolve({
          behavior: 'allow',
          updatedInput: { ...input, answers },
          toolUseID: opts.toolUseID,
        });
        this.emit({ type: 'question.resolved', requestId, answers, timedOut: true });
        this.finishWaitingIfIdle();
        this.notifyState(true);
      }, config.permissionTimeoutMs);
      timer.unref?.();
      this.pendingQuestions.set(requestId, {
        view,
        input,
        toolUseId: opts.toolUseID,
        resolve,
        timer,
      });
    });
  }

  private async approvePlan(
    input: Record<string, unknown>,
    opts: PermissionOptions,
  ): Promise<PermissionResult> {
    this.clearIdleTimer();
    const requestId = opts.requestId || randomId();
    const plan =
      (typeof input.plan === 'string' && input.plan.trim()) ||
      this.lastAssistantText.trim() ||
      '（模型没有提供计划正文，请根据对话上下文确认。）';
    const view: PendingPlanView = {
      requestId,
      toolUseId: opts.toolUseID,
      plan,
      createdAt: Date.now(),
    };
    this.emit({ type: 'plan.request', ...view });
    this.setWaiting('等待确认计划');

    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingPlan?.view.requestId !== requestId) return;
        this.pendingPlan = undefined;
        resolve({
          behavior: 'deny',
          message: '等待用户确认计划超时，请继续完善计划',
          toolUseID: opts.toolUseID,
        });
        this.emit({ type: 'plan.resolved', requestId, approved: false, timedOut: true });
        this.finishWaitingIfIdle();
      }, config.permissionTimeoutMs);
      timer.unref?.();
      this.pendingPlan = {
        view,
        input,
        toolUseId: opts.toolUseID,
        resolve,
        timer,
      };
    });
  }

  private flushAccumulator(acc: MessageAccumulator): void {
    const blocks = acc.order
      .map((index) => acc.blocks.get(index))
      .filter((block): block is ContentBlock => !!block)
      .map((block) => {
        if (block.type === 'tool_use' && (!block.input || Object.keys(block.input as object).length === 0)) {
          return { ...block, input: {} };
        }
        return block;
      });
    if (blocks.length === 0) return;
    if (acc.parentKey === 'main') {
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
        .trim();
      if (text) this.lastAssistantText = text;
    }
    this.emit({
      type: 'assistant.message',
      messageId: acc.messageId,
      blocks,
      model: acc.model,
      usage: acc.usage,
      final: true,
      parentToolUseId: acc.parentKey === 'main' ? null : acc.parentKey,
    });
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.name) {
        const toolUseId = block.id ?? `${block.name}:${Date.now()}`;
        this.activeTools.set(toolUseId, { name: block.name, startedAt: Date.now() });
        this.currentTool = {
          name: block.name,
          toolUseId: block.id,
          startedAt: Date.now(),
        };
      }
    }
    this.notifyState(true);
  }

  private handleMessage(raw: Record<string, unknown>): void {
    this.markConsumedInputs(raw);
    const type = raw.type as string | undefined;
    const subtype = raw.subtype as string | undefined;

    if (type === 'system' && subtype === 'init') {
      this.claudeSessionId = typeof raw.session_id === 'string' ? raw.session_id : this.claudeSessionId;
      this.model = typeof raw.model === 'string' ? raw.model : this.model;
      this.claudeVersion =
        typeof raw.claude_code_version === 'string' ? raw.claude_code_version : this.claudeVersion;
      if (
        !this.autoAllowAll &&
        (typeof raw.permission_mode === 'string' || typeof raw.permissionMode === 'string')
      ) {
        const mode = (raw.permission_mode ?? raw.permissionMode) as PermissionMode;
        this.permissionMode = mode;
      }
      const tools = Array.isArray(raw.tools) ? (raw.tools as string[]) : undefined;
      const skills = Array.isArray(raw.skills) ? (raw.skills as string[]) : undefined;
      const slashCommands = Array.isArray(raw.slash_commands)
        ? (raw.slash_commands as string[])
        : undefined;
      this.slashCommandCount = slashCommands?.length ?? 0;
      this.skillCount = skills?.length ?? 0;
      this.slashCommands = slashCommands ?? [];
      this.skills = skills ?? [];
      this.tools = tools ?? [];
      this.emit({
        type: 'session.init',
        sessionId: this.claudeSessionId ?? this.wid,
        cwd: this.cwd,
        model: this.model,
        permissionMode: this.permissionMode,
        tools,
        claudeVersion: this.claudeVersion,
        skills,
        slashCommands,
      });
      this.options2.onMeta({
        claudeSessionId: this.claudeSessionId,
        model: this.model,
        permissionMode: this.permissionMode,
      });
      this.notifyState(true);
      return;
    }

    if (type === 'system' && subtype === 'status') {
      const status = raw.status as string | null;
      if (status === 'compacting') {
        this.statusDetail = '正在压缩上下文…';
      } else {
        this.statusDetail = undefined;
      }
      if (typeof raw.permissionMode === 'string') {
        this.permissionMode = raw.permissionMode as PermissionMode;
      }
      if (raw.compact_result === 'success') {
        this.emit({ type: 'notice', level: 'info', text: '上下文压缩完成。' });
      } else if (raw.compact_result === 'failed') {
        this.emit({
          type: 'notice',
          level: 'warn',
          text: `上下文压缩失败：${String(raw.compact_error ?? '未知原因')}`,
        });
      }
      this.notifyState(true);
      return;
    }

    if (type === 'system' && subtype === 'compact_boundary') {
      const meta = raw.compact_metadata as { pre_tokens?: number } | undefined;
      if (typeof meta?.pre_tokens === 'number') {
        this.emit({
          type: 'notice',
          level: 'info',
          text: `上下文已压缩（压缩前约 ${Math.round(meta.pre_tokens / 1000)}k tokens）。`,
        });
      }
      return;
    }

    if (type === 'system' && subtype === 'task_started') {
      const id = String(raw.task_id ?? '');
      if (!id) return;
      this.tasks.set(id, {
        id,
        description: String(raw.description ?? '后台任务'),
        subagentType: typeof raw.subagent_type === 'string' ? raw.subagent_type : undefined,
        status: 'running',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        isBackgrounded: raw.is_backgrounded === true,
      });
      this.notifyState(true);
      return;
    }

    if (type === 'system' && subtype === 'task_progress') {
      const id = String(raw.task_id ?? '');
      const task = this.tasks.get(id);
      if (!task) return;
      const usage = raw.usage as Record<string, unknown> | undefined;
      task.description = String(raw.description ?? task.description);
      task.lastToolName = typeof raw.last_tool_name === 'string' ? raw.last_tool_name : task.lastToolName;
      task.summary = typeof raw.summary === 'string' ? raw.summary : task.summary;
      if (usage) {
        task.usage = {
          totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
          toolUses: typeof usage.tool_uses === 'number' ? usage.tool_uses : undefined,
          durationMs: typeof usage.duration_ms === 'number' ? usage.duration_ms : undefined,
        };
      }
      task.updatedAt = Date.now();
      this.notifyState();
      return;
    }

    if (type === 'system' && subtype === 'task_updated') {
      const id = String(raw.task_id ?? '');
      const task = this.tasks.get(id);
      const patch = raw.patch as Record<string, unknown> | undefined;
      if (!task || !patch) return;
      if (typeof patch.status === 'string') task.status = patch.status as TaskView['status'];
      if (typeof patch.description === 'string') task.description = patch.description;
      if (typeof patch.error === 'string') task.error = patch.error;
      if (typeof patch.end_time === 'number') task.endTime = patch.end_time;
      if (typeof patch.is_backgrounded === 'boolean') task.isBackgrounded = patch.is_backgrounded;
      task.updatedAt = Date.now();
      if (task.status !== 'running' && task.status !== 'pending') {
        this.emit({
          type: 'notice',
          level: task.status === 'failed' ? 'warn' : 'info',
          text: `后台任务${task.status === 'completed' ? '完成' : task.status === 'failed' ? '失败' : '结束'}：${task.description}`,
        });
      }
      this.notifyState(true);
      return;
    }

    if (type === 'system' && subtype === 'task_notification') {
      const id = String(raw.task_id ?? '');
      const task = this.tasks.get(id);
      if (!task) return;
      const status = raw.status;
      if (status === 'completed') task.status = 'completed';
      else if (status === 'failed') task.status = 'failed';
      else task.status = 'killed';
      if (typeof raw.summary === 'string') task.summary = raw.summary;
      task.endTime = Date.now();
      task.updatedAt = Date.now();
      this.notifyState(true);
      return;
    }

    if (type === 'system' && subtype === 'tool_progress') {
      const toolUseId = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : '';
      const elapsedSeconds =
        typeof raw.elapsed_time_seconds === 'number' ? raw.elapsed_time_seconds : undefined;
      if (toolUseId) {
        const tool = this.activeTools.get(toolUseId);
        if (tool) tool.elapsedSeconds = elapsedSeconds;
        if (this.currentTool?.toolUseId === toolUseId) {
          this.currentTool.elapsedSeconds = elapsedSeconds;
        }
      }
      this.notifyState();
      return;
    }

    if (type === 'system' && subtype === 'permission_denied') {
      this.emit({
        type: 'notice',
        level: 'warn',
        text: `权限被自动拒绝：${String(raw.tool_name ?? '工具')}${raw.reason ? `（${String(raw.reason)}）` : ''}`,
      });
      return;
    }

    if (type === 'stream_event') {
      this.handleStreamEvent(raw);
      return;
    }

    if (type === 'assistant') {
      this.handleAssistantMessage(raw);
      return;
    }

    if (type === 'user') {
      const parentKey = parentKeyOf(raw.parent_tool_use_id);
      if (parentKey !== 'main') return;
      const message = raw.message as { content?: unknown } | undefined;
      const content = message?.content;
      if (!Array.isArray(content)) return;
      const structured = raw.tool_use_result;
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const block = item as Record<string, unknown>;
        if (block.type !== 'tool_result') continue;
        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        if (!toolUseId) continue;
        let images: ToolImageRef[] = [];
        try {
          images = this.options2.toolImages.saveFromContent(this.wid, block.content);
        } catch {
          // Image previews are best-effort; the text result must still arrive.
        }
        this.emit({
          type: 'tool.result',
          toolUseId,
          content: toolResultText(block.content),
          isError: block.is_error === true,
          structured,
          ...(images.length > 0 ? { images } : {}),
        });
        this.activeTools.delete(toolUseId);
        const remaining = [...this.activeTools.entries()].at(-1);
        this.currentTool = remaining
          ? {
              name: remaining[1].name,
              toolUseId: remaining[0],
              startedAt: remaining[1].startedAt,
              elapsedSeconds: remaining[1].elapsedSeconds,
            }
          : undefined;
      }
      this.notifyState(true);
      return;
    }

    if (type === 'result') {
      for (const acc of this.accumulators.values()) this.flushAccumulator(acc);
      this.accumulators.clear();
      this.activeMessage.clear();
      this.currentTool = undefined;
      this.activeTools.clear();
      this.status = 'idle';
      this.statusDetail = undefined;
      this.turnStartedAt = undefined;
      const totalCost = raw.total_cost_usd;
      if (typeof totalCost === 'number') {
        this.costUsd = totalCost;
        this.options2.onMeta({ costUsd: totalCost });
      }
      const subtypeResult = String(raw.subtype ?? 'success');
      const isError = subtypeResult !== 'success' || raw.is_error === true;
      // Older CLIs do not echo user-message uuids. Keep the turn-boundary FIFO
      // fallback only for them; with uuid metadata, delivery is confirmed when
      // the CLI reports the message as consumed.
      if (
        typeof raw.user_message_uuid !== 'string' &&
        !Array.isArray(raw.user_message_uuids)
      ) {
        this.markInputDelivered();
      }
      this.emit({
        type: 'turn.result',
        subtype: subtypeResult,
        isError,
        text: typeof raw.result === 'string' ? raw.result : undefined,
        costUsd: typeof totalCost === 'number' ? totalCost : undefined,
        durationMs: typeof raw.duration_ms === 'number' ? raw.duration_ms : undefined,
        numTurns: typeof raw.num_turns === 'number' ? raw.num_turns : undefined,
        usage: raw.usage,
      });
      this.emit({ type: 'session.status', status: 'idle' });
      this.options2.onMeta({ status: 'idle', costUsd: this.costUsd });
      this.notifyState(true);
      void this.refreshContextUsage();
      this.scheduleIdleTimer();
      return;
    }

    if (type === 'tool_use_summary') {
      return;
    }
  }

  private handleStreamEvent(raw: Record<string, unknown>): void {
    const event = raw.event as Record<string, unknown> | undefined;
    if (!event || typeof event.type !== 'string') return;
    const parentKey = parentKeyOf(raw.parent_tool_use_id);

    if (event.type === 'message_start') {
      const message = event.message as Record<string, unknown> | undefined;
      const messageId =
        typeof message?.id === 'string' ? message.id : randomId();
      const acc: MessageAccumulator = {
        parentKey,
        messageId,
        model: typeof message?.model === 'string' ? message.model : undefined,
        usage: message?.usage,
        blocks: new Map(),
        order: [],
        toolIdToIndex: new Map(),
      };
      this.accumulators.set(`${parentKey}:${messageId}`, acc);
      this.activeMessage.set(parentKey, messageId);
      return;
    }

    const activeId = this.activeMessage.get(parentKey);
    const acc = activeId ? this.accumulators.get(`${parentKey}:${activeId}`) : undefined;
    if (!acc) return;

    if (event.type === 'content_block_start') {
      const index = typeof event.index === 'number' ? event.index : acc.order.length;
      const block = normalizeBlock(event.content_block);
      if (!block) return;
      acc.blocks.set(index, block);
      if (!acc.order.includes(index)) acc.order.push(index);
      if (block.type === 'tool_use' && block.id) acc.toolIdToIndex.set(block.id, index);
      return;
    }

    if (event.type === 'content_block_delta') {
      const index = typeof event.index === 'number' ? event.index : 0;
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) return;
      let block = acc.blocks.get(index);
      if (!block) {
        block = { type: 'text', text: '' };
        acc.blocks.set(index, block);
        acc.order.push(index);
      }
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        block.type = 'text';
        block.text = (block.text ?? '') + delta.text;
        if (parentKey === 'main') {
          const text = acc.order
            .map((key) => acc.blocks.get(key))
            .filter((item): item is ContentBlock => item?.type === 'text')
            .map((item) => item.text ?? '')
            .join('\n')
            .trim();
          if (text) this.lastAssistantText = text;
        }
        if (parentKey === 'main' && delta.text) {
          this.emit({
            type: 'assistant.delta',
            messageId: acc.messageId,
            index,
            kind: 'text',
            text: delta.text,
          });
        }
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        block.type = 'thinking';
        block.thinking = (block.thinking ?? '') + delta.thinking;
        if (parentKey === 'main' && delta.thinking) {
          this.emit({
            type: 'assistant.delta',
            messageId: acc.messageId,
            index,
            kind: 'thinking',
            text: delta.thinking,
          });
        }
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const previous = typeof block.__partialJson === 'string' ? block.__partialJson : '';
        block.__partialJson = previous + delta.partial_json;
      } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
        block.signature = delta.signature;
      }
      return;
    }

    if (event.type === 'message_delta') {
      const usage = event.usage;
      if (usage) acc.usage = usage;
      return;
    }

    if (event.type === 'message_stop') {
      this.flushAccumulator(acc);
      this.accumulators.delete(`${parentKey}:${acc.messageId}`);
      if (this.activeMessage.get(parentKey) === acc.messageId) {
        this.activeMessage.delete(parentKey);
      }
    }
  }

  private handleAssistantMessage(raw: Record<string, unknown>): void {
    const parentKey = parentKeyOf(raw.parent_tool_use_id);
    const message = raw.message as Record<string, unknown> | undefined;
    if (!message) return;
    const messageId =
      typeof message.id === 'string' ? message.id : randomId();
    const key = `${parentKey}:${messageId}`;
    let acc = this.accumulators.get(key);
    const content = message.content;

    if (!acc) {
      // No stream events for this message (e.g. a subagent frame). Emit it whole.
      const blocks: ContentBlock[] = [];
      if (Array.isArray(content)) {
        for (const item of content) {
          const block = normalizeBlock(item);
          if (block) blocks.push(block);
        }
      }
      if (blocks.length > 0) {
        if (parentKey === 'main') {
          const text = blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('\n')
            .trim();
          if (text) this.lastAssistantText = text;
        }
        this.emit({
          type: 'assistant.message',
          messageId,
          blocks,
          model: typeof message.model === 'string' ? message.model : undefined,
          usage: message.usage,
          final: true,
          parentToolUseId: parentKey === 'main' ? null : parentKey,
          agentId: typeof raw.agent_id === 'string' ? raw.agent_id : undefined,
        });
      }
      return;
    }

    if (!Array.isArray(content)) return;
    for (const item of content) {
      const block = normalizeBlock(item);
      if (!block) continue;
      if (block.type === 'tool_use' && block.id) {
        const index = acc.toolIdToIndex.get(block.id);
        if (index !== undefined) {
          const existing = acc.blocks.get(index);
          if (existing) {
            existing.input = block.input;
            delete existing.__partialJson;
          }
        } else {
          const index = acc.order.length;
          acc.blocks.set(index, block);
          acc.order.push(index);
          acc.toolIdToIndex.set(block.id, index);
        }
      } else if (block.type === 'text' || block.type === 'thinking') {
        const key2 = block.type;
        const targetIndex = acc.order.find((index) => {
          const existing = acc.blocks.get(index);
          if (!existing || existing.type !== key2) return false;
          const text = key2 === 'text' ? existing.text : existing.thinking;
          return !text;
        });
        if (targetIndex !== undefined) {
          acc.blocks.set(targetIndex, block);
        }
      }
    }
    if (typeof message.model === 'string') acc.model = message.model;
    if (message.usage) acc.usage = message.usage;
    const error = raw.error;
    if (typeof error === 'string') {
      this.emit({ type: 'notice', level: 'error', text: `模型返回错误：${error}` });
    }
  }

  /**
   * Refresh context usage from the SDK. Public so the Web UI can implement a
   * native `/context` command without sending a synthetic CLI message.
   */
  async refreshContextUsage(): Promise<ContextUsage | undefined> {
    const q = this.q;
    if (!q || this.stopped) return this.contextUsage;
    try {
      const usage = await q.getContextUsage({ detail: 'summary' });
      if (!usage) return this.contextUsage;
      const raw = usage as unknown as Record<string, unknown>;
      this.contextUsage = {
        totalTokens: typeof raw.totalTokens === 'number' ? raw.totalTokens : undefined,
        maxTokens: typeof raw.maxTokens === 'number' ? raw.maxTokens : undefined,
        percentage: typeof raw.percentage === 'number' ? raw.percentage : undefined,
        categories: Array.isArray(raw.categories)
          ? (raw.categories as Record<string, unknown>[]).map((row) => ({
              id: typeof row.id === 'string' ? row.id : undefined,
              name: String(row.name ?? ''),
              tokens: typeof row.tokens === 'number' ? row.tokens : 0,
            }))
          : undefined,
      };
      this.notifyState(true);
    } catch {
      // context usage is best-effort
    }
    return this.contextUsage;
  }

  /**
   * Safe session extension view: MCP status and agents only. MCP config
   * (env, headers, URLs) is deliberately not copied to the Web client.
   */
  async extensions(): Promise<ExtensionsView> {
    const q = this.q;
    if (!q || this.stopped) {
      return { available: false, mcpServers: [], agents: [] };
    }
    const [mcpResult, agentResult] = await Promise.allSettled([
      q.mcpServerStatus(),
      q.supportedAgents(),
    ]);
    const mcpServers: McpServerView[] = [];
    let mcpError: string | undefined;
    if (mcpResult.status === 'fulfilled') {
      for (const row of mcpResult.value) {
        const view = mapMcpStatus(row);
        if (view) mcpServers.push(view);
      }
      mcpServers.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      mcpError = errorMessage(mcpResult.reason).slice(0, 500);
    }
    const agents: AgentInfoView[] = [];
    let agentsError: string | undefined;
    if (agentResult.status === 'fulfilled') {
      for (const row of agentResult.value) {
        const view = mapAgentInfo(row);
        if (view) agents.push(view);
      }
      agents.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      agentsError = errorMessage(agentResult.reason).slice(0, 500);
    }
    return {
      available: true,
      mcpServers,
      agents,
      ...(mcpError ? { mcpError } : {}),
      ...(agentsError ? { agentsError } : {}),
    };
  }

  async toggleMcpServer(name: string, enabled: boolean): Promise<void> {
    const q = this.q;
    if (!q || this.stopped) throw new Error('会话未运行，无法管理 MCP 服务器');
    const server = name.trim();
    if (!server || server.length > 200) throw new Error('MCP 服务器名称无效');
    await q.toggleMcpServer(server, enabled);
  }

  async reconnectMcpServer(name: string): Promise<void> {
    const q = this.q;
    if (!q || this.stopped) throw new Error('会话未运行，无法重连 MCP 服务器');
    const server = name.trim();
    if (!server || server.length > 200) throw new Error('MCP 服务器名称无效');
    await q.reconnectMcpServer(server);
  }

  async stop(detail = '已停止'): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.inputClosed = true;
    this.failPendingInputs(detail);
    this.clearIdleTimer();
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.abortController.abort();
    while (this.inputWaiters.length > 0) {
      const waiter = this.inputWaiters.shift();
      waiter?.({ value: undefined as unknown as SDKUserMessage, done: true });
    }
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ behavior: 'deny', message: '会话已停止', toolUseID: pending.toolUseId });
      this.emit({ type: 'permission.resolved', requestId, decision: 'deny' });
    }
    this.pending.clear();
    for (const [requestId, pending] of this.pendingQuestions) {
      clearTimeout(pending.timer);
      pending.resolve({ behavior: 'deny', message: '会话已停止', toolUseID: pending.toolUseId });
      this.emit({ type: 'question.resolved', requestId, skipped: true, reason: '会话已停止' });
    }
    this.pendingQuestions.clear();
    if (this.pendingPlan) {
      const pending = this.pendingPlan;
      clearTimeout(pending.timer);
      pending.resolve({ behavior: 'deny', message: '会话已停止', toolUseID: pending.toolUseId });
      this.emit({
        type: 'plan.resolved',
        requestId: pending.view.requestId,
        approved: false,
        reason: '会话已停止',
      });
      this.pendingPlan = undefined;
    }
    try {
      await this.q?.return(undefined);
    } catch {
      // the abort already ended it
    }
    this.status = 'stopped';
    this.statusDetail = detail;
    this.turnStartedAt = undefined;
    this.currentTool = undefined;
    this.activeTools.clear();
    this.options2.onMeta({ status: 'stopped', updatedAt: nowIso() });
    this.emit({ type: 'session.status', status: 'stopped', detail });
    this.notifyState(true);
  }
}

interface PermissionOptions {
  signal: AbortSignal;
  suggestions?: unknown[];
  blockedPath?: string;
  mcpServer?: { name: string; source: string };
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
  toolUseID: string;
  agentID?: string;
  requestId: string;
}
