<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ApiError, api } from '../api';
import { t, translateServerMessage } from '../i18n';
import { toast } from '../store';
import type { VoiceConfigView, VoiceProviderId } from '../types';
import Icon from './Icon.vue';

interface FormState {
  enabled: boolean;
  model: string;
  baseUrl: string;
  language: string;
  apiKey: string;
  relayEnabled: boolean;
  relayBaseUrl: string;
  relayAuth: string;
  relayAuthHeader: string;
  appId: string;
  accessKey: string;
  resourceId: string;
  clearApiKey: boolean;
  clearAccessKey: boolean;
  clearRelayAuth: boolean;
  liveEnabled: boolean;
  liveMode: 'auto' | 'realtime' | 'segment';
  liveModel: string;
  liveUrl: string;
  liveProxyToken: string;
  clearLiveProxyToken: boolean;
}

const config = ref<VoiceConfigView | null>(null);
const active = ref<VoiceProviderId>('gemini');
const selectedProvider = ref<VoiceProviderId>('gemini');
const saving = ref<VoiceProviderId | null>(null);
const testing = ref<VoiceProviderId | null>(null);
const results = reactive<Record<string, { ok?: boolean; detail?: string; latencyMs?: number }>>({});
const liveTesting = ref<VoiceProviderId | null>(null);
const liveResults = reactive<
  Record<string, { ok?: boolean; detail?: string; latencyMs?: number }>
>({});
const openaiPresets = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
  },
  {
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
  },
  {
    label: '本地 faster-whisper',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'whisper-1',
  },
];

function applyPreset(preset: { baseUrl: string; model: string }): void {
  forms.openai.baseUrl = preset.baseUrl;
  forms.openai.model = preset.model;
}
const forms = reactive<Record<VoiceProviderId, FormState>>({
  gemini: emptyForm(),
  openai: emptyForm(),
  volcengine: emptyForm(),
  browser: emptyForm(),
});

function emptyForm(): FormState {
  return {
    enabled: false,
    model: '',
    baseUrl: '',
    language: '',
    apiKey: '',
    relayEnabled: false,
    relayBaseUrl: '',
    relayAuth: '',
    relayAuthHeader: '',
    appId: '',
    accessKey: '',
    resourceId: '',
    clearApiKey: false,
    clearAccessKey: false,
    clearRelayAuth: false,
    liveEnabled: false,
    liveMode: 'auto',
    liveModel: '',
    liveUrl: '',
    liveProxyToken: '',
    clearLiveProxyToken: false,
  };
}

function fill(id: VoiceProviderId, view: VoiceConfigView): void {
  const provider = view.providers[id];
  forms[id] = {
    enabled: provider.enabled,
    model: provider.model,
    baseUrl: provider.baseUrl,
    language: provider.language,
    apiKey: '',
    relayEnabled: provider.relayEnabled,
    relayBaseUrl: provider.relayBaseUrl,
    relayAuth: '',
    relayAuthHeader: provider.relayAuthHeader ?? '',
    appId: provider.appId,
    accessKey: '',
    resourceId: provider.resourceId,
    clearApiKey: false,
    clearAccessKey: false,
    clearRelayAuth: false,
    liveEnabled: provider.liveEnabled,
    liveMode: provider.liveMode ?? 'auto',
    liveModel: provider.liveModel,
    liveUrl: provider.liveUrl,
    liveProxyToken: '',
    clearLiveProxyToken: false,
  };
}

async function load(): Promise<void> {
  try {
    const view = await api.voiceConfig();
    config.value = view;
    active.value = view.active;
    selectedProvider.value = view.active;
    fill('gemini', view);
    fill('openai', view);
    fill('volcengine', view);
    fill('browser', view);
  } catch (err) {
    toast(err instanceof ApiError ? translateServerMessage(err.message) : t('读取语音配置失败'), 'error');
  }
}

async function save(id: VoiceProviderId): Promise<void> {
  if (saving.value) return;
  saving.value = id;
  const form = forms[id];
  const patch: Record<string, unknown> = {
    enabled: form.enabled,
    model: form.model,
    baseUrl: form.baseUrl,
    language: form.language,
    relayEnabled: form.relayEnabled,
    relayBaseUrl: form.relayBaseUrl,
    relayAuthHeader: form.relayAuthHeader,
    appId: form.appId,
    resourceId: form.resourceId,
    liveEnabled: form.liveEnabled,
    liveMode: form.liveMode,
    liveModel: form.liveModel,
    liveUrl: form.liveUrl,
  };
  if (form.apiKey.trim()) patch.apiKey = form.apiKey.trim();
  if (form.accessKey.trim()) patch.accessKey = form.accessKey.trim();
  if (form.relayAuth.trim()) patch.relayAuth = form.relayAuth.trim();
  if (form.clearApiKey) patch.clearApiKey = true;
  if (form.clearAccessKey) patch.clearAccessKey = true;
  if (form.clearRelayAuth) patch.clearRelayAuth = true;
  if (form.liveProxyToken.trim()) patch.liveProxyToken = form.liveProxyToken.trim();
  if (form.clearLiveProxyToken) patch.clearLiveProxyToken = true;
  try {
    const view = await api.updateVoiceConfig({
      active: id,
      providers: { [id]: patch },
    });
    config.value = view;
    active.value = view.active;
    selectedProvider.value = id;
    fill(id, view);
    toast(t('语音渠道已保存并设为当前'), 'success');
    delete results[id];
    delete liveResults[id];
  } catch (err) {
    toast(err instanceof ApiError ? translateServerMessage(err.message) : t('保存失败'), 'error');
  } finally {
    saving.value = null;
  }
}

