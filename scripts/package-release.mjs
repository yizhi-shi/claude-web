#!/usr/bin/env node
/**
 * Build an immutable Claude Code Web release artifact + update manifest.
 *
 * Usage:
 *   node scripts/package-release.mjs --out dist-release
 *   node scripts/package-release.mjs --no-deps --channel beta
 *   UPDATE_SIGNING_KEY=.local-secrets/update-signing-key.pem \
 *     node scripts/package-release.mjs --base-url https://example.com/releases/v0.14.0
 *
 * The artifact contains a built server (dist/server), the web bundle
 * (web/dist), package metadata and, by default, production node_modules. It is
 * intentionally assembled from an allowlist so private files in a development
 * checkout cannot leak into a public release.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);

function value(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const channel = value('--channel', process.env.UPDATE_CHANNEL || 'stable');
const outDir = path.resolve(value('--out', 'dist-release'));
const withDeps = !args.includes('--no-deps');
const platform =
  value('--platform', '') ||
  (withDeps
    ? `linux-${process.arch}-${fs.existsSync('/etc/alpine-release') ? 'musl' : 'gnu'}`
    : 'any');
const baseUrl = value(
  '--base-url',
  `https://github.com/yizhi-shi/claude-web/releases/download/v${version}`,
);
const signKeyPath = value(
  '--sign-key',
  process.env.UPDATE_SIGNING_KEY || path.join(ROOT, '.local-secrets/update-signing-key.pem'),
);
const filename = `claude-web-${version}-${platform}.tar.gz`;
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-web-release-'));
const work = path.join(staging, 'package');
fs.mkdirSync(work, { recursive: true });

function log(message) {
  process.stdout.write(`==> ${message}\n`);
}

function requireFile(relative) {
  const file = path.join(ROOT, relative);
  if (!fs.existsSync(file)) throw new Error(`missing build output: ${relative}`);
  return file;
}

function copy(relative, options = {}) {
  const source = path.join(ROOT, relative);
  if (!fs.existsSync(source)) {
    if (options.optional) return;
    throw new Error(`missing release input: ${relative}`);
  }
  fs.cpSync(source, path.join(work, relative), {
    recursive: true,
    preserveTimestamps: true,
    dereference: false,
    filter: options.filter,
  });
}

function run(cmd, options = {}) {
  log(`${cmd} ${options.args?.join(' ') ?? ''}`.trim());
  execFileSync(cmd, options.args ?? [], {
    cwd: options.cwd ?? ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeout ?? 20 * 60_000,
  });
}

try {
  requireFile('dist/server/index.js');
  requireFile('web/dist/index.html');

  log(`assembling v${version} (${platform}${withDeps ? ', bundled deps' : ''})`);
  copy('dist');
  copy('web/dist');
  copy('package.json');
  copy('package-lock.json');
  copy('README.md', { optional: true });
  copy('README.en.md', { optional: true });
  copy('CHANGELOG.md', { optional: true });
  copy('LICENSE', { optional: true });
  copy('SECURITY.md', { optional: true });
  copy('SECURITY.zh-CN.md', { optional: true });
  copy('install.sh', { optional: true });
  copy('uninstall.sh', { optional: true });
  copy('deploy', {
    optional: true,
    filter: (source) => {
      const relative = path.relative(path.join(ROOT, 'deploy'), source);
      return (
        relative === '' ||
        (!relative.startsWith('personal') &&
          !relative.startsWith('cloudflare') &&
          !relative.startsWith('反向代理客户端') &&
          !relative.includes('.wrangler'))
      );
    },
  });
  copy('docs', {
    optional: true,
    filter: (source) => {
      const relative = path.relative(path.join(ROOT, 'docs'), source);
      return (
        relative === '' ||
        (!relative.startsWith('private') &&
          relative !== 'PLAN.md' &&
          relative !== 'REPO-STRATEGY.md')
      );
    },
  });
  copy('scripts/update', { optional: true });
  copy('scripts/install-release.sh', { optional: true });
  copy('scripts/package-release.mjs', { optional: true });

  if (withDeps) {
    run('npm', {
      args: [
        'ci',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--prefix',
        work,
      ],
      cwd: work,
    });
  }

  const info = {
    name: 'claude-web',
    version,
    channel,
    platform,
    includesNodeModules: withDeps,
    builtAt: new Date().toISOString(),
    node: process.version,
    gitSha: (() => {
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
      } catch {
        return '';
      }
    })(),
  };
  fs.writeFileSync(path.join(work, 'release-info.json'), `${JSON.stringify(info, null, 2)}\n`, {
    mode: 0o644,
  });

  fs.mkdirSync(outDir, { recursive: true });
  const archive = path.join(outDir, filename);
  fs.rmSync(archive, { force: true });
  log(`creating ${path.basename(archive)}`);
  run('tar', {
    args: [
      '-czf',
      archive,
      '-C',
      work,
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '.',
    ],
    cwd: outDir,
  });

  const raw = fs.readFileSync(archive);
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  fs.writeFileSync(`${archive}.sha256`, `${sha256}  ${filename}\n`, { mode: 0o644 });

  const manifest = {
    schema: 1,
    name: 'claude-web',
    version,
    channel,
    publishedAt: new Date().toISOString(),
    node: '>=20',
    notesUrl: `https://github.com/yizhi-shi/claude-web/releases/tag/v${version}`,
    breaking: false,
    artifacts: [
      {
        platform,
        url: `${baseUrl.replace(/\/+$/, '')}/${filename}`,
        size: raw.length,
        sha256,
        includesNodeModules: withDeps,
      },
    ],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(outDir, 'latest.json'), manifestBytes, { mode: 0o644 });

  if (fs.existsSync(signKeyPath)) {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(signKeyPath));
    const signature = crypto.sign(null, manifestBytes, privateKey);
    fs.writeFileSync(path.join(outDir, 'latest.json.sig'), signature, { mode: 0o644 });
    const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
    fs.writeFileSync(path.join(outDir, 'update-public-key.pem'), publicKey, { mode: 0o644 });
    log(`signed latest.json with ${signKeyPath}`);
  } else {
    log('warning: no signing key found; latest.json was NOT signed');
  }

  fs.writeFileSync(
    path.join(outDir, 'SHA256SUMS'),
    `${sha256}  ${filename}\n${crypto
      .createHash('sha256')
      .update(manifestBytes)
      .digest('hex')}  latest.json\n`,
    { mode: 0o644 },
  );

  log(`release ready in ${outDir}`);
  log(`artifact: ${filename} (${(raw.length / 1024 / 1024).toFixed(1)} MB)`);
  log(`sha256:   ${sha256}`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
