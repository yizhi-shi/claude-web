<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, api, websocketUrl } from '../api';
import AppShell from '../components/AppShell.vue';
import Icon from '../components/Icon.vue';
import MessageItem from '../components/MessageItem.vue';
import PermissionPanel from '../components/PermissionPanel.vue';
import PlanPanel from '../components/PlanPanel.vue';
import QuestionPanel from '../components/QuestionPanel.vue';
import VoiceControl from '../components/VoiceControl.vue';
import { buildChatItems } from '../chatModel';
import { appConfig, loadConfig, refreshSessions, toast } from '../store';
import type {
  AttachmentRef,
  PendingPermissionView,
  PendingPlanView,
  PendingQuestionView,
  PermissionMode,
  SessionRuntimeState,
  StoredEvent,
} from '../types';
import {
  basename,
  formatCost,
  formatDuration,
  formatTokens,
  prettyPath,
  renderMarkdown,
  statusLabel,
  statusTone,
} from '../utils';

const route = useRoute();
const router = useRouter();

const sessionId = computed(() => String(route.params.id ?? ''));
const events = ref<StoredEvent[]>([]);
const state = ref<SessionRuntimeState | null>(null);
const lastSeq = ref(0);
const firstSeq = ref(0);
const hasMoreEarlier = ref(false);
const loadingEarlier = ref(false);
const loading = ref(true);
const error = ref('');
const connected = ref(false);
const reconnecting = ref(false);
const sending = ref(false);
const permissionBusy = ref(false);
const pending = ref<PendingPermissionView | null>(null);
const resolvedRequests = new Set<string>();
const pendingQuestion = ref<PendingQuestionView | null>(null);
const pendingPlan = ref<PendingPlanView | null>(null);
const questionBusy = ref(false);
const planBusy = ref(false);
const resolvedQuestions = new Set<string>();
const resolvedPlans = new Set<string>();
const draft = ref('');
const messagesEl = ref<HTMLDivElement | null>(null);
const threadEl = ref<HTMLDivElement | null>(null);
let threadObserver: ResizeObserver | null = null;
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const stickToBottom = ref(true);
const now = ref(Date.now());
const settingsOpen = ref(false);
const settingsModel = ref('');
const modeBusy = ref(false);
const modelBusy = ref(false);
type SettingsTab = 'model' | 'permission' | 'info';
const settingsTab = ref<SettingsTab>('model');
const contextRefreshing = ref(false);
const helpOpen = ref(false);
const stopping = ref(false);
const stopSlow = ref(false);
let stopSlowTimer: number | undefined;

interface DraftAttachment extends AttachmentRef {
  uploading?: boolean;
  previewUrl?: string;
}

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const attachments = ref<DraftAttachment[]>([]);
const uploadingCount = ref(0);
const fileInputRef = ref<HTMLInputElement | null>(null);
const dragActive = ref(false);
let dragDepth = 0;

interface SideExchange {
  requestId: string;
  question: string;
  answer: string;
  thinking: string;
  status: 'running' | 'done' | 'error' | 'canceled';
  error?: string;
  costUsd?: number;
  durationMs?: number;
}

const sideOpen = ref(false);
const sideDraft = ref('');
const sideBusy = ref(false);
const sideExchanges = ref<SideExchange[]>([]);
const sideListRef = ref<HTMLDivElement | null>(null);
const sideInputRef = ref<HTMLTextAreaElement | null>(null);
const sidePanelRef = ref<HTMLElement | null>(null);
const sideHeight = ref<number | null>(null);
const sideResizing = ref(false);
const SIDE_HEIGHT_KEY = 'cw.side.height';
const SIDE_HEIGHT_MIN = 220;
let sideDrag: {
  startY: number;
  startHeight: number;
  handle: HTMLElement;
  pointerId: number;
} | null = null;

function sideHeightMax(): number {
  if (typeof window === 'undefined') return 720;
  return Math.max(SIDE_HEIGHT_MIN, Math.min(Math.round(window.innerHeight * 0.82), window.innerHeight - 160));
}

function clampSideHeight(value: number): number {
  return Math.min(sideHeightMax(), Math.max(SIDE_HEIGHT_MIN, Math.round(value)));
}

function readSideHeight(): number | null {
  try {
    const raw = Number(window.localStorage.getItem(SIDE_HEIGHT_KEY));
    return Number.isFinite(raw) && raw > 0 ? clampSideHeight(raw) : null;
  } catch {
    return null;
  }
}

function persistSideHeight(): void {
  try {
    if (sideHeight.value === null) window.localStorage.removeItem(SIDE_HEIGHT_KEY);
    else window.localStorage.setItem(SIDE_HEIGHT_KEY, String(Math.round(sideHeight.value)));
  } catch {
    // localStorage can be unavailable in private mode
  }
}

function onSideResizeMove(event: PointerEvent): void {
  if (!sideDrag) return;
  sideHeight.value = clampSideHeight(
    sideDrag.startHeight + sideDrag.startY - event.clientY,
  );
}

function finishSideResize(): void {
  if (!sideDrag) return;
  const { handle, pointerId } = sideDrag;
  try {
    if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
  } catch {
    // pointer capture may already be gone
  }
  sideDrag = null;
  sideResizing.value = false;
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  window.removeEventListener('pointermove', onSideResizeMove);
  window.removeEventListener('pointerup', finishSideResize);
  window.removeEventListener('pointercancel', finishSideResize);
  persistSideHeight();
}

function startSideResize(event: PointerEvent): void {
  if (event.button !== 0 || !sidePanelRef.value) return;
  const panel = sidePanelRef.value;
  const handle = event.currentTarget as HTMLElement;
  event.preventDefault();
  sideDrag = {
    startY: event.clientY,
    startHeight: panel.getBoundingClientRect().height,
    handle,
    pointerId: event.pointerId,
  };
  sideResizing.value = true;
  sideHeight.value = clampSideHeight(sideDrag.startHeight);
  try {
    handle.setPointerCapture?.(event.pointerId);
  } catch {
    // ignore
  }
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'ns-resize';
  window.addEventListener('pointermove', onSideResizeMove);
  window.addEventListener('pointerup', finishSideResize);
  window.addEventListener('pointercancel', finishSideResize);
}

function onSideResizeKey(event: KeyboardEvent): void {
  const step = event.shiftKey ? 48 : 24;
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    sideHeight.value = clampSideHeight((sideHeight.value ?? sidePanelRef.value?.getBoundingClientRect().height ?? 320) + step);
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    sideHeight.value = clampSideHeight((sideHeight.value ?? sidePanelRef.value?.getBoundingClientRect().height ?? 320) - step);
  } else if (event.key === 'Home') {
    event.preventDefault();
    sideHeight.value = sideHeightMax();
  } else if (event.key === 'End') {
    event.preventDefault();
    sideHeight.value = SIDE_HEIGHT_MIN;
  } else {
    return;
  }
  persistSideHeight();
}

function resetSideHeight(): void {
  sideHeight.value = null;
  persistSideHeight();
}

const sidePanelStyle = computed(() =>
  sideHeight.value === null ? undefined : { height: `${sideHeight.value}px` },
);

function onSideWindowResize(): void {
  if (sideHeight.value !== null) {
    sideHeight.value = clampSideHeight(sideHeight.value);
  }
}

function clearStopTimers(): void {
  if (stopSlowTimer) {
    window.clearTimeout(stopSlowTimer);
    stopSlowTimer = undefined;
  }
}

function clearStopState(): void {
  clearStopTimers();
  stopping.value = false;
  stopSlow.value = false;
}

function markStopping(): void {
  clearStopTimers();
  stopping.value = true;
  stopSlow.value = false;
  stopSlowTimer = window.setTimeout(() => {
    stopSlow.value = true;
  }, 2_500);
  // The server may keep the turn alive until a long-running tool exits; the
  // run strip exposes a force-stop button after 2.5s.
}

const menuType = ref<'none' | 'slash' | 'file'>('none');
const menuQuery = ref('');
const menuIndex = ref(0);
const tokenStart = ref(0);
const fileSuggestions = ref<string[]>([]);
const menuLoading = ref(false);

interface WebCommandInfo {
  name: string;
  usage: string;
  description: string;
}