async function testLive(id: VoiceProviderId): Promise<void> {
  if (liveTesting.value) return;
  liveTesting.value = id;
  delete liveResults[id];
  try {
    const result = await api.testVoiceLive(id);
    liveResults[id] = { ok: result.ok, detail: result.detail, latencyMs: result.latencyMs };
  } catch (err) {
    liveResults[id] = {
      ok: false,
      detail: err instanceof ApiError ? translateServerMessage(err.message) : t('实时连接测试失败'),
    };
  } finally {
    liveTesting.value = null;
  }
}

async function test(id: VoiceProviderId): Promise<void> {
  if (testing.value) return;
  testing.value = id;
  try {
    const result = await api.testVoice(id);
    results[id] = { ok: result.ok, detail: result.detail, latencyMs: result.latencyMs };
  } catch (err) {
    results[id] = {
      ok: false,
      detail: err instanceof ApiError ? translateServerMessage(err.message) : t('测试失败'),
    };
  } finally {
    testing.value = null;
  }
}

onMounted(load);
</script>

<template>
  <section id="voice-settings" class="panel settings-section">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">VOICE INPUT</p>
        <h2>{{ t('语音识别') }}</h2>
      </div>
      <span class="panel-hint">{{ t('可插拔渠道') }}</span>
    </div>

    <p class="section-lead">
      {{ t('在这里配置一次渠道即可；聊天输入框的麦克风会直接开始/结束听写，不再弹出配置面板。Gemini 可以在支持的地区直连，也可以通过 HTTPS 中转访问；OpenAI 兼容渠道适合 Whisper 类服务；浏览器内置识别不经过服务端。') }}
    </p>

    <div v-if="!config" class="settings-loading"><span class="spinner" />{{ t('读取配置…') }}</div>

    <template v-else>
      <div class="provider-tabs" role="tablist" :aria-label="t('语音渠道')">
        <button
          v-for="id in (['gemini', 'openai', 'volcengine', 'browser'] as VoiceProviderId[])"
          :key="id"
          type="button"
          class="provider-tab"
          :class="{ active: selectedProvider === id }"
          role="tab"
          :aria-selected="selectedProvider === id"
          @click="selectedProvider = id"
        >
          <span>{{ t(config.builtin[id]?.label ?? id) }}</span>
          <span v-if="active === id" class="provider-tab-current">{{ t('当前') }}</span>
        </button>
      </div>

      <div class="provider-grid single">
        <article
          v-for="id in [selectedProvider]"
          :key="id"
          class="provider-card"
          :class="{ current: active === id }"
          role="tabpanel"
        >
          <header class="provider-head">
            <div>
              <h3>{{ t(config.builtin[id]?.label ?? id) }}</h3>
              <span v-if="active === id" class="current-badge">{{ t('当前使用') }}</span>
            </div>
            <label class="switch-row">
              <input v-model="forms[id].enabled" type="checkbox" />
              <span>{{ t('启用') }}</span>
            </label>
          </header>

          <p class="provider-docs">
            <a :href="config.builtin[id]?.docs" target="_blank" rel="noopener noreferrer">
              {{ t('文档') }}
              <Icon name="external" :size="12" />
            </a>
          </p>

          <template v-if="id !== 'browser'">
            <div v-if="id === 'openai'" class="preset-row">
              <span class="mini-label">{{ t('快速预设') }}</span>
              <button
                v-for="preset in openaiPresets"
                :key="preset.label"
                class="preset-chip"
                @click="applyPreset(preset)"
              >
                {{ t(preset.label) }}
              </button>
            </div>

            <label class="field">
              <span>API Key {{ config.providers[id].hasApiKey ? `(${t('已保存')} ${config.providers[id].apiKeyHint})` : '' }}</span>
              <input
                v-model="forms[id].apiKey"
                type="password"
                :placeholder="config.providers[id].hasApiKey ? t('留空表示不修改') : t('输入 API Key')"
                autocomplete="off"
              />
            </label>
            <label v-if="config.providers[id].hasApiKey" class="clear-row">
              <input v-model="forms[id].clearApiKey" type="checkbox" />
              {{ t('清除已保存的 API Key') }}
            </label>

            <template v-if="id === 'volcengine'">
              <div class="grid-2">
                <label class="field">
                  <span>App ID</span>
                  <input v-model="forms[id].appId" :placeholder="t('火山引擎 App ID')" spellcheck="false" />
                </label>
                <label class="field">
                  <span>Access Key {{ config.providers[id].hasAccessKey ? `(${t('已保存')} ${config.providers[id].accessKeyHint})` : '' }}</span>
                  <input
                    v-model="forms[id].accessKey"
                    type="password"
                    :placeholder="config.providers[id].hasAccessKey ? t('留空表示不修改') : 'Access Token'"
                    autocomplete="off"
                  />
                </label>
              </div>
              <label v-if="config.providers[id].hasAccessKey" class="clear-row">
                <input v-model="forms[id].clearAccessKey" type="checkbox" />
                {{ t('清除已保存的 Access Key') }}
              </label>
              <label class="field">
                <span>Resource ID</span>
                <input
                  v-model="forms[id].resourceId"
                  placeholder="volc.bigasr.sauc.duration"
                  spellcheck="false"
                />
              </label>
              <p class="provider-inline-note">
                {{ t('整段转写时服务端用 ffmpeg 把浏览器录音转成 16kHz PCM；开启实时流式后直接走 WebSocket，不需要 ffmpeg。') }}
              </p>
            </template>

            <div class="grid-2">
              <label class="field">
                <span>{{ t('模型') }}</span>
                <input v-model="forms[id].model" list="voice-models" spellcheck="false" />
              </label>
              <label class="field">
                <span>{{ t('语言') }}</span>
                <input v-model="forms[id].language" placeholder="zh-CN / zh / en" spellcheck="false" />
              </label>
            </div>
            <label class="field">
              <span>{{ t('API 地址') }}</span>
              <input v-model="forms[id].baseUrl" spellcheck="false" />
            </label>

            <template v-if="id === 'gemini'">
              <label class="switch-row relay-toggle">
                <input v-model="forms[id].relayEnabled" type="checkbox" />
                <span>{{ t('通过 HTTPS 中转访问（自建反代或网关）') }}</span>
              </label>
              <template v-if="forms[id].relayEnabled">
                <label class="field">
                  <span>{{ t('中转根地址') }}</span>
                  <input
                    v-model="forms[id].relayBaseUrl"
                    placeholder="https://relay.example.com/google-ai-studio"
                    spellcheck="false"
                  />
                </label>
                <label class="field">
                  <span>{{ t('中转鉴权头名称') }}</span>
                  <input
                    v-model="forms[id].relayAuthHeader"
                    :placeholder="t('Authorization（默认）')"
                    spellcheck="false"
                  />
                </label>
                <label class="field">
                  <span>{{ t('中转鉴权值') }} {{ config.providers[id].hasRelayAuth ? `（已保存 ${config.providers[id].relayAuthHint}）` : '' }}</span>
                  <input
                    v-model="forms[id].relayAuth"
                    type="password"
                    :placeholder="config.providers[id].hasRelayAuth ? '留空表示不修改' : 'Bearer <token>'"
                    autocomplete="off"
                  />
                </label>
                <label v-if="config.providers[id].hasRelayAuth" class="clear-row">
                  <input v-model="forms[id].clearRelayAuth" type="checkbox" />
                  {{ t('清除已保存的中转鉴权') }}
                </label>
              </template>
            </template>

            <div class="live-block">
                <label class="switch-row">
                  <input v-model="forms[id].liveEnabled" type="checkbox" />
                  <span>{{ t('实时流式识别（边说边写）') }}</span>
                </label>
                <p class="provider-inline-note">
{{ t('聊天框麦克风会边说边把文字写进输入框。Gemini Live 需要支持地区的 WebSocket 中转；普通 HTTP 网关通常不支持 Live WS。') }}
{{ t('OpenAI 官方走 Realtime WebSocket；其它 OpenAI 兼容服务默认使用分段实时（静音断句后立即转写），两者都无需额外配置 ffmpeg。') }}
{{ t('直接复用上面的 App ID / Access Key / Resource ID，通过火山引擎流式 WebSocket 边说边写，16kHz PCM 不再经过 ffmpeg。') }}
                </p>
                <template v-if="forms[id].liveEnabled">
                  <template v-if="id === 'openai'">
                    <div class="grid-2">
                      <label class="field">
                        <span>{{ t('实时模式') }}</span>
                        <select v-model="forms[id].liveMode" class="text-input">
                          <option value="auto">{{ t('自动（官方 Realtime / 其它分段）') }}</option>
                          <option value="realtime">Realtime WebSocket</option>
                          <option value="segment">{{ t('分段 HTTP 转写') }}</option>
                        </select>
                      </label>
                      <label class="field">
                        <span>{{ t('实时模型') }}</span>
                        <input
                          v-model="forms[id].liveModel"
                          list="voice-models"
                          placeholder="gpt-4o-transcribe"
                          spellcheck="false"
                        />
                      </label>
                    </div>
                    <label class="field">
                      <span>Realtime 地址</span>
                      <input
                        v-model="forms[id].liveUrl"
                        placeholder="wss://api.openai.com/v1/realtime?intent=transcription"
                        spellcheck="false"
                      />
                    </label>
                  </template>
                  <div v-else class="grid-2">
                    <label class="field">
                      <span>{{ t('实时模型') }}</span>
                      <input
                        v-model="forms[id].liveModel"
                        :placeholder="id === 'gemini' ? 'gemini-3.5-transcribe-live' : 'bigmodel'"
                        spellcheck="false"
                      />
                    </label>
                    <label class="field">
                      <span>{{ t('实时地址') }}</span>
                      <input
                        v-model="forms[id].liveUrl"
                        :placeholder="id === 'gemini' ? 'wss://host/ws/…BidiGenerateContent' : 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'"
                        spellcheck="false"
                      />
                    </label>
                  </div>
                  <template v-if="id === 'gemini'">
                    <label class="field">
                      <span>{{ t('中转 Token') }} {{ config.providers[id].hasLiveProxyToken ? `（已保存 ${config.providers[id].liveProxyTokenHint}）` : '' }}</span>
                      <input
                        v-model="forms[id].liveProxyToken"
                        type="password"
                        :placeholder="config.providers[id].hasLiveProxyToken ? t('留空表示不修改') : t('内部中转 Token（可选）')"
                        autocomplete="off"
                      />
                    </label>
                    <label v-if="config.providers[id].hasLiveProxyToken" class="clear-row">
                      <input v-model="forms[id].clearLiveProxyToken" type="checkbox" />
                      {{ t('清除已保存的中转 Token') }}
                    </label>
                  </template>
                  <div class="live-test-row">
                    <button
                      class="btn secondary small"
                      :disabled="liveTesting !== null"
                      @click="testLive(id)"
                    >
                      <span v-if="liveTesting === id" class="spinner tiny" />
                      {{ t('测试实时连接') }}
                    </button>
                    <span class="provider-inline-note">{{ t('测试使用已保存配置，请先保存。') }}</span>
                  </div>
                  <p
                    v-if="liveResults[id]"
                    class="test-result"
                    :class="{ error: liveResults[id].ok === false }"
                  >
                    <Icon :name="liveResults[id].ok === false ? 'alert' : 'check'" :size="14" />
                    {{ liveResults[id].detail }}
                    <span v-if="liveResults[id].latencyMs !== undefined">（{{ liveResults[id].latencyMs }}ms）</span>
                  </p>
                  <p v-if="!config.providers[id].liveAvailable" class="provider-inline-note">
                    {{ config.providers[id].liveDetail }}{{ t('；保存后生效。') }}
                  </p>
                  <p v-else class="provider-inline-note">
                    {{ config.providers[id].liveDetail }}{{ t('。') }}
                  </p>
                </template>
              </div>

            <datalist id="voice-models">
              <option v-for="model in config.builtin[id]?.models ?? []" :key="model" :value="model" />
            </datalist>
          </template>

<p v-else class="browser-note">{{ t('使用浏览器自带的 SpeechRecognition，不需要 API Key。兼容性取决于浏览器，桌面 Chrome 支持较好，移动端表现不一。') }}</p>

          <div class="provider-actions">
            <button class="btn secondary small" :disabled="testing !== null" @click="test(id)">
              <span v-if="testing === id" class="spinner tiny" />
              {{ t('测试连接') }}
            </button>
            <button class="btn primary small" :disabled="saving !== null" @click="save(id)">
              {{ saving === id ? t('保存中…') : t('保存并设为当前') }}
            </button>
          </div>
          <p
            v-if="results[id]"
            class="test-result"
            :class="{ error: results[id].ok === false }"
          >
            <Icon :name="results[id].ok === false ? 'alert' : 'check'" :size="14" />
            {{ results[id].detail }}
            <span v-if="results[id].latencyMs !== undefined">（{{ results[id].latencyMs }}ms）</span>
          </p>
        </article>
      </div>

<p class="section-note">{{ t('Key 只保存在本机') }} <code>data/voice.json</code>{{ t('（0600），不会进入 Git 仓库；页面不会回显完整 Key。') }}</p>
    </template>
  </section>
</template>
