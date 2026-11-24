import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import WebSocket from 'ws';
import { config } from './config.js';
import { atomicWriteJson, HttpError, readJson } from './util.js';

export type VoiceProviderId = 'gemini' | 'openai' | 'volcengine' | 'browser';
export type VoiceLiveMode = 'auto' | 'realtime' | 'segment';

export interface VoiceProviderConfig {
  enabled?: boolean;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  language?: string;
  relayEnabled?: boolean;
  relayBaseUrl?: string;
  relayAuth?: string;
  relayAuthHeader?: string;
  appId?: string;
  accessKey?: string;
  resourceId?: string;
  liveEnabled?: boolean;
  liveModel?: string;
  liveUrl?: string;
  liveProxyToken?: string;
  /** OpenAI-compatible providers: auto -> official OpenAI uses Realtime,
   *  everything else uses segmented HTTP transcription. */
  liveMode?: VoiceLiveMode;
}

let voiceProxyAgent: ProxyAgent | undefined;

/** Use the optional local egress proxy for voice provider HTTP calls. */
function voiceFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!config.voiceProxyUrl) return fetch(url, init);
  voiceProxyAgent ??= new ProxyAgent(config.voiceProxyUrl);
  return undiciFetch(url, {
    ...(init as Record<string, unknown>),
    dispatcher: voiceProxyAgent,
  } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

export interface GeminiLiveSettings {
  enabled: boolean;
  url: string;
  token: string;
  model: string;
  apiKey: string;
}

export function geminiLiveSettings(): GeminiLiveSettings {
  const gemini = getVoiceConfig().providers.gemini ?? {};
  const rawUrl = (gemini.liveUrl || config.geminiLiveUrl || '').trim();
  const url = normalizeLiveUrl(rawUrl);
  return {
    enabled: gemini.liveEnabled === true,
    url,
    token: (gemini.liveProxyToken || config.geminiLiveProxyToken || '').trim(),
    model: (gemini.liveModel || config.geminiLiveModel || 'gemini-3.5-transcribe-live')
      .trim()
      .replace(/^models\//, ''),
    apiKey: (gemini.apiKey || '').trim(),
  };
}

function normalizeLiveUrl(value: string): string {
  if (!value) return '';
  let url = value.trim();
  if (url.startsWith('https://')) url = `wss://${url.slice('https://'.length)}`;
  else if (url.startsWith('http://')) url = `ws://${url.slice('http://'.length)}`;
  else if (!url.startsWith('wss://') && !url.startsWith('ws://')) url = `wss://${url}`;
  const livePath =
    '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  try {
    const parsed = new URL(url);
    if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = livePath;
    return parsed.toString();
  } catch {
    return url;
  }
}

export interface OpenAILiveSettings {
  enabled: boolean;
  mode: 'realtime' | 'segment';
  url: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  language: string;
}

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

function isOfficialOpenAI(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function normalizeRealtimeUrl(value: string): string {
  if (!value) return '';
  let url = value.trim();
  if (url.startsWith('https://')) url = `wss://${url.slice('https://'.length)}`;
  else if (url.startsWith('http://')) url = `ws://${url.slice('http://'.length)}`;
  else if (!url.startsWith('wss://') && !url.startsWith('ws://')) url = `wss://${url}`;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('intent') && !parsed.searchParams.has('model')) {
      parsed.searchParams.set('intent', 'transcription');
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function openaiLiveSettings(): OpenAILiveSettings {
  const cfg = getVoiceConfig().providers.openai ?? {};
  const baseUrl = baseUrlOf(cfg.baseUrl, 'https://api.openai.com/v1');
  const rawMode = cfg.liveMode;
  const mode: 'realtime' | 'segment' =
    rawMode === 'realtime' || rawMode === 'segment'
      ? rawMode
      : cfg.liveUrl || isOfficialOpenAI(baseUrl)
        ? 'realtime'
        : 'segment';
  const url =
    mode === 'realtime'
      ? normalizeRealtimeUrl(cfg.liveUrl || (isOfficialOpenAI(baseUrl) ? OPENAI_REALTIME_URL : ''))
      : '';
  return {
    enabled: cfg.liveEnabled === true,
    mode,
    url,
    model: (cfg.liveModel || 'gpt-4o-transcribe').trim(),
    apiKey: (cfg.apiKey || '').trim(),
    baseUrl,
    language: (cfg.language || '').trim(),
  };
}

export interface VolcengineLiveSettings {
  enabled: boolean;
  url: string;
  model: string;
  apiKey: string;
  appId: string;
  accessKey: string;
  resourceId: string;
}

export function volcengineLiveSettings(): VolcengineLiveSettings {
  const cfg = getVoiceConfig().providers.volcengine ?? {};
  return {
    enabled: cfg.liveEnabled === true,
    url: (
      cfg.liveUrl || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'
    ).trim(),
    model: (cfg.liveModel || cfg.model || 'bigmodel').trim(),
    apiKey: (cfg.apiKey || '').trim(),
    appId: (cfg.appId || '').trim(),
    accessKey: (cfg.accessKey || '').trim(),
    resourceId: (cfg.resourceId || 'volc.bigasr.sauc.duration').trim(),
  };
}

export interface LiveAvailability {
  available: boolean;
  mode: 'realtime' | 'segment' | '';
  detail: string;
}

export function liveAvailability(provider: VoiceProviderId): LiveAvailability {
  if (provider === 'gemini') {
    const settings = geminiLiveSettings();
    return {
      available: !!settings.url && !!settings.apiKey,
      mode: 'realtime',
      detail: settings.url
        ? 'Gemini Live WebSocket 中转已配置'
        : '未配置 Gemini Live 中转地址',
    };
  }
  if (provider === 'openai') {
    const settings = openaiLiveSettings();
    if (settings.mode === 'segment') {
      return {
        available: !!settings.apiKey && !!settings.baseUrl,
        mode: 'segment',
        detail: '分段实时：使用 OpenAI 兼容 HTTP 转写端点',
      };
    }
    return {
      available: !!settings.apiKey && !!settings.url,
      mode: 'realtime',
      detail: settings.url
        ? 'Realtime WebSocket 已配置'
        : '未配置 Realtime 地址；请在设置中填写或改用分段实时',
    };
  }
  if (provider === 'volcengine') {
    const settings = volcengineLiveSettings();
    const hasAuth = !!settings.apiKey || (!!settings.appId && !!settings.accessKey);
    return {
      available: hasAuth && !!settings.url,
      mode: 'realtime',
      detail: settings.url
        ? '火山引擎流式 WebSocket 已配置'
        : '未配置火山引擎流式地址',
    };
  }
  return { available: false, mode: '', detail: '浏览器内置识别在客户端运行' };
}

interface VoiceFile {
  version: 1;
  active: VoiceProviderId;
  providers: Record<string, VoiceProviderConfig>;
}

const PROVIDERS: VoiceProviderId[] = ['gemini', 'openai', 'volcengine', 'browser'];

function defaults(): VoiceFile {
  return {
    version: 1,
    active: 'gemini',
    providers: {
      gemini: {
        enabled: true,
        model: 'gemini-3.5-transcribe',
        baseUrl: 'https://generativelanguage.googleapis.com',
        language: 'zh-CN',
        relayEnabled: false,
        relayBaseUrl: '',
        relayAuth: '',
        relayAuthHeader: '',
        liveEnabled: false,
        liveModel: 'gemini-3.5-transcribe-live',
        liveUrl: '',
        liveProxyToken: '',
        liveMode: 'realtime',
      },
      openai: {
        enabled: false,
        model: 'whisper-1',
        baseUrl: 'https://api.openai.com/v1',
        language: 'zh',
        liveEnabled: false,
        liveMode: 'auto',
        liveModel: 'gpt-4o-transcribe',
        liveUrl: '',
      },
      volcengine: {
        enabled: false,
        model: 'bigmodel',
        baseUrl: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream',
        resourceId: 'volc.bigasr.sauc.duration',
        appId: '',
        accessKey: '',
        language: 'zh-CN',
        liveEnabled: false,
        liveMode: 'realtime',
        liveModel: 'bigmodel',
        liveUrl: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
      },
      browser: {
        enabled: true,
        language: 'zh-CN',
      },
    },
  };
}

let cache: VoiceFile | null = null;

function voiceFile(): string {
  return path.join(config.dataDir, 'voice.json');
}

export function getVoiceConfig(): VoiceFile {
  if (cache) return cache;
  const parsed = readJson<VoiceFile | null>(voiceFile(), null);
  const base = defaults();
  if (parsed?.providers && typeof parsed.providers === 'object') {
    for (const id of PROVIDERS) {
      if (parsed.providers[id] && typeof parsed.providers[id] === 'object') {
        base.providers[id] = { ...base.providers[id], ...parsed.providers[id] };
      }
    }
    if (PROVIDERS.includes(parsed.active)) base.active = parsed.active;
  }
  cache = base;
  return base;
}

function save(file: VoiceFile): void {
  cache = file;
  atomicWriteJson(voiceFile(), file);
}

function hint(secret?: string): string {
  if (!secret) return '';
  return secret.length <= 4 ? '••••' : `••••${secret.slice(-4)}`;
}

export function maskedVoiceConfig(): Record<string, unknown> {
  const file = getVoiceConfig();
  const providers: Record<string, unknown> = {};
  for (const id of PROVIDERS) {
    const cfg = file.providers[id] ?? {};
    const availability = liveAvailability(id);
    providers[id] = {
      enabled: cfg.enabled === true,
      model: cfg.model ?? '',
      baseUrl: cfg.baseUrl ?? '',
      language: cfg.language ?? '',
      relayEnabled: cfg.relayEnabled === true,
      relayBaseUrl: cfg.relayBaseUrl ?? '',
      appId: cfg.appId ?? '',
      resourceId: cfg.resourceId ?? '',
      hasApiKey: !!cfg.apiKey,
      apiKeyHint: hint(cfg.apiKey),
      hasAccessKey: !!cfg.accessKey,
      accessKeyHint: hint(cfg.accessKey),
      hasRelayAuth: !!cfg.relayAuth,
      relayAuthHint: hint(cfg.relayAuth),
      relayAuthHeader: cfg.relayAuthHeader ?? '',
      liveEnabled: cfg.liveEnabled === true,
      liveMode: cfg.liveMode ?? 'auto',
      liveModeResolved: availability.mode,
      liveModel: cfg.liveModel ?? '',
      liveUrl: cfg.liveUrl ?? '',
      hasLiveProxyToken: !!cfg.liveProxyToken,
      liveProxyTokenHint: hint(cfg.liveProxyToken),
      liveAvailable: availability.available,
      liveDetail: availability.detail,
    };
  }
  return {
    active: file.active,
    providers,
    builtin: {
      gemini: {
        label: 'Google Gemini',
        models: [
          'gemini-3.5-transcribe',
          'gemini-3.5-transcribe-live',
          'gemini-3.8-flash',
        ],
        docs: 'https://ai.google.dev/gemini-api/docs/audio',
      },
      openai: {
        label: 'OpenAI 兼容',
        models: [
          'whisper-1',
          'gpt-4o-transcribe',
          'gpt-4o-mini-transcribe',
          'gpt-live-transcribe',
          'gpt-realtime-whisper',
        ],
        docs: 'https://platform.openai.com/docs/guides/speech-to-text',
      },
      volcengine: {
        label: '字节火山引擎',
        models: ['bigmodel'],
        docs: 'https://www.volcengine.com/docs/6561/1354868',
      },
      browser: {
        label: '浏览器内置',
        models: [],
        docs: 'https://developer.mozilla.org/docs/Web/API/Web_Speech_API',
      },
    },
  };
}

interface UpdateInput {
  active?: unknown;
  providers?: Record<string, unknown>;
}

export function updateVoiceConfig(input: UpdateInput): Record<string, unknown> {
  const file = getVoiceConfig();
  if (typeof input.active === 'string' && PROVIDERS.includes(input.active as VoiceProviderId)) {
    file.active = input.active as VoiceProviderId;
  }
  if (input.providers && typeof input.providers === 'object') {
    for (const id of PROVIDERS) {
      const patch = input.providers[id];
      if (!patch || typeof patch !== 'object') continue;
      const row = patch as Record<string, unknown>;
      const next: VoiceProviderConfig = { ...(file.providers[id] ?? {}) };
      if (typeof row.enabled === 'boolean') next.enabled = row.enabled;
      if (typeof row.model === 'string') next.model = row.model.trim();
      if (typeof row.baseUrl === 'string') next.baseUrl = row.baseUrl.trim();
      if (typeof row.language === 'string') next.language = row.language.trim();
      if (typeof row.relayEnabled === 'boolean') next.relayEnabled = row.relayEnabled;
      if (typeof row.relayBaseUrl === 'string') next.relayBaseUrl = row.relayBaseUrl.trim();
      if (typeof row.appId === 'string') next.appId = row.appId.trim();
      if (typeof row.resourceId === 'string') next.resourceId = row.resourceId.trim();
      if (typeof row.apiKey === 'string' && row.apiKey.trim()) next.apiKey = row.apiKey.trim();
      if (row.clearApiKey === true) delete next.apiKey;
      if (typeof row.accessKey === 'string' && row.accessKey.trim()) next.accessKey = row.accessKey.trim();
      if (row.clearAccessKey === true) delete next.accessKey;
      if (typeof row.relayAuth === 'string' && row.relayAuth.trim()) next.relayAuth = row.relayAuth.trim();
      if (row.clearRelayAuth === true) delete next.relayAuth;
      if (typeof row.relayAuthHeader === 'string') next.relayAuthHeader = row.relayAuthHeader.trim();
      if (typeof row.liveEnabled === 'boolean') next.liveEnabled = row.liveEnabled;
      if (row.liveMode === 'auto' || row.liveMode === 'realtime' || row.liveMode === 'segment') {
        next.liveMode = row.liveMode;
      }
      if (typeof row.liveModel === 'string') next.liveModel = row.liveModel.trim();
      if (typeof row.liveUrl === 'string') next.liveUrl = row.liveUrl.trim();
      if (typeof row.liveProxyToken === 'string' && row.liveProxyToken.trim()) {
        next.liveProxyToken = row.liveProxyToken.trim();
      }
      if (row.clearLiveProxyToken === true) delete next.liveProxyToken;
      file.providers[id] = next;
    }
  }
  save(file);
  return maskedVoiceConfig();
}

export interface VoiceResult {
  text: string;
  provider: VoiceProviderId;
  model: string;
  latencyMs: number;
}

function baseUrlOf(value: string | undefined, fallback: string): string {
  const base = (value || fallback).trim().replace(/\/+$/, '');
  return base;
}

function geminiRequest(cfg: VoiceProviderConfig): { url: string; headers: Record<string, string> } {
  const relay = cfg.relayEnabled === true && !!cfg.relayBaseUrl;
  const base = baseUrlOf(relay ? cfg.relayBaseUrl : cfg.baseUrl, 'https://generativelanguage.googleapis.com');
  const model = encodeURIComponent(cfg.model || 'gemini-3.5-transcribe');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['x-goog-api-key'] = cfg.apiKey;
  if (relay && cfg.relayAuth) {
    const authHeader = (cfg.relayAuthHeader || 'Authorization').trim();
    if (/^[A-Za-z0-9-]+$/.test(authHeader)) headers[authHeader] = cfg.relayAuth;
  }
  return { url: `${base}/v1beta/models/${model}:generateContent`, headers };
}

function geminiModelsUrl(cfg: VoiceProviderConfig): { url: string; headers: Record<string, string> } {
  const relay = cfg.relayEnabled === true && !!cfg.relayBaseUrl;
  const base = baseUrlOf(relay ? cfg.relayBaseUrl : cfg.baseUrl, 'https://generativelanguage.googleapis.com');
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers['x-goog-api-key'] = cfg.apiKey;
  if (relay && cfg.relayAuth) {
    const authHeader = (cfg.relayAuthHeader || 'Authorization').trim();
    if (/^[A-Za-z0-9-]+$/.test(authHeader)) headers[authHeader] = cfg.relayAuth;
  }
  return { url: `${base}/v1beta/models?pageSize=1`, headers };
}

function transcriptPrompt(language?: string): string {
  const lang = (language || '').toLowerCase();
  if (lang.startsWith('zh')) {
    return '请逐字转写这段音频，使用简体中文，只输出转写文本，不要解释，不要添加不存在的内容。';
  }
  return 'Transcribe this audio verbatim. Output only the transcript, with no explanation.';
}

async function geminiTranscribe(
  cfg: VoiceProviderConfig,
  audioBase64: string,
  mimeType: string,
  language?: string,
): Promise<VoiceResult> {
  if (!cfg.apiKey) throw new HttpError(400, 'Gemini 渠道尚未配置 API Key');
  const { url, headers } = geminiRequest(cfg);
  const start = Date.now();
  let response: Response;
  try {
    response = await voiceFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inline_data: { mime_type: mimeType, data: audioBase64 } },
              { text: transcriptPrompt(language || cfg.language) },
            ],
          },
        ],
        generationConfig: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    throw new HttpError(502, `Gemini 请求失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const data = (await response.json().catch(() => null)) as
    | {
        error?: { message?: string };
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      }
    | null;
  if (!response.ok) {
    throw new HttpError(502, `Gemini 转写失败：${data?.error?.message ?? `HTTP ${response.status}`}`);
  }
  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join(' ')
      .trim() ?? '';
  if (!text) throw new HttpError(502, 'Gemini 没有识别到语音内容');
  return {
    text,
    provider: 'gemini',
    model: cfg.model || 'gemini-3.5-transcribe',
    latencyMs: Date.now() - start,
  };
}

export async function openaiTranscribe(
  cfg: VoiceProviderConfig,
  bytes: Buffer,
  mimeType: string,
  language?: string,
): Promise<VoiceResult> {
  if (!cfg.apiKey) throw new HttpError(400, 'OpenAI 兼容渠道尚未配置 API Key');
  const base = baseUrlOf(cfg.baseUrl, 'https://api.openai.com/v1');
  const extension = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'm4a' : mimeType.includes('wav') ? 'wav' : 'mp3';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), `audio.${extension}`);
  form.append('model', cfg.model || 'whisper-1');
  if (language || cfg.language) form.append('language', (language || cfg.language || '').replace(/-.*$/, ''));
  const start = Date.now();
  let response: Response;
  try {
    response = await voiceFetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    throw new HttpError(502, `语音服务请求失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const data = (await response.json().catch(() => null)) as
    | { text?: string; error?: { message?: string } }
    | null;
  if (!response.ok) {
    throw new HttpError(502, `转写失败：${data?.error?.message ?? `HTTP ${response.status}`}`);
  }
  const text = (data?.text ?? '').trim();
  if (!text) throw new HttpError(502, '语音服务没有返回文本');
  return {
    text,
    provider: 'openai',
    model: cfg.model || 'whisper-1',
    latencyMs: Date.now() - start,
  };
}

export function encodeVolcPacket(payload: Buffer, audio: boolean, final = false): Buffer {
  const body = gzipSync(payload);
  const header = Buffer.from([
    0x11,
    (audio ? 0x20 : 0x10) | (final ? 0x02 : 0x00),
    audio ? 0x01 : 0x11,
    0x00,
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, length, body]);
}

export function decodeVolcPacket(raw: Buffer): { message: Record<string, unknown>; final: boolean } {
  if (raw.length < 8 || (raw[0] ?? 0) >> 4 !== 1) {
    throw new Error('火山引擎返回了无效的 ASR 数据包');
  }
  let offset = ((raw[0] ?? 0) & 0x0f) * 4;
  const kind = (raw[1] ?? 0) >> 4;
  const flags = (raw[1] ?? 0) & 0x0f;
  const serialization = (raw[2] ?? 0) >> 4;
  const compression = (raw[2] ?? 0) & 0x0f;
  if (offset < 4 || (kind !== 9 && kind !== 15) || (compression !== 0 && compression !== 1) || flags > 3) {
    throw new Error('火山引擎 ASR 数据包头不支持');
  }
  let error: number | null = null;
  if (kind === 15 || (flags & 1) !== 0) {
    if (raw.length < offset + 4) throw new Error('火山引擎 ASR 数据包被截断');
    if (kind === 15) error = raw.readUInt32BE(offset);
    offset += 4;
  }
  if (raw.length < offset + 4) throw new Error('火山引擎 ASR 数据包缺少长度');
  const size = raw.readUInt32BE(offset);
  const body = raw.subarray(offset + 4);
  if (size !== body.length || size > 1024 * 1024) {
    throw new Error('火山引擎 ASR 数据包长度不正确');
  }
  const payload = compression === 1 ? gunzipSync(body) : body;
  if (error !== null) throw new Error(`火山引擎 ASR 错误（${error}）`);
  if (serialization !== 1) throw new Error('火山引擎 ASR 响应不是 JSON');
  const message = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
  const code = typeof message.code === 'number' ? message.code : 20000000;
  if (code !== 0 && code !== 20000000) {
    throw new Error(`火山引擎 ASR 错误（${String(message.code)}）`);
  }
  return { message, final: (flags & 2) !== 0 };
}

function toPcm16k(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-vn',
        '-f',
        's16le',
        '-ac',
        '1',
        '-ar',
        '16000',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error('音频转码超时'));
    }, 20_000);
    timer.unref?.();
    child.stdout.on('data', (data: Buffer) => chunks.push(data));
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(stderr || `ffmpeg 退出码 ${code}`));
    });
    child.stdin.end(input);
  });
}

