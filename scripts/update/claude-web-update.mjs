#!/usr/bin/env node
/**
 * Standalone updater for Claude Code Web.
 *
 * This file is copied to `<install-root>/bin/claude-web-update.mjs` and runs
 * from its own systemd oneshot unit. It deliberately does not import anything
 * from the running application: if the app is broken, the updater must still
 * be able to download, verify, switch and roll back a release.
 *
 * Usage:
 *   claude-web-update.mjs check
 *   claude-web-update.mjs status
 *   claude-web-update.mjs apply --request <file> [--root <dir>] [--no-service]
 *   claude-web-update.mjs apply --version <version> [--root <dir>]
 *   claude-web-update.mjs rollback [--root <dir>]
 */
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_ROOT = path.basename(HERE) === 'bin' ? path.dirname(HERE) : path.resolve(HERE, '../..');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const args = {
  action: (process.argv[2] || 'status').toLowerCase(),
  root: path.resolve(argValue('--root') || process.env.UPDATE_ROOT || SCRIPT_ROOT),
  request: argValue('--request') || process.env.UPDATE_REQUEST_FILE || '',
  version: argValue('--version') || '',
  noService: process.argv.includes('--no-service'),
  skipHealth: process.argv.includes('--skip-health'),
};
const dataDir = path.resolve(process.env.DATA_DIR || path.join(args.root, 'data'));
const stateDir = path.join(dataDir, 'updates');
const statePath = path.join(stateDir, 'state.json');
const requestPath = args.request ? path.resolve(args.request) : path.join(stateDir, 'request.json');
const installedPath = path.join(args.root, 'installed.json');

const channel = process.env.UPDATE_CHANNEL || 'stable';
const feedUrls = (process.env.UPDATE_FEED_URLS || process.env.UPDATE_FEED_URL || 'https://github.com/yizhi-shi/claude-web/releases/latest/download')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const proxyUrl =
  process.env.UPDATE_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy || '';
const requireSignature = !['0', 'false', 'no', 'off'].includes(
  (process.env.UPDATE_REQUIRE_SIGNATURE || '1').toLowerCase(),
);
const serviceName = process.env.UPDATE_WEB_SERVICE || 'claude-web.service';
const systemdScope = process.env.UPDATE_SYSTEMD_SCOPE || (process.env.XDG_RUNTIME_DIR ? 'user' : 'system');
const healthUrl =
  process.env.UPDATE_HEALTH_URL ||
  `http://127.0.0.1:${process.env.PORT || '8010'}/api/health`;
const keepReleases = Math.max(2, Number(process.env.UPDATE_KEEP_RELEASES || 3) || 3);

function nowIso() {
  return new Date().toISOString();
}

function log(message) {
  const line = `[${nowIso()}] ${message}`;
  process.stdout.write(`${line}\n`);
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(stateDir, 'update.log'), `${line}\n`, { mode: 0o600 });
  } catch {
    // logging must never fail the update
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(tmp, file);
}

let state = readJson(statePath, null) || {
  action: args.action === 'rollback' ? 'rollback' : 'apply',
  phase: 'queued',
  startedAt: nowIso(),
  progress: 0,
};

function saveState(patch) {
  state = { ...state, ...patch, updatedAt: nowIso() };
  writeJson(statePath, state);
}

function fail(message) {
  log(`FAILED: ${message}`);
  saveState({ phase: 'failed', error: message, finishedAt: nowIso(), progress: 100 });
  process.exitCode = 1;
}

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || '').trim());
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] ? match[4].split('.') : [],
  ];
}

function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  if (left[3].length === 0 && right[3].length > 0) return 1;
  if (right[3].length === 0 && left[3].length > 0) return -1;
  for (let i = 0; i < Math.max(left[3].length, right[3].length); i += 1) {
    const l = left[3][i];
    const r = right[3][i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    return l > r ? 1 : -1;
  }
  return 0;
}

function platformTag() {
  const libc = process.platform === 'linux' && fs.existsSync('/etc/alpine-release') ? 'musl' : 'gnu';
  return `${process.platform}-${process.arch}-${libc}`;
}

function normalizeFeedUrl(value) {
  if (!value) return '';
  return value.endsWith('.json') ? value : `${value.replace(/\/+$/, '')}/latest.json`;
}

function resolveArtifactUrl(raw, base) {
  const resolved = new URL(raw, base).toString();
  const parsed = new URL(resolved);
  const local = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new Error(`artifact URL must use HTTPS: ${parsed.origin}`);
  }
  return resolved;
}

