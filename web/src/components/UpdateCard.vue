<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ApiError, api } from '../api';
import { t, translateServerMessage } from '../i18n';
import { toast, updateStatus } from '../store';
import type { UpdateJobView, UpdateStatusView } from '../types';
import Icon from './Icon.vue';

const checking = ref(false);
const busy = ref(false);
const restarting = ref(false);
const error = ref('');
const confirming = ref(false);
const forceConfirmed = ref(false);
const localJob = ref<UpdateJobView | null>(null);
let pollTimer: number | undefined;
let healthTimer: number | undefined;
let healthFailures = 0;

const status = computed<UpdateStatusView | null>(() => updateStatus.value);
const job = computed<UpdateJobView | null>(() => localJob.value ?? status.value?.job ?? null);
const isWorking = computed(() => !!job.value && !job.value.finishedAt);
const canForce = computed(() => (status.value?.activeSessions ?? 0) > 0);
const disabledReasonText = computed(() =>
  status.value?.disabledReason ? translateServerMessage(status.value.disabledReason) : '',
);

const phaseLabel = computed(() => {
  const phase = job.value?.phase ?? '';
  const labels: Record<string, string> = {
    queued: '已排队',
    downloading: '下载更新包',
    verifying: '校验更新包',
    staging: '准备新版本',
    installing: '安装依赖',
    'smoke-test': '预启动检查',
    stopping: '停止服务',
    switching: '切换版本',
    starting: '启动新版本',
    restarting: '等待服务恢复',
    done: '更新完成',
    rolled_back: '已回滚',
    failed: '更新失败',
  };
  return t(labels[phase] || phase || '处理中');
});

function formatSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function setStatus(next: UpdateStatusView): void {
  updateStatus.value = next;
  if (next.job) localJob.value = next.job;
  if (next.lastResult) localJob.value = next.lastResult;
}

async function load(): Promise<void> {
  try {
    const next = await api.updateStatus();
    setStatus(next);
    if (next.job && !next.job.finishedAt) startPolling();
    if (next.lastResult && next.lastResult.phase !== 'done') {
      // Keep the failure visible until the user checks again.
    }
  } catch (err) {
    error.value = err instanceof ApiError ? translateServerMessage(err.message) : t('读取更新状态失败');
  }
}

async function check(): Promise<void> {
  checking.value = true;
  error.value = '';
  try {
    const next = await api.updateCheck();
    setStatus(next);
    if (next.updateAvailable) toast(t('发现新版本 v{version}', { version: next.latestVersion ?? '' }), 'success');
    else toast(t('已是最新版本'), 'success');
  } catch (err) {
    error.value = err instanceof ApiError ? translateServerMessage(err.message) : t('检查更新失败');
  } finally {
    checking.value = false;
  }
}

function beginApply(): void {
  if (!status.value?.canApply || isWorking.value) return;
  forceConfirmed.value = false;
  if (canForce.value) {
    confirming.value = true;
    return;
  }
  void apply(false);
}

async function apply(force: boolean): Promise<void> {
  if (!status.value?.latestVersion) return;
  confirming.value = false;
  busy.value = true;
  error.value = '';
  try {
    const next = await api.updateApply({
      version: status.value.latestVersion,
      force,
    });
    localJob.value = next;
    toast(t('更新已开始，服务会在切换时短暂重启'), 'info', 5000);
    startPolling();
  } catch (err) {
    const message = err instanceof ApiError ? translateServerMessage(err.message) : t('启动更新失败');
    if (err instanceof ApiError && err.status === 409 && err.message.includes('会话正在执行')) {
      // A session started between the status read and the click. Refresh the
      // count and show the confirmation instead of a dead-end error.
      try {
        setStatus(await api.updateStatus());
      } catch {
        // keep the server message below
      }
      confirming.value = true;
      forceConfirmed.value = false;
      error.value = '';
    } else {
      error.value = message;
    }
    busy.value = false;
  }
}

async function rollback(): Promise<void> {
  if (isWorking.value) return;
  busy.value = true;
  error.value = '';
  try {
    const next = await api.updateRollback();
    localJob.value = next;
    toast(t('回滚已开始'), 'info');
    startPolling();
  } catch (err) {
    error.value = err instanceof ApiError ? translateServerMessage(err.message) : t('回滚失败');
    busy.value = false;
  }
}

