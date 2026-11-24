import type {
  AppConfig,
  AttachmentRef,
  DirListing,
  PermissionDecision,
  PermissionMode,
  ProjectSummary,
  SessionRuntimeState,
  SessionSummary,
  StoredEvent,
  VoiceConfigView,
  VoiceProviderId,
  VoiceTestResult,
  VoiceTranscribeResult,
  WorkspaceConfigView,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly payload?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('X-Requested-With', 'claude-web');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers,
    });
  } catch {
    throw new ApiError(0, '网络连接失败，请检查服务是否在线');
  }
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `请求失败（HTTP ${response.status}）`;
    if (response.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent('cw:unauthorized'));
    }
    throw new ApiError(response.status, message, payload);
  }
  return payload as T;
}

import type { ThemeMode } from './store';

export interface AuthStatus {
  setupRequired: boolean;
  username: string;
  defaultTheme: ThemeMode;
}

export interface EventsResponse {
  events: StoredEvent[];
  state: SessionRuntimeState;
  lastSeq: number;
  firstSeq: number;
  hasMore: boolean;
}

export const api = {
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  preferences: () => request<{ theme: ThemeMode }>('/api/preferences'),
  updatePreferences: (theme: ThemeMode) =>
    request<{ theme: ThemeMode }>('/api/preferences', {
      method: 'PUT',
      body: JSON.stringify({ theme }),
    }),
  setup: (username: string, password: string) =>
    request<{ user: { username: string } }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    request<{ user: { username: string } }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<{ user: { username: string } }>('/api/auth/me'),
  changePassword: (current: string, next: string) =>
    request<{ ok: boolean }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current, next }),
    }),

  config: () => request<AppConfig>('/api/config'),
  sessions: (limit = 200) =>
    request<{ sessions: SessionSummary[] }>(`/api/sessions?limit=${limit}`),
  projects: () => request<{ projects: ProjectSummary[] }>('/api/projects/recent'),
  listDirs: (target?: string) =>
    request<DirListing>(`/api/fs/list${target ? `?path=${encodeURIComponent(target)}` : ''}`),
  searchFiles: (cwd: string, q: string, limit = 50) =>
    request<{ files: string[]; truncated: boolean }>(
      `/api/fs/search?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  mkdir: (parent: string, name: string) =>
    request<{ path: string }>('/api/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ parent, name }),
    }),
  workspaces: () => request<WorkspaceConfigView>('/api/workspaces'),
  updateWorkspaces: (payload: { defaultRoot?: string; extraRoots?: string[] }) =>
    request<WorkspaceConfigView>('/api/workspaces', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  createSession: (payload: {
    cwd: string;
    permissionMode?: PermissionMode;
    model?: string;
  }) =>
    request<SessionRuntimeState>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  resumeSession: (id: string) =>
    request<SessionRuntimeState>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ resume: id }),
    }),
  session: (id: string) => request<SessionRuntimeState>(`/api/sessions/${encodeURIComponent(id)}`),
  events: (
    id: string,
    after = 0,
    options?: { before?: number; limit?: number; tail?: boolean },
  ) => {
    const params = new URLSearchParams({ after: String(after) });
    if (options?.before !== undefined) params.set('before', String(options.before));
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.tail) params.set('tail', '1');
    return request<EventsResponse>(
      `/api/sessions/${encodeURIComponent(id)}/events?${params.toString()}`,
    );
  },
  stopSession: (id: string) =>
    request<SessionRuntimeState>(`/api/sessions/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    }),
  interrupt: (id: string) =>
    request<{ ok: boolean; stopped: boolean }>(
      `/api/sessions/${encodeURIComponent(id)}/interrupt`,
      { method: 'POST' },
    ),
  uploadAttachment: (
    id: string,
    payload: { name: string; mimeType: string; dataBase64: string },
  ) =>
    request<{ attachment: AttachmentRef }>(
      `/api/sessions/${encodeURIComponent(id)}/attachments`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  sendMessage: (id: string, text: string, attachments: string[] = []) =>
    request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, attachments }),
    }),
  respondPermission: (
    id: string,
    requestId: string,
    decision: PermissionDecision,
    updatedInput?: Record<string, unknown>,
  ) =>
    request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/permission`, {
      method: 'POST',
      body: JSON.stringify({ requestId, decision, updatedInput }),
    }),
  setMode: (id: string, mode: PermissionMode) =>
    request<SessionRuntimeState>(`/api/sessions/${encodeURIComponent(id)}/mode`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  setModel: (id: string, model: string) =>
    request<SessionRuntimeState>(`/api/sessions/${encodeURIComponent(id)}/model`, {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),

  voiceConfig: () => request<VoiceConfigView>('/api/voice/config'),
  updateVoiceConfig: (payload: {
    active?: VoiceProviderId;
    providers?: Record<string, Record<string, unknown>>;
  }) =>
    request<VoiceConfigView>('/api/voice/config', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  testVoice: (provider: VoiceProviderId) =>
    request<VoiceTestResult>('/api/voice/test', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    }),
  testVoiceLive: (provider: VoiceProviderId) =>
    request<VoiceTestResult>('/api/voice/live-test', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    }),
  transcribeVoice: (payload: {
    provider?: VoiceProviderId;
    audioBase64: string;
    mimeType: string;
    language?: string;
  }) =>
    request<VoiceTranscribeResult>('/api/voice/transcribe', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

export function attachmentUrl(sessionId: string, attachmentId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

export function websocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}
