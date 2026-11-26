<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError, api } from '../api';
import { t, translateServerMessage } from '../i18n';
import { appConfig, loadConfig, refreshSessions } from '../store';
import type { DirListing, PermissionMode, ProjectSummary } from '../types';
import { prettyPath } from '../utils';
import Icon from './Icon.vue';

const emit = defineEmits<{ created: [id: string] }>();
const router = useRouter();

const listing = ref<DirListing | null>(null);
const pathInput = ref('');
/** Raw text that produced the current listing; may be `~` or a trailing slash. */
const selectedInput = ref('');
const pathHint = ref('');
const pathState = ref<'idle' | 'resolving' | 'invalid'>('idle');
const pathComposing = ref(false);
const projects = ref<ProjectSummary[]>([]);
const loading = ref(false);
const submitting = ref(false);
const creatingFolder = ref(false);
const error = ref('');
const permissionMode = ref<PermissionMode>('default');
const model = ref('');

const PATH_DEBOUNCE_MS = 280;
let pathTimer: number | undefined;
let browseToken = 0;
let pathFocused = false;

const pathReady = computed(
  () =>
    !!listing.value &&
    !loading.value &&
    pathState.value === 'idle' &&
    pathInput.value.trim() === selectedInput.value.trim(),
);

const modes = computed(() => appConfig.value?.permissionModes ?? []);
const currentModel = computed(() => appConfig.value?.models.current ?? '');
const customModel = computed(() => appConfig.value?.models.custom ?? '');
const customModelName = computed(() => appConfig.value?.models.customName ?? '');

const descriptions: Record<string, string> = {
  default: '每个敏感工具都先询问你',
  acceptEdits: '文件编辑自动通过，命令仍需批准',
  plan: '只读规划，不改动文件',
  auto: '模型分类器自动判断（本机默认）',
  dontAsk: '不弹窗，未授权的一律拒绝',
  bypassPermissions: '跳过所有确认，非常危险',
};

function pathErrorMessage(err: unknown): string {
  return err instanceof ApiError ? translateServerMessage(err.message) : t('无法读取目录');
}

function cancelPendingBrowse(): void {
  if (pathTimer) {
    window.clearTimeout(pathTimer);
    pathTimer = undefined;
  }
  // Invalidate any request already in flight. It may still finish on the
  // server, but it must not overwrite the tree the user is now looking at.
  browseToken += 1;
}

async function browse(
  target?: string,
  options: { live?: boolean } = {},
): Promise<void> {
  if (options.live) cancelPendingBrowse();
  const token = ++browseToken;
  const requested = target?.trim() ?? '';
  loading.value = true;
  pathState.value = 'resolving';
  pathHint.value = '';
  error.value = '';
  try {
    const result = await api.listDirs(requested || undefined);
    if (token !== browseToken) return;
    listing.value = result;
    pathState.value = 'idle';
    if (options.live && pathFocused) {
      // Keep exactly what the user typed while the field is focused; show the
      // canonical path as a hint when `~` or a symlink changed it.
      selectedInput.value = requested;
      pathHint.value = result.path !== requested ? t('实际路径：{path}', { path: result.path }) : '';
    } else {
      pathInput.value = result.path;
      selectedInput.value = result.path;
      pathHint.value = '';
    }
  } catch (err) {
    if (token !== browseToken) return;
    pathState.value = 'invalid';
    pathHint.value = pathErrorMessage(err);
    // A live/Enter lookup must never replace the current tree with an empty
    // list or a page-level error: the user is probably still typing.
  } finally {
    if (token === browseToken) loading.value = false;
  }
}

function schedulePathBrowse(): void {
  if (pathComposing.value) return;
  cancelPendingBrowse();
  const value = pathInput.value.trim();
  if (!value) {
    pathState.value = 'idle';
    pathHint.value = '';
    loading.value = false;
    return;
  }
  pathState.value = 'resolving';
  pathHint.value = '';
  pathTimer = window.setTimeout(() => {
    pathTimer = undefined;
    void browse(value, { live: true });
  }, PATH_DEBOUNCE_MS);
}

