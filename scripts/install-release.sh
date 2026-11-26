#!/usr/bin/env bash
#
# Install a prebuilt Claude Code Web release (no npm/build on the target).
#
#   ./scripts/install-release.sh [options]
#
# The default install root is ~/.local/share/claude-web and the default feed is
# the latest GitHub Release of the public repository. The release layout is:
#
#   releases/<version>/   current -> releases/<version>   data/   bin/
#
# `install.sh --release` forwards to this script.
set -euo pipefail

REPO="${CLAUDE_WEB_REPO:-yizhi-shi/claude-web}"
FEED="${UPDATE_FEED_URLS:-${UPDATE_FEED_URL:-https://github.com/${REPO}/releases/latest/download}}"
INSTALL_DIR="${CLAUDE_WEB_HOME:-$HOME/.local/share/claude-web}"
PORT="${PORT:-8010}"
HOST="${HOST:-0.0.0.0}"
PERMISSION_MODE="${DEFAULT_PERMISSION_MODE:-default}"
SYSTEM=0
SERVICE=1
RUN_USER=""
VERSION=""
PUBLIC_KEY="${UPDATE_PUBLIC_KEY_FILE:-}"
MIGRATE=0

usage() {
  cat <<'EOF'
Usage: scripts/install-release.sh [options]

  --dir <path>             install directory (default ~/.local/share/claude-web)
  --port <port>            listen port (default 8010)
  --host <addr>            listen address (default 0.0.0.0)
  --permission-mode <mode> default permission mode for new sessions
  --version <version>      install a specific release (default: feed's latest)
  --feed <url>             release feed (default: public GitHub latest)
  --public-key <file>      Ed25519 public key for manifest verification
  --migrate                convert an existing flat (non-git) install
  --system                 install a system service under /opt (requires root)
  --user <name>            service user for --system
  --no-service             install files only
  -h, --help               show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --permission-mode) PERMISSION_MODE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --feed) FEED="$2"; shift 2 ;;
    --public-key) PUBLIC_KEY="$2"; shift 2 ;;
    --migrate) MIGRATE=1; shift ;;
    --system) SYSTEM=1; shift ;;
    --user) RUN_USER="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m!!\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }

need node
need curl
need tar
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ is required (found $(node -v))"
CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ]; then
  warn "claude CLI was not found on PATH. Install Claude Code and log in first; set CLAUDE_BIN in data/claude-web.env if it lives elsewhere."
fi

if [ "$SYSTEM" -eq 1 ]; then
  [ "$(id -u)" -eq 0 ] || die "--system requires root"
  RUN_USER="${RUN_USER:-${SUDO_USER:-root}}"
  if [ "$INSTALL_DIR" = "$HOME/.local/share/claude-web" ]; then INSTALL_DIR="/opt/claude-web"; fi
else
  RUN_USER="$(id -un)"
fi

if [ -n "$VERSION" ] && [ "$VERSION" = "${VERSION#v}" ]; then VERSION="v$VERSION"; fi
if [ -n "$VERSION" ]; then
  FEED="https://github.com/${REPO}/releases/download/${VERSION}"
fi
FEED="${FEED%/}"
case "$FEED" in
  */latest.json) FEED="${FEED%/latest.json}" ;;
esac

TMP="$(mktemp -d "${TMPDIR:-/tmp}/claude-web-release.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

MANIFEST="$TMP/latest.json"
SIG="$TMP/latest.json.sig"
CURL_PROTO="=https"
if [ "${UPDATE_ALLOW_INSECURE:-0}" = "1" ]; then CURL_PROTO="=https,http"; fi

say "resolving release from $FEED"
curl -fsSL --proto "$CURL_PROTO" --tlsv1.2 --connect-timeout 20 --max-time 120 "$FEED/latest.json" -o "$MANIFEST" \
  || die "could not download $FEED/latest.json"

