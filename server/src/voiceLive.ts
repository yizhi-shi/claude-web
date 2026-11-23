import { randomUUID } from 'node:crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';
import { config } from './config.js';
import {
  decodeVolcPacket,
  encodeVolcPacket,
  geminiLiveSettings,
  getVoiceConfig,
  openaiLiveSettings,
  openaiTranscribe,
  testVoiceProvider,
  volcengineHeaders,
  volcengineLiveSettings,
  type VoiceProviderConfig,
  type VoiceProviderId,
} from './voice.js';

export type VoiceLiveEvent =
  | { type: 'ready' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string }
  | { type: 'closed' };

export interface VoiceLiveHandlers {
  onEvent: (event: VoiceLiveEvent) => void;
  onClose: () => void;
}

export interface VoiceLiveSession {
  sendAudio(chunk: Buffer): void;
  endAudio(): void;
  close(): void;
}

export interface VoiceLiveTestResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
  provider?: VoiceProviderId;
}

const LIVE_PATH =
  '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

function joinTranscript(previous: string, next: string): string {
  const a = previous.trim();
  const b = next.trim();
  if (!a) return b;
  if (!b) return a;
  if (/[\s，。！？；：、,.!?;:]$/.test(a)) return `${a}${b}`;
  return `${a} ${b}`;
}

function languageCode(value: string | undefined): string {
  const lang = (value || '').trim().toLowerCase();
  if (!lang) return '';
  return lang.split(/[-_]/)[0] ?? '';
}

function wsOptions(
  headers: Record<string, string>,
  handshakeTimeout = 20_000,
): WebSocket.ClientOptions {
  const options: WebSocket.ClientOptions = { headers, handshakeTimeout };
  if (config.voiceProxyUrl) options.agent = new HttpsProxyAgent(config.voiceProxyUrl);
  return options;
}

function unexpectedResponse(
  response: import('node:http').IncomingMessage,
  fail: (message: string) => void,
  label: string,
): void {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8').slice(0, 400);
    fail(`${label}返回 HTTP ${response.statusCode ?? 0}${body ? `：${body}` : ''}`);
  });
}

/** One Gemini Live BidiGenerateContent session (16 kHz PCM16 mono in). */
export class GeminiLiveSession implements VoiceLiveSession {
  private ws: WebSocket | null = null;
  private ready = false;
  private ended = false;
  private pendingEnd = false;
  private closed = false;
  private errorSent = false;
  private finalText = '';
  private lastPartial = '';
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private closeTimer: NodeJS.Timeout | null = null;
  private closeNotified = false;

  constructor(private handlers: VoiceLiveHandlers) {
    const settings = geminiLiveSettings();
    if (!settings.enabled) {
      this.fail('Gemini Live 未启用');
      return;
    }
    if (!settings.url) {
      this.fail('未配置 Gemini Live 中转地址');
      return;
    }
    if (!settings.apiKey) {
      this.fail('Gemini 渠道尚未配置 API Key');
      return;
    }

    const headers: Record<string, string> = { 'x-goog-api-key': settings.apiKey };
    if (settings.token) headers['x-proxy-token'] = settings.token;

    let socket: WebSocket;
    try {
      socket = new WebSocket(settings.url, wsOptions(headers));
    } catch (error) {
      this.fail(error instanceof Error ? error.message : '无法连接 Gemini Live');
      return;
    }
    this.ws = socket;
    socket.on('open', () => {
      try {
        socket.send(
          JSON.stringify({
            setup: {
              model: `models/${settings.model}`,
              generationConfig: { responseModalities: ['TEXT'] },
              inputAudioTranscription: {},
            },
          }),
        );
      } catch (error) {
        this.fail(error instanceof Error ? error.message : 'Gemini Live 初始化失败');
      }
    });
    socket.on('message', (data) => this.onMessage(data));
    socket.on('unexpected-response', (_request, response) => {
      unexpectedResponse(response, (message) => this.fail(message), 'Gemini Live 中转');
    });
    socket.on('error', (error) => {
      this.fail(`Gemini Live 连接失败：${error.message || '无法连接中转地址'}`);
    });
    socket.on('close', (code, reason) => {
      this.closed = true;
      if (this.lastPartial) {
        this.finalText = joinTranscript(this.finalText, this.lastPartial);
        this.lastPartial = '';
        this.emit({ type: 'final', text: this.finalText });
      }
      if (!this.errorSent && code !== 1000 && code !== 1005) {
        const detail = reason.toString().slice(0, 300);
        this.errorSent = true;
        this.emit({
          type: 'error',
          message: `Gemini Live 连接中断（${code}${detail ? `：${detail}` : ''}）`,
        });
      }
      if (!this.errorSent) this.emit({ type: 'closed' });
      this.notifyClosed();
    });
  }

