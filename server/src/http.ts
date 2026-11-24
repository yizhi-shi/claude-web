import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import { contentDisposition } from './attachments.js';
import { audit } from './audit.js';
import {
  accountLockRemaining,
  authenticate,
  changePassword,
  clearAccountLock,
  clearLoginFailures,
  clearSessionCookie,
  getUsername,
  isSetupRequired,
  issueSessionCookie,
  loginAllowed,
  recordLoginFailure,
  setupAdmin,
  verifyCredentials,
  type AuthUser,
} from './auth.js';
import { config } from './config.js';
import { SessionManager } from './manager.js';
import { createWorkspaceDir, listDirectory, searchFiles, validateCwd } from './paths.js';
import { getThemePreference, setThemePreference } from './preferences.js';
import { updateWorkspaces, workspaceConfig } from './workspaces.js';
import type { PermissionDecision } from './types.js';
import { errorMessage, HttpError } from './util.js';
import { getVersions } from './versions.js';
import {
  getVoiceConfig,
  maskedVoiceConfig,
  testVoiceProvider,
  transcribeAudio,
  updateVoiceConfig,
  voiceRateAllowed,
  type VoiceProviderId,
} from './voice.js';
import { testVoiceLive } from './voiceLive.js';

type Handler = (
  req: FastifyRequest,
  reply: FastifyReply,
  user: AuthUser,
) => Promise<unknown> | unknown;

function statusOf(error: unknown): number {
  if (error instanceof HttpError) return error.statusCode;
  const candidate = (error as { statusCode?: unknown })?.statusCode;
  return typeof candidate === 'number' ? candidate : 500;
}

function sendError(reply: FastifyReply, error: unknown): void {
  if (reply.sent) return;
  const status = statusOf(error);
  void reply.code(status).send({ error: status >= 500 ? '服务器内部错误' : errorMessage(error) });
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error('[claude-web] request failed:', error);
  }
}

function authed(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  handler: Handler,
): void {
  app.route({
    method,
    url,
    handler: async (req, reply) => {
      const user = authenticate(req);
      if (!user) return reply.code(401).send({ error: '未登录或会话已过期' });
      try {
        return await handler(req, reply, user);
      } catch (error) {
        sendError(reply, error);
      }
    },
  });
}