function onPathInput(event: Event): void {
  const target = event.target as HTMLInputElement | null;
  if (target) pathInput.value = target.value;
  schedulePathBrowse();
}

function onPathFocus(): void {
  pathFocused = true;
}

function onPathBlur(): void {
  pathFocused = false;
  if (pathState.value === 'idle' && listing.value) {
    pathInput.value = listing.value.path;
    selectedInput.value = listing.value.path;
    pathHint.value = '';
  }
}

function onPathKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  cancelPendingBrowse();
  pathInput.value = listing.value?.path ?? '';
  selectedInput.value = listing.value?.path ?? '';
  pathState.value = 'idle';
  pathHint.value = '';
  loading.value = false;
}

function onCompositionStart(): void {
  pathComposing.value = true;
}

function onCompositionEnd(): void {
  pathComposing.value = false;
  schedulePathBrowse();
}

async function loadProjects(): Promise<void> {
  try {
    const result = await api.projects();
    projects.value = result.projects.slice(0, 6);
  } catch {
    projects.value = [];
  }
}

async function start(): Promise<void> {
  if (!listing.value || submitting.value || !pathReady.value) return;
  submitting.value = true;
  error.value = '';
  try {
    const state = await api.createSession({
      cwd: listing.value.path,
      permissionMode: permissionMode.value,
      model: model.value.trim() || undefined,
    });
    await refreshSessions();
    emit('created', state.id);
    await router.push(`/s/${state.id}`);
  } catch (err) {
    error.value = err instanceof ApiError ? translateServerMessage(err.message) : t('创建会话失败');
  } finally {
    submitting.value = false;
  }
}

function openPath(target: string): void {
  cancelPendingBrowse();
  pathFocused = false;
  void browse(target);
}

function goUp(): void {
  if (listing.value?.parent) openPath(listing.value.parent);
}

function submitPath(): void {
  cancelPendingBrowse();
  const value = pathInput.value.trim();
  if (value) void browse(value);
}

async function createFolder(): Promise<void> {
  if (!listing.value || creatingFolder.value) return;
  const name = window.prompt(t('新建文件夹名称（将在当前目录下创建）'), t('新工作区'));
  if (!name || !name.trim()) return;
  creatingFolder.value = true;
  error.value = '';
  try {
    const result = await api.mkdir(listing.value.path, name.trim());
    openPath(result.path);
  } catch (err) {
    error.value = err instanceof ApiError ? translateServerMessage(err.message) : t('创建文件夹失败');
  } finally {
    creatingFolder.value = false;
  }
}

onMounted(async () => {
  await loadConfig();
  permissionMode.value = appConfig.value?.defaultPermissionMode ?? 'default';
  await loadProjects();
  const preferred =
    appConfig.value?.defaultRoot ||
    projects.value.find((item) => item.cwd.startsWith('/'))?.cwd ||
    appConfig.value?.allowedRoots[0];
  await browse(preferred);
});
</script>