  private emit(event: VoiceLiveEvent): void {
    this.handlers.onEvent(event);
  }

  private onMessage(data: WebSocket.RawData): void {
    const text = data.toString();
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.setupComplete) {
      this.ready = true;
      this.emit({ type: 'ready' });
      this.flush();
      return;
    }
    const error = message.error as { message?: string } | undefined;
    if (error) {
      this.fail(error.message || 'Gemini Live 返回错误');
      return;
    }
    const content = message.serverContent as
      | {
          interimInputTranscription?: { text?: string };
          inputTranscription?: { text?: string };
          generationComplete?: boolean;
          turnComplete?: boolean;
        }
      | undefined;
    if (!content) return;

    const interim = content.interimInputTranscription?.text;
    if (typeof interim === 'string' && interim.trim()) {
      this.lastPartial = interim.trim();
      this.emit({ type: 'partial', text: joinTranscript(this.finalText, this.lastPartial) });
    }
    const final = content.inputTranscription?.text;
    if (typeof final === 'string' && final.trim()) {
      this.finalText = joinTranscript(this.finalText, final);
      this.lastPartial = '';
      this.emit({ type: 'final', text: this.finalText });
    }
    if (content.generationComplete || content.turnComplete) {
      if (this.lastPartial) {
        this.finalText = joinTranscript(this.finalText, this.lastPartial);
        this.lastPartial = '';
        this.emit({ type: 'final', text: this.finalText });
      }
      if (this.ended) this.finishSoon(120);
    }
  }

  private flush(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const chunk of this.queue) this.sendChunk(chunk);
    this.queue = [];
    this.queuedBytes = 0;
    if (this.pendingEnd) {
      this.pendingEnd = false;
      try {
        this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      } catch {
        // final transcription can still arrive before close
      }
    }
  }

  private sendChunk(chunk: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [
            { mimeType: 'audio/pcm;rate=16000', data: chunk.toString('base64') },
          ],
        },
      }),
    );
  }

  sendAudio(chunk: Buffer): void {
    if (this.closed || this.ended) return;
    if (!this.ready) {
      if (this.queuedBytes + chunk.length > 8 * 1024 * 1024) return;
      this.queue.push(chunk);
      this.queuedBytes += chunk.length;
      return;
    }
    this.sendChunk(chunk);
  }

  endAudio(): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    if (!this.ready) {
      this.pendingEnd = true;
    } else if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      } catch {
        // final transcription can still arrive before the socket closes
      }
    }
    this.closeTimer = setTimeout(() => this.finishSoon(0), 5_000);
    this.closeTimer.unref?.();
  }

  private finishSoon(delayMs = 250): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    const timer = setTimeout(() => this.close(), delayMs);
    timer.unref?.();
    this.closeTimer = timer;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    if (!this.ws) this.notifyClosed();
  }

  private notifyClosed(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.handlers.onClose();
  }

  private fail(message: string): void {
    if (this.errorSent || this.closed) return;
    this.errorSent = true;
    this.emit({ type: 'error', message });
    if (this.ws) this.close();
    else {
      this.closed = true;
      this.notifyClosed();
    }
  }
}

const OPENAI_VAD = {
  type: 'server_vad',
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 500,
};

function openaiSupportsVad(model: string): boolean {
  return !/live-transcribe/i.test(model);
}