function readPublicKey() {
  if (process.env.UPDATE_PUBLIC_KEY && process.env.UPDATE_PUBLIC_KEY.trim()) {
    return process.env.UPDATE_PUBLIC_KEY;
  }
  const candidates = [
    process.env.UPDATE_PUBLIC_KEY_FILE,
    path.join(args.root, 'bin', 'update-public-key.pem'),
    path.join(args.root, 'deploy', 'update-public-key.pem'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      // next candidate
    }
  }
  return '';
}

const publicKey = readPublicKey();

function validateManifest(manifest) {
  if (!manifest || manifest.schema !== 1) throw new Error('unsupported manifest schema');
  if (manifest.name !== 'claude-web') throw new Error('manifest name mismatch');
  if (!parseSemver(manifest.version)) throw new Error('invalid manifest version');
  if (manifest.channel !== channel) throw new Error(`channel mismatch: ${manifest.channel}`);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error('manifest has no artifacts');
  }
  for (const artifact of manifest.artifacts) {
    if (
      !artifact ||
      typeof artifact.platform !== 'string' ||
      typeof artifact.url !== 'string' ||
      typeof artifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(artifact.sha256) ||
      typeof artifact.size !== 'number' ||
      artifact.size <= 0
    ) {
      throw new Error('invalid artifact entry');
    }
  }
}

function selectArtifact(manifest) {
  const tag = platformTag();
  return (
    manifest.artifacts.find((item) => item.platform === tag) ||
    manifest.artifacts.find((item) => item.platform === 'any' || item.platform === 'linux-any') ||
    null
  );
}

async function fetchBuffer(url, timeoutMs = 20_000) {
  if (proxyUrl) {
    const { stdout } = await execFileAsync(
      'curl',
      ['-fsSL', '--proto', '=https,http', '--tlsv1.2', '--connect-timeout', '15', '--max-time', String(Math.round(timeoutMs / 1000)), url],
      { maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs + 5000, env: { ...process.env, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl } },
    );
    return Buffer.from(stdout, 'binary');
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'claude-web-updater' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function download(url, dest, expectedSha, expectedSize) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  if (fs.existsSync(dest)) {
    const existing = sha256File(dest);
    if (existing === expectedSha) {
      log(`using cached artifact ${path.basename(dest)}`);
      return;
    }
    fs.rmSync(dest, { force: true });
  }
  const part = `${dest}.part`;
  fs.rmSync(part, { force: true });
  if (proxyUrl) {
    log('downloading via curl proxy');
    await execFileAsync(
      'curl',
      [
        '-fsSL',
        '--proto',
        '=https,http',
        '--tlsv1.2',
        '--connect-timeout',
        '20',
        '--max-time',
        '1800',
        '--retry',
        '2',
        '--retry-delay',
        '2',
        '-o',
        part,
        url,
      ],
      { timeout: 1_900_000, env: { ...process.env, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl } },
    );
  } else {
    log('downloading artifact');
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30 * 60_000),
      headers: { 'user-agent': 'claude-web-updater' },
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    if (!response.body) throw new Error('empty response body');
    const handle = await fs.promises.open(part, 'w', 0o600);
    try {
      for await (const chunk of response.body) {
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
  }
  const size = fs.statSync(part).size;
  if (expectedSize && size !== expectedSize) {
    throw new Error(`artifact size mismatch: expected ${expectedSize}, got ${size}`);
  }
  const digest = sha256File(part);
  if (digest !== expectedSha) {
    throw new Error(`artifact sha256 mismatch: expected ${expectedSha}, got ${digest}`);
  }
  fs.renameSync(part, dest);
  log(`downloaded ${path.basename(dest)} (${size} bytes)`);
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let read = 0;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

async function loadManifest() {
  let lastError = '';
  for (const rawFeed of feedUrls) {
    const feedUrl = normalizeFeedUrl(rawFeed);
    try {
      const raw = await fetchBuffer(feedUrl);
      if (raw.length > 1024 * 1024) throw new Error('manifest too large');
      if (requireSignature) {
        if (!publicKey) throw new Error('no update public key configured');
        const sig = await fetchBuffer(`${feedUrl}.sig`);
        if (sig.length === 0 || !crypto.verify(null, raw, publicKey, sig)) {
          throw new Error('manifest signature verification failed');
        }
      }
      const manifest = JSON.parse(raw.toString('utf8'));
      validateManifest(manifest);
      const artifact = selectArtifact(manifest);
      if (!artifact) throw new Error(`no artifact for ${platformTag()}`);
      return {
        manifest,
        feedUrl,
        artifact: { ...artifact, url: resolveArtifactUrl(artifact.url, feedUrl) },
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log(`feed failed: ${feedUrl}: ${lastError}`);
    }
  }
  throw new Error(lastError || 'no update feed configured');
}

function assertTarEntry(name) {
  if (!name || name.includes('\0')) throw new Error('empty tar entry');
  if (name.startsWith('/') || path.isAbsolute(name)) throw new Error(`absolute tar entry: ${name}`);
  const parts = name.split('/');
  if (parts.includes('..')) throw new Error(`tar path traversal: ${name}`);
}

async function inspectTar(archive) {
  const [namesResult, verboseResult] = await Promise.all([
    execFileAsync('tar', ['-tzf', archive], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    }),
    execFileAsync('tar', ['-tvzf', archive], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    }),
  ]);
  const names = namesResult.stdout.split('\n').filter((line) => line.length > 0);
  const verbose = verboseResult.stdout.split('\n').filter((line) => line.length > 0);
  if (names.length !== verbose.length) throw new Error('archive listing mismatch');
  let total = 0;
  if (names.length > 30_000) throw new Error('archive has too many entries');
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    assertTarEntry(name);
    const line = verbose[i];
    const type = line[0];
    if (!['-', 'd', 'l', 'h'].includes(type)) {
      throw new Error(`archive contains unsupported entry type: ${type}`);
    }
    const fields = line.split(/\s+/);
    const size = Number(fields[2]);
    if (Number.isFinite(size)) total += size;
    if (type === 'l' || type === 'h') {
      const arrow = line.lastIndexOf(' -> ');
      if (arrow < 0) throw new Error(`invalid link entry: ${name}`);
      const target = line.slice(arrow + 4);
      if (!target || target.startsWith('/') || target.includes('\0')) {
        throw new Error(`unsafe link target for ${name}`);
      }
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(name), target),
      );
      if (resolved === '..' || resolved.startsWith('../')) {
        throw new Error(`link escapes archive root: ${name} -> ${target}`);
      }
    }
  }
  if (total > 4 * 1024 * 1024 * 1024) throw new Error('archive is too large after extraction');
}