/** Commands handled by the Web UI instead of being sent to the CLI. */
const webCommands: WebCommandInfo[] = [
  { name: 'model', usage: '/model [name]', description: '打开模型选择，或直接切换模型' },
  { name: 'context', usage: '/context', description: '打开上下文用量面板' },
  { name: 'usage', usage: '/usage', description: '查看会话用量、费用与上下文' },
  { name: 'status', usage: '/status', description: '查看会话状态与运行信息' },
  { name: 'permissions', usage: '/permissions', description: '切换权限模式' },
  { name: 'config', usage: '/config', description: '打开 Web 会话设置' },
  { name: 'help', usage: '/help', description: '查看 Web 命令帮助' },
];
const webCommandNames = new Set(webCommands.map((command) => command.name));
const modelPresets = [
  { value: 'default', label: '默认', hint: 'CLI 默认模型' },
  { value: 'best', label: 'Best', hint: '最佳可用模型' },
  { value: 'sonnet', label: 'Sonnet', hint: 'sonnet' },
  { value: 'opus', label: 'Opus', hint: 'opus' },
  { value: 'haiku', label: 'Haiku', hint: 'haiku' },
  { value: 'fable', label: 'Fable', hint: 'fable' },
  { value: 'sonnet[1m]', label: 'Sonnet 1M', hint: '1M 上下文' },
  { value: 'opus[1m]', label: 'Opus 1M', hint: '1M 上下文' },
  { value: 'fable[1m]', label: 'Fable 1M', hint: '1M 上下文' },
  { value: 'opusplan', label: 'Opus Plan', hint: '规划模式' },
];
const settingsTabs: Array<{ value: SettingsTab; label: string }> = [
  { value: 'model', label: '模型' },
  { value: 'permission', label: '权限' },
  { value: 'info', label: '状态' },
];

const builtinCommands: Array<{ name: string; description: string }> = [
  { name: 'btw', description: '旁问：基于当前上下文提问，不打断主对话' },
  { name: 'clear', description: '清空当前上下文，开始新对话' },
  { name: 'compact', description: '压缩上下文，保留摘要' },
  { name: 'context', description: '查看上下文用量（Web 面板）' },
  { name: 'usage', description: '查看会话用量与费用（Web 面板）' },
  { name: 'model', description: '切换模型（Web 面板）' },
  { name: 'permissions', description: '切换权限模式（Web 面板）' },
  { name: 'status', description: '查看会话状态（Web 面板）' },
  { name: 'config', description: '打开会话设置（Web 面板）' },
  { name: 'help', description: '查看 Web 命令帮助' },
  { name: 'init', description: '为项目生成 CLAUDE.md' },
  { name: 'review', description: '审查当前改动' },
];

interface MenuItem {
  id: string;
  label: string;
  description: string;
  insert: string;
  kind: 'command' | 'skill' | 'file';
}

const items = computed(() => buildChatItems(events.value));
const title = computed(() => state.value?.title || '新会话');
const status = computed(() => state.value?.status ?? 'idle');
const running = computed(() => status.value === 'running' || status.value === 'waiting_permission');
const modeLabel = computed(
  () =>
    appConfig.value?.permissionModes.find((mode) => mode.value === state.value?.permissionMode)?.label ??
    state.value?.permissionMode ??
    '',
);
const contextPercent = computed(() =>
  Math.round(state.value?.contextUsage?.percentage ?? 0),
);
const contextTitle = computed(() => {
  const usage = state.value?.contextUsage;
  if (!usage) return '';
  return `上下文 ${formatTokens(usage.totalTokens)} / ${formatTokens(usage.maxTokens)}`;
});
const elapsedText = computed(() => {
  const started = state.value?.turnStartedAt;
  if (!started) return '';
  return formatDuration(now.value - started);
});
const activeTasks = computed(
  () => state.value?.tasks.filter((task) => task.status === 'running' || task.status === 'pending') ?? [],
);
const activeToolList = computed(() => state.value?.activeTools ?? []);
const runtimeLabel = computed(() => {
  if (pendingQuestion.value) return '等待你的回答';
  if (pendingPlan.value) return '计划待确认';
  if (state.value?.statusDetail) return state.value.statusDetail;
  if (activeToolList.value.length > 0) {
    const names = activeToolList.value.map((tool) => tool.name).slice(0, 3);
    return `正在执行 ${names.join('、')}${activeToolList.value.length > 3 ? ' 等' : ''}`;
  }
  if (state.value?.currentTool) return `正在执行 ${state.value.currentTool.name}`;
  if (status.value === 'waiting_permission') return '等待你的批准';
  return 'Claude 正在处理';
});
const examples = ['总结这个项目的结构', '运行测试并修复失败项', '解释最近一次 git 提交'];

watch(status, (value) => {
  if (value !== 'running' && value !== 'waiting_permission') clearStopState();
});

const slashCommands = computed(() => {
  const skills = new Set((state.value?.skills ?? []).map((item) => item.replace(/^\//, '')));
  const builtinMap = new Map(builtinCommands.map((item) => [item.name, item.description]));
  const seen = new Set<string>();
  const out: Array<{ name: string; description: string; kind: 'command' | 'skill' }> = [];

  for (const command of builtinCommands) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    out.push({ name: command.name, description: command.description, kind: 'command' });
  }

  for (const detail of state.value?.commandDetails ?? []) {
    const name = detail.name.replace(/^\//, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description:
        (detail.description ?? '').replace(/\s*\((user|project|plugin)\)\s*$/, '') ||
        builtinMap.get(name) ||
        '命令',
      kind: skills.has(name) ? 'skill' : 'command',
    });
  }

  const fromState = (state.value?.slashCommands ?? []).map((item) => item.replace(/^\//, ''));
  for (const name of [...fromState, ...skills]) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: builtinMap.get(name) ?? (skills.has(name) ? '技能' : '命令'),
      kind: skills.has(name) ? 'skill' : 'command',
    });
  }

  return out;
});

const menuItems = computed<MenuItem[]>(() => {
  if (menuType.value === 'slash') {
    const query = menuQuery.value.toLowerCase();
    return slashCommands.value
      .filter((item) => item.name.toLowerCase().includes(query))
      .slice(0, 14)
      .map((item) => ({
        id: `${item.kind}:${item.name}`,
        label: `/${item.name}`,
        description: item.description,
        insert: `/${item.name} `,
        kind: item.kind,
      }));
  }
  if (menuType.value === 'file') {
    return fileSuggestions.value.map((file) => {
      const index = file.lastIndexOf('/');
      return {
        id: `file:${file}`,
        label: basename(file),
        description: index > 0 ? file.slice(0, index) : '.',
        insert: `@${file} `,
        kind: 'file' as const,
      };
    });
  }
  return [];
});

let ws: WebSocket | null = null;
let reconnectTimer: number | undefined;
let heartbeatTimer: number | undefined;
let reconnectAttempt = 0;
let mounted = true;
let fileTimer: number | undefined;
let fileSeq = 0;
let clockTimer: number | undefined;

function cleanupSocket(): void {
  if (heartbeatTimer) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  if (ws) {
    const socket = ws;
    ws = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // ignore
    }
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer) window.clearInterval(heartbeatTimer);
  heartbeatTimer = window.setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 25_000);
}

function scheduleReconnect(): void {
  if (!mounted) return;
  reconnecting.value = true;
  const delay = Math.min(6000, 800 * 1.7 ** reconnectAttempt);
  reconnectAttempt += 1;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => void connect(), delay);
}

async function connect(): Promise<void> {
  if (!mounted || !sessionId.value) return;
  cleanupSocket();
  const socket = new WebSocket(websocketUrl());
  ws = socket;
  socket.onopen = () => {
    connected.value = true;
    reconnecting.value = false;
    reconnectAttempt = 0;
    startHeartbeat();
    socket.send(
      JSON.stringify({ type: 'attach', sessionId: sessionId.value, lastSeq: lastSeq.value }),
    );
  };
  socket.onmessage = (event) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    handleSocketMessage(message);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    connected.value = false;
    markSideDisconnected();
    cleanupSocket();
    scheduleReconnect();
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      // ignore
    }
  };
}

