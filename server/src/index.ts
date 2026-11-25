import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { AttachmentStore } from './attachments.js';
import { audit } from './audit.js';
import { initAuth } from './auth.js';
import { config, ensureDataDirs, loadClaudeSettingsEnv } from './config.js';
import { registerHttp } from './http.js';
import { SessionManager } from './manager.js';
import { initSecurity } from './security.js';
import { SessionIndex } from './sessionIndex.js';
import { TranscriptStore } from './transcript.js';
import { registerVoiceWs } from './voiceWs.js';
import { registerWs } from './ws.js';

async function main(): Promise<void> {
  loadClaudeSettingsEnv();
  ensureDataDirs();
  initAuth();
  initSecurity();

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 18 * 1024 * 1024,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

  const index = new SessionIndex(config.dataDir);
  const transcript = new TranscriptStore(path.join(config.dataDir, 'transcripts'));
  const attachments = new AttachmentStore(path.join(config.dataDir, 'attachments'));
  const manager = new SessionManager(index, transcript, attachments);

  registerHttp(app, manager);
  registerWs(app, manager);
  registerVoiceWs(app);

  const indexHtml = path.join(config.webDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn(`web bundle not found at ${config.webDist}; run "npm run build:web"`);
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('前端尚未构建。请先运行 npm run build，再启动服务。');
    });
  }

  await app.listen({ host: config.host, port: config.port });
  audit('server.start', { host: config.host, port: config.port, pid: process.pid });
  app.log.info(`claude-web listening on http://${config.host}:${config.port}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`received ${signal}, stopping background Claude sessions...`);
    audit('server.stop', { signal });
    const forced = setTimeout(() => process.exit(1), 15_000);
    forced.unref();
    try {
      await manager.shutdown();
      await app.close();
    } catch (error) {
      app.log.error(error);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ reason }, 'unhandled rejection');
  });
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[claude-web] fatal:', error);
  process.exit(1);
});