<template>
  <section id="new-session" class="panel new-session">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">NEW SESSION</p>
        <h2>{{ t('新建会话') }}</h2>
      </div>
      <span class="panel-hint">{{ t('服务端常驻') }}</span>
    </div>

    <div v-if="projects.length" class="recent-projects">
      <span class="mini-label">{{ t('最近项目') }}</span>
      <div class="project-chips">
        <button
          v-for="project in projects"
          :key="project.cwd"
          class="project-chip"
          :class="{ active: project.cwd === listing?.path }"
          :title="project.cwd"
          @click="openPath(project.cwd)"
        >
          {{ prettyPath(project.cwd) }}
        </button>
      </div>
    </div>

    <div class="picker">
      <div class="picker-head">
        <button class="icon-btn" :title="t('上级目录')" :disabled="!listing?.parent || loading" @click="goUp">
          <Icon name="arrowLeft" :size="17" />
        </button>
        <form class="path-form" @submit.prevent="submitPath">
          <Icon name="folder" :size="15" />
          <input
            v-model="pathInput"
            spellcheck="false"
            :aria-label="t('工作目录')"
            :aria-invalid="pathState === 'invalid'"
            :aria-busy="pathState === 'resolving'"
            :aria-describedby="pathHint ? 'workspace-path-hint' : undefined"
            @input="onPathInput"
            @focus="onPathFocus"
            @blur="onPathBlur"
            @keydown="onPathKeydown"
            @compositionstart="onCompositionStart"
            @compositionend="onCompositionEnd"
          />
          <span v-if="pathState === 'resolving' || loading" class="spinner tiny" aria-hidden="true" />
        </form>
        <button
          class="icon-btn"
          :title="t('在当前目录新建文件夹')"
          :disabled="!listing || creatingFolder"
          @click="createFolder"
        >
          <Icon name="plus" :size="17" />
        </button>
      </div>

      <p
        v-if="pathHint"
        id="workspace-path-hint"
        class="path-hint"
        :class="{ error: pathState === 'invalid' }"
        role="status"
        aria-live="polite"
      >
        <Icon :name="pathState === 'invalid' ? 'alert' : 'info'" :size="13" />
        {{ pathHint }}
      </p>

      <div class="dir-list" :class="{ loading }">
        <button
          v-for="entry in listing?.entries ?? []"
          :key="entry.path"
          class="dir-row"
          @click="openPath(entry.path)"
        >
          <span class="dir-icon" :class="{ git: entry.isGit }">
            <Icon :name="entry.isGit ? 'gitBranch' : 'folder'" :size="16" />
          </span>
          <span class="dir-name">{{ entry.name }}</span>
          <span v-if="entry.isGit" class="git-badge">git</span>
          <Icon class="dir-arrow" name="chevronRight" :size="14" />
        </button>
        <div v-if="!loading && (listing?.entries.length ?? 0) === 0" class="dir-empty">
          {{ t('这个目录下没有可进入的子目录') }}
        </div>
        <div v-if="loading" class="dir-loading">{{ t('读取目录…') }}</div>
      </div>
    </div>

    <div class="field-block">
      <span class="mini-label">{{ t('权限模式') }}</span>
      <div class="mode-grid">
        <button
          v-for="mode in modes"
          :key="mode.value"
          class="mode-card"
          :class="{
            active: permissionMode === mode.value,
            danger: mode.value === 'bypassPermissions',
          }"
          @click="permissionMode = mode.value"
        >
          <span class="mode-title">{{ t(mode.label) }}</span>
          <span class="mode-desc">{{ t(descriptions[mode.value] ?? '') }}</span>
        </button>
      </div>
    </div>

    <p v-if="permissionMode === 'bypassPermissions'" class="mode-warning">
      <Icon name="alert" :size="14" />
      {{ t('当前为跳过确认模式：Claude 会直接执行命令和文件修改。仅建议在可信环境使用，可随时在上方切换。') }}
    </p>

    <label class="field-block">
      <span class="mini-label">{{ t('模型（可选）') }}</span>
      <input
        v-model="model"
        class="text-input"
        :placeholder="currentModel ? t('留空使用默认：{model}', { model: currentModel }) : t('留空使用默认模型')"
        list="model-options"
        spellcheck="false"
      />
      <datalist id="model-options">
        <option v-if="currentModel" :value="currentModel" />
        <option v-if="customModel" :value="customModel">{{ customModelName }}</option>
      </datalist>
    </label>

    <p v-if="listing" class="picker-selected" :class="{ warning: !pathReady }">
      <Icon name="folder" :size="13" />
      {{ pathReady ? t('将在此创建会话：') : t('当前选中（上方路径未应用）：') }}
      <code>{{ listing.path }}</code>
    </p>

    <p v-if="error" class="form-error"><Icon name="alert" :size="15" />{{ error }}</p>

    <button class="btn primary block start-btn" :disabled="!pathReady || submitting" @click="start">
      <Icon name="play" :size="15" />
      {{ submitting ? t('创建中…') : t('开始会话') }}
    </button>
    <p class="new-session-note">
      {{ t('会话进程在服务端运行，页面刷新或断网都不会中断正在执行的任务。') }}
    </p>
  </section>
</template>