function handleSocketMessage(message: Record<string, unknown>): void {
  const type = message.type;
  if (type === 'snapshot') {
    if (message.state) state.value = message.state as SessionRuntimeState;
    const incoming = (message.events as StoredEvent[] | undefined) ?? [];
    for (const event of incoming) pushEvent(event);
    derivePending();
    void refreshSessions();
    scrollToBottom();
    return;
  }
  if (type === 'state') {
    if (message.state) state.value = message.state as SessionRuntimeState;
    derivePending();
    return;
  }
  if (type === 'event') {
    if (message.event) pushEvent(message.event as StoredEvent);
    return;
  }
  if (type === 'side.delta') {
    const exchange = sideExchanges.value.find(
      (item) => item.requestId === String(message.requestId ?? ''),
    );
    if (exchange && exchange.status === 'running') {
      const text = String(message.text ?? '');
      if (message.kind === 'thinking') exchange.thinking += text;
      else exchange.answer += text;
      if (sideOpen.value) void nextTick(scrollSideToBottom);
    }
    return;
  }
  if (type === 'side.done') {
    const exchange = sideExchanges.value.find(
      (item) => item.requestId === String(message.requestId ?? ''),
    );
    if (exchange) {
      exchange.status = 'done';
      if (typeof message.answer === 'string' && message.answer) {
        exchange.answer = message.answer;
      }
      if (typeof message.costUsd === 'number') exchange.costUsd = message.costUsd;
      if (typeof message.durationMs === 'number') exchange.durationMs = message.durationMs;
    }
    sideBusy.value = false;
    void nextTick(scrollSideToBottom);
    return;
  }
  if (type === 'side.error') {
    const exchange = sideExchanges.value.find(
      (item) => item.requestId === String(message.requestId ?? ''),
    );
    const text = String(message.message ?? '旁问失败');
    if (exchange) {
      exchange.status = text === '旁问已取消' ? 'canceled' : 'error';
      exchange.error = text;
    } else {
      toast(text, 'error');
    }
    sideBusy.value = false;
    return;
  }
  if (type === 'side.started') return;
  if (type === 'error') {
    const text = String(message.message ?? '连接出错');
    toast(text, 'error');
    if (text.includes('不存在')) error.value = text;
    return;
  }
}

function pushEvent(event: StoredEvent): void {
  if (!event || typeof event.seq !== 'number' || event.seq <= lastSeq.value) return;
  events.value.push(event);
  lastSeq.value = event.seq;
  applySideEffects(event);
  if (stickToBottom.value) scrollToBottom();
}

function applySideEffects(event: StoredEvent): void {
  const current = state.value;
  if (!current) return;
  if (event.type === 'session.init') {
    current.model = event.model ?? current.model;
    current.cwd = event.cwd || current.cwd;
    current.claudeSessionId = event.sessionId;
    current.claudeVersion = event.claudeVersion ?? current.claudeVersion;
    current.permissionMode = (event.permissionMode as PermissionMode) ?? current.permissionMode;
    current.slashCommands = event.slashCommands ?? current.slashCommands;
    current.skills = event.skills ?? current.skills;
    current.tools = event.tools ?? current.tools;
    return;
  }
  if (event.type === 'session.status') {
    current.status = event.status;
    current.statusDetail = event.detail;
    if (event.status === 'idle' || event.status === 'stopped') void refreshSessions();
    return;
  }
  if (event.type === 'session.meta') {
    // `model: undefined` is meaningful: it restores the CLI default.
    current.model = event.model;
    current.permissionMode = event.permissionMode ?? current.permissionMode;
    current.costUsd = event.costUsd ?? current.costUsd;
    return;
  }
  if (event.type === 'permission.request') {
    resolvedRequests.delete(event.requestId);
    pending.value = event as unknown as PendingPermissionView;
    return;
  }
  if (event.type === 'permission.resolved') {
    resolvedRequests.add(event.requestId);
    if (pending.value?.requestId === event.requestId) pending.value = null;
    if (event.decision === 'timeout') toast('审批超时，已自动拒绝', 'error');
    return;
  }
  if (event.type === 'question.request') {
    resolvedQuestions.delete(event.requestId);
    pendingQuestion.value = event as unknown as PendingQuestionView;
    return;
  }
  if (event.type === 'question.resolved') {
    resolvedQuestions.add(event.requestId);
    if (pendingQuestion.value?.requestId === event.requestId) pendingQuestion.value = null;
    if (event.timedOut) toast('问答超时，已让 Claude 自行判断', 'info');
    return;
  }
  if (event.type === 'plan.request') {
    resolvedPlans.delete(event.requestId);
    pendingPlan.value = event as unknown as PendingPlanView;
    return;
  }
  if (event.type === 'plan.resolved') {
    resolvedPlans.add(event.requestId);
    if (pendingPlan.value?.requestId === event.requestId) pendingPlan.value = null;
    if (event.timedOut) toast('计划确认超时，已按拒绝处理', 'info');
    return;
  }
  if (event.type === 'turn.result') {
    current.status = 'idle';
    current.statusDetail = undefined;
    current.turnStartedAt = undefined;
    current.costUsd = event.costUsd ?? current.costUsd;
    void refreshSessions();
    return;
  }
  if (event.type === 'notice' && event.level === 'error') {
    toast(event.text, 'error');
  }
}

function derivePending(): void {
  const map = new Map<string, PendingPermissionView>();
  for (const event of events.value) {
    if (event.type === 'permission.request') {
      if (!resolvedRequests.has(event.requestId)) {
        map.set(event.requestId, event as unknown as PendingPermissionView);
      }
    } else if (event.type === 'permission.resolved') {
      resolvedRequests.add(event.requestId);
      map.delete(event.requestId);
    }
  }
  const fromState = state.value?.pendingPermissions ?? [];
  const candidate = fromState.find((item) => !resolvedRequests.has(item.requestId));
  pending.value = candidate ?? [...map.values()].at(-1) ?? null;

  const questions = new Map<string, PendingQuestionView>();
  const plans = new Map<string, PendingPlanView>();
  for (const event of events.value) {
    if (event.type === 'question.request') {
      if (!resolvedQuestions.has(event.requestId)) {
        questions.set(event.requestId, event as unknown as PendingQuestionView);
      }
    } else if (event.type === 'question.resolved') {
      resolvedQuestions.add(event.requestId);
      questions.delete(event.requestId);
    } else if (event.type === 'plan.request') {
      if (!resolvedPlans.has(event.requestId)) {
        plans.set(event.requestId, event as unknown as PendingPlanView);
      }
    } else if (event.type === 'plan.resolved') {
      resolvedPlans.add(event.requestId);
      plans.delete(event.requestId);
    }
  }
  const stateQuestion = (state.value?.pendingQuestions ?? []).find(
    (item) => !resolvedQuestions.has(item.requestId),
  );
  pendingQuestion.value = stateQuestion ?? [...questions.values()].at(-1) ?? null;
  const statePlan = state.value?.pendingPlan;
  pendingPlan.value =
    statePlan && !resolvedPlans.has(statePlan.requestId)
      ? statePlan
      : [...plans.values()].at(-1) ?? null;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  events.value = [];
  state.value = null;
  lastSeq.value = 0;
  firstSeq.value = 0;
  hasMoreEarlier.value = false;
  pending.value = null;
  pendingQuestion.value = null;
  pendingPlan.value = null;
  resolvedRequests.clear();
  resolvedQuestions.clear();
  resolvedPlans.clear();
  stickToBottom.value = true;
  await loadConfig();
  try {
    const result = await api.events(sessionId.value, 0, {
      limit: 240,
      tail: true,
      compact: true,
    });
    events.value = result.events;
    // History omits token deltas. Attach from the last renderable event so the
    // WS replay rebuilds any in-flight partial assistant text.
    lastSeq.value = result.events.length > 0 ? result.events[result.events.length - 1].seq : 0;
    firstSeq.value = result.firstSeq;
    hasMoreEarlier.value = result.hasMore;
    state.value = result.state;
    derivePending();
    settingsModel.value = result.state.model ?? '';
    await nextTick();
    scrollToBottom(true);
    await connect();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '无法载入会话';
  } finally {
    loading.value = false;
  }
}

async function loadEarlier(): Promise<void> {
  if (loadingEarlier.value || !hasMoreEarlier.value) return;
  loadingEarlier.value = true;
  const container = messagesEl.value;
  const previousHeight = container?.scrollHeight ?? 0;
  try {
    const result = await api.events(sessionId.value, 0, {
      before: firstSeq.value,
      limit: 200,
      tail: true,
      compact: true,
    });
    const existing = new Set(events.value.map((event) => event.seq));
    const incoming = result.events.filter((event) => !existing.has(event.seq));
    events.value = [...incoming, ...events.value];
    firstSeq.value = result.firstSeq;
    hasMoreEarlier.value = result.hasMore;
    await nextTick();
    if (container) container.scrollTop += container.scrollHeight - previousHeight;
  } catch (err) {
    toast(err instanceof ApiError ? err.message : '加载历史失败', 'error');
  } finally {
    loadingEarlier.value = false;
  }
}

