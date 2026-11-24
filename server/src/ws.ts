import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { audit } from './audit.js';
import { authenticate } from './auth.js';
import { SessionManager } from './manager.js';
import type { PermissionDecision, UiEvent } from './types.js';
import { errorMessage } from './util.js';

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(value));
  } catch {
    // socket died between checks
  }
}

export function registerWs(app: FastifyInstance, manager: SessionManager): void {
  app.get('/ws', { websocket: true }, (socket, req: FastifyRequest) => {
    const user = authenticate(req);
    if (!user) {
      socket.close(4401, 'unauthorized');
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) {
          socket.close(4403, 'forbidden origin');
          return;
        }
      } catch {
        socket.close(4403, 'bad origin');
        return;
      }
    }

    let sessionId: string | null = null;
    let unsubscribeEvents: (() => void) | undefined;
    let unsubscribeState: (() => void) | undefined;
    let lastSent = 0;
    let closed = false;

    const detach = (): void => {
      unsubscribeEvents?.();
      unsubscribeEvents = undefined;
      unsubscribeState?.();
      unsubscribeState = undefined;
    };

    const sendEvent = (event: UiEvent): void => {
      if (event.seq <= lastSent) return;
      lastSent = event.seq;
      sendJson(socket, { type: 'event', event });
    };

    const sendState = (): void => {
      if (!sessionId) return;
      try {
        sendJson(socket, { type: 'state', state: manager.state(sessionId) });
      } catch (error) {
        sendJson(socket, { type: 'error', message: errorMessage(error) });
      }
    };

    const attach = async (id: string, fromSeq: number): Promise<void> => {
      detach();
      sessionId = id;
      lastSent = Math.max(0, fromSeq);
      const runtime = await manager.ensureRuntime(id);

      let live = false;
      const buffered: UiEvent[] = [];
      unsubscribeEvents = runtime.subscribeEvents((event) => {
        if (!live) buffered.push(event);
        else sendEvent(event);
      });
      unsubscribeState = manager.subscribeState(id, sendState);

      const events = manager.events(id, lastSent);
      const snapshotLast = events.length > 0 ? events[events.length - 1].seq : lastSent;
      lastSent = Math.max(lastSent, snapshotLast);
      sendJson(socket, {
        type: 'snapshot',
        sessionId: id,
        state: manager.state(id),
        events,
        lastSeq: lastSent,
      });
      live = true;
      for (const event of buffered) sendEvent(event);
      buffered.length = 0;
      sendState();
    };

    socket.on('message', (raw) => {
      if (closed) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        sendJson(socket, { type: 'error', message: '消息格式错误' });
        return;
      }
      const type = typeof message.type === 'string' ? message.type : '';
      void (async () => {
        try {
          if (type === 'attach') {
            const id = typeof message.sessionId === 'string' ? message.sessionId : '';
            if (!id) {
              sendJson(socket, { type: 'error', message: '缺少会话 ID' });
              return;
            }
            await attach(id, Number(message.lastSeq) || 0);
            return;
          }
          if (!sessionId) {
            sendJson(socket, { type: 'error', message: '请先 attach 会话' });
            return;
          }

          if (type === 'user.message') {
            const text = typeof message.text === 'string' ? message.text : '';
            const attachmentIds = Array.isArray(message.attachments)
              ? message.attachments.filter((value): value is string => typeof value === 'string')
              : [];
            if (!text.trim() && attachmentIds.length === 0) return;
            await manager.ensureTranscript(sessionId);
            await manager.send(sessionId, text, attachmentIds);
            audit(
              'message.send',
              { id: sessionId, chars: text.length, attachments: attachmentIds.length, via: 'ws' },
              req.ip,
            );
            return;
          }

          if (type === 'permission.response') {
            const requestId = typeof message.requestId === 'string' ? message.requestId : '';
            const decision = message.decision as PermissionDecision | undefined;
            if (!requestId || !decision || !['allow_once', 'allow_session', 'deny'].includes(decision)) {
              sendJson(socket, { type: 'error', message: '无效的审批参数' });
              return;
            }
            const updatedInput =
              message.updatedInput && typeof message.updatedInput === 'object'
                ? (message.updatedInput as Record<string, unknown>)
                : undefined;
            const ok = await manager.respondPermission(sessionId, requestId, decision, updatedInput);
            audit('permission.decision', { id: sessionId, requestId, decision, ok, via: 'ws' }, req.ip);
            if (!ok) sendJson(socket, { type: 'error', message: '审批请求已失效' });
            return;
          }

          if (type === 'interrupt') {
            await manager.interrupt(sessionId);
            audit('session.interrupt', { id: sessionId, via: 'ws' }, req.ip);
            return;
          }

          if (type === 'set.permissionMode') {
            const mode = typeof message.mode === 'string' ? message.mode : '';
            await manager.setMode(sessionId, mode);
            audit('session.mode', { id: sessionId, mode, via: 'ws' }, req.ip);
            return;
          }

          if (type === 'set.model') {
            const model = typeof message.model === 'string' ? message.model : undefined;
            await manager.setModel(sessionId, model);
            audit('session.model', { id: sessionId, model, via: 'ws' }, req.ip);
            return;
          }

          if (type === 'ping') {
            sendJson(socket, { type: 'pong', time: Date.now() });
            return;
          }

          sendJson(socket, { type: 'error', message: `未知消息类型：${type}` });
        } catch (error) {
          sendJson(socket, { type: 'error', message: errorMessage(error) });
        }
      })();
    });

    const heartbeat = setInterval(() => {
      if (socket.readyState === 1) {
        try {
          socket.ping();
        } catch {
          // ignore
        }
      }
    }, 25_000);
    heartbeat.unref?.();

    socket.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      detach();
    });
    socket.on('error', () => {
      closed = true;
      clearInterval(heartbeat);
      detach();
    });
  });
}