function stopPolling(): void {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function startPolling(): void {
  stopPolling();
  void pollOnce();
  pollTimer = window.setInterval(() => void pollOnce(), 1000);
}

async function pollOnce(): Promise<void> {
  try {
    const next = await api.updateStatus();
    setStatus(next);
    healthFailures = 0;
    if (next.job && ['stopping', 'switching', 'starting', 'restarting'].includes(next.job.phase)) {
      beginHealthWait(next.job);
      return;
    }
    if (!next.job && next.lastResult?.finishedAt) {
      stopPolling();
      busy.value = false;
      if (next.lastResult.phase === 'done') {
        toast(t('更新完成，正在刷新页面'), 'success');
        window.setTimeout(() => window.location.reload(), 800);
      } else if (next.lastResult.phase === 'rolled_back') {
        error.value = t('新版本未能启动，已自动回滚到旧版本');
      } else if (next.lastResult.error) {
        error.value = next.lastResult.error;
      }
    }
  } catch {
    healthFailures += 1;
    if (healthFailures >= 2) beginHealthWait(job.value);
  }
}

function beginHealthWait(current: UpdateJobView | null): void {
  if (restarting.value) return;
  restarting.value = true;
  stopPolling();
  const target = current?.targetVersion ?? status.value?.latestVersion ?? '';
  const previous = current?.previousVersion ?? status.value?.currentVersion ?? '';
  const started = Date.now();
  const tick = async (): Promise<void> => {
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      if (response.ok) {
        const payload = (await response.json()) as { version?: string };
        const version = payload.version ?? '';
        if (version && version === target) {
          window.clearTimeout(healthTimer);
          sessionStorage.setItem('cw.update.flash', t('已更新到 v{version}', { version }));
          window.location.reload();
          return;
        }
        if (version && version === previous) {
          window.clearTimeout(healthTimer);
          restarting.value = false;
          busy.value = false;
          error.value = t('新版本未能启动，服务已恢复到 v{version}', { version });
          return;
        }
      }
    } catch {
      // expected while the service is restarting
    }
    if (Date.now() - started > 150_000) {
      restarting.value = false;
      busy.value = false;
      error.value = t('服务在 150 秒内没有恢复，请查看 journalctl --user -u claude-web');
      return;
    }
    healthTimer = window.setTimeout(() => void tick(), 1500);
  };
  void tick();
}

onMounted(() => {
  const flash = sessionStorage.getItem('cw.update.flash');
  if (flash) {
    sessionStorage.removeItem('cw.update.flash');
    toast(flash, 'success', 5000);
  }
  void load();
});

onUnmounted(() => {
  stopPolling();
  if (healthTimer) window.clearTimeout(healthTimer);
});
</script>

