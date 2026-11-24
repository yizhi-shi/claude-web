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
const projects = ref<ProjectSummary[]>([]);
const loading = ref(false);
const submitting = ref(false);
const creatingFolder = ref(false);
const error = ref('');
const permissionMode = ref<PermissionMode>('default');
const model = ref('');

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

async function browse(target?: string): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await api.listDirs(target);
    listing.value = result;
    pathInput.value = result.path;
  } catch (err) {
    error.value = err instanceof ApiError ? translateServerMessage(err.message) : t('无法读取目录');
  } finally {
    loading.value = false;
  }
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
  if (!listing.value || submitting.value) return;
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

function goUp(): void {
  if (listing.value?.parent) void browse(listing.value.parent);
}

function submitPath(): void {
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
    await browse(result.path);
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
          @click="browse(project.cwd)"
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
          <input v-model="pathInput" spellcheck="false" :aria-label="t('工作目录')" :disabled="loading" />
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

      <div class="dir-list" :class="{ loading }">
        <button
          v-for="entry in listing?.entries ?? []"
          :key="entry.path"
          class="dir-row"
          @click="browse(entry.path)"
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

    <p v-if="error" class="form-error"><Icon name="alert" :size="15" />{{ error }}</p>

    <button class="btn primary block start-btn" :disabled="!listing || submitting" @click="start">
      <Icon name="play" :size="15" />
      {{ submitting ? t('创建中…') : t('开始会话') }}
    </button>
    <p class="new-session-note">
      {{ t('会话进程在服务端运行，页面刷新或断网都不会中断正在执行的任务。') }}
    </p>
  </section>
</template>
