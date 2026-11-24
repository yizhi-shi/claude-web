<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError, api } from '../api';
import AppShell from '../components/AppShell.vue';
import Icon from '../components/Icon.vue';
import VoiceSettings from '../components/VoiceSettings.vue';
import {
  appConfig,
  authState,
  loadConfig,
  setServerTheme,
  serverTheme,
  toast,
  type ThemeMode,
} from '../store';
import type { WorkspaceConfigView } from '../types';
import { prettyPath } from '../utils';

const current = ref('');
const next = ref('');
const confirm = ref('');
const busy = ref(false);
const error = ref('');
const workspace = ref<WorkspaceConfigView | null>(null);
const themeIcons: Record<ThemeMode, string> = {
  system: 'smartphone',
  light: 'sun',
  dark: 'moon',
};
const themeDescriptions: Record<ThemeMode, string> = {
  system: '跟随设备或浏览器的外观设置',
  light: '登录页和所有新浏览器默认浅色',
  dark: '登录页和所有新浏览器默认深色',
};
const themeBusy = ref(false);

async function saveDefaultTheme(mode: ThemeMode): Promise<void> {
  if (themeBusy.value) return;
  themeBusy.value = true;
  try {
    const result = await api.updatePreferences(mode);
    setServerTheme(result.theme);
    toast('默认外观已更新', 'success');
  } catch (err) {
    toast(err instanceof ApiError ? err.message : '保存外观失败', 'error');
  } finally {
    themeBusy.value = false;
  }
}
const defaultRootDraft = ref('');
const newRoot = ref('');
const workspaceBusy = ref(false);

async function loadWorkspaces(): Promise<void> {
  try {
    workspace.value = await api.workspaces();
    defaultRootDraft.value = workspace.value.defaultRoot;
  } catch (err) {
    toast(err instanceof ApiError ? err.message : '读取工作区失败', 'error');
  }
}

async function persistWorkspaces(payload: {
  defaultRoot?: string;
  extraRoots?: string[];
}): Promise<void> {
  if (workspaceBusy.value) return;
  workspaceBusy.value = true;
  try {
    workspace.value = await api.updateWorkspaces(payload);
    defaultRootDraft.value = workspace.value.defaultRoot;
    await loadConfig(true);
    toast('工作区配置已更新', 'success');
  } catch (err) {
    toast(err instanceof ApiError ? err.message : '保存工作区失败', 'error');
  } finally {
    workspaceBusy.value = false;
  }
}

async function addRoot(): Promise<void> {
  const value = newRoot.value.trim();
  if (!value || !workspace.value) return;
  const nextRoots = [...workspace.value.extraRoots, value];
  await persistWorkspaces({ defaultRoot: defaultRootDraft.value, extraRoots: nextRoots });
  if (workspace.value?.extraRoots.includes(value)) newRoot.value = '';
}

async function removeRoot(root: string): Promise<void> {
  if (!workspace.value) return;
  const nextRoots = workspace.value.extraRoots.filter((item) => item !== root);
  await persistWorkspaces({ defaultRoot: defaultRootDraft.value, extraRoots: nextRoots });
}

async function saveDefaultRoot(): Promise<void> {
  if (!workspace.value) return;
  await persistWorkspaces({
    defaultRoot: defaultRootDraft.value,
    extraRoots: workspace.value.extraRoots,
  });
}

async function changePassword(): Promise<void> {
  if (busy.value) return;
  error.value = '';
  if (next.value.length < 8) {
    error.value = '新密码至少 8 位';
    return;
  }
  if (next.value !== confirm.value) {
    error.value = '两次输入的新密码不一致';
    return;
  }
  busy.value = true;
  try {
    await api.changePassword(current.value, next.value);
    current.value = '';
    next.value = '';
    confirm.value = '';
    toast('密码已更新，其他设备需要重新登录', 'success');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '修改密码失败';
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void loadConfig(true);
  void loadWorkspaces();
});
</script>

