import { reactive, ref } from 'vue';
import { ApiError, api } from './api';
import type { AppConfig, SessionSummary, UpdateStatusView } from './types';

export const authState = reactive<{
  user: { username: string } | null;
  checked: boolean;
}>({ user: null, checked: false });

export async function ensureAuth(force = false): Promise<boolean> {
  if (authState.checked && !force) return !!authState.user;
  try {
    const result = await api.me();
    authState.user = result.user;
  } catch (error) {
    if (error instanceof ApiError && error.status !== 401) throw error;
    authState.user = null;
  } finally {
    authState.checked = true;
  }
  return !!authState.user;
}

export const appConfig = ref<AppConfig | null>(null);

export async function loadConfig(force = false): Promise<AppConfig | null> {
  if (appConfig.value && !force) return appConfig.value;
  try {
    appConfig.value = await api.config();
    if (appConfig.value?.defaultTheme) initTheme(appConfig.value.defaultTheme);
  } catch {
    appConfig.value = null;
  }
  return appConfig.value;
}

export const sessions = ref<SessionSummary[]>([]);
export const sessionsLoading = ref(false);

export const updateStatus = ref<UpdateStatusView | null>(null);

export async function refreshUpdateStatus(force = false): Promise<UpdateStatusView | null> {
  if (updateStatus.value && !force) return updateStatus.value;
  try {
    updateStatus.value = await api.updateStatus();
  } catch {
    // The update card shows its own error when the user opens Settings.
  }
  return updateStatus.value;
}

export async function refreshSessions(): Promise<void> {
  if (sessionsLoading.value) return;
  sessionsLoading.value = true;
  try {
    const result = await api.sessions(200);
    sessions.value = result.sessions;
  } catch {
    // keep the previous list; the connection banner covers offline states
  } finally {
    sessionsLoading.value = false;
  }
}

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
}

export const toasts = reactive<Toast[]>([]);
let toastId = 0;

export function toast(text: string, kind: ToastKind = 'info', ms = 3200): void {
  const id = ++toastId;
  toasts.push({ id, text, kind });
  window.setTimeout(() => {
    const index = toasts.findIndex((item) => item.id === id);
    if (index >= 0) toasts.splice(index, 1);
  }, ms);
}

export type Theme = 'dark' | 'light';
export type ThemeMode = 'system' | 'dark' | 'light';

export const serverTheme = ref<ThemeMode>('system');
export const theme = ref<Theme>('dark');

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function resolveTheme(mode: ThemeMode): Theme {
  return mode === 'system' ? systemTheme() : mode;
}

export function applyTheme(): void {
  document.documentElement.dataset.theme = theme.value;
  document.documentElement.style.colorScheme = theme.value;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.value === 'dark' ? '#0a0f1a' : '#f7f8fa');
}

/**
 * The server's default appearance applies to browsers that have not made a
 * local choice. A local choice is stored in localStorage and survives reloads.
 */
export function initTheme(mode?: ThemeMode): void {
  if (mode) serverTheme.value = mode;
  const saved = localStorage.getItem('cw.theme');
  if (saved === 'dark' || saved === 'light') theme.value = saved;
  else theme.value = resolveTheme(serverTheme.value);
  applyTheme();
}

export function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  localStorage.setItem('cw.theme', theme.value);
  applyTheme();
}

/** Apply a saved server-wide default and clear this browser's override. */
export function setServerTheme(mode: ThemeMode): void {
  serverTheme.value = mode;
  localStorage.removeItem('cw.theme');
  theme.value = resolveTheme(mode);
  applyTheme();
}
