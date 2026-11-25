<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, api } from '../api';
import Icon from '../components/Icon.vue';
import { locale, t, toggleLocale, translateServerMessage } from '../i18n';
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

const step = ref<'credentials' | 'email'>('credentials');
const challengeId = ref('');
const emailHint = ref('');
const code = ref('');
const resendAt = ref(0);
const now = ref(Date.now());
const codeBusy = ref(false);
const resendBusy = ref(false);
let clockTimer: number | undefined;

const resendLeft = computed(() => Math.max(0, Math.ceil((resendAt.value - now.value) / 1000)));

function redirectTarget(): string {
  const value = route.query.redirect;
  return typeof value === 'string' && value.startsWith('/') ? value : '/';
}

async function finishLogin(): Promise<void> {
  await ensureAuth(true);
  await loadConfig(true);
  await router.replace(redirectTarget());
}

async function loadStatus(): Promise<void> {
  statusLoaded.value = false;
  loadError.value = '';
  try {
    const status = await api.authStatus();
    initTheme(status.defaultTheme);
    setup.value = status.setupRequired;
    if (authState.checked && authState.user) {
      await router.replace(redirectTarget());
    }
  } catch (err) {
    loadError.value = err instanceof ApiError ? translateServerMessage(err.message) : t('无法连接服务');
  } finally {
    statusLoaded.value = true;
  }
}

async function submit(): Promise<void> {
  if (busy.value) return;
  error.value = '';
  if (!username.value.trim() || !password.value) {
    error.value = t('请输入账号和密码');
    return;
  }
  if (setup.value) {
    if (password.value.length < 8) {
      error.value = t('密码至少 8 位');
      return;
    }
    if (password.value !== confirm.value) {
      error.value = t('两次输入的密码不一致');
      return;
    }
  }
  busy.value = true;
  try {
    if (setup.value) {
      await api.setup(username.value.trim(), password.value);
      await finishLogin();
      return;
    }
    const result = await api.login(username.value.trim(), password.value);
    if (result.twoFactorRequired) {
      if (!result.challengeId) throw new Error('missing challenge');
      step.value = 'email';
      challengeId.value = result.challengeId;
      emailHint.value = result.emailHint ?? '';
      code.value = '';
      resendAt.value = Date.now() + (result.resendAfterMs ?? 60_000);
      return;
    }
    await finishLogin();
  } catch (err) {
    if (err instanceof ApiError) {
      error.value = translateServerMessage(err.message);
      if (err.status === 409 && setup.value) setup.value = false;
    } else {
      error.value = t('登录失败，请稍后重试');
    }
  } finally {
    busy.value = false;
  }
}

async function verifyCode(): Promise<void> {
  if (codeBusy.value) return;
  error.value = '';
  if (!/^\d{6}$/.test(code.value.trim())) {
    error.value = t('请输入 6 位邮箱验证码');
    return;
  }
  codeBusy.value = true;
  try {
    await api.verifyEmail(challengeId.value, code.value.trim());
    await finishLogin();
  } catch (err) {
    error.value = err instanceof ApiError ? translateServerMessage(err.message) : t('验证失败，请重试');
  } finally {
    codeBusy.value = false;
  }
}

async function resendCode(): Promise<void> {
  if (resendBusy.value || resendLeft.value > 0) return;
  error.value = '';
  resendBusy.value = true;
  try {
    const result = await api.resendEmail(challengeId.value);
    emailHint.value = result.emailHint;
    resendAt.value = Date.now() + result.resendAfterMs;
  } catch (err) {
    error.value = err instanceof ApiError ? translateServerMessage(err.message) : t('发送失败，请重试');
  } finally {
    resendBusy.value = false;
  }
}

function backToPassword(): void {
  step.value = 'credentials';
  challengeId.value = '';
  code.value = '';
  password.value = '';
  error.value = '';
}

onMounted(async () => {
  clockTimer = window.setInterval(() => (now.value = Date.now()), 1000);
  const authed = await ensureAuth();
  if (authed) {
    await router.replace(redirectTarget());
    return;
  }
  await loadStatus();
});

