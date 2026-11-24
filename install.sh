#!/usr/bin/env bash
#
# Claude Code Web — clean installer for a single Linux machine.
#
# Default (user mode):
#   ./install.sh
#   -> ~/.local/share/claude-web + systemd --user + linger
#
# System mode:
#   sudo ./install.sh --system --dir /opt/claude-web --user "$SUDO_USER"
#
# Existing checkout:
#   ./install.sh --from-dir . --dir ~/.local/share/claude-web
#
set -euo pipefail

REPO_URL="${CLAUDE_WEB_REPO:-https://github.com/yizhi-shi/claude-web.git}"
BRANCH="${CLAUDE_WEB_BRANCH:-main}"
INSTALL_DIR="${CLAUDE_WEB_HOME:-$HOME/.local/share/claude-web}"
PORT="${PORT:-8010}"
HOST="${HOST:-0.0.0.0}"
PERMISSION_MODE="${DEFAULT_PERMISSION_MODE:-default}"
SERVICE=1
SYSTEM=0
FROM_DIR=""
RUN_USER=""

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

  --dir <path>             install directory (default ~/.local/share/claude-web)
  --port <port>            listen port (default 8010)
  --host <addr>            listen address (default 0.0.0.0)
  --permission-mode <mode> default permission mode for new sessions
                           (default | acceptEdits | plan | bypassPermissions | dontAsk | auto)
  --from-dir <path>        install from an existing checkout instead of cloning
  --repo <url>             git repository (default public repo)
  --branch <name>          git branch (default main)
  --system                 install a system service under /opt (requires root)
  --user <name>            service user for --system (default $SUDO_USER or current user)
  --no-service             install and build only, do not register/start a service
  -h, --help               show this help

Recommended for personal machines: the default user mode. It runs as the same
user that owns ~/.claude and your projects, and survives logout via linger.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --permission-mode) PERMISSION_MODE="$2"; shift 2 ;;
    --from-dir) FROM_DIR="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
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

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

need node
need npm
need git

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node.js 20+ is required (found $(node -v)). Install a newer Node, e.g. via nvm."
fi

NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ]; then
  warn "claude CLI was not found on PATH. Install Claude Code and log in first; set CLAUDE_BIN if it lives elsewhere."
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  warn "ffmpeg was not found. It is only needed for the Volcengine/ByteDance voice provider."
fi

if [ "$SYSTEM" -eq 1 ]; then
  [ "$(id -u)" -eq 0 ] || die "--system requires root"
  if [ -z "$RUN_USER" ]; then RUN_USER="${SUDO_USER:-root}"; fi
  INSTALL_DIR="${INSTALL_DIR:-/opt/claude-web}"
  if [ "$INSTALL_DIR" = "$HOME/.local/share/claude-web" ]; then INSTALL_DIR="/opt/claude-web"; fi
else
  RUN_USER="$(id -un)"
fi

mkdir -p "$INSTALL_DIR"

if [ -n "$FROM_DIR" ]; then
  SRC="$(cd "$FROM_DIR" && pwd)"
  if [ "$SRC" != "$(cd "$INSTALL_DIR" && pwd)" ]; then
    say "copying checkout from $SRC to $INSTALL_DIR"
    (cd "$SRC" && tar \
      --exclude='.git' \
      --exclude='node_modules' \
      --exclude='dist' \
      --exclude='web/dist' \
      --exclude='data' \
      --exclude='.smoke' \
      -cf - .) | (cd "$INSTALL_DIR" && tar -xf -)
  fi
else
  if [ -d "$INSTALL_DIR/.git" ]; then
    say "updating existing checkout"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$INSTALL_DIR" checkout "$BRANCH"
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
  elif [ -f "$INSTALL_DIR/package.json" ]; then
    warn "$INSTALL_DIR already contains a project; using it as-is (pass --from-dir to refresh)."
  else
    say "cloning $REPO_URL"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
fi

cd "$INSTALL_DIR"
say "installing dependencies"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

say "building server and web bundles"
npm run build

mkdir -p "$INSTALL_DIR/data"
chmod 700 "$INSTALL_DIR/data" || true

if [ "$SYSTEM" -eq 1 ]; then
  SERVICE_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
  SERVICE_HOME="${SERVICE_HOME:-$HOME}"
else
  SERVICE_HOME="$HOME"
fi

ENV_FILE="$INSTALL_DIR/data/claude-web.env"
if [ ! -f "$ENV_FILE" ]; then
  {
    echo "HOME=$SERVICE_HOME"
    echo "PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin"
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

if [ "$SERVICE" -eq 1 ]; then
  if [ "$SYSTEM" -eq 1 ]; then
    UNIT=/etc/systemd/system/claude-web.service
    cat > "$UNIT" <<EOF
[Unit]
Description=Claude Code Web console
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $INSTALL_DIR/dist/server/index.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
    chown -R "$RUN_USER":"$RUN_USER" "$INSTALL_DIR" 2>/dev/null || true
    chmod 700 "$INSTALL_DIR/data" 2>/dev/null || true
    systemctl daemon-reload
    systemctl enable --now claude-web.service
    say "system service installed: systemctl status claude-web"
  else
    USER_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$USER_UNIT_DIR"
    UNIT="$USER_UNIT_DIR/claude-web.service"
    cat > "$UNIT" <<EOF
[Unit]
Description=Claude Code Web console
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $INSTALL_DIR/dist/server/index.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
    if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
      export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    fi
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload
      systemctl --user enable --now claude-web.service
      loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || warn "could not enable linger; the service may stop after logout"
      say "user service installed: systemctl --user status claude-web"
    else
      warn "systemctl not found; start manually: cd $INSTALL_DIR && node dist/server/index.js"
    fi
  fi
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say "done"
echo
echo "  URL:        http://${IP:-127.0.0.1}:$PORT"
echo "  Data:       $INSTALL_DIR/data"
echo "  Env:        $ENV_FILE"
echo "  First open: set the administrator account in the browser."
echo "  Logs:       journalctl --user -u claude-web -f   (system: journalctl -u claude-web -f)"
echo
if [ "$PERMISSION_MODE" = "bypassPermissions" ]; then
  warn "new sessions default to bypassPermissions (all tools allowed). Use only on a trusted machine."
fi