async function reload(): Promise<void> {
  cleanupSocket();
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnecting.value = false;
  connected.value = false;
  await load();
}

function scrollToBottom(force = false): void {
  void nextTick(() => {
    const el = messagesEl.value;
    if (!el) return;
    if (force || stickToBottom.value) el.scrollTop = el.scrollHeight;
  });
}

function onScroll(): void {
  const el = messagesEl.value;
  if (!el) return;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  if (
    el.scrollTop < 80 &&
    el.scrollHeight > el.clientHeight + 200 &&
    hasMoreEarlier.value &&
    !loadingEarlier.value
  ) {
    void loadEarlier();
  }
}

function resizeComposer(): void {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(220, Math.max(44, el.scrollHeight))}px`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

async function addFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  const room = MAX_ATTACHMENTS - attachments.value.length;
  if (room <= 0) {
    toast(`单条消息最多 ${MAX_ATTACHMENTS} 个附件`, 'error');
    return;
  }
  if (files.length > room) {
    toast(`单条消息最多 ${MAX_ATTACHMENTS} 个附件，已忽略多余文件`, 'info');
  }

  for (const file of files.slice(0, room)) {
    if (file.size === 0) {
      toast(`${file.name || '文件'} 是空文件，已跳过`, 'error');
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast(`${file.name || '文件'} 超过 10 MB，已跳过`, 'error');
      continue;
    }

    const isImage = IMAGE_TYPES.has(file.type);
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
    const displayName = file.name || (isImage ? '粘贴的图片' : '粘贴的文件');
    attachments.value.push({
      id: tempId,
      name: displayName,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      kind: isImage ? 'image' : 'file',
      uploading: true,
      previewUrl,
    });
    uploadingCount.value += 1;
    try {
      const dataBase64 = await fileToBase64(file);
      const { attachment } = await api.uploadAttachment(sessionId.value, {
        name: displayName,
        mimeType: file.type || 'application/octet-stream',
        dataBase64,
      });
      const index = attachments.value.findIndex((item) => item.id === tempId);
      if (index >= 0) {
        attachments.value[index] = { ...attachment, previewUrl };
      } else if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    } catch (err) {
      const index = attachments.value.findIndex((item) => item.id === tempId);
      if (index >= 0) attachments.value.splice(index, 1);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      toast(err instanceof ApiError ? err.message : `${displayName} 上传失败`, 'error');
    } finally {
      uploadingCount.value = Math.max(0, uploadingCount.value - 1);
    }
  }
}

function pickFiles(): void {
  fileInputRef.value?.click();
}

function onFilePicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  void addFiles(files);
}

function onPaste(event: ClipboardEvent): void {
  const items = event.clipboardData?.items;
  if (!items) return;
  const files: File[] = [];
  let hasText = false;
  for (const item of Array.from(items)) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    } else if (item.kind === 'string' && item.type === 'text/plain') {
      hasText = true;
    }
  }
  if (files.length === 0) return;
  // Keep the normal text paste when the clipboard carries both text and files.
  if (!hasText) event.preventDefault();
  void addFiles(files);
}

function hasDraggedFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function onDragEnter(event: DragEvent): void {
  if (!hasDraggedFiles(event)) return;
  dragDepth += 1;
  dragActive.value = true;
}

function onDragOver(event: DragEvent): void {
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
}

function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragActive.value = false;
}

function onDrop(event: DragEvent): void {
  dragDepth = 0;
  dragActive.value = false;
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length > 0) void addFiles(files);
}

function removeAttachment(id: string): void {
  const index = attachments.value.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [removed] = attachments.value.splice(index, 1);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
}

function clearAttachments(): void {
  for (const attachment of attachments.value) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
  attachments.value = [];
}

function scrollSideToBottom(): void {
  const el = sideListRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function toggleSide(): void {
  sideOpen.value = !sideOpen.value;
  if (sideOpen.value) {
    void nextTick(() => {
      sideInputRef.value?.focus();
      scrollSideToBottom();
    });
  }
}

function askSide(): void {
  const text = sideDraft.value.trim().replace(/^\/btw(?:\s+|$)/, '').trim();
  if (!text || sideBusy.value) return;
  if (ws?.readyState !== WebSocket.OPEN) {
    toast('连接已断开，暂时无法旁问', 'error');
    return;
  }
  const requestId = `side-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  sideExchanges.value.push({
    requestId,
    question: text,
    answer: '',
    thinking: '',
    status: 'running',
  });
  sideBusy.value = true;
  sideDraft.value = '';
  sideOpen.value = true;
  ws.send(JSON.stringify({ type: 'side.question', requestId, text }));
  void nextTick(scrollSideToBottom);
}

function cancelSide(): void {
  const current = sideExchanges.value.find((item) => item.status === 'running');
  if (!current) return;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'side.cancel', requestId: current.requestId }));
  }
}

function onSideKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    askSide();
  }
}

function markSideDisconnected(): void {
  const current = sideExchanges.value.find((item) => item.status === 'running');
  if (!current) return;
  current.status = 'error';
  current.error = '连接中断，旁问未完成';
  sideBusy.value = false;
}

const canSend = computed(
  () =>
    !sending.value &&
    uploadingCount.value === 0 &&
    (!!draft.value.trim() || attachments.value.length > 0),
);

async function send(): Promise<void> {
  if (!canSend.value) return;
  const text = draft.value.trim();
  const attachmentIds = attachments.value.map((attachment) => attachment.id);

  if (handleWebCommand(text)) return;

  // `/btw` is a Web-side side question, not a CLI command. Route it to the
  // panel instead of sending the literal text into the main conversation.
  if (/^\/btw(?:\s|$)/.test(text)) {
    if (attachmentIds.length > 0) {
      toast('旁问暂不支持附件，请先移除附件', 'error');
      return;
    }
    const question = text.replace(/^\/btw(?:\s+|$)/, '').trim();
    draft.value = '';
    await nextTick();
    resizeComposer();
    sideOpen.value = true;
    sideDraft.value = question;
    if (question) askSide();
    else void nextTick(() => sideInputRef.value?.focus());
    return;
  }

  sending.value = true;
  closeMenu();
  try {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'user.message', text, attachments: attachmentIds }));
    } else {
      await api.sendMessage(sessionId.value, text, attachmentIds);
    }
    draft.value = '';
    clearAttachments();
    await nextTick();
    resizeComposer();
    stickToBottom.value = true;
    scrollToBottom(true);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : '发送失败', 'error');
  } finally {
    sending.value = false;
  }
}

async function interrupt(): Promise<void> {
  if (stopping.value) return;
  markStopping();
  try {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'interrupt' }));
    } else {
      await api.interrupt(sessionId.value);
    }
    // Do not wait for the next state push to give feedback: the SDK may need
    // a moment to unwind a tool, and a silent button feels broken.
    toast('已请求停止当前回合…', 'info', 1800);
  } catch (err) {
    clearStopState();
    toast(err instanceof ApiError ? err.message : '停止失败', 'error');
  }
}

async function forceStop(): Promise<void> {
  if (!window.confirm('强制结束后台进程？聊天记录会保留，下次发送会自动恢复。')) return;
  settingsOpen.value = false;
  try {
    const next = await api.stopSession(sessionId.value);
    state.value = next;
    clearStopState();
    toast('已强制结束后台进程');
    await refreshSessions();
    await reload();
  } catch (err) {
    toast(err instanceof ApiError ? err.message : '强制结束失败', 'error');
  }
}

async function respond(decision: 'allow_once' | 'allow_session' | 'deny'): Promise<void> {
  const request = pending.value;
  if (!request || permissionBusy.value) return;
  permissionBusy.value = true;
  resolvedRequests.add(request.requestId);
  try {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'permission.response',
          requestId: request.requestId,
          decision,
        }),
      );
    } else {
      await api.respondPermission(sessionId.value, request.requestId, decision);
    }
    pending.value = null;
    if (decision === 'deny') toast('已拒绝这次操作');
  } catch (err) {
    resolvedRequests.delete(request.requestId);
    toast(err instanceof ApiError ? err.message : '审批失败', 'error');
  } finally {
    permissionBusy.value = false;
  }
}

async function answerQuestion(answers: Record<string, string>): Promise<void> {
  const request = pendingQuestion.value;
  if (!request || questionBusy.value) return;
  questionBusy.value = true;
  resolvedQuestions.add(request.requestId);
  try {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'question.response',
          requestId: request.requestId,
          answers,
        }),
      );
    } else {
      await api.respondQuestion(sessionId.value, request.requestId, answers);
    }
    pendingQuestion.value = null;
  } catch (err) {
    resolvedQuestions.delete(request.requestId);
    toast(err instanceof ApiError ? err.message : '提交回答失败', 'error');
  } finally {
    questionBusy.value = false;
  }
}