export function volcengineHeaders(cfg: VoiceProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Api-Resource-Id': cfg.resourceId || 'volc.bigasr.sauc.duration',
    'X-Api-Connect-Id': randomUUID(),
    'X-Api-Request-Id': randomUUID(),
  };
  if (cfg.apiKey) {
    headers['X-Api-Key'] = cfg.apiKey;
  } else if (cfg.appId && cfg.accessKey) {
    headers['X-Api-App-Key'] = cfg.appId;
    headers['X-Api-Access-Key'] = cfg.accessKey;
  }
  return headers;
}

export function volcengineSocket(cfg: VoiceProviderConfig, urlOverride?: string): WebSocket {
  const url =
    urlOverride ||
    (cfg.baseUrl?.startsWith('wss://') || cfg.baseUrl?.startsWith('ws://')
      ? cfg.baseUrl
      : 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream');
  return new WebSocket(url, {
    headers: volcengineHeaders(cfg),
    handshakeTimeout: 12_000,
    maxPayload: 2 * 1024 * 1024,
  });
}

function volcengineRecognize(cfg: VoiceProviderConfig, pcm: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!cfg.apiKey && (!cfg.appId || !cfg.accessKey)) {
      reject(new HttpError(400, '火山引擎渠道需要 App ID + Access Key，或 API Key'));
      return;
    }
    const socket = volcengineSocket(cfg);
    let text = '';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore
      }
      if (error) reject(error);
      else if (text.trim()) resolve(text.trim());
      else reject(new Error('火山引擎没有识别到语音内容'));
    };
    const timer = setTimeout(() => finish(new Error('火山引擎 ASR 超时')), 60_000);
    timer.unref?.();

    socket.on('open', () => {
      const setup = {
        user: { uid: randomUUID() },
        audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
        request: {
          model_name: cfg.model || 'bigmodel',
          enable_itn: true,
          enable_punc: true,
          result_type: 'full',
          show_utterances: true,
        },
      };
      socket.send(encodeVolcPacket(Buffer.from(JSON.stringify(setup)), false));
      for (let offset = 0; offset < pcm.length; offset += 6400) {
        socket.send(encodeVolcPacket(pcm.subarray(offset, offset + 6400), true));
      }
      socket.send(encodeVolcPacket(Buffer.alloc(0), true, true));
    });
    socket.on('message', (raw) => {
      try {
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        const { message, final } = decodeVolcPacket(buffer);
        const result = message.result as { text?: unknown } | undefined;
        if (typeof result?.text === 'string' && result.text) text = result.text;
        if (final) finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => {
      if (!settled) finish(text.trim() ? undefined : new Error('火山引擎连接提前关闭'));
    });
  });
}

