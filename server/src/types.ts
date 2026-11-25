export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'auto';

export type RuntimeStatus = 'idle' | 'running' | 'waiting_permission' | 'stopped' | 'error';

export type PermissionDecision = 'allow_once' | 'allow_session' | 'deny';

export type EventLevel = 'info' | 'warn' | 'error';

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  [key: string]: unknown;
}

/**
 * A file the user attached to a message. The binary lives under
 * `data/attachments/<sessionId>/`; only this descriptor is written to the
 * transcript, so history replay never embeds file bytes.
 */
export interface AttachmentRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'file';
}

/**
 * An image returned by a tool (for example Read on a PNG). The bytes live
 * under `data/tool-images/<sessionId>/`; the transcript only stores this
 * descriptor so replay and history fetches stay small.
 */
export interface ToolImageRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface TaskView {
  id: string;
  description: string;
  subagentType?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused';
  startedAt: number;
  updatedAt: number;
  endTime?: number;
  lastToolName?: string;
  summary?: string;
  error?: string;
  isBackgrounded?: boolean;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
}

export interface ContextUsage {
  totalTokens?: number;
  maxTokens?: number;
  percentage?: number;
  categories?: { id?: string; name: string; tokens: number }[];
}

export interface McpToolView {
  name: string;
  description?: string;
  readOnly?: boolean;
  destructive?: boolean;
}

export interface McpServerView {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  scope?: string;
  source?: string;
  serverName?: string;
  serverVersion?: string;
  error?: string;
  tools: McpToolView[];
}

export interface AgentInfoView {
  name: string;
  description: string;
  model?: string;
}

export interface ExtensionsView {
  available: boolean;
  mcpServers: McpServerView[];
  agents: AgentInfoView[];
  mcpError?: string;
  agentsError?: string;
}

export interface SessionRuntimeState {
  id: string;
  claudeSessionId?: string;
  cwd: string;
  title?: string;
  model?: string;
  permissionMode: PermissionMode;
  status: RuntimeStatus;
  statusDetail?: string;
  live: boolean;
  createdAt?: string;
  updatedAt?: string;
  costUsd?: number;
  turnStartedAt?: number;
  currentTool?: { name: string; toolUseId?: string; startedAt: number; elapsedSeconds?: number };
  activeTools?: { name: string; toolUseId?: string; startedAt: number; elapsedSeconds?: number }[];
  tasks: TaskView[];
  contextUsage?: ContextUsage;
  pendingPermissions: PendingPermissionView[];
  pendingQuestions?: PendingQuestionView[];
  pendingPlan?: PendingPlanView;
  claudeVersion?: string;
  slashCommandCount?: number;
  skillCount?: number;
  slashCommands?: string[];
  commandDetails?: { name: string; description?: string }[];
  skills?: string[];
  tools?: string[];
}

export interface PendingPermissionView {
  requestId: string;
  toolUseId?: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  suggestions?: unknown[];
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
  createdAt: number;
}

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface QuestionItem {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PendingQuestionView {
  requestId: string;
  toolUseId?: string;
  questions: QuestionItem[];
  createdAt: number;
}

export interface PendingPlanView {
  requestId: string;
  toolUseId?: string;
  plan: string;
  createdAt: number;
}

type EventBase = { seq: number; ts: number };

export type UiEvent =
  | (EventBase & {
      type: 'session.init';
      sessionId: string;
      cwd: string;
      model?: string;
      permissionMode?: string;
      tools?: string[];
      claudeVersion?: string;
      skills?: string[];
      slashCommands?: string[];
    })
  | (EventBase & { type: 'session.status'; status: RuntimeStatus; detail?: string })
  | (EventBase & { type: 'session.meta'; model?: string; permissionMode?: PermissionMode; costUsd?: number })
  | (EventBase & {
      type: 'user.message';
      id: string;
      text: string;
      attachments?: AttachmentRef[];
      /**
       * True when the message was sent while a turn was already running.
       * The CLI may fold it into the running turn between tool rounds; the
       * UI clears this state once the CLI echoes the message uuid.
       */
      queued?: boolean;
    })
  | (EventBase & { type: 'user.message.delivered'; id: string })
  | (EventBase & { type: 'user.message.failed'; id: string; reason?: string })
  /** A message lost to a service shutdown is being re-sent after restart. */
  | (EventBase & { type: 'user.message.retrying'; id: string })
  | (EventBase & {
      type: 'assistant.message';
      messageId: string;
      blocks: ContentBlock[];
      model?: string;
      usage?: unknown;
      final?: boolean;
      parentToolUseId?: string | null;
      agentId?: string;
      error?: string;
    })
  | (EventBase & {
      type: 'assistant.delta';
      messageId: string;
      index: number;
      kind: 'text' | 'thinking';
      text: string;
    })
  | (EventBase & {
      type: 'tool.result';
      toolUseId: string;
      content: string;
      isError?: boolean;
      structured?: unknown;
      images?: ToolImageRef[];
    })
  | (EventBase & {
      type: 'permission.request';
      requestId: string;
      toolUseId?: string;
      toolName: string;
      input: Record<string, unknown>;
      title?: string;
      description?: string;
      suggestions?: unknown[];
      defaultToNo?: boolean;
      suppressAlwaysAllowRule?: boolean;
      createdAt: number;
    })
  | (EventBase & {
      type: 'permission.resolved';
      requestId: string;
      decision: PermissionDecision | 'timeout';
      by?: string;
    })
  | (EventBase & {
      type: 'question.request';
      requestId: string;
      toolUseId?: string;
      questions: QuestionItem[];
      createdAt: number;
    })
  | (EventBase & {
      type: 'question.resolved';
      requestId: string;
      answers?: Record<string, string>;
      skipped?: boolean;
      timedOut?: boolean;
      reason?: string;
    })
  | (EventBase & {
      type: 'plan.request';
      requestId: string;
      toolUseId?: string;
      plan: string;
      createdAt: number;
    })
  | (EventBase & {
      type: 'plan.resolved';
      requestId: string;
      approved: boolean;
      feedback?: string;
      timedOut?: boolean;
      reason?: string;
    })
  | (EventBase & {
      type: 'turn.result';
      subtype?: string;
      isError?: boolean;
      text?: string;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
      usage?: unknown;
    })
  | (EventBase & { type: 'notice'; level: EventLevel; text: string });

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

export type UiEventInput = DistributiveOmit<UiEvent, 'seq' | 'ts'>;

export interface SessionMeta {
  id: string;
  claudeSessionId?: string;
  cwd: string;
  title?: string;
  model?: string;
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
  status: RuntimeStatus | 'new';
  costUsd?: number;
  lastError?: string;
}

export interface SessionSummary {
  id: string;
  claudeSessionId?: string;
  cwd: string;
  title: string;
  createdAt?: string;
  updatedAt: string;
  status?: string;
  live: boolean;
  source: 'web' | 'claude';
  costUsd?: number;
}

export interface AuthFile {
  username: string;
  passwordHash: string;
  sessionVersion: number;
  updatedAt: string;
}