async function skipQuestion(): Promise<void> {
  const request = pendingQuestion.value;
  if (!request || questionBusy.value) return;
  questionBusy.value = true;
  resolvedQuestions.add(request.requestId);
  try {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'question.response', requestId: request.requestId, skipped: true }));
    } else {
      await api.respondQuestion(sessionId.value, request.requestId, undefined, true);
    }
    pendingQuestion.value = null;
  } catch (err) {
    resolvedQuestions.delete(request.requestId);
    toast(err instanceof ApiError ? err.message : '跳过失败', 'error');
  } finally {
    questionBusy.value = false;
  }
}

async function decidePlan(approved: boolean, feedback?: string): Promise<void> {
  const request = pendingPlan.value;
  if (!request || planBusy.value) return;
  planBusy.value = true;
  resolvedPlans.add(request.requestId);
  try {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'plan.response',
          requestId: request.requestId,
          approved,
          feedback,
        }),
      );
    } else {
      await api.respondPlan(sessionId.value, request.requestId, approved, feedback);
    }
    pendingPlan.value = null;
    toast(approved ? '已批准计划，开始执行' : '已退回计划，继续完善');
  } catch (err) {
    resolvedPlans.delete(request.requestId);
    toast(err instanceof ApiError ? err.message : '计划确认失败', 'error');
  } finally {
    planBusy.value = false;
  }
}

async function chooseMode(mode: PermissionMode): Promise<void> {
  if (modeBusy.value) return;
  modeBusy.value = true;
  try {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set.permissionMode', mode }));
    } else {
      await api.setMode(sessionId.value, mode);
    }
    if (state.value) state.value.permissionMode = mode;
    toast('权限模式已更新');
  } catch (err) {
    toast(err instanceof ApiError ? err.message : '切换失败', 'error');
  } finally {
    modeBusy.value = false;
  }
}

function openSessionPanel(tab: SettingsTab = settingsTab.value): void {
  helpOpen.value = false;
  settingsTab.value = tab;
  if (!settingsOpen.value) settingsModel.value = state.value?.model ?? '';
  settingsOpen.value = true;
  if (tab === 'info') void refreshContextNow();
}

function toggleSessionSettings(): void {
  if (settingsOpen.value) settingsOpen.value = false;
  else openSessionPanel(settingsTab.value);
}

function selectSettingsTab(tab: SettingsTab): void {
  settingsTab.value = tab;
  if (tab === 'info') void refreshContextNow();
}

async function refreshContextNow(): Promise<void> {
  if (contextRefreshing.value) return;
  contextRefreshing.value = true;
  try {
    const result = await api.contextUsage(sessionId.value);
    if (result.contextUsage && state.value) {
      state.value.contextUsage = result.contextUsage;
    }
  } catch (err) {
    toast(err instanceof ApiError ? err.message : '读取上下文用量失败', 'error');
  } finally {
    contextRefreshing.value = false;
  }
}

async function applyModel(value: string): Promise<void> {
  if (modelBusy.value) return;
  const model = value === 'default' ? '' : value.trim();
  modelBusy.value = true;
  try {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set.model', model }));
    } else {
      await api.setModel(sessionId.value, model);
    }
    settingsModel.value = model;
    toast(model ? `模型切换请求已发送：${model}` : '已请求恢复默认模型', 'success');
    settingsOpen.value = false;
  } catch (err) {
    toast(err instanceof ApiError ? err.message : '切换模型失败', 'error');
  } finally {
    modelBusy.value = false;
  }
}

async function saveModel(): Promise<void> {
  await applyModel(settingsModel.value);
}

function categoryWidth(tokens: number | undefined): string {
  // Categories include free space/autocompact buffer, so the bar is relative
  // to the context window, not to currently-used tokens.
  const max = state.value?.contextUsage?.maxTokens ?? 0;
  if (!max || !tokens) return '0%';
  return `${Math.max(1, Math.min(100, Math.round((tokens / max) * 100)))}%`;
}

/**
 * Web-native system/config commands. Returning true means the text was
 * handled locally and must not be sent to the CLI (which would otherwise
 * render a `<synthetic>` assistant message).
 */
function handleWebCommand(text: string): boolean {
  const match = text.match(/^\/([a-zA-Z0-9_-]+)(?:[ \t]+([^\n]*))?$/);
  if (!match) return false;
  const name = match[1].toLowerCase();
  const arg = (match[2] ?? '').trim();
  if (!webCommandNames.has(name)) return false;

  if (attachments.value.length > 0) {
    toast('该命令不支持附件，请先移除附件', 'error');
    return true;
  }

  switch (name) {
    case 'model':
      if (!arg) {
        openSessionPanel('model');
      } else {
        void applyModel(arg);
      }
      break;
    case 'context':
      openSessionPanel('info');
      break;
    case 'usage':
    case 'status':
      openSessionPanel('info');
      break;
    case 'permissions':
      openSessionPanel('permission');
      break;
    case 'config':
      openSessionPanel('model');
      toast('Web 端可配置模型、权限与会话状态；其他 CLI 配置请使用设置页或终端', 'info', 3600);
      break;
    case 'help':
      settingsOpen.value = false;
      helpOpen.value = true;
      break;
    default:
      return false;
  }

  draft.value = '';
  closeMenu();
  void nextTick(() => {
    resizeComposer();
    textareaRef.value?.focus();
  });
  return true;
}

async function stopRuntime(): Promise<void> {
  settingsOpen.value = false;
  await forceStop();
}

function closeMenu(): void {
  menuType.value = 'none';
  menuQuery.value = '';
  menuIndex.value = 0;
  fileSuggestions.value = [];
}

function scheduleFileSearch(query: string): void {
  if (fileTimer) window.clearTimeout(fileTimer);
  const seq = ++fileSeq;
  fileTimer = window.setTimeout(async () => {
    const cwd = state.value?.cwd;
    if (!cwd) return;
    menuLoading.value = true;
    try {
      const result = await api.searchFiles(cwd, query);
      if (seq !== fileSeq || menuType.value !== 'file') return;
      fileSuggestions.value = result.files;
      menuIndex.value = 0;
    } catch {
      fileSuggestions.value = [];
    } finally {
      if (seq === fileSeq) menuLoading.value = false;
    }
  }, 160);
}

function detectMenu(): void {
  const el = textareaRef.value;
  if (!el) return;
  const caret = el.selectionStart ?? 0;
  const before = draft.value.slice(0, caret);
  const match = before.match(/(?:^|\s)([/@])([^\s]*)$/);
  if (!match) {
    closeMenu();
    return;
  }
  const symbol = match[1];
  const query = match[2] ?? '';
  tokenStart.value = caret - query.length - 1;
  menuIndex.value = 0;
  if (symbol === '/') {
    menuType.value = 'slash';
    menuQuery.value = query;
    fileSuggestions.value = [];
  } else {
    menuType.value = 'file';
    menuQuery.value = query;
    scheduleFileSearch(query);
  }
}

function insertMenu(index: number): void {
  const item = menuItems.value[index];
  const el = textareaRef.value;
  if (!item || !el) return;
  const caret = el.selectionStart ?? draft.value.length;
  const before = draft.value.slice(0, tokenStart.value);
  const after = draft.value.slice(caret);
  draft.value = `${before}${item.insert}${after}`;
  const position = before.length + item.insert.length;
  closeMenu();
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(position, position);
    resizeComposer();
  });
}

function openSymbol(symbol: '/' | '@'): void {
  const el = textareaRef.value;
  if (!el) return;
  const caret = el.selectionStart ?? draft.value.length;
  draft.value = `${draft.value.slice(0, caret)}${symbol}${draft.value.slice(caret)}`;
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(caret + 1, caret + 1);
    resizeComposer();
    detectMenu();
  });
}

function moveMenu(delta: number): void {
  const count = menuItems.value.length;
  if (count === 0) return;
  menuIndex.value = (menuIndex.value + delta + count) % count;
}