async function volcengineTranscribe(
  cfg: VoiceProviderConfig,
  bytes: Buffer,
): Promise<VoiceResult> {
  const start = Date.now();
  let pcm: Buffer;
  try {
    pcm = await toPcm16k(bytes);
  } catch (error) {
    throw new HttpError(
      502,
      `音频转码失败：${error instanceof Error ? error.message : String(error)}（火山引擎渠道需要本机安装 ffmpeg）`,
    );
  }
  if (pcm.length === 0) throw new HttpError(400, '音频为空');
  if (pcm.length > 16000 * 2 * 60) throw new HttpError(413, '录音片段不能超过 60 秒');
  const text = await volcengineRecognize(cfg, pcm);
  return {
    text,
    provider: 'volcengine',
    model: cfg.model || 'bigmodel',
    latencyMs: Date.now() - start,
  };
}

async function volcengineHandshake(cfg: VoiceProviderConfig): Promise<void> {
  if (!cfg.apiKey && (!cfg.appId || !cfg.accessKey)) {
    throw new HttpError(400, '火山引擎渠道需要 App ID + Access Key，或 API Key');
  }
  await new Promise<void>((resolve, reject) => {
    const socket = volcengineSocket(cfg);
    const timer = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        // ignore
      }
      reject(new Error('连接火山引擎超时'));
    }, 12_000);
    timer.unref?.();
    socket.on('open', () => {
      clearTimeout(timer);
      socket.close();
      resolve();
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function transcribeAudio(input: {
  provider?: VoiceProviderId;
  audioBase64: string;
  mimeType?: string;
  language?: string;
}): Promise<VoiceResult> {
  const file = getVoiceConfig();
  const provider = input.provider && PROVIDERS.includes(input.provider) ? input.provider : file.active;
  const cfg = file.providers[provider] ?? {};
  if (cfg.enabled !== true) throw new HttpError(400, '该语音渠道未启用');
  if (provider === 'browser') {
    throw new HttpError(400, '浏览器内置识别在客户端运行，不需要服务端转写');
  }
  // MediaRecorder often reports parameters such as `audio/webm;codecs=opus`.
  // Providers only need the base media type; reject truly unknown types.
  const mimeType = (input.mimeType || 'audio/webm').split(';')[0].trim().toLowerCase();
  if (!/^audio\/[a-z0-9.+-]+$/.test(mimeType)) throw new HttpError(400, '不支持的音频类型');
  if (typeof input.audioBase64 !== 'string' || input.audioBase64.length < 100) {
    throw new HttpError(400, '音频数据为空');
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.audioBase64, 'base64');
  } catch {
    throw new HttpError(400, '音频数据格式错误');
  }
  if (bytes.length < 800) throw new HttpError(400, '录音太短，请重试');
  if (bytes.length > 8 * 1024 * 1024) throw new HttpError(413, '单个录音片段不能超过 8MB');

  if (provider === 'gemini') {
    return geminiTranscribe(cfg, input.audioBase64, mimeType, input.language);
  }
  if (provider === 'volcengine') {
    return volcengineTranscribe(cfg, bytes);
  }
  return openaiTranscribe(cfg, bytes, mimeType, input.language);
}

export async function testVoiceProvider(provider: VoiceProviderId): Promise<{
  ok: boolean;
  latencyMs: number;
  detail: string;
}> {
  const file = getVoiceConfig();
  const cfg = file.providers[provider] ?? {};
  const start = Date.now();
  if (provider === 'browser') {
    return { ok: true, latencyMs: 0, detail: '浏览器内置识别在客户端运行，无需服务端测试' };
  }
  if (provider === 'volcengine') {
    await volcengineHandshake(cfg);
    return {
      ok: true,
      latencyMs: Date.now() - start,
      detail: '火山引擎 WebSocket 握手成功，凭证格式有效',
    };
  }
  if (!cfg.apiKey) throw new HttpError(400, '尚未配置 API Key');
  if (provider === 'gemini') {
    const { url, headers } = geminiModelsUrl(cfg);
    let response: Response;
    try {
      response = await voiceFetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new HttpError(502, `连接失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const data = (await response.json().catch(() => null)) as
      | { models?: unknown[]; error?: { message?: string } }
      | null;
    if (!response.ok) {
      throw new HttpError(502, data?.error?.message ?? `HTTP ${response.status}`);
    }
    const count = Array.isArray(data?.models) ? data.models.length : 0;
    return {
      ok: true,
      latencyMs: Date.now() - start,
      detail: `连接成功，鉴权通过${count ? `（返回 ${count} 个模型）` : ''}`,
    };
  }
  const base = baseUrlOf(cfg.baseUrl, 'https://api.openai.com/v1');
  let response: Response;
  try {
    response = await voiceFetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new HttpError(502, `连接失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new HttpError(502, data?.error?.message ?? `HTTP ${response.status}`);
  }
  return { ok: true, latencyMs: Date.now() - start, detail: '连接成功，鉴权通过' };
}

const voiceUsage = new Map<string, { count: number; resetAt: number }>();

export function voiceRateAllowed(username: string): boolean {
  const now = Date.now();
  const entry = voiceUsage.get(username);
  if (!entry || now > entry.resetAt) {
    voiceUsage.set(username, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 60) return false;
  entry.count += 1;
  return true;
}

export function voiceFileExists(): boolean {
  try {
    return fs.statSync(voiceFile()).size > 0;
  } catch {
    return false;
  }
}