REQUIRE_SIGNATURE="${UPDATE_REQUIRE_SIGNATURE:-1}"
if [ "$REQUIRE_SIGNATURE" != "0" ]; then
  if [ -z "$PUBLIC_KEY" ]; then
    for candidate in "$(dirname "$0")/../deploy/update-public-key.pem" "$INSTALL_DIR/bin/update-public-key.pem"; do
      if [ -f "$candidate" ]; then PUBLIC_KEY="$candidate"; break; fi
    done
  fi
  [ -n "$PUBLIC_KEY" ] && [ -f "$PUBLIC_KEY" ] \
    || die "signature verification is enabled but no public key was found (pass --public-key or set UPDATE_REQUIRE_SIGNATURE=0)"
  curl -fsSL --proto "$CURL_PROTO" --tlsv1.2 --connect-timeout 20 --max-time 120 "$FEED/latest.json.sig" -o "$SIG" \
    || die "could not download latest.json.sig"
  MANIFEST="$MANIFEST" SIG="$SIG" KEY="$PUBLIC_KEY" node -e '
    const fs = require("fs"), crypto = require("crypto");
    const raw = fs.readFileSync(process.env.MANIFEST);
    const signature = fs.readFileSync(process.env.SIG);
    const key = fs.readFileSync(process.env.KEY);
    if (!crypto.verify(null, raw, key, signature)) {
      console.error("manifest signature verification failed");
      process.exit(1);
    }
  ' || die "manifest signature verification failed"
fi

MANIFEST="$MANIFEST" FEED="$FEED" OUT="$TMP/selected.json" node -e '
  const fs = require("fs");
  const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST, "utf8"));
  const arch = process.arch;
  const libc = process.platform === "linux" && fs.existsSync("/etc/alpine-release") ? "musl" : "gnu";
  const tag = `${process.platform}-${arch}-${libc}`;
  const artifact =
    manifest.artifacts.find((item) => item.platform === tag) ||
    manifest.artifacts.find((item) => item.platform === "any" || item.platform === "linux-any");
  if (!artifact) throw new Error(`no artifact for ${tag}`);
  const resolved = new URL(artifact.url, process.env.FEED).toString();
  fs.writeFileSync(process.env.OUT, JSON.stringify({ manifest, artifact: { ...artifact, url: resolved } }, null, 2));
' || die "could not select a release artifact"

VERSION="$(node -p "require('$TMP/selected.json').manifest.version")"
ARTIFACT_URL="$(node -p "require('$TMP/selected.json').artifact.url")"
SHA256="$(node -p "require('$TMP/selected.json').artifact.sha256")"
SIZE="$(node -p "require('$TMP/selected.json').artifact.size")"
INCLUDES_DEPS="$(node -p "require('$TMP/selected.json').artifact.includesNodeModules === true")"
ARCHIVE="$TMP/$(basename "$ARTIFACT_URL")"

say "downloading v$VERSION"
curl -fsSL --proto "$CURL_PROTO" --tlsv1.2 --connect-timeout 20 --max-time 1800 --retry 2 --retry-delay 2 "$ARTIFACT_URL" -o "$ARCHIVE" \
  || die "could not download $ARTIFACT_URL"
ACTUAL_SIZE="$(wc -c < "$ARCHIVE" | tr -d ' ')"
[ "$ACTUAL_SIZE" = "$SIZE" ] || die "artifact size mismatch: expected $SIZE, got $ACTUAL_SIZE"
ACTUAL_SHA="$(node -e 'const fs=require("fs"),crypto=require("crypto");const h=crypto.createHash("sha256");h.update(fs.readFileSync(process.argv[1]));process.stdout.write(h.digest("hex"))' "$ARCHIVE")"
[ "$ACTUAL_SHA" = "$SHA256" ] || die "artifact sha256 mismatch"

if [ -e "$INSTALL_DIR/.git" ]; then
  die "$INSTALL_DIR is a git checkout; release installs must use a separate directory"