onUnmounted(() => {
  if (clockTimer) window.clearInterval(clockTimer);
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
        <h1>{{ t('把你的 Claude Code') }}<br />{{ t('放进浏览器。') }}</h1>
        <p class="auth-lead">
          {{ t('会话常驻服务端。刷新、切到手机、甚至关掉页面，正在执行的任务都不会中断。') }}
        </p>
        <ul class="auth-points">
          <li><span class="point-icon"><Icon name="activity" :size="17" /></span>{{ t('实时会话与执行状态') }}</li>
          <li><span class="point-icon"><Icon name="shield" :size="17" /></span>{{ t('工具审批、命令与文件 diff') }}</li>
          <li><span class="point-icon"><Icon name="smartphone" :size="17" /></span>{{ t('桌面与手机自适应布局') }}</li>
        </ul>
      </div>

      <div class="auth-terminal" aria-hidden="true">
        <div class="term-head">
          <i /><i /><i />
          <span>claude-web · session</span>
        </div>
        <div class="term-body">
          <p><span class="term-prompt">$</span> claude "{{ t('整理今天的发布记录') }}"</p>
          <p class="term-muted">● {{ t('读取仓库 · 12 个文件') }}</p>
          <p class="term-muted">● {{ t('运行测试 · 通过') }}</p>
          <p><span class="term-ok">✓</span> {{ t('已生成 CHANGELOG.md') }}<span class="term-cursor" /></p>
        </div>
      </div>

      <p class="auth-foot">{{ t('自托管 · 你的机器 · 你的数据') }}</p>
    </section>

    <section class="auth-panel">
      <div class="auth-card">
        <button class="auth-lang" type="button" :title="t('切换语言')" @click="toggleLocale">
          {{ locale === 'zh' ? 'English' : '中文' }}
        </button>
        <div class="auth-mobile-brand">
          <span class="brand-mark"><Icon name="brand" :size="28" /></span>
          <span>Claude Code <em>Web</em></span>
        </div>

        <template v-if="statusLoaded">
          <h2>{{ step === 'email' ? t('邮箱验证') : setup ? t('初始化管理员') : t('登录控制台') }}</h2>
          <p class="auth-sub">
            {{
              step === 'email'
                ? t('验证码已发送到 {email}', { email: emailHint })
                : setup
                  ? t('首次使用，请设置管理员账号。')
                  : t('使用你的管理员账号继续。')
            }}
          </p>

          <form v-if="step === 'credentials'" class="auth-form" @submit.prevent="submit">
            <label class="field">
              <span>{{ t('账号') }}</span>
              <input
                v-model="username"
                type="text"
                autocomplete="username"
                :placeholder="t('输入管理员账号')"
                :disabled="busy"
                autofocus
              />
            </label>

            <label class="field">
              <span>{{ t('密码') }}</span>
              <span class="password-wrap">
                <input
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  :autocomplete="setup ? 'new-password' : 'current-password'"
                  :placeholder="t('输入密码')"
                  :disabled="busy"
                />
                <button
                  type="button"
                  class="password-toggle"
                  :title="showPassword ? t('隐藏密码') : t('显示密码')"
                  @click="showPassword = !showPassword"
                >
                  <Icon :name="showPassword ? 'eyeOff' : 'eye'" :size="17" />
                </button>
              </span>
            </label>

            <label v-if="setup" class="field">
              <span>{{ t('确认密码') }}</span>
              <input
                v-model="confirm"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="new-password"
                :placeholder="t('再次输入密码')"
                :disabled="busy"
              />
            </label>

            <p v-if="error" class="form-error"><Icon name="alert" :size="15" />{{ error }}</p>

            <button class="btn primary block auth-submit" type="submit" :disabled="busy">
              {{ busy ? t('请稍候…') : setup ? t('创建并进入') : t('登录') }}
              <Icon v-if="!busy" name="chevronRight" :size="16" />
            </button>
          </form>

          <form v-else class="auth-form" @submit.prevent="verifyCode">
            <label class="field">
              <span>{{ t('邮箱验证码') }}</span>
              <input
                v-model="code"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="6"
                pattern="[0-9]*"
                :placeholder="t('输入 6 位验证码')"
                :disabled="codeBusy"
                autofocus
              />
            </label>

            <p v-if="error" class="form-error"><Icon name="alert" :size="15" />{{ error }}</p>

            <button class="btn primary block auth-submit" type="submit" :disabled="codeBusy">
              {{ codeBusy ? t('验证中…') : t('验证并登录') }}
              <Icon v-if="!codeBusy" name="chevronRight" :size="16" />
            </button>

            <div class="auth-actions">
              <button
                type="button"
                class="btn ghost small"
                :disabled="resendBusy || resendLeft > 0"
                @click="resendCode"
              >
                {{
                  resendLeft > 0
                    ? t('重新发送（{n} 秒）', { n: resendLeft })
                    : resendBusy
                      ? t('发送中…')
                      : t('重新发送验证码')
                }}
              </button>
              <button type="button" class="btn ghost small" @click="backToPassword">
                {{ t('返回密码登录') }}
              </button>
            </div>
          </form>

          <p v-if="step === 'email'" class="auth-note">
            {{ t('验证码 10 分钟内有效，只能使用一次；没收到请检查垃圾邮件。') }}
          </p>
          <p v-else-if="setup" class="auth-note">
            {{ t('账号只保存在本机') }} <code>data/auth.json</code>{{ t('（bcrypt 哈希），不会进入 Git 仓库。') }}
          </p>
          <p v-else class="auth-note">{{ t('连续 5 次密码错误会锁定该账号 1 小时。') }}</p>
        </template>

        <template v-else>
          <h2>{{ t('连接服务') }}</h2>
          <p class="auth-sub">{{ t('正在检查登录状态…') }}</p>
          <p v-if="loadError" class="form-error"><Icon name="alert" :size="15" />{{ loadError }}</p>
          <button v-if="loadError" class="btn secondary block" @click="loadStatus">{{ t('重试') }}</button>
        </template>
      </div>
      <p class="auth-legal">{{ t('仅限授权用户。所有操作都在本机执行。') }}</p>
    </section>
  </div>
</template>

<style scoped>
.auth-card {
  position: relative;
}

.auth-lang {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 2;
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-soft);
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
}

.auth-lang:hover {
  border-color: var(--accent-line);
  color: var(--accent);
}
</style>
