#!/usr/bin/env bash
#
# Restart the Claude Code Web user service from outside the session that the
# service hosts. Running `systemctl --user restart claude-web` inside a Web
# conversation kills that conversation's own Claude process (exit 137), so this
# script refuses to run when it detects that it is inside the service cgroup.
#
#   scripts/restart-service.sh            # build is already done
#   scripts/restart-service.sh --build    # build server + web first
#   scripts/restart-service.sh --defer 30 # run restart after N seconds via a
#                                         # transient user unit (safe to call
#                                         # from a session; that session will
#                                         # end when the restart fires)
#
set -euo pipefail

SERVICE="${CLAUDE_WEB_SERVICE:-claude-web}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD=0
DEFER=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build) BUILD=1 ;;
    --defer)
      DEFER="${2:-0}"
      shift
      ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
command -v systemctl >/dev/null || { echo "systemctl not found" >&2; exit 1; }
systemctl --user cat "$SERVICE" >/dev/null 2>&1 || {
  echo "user service '$SERVICE' not found" >&2
  exit 1
}

inside_service_cgroup() {
  local pid="$$" main
  main="$(systemctl --user show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)"
  [ -n "$main" ] && [ "$main" != "0" ] || return 1
  while [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "1" ]; do
    [ "$pid" = "$main" ] && return 0
    pid="$(awk '/^PPid:/{print $2}' "/proc/$pid/status" 2>/dev/null || true)"
  done
  return 1
}

if inside_service_cgroup && [ "$DEFER" = "0" ]; then
  cat >&2 <<'EOF'
This shell is inside the claude-web service cgroup. A direct restart would
kill the Claude process that is running this conversation (exit 137).

Run the script from another terminal/Claude Code window, or use:
  scripts/restart-service.sh --defer 30
which schedules the restart through a separate transient user unit. The
current conversation will end when the deferred restart fires and can be
resumed from the session list afterwards.
EOF
  exit 2
fi

if [ "$BUILD" = "1" ]; then
  cd "$ROOT"
  npm run build
fi

restart_now() {
  systemctl --user restart "$SERVICE"
  systemctl --user is-active "$SERVICE"
  local port
  port="$(grep -E '^PORT=' "$ROOT/data/claude-web.env" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
  port="${port:-8010}"
  curl -fsS --max-time 5 "http://127.0.0.1:$port/api/health" >/dev/null
  echo "claude-web restarted and healthy on 127.0.0.1:$port"
}

if [ "$DEFER" -gt 0 ] 2>/dev/null; then
  unit="claude-web-restart-$(date +%s)"
  say="deferred restart in ${DEFER}s (transient unit $unit)"
  echo "$say"
  # systemd-run creates a sibling unit outside the claude-web cgroup, so it
  # survives when the restart kills the caller's session.
  systemd-run --user --unit="$unit" --collect --no-block \
    /bin/bash -c "sleep $DEFER; systemctl --user restart '$SERVICE'"
  exit 0
fi

restart_now
