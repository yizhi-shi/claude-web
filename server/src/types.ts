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
    })
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