function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function registerHttp(app: FastifyInstance, manager: SessionManager): void {
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      try {
        const parsed = new URL(origin);
        if (parsed.host !== req.headers.host) {
          return reply.code(403).send({ error: '跨站请求已被拒绝' });
        }
      } catch {
        return reply.code(403).send({ error: '非法来源' });
      }
    }
    return undefined;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    // Allow the page itself to request microphone access (voice input); camera &
    // geolocation stay disabled. `microphone=()` would make getUserMedia fail
    // with NotAllowedError before the browser ever shows a permission prompt.
    reply.header('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
    // Attachment bytes are immutable (UUID file names) and can be cached
    // privately; every other API response must not be cached.
    const isAttachment = /^\/api\/sessions\/[^/]+\/attachments\/[^/?]+(?:\?.*)?$/.test(req.url);
    if (req.url.startsWith('/api/') && !isAttachment) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  app.get('/api/auth/status', async () => ({
    setupRequired: isSetupRequired(),
    username: isSetupRequired() ? '' : getUsername(),
    defaultTheme: getThemePreference(),
  }));

  app.post('/api/auth/setup', async (req, reply) => {
    if (!isSetupRequired()) {
      return reply.code(409).send({ error: '管理员账号已初始化，请直接登录' });
    }
    const ip = req.ip;
    if (!loginAllowed(ip)) {
      return reply.code(429).send({ error: '尝试次数过多，请稍后再试' });
    }
    const body = req.body as { username?: unknown; password?: unknown } | undefined;
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    try {
      setupAdmin(username, password);
    } catch (error) {
      recordLoginFailure(ip, '');
      return reply.code(statusOf(error)).send({ error: errorMessage(error) });
    }
    issueSessionCookie(req, reply);
    audit('setup.completed', { username }, ip);
    return { user: { username: getUsername() } };
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (isSetupRequired()) {
      return reply.code(409).send({ error: '请先初始化管理员账号', setupRequired: true });
    }
    const ip = req.ip;
    if (!loginAllowed(ip)) {
      return reply.code(429).send({ error: '尝试次数过多，请稍后再试' });
    }
    const body = req.body as { username?: unknown; password?: unknown } | undefined;
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!username || !password) {
      return reply.code(400).send({ error: '请输入账号和密码' });
    }

    const locked = accountLockRemaining(username);
    if (locked > 0) {
      reply.header('Retry-After', String(Math.ceil(locked / 1000)));
      return reply.code(429).send({
        error: `账号已锁定，请 ${Math.ceil(locked / 60_000)} 分钟后重试`,
        retryAfterMs: locked,
      });
    }

    const ok = await verifyCredentials(username, password);
    if (!ok) {
      const lockMs = recordLoginFailure(ip, username);
      audit('login.failed', { username }, ip);
      if (lockMs > 0) {
        reply.header('Retry-After', String(Math.ceil(lockMs / 1000)));
        audit('account.locked', { username, minutes: Math.round(lockMs / 60_000) }, ip);
        return reply.code(429).send({
          error: `连续多次密码错误，账号已锁定 ${Math.round(lockMs / 60_000)} 分钟`,
          retryAfterMs: lockMs,
        });
      }
      return reply.code(401).send({ error: '账号或密码错误' });
    }
    clearLoginFailures(ip, username);
    issueSessionCookie(req, reply);
    audit('login.success', { username: getUsername() }, ip);
    return { user: { username: getUsername() } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    clearSessionCookie(reply);
    audit('logout', {}, req.ip);
    return { ok: true };
  });

  authed(app, 'GET', '/api/auth/me', async (_req, _reply, user) => ({
    user: { username: user.username },
  }));

  authed(app, 'POST', '/api/auth/change-password', async (req, reply, user) => {
    const body = req.body as { current?: unknown; next?: unknown } | undefined;
    const current = typeof body?.current === 'string' ? body.current : '';
    const next = typeof body?.next === 'string' ? body.next : '';
    try {
      await changePassword(current, next);
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: errorMessage(error) });
    }
    clearAccountLock(user.username);
    issueSessionCookie(req, reply);
    audit('password.changed', { username: user.username }, req.ip);
    return { ok: true };
  });

  authed(app, 'GET', '/api/config', async () => {
    const versions = getVersions();
    const workspaces = workspaceConfig();
    return {
      username: getUsername(),
      versions,
      allowedRoots: workspaces.allowedRoots,
      defaultRoot: workspaces.defaultRoot,
      permissionModes: [
        { value: 'default', label: '每次询问（推荐）' },
        { value: 'acceptEdits', label: '自动接受文件编辑' },
        { value: 'plan', label: '计划模式（只读）' },
        { value: 'auto', label: '自动判断（模型分类器）' },
        { value: 'dontAsk', label: '不问，未授权即拒绝' },
        { value: 'bypassPermissions', label: '跳过所有确认（危险）' },
      ],
      models: {
        current: process.env.ANTHROPIC_MODEL || process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
        custom: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION || '',
        customName: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME || '',
        baseUrl: process.env.ANTHROPIC_BASE_URL || '',
      },
      defaultPermissionMode: config.defaultPermissionMode,
      defaultTheme: getThemePreference(),
      idleMinutes: Math.round(config.idleMs / 60_000),
      permissionTimeoutMinutes: Math.round(config.permissionTimeoutMs / 60_000),
      dataDir: config.dataDir,
    };
  });

  authed(app, 'GET', '/api/voice/config', async () => maskedVoiceConfig());

  authed(app, 'PUT', '/api/voice/config', async (req) => {
    const body = req.body as { active?: unknown; providers?: Record<string, unknown> } | undefined;
    const next = updateVoiceConfig(body ?? {});
    audit('voice.config', {}, req.ip);
    return next;
  });

  authed(app, 'POST', '/api/voice/test', async (req, reply) => {
    const body = req.body as { provider?: unknown } | undefined;
    const provider = typeof body?.provider === 'string' ? body.provider : '';
    if (!['gemini', 'openai', 'volcengine', 'browser'].includes(provider)) {
      return reply.code(400).send({ error: '未知的语音渠道' });
    }
    const result = await testVoiceProvider(provider as VoiceProviderId);
    audit('voice.test', { provider, ok: result.ok, latencyMs: result.latencyMs }, req.ip);
    return result;
  });

  authed(app, 'POST', '/api/voice/live-test', async (req, reply, user) => {
    if (!voiceRateAllowed(user.username)) {
      return reply.code(429).send({ error: '语音识别请求过于频繁，请稍后再试' });
    }
    const body = req.body as { provider?: unknown } | undefined;
    const provider =
      typeof body?.provider === 'string' &&
      ['gemini', 'openai', 'volcengine', 'browser'].includes(body.provider)
        ? (body.provider as VoiceProviderId)
        : getVoiceConfig().active;
    try {
      const result = await testVoiceLive(provider);
      audit(
        'voice.live.test',
        { provider, ok: result.ok, latencyMs: result.latencyMs },
        req.ip,
      );
      return result;
    } catch (error) {
      throw new HttpError(400, errorMessage(error));
    }
  });

  authed(app, 'POST', '/api/voice/transcribe', async (req, reply, user) => {
    if (!voiceRateAllowed(user.username)) {
      return reply.code(429).send({ error: '语音识别请求过于频繁，请稍后再试' });
    }
    const body = req.body as
      | {
          provider?: unknown;
          audioBase64?: unknown;
          mimeType?: unknown;
          language?: unknown;
        }
      | undefined;
    const provider =
      typeof body?.provider === 'string' &&
      ['gemini', 'openai', 'volcengine', 'browser'].includes(body.provider)
        ? (body.provider as VoiceProviderId)
        : undefined;
    const audioBase64 = typeof body?.audioBase64 === 'string' ? body.audioBase64 : '';
    const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : undefined;
    const language = typeof body?.language === 'string' ? body.language : undefined;
    const result = await transcribeAudio({ provider, audioBase64, mimeType, language });
    audit(
      'voice.transcribe',
      {
        provider: result.provider,
        model: result.model,
        latencyMs: result.latencyMs,
        bytes: Math.round(audioBase64.length * 0.75),
      },
      req.ip,
    );
    return result;
  });

  authed(app, 'GET', '/api/sessions', async (req) => {
    const query = req.query as { limit?: unknown };
    const limit = intParam(query.limit, 200, 1, 1000);
    return { sessions: await manager.listSummaries(limit) };
  });

  authed(app, 'GET', '/api/projects/recent', async () => ({
    projects: await manager.projects(),
  }));

  authed(app, 'GET', '/api/preferences', async () => ({
    theme: getThemePreference(),
  }));

  authed(app, 'PUT', '/api/preferences', async (req) => {
    const body = req.body as { theme?: unknown } | undefined;
    const theme = setThemePreference(body?.theme);
    audit('preferences.theme', { theme }, req.ip);
    return { theme };
  });

  authed(app, 'GET', '/api/workspaces', async () => workspaceConfig());

  authed(app, 'PUT', '/api/workspaces', async (req) => {
    const body = req.body as
      | { defaultRoot?: unknown; extraRoots?: unknown }
      | undefined;
    const next = updateWorkspaces(body ?? {});
    audit('workspace.update', { defaultRoot: next.defaultRoot, extraRoots: next.extraRoots }, req.ip);
    return next;
  });

  authed(app, 'POST', '/api/fs/mkdir', async (req, reply) => {
    const body = req.body as { parent?: unknown; name?: unknown } | undefined;
    const parent = typeof body?.parent === 'string' ? body.parent : '';
    const name = typeof body?.name === 'string' ? body.name : '';
    if (!parent) return reply.code(400).send({ error: '缺少父目录' });
    const created = createWorkspaceDir(parent, name);
    audit('workspace.mkdir', { parent, name, created }, req.ip);
    return { path: created };
  });

  authed(app, 'GET', '/api/fs/list', async (req) => {
    const query = req.query as { path?: unknown };
    const target = typeof query.path === 'string' ? query.path : undefined;
    return listDirectory(target);
  });

  authed(app, 'GET', '/api/fs/search', async (req) => {
    const query = req.query as { cwd?: unknown; q?: unknown; limit?: unknown };
    const cwd = typeof query.cwd === 'string' ? query.cwd : '';
    const q = typeof query.q === 'string' ? query.q : '';
    const limit = intParam(query.limit, 50, 1, 100);
    return searchFiles(cwd, q, limit);
  });

  authed(app, 'POST', '/api/sessions', async (req, reply, user) => {
    const body = req.body as
      | { cwd?: unknown; permissionMode?: unknown; model?: unknown; resume?: unknown }
      | undefined;
    const resume = typeof body?.resume === 'string' ? body.resume : '';
    if (resume) {
      const meta = await manager.resumeSession(resume);
      audit('session.resume', { id: meta.id, cwd: meta.cwd }, req.ip);
      return manager.state(meta.id);
    }
    const cwd = validateCwd(typeof body?.cwd === 'string' ? body.cwd : '');
    const permissionMode =
      typeof body?.permissionMode === 'string' ? body.permissionMode : undefined;
    const model = typeof body?.model === 'string' ? body.model : undefined;
    const meta = manager.createSession({ cwd, permissionMode, model });
    audit('session.create', { id: meta.id, cwd, permissionMode: meta.permissionMode, by: user.username }, req.ip);
    return manager.state(meta.id);
  });

  authed(app, 'GET', '/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    await manager.ensureTranscript(id);
    return manager.state(id);
  });

  authed(app, 'GET', '/api/sessions/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as {
      after?: unknown;
      before?: unknown;
      limit?: unknown;
      tail?: unknown;
      compact?: unknown;
    };
    await manager.ensureTranscript(id);
    const after = intParam(query.after, 0, 0, Number.MAX_SAFE_INTEGER);
    const before =
      query.before === undefined
        ? undefined
        : intParam(query.before, Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(query.limit, config.maxEventsPerFetch, 1, config.maxEventsPerFetch);
    const tail = query.tail === '1' || query.tail === 'true';
    const compact = query.compact === '1' || query.compact === 'true';
    const events = manager.eventsWindow(id, { after, before, limit, tail, compact });
    const lastSeq = manager.lastSeq(id);
    const firstSeq = events.length > 0 ? events[0].seq : after;
    const hasMore = events.length > 0 && firstSeq > after + 1;
    return { events, state: manager.state(id), lastSeq, firstSeq, hasMore };
  });

  authed(app, 'GET', '/api/sessions/:id/context', async (req) => {
    const { id } = req.params as { id: string };
    await manager.ensureTranscript(id);
    const runtime = manager.runtime(id);
    const contextUsage = runtime
      ? await runtime.refreshContextUsage()
      : manager.state(id).contextUsage;
    return { contextUsage };
  });

  authed(app, 'POST', '/api/sessions/:id/attachments', async (req) => {
    const { id } = req.params as { id: string };
    await manager.ensureTranscript(id);
    const body = req.body as
      | { name?: unknown; mimeType?: unknown; dataBase64?: unknown }
      | undefined;
    const attachment = manager.attachments.save(id, body ?? {});
    audit(
      'attachment.upload',
      {
        id,
        attachmentId: attachment.id,
        name: attachment.name,
        mime: attachment.mimeType,
        bytes: attachment.size,
      },
      req.ip,
    );
    return { attachment };
  });

  authed(app, 'GET', '/api/sessions/:id/attachments/:attachmentId', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    await manager.ensureTranscript(id);
    const { meta, file, size } = manager.attachments.read(id, attachmentId);
    reply.header('Content-Type', meta.kind === 'image' ? meta.mimeType : 'application/octet-stream');
    reply.header('Content-Disposition', contentDisposition(meta.kind, meta.name));
    reply.header('Content-Length', String(size));
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.send(fs.createReadStream(file));
  });

  authed(app, 'POST', '/api/sessions/:id/stop', async (req) => {
    const { id } = req.params as { id: string };
    await manager.ensureTranscript(id);
    await manager.stop(id);
    audit('session.stop', { id }, req.ip);
    return manager.state(id);
  });

  authed(app, 'POST', '/api/sessions/:id/interrupt', async (req) => {
    const { id } = req.params as { id: string };
    await manager.ensureTranscript(id);
    const stopped = await manager.interrupt(id);
    audit('session.interrupt', { id, stopped }, req.ip);
    return { ok: true, stopped, state: manager.state(id) };
  });

  authed(app, 'POST', '/api/sessions/:id/permission', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as
      | { requestId?: unknown; decision?: unknown; updatedInput?: unknown }
      | undefined;
    const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
    const decision = body?.decision as PermissionDecision | undefined;
    if (!requestId || !decision || !['allow_once', 'allow_session', 'deny'].includes(decision)) {
      return reply.code(400).send({ error: '无效的审批参数' });
    }
    const updatedInput =
      body?.updatedInput && typeof body.updatedInput === 'object'
        ? (body.updatedInput as Record<string, unknown>)
        : undefined;
    const ok = await manager.respondPermission(id, requestId, decision, updatedInput);
    audit('permission.decision', { id, requestId, decision, ok }, req.ip);
    return { ok, state: manager.state(id) };
  });

  authed(app, 'POST', '/api/sessions/:id/question', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as
      | { requestId?: unknown; answers?: unknown; skipped?: unknown }
      | undefined;
    const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
    if (!requestId) return reply.code(400).send({ error: '缺少问题请求 ID' });
    const answers =
      body?.answers && typeof body.answers === 'object'
        ? (body.answers as Record<string, unknown>)
        : undefined;
    const skipped = body?.skipped === true;
    const ok = await manager.respondQuestion(id, requestId, answers, skipped);
    audit(
      'question.answer',
      { id, requestId, ok, skipped, answered: answers ? Object.keys(answers).length : 0 },
      req.ip,
    );
    return { ok, state: manager.state(id) };
  });

  authed(app, 'POST', '/api/sessions/:id/plan', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as
      | { requestId?: unknown; approved?: unknown; feedback?: unknown }
      | undefined;
    const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
    if (!requestId || typeof body?.approved !== 'boolean') {
      return reply.code(400).send({ error: '无效的计划确认参数' });
    }
    const feedback = typeof body.feedback === 'string' ? body.feedback : '';
    const ok = await manager.respondPlan(id, requestId, body.approved, feedback);
    audit(
      'plan.decision',
      { id, requestId, approved: body.approved, ok, feedbackChars: feedback.length },
      req.ip,
    );
    return { ok, state: manager.state(id) };
  });

  authed(app, 'POST', '/api/sessions/:id/mode', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { mode?: unknown } | undefined;
    const mode = typeof body?.mode === 'string' ? body.mode : '';
    try {
      await manager.setMode(id, mode);
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: errorMessage(error) });
    }
    audit('session.mode', { id, mode }, req.ip);
    return manager.state(id);
  });

  authed(app, 'POST', '/api/sessions/:id/model', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { model?: unknown } | undefined;
    const model = typeof body?.model === 'string' ? body.model : undefined;
    await manager.setModel(id, model);
    audit('session.model', { id, model }, req.ip);
    return manager.state(id);
  });

  // Kept for programmatic clients that only have a session id.
  authed(app, 'POST', '/api/sessions/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { text?: unknown; attachments?: unknown } | undefined;
    const text = typeof body?.text === 'string' ? body.text : '';
    const attachmentIds = Array.isArray(body?.attachments)
      ? body.attachments.filter((value): value is string => typeof value === 'string')
      : [];
    if (!text.trim() && attachmentIds.length === 0) {
      return reply.code(400).send({ error: '消息不能为空' });
    }
    await manager.ensureTranscript(id);
    await manager.send(id, text, attachmentIds);
    audit('message.send', { id, chars: text.length, attachments: attachmentIds.length }, req.ip);
    return { ok: true, state: manager.state(id) };
  });
}
