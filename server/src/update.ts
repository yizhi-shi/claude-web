import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { config } from './config.js';
import { atomicWriteJson, HttpError, nowIso, randomId, readJson } from './util.js';

const execFileAsync = promisify(execFile);

export interface UpdateArtifact {
  platform: string;
  url: string;
  size: number;
  sha256: string;
  includesNodeModules?: boolean;
}

export interface UpdateManifest {
  schema: number;
  name: string;
  version: string;
  channel: string;
  publishedAt?: string;
  node?: string;
  notesUrl?: string;
  breaking?: boolean;
  minVersion?: string;
  artifacts: UpdateArtifact[];
}

export type UpdateInstallMode = 'release' | 'flat' | 'git' | 'off' | 'unsupported';

export interface UpdateReleaseView {
  version: string;
  channel: string;
  publishedAt?: string;
  notesUrl?: string;
  breaking: boolean;
  minVersion?: string;
  platform: string;
  size: number;
  sha256: string;
  includesNodeModules: boolean;
}

export interface UpdateJobView {
  id?: string;
  action: 'apply' | 'rollback';
  phase: string;
  targetVersion?: string;
  previousVersion?: string;
  progress?: number;
  message?: string;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
}

export interface UpdateStatusView {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  installMode: UpdateInstallMode;
  canCheck: boolean;
  canApply: boolean;
  disabledReason?: string;
  channel: string;
  checkedAt: string | null;
  release: UpdateReleaseView | null;
  activeSessions: number;
  job: UpdateJobView | null;
  lastResult: UpdateJobView | null;
}

export interface UpdateManagerOptions {
  root?: string;
  dataDir?: string;
  currentVersion?: string;
  feedUrls?: string[];
  channel?: string;
  requireSignature?: boolean;
  publicKeyFile?: string;
  publicKeyInline?: string;
  mode?: string;
  startUpdater?: (requestPath: string) => Promise<void>;
  activeSessions?: () => Promise<number> | number;
  now?: () => number;
}

interface CachedManifest {
  manifest: UpdateManifest;
  artifact: UpdateArtifact;
  feedUrl: string;
  checkedAt: number;
}

function platformTag(): string {
  const libc =
    process.platform === 'linux' && fs.existsSync('/etc/alpine-release') ? 'musl' : 'gnu';
  return `${process.platform}-${process.arch}-${libc}`;
}

function normalizeFeedUrl(value: string): string {
  const clean = value.trim();
  if (!clean) return clean;
  if (clean.endsWith('.json')) return clean;
  return `${clean.replace(/\/+$/, '')}/latest.json`;
}

function parseSemver(value: string): [number, number, number, string[]] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] ? match[4].split('.') : [],
  ];
}

export function compareSemver(a: string, b: string): number {
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

function isLocalHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function validateArtifactUrl(raw: string, base: string): string {
  const resolved = new URL(raw, base).toString();
  const parsed = new URL(resolved);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalHost(parsed.hostname))) {
    throw new HttpError(502, `更新包地址必须使用 HTTPS：${parsed.origin}`);
  }
  return resolved;
}

function readPublicKey(file: string, inline: string): string | undefined {
  if (inline.trim()) return inline;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function normalizeJob(value: unknown): UpdateJobView | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.action !== 'apply' && raw.action !== 'rollback') return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    action: raw.action,
    phase: typeof raw.phase === 'string' ? raw.phase : 'unknown',
    targetVersion: typeof raw.targetVersion === 'string' ? raw.targetVersion : undefined,
    previousVersion: typeof raw.previousVersion === 'string' ? raw.previousVersion : undefined,
    progress: typeof raw.progress === 'number' ? raw.progress : undefined,
    message: typeof raw.message === 'string' ? raw.message : undefined,
    error: typeof raw.error === 'string' ? raw.error : undefined,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : undefined,
  };
}

export class UpdateManager {
  private readonly root: string;
  private readonly dataDir: string;
  private readonly currentVersion: string;
  private readonly feedUrls: string[];
  private readonly channel: string;
  private readonly requireSignature: boolean;
  private readonly publicKey: string | undefined;
  private readonly mode: string;
  private readonly startUpdater: ((requestPath: string) => Promise<void>) | undefined;
  private readonly activeSessions: () => Promise<number> | number;
  private readonly now: () => number;
  private cached: CachedManifest | null = null;
  private checking: Promise<CachedManifest> | null = null;

