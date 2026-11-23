<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, api } from '../api';
import Icon from '../components/Icon.vue';
import { authState, ensureAuth, initTheme, loadConfig } from '../store';

const route = useRoute();
const router = useRouter();

const setup = ref(false);
const statusLoaded = ref(false);
const loadError = ref('');
const username = ref('');
const password = ref('');
const confirm = ref('');
const showPassword = ref(false);
const busy = ref(false);
const error = ref('');

function redirectTarget(): string {
  const value = route.query.redirect;
  return typeof value === 'string' && value.startsWith('/') ? value : '/';
}

async function loadStatus(): Promise<void> {
  statusLoaded.value = false;
  loadError.value = '';
  try {
    const status = await api.authStatus();
    initTheme(status.defaultTheme);
    setup.value = status.setupRequired;
    if (!status.setupRequired && status.username) username.value = status.username;
    if (authState.checked && authState.user) {
      await router.replace(redirectTarget());
    }
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : '无法连接服务';
  } finally {
    statusLoaded.value = true;
  }
}

async function submit(): Promise<void> {
  if (busy.value) return;
  error.value = '';
  if (!username.value.trim() || !password.value) {
    error.value = '请输入账号和密码';
    return;
  }
  if (setup.value) {
    if (password.value.length < 8) {
      error.value = '密码至少 8 位';
      return;
    }
    if (password.value !== confirm.value) {
      error.value = '两次输入的密码不一致';
      return;
    }
  }
  busy.value = true;
  try {
    if (setup.value) {
      await api.setup(username.value.trim(), password.value);
    } else {
      await api.login(username.value.trim(), password.value);
    }
    await ensureAuth(true);
    await loadConfig(true);
    await router.replace(redirectTarget());
  } catch (err) {
    if (err instanceof ApiError) {
      error.value = err.message;
      if (err.status === 409 && setup.value) setup.value = false;
    } else {
      error.value = '登录失败，请稍后重试';
    }
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  const authed = await ensureAuth();
  if (authed) {
    await router.replace(redirectTarget());
    return;
  }
  await loadStatus();
});
</script>

<template>
  <div class="auth-page">
    <section class="auth-intro">
      <div class="auth-brand">
        <span class="brand-mark"><Icon name="brand" :size="30" /></span>
        <span>Claude Code <em>Web</em></span>
      </div>

      <div class="auth-copy">
        <p class="eyebrow">SELF-HOSTED CONSOLE</p>
        <h1>把你的 Claude Code<br />放进浏览器。</h1>
        <p class="auth-lead">
          会话常驻服务端。刷新、切到手机、甚至关掉页面，正在执行的任务都不会中断。
        </p>
        <ul class="auth-points">
          <li><span class="point-icon"><Icon name="activity" :size="17" /></span>实时会话与执行状态</li>
          <li><span class="point-icon"><Icon name="shield" :size="17" /></span>工具审批、命令与文件 diff</li>
          <li><span class="point-icon"><Icon name="smartphone" :size="17" /></span>桌面与手机自适应布局</li>
        </ul>
      </div>

      <div class="auth-terminal" aria-hidden="true">
        <div class="term-head">
          <i /><i /><i />
          <span>claude-web · session</span>
        </div>
        <div class="term-body">
          <p><span class="term-prompt">$</span> claude "整理今天的发布记录"</p>
          <p class="term-muted">● 读取仓库 · 12 个文件</p>
          <p class="term-muted">● 运行测试 · 通过</p>
          <p><span class="term-ok">✓</span> 已生成 CHANGELOG.md<span class="term-cursor" /></p>
        </div>
      </div>

      <p class="auth-foot">自托管 · 你的机器 · 你的数据</p>
    </section>

    <section class="auth-panel">
      <div class="auth-card">
        <div class="auth-mobile-brand">
          <span class="brand-mark"><Icon name="brand" :size="28" /></span>
          <span>Claude Code <em>Web</em></span>
        </div>

        <template v-if="statusLoaded">
          <h2>{{ setup ? '初始化管理员' : '登录控制台' }}</h2>
          <p class="auth-sub">
            {{ setup ? '首次使用，请设置管理员账号。' : '使用你的管理员账号继续。' }}
          </p>

          <form class="auth-form" @submit.prevent="submit">
            <label class="field">
              <span>账号</span>
              <input
                v-model="username"
                type="text"
                autocomplete="username"
                placeholder="输入管理员账号"
                :disabled="busy"
                autofocus
              />
            </label>

            <label class="field">
              <span>密码</span>
              <span class="password-wrap">
                <input
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  :autocomplete="setup ? 'new-password' : 'current-password'"
                  placeholder="输入密码"
                  :disabled="busy"
                />
                <button
                  type="button"
                  class="password-toggle"
                  :title="showPassword ? '隐藏密码' : '显示密码'"
                  @click="showPassword = !showPassword"
                >
                  <Icon :name="showPassword ? 'eyeOff' : 'eye'" :size="17" />
                </button>
              </span>
            </label>

            <label v-if="setup" class="field">
              <span>确认密码</span>
              <input
                v-model="confirm"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="new-password"
                placeholder="再次输入密码"
                :disabled="busy"
              />
            </label>

            <p v-if="error" class="form-error"><Icon name="alert" :size="15" />{{ error }}</p>

            <button class="btn primary block auth-submit" type="submit" :disabled="busy">
              {{ busy ? '请稍候…' : setup ? '创建并进入' : '登录' }}
              <Icon v-if="!busy" name="chevronRight" :size="16" />
            </button>
          </form>

          <p v-if="setup" class="auth-note">
            账号只保存在本机 <code>data/auth.json</code>（bcrypt 哈希），不会进入 Git 仓库。
          </p>
          <p v-else class="auth-note">连续 5 次密码错误会锁定该账号 1 小时。</p>
        </template>

        <template v-else>
          <h2>连接服务</h2>
          <p class="auth-sub">正在检查登录状态…</p>
          <p v-if="loadError" class="form-error"><Icon name="alert" :size="15" />{{ loadError }}</p>
          <button v-if="loadError" class="btn secondary block" @click="loadStatus">重试</button>
        </template>
      </div>
      <p class="auth-legal">仅限授权用户。所有操作都在本机执行。</p>
    </section>
  </div>
</template>