<template>
  <AppShell>
    <div class="page settings-page">
      <header class="page-head">
        <div>
          <p class="eyebrow">SETTINGS</p>
          <h1>设置</h1>
          <p class="page-sub">账号、语音渠道与运行环境。敏感信息只保存在本机。</p>
        </div>
      </header>

      <div class="settings-grid">
        <section class="panel settings-section">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">ACCOUNT</p>
              <h2>管理员账号</h2>
            </div>
            <span class="panel-hint">{{ authState.user?.username }}</span>
          </div>

          <div class="account-row">
            <span class="account-avatar"><Icon name="user" :size="20" /></span>
            <div>
              <strong>{{ authState.user?.username }}</strong>
              <span>单管理员账号 · 连续 5 次错误锁定 1 小时</span>
            </div>
          </div>

          <div class="password-form">
            <label class="field">
              <span>当前密码</span>
              <input v-model="current" type="password" autocomplete="current-password" />
            </label>
            <div class="grid-2">
              <label class="field">
                <span>新密码</span>
                <input v-model="next" type="password" autocomplete="new-password" placeholder="至少 8 位" />
              </label>
              <label class="field">
                <span>确认新密码</span>
                <input v-model="confirm" type="password" autocomplete="new-password" />
              </label>
            </div>
            <p v-if="error" class="form-error"><Icon name="alert" :size="15" />{{ error }}</p>
            <button class="btn primary" :disabled="busy" @click="changePassword">
              <Icon name="lock" :size="15" />
              {{ busy ? '更新中…' : '更新密码' }}
            </button>
          </div>
        </section>

        <section class="panel settings-section settings-wide">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">WORKSPACES</p>
              <h2>工作区目录</h2>
            </div>
            <span class="panel-hint">新建会话的起始位置</span>
          </div>

          <p class="section-lead">
            Claude 只能在你允许的目录内创建会话。环境变量 <code>ALLOWED_ROOTS</code>
            中的目录始终允许；这里可以追加额外目录，并设置新建会话的默认目录。
          </p>

          <div v-if="!workspace" class="settings-loading"><span class="spinner" />读取工作区…</div>

          <template v-else>
            <div class="workspace-default">
              <label class="field">
                <span>默认工作区</span>
                <input v-model="defaultRootDraft" placeholder="/root" spellcheck="false" />
              </label>
              <button class="btn secondary" :disabled="workspaceBusy" @click="saveDefaultRoot">
                保存默认目录
              </button>
            </div>

            <div class="setting-block">
              <span class="mini-label">环境变量允许目录（只读）</span>
              <div class="root-list">
                <span v-for="root in workspace.envRoots" :key="root" class="root-chip locked">
                  {{ prettyPath(root) }}
                </span>
              </div>
            </div>

            <div class="setting-block">
              <span class="mini-label">额外允许目录</span>
              <div class="root-list">
                <span v-for="root in workspace.extraRoots" :key="root" class="root-chip">
                  {{ prettyPath(root) }}
                  <button title="移除" :disabled="workspaceBusy" @click="removeRoot(root)">
                    <Icon name="x" :size="12" />
                  </button>
                </span>
                <span v-if="workspace.extraRoots.length === 0" class="muted tiny-text">
                  还没有额外目录
                </span>
              </div>
              <div class="root-add">
                <input
                  v-model="newRoot"
                  class="text-input"
                  placeholder="/path/to/workspace"
                  spellcheck="false"
                  @keydown.enter.prevent="addRoot"
                />
                <button class="btn secondary" :disabled="workspaceBusy" @click="addRoot">添加</button>
              </div>
            </div>

            <p class="section-note">
              建议把项目集中在一个工作区根目录下，例如 <code>/home/you/workspaces</code>；新建会话时也可以在选择器里直接新建文件夹。
            </p>
          </template>
        </section>

        <section class="panel settings-section">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">RUNTIME</p>
              <h2>运行环境</h2>
            </div>
          </div>

          <div class="version-grid">
            <div class="version-row">
              <span>Claude Code CLI</span>
              <code>{{ appConfig?.versions.cli ?? '—' }}</code>
            </div>
            <div class="version-row">
              <span>Agent SDK</span>
              <code>{{ appConfig?.versions.sdk ?? '—' }}</code>
            </div>
            <div class="version-row">
              <span>VSCode 插件</span>
              <code>{{ appConfig?.versions.vscodeExtension ?? '—' }}</code>
            </div>
            <div class="version-row">
              <span>Node.js</span>
              <code>{{ appConfig?.versions.node ?? '—' }}</code>
            </div>
            <div class="version-row">
              <span>Claude Web</span>
              <code>{{ appConfig?.versions.claudeWeb ?? '—' }}</code>
            </div>
          </div>

          <div class="setting-block">
            <span class="mini-label">默认模型</span>
            <p>{{ appConfig?.models.current || '由 Claude Code 设置决定' }}</p>
            <span v-if="appConfig?.models.customName" class="muted">
              备选：{{ appConfig.models.customName }}（{{ appConfig.models.custom }}）
            </span>
          </div>

          <div class="setting-block">
            <span class="mini-label">允许访问的目录</span>
            <div class="root-list">
              <code v-for="root in appConfig?.allowedRoots ?? []" :key="root">{{ root }}</code>
            </div>
          </div>

          <div class="setting-block">
            <span class="mini-label">会话空闲休眠</span>
            <p>{{ appConfig?.idleMinutes ?? 30 }} 分钟；再次发送会自动恢复。</p>
          </div>

          <div class="setting-block">
            <span class="mini-label">数据目录</span>
            <code class="data-path">{{ appConfig?.dataDir ?? '—' }}</code>
          </div>
        </section>

        <VoiceSettings class="settings-wide" />

        <section class="panel settings-section">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">APPEARANCE</p>
              <h2>外观</h2>
            </div>
          </div>
          <p class="section-lead">
            这里配置的是服务端默认外观，作用于登录页和所有尚未单独切换的浏览器。当前浏览器可随时在左下角切换。
          </p>
          <div class="theme-mode-grid">
            <button
              v-for="mode in (['system', 'light', 'dark'] as ThemeMode[])"
              :key="mode"
              class="theme-mode-card"
              :class="{ active: serverTheme === mode }"
              :disabled="themeBusy"
              @click="saveDefaultTheme(mode)"
            >
              <span class="theme-mode-icon"><Icon :name="themeIcons[mode]" :size="18" /></span>
              <span class="theme-mode-copy">
                <strong>{{ mode === 'system' ? '跟随系统' : mode === 'light' ? '浅色' : '深色' }}</strong>
                <span>{{ themeDescriptions[mode] }}</span>
              </span>
              <Icon v-if="serverTheme === mode" name="check" :size="15" class="theme-check" />
            </button>
          </div>
        </section>

        <section class="panel settings-section">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">SECURITY</p>
              <h2>安全提示</h2>
            </div>
          </div>
          <ul class="security-list">
            <li><Icon name="shield" :size="15" />控制台拥有服务运行用户的终端权限，请只暴露给可信网络。</li>
            <li><Icon name="lock" :size="15" />公网部署建议叠加统一身份网关、HTTPS 与反向代理限流。</li>
            <li><Icon name="key" :size="15" />账号、语音 Key 与中转凭据保存在 <code>data/</code>，已被 Git 忽略。</li>
            <li><Icon name="server" :size="15" />管理员忘记密码时，可在服务器执行 <code>npm run set-password</code>。</li>
          </ul>
        </section>
      </div>
    </div>
  </AppShell>
</template>
