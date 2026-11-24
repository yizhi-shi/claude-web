<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ApiError, api } from '../api';
import { toast } from '../store';
import type { VoiceConfigView, VoiceProviderId } from '../types';
import Icon from './Icon.vue';

const emit = defineEmits<{
  start: [];
  partial: [text: string];
  text: [text: string];
  end: [];
}>();

const config = ref<VoiceConfigView | null>(null);
const recording = ref(false);
const starting = ref(false);
const busy = ref(false);

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let browserRecognition: { stop: () => void; start: () => void } | null = null;
let browserFinalText = '';
let disposed = false;

let liveSocket: WebSocket | null = null;
let liveContext: AudioContext | null = null;
let liveStream: MediaStream | null = null;
let liveSource: MediaStreamAudioSourceNode | null = null;
let liveProcessor: ScriptProcessorNode | null = null;
let liveReady: Promise<void> | null = null;
let liveReadyResolve: (() => void) | null = null;
let liveReadyReject: ((error: Error) => void) | null = null;
let liveEndTimer: number | undefined;
let liveStarted = false;
let liveAudioActive = false;
let livePending: ArrayBuffer[] = [];
let livePendingBytes = 0;
let liveStopRequested = false;
let liveFinalReceived = false;

const activeProvider = computed<VoiceProviderId>(() => config.value?.active ?? 'gemini');
const active = computed(() => config.value?.providers[activeProvider.value]);
const liveEnabled = computed(
  () => active.value?.liveEnabled === true && active.value?.liveAvailable === true,
);
const liveSampleRate = computed(() => (activeProvider.value === 'openai' ? 24_000 : 16_000));
const configured = computed(() => {
  if (!active.value?.enabled) return false;
  if (activeProvider.value === 'browser') return true;
  if (activeProvider.value === 'volcengine') {
    return active.value.hasApiKey || (!!active.value.appId && active.value.hasAccessKey);
  }
  return active.value.hasApiKey;
});

async function loadConfig(): Promise<void> {
  try {
    config.value = await api.voiceConfig();
  } catch {
    config.value = null;
  }
}

function pickMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  if (typeof MediaRecorder === 'undefined') return '';
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function voiceWsUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws/voice`;
}

function micBlockedReason(): string | null {
  if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    return '浏览器麦克风只在 HTTPS 或 localhost 下可用';
  }
  if (!navigator.mediaDevices?.getUserMedia) return '当前浏览器不支持录音';
  return null;
}

async function transcribeBlob(blob: Blob): Promise<void> {
  if (blob.size < 800) {
    toast('录音太短，请多说一会儿', 'info');
    return;
  }
  busy.value = true;
  try {
    const base64 = arrayBufferToBase64(await blob.arrayBuffer());
    // MediaRecorder may report `audio/webm;codecs=opus`; the server only
    // needs the base media type. Sending parameters caused "不支持的音频类型".
    const mimeType = (blob.type || 'audio/webm').split(';')[0].trim() || 'audio/webm';
    const result = await api.transcribeVoice({
      provider: activeProvider.value,
      audioBase64: base64,
      mimeType,
      language: active.value?.language,
    });
    if (result.text.trim()) emit('text', result.text.trim());
    else toast('没有识别到语音内容', 'info');
  } catch (err) {
    toast(err instanceof ApiError ? err.message : '语音识别失败', 'error', 4200);
  } finally {
    busy.value = false;
  }
}

async function startSegment(): Promise<void> {
  if (starting.value || recording.value) return;
  starting.value = true;
  try {
    const blocked = micBlockedReason();
    if (blocked) {
      toast(blocked, 'error', 4200);
      return;
    }
    try {
      const status = await navigator.permissions?.query({
        name: 'microphone' as PermissionName,
      });
      if (status?.state === 'denied') {
        toast('麦克风权限被拒绝，请在浏览器设置中允许后重试', 'error', 4200);
        return;
      }
    } catch {
      // Permissions API may not expose microphone; getUserMedia will prompt.
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    if (disposed) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      return;
    }
    const mime = pickMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    rec.onstop = () => {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      recorder = null;
      recording.value = false;
      if (disposed) return;
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      void transcribeBlob(blob).finally(() => emit('end'));
    };
    recorder = rec;
    recording.value = true;
    emit('start');
    rec.start();
  } catch (err) {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    recorder = null;
    recording.value = false;
    toast(
      err instanceof Error && err.name === 'NotAllowedError'
        ? '麦克风权限被拒绝，请在浏览器设置中允许'
        : '无法打开麦克风',
      'error',
      4200,
    );
  } finally {
    starting.value = false;
  }
}

function stopSegment(): void {
  if (recorder && recorder.state === 'recording') {
    recorder.stop();
  } else {
    recording.value = false;
  }
}

function cleanupLiveAudio(): void {
  liveAudioActive = false;
  if (liveProcessor) {
    liveProcessor.onaudioprocess = null;
    try {
      liveProcessor.disconnect();
    } catch {
      // ignore
    }
    liveProcessor = null;
  }
  try {
    liveSource?.disconnect();
  } catch {
    // ignore
  }
  liveSource = null;
  liveStream?.getTracks().forEach((track) => track.stop());
  liveStream = null;
  if (liveContext) {
    void liveContext.close().catch(() => undefined);
    liveContext = null;
  }
}

function clearLiveTimer(): void {
  if (liveEndTimer !== undefined) {
    window.clearTimeout(liveEndTimer);
    liveEndTimer = undefined;
  }
}

function finishLive(): void {
  clearLiveTimer();
  cleanupLiveAudio();
  if (liveSocket) {
    try {
      liveSocket.close();
    } catch {
      // ignore
    }
    liveSocket = null;
  }
  recording.value = false;
  busy.value = false;
  starting.value = false;
  livePending = [];
  livePendingBytes = 0;
  liveStopRequested = false;
  liveFinalReceived = false;
  if (liveStarted) {
    liveStarted = false;
    emit('end');
  }
}

/** A second click while a stopped session is flushing should cancel at once. */
function cancelLive(): void {
  clearLiveTimer();
  if (liveSocket) {
    try {
      liveSocket.close();
    } catch {
      // ignore
    }
  }
  finishLive();
}

function flushLivePending(): void {
  if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN) return;
  for (const buffer of livePending) {
    try {
      liveSocket.send(buffer);
    } catch {
      // close handler will finish
    }
  }
  livePending = [];
  livePendingBytes = 0;
  if (liveStopRequested) {
    try {
      liveSocket.send(JSON.stringify({ type: 'stop' }));
    } catch {
      // ignore
    }
  }
}

function startLiveAudio(): Promise<void> {
  return (async () => {
    const blocked = micBlockedReason();
    if (blocked) throw new Error(blocked);
    const media = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    if (disposed || !liveSocket) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    liveStream = media;
    const context = new AudioContext();
    liveContext = context;
    await context.resume();
    const source = context.createMediaStreamSource(media);
    liveSource = source;
    const processor = context.createScriptProcessor(4096, 1, 1);
    liveProcessor = processor;
    // Gemini/Volcengine stream 16 kHz PCM; OpenAI Realtime expects PCM16 at
    // 24 kHz. Resample in the microphone path instead of transcoding server-side.
    const ratio = context.sampleRate / liveSampleRate.value;
    liveAudioActive = true;
    processor.onaudioprocess = (event) => {
      if (!liveAudioActive || !liveSocket) return;
      const input = event.inputBuffer.getChannelData(0);
      const outLength = Math.max(1, Math.floor(input.length / ratio));
      const pcm = new Int16Array(outLength);
      for (let i = 0; i < outLength; i += 1) {
        const start = Math.floor(i * ratio);
        const end = Math.max(start + 1, Math.min(input.length, Math.floor((i + 1) * ratio)));
        let sum = 0;
        for (let j = start; j < end; j += 1) sum += input[j] ?? 0;
        const sample = Math.max(-1, Math.min(1, sum / (end - start)));
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      const buffer = pcm.buffer;
      if (liveSocket.readyState === WebSocket.OPEN) {
        try {
          liveSocket.send(buffer);
        } catch {
          // the close handler will surface the failure
        }
      } else if (livePendingBytes + buffer.byteLength < 2 * 1024 * 1024) {
        // The Live setup usually takes ~1s. Keep the first words captured
        // during that window instead of dropping them.
        livePending.push(buffer);
        livePendingBytes += buffer.byteLength;
      }
    };
    source.connect(processor);
    // ScriptProcessor needs a destination connection to run in some browsers.
    processor.connect(context.destination);
  })();
}

async function startLive(): Promise<void> {
  if (starting.value || recording.value) return;
  starting.value = true;
  const socket = new WebSocket(voiceWsUrl());
  liveSocket = socket;
  socket.binaryType = 'arraybuffer';
  livePending = [];
  livePendingBytes = 0;
  liveStopRequested = false;
  liveFinalReceived = false;
  socket.onopen = () => flushLivePending();
  liveReady = new Promise<void>((resolve, reject) => {
    liveReadyResolve = resolve;
    liveReadyReject = reject;
  });
  const rejectOnce = (message: string): void => {
    if (liveReadyReject) {
      const reject = liveReadyReject;
      liveReadyReject = null;
      reject(new Error(message));
    }
  };
  socket.onmessage = (event) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof message.type === 'string' ? message.type : '';
    if (type === 'ready') {
      const resolve = liveReadyResolve;
      liveReadyResolve = null;
      liveReadyReject = null;
      resolve?.();
      return;
    }
    if (type === 'partial' && typeof message.text === 'string') {
      // Stop must settle the composer immediately. Late partials from the
      // provider would otherwise keep rewriting the same sentence after the
      // user already clicked "结束".
      if (liveStopRequested) return;
      emit('partial', message.text);
      return;
    }
    if (type === 'final' && typeof message.text === 'string') {
      if (liveStopRequested && liveFinalReceived) {
        window.setTimeout(() => finishLive(), 120);
        return;
      }
      liveFinalReceived = true;
      emit('text', message.text);
      if (liveStopRequested) {
        window.setTimeout(() => finishLive(), 120);
      }
      return;
    }
    if (type === 'error') {
      const text = typeof message.message === 'string' ? message.message : '实时语音识别失败';
      if (liveStarted && !liveStopRequested) toast(text, 'error', 4200);
      rejectOnce(text);
      finishLive();
    }
  };
  socket.onerror = () => {
    const message = '实时语音连接失败';
    if (liveStarted && !liveStopRequested) toast(message, 'error', 4200);
    rejectOnce(message);
    finishLive();
  };
  socket.onclose = () => {
    if (liveReadyReject) rejectOnce('实时语音连接已关闭');
    finishLive();
  };

  try {
    // Capture immediately. Gemini Live setup takes about a second; waiting
    // for it before opening the microphone drops the first words the user
    // speaks after clicking the button.
    recording.value = true;
    liveStarted = true;
    emit('start');
    const audioPromise = startLiveAudio();
    await Promise.all([
      Promise.race([
        liveReady,
        new Promise<void>((_, reject) =>
          window.setTimeout(() => reject(new Error('实时语音连接超时')), 20_000),
        ),
      ]),
      audioPromise,
    ]);
    if (disposed || liveSocket !== socket) return;
  } catch (error) {
    // The user may have cancelled while the provider was still handshaking.
    if (!disposed && liveSocket === socket) {
      toast(
        error instanceof Error ? error.message : '无法启动实时语音识别',
        'error',
        4200,
      );
    }
    finishLive();
  } finally {
    starting.value = false;
  }
}

function stopLive(): void {
  if (!liveSocket) {
    recording.value = false;
    return;
  }
  recording.value = false;
  liveStopRequested = true;
  cleanupLiveAudio();
  if (liveSocket.readyState === WebSocket.OPEN) flushLivePending();
  busy.value = true;
  clearLiveTimer();
  // Keep the anchor alive long enough for the provider's final transcript,
  // but never let a dead upstream keep the button in "完成中" for seconds.
  liveEndTimer = window.setTimeout(() => {
    if (liveSocket) {
      try {
        liveSocket.close();
      } catch {
        // ignore
      }
    }
    finishLive();
  }, 3_500);
}

function startBrowserRecognition(): void {
  const RecognitionCtor =
    (window as unknown as { SpeechRecognition?: new () => never }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: new () => never }).webkitSpeechRecognition;
  if (!RecognitionCtor) {
    toast('当前浏览器不支持内置语音识别，请在设置中启用 Gemini 或 OpenAI 兼容渠道', 'error', 4200);
    return;
  }
  if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    toast('浏览器内置识别只在 HTTPS 或 localhost 下可用', 'error', 4200);
    return;
  }
  const recognition = new (RecognitionCtor as unknown as {
    new (): {
      lang: string;
      continuous: boolean;
      interimResults: boolean;
      onresult: ((event: unknown) => void) | null;
      onerror: ((event: unknown) => void) | null;
      onend: (() => void) | null;
      start: () => void;
      stop: () => void;
    };
  })();
  recognition.lang = active.value?.language || 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = true;
  browserFinalText = '';
  recognition.onresult = (event: unknown) => {
    const result = event as {
      resultIndex: number;
      results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
    };
    let partial = '';
    for (let i = result.resultIndex; i < result.results.length; i += 1) {
      const row = result.results[i];
      const text = row?.[0]?.transcript ?? '';
      if (row?.isFinal) browserFinalText += text;
      else partial += text;
    }
    const combined = `${browserFinalText}${partial}`.trim();
    if (combined) emit('partial', combined);
  };
  recognition.onerror = () => {
    toast('浏览器语音识别失败，请检查麦克风权限', 'error', 4200);
    if (browserFinalText.trim()) emit('text', browserFinalText.trim());
    recording.value = false;
    browserRecognition = null;
    emit('end');
  };
  recognition.onend = () => {
    if (recording.value) {
      try {
        recognition.start();
      } catch {
        recording.value = false;
        browserRecognition = null;
        emit('end');
      }
    }
  };
  browserRecognition = recognition;
  recording.value = true;
  liveStarted = true;
  emit('start');
  try {
    recognition.start();
  } catch {
    recording.value = false;
    browserRecognition = null;
    liveStarted = false;
    toast('无法启动浏览器语音识别', 'error', 4200);
    emit('end');
  }
}

function stopBrowser(): void {
  recording.value = false;
  const finalText = browserFinalText.trim();
  browserFinalText = '';
  if (browserRecognition) {
    try {
      browserRecognition.stop();
    } catch {
      // ignore
    }
    browserRecognition = null;
  }
  if (finalText) emit('text', finalText);
  if (liveStarted) {
    liveStarted = false;
    emit('end');
  }
}

async function toggleDictation(): Promise<void> {
  if (busy.value) {
    // While the stopped realtime session is flushing its final transcript,
    // another click is an explicit cancel, not a "please wait" toast.
    if (liveSocket) {
      cancelLive();
      return;
    }
    toast('正在识别上一段录音…', 'info');
    return;
  }
  if (recording.value) {
    if (liveSocket) stopLive();
    else if (browserRecognition) stopBrowser();
    else stopSegment();
    return;
  }
  if (!config.value) await loadConfig();
  if (!config.value) {
    toast('无法读取语音配置，请稍后重试', 'error', 4200);
    return;
  }
  if (!configured.value) {
    toast('语音识别尚未配置：请到 设置 → 语音识别 启用一个渠道', 'info', 4800);
    return;
  }
  if (liveEnabled.value) {
    await startLive();
    return;
  }
  if (active.value?.liveEnabled && !active.value.liveAvailable) {
    toast(
      `实时识别不可用：${active.value.liveDetail || '配置不完整'}，已回退到整段转写`,
      'info',
      4200,
    );
  }
  if (activeProvider.value === 'browser') startBrowserRecognition();
  else await startSegment();
}

function stopAll(): void {
  clearLiveTimer();
  recording.value = false;
  stopSegment();
  cleanupLiveAudio();
  if (browserRecognition) {
    try {
      browserRecognition.stop();
    } catch {
      // ignore
    }
    browserRecognition = null;
  }
  browserFinalText = '';
  if (liveSocket) {
    try {
      liveSocket.close();
    } catch {
      // ignore
    }
    liveSocket = null;
  }
  liveStarted = false;
  liveAudioActive = false;
  livePending = [];
  livePendingBytes = 0;
  liveStopRequested = false;
  liveFinalReceived = false;
  busy.value = false;
  starting.value = false;
}

onMounted(() => void loadConfig());
onUnmounted(() => {
  disposed = true;
  stopAll();
});
</script>

<template>
  <div class="voice-control">
    <button
      class="tool-btn voice-btn"
      :class="{ recording, busy }"
      :disabled="starting"
      :title="busy ? '正在收尾，点击可立即取消' : recording ? '结束语音输入' : '语音输入（边说边写）'"
      :aria-label="busy ? '取消语音收尾' : recording ? '结束语音输入' : '语音输入'"
      @click="toggleDictation"
    >
      <Icon name="mic" :size="16" />
      <span>{{ busy ? '处理中' : recording ? '结束' : '语音' }}</span>
      <span v-if="recording" class="voice-pulse" />
    </button>
  </div>
</template>