function onKeydown(event: KeyboardEvent): void {
  if (menuType.value !== 'none' && menuItems.value.length > 0) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveMenu(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      // If the user already typed the full slash command name, Enter should
      // execute it instead of only completing `/model ` with a trailing space.
      if (event.key === 'Enter' && menuType.value === 'slash' && menuQuery.value) {
        const exact = menuItems.value.find(
          (item) =>
            item.kind !== 'file' &&
            item.label.toLowerCase() === `/${menuQuery.value.toLowerCase()}`,
        );
        if (exact) {
          event.preventDefault();
          void send();
          return;
        }
      }
      event.preventDefault();
      insertMenu(menuIndex.value);
      return;
    }
  }
  if (event.key === 'Escape' && menuType.value !== 'none') {
    event.preventDefault();
    closeMenu();
    return;
  }
  if (event.key === 'Escape' && running.value && !event.isComposing) {
    event.preventDefault();
    void interrupt();
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}

function onInput(): void {
  resizeComposer();
  detectMenu();
}

function useExample(text: string): void {
  draft.value = text;
  void nextTick(() => {
    textareaRef.value?.focus();
    resizeComposer();
  });
}

interface VoiceEdit {
  start: number;
  spacer: string;
  applied: string;
}

let voiceEdit: VoiceEdit | null = null;

function beginVoiceEdit(): void {
  const el = textareaRef.value;
  voiceEdit = { start: el?.selectionStart ?? draft.value.length, spacer: '', applied: '' };
}

function renderVoiceDraft(text: string): void {
  if (!voiceEdit) return;
  const clean = text.trim();
  const current = draft.value;

  if (!voiceEdit.applied) {
    // First insertion: use the current caret in case the user typed while the
    // Live setup was in flight.
    const el = textareaRef.value;
    const caret = Math.min(el?.selectionStart ?? voiceEdit.start, current.length);
    const before = current.slice(0, caret);
    const spacer = before && !/\s$/.test(before) ? ' ' : '';
    voiceEdit.start = caret;
    voiceEdit.spacer = spacer;
    voiceEdit.applied = `${spacer}${clean}`;
    draft.value = `${before}${voiceEdit.applied}${current.slice(caret)}`;
    resizeComposer();
    return;
  }

  // The user may have typed after the dictation segment. Replace only the
  // applied segment instead of appending the final text after their edit.
  let at = voiceEdit.start;
  if (current.slice(at, at + voiceEdit.applied.length) !== voiceEdit.applied) {
    at = current.indexOf(voiceEdit.applied);
  }
  if (at < 0) {
    // The segment was edited/deleted beyond recognition; fall back to the
    // normal insertion path rather than overwriting unrelated text.
    voiceEdit = null;
    return;
  }
  const previousLength = voiceEdit.applied.length;
  const next = `${voiceEdit.spacer}${clean}`;
  voiceEdit.start = at;
  voiceEdit.applied = next;
  draft.value = `${current.slice(0, at)}${next}${current.slice(at + previousLength)}`;
  resizeComposer();
}

function renderVoicePartial(text: string): void {
  if (!voiceEdit) beginVoiceEdit();
  renderVoiceDraft(text);
}

function finishVoiceEdit(): void {
  const edit = voiceEdit;
  voiceEdit = null;
  if (!edit) return;
  void nextTick(() => {
    const el = textareaRef.value;
    const position = edit.start + edit.applied.length;
    el?.focus();
    el?.setSelectionRange(position, position);
    resizeComposer();
  });
}

function insertVoiceText(text: string): void {
  const clean = text.trim();
  if (!clean) return;
  if (voiceEdit) {
    renderVoiceDraft(clean);
    // Gemini Live may finalize one utterance while the same capture session
    // continues with the next one. Keep the anchor until VoiceControl emits
    // `end`; otherwise the next partial starts a new anchor at the caret and
    // repeats the finalized prefix.
    if (voiceEdit) return;
    // Anchor was lost because the user edited over it; fall through to a
    // normal insertion so the final text is not dropped.
  }
  const el = textareaRef.value;
  const caret = el?.selectionStart ?? draft.value.length;
  const prefix = draft.value.slice(0, caret);
  const suffix = draft.value.slice(caret);
  const spacer = prefix && !/\s$/.test(prefix) ? ' ' : '';
  draft.value = `${prefix}${spacer}${clean}${suffix}`;
  void nextTick(() => {
    const position = prefix.length + spacer.length + clean.length;
    el?.focus();
    el?.setSelectionRange(position, position);
    resizeComposer();
  });
}

watch(settingsOpen, (open) => {
  if (open) settingsModel.value = state.value?.model ?? '';
});

watch(
  () => route.params.id,
  () => {
    sideOpen.value = false;
    sideDraft.value = '';
    sideBusy.value = false;
    sideExchanges.value = [];
    if (route.name === 'chat') void reload();
  },
);

function onVisibility(): void {
  if (document.visibilityState === 'visible' && !connected.value && !loading.value) {
    void connect();
  }
}

onMounted(async () => {
  mounted = true;
  sideHeight.value = readSideHeight();
  window.addEventListener('resize', onSideWindowResize);
  clockTimer = window.setInterval(() => (now.value = Date.now()), 1000);
  document.addEventListener('visibilitychange', onVisibility);
  if (typeof ResizeObserver !== 'undefined' && threadEl.value) {
    threadObserver = new ResizeObserver(() => {
      if (stickToBottom.value) scrollToBottom();
    });
    threadObserver.observe(threadEl.value);
  }
  await load();
});

onUnmounted(() => {
  mounted = false;
  finishSideResize();
  window.removeEventListener('resize', onSideWindowResize);
  cleanupSocket();
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  if (fileTimer) window.clearTimeout(fileTimer);
  if (clockTimer) window.clearInterval(clockTimer);
  threadObserver?.disconnect();
  threadObserver = null;
  document.removeEventListener('visibilitychange', onVisibility);
});
</script>

