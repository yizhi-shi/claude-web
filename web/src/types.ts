// Mirrors server/src/types.ts. Keep the wire contract in sync.
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'auto';

export type RuntimeStatus = 'idle' | 'running' | 'waiting_permission' | 'stopped' | 'error';

export type PermissionDecision = 'allow_once' | 'allow_session' | 'deny';

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
  | (EventBase & {
      type: 'session.meta';
      model?: string;
      permissionMode?: PermissionMode;
      costUsd?: number;
    })
  | (EventBase & { type: 'user.message'; id: string; text: string })
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
  | (EventBase & { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string });

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

export interface ProjectSummary {
  cwd: string;
  sessions: number;
  lastUpdated: string;
}

export interface AppConfig {
  username: string;
  versions: {
    cli: string;
    sdk: string;
    vscodeExtension: string;
    node: string;
    claudeWeb: string;
  };
  allowedRoots: string[];
  permissionModes: { value: PermissionMode; label: string }[];
  models: { current: string; custom: string; customName: string; baseUrl: string };
  defaultPermissionMode: PermissionMode;
  defaultTheme: 'system' | 'dark' | 'light';
  defaultRoot: string;
  idleMinutes: number;
  permissionTimeoutMinutes: number;
  dataDir: string;
}

export interface WorkspaceConfigView {
  defaultRoot: string;
  allowedRoots: string[];
  envRoots: string[];
  extraRoots: string[];
}

export interface StoredEvent extends UiEvent {}

export type VoiceProviderId = 'gemini' | 'openai' | 'volcengine' | 'browser';

export interface VoiceProviderView {
  enabled: boolean;
  model: string;
  baseUrl: string;
  language: string;
  relayEnabled: boolean;
  relayBaseUrl: string;
  appId: string;
  resourceId: string;
  hasApiKey: boolean;
  apiKeyHint: string;
  hasAccessKey: boolean;
  accessKeyHint: string;
  hasRelayAuth: boolean;
  relayAuthHint: string;
  relayAuthHeader: string;
  liveEnabled: boolean;
  liveMode: 'auto' | 'realtime' | 'segment';
  liveModeResolved: 'realtime' | 'segment' | '';
  liveModel: string;
  liveUrl: string;
  hasLiveProxyToken: boolean;
  liveProxyTokenHint: string;
  liveAvailable: boolean;
  liveDetail: string;
}

export interface VoiceConfigView {
  active: VoiceProviderId;
  providers: Record<VoiceProviderId, VoiceProviderView>;
  builtin: Record<
    VoiceProviderId,
    { label: string; models: string[]; docs: string }
  >;
}

export interface VoiceTestResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

export interface VoiceTranscribeResult {
  text: string;
  provider: VoiceProviderId;
  model: string;
  latencyMs: number;
}
