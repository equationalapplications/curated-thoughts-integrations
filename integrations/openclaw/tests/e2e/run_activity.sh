#!/usr/bin/env bash
# run_activity.sh — OpenClaw live e2e for autonomous-work ("activity")
# delivery (spec docs/superpowers/specs/2026-10-17-openclaw-autonomous-work-
# wisdom-design.md). Controller-run, NOT in CI.
#
# Installs the plugin into an ISOLATED OpenClaw state dir AND an isolated
# HOME / CURATED_BRAIN_DIR with the real host CLI (pin from
# tests/host/compatibility.json), puts a deterministic stub `ct` on PATH and a
# stub CT MCP sidecar (one tool, curated_recall_context) in the user
# `mcp.servers` row, routes the model through the body-only recording proxy
# (never headers: the key is never recorded) to ZAI GLM-5.3-FLASH, and runs:
#   turn 1: one user message that makes the agent work through several tool
#           steps (read TASK.md, exec `git status` twice, write then read
#           .env.local, a CT recall);
#   turn 2: a fresh process in the same session (persistence + replay).
# activity_verdict.py then checks the Hermes-style properties.
#
# CT IS A STUB here (stub-ct.cjs / stub-mcp.cjs): this run verifies the host
# binding, not CT's gate.
#
# Requires: node >= 24.16, python3, ZAI_API_KEY (passed by name only).
# Usage: tests/e2e/run_activity.sh [work-dir]   (exit 0 = all checks pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"
PORT="${CT_E2E_PROXY_PORT:-18998}"
PROXY_PID=""
OWN_WORK=0
if [ -n "${1:-}" ]; then
  WORK="$1"
else
  WORK="$(mktemp -d)"
  OWN_WORK=1
fi
cleanup() {
  if [ -n "$PROXY_PID" ]; then kill "$PROXY_PID" 2>/dev/null || true; fi
  if [ "$OWN_WORK" -eq 1 ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT
PIN="$(node -p "require('$PKG/tests/host/compatibility.json').openclaw")"

if [ -z "${ZAI_API_KEY:-}" ]; then
  echo "ZAI_API_KEY is not set" >&2
  exit 2
fi
mkdir -p "$WORK/state" "$WORK/bin" "$WORK/home" "$WORK/brain" "$WORK/mcp"

if [ -z "${OPENCLAW_BIN:-}" ]; then
  echo "installing openclaw@$PIN under $WORK/host ..."
  (cd "$WORK" && mkdir -p host && cd host && echo '{"private":true}' > package.json \
    && npm install --no-audit --no-fund "openclaw@$PIN" >/dev/null)
  OPENCLAW_BIN="$WORK/host/node_modules/.bin/openclaw"
fi
export OPENCLAW_BIN
# Isolation: never the user's home, OpenClaw state or brain.
export HOME="$WORK/home"
export OPENCLAW_STATE_DIR="$WORK/state"
export CURATED_BRAIN_DIR="$WORK/brain"

(cd "$PKG/../../packages/ct-wisdom-core" && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null)
(cd "$PKG" && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null)
CT_INSTALL_EDIT=1 "$PKG/scripts/install.sh" > "$WORK/install.log" 2>&1 || { cat "$WORK/install.log"; exit 1; }
cp "$HERE/stub-mcp.cjs" "$WORK/mcp/stub-mcp.cjs"
node "$HERE/setcfg.cjs" "$OPENCLAW_STATE_DIR/openclaw.json" "$PORT" "$WORK/mcp/stub-mcp.cjs"

cp "$HERE/stub-ct.cjs" "$WORK/bin/ct"
chmod +x "$WORK/bin/ct"
cp "$HERE/proxy.mjs" "$WORK/proxy.mjs"
rm -f "$WORK/wire.jsonl" "$WORK/ct-calls.jsonl" "$WORK/mcp/mcp-calls.jsonl"

# The agent workspace (the middleware's cwd): a project, so paths may be sent.
mkdir -p "$OPENCLAW_STATE_DIR/workspace"
: > "$OPENCLAW_STATE_DIR/workspace/.curated-thoughts-project"
printf 'Task list\n1. check git status\n' > "$OPENCLAW_STATE_DIR/workspace/TASK.md"

node "$WORK/proxy.mjs" "$PORT" > "$WORK/proxy.log" 2>&1 &
PROXY_PID=$!
ready=0
for _ in $(seq 1 50); do
  if node -e "require('net').connect($PORT, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"; then
    ready=1
    break
  fi
  sleep 0.2
done
if [ "$ready" -ne 1 ]; then
  echo "proxy did not start on port $PORT" >&2
  exit 1
fi

turn() {
  CT_WISDOM_VERBOSE=1 PATH="$WORK/bin:$PATH" "$OPENCLAW_BIN" agent --local --agent main \
    --session-key agent:main:ct-activity --message "$1" --timeout 300 --json > "$WORK/$2.json" 2> "$WORK/$2.err"
}
turn "Work through these steps strictly one at a time, one tool call per step, waiting for each result: \
(1) read the file TASK.md with the read tool; \
(2) run the shell command \`git status\` with the exec tool; \
(3) run \`git status\` with the exec tool once more; \
(4) create the file .env.local containing the single line X=1 with the write tool; \
(5) read .env.local with the read tool; \
(6) call the curated_recall_context tool with the query release. \
Then reply with the single word DONE." turn1
turn "Reply with the single word OK. Do not use any tools." turn2

echo "ct calls:"
sed 's/^/  /' "$WORK/ct-calls.jsonl"
echo "mcp calls:"
if [ -f "$WORK/mcp/mcp-calls.jsonl" ]; then sed 's/^/  /' "$WORK/mcp/mcp-calls.jsonl"; else echo "  (none)"; fi
python3 -I "$HERE/activity_verdict.py" "$WORK"