fi
# Migration moves deploy/ into the old release; keep the bootstrap public key
# outside the install tree so signature verification still works afterwards.
if [ -n "$PUBLIC_KEY" ] && [ -f "$PUBLIC_KEY" ] && case "$PUBLIC_KEY" in "$INSTALL_DIR"/*) true ;; *) false ;; esac; then
  cp "$PUBLIC_KEY" "$TMP/update-public-key.pem"
  PUBLIC_KEY="$TMP/update-public-key.pem"
fi
if [ -f "$INSTALL_DIR/package.json" ] && [ ! -e "$INSTALL_DIR/current" ]; then
  if [ "$MIGRATE" -ne 1 ]; then
    die "$INSTALL_DIR is a flat install; rerun with --migrate or choose a new --dir"
  fi
  OLD_VERSION="$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null || true)"
  [ -n "$OLD_VERSION" ] || die "could not read the existing package version"
  say "migrating flat install v$OLD_VERSION to releases/$OLD_VERSION"
  mkdir -p "$INSTALL_DIR/releases/$OLD_VERSION"
  for entry in dist web node_modules package.json package-lock.json scripts docs deploy README.md README.en.md CHANGELOG.md LICENSE SECURITY.md SECURITY.zh-CN.md install.sh uninstall.sh; do
    if [ -e "$INSTALL_DIR/$entry" ]; then
      mv "$INSTALL_DIR/$entry" "$INSTALL_DIR/releases/$OLD_VERSION/"
    fi
  done
  ln -s "releases/$OLD_VERSION" "$INSTALL_DIR/.current.$$"
  mv -Tf "$INSTALL_DIR/.current.$$" "$INSTALL_DIR/current" 2>/dev/null || {
    rm -f "$INSTALL_DIR/current"
    mv "$INSTALL_DIR/.current.$$" "$INSTALL_DIR/current"
  }
fi

mkdir -p "$INSTALL_DIR/releases" "$INSTALL_DIR/data/updates" "$INSTALL_DIR/bin"
chmod 700 "$INSTALL_DIR/data" "$INSTALL_DIR/data/updates" 2>/dev/null || true
RELEASE_DIR="$INSTALL_DIR/releases/$VERSION"
if [ ! -d "$RELEASE_DIR" ]; then
  STAGE="$INSTALL_DIR/releases/.$VERSION.tmp.$$"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  say "extracting v$VERSION"
  tar -xzf "$ARCHIVE" -C "$STAGE" --no-same-owner --no-same-permissions
  [ "$(node -p "require('$STAGE/package.json').version" 2>/dev/null || true)" = "$VERSION" ] \
    || die "release package version mismatch"
  [ -f "$STAGE/dist/server/index.js" ] && [ -f "$STAGE/web/dist/index.html" ] \
    || die "release package is missing dist or web/dist"
  if [ "$INCLUDES_DEPS" != "true" ]; then
    command -v npm >/dev/null 2>&1 || die "this release does not bundle node_modules and npm is not installed"
    say "installing production dependencies (this release does not bundle them)"
    (cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
  fi
  mv "$STAGE" "$RELEASE_DIR"
else
  say "release v$VERSION already present"
fi

CURRENT_TMP="$INSTALL_DIR/.current.$$"
ln -s "releases/$VERSION" "$CURRENT_TMP"
mv -Tf "$CURRENT_TMP" "$INSTALL_DIR/current" 2>/dev/null || {
  rm -f "$INSTALL_DIR/current"
  mv "$CURRENT_TMP" "$INSTALL_DIR/current"
}

if [ -f "$RELEASE_DIR/scripts/update/claude-web-update.mjs" ]; then
  install -m 0755 "$RELEASE_DIR/scripts/update/claude-web-update.mjs" "$INSTALL_DIR/bin/claude-web-update.mjs"
else
  die "release is missing the standalone updater"
fi
if [ -n "$PUBLIC_KEY" ] && [ -f "$PUBLIC_KEY" ]; then
  install -m 0644 "$PUBLIC_KEY" "$INSTALL_DIR/bin/update-public-key.pem"
elif [ -f "$RELEASE_DIR/deploy/update-public-key.pem" ]; then
  install -m 0644 "$RELEASE_DIR/deploy/update-public-key.pem" "$INSTALL_DIR/bin/update-public-key.pem"
elif [ -f "$TMP/update-public-key.pem" ]; then
  install -m 0644 "$TMP/update-public-key.pem" "$INSTALL_DIR/bin/update-public-key.pem"
fi

cat > "$INSTALL_DIR/installed.json" <<EOF
{
  "version": "$VERSION",
  "layout": "release",
  "artifact": {
    "sha256": "$SHA256",
    "size": $SIZE,
    "includesNodeModules": $INCLUDES_DEPS
  },
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "installedBy": "install-release.sh"
}
EOF
chmod 644 "$INSTALL_DIR/installed.json"

if [ "$SYSTEM" -eq 1 ]; then
  SERVICE_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
else
  SERVICE_HOME="$HOME"
fi
ENV_FILE="$INSTALL_DIR/data/claude-web.env"
if [ ! -f "$ENV_FILE" ]; then
  {
    echo "HOME=$SERVICE_HOME"
    echo "PATH=$NODE_DIR:$SERVICE_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
    echo "HOST=$HOST"
    echo "PORT=$PORT"
    echo "DATA_DIR=$INSTALL_DIR/data"
    echo "ALLOWED_ROOTS=${ALLOWED_ROOTS:-$SERVICE_HOME}"
    echo "DEFAULT_PERMISSION_MODE=$PERMISSION_MODE"
    echo "DEFAULT_THEME=system"
    echo "TRUST_PROXY=true"
    echo "SESSION_IDLE_MINUTES=30"
    echo "PERMISSION_TIMEOUT_MINUTES=30"
    if [ -n "$CLAUDE_BIN" ]; then echo "CLAUDE_BIN=$CLAUDE_BIN"; fi
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  say "keeping existing $ENV_FILE"
fi
# Keep update settings current without duplicating keys.
{
  grep -v '^UPDATE_' "$ENV_FILE" || true
  echo "UPDATE_MODE=release"
  echo "UPDATE_ROOT=$INSTALL_DIR"
  echo "UPDATE_PUBLIC_KEY_FILE=$INSTALL_DIR/bin/update-public-key.pem"
  echo "UPDATE_REQUIRE_SIGNATURE=${UPDATE_REQUIRE_SIGNATURE:-1}"
  echo "UPDATE_SYSTEMD_SCOPE=$([ "$SYSTEM" -eq 1 ] && echo system || echo user)"
  echo "UPDATE_WEB_SERVICE=claude-web.service"
  echo "UPDATE_SERVICE_NAME=claude-web-update.service"
  echo "UPDATE_HEALTH_URL=http://127.0.0.1:$PORT/api/health"
  echo "UPDATE_FEED_URLS=$FEED"
} > "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"

if [ "$SERVICE" -eq 1 ]; then
  if [ "$SYSTEM" -eq 1 ]; then
    UNIT=/etc/systemd/system/claude-web.service
    UPDATE_UNIT=/etc/systemd/system/claude-web-update.service
    cat > "$UNIT" <<EOF
[Unit]
Description=Claude Code Web console
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$INSTALL_DIR/current
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $INSTALL_DIR/current/dist/server/index.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
    cat > "$UPDATE_UNIT" <<EOF
[Unit]
Description=Claude Code Web updater
After=network.target

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $INSTALL_DIR/bin/claude-web-update.mjs apply --request $INSTALL_DIR/data/updates/request.json
TimeoutStartSec=30min
EOF
    chown -R "$RUN_USER":"$RUN_USER" "$INSTALL_DIR" 2>/dev/null || true
    chmod 700 "$INSTALL_DIR/data" 2>/dev/null || true
    systemctl daemon-reload
    systemctl enable --now claude-web.service
  else
    UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/claude-web.service" <<EOF
[Unit]
Description=Claude Code Web console
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/current
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $INSTALL_DIR/current/dist/server/index.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
    cat > "$UNIT_DIR/claude-web-update.service" <<EOF
[Unit]
Description=Claude Code Web updater
After=network.target

[Service]
Type=oneshot
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $INSTALL_DIR/bin/claude-web-update.mjs apply --request $INSTALL_DIR/data/updates/request.json
TimeoutStartSec=30min
EOF
    if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
      export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    fi
    systemctl --user daemon-reload
    systemctl --user enable --now claude-web.service
    loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || warn "could not enable linger"
  fi
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say "installed Claude Code Web v$VERSION"
echo "  URL:        http://${IP:-127.0.0.1}:$PORT"
echo "  install:    $INSTALL_DIR"
echo "  releases:   $INSTALL_DIR/releases"
echo "  updater:    $INSTALL_DIR/bin/claude-web-update.mjs"
if [ "$SERVICE" -eq 1 ]; then
  echo "  service:    systemctl $([ "$SYSTEM" -eq 1 ] && echo '' || echo '--user') status claude-web"
fi