  constructor(options: UpdateManagerOptions = {}) {
    this.root = path.resolve(options.root ?? config.updateRoot);
    this.dataDir = path.resolve(options.dataDir ?? config.dataDir);
    this.currentVersion = options.currentVersion ?? config.appVersion;
    this.feedUrls = (options.feedUrls ?? config.updateFeedUrls).map(normalizeFeedUrl).filter(Boolean);
    this.channel = options.channel ?? config.updateChannel;
    this.requireSignature =
      options.requireSignature ?? config.updateRequireSignature;
    this.publicKey = readPublicKey(
      options.publicKeyFile ?? config.updatePublicKeyFile,
      options.publicKeyInline ?? config.updatePublicKeyInline,
    );
    this.mode = (options.mode ?? config.updateMode).toLowerCase();
    this.startUpdater = options.startUpdater;
    this.activeSessions = options.activeSessions ?? (() => 0);
    this.now = options.now ?? Date.now;
  }

  private stateDir(): string {
    return path.join(this.dataDir, 'updates');
  }

  private statePath(): string {
    return path.join(this.stateDir(), 'state.json');
  }

  private requestPath(): string {
    return path.join(this.stateDir(), 'request.json');
  }

  private installedPath(): string {
    return path.join(this.root, 'installed.json');
  }

  installMode(): UpdateInstallMode {
    if (this.mode === 'off') return 'off';
    if (this.mode === 'git') return 'git';
    if (this.mode === 'release') return 'release';
    try {
      const current = path.join(this.root, 'current');
      if (fs.lstatSync(current).isSymbolicLink() && fs.existsSync(path.join(this.root, 'releases'))) {
        return 'release';
      }
      if (fs.existsSync(path.join(this.root, '.git'))) return 'git';
      if (fs.existsSync(path.join(this.root, 'package.json'))) return 'flat';
    } catch {
      // fall through
    }
    return 'unsupported';
  }

  private signatureProblem(): string | undefined {
    if (!this.requireSignature) return undefined;
    if (!this.publicKey) {
      return '未配置更新签名公钥，自动更新已禁用（请设置 UPDATE_PUBLIC_KEY_FILE）';
    }
    return undefined;
  }

  private disabledReason(mode: UpdateInstallMode): string | undefined {
    if (mode === 'off') return '自动更新已被 UPDATE_MODE=off 关闭';
    if (mode === 'git') return '当前是 git 开发工作区，自动更新已禁用；请使用发布包安装';
    if (mode === 'flat') return '当前是旧版平铺安装；请用 install.sh --release 重新安装后启用自动更新';
    if (mode === 'unsupported') return '无法识别安装目录布局，自动更新不可用';
    const signature = this.signatureProblem();
    if (signature) return signature;
    const underSystemd = !!process.env.INVOCATION_ID || !!process.env.SYSTEMD_EXEC_PID;
    if (!this.startUpdater && !config.updateStartCommand && !underSystemd) {
      // The web process never replaces its own files. It only starts a
      // separate oneshot unit, so a supervisor (systemd) must be present.
      return '自动更新需要 systemd 或 UPDATE_START_COMMAND';
    }
    try {
      fs.accessSync(this.root, fs.constants.W_OK);
    } catch {
      return '安装目录不可写，自动更新不可用';
    }
    return undefined;
  }

  async status(): Promise<UpdateStatusView> {
    const mode = this.installMode();
    const activeSessions = await this.activeSessions();
    const state = normalizeJob(readJson<unknown>(this.statePath(), null));
    const lastResult = state && state.finishedAt ? state : null;
    const job = state && !state.finishedAt ? state : null;
    const release = this.cached
      ? {
          version: this.cached.manifest.version,
          channel: this.cached.manifest.channel,
          publishedAt: this.cached.manifest.publishedAt,
          notesUrl: this.cached.manifest.notesUrl,
          breaking: this.cached.manifest.breaking === true,
          minVersion: this.cached.manifest.minVersion,
          platform: this.cached.artifact.platform,
          size: this.cached.artifact.size,
          sha256: this.cached.artifact.sha256,
          includesNodeModules: this.cached.artifact.includesNodeModules === true,
        }
      : null;
    const latestVersion = this.cached?.manifest.version ?? null;
    return {
      currentVersion: this.currentVersion,
      latestVersion,
      updateAvailable:
        !!latestVersion && compareSemver(latestVersion, this.currentVersion) > 0,
      installMode: mode,
      canCheck: mode === 'release' || mode === 'flat',
      canApply: mode === 'release' && !this.disabledReason(mode),
      disabledReason: this.disabledReason(mode),
      channel: this.channel,
      checkedAt: this.cached ? new Date(this.cached.checkedAt).toISOString() : null,
      release,
      activeSessions,
      job,
      lastResult,
    };
  }

