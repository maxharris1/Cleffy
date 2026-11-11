#!/usr/bin/env bash
# SessionStart hook for Claude Code cloud sessions (claude.ai/code, `claude --remote`).
# Gets a fresh container to "deps installed + Docker running" so the agent can
# lint/test immediately and boot the full stack with `npm run cloud:up`.
#
# Deliberately does NOT boot Supabase: that takes minutes and most sessions
# never need it. Local sessions (CLAUDE_CODE_REMOTE unset) are a no-op.

set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
    exit 0
fi

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO_ROOT"

# `npm install` rather than `npm ci`: the container is snapshotted after this
# hook, and install reuses an existing node_modules instead of wiping it.
echo "[session-start] npm install..."
npm install --no-audit --no-fund --loglevel=error

# The cloud container ships Docker but not a running daemon; `npm run local:up`
# and `cloud:up` both need it.
BOOT_COMMON_REPO_ROOT="$REPO_ROOT"
# shellcheck source=../../.cursor/lib/boot-common.sh
source "$REPO_ROOT/.cursor/lib/boot-common.sh"
if docker info >/dev/null 2>&1 || ensure_docker_access; then
    echo "[session-start] Docker daemon is up."
else
    echo "[session-start] WARN: Docker daemon did not start (see /tmp/dockerd.log); cloud:up will retry." >&2
fi

cat <<'MSG'
[session-start] Ready: lint/typecheck/test work now.
[session-start] Need the running app (UI checks, E2E)? Run `npm run cloud:up` (local Supabase + Vite + functions).
MSG
