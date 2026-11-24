import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { audit } from './audit.js';
import { authenticate } from './auth.js';
import { getVoiceConfig, voiceRateAllowed } from './voice.js';
import { createLiveSession, type VoiceLiveEvent } from './voiceLive.js';

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(value));
  } catch {
    // socket closed between checks
  }
}

function originAllowed(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * Browser <-> server audio bridge for Gemini Live.
 * Binary frames are raw PCM16 mono at 16 kHz; JSON frames are control events.
 */
export function registerVoiceWs(app: FastifyInstance): void {
  app.get('/ws/voice', { websocket: true }, (socket, req) => {
    const user = authenticate(req);
    if (!user) {
      socket.close(4401, 'unauthorized');
      return;
    }
    if (!originAllowed(req)) {
      socket.close(4403, 'forbidden origin');
      return;
    }
    if (!voiceRateAllowed(user.username)) {
      sendJson(socket, { type: 'error', message: '语音识别请求过于频繁，请稍后再试' });
      socket.close(4429, 'rate limited');
      return;
    }

    let audioBytes = 0;
    const provider = getVoiceConfig().active;
    const live = createLiveSession({
      onEvent: (event: VoiceLiveEvent) => {
        if (event.type === 'closed') return;
        sendJson(socket, event);
      },
      onClose: () => {
        audit(
          'voice.live',
          { user: user.username, provider, bytes: audioBytes, via: 'ws' },
          req.ip,
        );
        if (socket.readyState === 1) socket.close();
      },
    });

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        const chunk = Buffer.isBuffer(raw)
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : Buffer.from(raw);
        audioBytes += chunk.length;
        live.sendAudio(chunk);
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        sendJson(socket, { type: 'error', message: '消息格式错误' });
        return;
      }
      if (message.type === 'stop') live.endAudio();
      else if (message.type === 'close') live.close();
    });

    socket.on('close', () => live.close());
    socket.on('error', () => live.close());
  });
}
