<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import AppShell from '../components/AppShell.vue';
import Icon from '../components/Icon.vue';
import NewSessionPanel from '../components/NewSessionPanel.vue';
import { appConfig, loadConfig, refreshSessions, sessions } from '../store';
import type { ProjectSummary } from '../types';
import {
  formatCost,
  formatRelative,
  prettyPath,
  statusLabel,
  statusTone,
} from '../utils';

const router = useRouter();
const route = useRoute();
const search = ref('');
const projects = ref<ProjectSummary[]>([]);

const runningCount = computed(
  () =>
    sessions.value.filter(
      (item) => item.status === 'running' || item.status === 'waiting_permission',
    ).length,
);
const projectCount = computed(() => projects.value.length);
const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return sessions.value;
  return sessions.value.filter(
    (item) =>
      item.title.toLowerCase().includes(query) ||
      item.cwd.toLowerCase().includes(query),
  );
});

onMounted(async () => {
  await Promise.all([refreshSessions(), loadConfig()]);
  try {
    projects.value = (await api.projects()).projects;
  } catch {
    projects.value = [];
  }
});

function openSession(id: string): void {
  void router.push(`/s/${id}`);
}

watch(
  () => route.query.new,
  (value) => {
    if (!value) return;
    void nextTick(() => {
      document.getElementById('new-session')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  },
  { immediate: true },
);
</script>

<template>
  <AppShell>
    <div class="page home-page">
      <header class="page-head">
        <div>
          <p class="eyebrow">WORKSPACE</p>
          <h1>会话空间</h1>
          <p class="page-sub">
            在浏览器里继续本机的 Claude Code。会话运行在服务端，刷新不会中断任务。
          </p>
        </div>
        <div class="head-meta">
          <span class="env-chip">
            <Icon name="terminal" :size="14" />
            CLI {{ appConfig?.versions.cli ?? '…' }}
          </span>
          <span v-if="appConfig?.versions.vscodeExtension !== 'not-installed'" class="env-chip">
            <Icon name="code" :size="14" />
            VSCode {{ appConfig?.versions.vscodeExtension }}
          </span>
        </div>
      </header>

      <div class="stats-row">
        <div class="stat-card">
          <span class="stat-icon live"><Icon name="activity" :size="18" /></span>
          <div>
            <span class="stat-value">{{ runningCount }}</span>
            <span class="stat-label">正在执行</span>
          </div>
        </div>
        <div class="stat-card">
          <span class="stat-icon"><Icon name="list" :size="18" /></span>
          <div>
            <span class="stat-value">{{ sessions.length }}</span>
            <span class="stat-label">可用会话</span>
          </div>
        </div>
        <div class="stat-card">
          <span class="stat-icon"><Icon name="folder" :size="18" /></span>
          <div>
            <span class="stat-value">{{ projectCount }}</span>
            <span class="stat-label">最近项目</span>
          </div>
        </div>
      </div>

      <div class="home-grid">
        <section class="panel sessions-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">SESSIONS</p>
              <h2>最近的会话</h2>
            </div>
            <div class="search-box">
              <Icon name="search" :size="15" />
              <input v-model="search" placeholder="搜索标题或目录…" spellcheck="false" />
            </div>
          </div>

          <div class="session-list">
            <button
              v-for="item in filtered"
              :key="item.id"
              class="session-row"
              @click="openSession(item.id)"
            >
              <span class="status-dot" :class="statusTone(item.status)" />
              <span class="session-main">
                <span class="session-title-row">
                  <span class="session-name">{{ item.title }}</span>
                  <span
                    v-if="item.status === 'running' || item.status === 'waiting_permission'"
                    class="live-badge"
                  >运行中</span>
                  <span v-else-if="item.source === 'claude'" class="source-badge">终端</span>
                </span>
                <span class="session-meta">
                  <span>{{ prettyPath(item.cwd) }}</span>
                  <span class="dot-sep">·</span>
                  <span>{{ formatRelative(item.updatedAt) }}</span>
                  <span v-if="formatCost(item.costUsd)" class="dot-sep">·</span>
                  <span v-if="formatCost(item.costUsd)">{{ formatCost(item.costUsd) }}</span>
                </span>
              </span>
              <span class="session-status">{{ statusLabel(item.status) }}</span>
              <Icon name="chevronRight" :size="16" class="row-arrow" />
            </button>

            <div v-if="filtered.length === 0" class="empty-state">
              <span class="empty-mark"><Icon name="terminal" :size="26" /></span>
              <h3>{{ search ? '没有匹配的会话' : '还没有会话' }}</h3>
              <p>{{ search ? '换个关键词试试。' : '在右侧选择项目目录，开始第一个会话。' }}</p>
            </div>
          </div>
        </section>

        <NewSessionPanel class="home-new" />
      </div>
    </div>
  </AppShell>
</template>
