<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { locale, t, toggleLocale } from '../i18n';
import {
  appConfig,
  authState,
  loadConfig,
  refreshSessions,
  sessions,
  theme,
  toggleTheme,
} from '../store';
import { formatRelative, prettyPath, statusLabel, statusTone } from '../utils';
import Icon from './Icon.vue';

defineProps<{ flush?: boolean }>();

const route = useRoute();
const router = useRouter();
const mobileOpen = ref(false);
const loggingOut = ref(false);
let pollTimer: number | undefined;

const activeId = computed(() => (route.params.id as string | undefined) ?? '');
const visibleSessions = computed(() => sessions.value.slice(0, 60));
const version = computed(() => appConfig.value?.versions.claudeWeb ?? '0.10.1');

function isActive(id: string): boolean {
  return activeId.value === id;
}

async function logout(): Promise<void> {
  if (loggingOut.value) return;
  loggingOut.value = true;
  try {
    await api.logout();
  } catch {
    // local state still wins
  }
  authState.user = null;
  authState.checked = true;
  mobileOpen.value = false;
  await router.replace('/login');
  loggingOut.value = false;
}

function tick(): void {
  if (document.visibilityState === 'visible') void refreshSessions();
}

function goNewSession(): void {
  mobileOpen.value = false;
  void router.push({ path: '/', query: { new: '1' } });
}

watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false;
    void refreshSessions();
  },
);

onMounted(() => {
  void refreshSessions();
  void loadConfig();
  pollTimer = window.setInterval(tick, 20_000);
  document.addEventListener('visibilitychange', tick);
});

onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer);
  document.removeEventListener('visibilitychange', tick);
});
</script>

<template>
  <div class="shell" :class="{ flush }">
    <div v-if="mobileOpen" class="sidebar-backdrop" @click="mobileOpen = false" />
    <aside class="sidebar" :class="{ open: mobileOpen }">
      <div class="brand">
        <span class="brand-mark"><Icon name="brand" :size="30" /></span>
        <span class="brand-text">Claude Code <em>Web</em></span>
        <button class="icon-btn sidebar-close" :title="t('关闭菜单')" @click="mobileOpen = false">
          <Icon name="x" :size="18" />
        </button>
      </div>

      <button class="new-chat" @click="goNewSession">
        <Icon name="plus" :size="17" />
        {{ t('新建会话') }}
      </button>

      <div class="side-section">
        <div class="side-heading">
          <span>{{ t('最近会话') }}</span>
          <button class="icon-btn tiny" :title="t('刷新')" @click="refreshSessions()">
            <Icon name="refresh" :size="14" />
          </button>
        </div>
        <nav class="session-nav">
          <router-link
            v-for="item in visibleSessions"
            :key="item.id"
            :to="`/s/${item.id}`"
            class="session-item"
            :class="{ active: isActive(item.id) }"
          >
            <span class="status-dot" :class="statusTone(item.status)" />
            <span class="session-lines">
              <span class="session-title">{{ item.title === '新会话' ? t('新会话') : item.title }}</span>
              <span class="session-sub">{{ prettyPath(item.cwd) }}</span>
            </span>
            <span class="session-time">{{ formatRelative(item.updatedAt) }}</span>
          </router-link>
          <div v-if="visibleSessions.length === 0" class="side-empty">
            {{ t('还没有会话。点上方「新建会话」开始。') }}
          </div>
        </nav>
      </div>

      <div class="side-footer">
        <router-link to="/settings" class="side-action">
          <Icon name="settings" :size="16" />
          {{ t('设置') }}
        </router-link>
        <button class="side-action" @click="toggleTheme">
          <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="16" />
          {{ theme === 'dark' ? t('浅色模式') : t('深色模式') }}
        </button>
        <button class="side-action" @click="toggleLocale">
          <Icon name="globe" :size="16" />
          {{ locale === 'zh' ? 'English' : '中文' }}
        </button>
        <button class="side-action" :disabled="loggingOut" @click="logout">
          <Icon name="logout" :size="16" />
          {{ loggingOut ? t('退出中…') : t('退出登录') }}
        </button>
        <div class="side-version">
          <span>v{{ version }}</span>
          <span>{{ authState.user?.username }}</span>
        </div>
      </div>
    </aside>

    <div class="shell-body">
      <header class="mobile-bar">
        <button class="icon-btn" :title="t('菜单')" @click="mobileOpen = true">
          <Icon name="menu" :size="20" />
        </button>
        <span class="mobile-title">
          <Icon name="brand" :size="22" />
          Claude Code Web
        </span>
        <button class="icon-btn" :title="t('新建会话')" @click="goNewSession">
          <Icon name="plus" :size="20" />
        </button>
      </header>
      <main class="shell-main">
        <slot />
      </main>
    </div>
  </div>
</template>