/**
 * OpenAI Realtime transcription session (`?intent=transcription`).
 * Supports the current `session.update` schema and falls back once to the
 * older `transcription_session.update` schema used by compatible gateways.
 */
export class OpenAIRealtimeLiveSession implements VoiceLiveSession {
  private ws: WebSocket | null = null;
  private ready = false;
  private ended = false;
  private pendingEnd = false;
  private closed = false;
  private errorSent = false;
  private schema: 'new' | 'old' | null = null;
  private triedOld = false;
  private schemaTimer: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private closeNotified = false;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private itemOrder: string[] = [];
  private itemTexts = new Map<string, string>();
  private itemDone = new Set<string>();
  private committed = 0;
  private completed = 0;
  private commitSent = false;
  private lastPartial = '';
  private finalEmitted = '';

  constructor(private handlers: VoiceLiveHandlers) {
    const settings = openaiLiveSettings();
    if (!settings.enabled) {
      this.fail('OpenAI 实时识别未启用');
      return;
    }
    if (settings.mode !== 'realtime') {
      this.fail('当前 OpenAI 兼容配置使用分段实时模式');
      return;
    }
    if (!settings.apiKey) {
      this.fail('OpenAI 兼容渠道尚未配置 API Key');
      return;
    }
    if (!settings.url) {
      this.fail('未配置 OpenAI Realtime 地址');
      return;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${settings.apiKey}`,
      'OpenAI-Beta': 'realtime=v1',
    };
    let socket: WebSocket;
    try {
      socket = new WebSocket(settings.url, wsOptions(headers));
    } catch (error) {
      this.fail(error instanceof Error ? error.message : '无法连接 OpenAI Realtime');
      return;
    }
    this.ws = socket;
    socket.on('open', () => {
      this.sendNewSchema();
      this.schemaTimer = setTimeout(() => {
        if (!this.ready && !this.closed) this.sendOldSchema();
      }, 900);
      this.schemaTimer.unref?.();
    });
    socket.on('message', (data) => this.onMessage(data));
    socket.on('unexpected-response', (_request, response) => {
      unexpectedResponse(response, (message) => this.fail(message), 'OpenAI Realtime');
    });
    socket.on('error', (error) => {
      this.fail(`OpenAI Realtime 连接失败：${error.message || '无法连接服务'}`);
    });
    socket.on('close', (code, reason) => {
      this.closed = true;
      this.clearTimers();
      const text = this.compose();
      if (text && text !== this.finalEmitted) {
        this.finalEmitted = text;
        this.emit({ type: 'final', text });
      }
      if (!this.errorSent && code !== 1000 && code !== 1005) {
        const detail = reason.toString().slice(0, 300);
        this.errorSent = true;
        this.emit({
          type: 'error',
          message: `OpenAI Realtime 连接中断（${code}${detail ? `：${detail}` : ''}）`,
        });
      }
      if (!this.errorSent) this.emit({ type: 'closed' });
      this.notifyClosed();
    });
  }

  private emit(event: VoiceLiveEvent): void {
    this.handlers.onEvent(event);
  }

  private sendNewSchema(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const settings = openaiLiveSettings();
    this.schema = 'new';
    const language = languageCode(settings.language);
    const transcription: Record<string, unknown> = { model: settings.model };
    if (language) transcription.language = language;
    this.ws.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription,
              turn_detection: openaiSupportsVad(settings.model) ? OPENAI_VAD : null,
            },
          },
        },
      }),
    );
  }

  private sendOldSchema(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.closed) return;
    const settings = openaiLiveSettings();
    this.schema = 'old';
    this.triedOld = true;
    const language = languageCode(settings.language);
    const transcription: Record<string, unknown> = { model: settings.model };
    if (language) transcription.language = language;
    try {
      this.ws.send(
        JSON.stringify({
          type: 'transcription_session.update',
          session: {
            input_audio_format: 'pcm16',
            input_audio_transcription: transcription,
            turn_detection: openaiSupportsVad(settings.model) ? OPENAI_VAD : null,
            input_audio_noise_reduction: { type: 'near_field' },
          },
        }),
      );
    } catch {
      this.fail('无法发送 OpenAI Realtime 会话配置');
      return;
    }
    // Compatible gateways do not all acknowledge the update. Audio is still
    // sent after the config frame, so flushing here keeps ordering intact.
    const timer = setTimeout(() => {
      if (!this.closed) this.markReady();
    }, 120);
    timer.unref?.();
  }

  private markReady(): void {
    if (this.ready || this.closed) return;
    if (this.schemaTimer) {
      clearTimeout(this.schemaTimer);
      this.schemaTimer = null;
    }
    this.ready = true;
    this.emit({ type: 'ready' });
    this.flush();
  }

  private onMessage(data: WebSocket.RawData): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof event.type === 'string' ? event.type : '';
    if (
      type === 'session.created' ||
      type === 'session.updated' ||
      type === 'transcription_session.created' ||
      type === 'transcription_session.updated'
    ) {
      this.markReady();
      return;
    }
    if (type === 'input_audio_buffer.committed') {
      const id = typeof event.item_id === 'string' ? event.item_id : '';
      if (id && !this.itemTexts.has(id)) {
        this.itemOrder.push(id);
        this.itemTexts.set(id, '');
        this.committed += 1;
      }
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.delta') {
      const id = typeof event.item_id === 'string' ? event.item_id : '';
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (!id || !delta) return;
      if (!this.itemTexts.has(id)) {
        this.itemOrder.push(id);
        this.itemTexts.set(id, '');
      }
      this.itemTexts.set(id, `${this.itemTexts.get(id) ?? ''}${delta}`);
      const text = this.compose();
      if (text && text !== this.lastPartial) {
        this.lastPartial = text;
        this.emit({ type: 'partial', text });
      }
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const id = typeof event.item_id === 'string' ? event.item_id : '';
      const transcript = typeof event.transcript === 'string' ? event.transcript : '';
      if (!id) return;
      if (!this.itemTexts.has(id)) {
        this.itemOrder.push(id);
        this.committed += 1;
      }
      this.itemTexts.set(id, transcript);
      if (!this.itemDone.has(id)) {
        this.itemDone.add(id);
        this.completed += 1;
      }
      const text = this.compose();
      if (text && text !== this.finalEmitted) {
        this.finalEmitted = text;
        this.lastPartial = text;
        this.emit({ type: 'final', text });
      }
      if (this.ended && this.completed >= this.committed && this.committed > 0) {
        this.finishSoon(120);
      }
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.failed') {
      const error = event.error as { message?: string } | undefined;
      this.fail(error?.message || 'OpenAI 实时转写失败');
      return;
    }
    if (type === 'error') {
      const error = event.error as { message?: string; code?: string } | undefined;
      const message = error?.message || String(event.message ?? 'OpenAI Realtime 返回错误');
      if (this.schema === 'new' && !this.triedOld) {
        // Older OpenAI-compatible gateways reject the current session schema.
        if (this.schemaTimer) {
          clearTimeout(this.schemaTimer);
          this.schemaTimer = null;
        }
        this.sendOldSchema();
        return;
      }
      if (this.ended && /buffer|commit|too small|empty/i.test(message)) {
        this.finishSoon(120);
        return;
      }
      this.fail(message);
    }
  }

  private compose(): string {
    let text = '';
    for (const id of this.itemOrder) {
      const part = (this.itemTexts.get(id) ?? '').trim();
      if (part) text = joinTranscript(text, part);
    }
    return text;
  }

  private flush(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) return;
    for (const chunk of this.queue) this.sendAppend(chunk);
    this.queue = [];
    this.queuedBytes = 0;
    if (this.pendingEnd || (this.ended && !this.commitSent)) {
      this.pendingEnd = false;
      this.sendCommit();
    }
  }

  private sendAppend(chunk: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: chunk.toString('base64'),
      }),
    );
  }

  private sendCommit(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.commitSent) return;
    this.commitSent = true;
    try {
      this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    } catch {
      // final transcription may still arrive
    }
  }

  sendAudio(chunk: Buffer): void {
    if (this.closed || this.ended) return;
    if (!this.ready) {
      if (this.queuedBytes + chunk.length > 8 * 1024 * 1024) return;
      this.queue.push(chunk);
      this.queuedBytes += chunk.length;
      return;
    }
    this.sendAppend(chunk);
  }

  endAudio(): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    if (!this.ready) this.pendingEnd = true;
    else this.sendCommit();
    this.closeTimer = setTimeout(() => this.finishSoon(0), 4_500);
    this.closeTimer.unref?.();
  }

  private finishSoon(delayMs = 250): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    const timer = setTimeout(() => this.close(), delayMs);
    timer.unref?.();
    this.closeTimer = timer;
  }

  private clearTimers(): void {
    if (this.schemaTimer) {
      clearTimeout(this.schemaTimer);
      this.schemaTimer = null;
    }
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    if (!this.ws) this.notifyClosed();
  }

  private notifyClosed(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.handlers.onClose();
  }

  private fail(message: string): void {
    if (this.errorSent || this.closed) return;
    this.errorSent = true;
    this.emit({ type: 'error', message });
    if (this.ws) this.close();
    else {
      this.closed = true;
      this.notifyClosed();
    }
  }
}

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 4, 'ascii');
  header.write('fmt ', 12, 4, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 4, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function chunkRms(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const value = chunk.readInt16LE(i * 2) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

/**
 * Near-real-time fallback for OpenAI-compatible endpoints that only expose
 * `/v1/audio/transcriptions`: energy VAD cuts each utterance, then the server
 * transcribes it and appends the result while the user keeps talking.
 */
export class OpenAISegmentLiveSession implements VoiceLiveSession {
  private static readonly sampleRate = 24_000;
  private closed = false;
  private ended = false;
  private errorSent = false;
  private closeNotified = false;
  private closeTimer: NodeJS.Timeout | null = null;
  private speech = false;
  private silenceMs = 0;
  private speechMs = 0;
  private noiseFloor = 0.003;
  private segment: Buffer[] = [];
  private preRoll: Buffer[] = [];
  private finalText = '';
  private chain: Promise<void> = Promise.resolve();
  private transcribing = 0;

  constructor(private handlers: VoiceLiveHandlers) {
    const settings = openaiLiveSettings();
    if (!settings.enabled) {
      this.fail('OpenAI 实时识别未启用');
      return;
    }
    if (settings.mode !== 'segment') {
      this.fail('当前 OpenAI 兼容配置使用 Realtime WebSocket 模式');
      return;
    }
    if (!settings.apiKey) {
      this.fail('OpenAI 兼容渠道尚未配置 API Key');
      return;
    }
    queueMicrotask(() => {
      if (!this.closed && !this.ended) this.emit({ type: 'ready' });
    });
  }

  private emit(event: VoiceLiveEvent): void {
    this.handlers.onEvent(event);
  }

  sendAudio(chunk: Buffer): void {
    if (this.closed || this.ended || chunk.length < 2) return;
    const durationMs = (chunk.length / (OpenAISegmentLiveSession.sampleRate * 2)) * 1000;
    const rms = chunkRms(chunk);
    const threshold = Math.max(0.008, this.noiseFloor * 3);
    if (!this.speech) {
      this.preRoll.push(chunk);
      if (this.preRoll.length > 3) this.preRoll.shift();
      if (rms > threshold) {
        this.speech = true;
        this.segment = this.preRoll;
        this.preRoll = [];
        this.speechMs = durationMs;
        this.silenceMs = 0;
      } else {
        this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      }
      return;
    }
    this.segment.push(chunk);
    this.speechMs += durationMs;
    if (rms <= threshold) this.silenceMs += durationMs;
    else this.silenceMs = 0;
    if (this.silenceMs >= 650 || this.speechMs >= 12_000) this.cutSegment();
  }

  private cutSegment(): void {
    const chunks = this.segment;
    this.segment = [];
    this.speech = false;
    this.silenceMs = 0;
    this.speechMs = 0;
    if (chunks.length === 0) return;
    const pcm = Buffer.concat(chunks);
    if (pcm.length < OpenAISegmentLiveSession.sampleRate * 2 * 0.25) return;
    const wav = pcmToWav(pcm, OpenAISegmentLiveSession.sampleRate);
    const settings = openaiLiveSettings();
    const cfg = getVoiceConfig().providers.openai ?? {};
    this.transcribing += 1;
    this.chain = this.chain
      .then(async () => {
        if (this.closed) return;
        const result = await openaiTranscribe(cfg, wav, 'audio/wav', settings.language);
        const text = result.text.trim();
        if (!text) return;
        this.finalText = joinTranscript(this.finalText, text);
        this.emit({ type: 'final', text: this.finalText });
      })
      .catch((error: unknown) => {
        this.fail(error instanceof Error ? error.message : 'OpenAI 分段转写失败');
      })
      .finally(() => {
        this.transcribing -= 1;
        if (this.ended && this.transcribing === 0 && !this.speech) this.finishSoon(100);
      });
  }

  endAudio(): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    if (this.speech) this.cutSegment();
    if (this.transcribing === 0) this.finishSoon(150);
    else {
      this.closeTimer = setTimeout(() => this.finishSoon(0), 10_000);
      this.closeTimer.unref?.();
    }
  }

  private finishSoon(delayMs = 150): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    const timer = setTimeout(() => this.close(), delayMs);
    timer.unref?.();
    this.closeTimer = timer;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.notifyClosed();
  }

  private notifyClosed(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.handlers.onClose();
  }

  private fail(message: string): void {
    if (this.errorSent || this.closed) return;
    this.errorSent = true;
    this.emit({ type: 'error', message });
    this.close();
  }
}

/** Volcengine / Doubao streaming ASR (`/api/v3/sauc/bigmodel`). */
export class VolcengineLiveSession implements VoiceLiveSession {
  private ws: WebSocket | null = null;
  private ready = false;
  private ended = false;
  private pendingEnd = false;
  private closed = false;
  private errorSent = false;
  private closeNotified = false;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private pendingAudio = Buffer.alloc(0);
  private lastPartial = '';
  private finalText = '';
  private closeTimer: NodeJS.Timeout | null = null;

  constructor(private handlers: VoiceLiveHandlers) {
    const settings = volcengineLiveSettings();
    if (!settings.enabled) {
      this.fail('火山引擎实时识别未启用');
      return;
    }
    if (!settings.url) {
      this.fail('未配置火山引擎流式地址');
      return;
    }
    if (!settings.apiKey && (!settings.appId || !settings.accessKey)) {
      this.fail('火山引擎渠道需要 App ID + Access Key，或 API Key');
      return;
    }
    const cfg: VoiceProviderConfig = {
      apiKey: settings.apiKey,
      appId: settings.appId,
      accessKey: settings.accessKey,
      resourceId: settings.resourceId,
      model: settings.model,
    };
    let socket: WebSocket;
    try {
      socket = new WebSocket(settings.url, {
        ...wsOptions(volcengineHeaders(cfg)),
        maxPayload: 2 * 1024 * 1024,
      });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : '无法连接火山引擎');
      return;
    }
    this.ws = socket;
    socket.on('open', () => {
      try {
        socket.send(
          encodeVolcPacket(
            Buffer.from(
              JSON.stringify({
                user: { uid: randomUUID() },
                audio: {
                  format: 'pcm',
                  codec: 'raw',
                  rate: 16000,
                  bits: 16,
                  channel: 1,
                },
                request: {
                  model_name: settings.model,
                  enable_itn: true,
                  enable_punc: true,
                  result_type: 'full',
                  show_utterances: true,
                },
              }),
            ),
            false,
          ),
        );
      } catch (error) {
        this.fail(error instanceof Error ? error.message : '火山引擎初始化失败');
        return;
      }
      this.ready = true;
      this.emit({ type: 'ready' });
      this.flush();
    });
    socket.on('message', (raw) => this.onMessage(raw));
    socket.on('unexpected-response', (_request, response) => {
      unexpectedResponse(response, (message) => this.fail(message), '火山引擎');
    });
    socket.on('error', (error) => {
      this.fail(`火山引擎连接失败：${error.message || '无法连接服务'}`);
    });
    socket.on('close', (code, reason) => {
      this.closed = true;
      if (this.closeTimer) {
        clearTimeout(this.closeTimer);
        this.closeTimer = null;
      }
      if (this.lastPartial && !this.finalText) {
        this.finalText = this.lastPartial;
        this.emit({ type: 'final', text: this.finalText });
      }
      if (!this.errorSent && code !== 1000 && code !== 1005 && !this.ended) {
        const detail = reason.toString().slice(0, 300);
        this.errorSent = true;
        this.emit({
          type: 'error',
          message: `火山引擎连接中断（${code}${detail ? `：${detail}` : ''}）`,
        });
      }
      if (!this.errorSent) this.emit({ type: 'closed' });
      this.notifyClosed();
    });
  }

  private emit(event: VoiceLiveEvent): void {
    this.handlers.onEvent(event);
  }

  private onMessage(raw: WebSocket.RawData): void {
    let decoded: { message: Record<string, unknown>; final: boolean };
    try {
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      decoded = decodeVolcPacket(buffer);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : '火山引擎返回了无效数据');
      return;
    }
    const result = decoded.message.result as { text?: unknown } | undefined;
    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    if (text && text !== this.lastPartial) {
      this.lastPartial = text;
      this.emit({ type: 'partial', text });
    }
    if (decoded.final) {
      if (text || this.lastPartial) {
        this.finalText = text || this.lastPartial;
        this.emit({ type: 'final', text: this.finalText });
      }
      this.finishSoon(100);
    }
  }

  private flush(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const chunk of this.queue) this.sendPcm(chunk);
    this.queue = [];
    this.queuedBytes = 0;
    if (this.pendingAudio.length > 0) {
      this.sendPcm(this.pendingAudio);
      this.pendingAudio = Buffer.alloc(0);
    }
    if (this.pendingEnd) {
      this.pendingEnd = false;
      this.sendFinal();
    }
  }

  private sendPcm(chunk: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.pendingAudio = Buffer.concat([this.pendingAudio, chunk]);
    while (this.pendingAudio.length >= 6400) {
      const frame = this.pendingAudio.subarray(0, 6400);
      this.pendingAudio = this.pendingAudio.subarray(6400);
      this.ws.send(encodeVolcPacket(frame, true));
    }
  }

  private sendFinal(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.pendingAudio.length > 0) {
      this.ws.send(encodeVolcPacket(this.pendingAudio, true));
      this.pendingAudio = Buffer.alloc(0);
    }
    try {
      this.ws.send(encodeVolcPacket(Buffer.alloc(0), true, true));
    } catch {
      // the final response can still arrive before close
    }
  }

  sendAudio(chunk: Buffer): void {
    if (this.closed || this.ended) return;
    if (!this.ready) {
      if (this.queuedBytes + chunk.length > 8 * 1024 * 1024) return;
      this.queue.push(chunk);
      this.queuedBytes += chunk.length;
      return;
    }
    this.sendPcm(chunk);
  }

  endAudio(): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    if (!this.ready) this.pendingEnd = true;
    else this.sendFinal();
    this.closeTimer = setTimeout(() => this.finishSoon(0), 6_000);
    this.closeTimer.unref?.();
  }

  private finishSoon(delayMs = 150): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    const timer = setTimeout(() => this.close(), delayMs);
    timer.unref?.();
    this.closeTimer = timer;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    if (!this.ws) this.notifyClosed();
  }

  private notifyClosed(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.handlers.onClose();
  }

  private fail(message: string): void {
    if (this.errorSent || this.closed) return;
    this.errorSent = true;
    this.emit({ type: 'error', message });
    if (this.ws) this.close();
    else {
      this.closed = true;
      this.notifyClosed();
    }
  }
}

class UnsupportedLiveSession implements VoiceLiveSession {
  constructor(private handlers: VoiceLiveHandlers, private message: string) {
    queueMicrotask(() => {
      this.handlers.onEvent({ type: 'error', message: this.message });
      this.handlers.onClose();
    });
  }

  sendAudio(): void {
    // no-op
  }

  endAudio(): void {
    // no-op
  }

  close(): void {
    // no-op
  }
}

export function createLiveSession(handlers: VoiceLiveHandlers): VoiceLiveSession {
  const provider = getVoiceConfig().active;
  if (provider === 'gemini') return new GeminiLiveSession(handlers);
  if (provider === 'openai') {
    return openaiLiveSettings().mode === 'segment'
      ? new OpenAISegmentLiveSession(handlers)
      : new OpenAIRealtimeLiveSession(handlers);
  }
  if (provider === 'volcengine') return new VolcengineLiveSession(handlers);
  return new UnsupportedLiveSession(handlers, '浏览器内置识别在客户端运行，不需要实时语音桥');
}

export async function testGeminiLive(timeoutMs = 15_000): Promise<VoiceLiveTestResult> {
  const start = Date.now();
  const settings = geminiLiveSettings();
  if (!settings.enabled) throw new Error('Gemini Live 未启用');
  if (!settings.url) throw new Error('未配置 Gemini Live 中转地址');
  if (!settings.apiKey) throw new Error('Gemini 渠道尚未配置 API Key');
  return new Promise((resolve, reject) => {
    let settled = false;
    const session = new GeminiLiveSession({
      onEvent: (event) => {
        if (settled) return;
        if (event.type === 'ready') {
          settled = true;
          session.close();
          resolve({
            ok: true,
            latencyMs: Date.now() - start,
            detail: `Gemini Live 握手成功（${settings.model}）`,
            provider: 'gemini',
          });
        } else if (event.type === 'error') {
          settled = true;
          session.close();
          reject(new Error(event.message));
        }
      },
      onClose: () => {
        if (settled) return;
        settled = true;
        reject(new Error('Gemini Live 连接提前关闭'));
      },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      session.close();
      reject(new Error('Gemini Live 连接超时'));
    }, timeoutMs);
    timer.unref?.();
  });
}

function testSocketSession(
  create: (handlers: VoiceLiveHandlers) => VoiceLiveSession,
  detail: string,
  provider: VoiceProviderId,
  timeoutMs = 15_000,
): Promise<VoiceLiveTestResult> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const session = create({
      onEvent: (event) => {
        if (settled) return;
        if (event.type === 'ready') {
          settled = true;
          session.close();
          resolve({
            ok: true,
            latencyMs: Date.now() - start,
            detail,
            provider,
          });
        } else if (event.type === 'error') {
          settled = true;
          session.close();
          reject(new Error(event.message));
        }
      },
      onClose: () => {
        if (settled) return;
        settled = true;
        reject(new Error('实时语音连接提前关闭'));
      },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      session.close();
      reject(new Error('实时语音连接超时'));
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function testVoiceLive(provider: VoiceProviderId): Promise<VoiceLiveTestResult> {
  if (provider === 'gemini') return testGeminiLive();
  if (provider === 'openai') {
    const settings = openaiLiveSettings();
    if (settings.mode === 'segment') {
      const result = await testVoiceProvider('openai');
      return {
        ...result,
        detail: `分段实时使用 HTTP 转写端点：${result.detail}`,
        provider: 'openai',
      };
    }
    if (!settings.enabled) throw new Error('OpenAI 实时识别未启用');
    if (!settings.url) throw new Error('未配置 OpenAI Realtime 地址');
    return testSocketSession(
      (handlers) => new OpenAIRealtimeLiveSession(handlers),
      `OpenAI Realtime 握手成功（${settings.model}）`,
      'openai',
    );
  }
  if (provider === 'volcengine') {
    const settings = volcengineLiveSettings();
    if (!settings.enabled) throw new Error('火山引擎实时识别未启用');
    return testSocketSession(
      (handlers) => new VolcengineLiveSession(handlers),
      `火山引擎流式握手成功（${settings.model}）`,
      'volcengine',
    );
  }
  throw new Error('浏览器内置识别在客户端运行，无需服务端测试');
}

export const GEMINI_LIVE_PATH = LIVE_PATH;
