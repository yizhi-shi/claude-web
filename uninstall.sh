#!/usr/bin/env bash
#
# Remove the Claude Code Web service. Data is kept unless --purge is passed.
#
set -euo pipefail

INSTALL_DIR="${CLAUDE_WEB_HOME:-$HOME/.local/share/claude-web}"
SYSTEM=0
PURGE=0
YES=0

usage() {
  cat <<'EOF'
Usage: ./uninstall.sh [options]

  --dir <path>   install directory (default ~/.local/share/claude-web)
  --system       remove the system service instead of the user service
  --purge        also delete the install directory (data included!)
  --yes          skip the interactive confirmation for --purge
  -h, --help     show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --system) SYSTEM=1; shift ;;
    --purge) PURGE=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

if [ "$SYSTEM" -eq 1 ]; then
  systemctl disable --now claude-web.service 2>/dev/null || true
  rm -f /etc/systemd/system/claude-web.service
  systemctl daemon-reload 2>/dev/null || true
  say "system service removed"
else
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  fi
  systemctl --user disable --now claude-web.service 2>/dev/null || true
  rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/claude-web.service"
  systemctl --user daemon-reload 2>/dev/null || true
  say "user service removed"
fi

if [ "$PURGE" -eq 1 ]; then
  if [ "$YES" -ne 1 ]; then
    printf 'Delete %s and ALL data in it? [y/N] ' "$INSTALL_DIR"
    read -r answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *) echo "aborted"; exit 1 ;;
    esac
  fi
  rm -rf "$INSTALL_DIR"
  say "removed $INSTALL_DIR"
else
  say "kept $INSTALL_DIR (data included). Use --purge --yes to remove it."
fi