  async check(force = false): Promise<UpdateStatusView> {
    await this.refresh(force);
    return this.status();
  }

  private async refresh(force: boolean): Promise<CachedManifest> {
    if (!force && this.cached && this.now() - this.cached.checkedAt < config.updateCheckTtlMs) {
      return this.cached;
    }
    if (this.checking) return this.checking;
    this.checking = this.fetchManifest();
    try {
      this.cached = await this.checking;
      return this.cached;
    } finally {
      this.checking = null;
    }
  }

  private async fetchManifest(): Promise<CachedManifest> {
    const mode = this.installMode();
    if (mode === 'off') throw new HttpError(409, '自动更新已关闭');
    if (mode === 'git') throw new HttpError(409, 'git 开发工作区不支持在线检查更新');
    if (mode === 'unsupported') throw new HttpError(409, '无法识别安装目录布局');
    const signatureProblem = this.signatureProblem();
    if (signatureProblem) throw new HttpError(409, signatureProblem);
    if (this.feedUrls.length === 0) throw new HttpError(409, '未配置更新源');

    let lastError = '';
    for (const feedUrl of this.feedUrls) {
      try {
        const manifestResponse = await this.get(feedUrl);
        const raw = Buffer.from(await manifestResponse.arrayBuffer());
        if (raw.length > 1024 * 1024) throw new Error('manifest too large');
        if (this.requireSignature) {
          const sigResponse = await this.get(`${feedUrl}.sig`);
          const sigRaw = Buffer.from(await sigResponse.arrayBuffer());
          if (sigRaw.length === 0 || sigRaw.length > 16 * 1024) {
            throw new Error('invalid signature');
          }
          if (!this.publicKey || !crypto.verify(null, raw, this.publicKey, sigRaw)) {
            throw new Error('manifest signature verification failed');
          }
        }
        const manifest = JSON.parse(raw.toString('utf8')) as UpdateManifest;
        this.validateManifest(manifest);
        const artifact = this.selectArtifact(manifest);
        const resolved = { ...artifact, url: validateArtifactUrl(artifact.url, feedUrl) };
        return {
          manifest,
          artifact: resolved,
          feedUrl,
          checkedAt: this.now(),
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new HttpError(502, `检查更新失败：${lastError || '无法连接更新源'}`);
  }

  private async get(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const init: Record<string, unknown> = {
        signal: controller.signal,
        headers: { 'user-agent': `claude-web/${this.currentVersion}` },
        redirect: 'follow',
      };
      if (config.updateProxyUrl) {
        const agent = new ProxyAgent(config.updateProxyUrl);
        init.dispatcher = agent;
      }
      const response = (await undiciFetch(
        url,
        init as Parameters<typeof undiciFetch>[1],
      )) as unknown as Response;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new Error(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  private validateManifest(manifest: UpdateManifest): void {
    if (!manifest || manifest.schema !== 1) throw new Error('不支持的更新清单版本');
    if (manifest.name !== 'claude-web') throw new Error('更新清单名称不匹配');
    if (!parseSemver(manifest.version)) throw new Error('更新清单版本号不合法');
    if (manifest.channel !== this.channel) {
      throw new Error(`更新渠道不匹配：${manifest.channel}`);
    }
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
      throw new Error('更新清单没有可用的安装包');
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
        throw new Error('更新清单中的安装包字段不合法');
      }
    }
  }

  private selectArtifact(manifest: UpdateManifest): UpdateArtifact {
    const tag = platformTag();
    const exact = manifest.artifacts.find((item) => item.platform === tag);
    if (exact) return exact;
    const universal = manifest.artifacts.find(
      (item) => item.platform === 'any' || item.platform === 'linux-any',
    );
    if (universal) return universal;
    throw new Error(`没有适用于 ${tag} 的安装包`);
  }

  async apply(input: {
    version?: string;
    force?: boolean;
    user?: string;
  }): Promise<UpdateJobView> {
    const mode = this.installMode();
    const reason = this.disabledReason(mode);
    if (mode !== 'release' || reason) {
      throw new HttpError(409, reason || '当前安装不支持自动更新');
    }
    const cached = await this.refresh(false);
    if (input.version && input.version !== cached.manifest.version) {
      throw new HttpError(409, '目标版本已变化，请重新检查更新');
    }
    if (compareSemver(cached.manifest.version, this.currentVersion) <= 0) {
      throw new HttpError(409, '已经是最新版本');
    }
    const active = await this.activeSessions();
    if (active > 0 && !input.force) {
      throw new HttpError(
        409,
        `有 ${active} 个会话正在执行；更新会中断这些任务，请确认后再试`,
      );
    }
    await this.assertNoActiveJob();
    const job: UpdateJobView = {
      id: randomId(),
      action: 'apply',
      phase: 'queued',
      targetVersion: cached.manifest.version,
      previousVersion: this.currentVersion,
      progress: 0,
      message: '已排队，等待更新器启动',
      startedAt: nowIso(),
      updatedAt: nowIso(),
    };
    atomicWriteJson(this.requestPath(), {
      ...job,
      requestedBy: input.user || 'admin',
      feedUrl: cached.feedUrl,
      channel: this.channel,
    });
    atomicWriteJson(this.statePath(), job);
    try {
      await this.triggerUpdater(this.requestPath());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      atomicWriteJson(this.statePath(), {
        ...job,
        phase: 'failed',
        error: message,
        finishedAt: nowIso(),
      });
      fs.rmSync(this.requestPath(), { force: true });
      throw error;
    }
    return job;
  }

  async rollback(input: { user?: string } = {}): Promise<UpdateJobView> {
    const mode = this.installMode();
    if (mode !== 'release') throw new HttpError(409, '当前安装不支持回滚');
    const installed = readJson<Record<string, unknown>>(this.installedPath(), {});
    const previous = typeof installed.previousVersion === 'string' ? installed.previousVersion : '';
    if (!previous) throw new HttpError(409, '没有可回滚的上一版本');
    const target = path.join(this.root, 'releases', previous);
    if (!fs.existsSync(target)) throw new HttpError(409, `上一版本目录不存在：${previous}`);
    await this.assertNoActiveJob();
    const job: UpdateJobView = {
      id: randomId(),
      action: 'rollback',
      phase: 'queued',
      targetVersion: previous,
      previousVersion: this.currentVersion,
      progress: 0,
      message: '已排队，等待更新器启动',
      startedAt: nowIso(),
      updatedAt: nowIso(),
    };
    atomicWriteJson(this.requestPath(), {
      ...job,
      requestedBy: input.user || 'admin',
      channel: this.channel,
    });
    atomicWriteJson(this.statePath(), job);
    try {
      await this.triggerUpdater(this.requestPath());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      atomicWriteJson(this.statePath(), {
        ...job,
        phase: 'failed',
        error: message,
        finishedAt: nowIso(),
      });
      fs.rmSync(this.requestPath(), { force: true });
      throw error;
    }
    return job;
  }

  private async assertNoActiveJob(): Promise<void> {
    const state = normalizeJob(readJson<unknown>(this.statePath(), null));
    if (state && !state.finishedAt) {
      const updated = state.updatedAt ? Date.parse(state.updatedAt) : 0;
      // A crashed updater should not block forever. 30 minutes is far longer
      // than a local staging + switch should take.
      if (Date.now() - updated < 30 * 60_000) {
        throw new HttpError(409, '已有更新任务在执行');
      }
    }
  }

  private async triggerUpdater(requestPath: string): Promise<void> {
    if (this.startUpdater) {
      await this.startUpdater(requestPath);
      return;
    }
    if (config.updateStartCommand) {
      const child = spawn('/bin/sh', ['-c', config.updateStartCommand], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, UPDATE_REQUEST_FILE: requestPath },
      });
      child.unref();
      return;
    }
    const scope = config.updateSystemdScope === 'user' ? ['--user'] : [];
    try {
      // A failed oneshot stays in "failed" and systemd may refuse to start it
      // again. Clearing the previous result is safe and makes retries work.
      await execFileAsync(
        'systemctl',
        [...scope, 'reset-failed', config.updateServiceName],
        { timeout: 10_000 },
      ).catch(() => {});
      await execFileAsync(
        'systemctl',
        [...scope, 'start', '--no-block', config.updateServiceName],
        { timeout: 10_000 },
      );
    } catch (error) {
      throw new HttpError(
        500,
        `无法启动更新服务：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function readUpdateState(dataDir = config.dataDir): UpdateJobView | null {
  return normalizeJob(readJson<unknown>(path.join(dataDir, 'updates', 'state.json'), null));
}
