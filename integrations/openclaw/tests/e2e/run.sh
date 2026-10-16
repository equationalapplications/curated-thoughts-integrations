#!/usr/bin/env bash
# run.sh — OpenClaw live e2e + AC 9 cache gate (controller-run, NOT in CI).
#
# Installs the plugin into an ISOLATED OpenClaw state dir with the real host
# CLI, puts a deterministic stub `ct` on PATH, routes the model through a
# local recording proxy (request bodies only — never headers, so the key is
# never recorded) to the ZAI Anthropic-compatible endpoint, runs two turns in
# one session through the embedded runner (`openclaw agent --local`, a fresh
# process per turn, which also exercises the restore path), and asserts:
#   - the system prompt (bootstrap block) is byte-identical across turns;
#   - turn 1's user message (live block) is replayed byte-identically;
#   - turn 2's live block rides the last user message and repeats no id.
#
# Requires: node >= 24.16, python3, ZAI_API_KEY. OPENCLAW_BIN defaults to a
# fresh `npm install openclaw@<pin>` under the work dir.
# Usage: tests/e2e/run.sh [work-dir]     (verdict exit: 0 cache-safe, 1 not)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"
PORT="${CT_E2E_PROXY_PORT:-18999}"
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
  # Remove the work dir (host install + state) only when this script made it.
  if [ "$OWN_WORK" -eq 1 ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT
PIN="$(node -p "require('$PKG/tests/host/compatibility.json').openclaw")"

if [ -z "${ZAI_API_KEY:-}" ]; then
  echo "ZAI_API_KEY is not set" >&2
  exit 2
fi
mkdir -p "$WORK/state" "$WORK/bin"

if [ -z "${OPENCLAW_BIN:-}" ]; then
  echo "installing openclaw@$PIN under $WORK/host ..."
  (cd "$WORK" && mkdir -p host && cd host && echo '{"private":true}' > package.json \
    && npm install --no-audit --no-fund "openclaw@$PIN" >/dev/null)
  OPENCLAW_BIN="$WORK/host/node_modules/.bin/openclaw"
fi
export OPENCLAW_BIN
export OPENCLAW_STATE_DIR="$WORK/state"

(cd "$PKG/../../packages/ct-wisdom-core" && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null)
(cd "$PKG" && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null)
# A failed install aborts the run; the installer itself only warns on doctor
# findings (e.g. no embedding backend), so it still exits 0 for those.
CT_INSTALL_EDIT=1 "$PKG/scripts/install.sh"
node "$HERE/setcfg.cjs" "$OPENCLAW_STATE_DIR/openclaw.json" "$PORT"

cp "$HERE/stub-ct.cjs" "$WORK/bin/ct"
chmod +x "$WORK/bin/ct"
cp "$HERE/proxy.mjs" "$WORK/proxy.mjs"
rm -f "$WORK/wire.jsonl"
node "$WORK/proxy.mjs" "$PORT" &
PROXY_PID=$!
# Wait until the proxy accepts connections (no fixed sleep race).
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
  PATH="$WORK/bin:$PATH" "$OPENCLAW_BIN" agent --local --agent main \
    --session-key agent:main:ct-e2e --message "$1" --timeout 240 --json > "$WORK/$2.json" 2> "$WORK/$2.err"
}
turn "In one sentence: how are releases tagged in this repo?" turn1
turn "And which pnpm version writes lockfiles? One sentence." turn2

echo "ct calls:"
sed 's/^/  /' "$WORK/ct-calls.jsonl"
python3 "$HERE/wire_verdict.py" "$WORK/wire.jsonl"