<template>
  <AppShell flush>
    <div
      class="chat-page"
      @dragenter.prevent="onDragEnter"
      @dragover.prevent="onDragOver"
      @dragleave.prevent="onDragLeave"
      @drop.prevent="onDrop"
    >
      <div v-if="dragActive" class="drop-overlay">
        <Icon name="paperclip" :size="22" />
        <span>松开即可添加附件</span>
      </div>
      <header class="chat-head">
        <div class="chat-head-left">
          <button class="icon-btn back-mobile" title="返回" @click="router.push('/')">
            <Icon name="arrowLeft" :size="19" />
          </button>
          <div class="chat-title-wrap">
            <div class="chat-title-line">
              <h1>{{ title }}</h1>
              <span class="status-pill" :class="statusTone(status)">
                <span class="status-dot" :class="statusTone(status)" />
                {{ statusLabel(status) }}
              </span>
              <span v-if="elapsedText" class="elapsed-chip">{{ elapsedText }}</span>
            </div>
            <div class="chat-path">
              <Icon name="folder" :size="13" />
              <span>{{ prettyPath(state?.cwd ?? '') }}</span>
              <span v-if="state?.costUsd" class="dot-sep">·</span>
              <span v-if="state?.costUsd" class="cost-chip">{{ formatCost(state.costUsd) }}</span>
            </div>
          </div>
        </div>

        <div class="chat-head-right">
          <div v-if="contextPercent > 0" class="context-meter" :title="contextTitle">
            <span class="context-bar"><span :style="{ width: `${Math.min(100, contextPercent)}%` }" /></span>
            <span>{{ contextPercent }}%</span>
          </div>
          <span class="meta-chip">{{ state?.model || '默认模型' }}</span>
          <span
            class="meta-chip mode"
            :class="{ danger: state?.permissionMode === 'bypassPermissions' }"
          >{{ modeLabel }}</span>
          <button
            class="meta-chip side-entry"
            :class="{ active: sideOpen }"
            title="旁问：基于当前上下文回答，不打断当前任务"
            @click="toggleSide"
          >
            <Icon name="spark" :size="13" />
            <span>旁问</span>
          </button>
          <button class="icon-btn" title="会话设置" @click="toggleSessionSettings">
            <Icon name="settings" :size="18" />
          </button>
        </div>
      </header>

      <div v-if="reconnecting && !connected" class="conn-banner">
        <span class="spinner tiny" />
        连接中断，正在重连… 后台任务仍在服务端运行
      </div>

      <div
        v-if="running || activeTasks.length || state?.statusDetail"
        class="run-strip"
        :class="{ waiting: status === 'waiting_permission' }"
      >
        <span v-if="status === 'running'" class="spinner tiny" />
        <Icon v-else-if="status === 'waiting_permission'" name="shield" :size="14" />
        <span class="run-label">{{ runtimeLabel }}</span>
        <span v-if="elapsedText" class="run-elapsed">{{ elapsedText }}</span>
        <span
          v-for="task in activeTasks"
          :key="task.id"
          class="task-chip"
          :title="task.description"
        >
          <Icon name="spark" :size="12" />
          {{ task.description }}
          <span v-if="task.lastToolName" class="task-tool">{{ task.lastToolName }}</span>
        </span>
        <span class="run-spacer" />
        <span v-if="stopping && stopSlow" class="run-slow">工具仍在退出</span>
        <button
          v-if="stopSlow"
          class="run-stop force"
          title="强制结束后台进程"
          @click="forceStop"
        >
          强制结束
        </button>
        <button
          v-if="running"
          class="run-stop"
          :disabled="stopping"
          title="停止当前回合（Esc）"
          @click="interrupt"
        >
          <span v-if="stopping" class="spinner tiny" />
          <Icon v-else name="stop" :size="12" />
          {{ stopping ? '停止中…' : '停止' }}
        </button>
      </div>

      <div ref="messagesEl" class="chat-scroll" @scroll="onScroll">
        <div ref="threadEl" class="chat-thread">
          <button
            v-if="hasMoreEarlier && !loading"
            class="load-earlier"
            :disabled="loadingEarlier"
            @click="loadEarlier"
          >
            <span v-if="loadingEarlier" class="spinner tiny" />
            {{ loadingEarlier ? '加载中…' : '加载更早的消息' }}
          </button>

          <div v-if="loading" class="thread-loading">
            <span class="spinner" />
            正在载入会话…
          </div>

          <div v-else-if="error" class="thread-error">
            <span class="empty-mark"><Icon name="alert" :size="26" /></span>
            <h3>无法打开会话</h3>
            <p>{{ error }}</p>
            <button class="btn secondary" @click="router.push('/')">返回会话列表</button>
          </div>

          <div v-else-if="items.length === 0" class="chat-empty">
            <span class="empty-mark large"><Icon name="brand" :size="34" /></span>
            <h2>开始和 Claude 对话</h2>
            <p>当前目录：<code>{{ prettyPath(state?.cwd ?? '') }}</code></p>
            <div class="example-row">
              <button v-for="example in examples" :key="example" class="example-chip" @click="useExample(example)">
                {{ example }}
              </button>
            </div>
            <p class="empty-hint">
              输入 <code>/</code> 选择命令或技能，输入 <code>@</code> 引用文件；敏感操作会先请你批准。
            </p>
          </div>

          <MessageItem
            v-for="item in items"
            :key="item.key"
            :item="item"
            :session-id="sessionId"
          />
          <div class="thread-bottom" />
        </div>

        <button v-if="!stickToBottom" class="scroll-bottom" @click="scrollToBottom(true)">
          <Icon name="chevronDown" :size="16" />
          回到底部
        </button>
      </div>

      <div class="composer-wrap">
        <QuestionPanel
          v-if="pendingQuestion"
          :question="pendingQuestion"
          :busy="questionBusy"
          :timeout-minutes="appConfig?.permissionTimeoutMinutes"
          @submit="answerQuestion"
          @skip="skipQuestion"
        />
        <PlanPanel
          v-else-if="pendingPlan"
          :plan="pendingPlan"
          :busy="planBusy"
          :timeout-minutes="appConfig?.permissionTimeoutMinutes"
          @decide="decidePlan"
        />
        <PermissionPanel
          v-else-if="pending"
          :permission="pending"
          :busy="permissionBusy"
          :timeout-minutes="appConfig?.permissionTimeoutMinutes"
          @respond="respond"
        />

        <div class="composer">
          <div v-if="menuType !== 'none'" class="suggest-menu">
            <div class="suggest-head">
              <span>{{ menuType === 'slash' ? '命令与技能' : '引用文件' }}</span>
              <span v-if="menuLoading" class="spinner tiny" />
              <button class="icon-btn tiny" title="关闭" @click="closeMenu">
                <Icon name="x" :size="13" />
              </button>
            </div>
            <button
              v-for="(menuItem, index) in menuItems"
              :key="menuItem.id"
              class="suggest-item"
              :class="{ active: index === menuIndex }"
              @mousedown.prevent="insertMenu(index)"
            >
              <span class="suggest-icon">
                <Icon
                  :name="menuItem.kind === 'file' ? 'file' : menuItem.kind === 'skill' ? 'spark' : 'command'"
                  :size="15"
                />
              </span>
              <span class="suggest-copy">
                <span class="suggest-label">{{ menuItem.label }}</span>
                <span class="suggest-desc">{{ menuItem.description }}</span>
              </span>
              <span class="suggest-insert">{{ menuItem.insert.trim() }}</span>
            </button>
            <div v-if="menuItems.length === 0 && !menuLoading" class="suggest-empty">
              没有匹配项
            </div>
          </div>

          <div v-if="attachments.length > 0" class="composer-attachments">
            <div
              v-for="attachment in attachments"
              :key="attachment.id"
              class="attachment-chip"
              :class="{ uploading: attachment.uploading, image: attachment.kind === 'image' }"
              :title="attachment.name"
            >
              <img
                v-if="attachment.kind === 'image' && attachment.previewUrl"
                :src="attachment.previewUrl"
                alt=""
                class="attachment-thumb"
              />
              <span v-else class="attachment-file-icon"><Icon name="file" :size="15" /></span>
              <span class="attachment-copy">
                <span class="attachment-name">{{ attachment.name }}</span>
                <span class="attachment-size">{{ formatBytes(attachment.size) }}</span>
              </span>
              <span v-if="attachment.uploading" class="spinner tiny" />
              <button
                class="icon-btn tiny attachment-remove"
                title="移除附件"
                @click="removeAttachment(attachment.id)"
              >
                <Icon name="x" :size="12" />
              </button>
            </div>
          </div>

          <textarea
            ref="textareaRef"
            v-model="draft"
            class="composer-input"
            rows="1"
            placeholder="给 Claude 一个任务，输入 / 命令、@ 文件，或粘贴/拖入附件…"
            spellcheck="false"
            @input="onInput"
            @keydown="onKeydown"
            @paste="onPaste"
          />

          <div class="composer-bar">
            <div class="composer-tools">
              <button class="tool-btn" title="命令与技能" @click="openSymbol('/')">
                <Icon name="command" :size="16" />
                <span>命令</span>
              </button>
              <button class="tool-btn" title="引用文件" @click="openSymbol('@')">
                <Icon name="at" :size="16" />
                <span>文件</span>
              </button>
              <button class="tool-btn" title="添加附件（图片或文件）" @click="pickFiles">
                <Icon name="paperclip" :size="16" />
                <span>附件</span>
              </button>
              <input
                ref="fileInputRef"
                type="file"
                multiple
                class="file-input-hidden"
                @change="onFilePicked"
              />
              <VoiceControl
                @start="beginVoiceEdit"
                @partial="renderVoicePartial"
                @text="insertVoiceText"
                @end="finishVoiceEdit"
              />
            </div>
            <span class="composer-hint">Enter 发送 · Shift+Enter 换行 · Esc 停止</span>
            <span class="composer-spacer" />
            <span v-if="running && !stopping" class="queue-hint">发送会排在当前步骤之后</span>
            <button
              v-if="running"
              class="btn ghost small composer-stop"
              :disabled="stopping"
              title="停止当前回合（Esc）"
              @click="interrupt"
            >
              <span v-if="stopping" class="spinner tiny" />
              <Icon v-else name="stop" :size="13" />
              {{ stopping ? '停止中…' : '停止' }}
            </button>
            <button class="btn primary send-btn" :disabled="!canSend" @click="send">
              <Icon name="send" :size="15" />
              {{ running ? '排队发送' : '发送' }}
            </button>
          </div>
        </div>
      </div>

      <aside
        v-if="sideOpen"
        ref="sidePanelRef"
        class="side-panel"
        :class="{ resizing: sideResizing }"
        :style="sidePanelStyle"
      >
        <div
          class="side-resize-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整旁问高度"
          tabindex="0"
          title="拖动调整高度，双击还原"
          @pointerdown="startSideResize"
          @keydown="onSideResizeKey"
          @dblclick="resetSideHeight"
        >
          <span class="side-resize-grip" />
        </div>
        <header class="side-head">
          <span class="side-title"><Icon name="spark" :size="14" />旁问</span>
          <span class="side-note">当前上下文 · 不写入主对话</span>
          <button class="icon-btn tiny" title="关闭旁问" @click="sideOpen = false">
            <Icon name="x" :size="13" />
          </button>
        </header>

        <div ref="sideListRef" class="side-list">
          <p v-if="sideExchanges.length === 0" class="side-empty">
            在当前任务运行中问一个快速问题。旁问会读取已经落盘的对话上下文，不能调用工具，也不会打断当前回合或写入主对话。
          </p>
          <div
            v-for="exchange in sideExchanges"
            :key="exchange.requestId"
            class="side-exchange"
          >
            <div class="side-question">{{ exchange.question }}</div>
            <details v-if="exchange.thinking" class="side-thinking">
              <summary>思考过程</summary>
              <pre>{{ exchange.thinking }}</pre>
            </details>
            <div
              v-if="exchange.answer"
              class="side-answer markdown"
              v-html="renderMarkdown(exchange.answer)"
            />
            <div v-else-if="exchange.status === 'running'" class="side-wait">
              <span class="spinner tiny" />
              正在回答…
            </div>
            <div v-if="exchange.status === 'error'" class="side-error">
              <Icon name="alert" :size="13" />
              <span>{{ exchange.error || '旁问失败' }}</span>
            </div>
            <div v-else-if="exchange.status === 'canceled'" class="side-canceled">已取消</div>
            <div v-if="exchange.status === 'done'" class="side-meta">
              <span v-if="formatCost(exchange.costUsd)">{{ formatCost(exchange.costUsd) }}</span>
              <span v-if="formatDuration(exchange.durationMs)">{{ formatDuration(exchange.durationMs) }}</span>
              <span>未写入主对话</span>
            </div>
          </div>
        </div>

        <div class="side-compose">
          <textarea
            ref="sideInputRef"
            v-model="sideDraft"
            class="side-input"
            rows="2"
            placeholder="问一个旁支问题…（Enter 发送，Shift+Enter 换行）"
            :disabled="sideBusy"
            @keydown="onSideKeydown"
          />
          <div class="side-actions">
            <span class="side-hint">基于当前上下文</span>
            <button v-if="sideBusy" class="btn ghost small" @click="cancelSide">取消</button>
            <button
              class="btn primary small"
              :disabled="!sideDraft.trim() || sideBusy || !connected"
              @click="askSide"
            >
              提问
            </button>
          </div>
        </div>
      </aside>

      <div v-if="settingsOpen" class="popover-backdrop" @click="settingsOpen = false" />
      <div v-if="settingsOpen" class="session-popover settings-popover">
        <div class="popover-head">
          <span>会话设置</span>
          <button class="icon-btn tiny" @click="settingsOpen = false">
            <Icon name="x" :size="15" />
          </button>
        </div>

        <div class="popover-tabs">
          <button
            v-for="tab in settingsTabs"
            :key="tab.value"
            class="popover-tab"
            :class="{ active: settingsTab === tab.value }"
            @click="selectSettingsTab(tab.value)"
          >
            {{ tab.label }}
          </button>
        </div>

        <template v-if="settingsTab === 'model'">
          <div class="popover-current">
            <span class="mini-label">当前模型</span>
            <code>{{ state?.model || '默认模型' }}</code>
          </div>
          <div class="model-grid">
            <button
              v-for="preset in modelPresets"
              :key="preset.value"
              class="model-option"
              :class="{
                active:
                  preset.value === 'default'
                    ? !state?.model
                    : state?.model === preset.value,
              }"
              :disabled="modelBusy"
              @click="applyModel(preset.value)"
            >
              <span>{{ preset.label }}</span>
              <small>{{ preset.hint }}</small>
            </button>
          </div>
          <label class="popover-field">
            <span class="mini-label">自定义模型 ID</span>
            <input
              v-model="settingsModel"
              class="text-input"
              placeholder="留空使用默认模型"
              spellcheck="false"
              @keydown.enter.prevent="saveModel"
            />
          </label>
          <button class="btn secondary block" :disabled="modelBusy" @click="saveModel">
            <span v-if="modelBusy" class="spinner tiny" />
            应用模型
          </button>
          <p class="popover-note">
            模型别名由 Claude Code CLI 解释；可用 sonnet / opus / haiku / fable / best /
            1M 变体 / opusplan，或填写完整模型 ID。
          </p>
        </template>

        <template v-else-if="settingsTab === 'permission'">
          <span class="mini-label">权限模式</span>
          <div class="mode-list">
            <button
              v-for="mode in appConfig?.permissionModes ?? []"
              :key="mode.value"
              class="mode-option"
              :class="{
                active: state?.permissionMode === mode.value,
                danger: mode.value === 'bypassPermissions',
              }"
              :disabled="modeBusy"
              @click="chooseMode(mode.value)"
            >
              <span>{{ mode.label }}</span>
              <Icon v-if="state?.permissionMode === mode.value" name="check" :size="14" />
            </button>
          </div>
        </template>

        <template v-else>
          <div class="popover-info-list">
            <div class="popover-meta">
              <span>状态</span>
              <code>{{ statusLabel(state?.status) }}</code>
            </div>
            <div class="popover-meta">
              <span>模型</span>
              <code>{{ state?.model || '默认模型' }}</code>
            </div>
            <div class="popover-meta">
              <span>权限</span>
              <code>{{ modeLabel || '—' }}</code>
            </div>
            <div class="popover-meta">
              <span>工作目录</span>
              <code :title="state?.cwd ?? ''">{{ prettyPath(state?.cwd ?? '') }}</code>
            </div>
            <div v-if="state?.claudeSessionId" class="popover-meta">
              <span>会话 ID</span>
              <code>{{ state.claudeSessionId.slice(0, 8) }}…</code>
            </div>
            <div class="popover-meta">
              <span>CLI</span>
              <code>{{ state?.claudeVersion ?? appConfig?.versions.cli ?? '—' }}</code>
            </div>
            <div v-if="state?.costUsd" class="popover-meta">
              <span>费用</span>
              <code>{{ formatCost(state.costUsd) }}</code>
            </div>
            <div v-if="state?.activeTools?.length" class="popover-meta">
              <span>活动工具</span>
              <code>{{ state.activeTools.map((tool) => tool.name).join('、') }}</code>
            </div>
          </div>

          <div class="popover-sep" />
          <div class="context-title">
            <span class="mini-label">上下文用量</span>
            <button class="mini-link" :disabled="contextRefreshing" @click="refreshContextNow">
              <span v-if="contextRefreshing" class="spinner tiny" />
              {{ contextRefreshing ? '读取中…' : '刷新' }}
            </button>
          </div>
          <template v-if="state?.contextUsage">
            <div class="context-summary">
              {{ formatTokens(state.contextUsage.totalTokens) || '—' }} /
              {{ formatTokens(state.contextUsage.maxTokens) || '—' }}
              <span>· {{ Math.round(state.contextUsage.percentage ?? 0) }}%</span>
            </div>
            <div v-if="state.contextUsage.categories?.length" class="context-cats">
              <div v-for="category in state.contextUsage.categories" :key="category.name" class="context-cat">
                <span class="context-cat-name">{{ category.name }}</span>
                <span class="context-cat-bar"><span :style="{ width: categoryWidth(category.tokens) }" /></span>
                <span class="context-cat-value">{{ formatTokens(category.tokens) }}</span>
              </div>
            </div>
          </template>
          <p v-else class="popover-note">暂无上下文数据；发送一条消息后再查看。</p>

          <div class="popover-sep" />
          <button class="btn ghost danger-text block" @click="stopRuntime">结束后台进程</button>
          <p class="popover-note">
            关闭浏览器页面不会停止后台任务；再次打开会自动附着并回放。结束后台进程只停止进程，聊天记录保留。
          </p>
        </template>
      </div>

      <div v-if="helpOpen" class="popover-backdrop" @click="helpOpen = false" />
      <div v-if="helpOpen" class="session-popover help-popover">
        <div class="popover-head">
          <span>Web 命令</span>
          <button class="icon-btn tiny" @click="helpOpen = false">
            <Icon name="x" :size="15" />
          </button>
        </div>
        <p class="popover-note">
          这些命令由 Web 原生处理，不会发送给 CLI，也不会产生 <code>&lt;synthetic&gt;</code> 对话。
          其他 <code>/命令</code> 和 Skill 仍交给 Claude Code 执行。
        </p>
        <div class="help-list">
          <div v-for="command in webCommands" :key="command.name" class="help-item">
            <code>{{ command.usage }}</code>
            <span>{{ command.description }}</span>
          </div>
        </div>
        <p class="popover-note">输入 <code>/</code> 浏览全部命令，输入 <code>@</code> 引用文件。</p>
      </div>
    </div>
  </AppShell>
</template>