function removeTree(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function moveDir(source, dest) {
  try {
    fs.renameSync(source, dest);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    fs.cpSync(source, dest, { recursive: true, preserveTimestamps: true });
    removeTree(source);
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function smokeTest(staging, version) {
  const port = await findFreePort();
  const smokeData = path.join(stateDir, `smoke-${process.pid}-${Date.now()}`);
  fs.mkdirSync(smokeData, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [path.join(staging, 'dist/server/index.js')], {
    cwd: staging,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: smokeData,
      ALLOWED_ROOTS: smokeData,
      WEB_DIST: path.join(staging, 'web/dist'),
      COOKIE_SECURE: 'never',
      UPDATE_MODE: 'off',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`staged server exited early: ${stderr.slice(-1200)}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          const payload = await response.json();
          if (payload.version !== version) {
            throw new Error(`staged version mismatch: ${payload.version} != ${version}`);
          }
          return;
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('staged version')) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(`staged smoke test timed out: ${stderr.slice(-1200)}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    removeTree(smokeData);
  }
}

async function runCommand(command, label, timeoutMs = 120_000) {
  log(label);
  await execFileAsync('/bin/sh', ['-c', command], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function stopService() {
  if (args.noService) return;
  if (process.env.UPDATE_STOP_COMMAND) {
    await runCommand(process.env.UPDATE_STOP_COMMAND, 'stopping web service (custom command)', 120_000);
    return;
  }
  const scope = systemdScope === 'user' ? ['--user'] : [];
  log(`stopping ${serviceName}`);
  await execFileAsync('systemctl', [...scope, 'stop', serviceName], { timeout: 120_000 });
}

async function startService() {
  if (args.noService) return;
  if (process.env.UPDATE_START_COMMAND) {
    await runCommand(process.env.UPDATE_START_COMMAND, 'starting web service (custom command)', 120_000);
    return;
  }
  const scope = systemdScope === 'user' ? ['--user'] : [];
  log(`starting ${serviceName}`);
  await execFileAsync('systemctl', [...scope, 'start', serviceName], { timeout: 120_000 });
}

async function waitForHealth(version, timeoutMs = 90_000) {
  if (args.noService || args.skipHealth) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const payload = await response.json();
        if (payload.version === version) return true;
      }
    } catch {
      // service is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function currentTarget() {
  const current = path.join(args.root, 'current');
  try {
    return fs.realpathSync(current);
  } catch {
    return '';
  }
}

function switchCurrent(version) {
  const release = path.join(args.root, 'releases', version);
  if (!fs.existsSync(release)) throw new Error(`release not found: ${release}`);
  const current = path.join(args.root, 'current');
  const tmp = path.join(args.root, `.current-${process.pid}-${Date.now()}`);
  try {
    fs.symlinkSync(path.join('releases', version), tmp, 'dir');
    fs.renameSync(tmp, current);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  log(`current -> releases/${version}`);
}

function readInstalled() {
  return readJson(installedPath, {});
}

function writeInstalled(value) {
  writeJson(installedPath, value, 0o644);
}

function siblingReleases() {
  const root = path.join(args.root, 'releases');
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && parseSemver(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => compareSemver(b, a));
  } catch {
    return [];
  }
}

function cleanupReleases(activeVersion, previousVersion) {
  const releases = siblingReleases();
  const keep = new Set([activeVersion, previousVersion, ...releases.slice(0, keepReleases)]);
  for (const version of releases) {
    if (keep.has(version)) continue;
    removeTree(path.join(args.root, 'releases', version));
    log(`removed old release ${version}`);
  }
}

async function acquireLock() {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDir, 'update.lock');
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }));
    fs.closeSync(fd);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readJson(lockPath, {});
    const age = Date.now() - Date.parse(existing.at || 0);
    if (existing.pid && age < 60 * 60_000) {
      throw new Error('another update is already running');
    }
    fs.rmSync(lockPath, { force: true });
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }));
    fs.closeSync(fd);
  }
  return () => fs.rmSync(lockPath, { force: true });
}

