#!/usr/bin/env bash
# Refuse to publish a tree that still contains known secret patterns.
set -euo pipefail

TARGET="."
MODE="private"
if [ "${1:-}" = "--public" ]; then
  MODE="public"
  TARGET="${2:-.}"
elif [ -n "${1:-}" ]; then
  TARGET="$1"
fi

PATTERN='AQ\.[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|authorization[[:space:]]*[:=][[:space:]]*Bearer[[:space:]]+[A-Za-z0-9_.-]{10,}|ANTHROPIC_AUTH_TOKEN[[:space:]]*[:=][[:space:]]*[^[:space:]]+'
PRIVATE_PATTERNS="$(dirname "$0")/private-patterns.txt"
if [ -f "$PRIVATE_PATTERNS" ]; then
  EXTRA="$(grep -vE '^[[:space:]]*(#|$)' "$PRIVATE_PATTERNS" | paste -sd'|' -)"
  if [ -n "$EXTRA" ]; then PATTERN="$PATTERN|$EXTRA"; fi
fi

EXCLUDES=(
  --exclude-dir=node_modules
  --exclude-dir=.git
  --exclude-dir=dist
  --exclude-dir=data
  --exclude-dir=.smoke
  --exclude='package-lock.json'
  --exclude='*.png'
  --exclude='*.jpg'
  --exclude='*.jpeg'
  --exclude='*.gif'
  --exclude='*.webp'
)
if [ "$MODE" = "private" ]; then
  # The private tree intentionally names the private account and contains the
  # publishing tooling. Public export must pass the strict scan instead.
  EXCLUDES+=(
    --exclude='check-secrets.sh'
    --exclude='publish.sh'
    --exclude='export-oss.sh'
    --exclude='private-patterns.txt'
    --exclude='private-map.sed'
    --exclude='REPO-STRATEGY.md'
    --exclude='PLAN.md'
    --exclude-dir=private
  )
fi

set +e
MATCHES="$(grep -RInE "${EXCLUDES[@]}" "$PATTERN" "$TARGET")"
STATUS=$?
set -e

if [ -n "$MATCHES" ]; then
  echo "Secret-like content found:" >&2
  echo "$MATCHES" >&2
  exit 1
fi
if [ "$STATUS" -gt 1 ]; then
  echo "grep failed with status $STATUS" >&2
  exit "$STATUS"
fi

echo "secret check passed: $TARGET"