<template>
  <section id="update" class="panel settings-section settings-update">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">UPDATE</p>
        <h2>{{ t('系统更新') }}</h2>
      </div>
      <span class="panel-hint">{{ status ? t('独立更新器 · 可回滚') : '…' }}</span>
    </div>

    <div v-if="!status" class="settings-loading"><span class="spinner" />{{ t('读取更新状态…') }}</div>

    <template v-else>
      <div class="update-versions">
        <div>
          <span class="mini-label">{{ t('当前版本') }}</span>
          <code>v{{ status.currentVersion }}</code>
        </div>
        <div>
          <span class="mini-label">{{ t('最新版本') }}</span>
          <code>{{ status.latestVersion ? `v${status.latestVersion}` : '—' }}</code>
        </div>
        <div>
          <span class="mini-label">{{ t('安装形态') }}</span>
          <code>{{ status.installMode }}</code>
        </div>
        <span class="update-channel">{{ status.channel }}</span>
      </div>

      <p v-if="status.updateAvailable && status.release" class="update-summary">
        <Icon name="download" :size="14" />
        {{ t('发现 v{version}，下载 {size}', {
          version: status.release.version,
          size: formatSize(status.release.size),
        }) }}
        <span v-if="status.release.publishedAt" class="muted">
          · {{ formatDate(status.release.publishedAt) }}
        </span>
        <a v-if="status.release.notesUrl" :href="status.release.notesUrl" target="_blank" rel="noreferrer">
          {{ t('更新说明') }}
        </a>
      </p>
      <p v-else-if="status.checkedAt" class="section-note">
        {{ t('已是最新版本') }} · {{ formatDate(status.checkedAt) }}
      </p>
      <p v-else class="section-note">
        {{ t('点击“检查更新”从发布源获取最新版本。') }}
      </p>

      <p v-if="disabledReasonText" class="update-warning">
        <Icon name="alert" :size="14" />{{ disabledReasonText }}
      </p>

      <div class="update-actions">
        <button class="btn secondary" :disabled="checking || !status.canCheck" @click="check">
          <Icon name="refresh" :size="14" />
          {{ checking ? t('检查中…') : t('检查更新') }}
        </button>
        <button
          v-if="status.updateAvailable"
          class="btn primary"
          :disabled="!status.canApply || busy || isWorking"
          @click="beginApply"
        >
          <Icon name="download" :size="14" />
          {{ isWorking ? t('更新进行中…') : t('立即更新') }}
        </button>
        <button
          v-if="status.lastResult?.action === 'apply' && status.lastResult.phase === 'done'"
          class="btn ghost"
          :disabled="busy || isWorking"
          @click="rollback"
        >
          {{ t('回滚上一版本') }}
        </button>
      </div>

      <div v-if="confirming" class="update-confirm">
        <p>
          <Icon name="alert" :size="14" />
          {{ t('有 {n} 个会话正在执行。更新会停止服务并中断这些任务。', {
            n: status.activeSessions,
          }) }}
        </p>
        <label class="update-check">
          <input v-model="forceConfirmed" type="checkbox" />
          <span>{{ t('我了解，继续更新') }}</span>
        </label>
        <div class="update-actions">
          <button class="btn ghost" @click="confirming = false">{{ t('取消') }}</button>
          <button class="btn primary" :disabled="!forceConfirmed" @click="apply(true)">
            {{ t('确认更新') }}
          </button>
        </div>
      </div>

      <div v-if="job" class="update-progress">
        <div class="update-progress-head">
          <span>{{ phaseLabel }}</span>
          <span v-if="job.progress !== undefined">{{ job.progress }}%</span>
        </div>
        <div class="update-bar"><span :style="{ width: `${Math.max(0, Math.min(100, job.progress ?? 8))}%` }" /></div>
        <p v-if="job.message" class="section-note">{{ job.message }}</p>
        <p v-if="job.error" class="form-error"><Icon name="alert" :size="14" />{{ job.error }}</p>
      </div>

      <p v-if="restarting" class="section-note update-restarting">
        <span class="spinner tiny" />{{ t('服务正在重启，页面会自动恢复…') }}
      </p>

      <p v-if="error" class="form-error"><Icon name="alert" :size="14" />{{ error }}</p>
    </template>
  </section>
</template>

<style scoped>
.update-versions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
  gap: 10px;
  align-items: end;
}

.update-versions > div {
  display: grid;
  gap: 3px;
}

.update-versions code {
  font-family: var(--font-mono);
  font-size: 12px;
}

.update-channel {
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--faint);
  font-size: 11px;
}

.update-summary,
.update-warning {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}

.update-summary a {
  color: var(--accent);
}

.update-warning {
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  border-radius: 8px;
  color: var(--danger);
  background: var(--danger-soft);
}

.update-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.update-confirm {
  display: grid;
  gap: 10px;
  padding: 11px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  border-radius: 9px;
  background: var(--danger-soft);
}

.update-confirm p {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  color: var(--danger);
  font-size: 12px;
  line-height: 1.5;
}

.update-check {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text);
  font-size: 12px;
}

.update-progress {
  display: grid;
  gap: 7px;
}

.update-progress-head {
  display: flex;
  justify-content: space-between;
  color: var(--muted);
  font-size: 12px;
}

.update-bar {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--panel-soft);
}

.update-bar span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.3s ease;
}

.update-restarting {
  display: flex;
  align-items: center;
  gap: 7px;
}

@media (max-width: 720px) {
  .update-versions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