async function readRequest() {
  if (args.request) {
    const request = readJson(requestPath, null);
    if (!request || typeof request !== 'object') throw new Error('invalid update request');
    return request;
  }
  return {
    action: args.action === 'rollback' ? 'rollback' : 'apply',
    targetVersion: args.version,
    id: `manual-${Date.now()}`,
  };
}

async function applyUpdate(request) {
  const before = currentTarget();
  const currentVersion = readInstalled().version || path.basename(before) || '';
  const manifestInfo = await loadManifest();
  const targetVersion = request.targetVersion || manifestInfo.manifest.version;
  if (targetVersion !== manifestInfo.manifest.version) {
    throw new Error(`requested ${targetVersion}, feed offers ${manifestInfo.manifest.version}`);
  }
  if (compareSemver(targetVersion, currentVersion) <= 0) {
    throw new Error(`target ${targetVersion} is not newer than ${currentVersion}`);
  }
  saveState({
    action: 'apply',
    phase: 'downloading',
    targetVersion,
    previousVersion: currentVersion,
    progress: 5,
    message: `downloading v${targetVersion}`,
    error: '',
    finishedAt: undefined,
    startedAt: nowIso(),
  });

  const artifact = manifestInfo.artifact;
  const archive = path.join(stateDir, 'downloads', `${artifact.sha256}.tar.gz`);
  await download(artifact.url, archive, artifact.sha256, artifact.size);

  saveState({ phase: 'verifying', progress: 25, message: 'verifying archive' });
  await inspectTar(archive);

  saveState({ phase: 'staging', progress: 35, message: `staging v${targetVersion}` });
  const staging = path.join(stateDir, 'staging', `${targetVersion}-${process.pid}-${Date.now()}`);
  removeTree(staging);
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  await execFileAsync(
    'tar',
    ['-xzf', archive, '-C', staging, '--no-same-owner', '--no-same-permissions'],
    { timeout: 10 * 60_000 },
  );

  const pkg = readJson(path.join(staging, 'package.json'), null);
  if (!pkg || pkg.version !== targetVersion) {
    throw new Error(`staged package version mismatch: ${pkg?.version || 'missing'}`);
  }
  for (const required of ['dist/server/index.js', 'web/dist/index.html']) {
    if (!fs.existsSync(path.join(staging, required))) {
      throw new Error(`staged archive is missing ${required}`);
    }
  }
  if (!artifact.includesNodeModules) {
    saveState({ phase: 'installing', progress: 45, message: 'installing production dependencies' });
    log('installing production dependencies');
    await execFileAsync(
      process.env.NPM_BIN || 'npm',
      ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', staging],
      { timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024, cwd: staging },
    );
  }
  if (!fs.existsSync(path.join(staging, 'node_modules'))) {
    throw new Error('staged release has no node_modules');
  }

  saveState({ phase: 'smoke-test', progress: 55, message: 'starting the staged release' });
  await smokeTest(staging, targetVersion);

  const releaseDir = path.join(args.root, 'releases', targetVersion);
  if (fs.existsSync(releaseDir)) throw new Error(`release already exists: ${releaseDir}`);
  fs.mkdirSync(path.join(args.root, 'releases'), { recursive: true, mode: 0o700 });
  moveDir(staging, releaseDir);
  log(`staged release ready: ${releaseDir}`);

  saveState({ phase: 'stopping', progress: 70, message: 'stopping the web service' });
  await stopService();

  try {
    saveState({ phase: 'switching', progress: 80, message: `switching to v${targetVersion}` });
    switchCurrent(targetVersion);
    saveState({ phase: 'starting', progress: 88, message: 'starting the new version' });
    await startService();
    const healthy = await waitForHealth(targetVersion);
    if (!healthy) throw new Error(`new version did not become healthy at ${healthUrl}`);
    writeInstalled({
      version: targetVersion,
      previousVersion: currentVersion || undefined,
      layout: 'release',
      artifact: {
        platform: artifact.platform,
        sha256: artifact.sha256,
        includesNodeModules: artifact.includesNodeModules === true,
      },
      installedAt: nowIso(),
      installedBy: 'claude-web-update',
    });
    saveState({ phase: 'done', progress: 100, message: `v${targetVersion} is running`, finishedAt: nowIso() });
    cleanupReleases(targetVersion, currentVersion);
    log(`update complete: v${targetVersion}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`switch failed: ${message}`);
    if (compareSemver(currentVersion, targetVersion) < 0 && before) {
      try {
        saveState({ phase: 'restarting', progress: 92, message: 'rolling back' });
        switchCurrent(currentVersion);
        await startService();
        const restored = await waitForHealth(currentVersion, 60_000);
        if (!restored) throw new Error('old version did not become healthy');
        saveState({
          phase: 'rolled_back',
          progress: 100,
          error: message,
          message: `rolled back to v${currentVersion}`,
          finishedAt: nowIso(),
        });
        return;
      } catch (rollbackError) {
        const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`${message}; rollback failed: ${detail}`);
      }
    }
    throw error;
  } finally {
    removeTree(staging);
  }
}

async function rollbackUpdate() {
  const installed = readInstalled();
  const previous = installed.previousVersion;
  if (!previous) throw new Error('no previous version recorded');
  if (!fs.existsSync(path.join(args.root, 'releases', previous))) {
    throw new Error(`previous release not found: ${previous}`);
  }
  const current = installed.version || path.basename(currentTarget());
  saveState({
    action: 'rollback',
    phase: 'stopping',
    targetVersion: previous,
    previousVersion: current,
    progress: 20,
    message: `rolling back to v${previous}`,
    error: '',
    finishedAt: undefined,
    startedAt: nowIso(),
  });
  await stopService();
  saveState({ phase: 'switching', progress: 50, message: `switching to v${previous}` });
  switchCurrent(previous);
  saveState({ phase: 'starting', progress: 70, message: 'starting the previous version' });
  await startService();
  const healthy = await waitForHealth(previous);
  if (!healthy) throw new Error(`rolled-back version did not become healthy at ${healthUrl}`);
  writeInstalled({
    ...installed,
    version: previous,
    previousVersion: current,
    installedAt: nowIso(),
    installedBy: 'claude-web-update',
  });
  saveState({
    phase: 'done',
    progress: 100,
    message: `rolled back to v${previous}`,
    finishedAt: nowIso(),
  });
  log(`rollback complete: v${previous}`);
}

async function main() {
  if (args.action === 'check') {
    const info = await loadManifest();
    console.log(
      JSON.stringify(
        {
          currentVersion: readInstalled().version || path.basename(currentTarget()) || null,
          latestVersion: info.manifest.version,
          channel: info.manifest.channel,
          artifact: info.artifact,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (args.action === 'status') {
    console.log(
      JSON.stringify(
        {
          root: args.root,
          current: currentTarget() || null,
          installed: readInstalled(),
          state: readJson(statePath, null),
          releases: siblingReleases(),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!['apply', 'rollback'].includes(args.action)) {
    throw new Error(`unknown action: ${args.action}`);
  }
  const releaseLock = await acquireLock();
  try {
    const request = args.action === 'rollback' ? { action: 'rollback' } : await readRequest();
    if (request.action === 'rollback' || args.action === 'rollback') {
      await rollbackUpdate();
    } else {
      await applyUpdate(request);
    }
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
