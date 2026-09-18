#!/usr/bin/env bash
# e2e.sh — runs INSIDE the ct-dsh-e2e container (see Dockerfile, run.sh).
#
# Installs the packed integration the way a user would, against the real
# `dsh` CLI and the real curated-thoughts-mcp sidecar, then checks:
#   1. install.sh preview writes nothing;
#   2. CT_INSTALL_EDIT=1 install.sh --profile headless installs the package
#      into the profile (npm pack + `dsh plugin --profile headless add`) and
#      the bundle patch rows appear in `dsh --profile headless --dump-config`;
#   3. the doctor reports no FAIL;
#   4. (only with ZAI_API_KEY) a headless run calls curated_proposals_list
#      through the mounted MCP client and completes it;
#   5. (only with ZAI_API_KEY) with CURATED_BRAIN_DIR pointing at a missing
#      dir, the degraded health block reaches the system prompt — this also
#      proves `export const inject`, the finite prompt-context order, and the
#      agent/session-start listener all fire;
#   6. the sidecar treats a literal `~` in CURATED_BRAIN_DIR as a relative
#      path and refuses to start (driven directly over MCP stdio) — this pins
#      why the shipped patch rows resolve the brain dir at composition time;
#   7. re-running the installer is a no-op.
#
# No embedding backend runs here (no Ollama, no fastembed download): the live
# call uses curated_proposals_list, which needs neither.
set -uo pipefail

MODEL_ID="${CT_E2E_MODEL:-GLM-5.3-FLASH}"
PROFILE=headless
DSH_HOME_DIR="$HOME/.dsh"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PLUGIN_SCOPE="@equational-applications/dsh-curated-thoughts"
OUT="$HOME/out"
mkdir -p "$OUT"

pass=0
fail=0
ok() { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1"; fail=$((fail + 1)); }
check() { # check <label> <command...>
  local label="$1"; shift
  if "$@"; then ok "$label"; else bad "$label"; fi
}
section() { printf '\n== %s\n' "$1"; }

# Newest session log written after $1 (a date string), decompressed with zstd.
# The one-shot log is session.v3.jsonl.zstd — multiple zstd frames, so use the
# CLI (handles concatenated frames), not a single-shot zlib call. No `head -1`
# in a pipe: it SIGPIPEs the producer and pipefail would drop the result.
newest_session_log() {
  local after="$1" found
  found=$(find "$DSH_HOME_DIR/sessions" -name 'session.v3.jsonl.zstd' -newermt "$after" 2>/dev/null | sort -r)
  [ -n "$found" ] || return 1
  # shellcheck disable=SC2086  # find output paths contain no whitespace here
  set -- $(ls -t $found)
  printf '%s\n' "$1"
}
dump_session_log() { # dump_session_log <out-file>
  local zlog
  zlog="$(newest_session_log "$1")"
  if [ -n "$zlog" ]; then zstd -dc "$zlog" >"$2" 2>/dev/null; fi
}

# ---------------------------------------------------------------------------
section 'seed a brain (headless)'
# --onboard writes config.json and the vault skeleton (canned answers: local
# embedding, no generation, software-org schema). It does not create
# brain.db; launching the app binary runs the schema migrations first and
# then panics on the missing display, which is the only headless way to get
# a fully migrated database today.
printf '1\n0\n1\n' | curated-thoughts-mcp --onboard --vault "$HOME/vault" --force >"$OUT/onboard.log" 2>&1
curated-thoughts-mcp >"$OUT/migrate.log" 2>&1 || true
check 'brain config written' test -f "$HOME/.brain/config.json"
check 'brain.db migrated' test -s "$HOME/.brain/brain.db"

# Provider settings: the key stays in the environment (apiKeyEnv); this file
# only names it. Written before any dsh boot.
mkdir -p "$DSH_HOME_DIR"
cp "$HOME/dist/zai-settings.yaml" "$DSH_HOME_DIR/settings.yaml"

# ---------------------------------------------------------------------------
section 'unpack the release tarball'
mkdir -p "$HOME/release"
check 'SHA256SUMS verifies the artifact' sh -c "cd '$HOME/dist' && sha256sum -c --quiet SHA256SUMS"
tar -xzf "$HOME"/dist/deepseek-*.tar.gz -C "$HOME/release"
REL=$(find "$HOME/release" -mindepth 1 -maxdepth 1 -type d | head -1)
check 'install.sh is executable (README runs ./scripts/install.sh)' test -x "$REL/scripts/install.sh"

# ---------------------------------------------------------------------------
section 'install.sh preview writes nothing'
# Hash both the path set and the regular-file contents so a preview that
# silently rewrites an existing file (or rewrites permissions only) cannot
# pass the unchanged-filesystem check. Empty trees fall through without
# invoking sha256sum without operands.
dsh_home_digest() {
  {
    find "$DSH_HOME_DIR" -mindepth 1 2>/dev/null | LC_ALL=C sort
    find "$DSH_HOME_DIR" -mindepth 1 -type f -exec sha256sum {} + 2>/dev/null | LC_ALL=C sort
  } | sha256sum
}
before=$(dsh_home_digest)
"$REL/scripts/install.sh" --profile "$PROFILE" >"$OUT/preview.log" 2>&1
preview_rc=$?
after=$(dsh_home_digest)
check "preview exits 0 (rc=$preview_rc)" test "$preview_rc" -eq 0
check 'preview leaves the filesystem untouched' test "$before" = "$after"
check 'preview names the plugin package' grep -q 'dsh-curated-thoughts' "$OUT/preview.log"

# ---------------------------------------------------------------------------
section 'CT_INSTALL_EDIT=1 install.sh applies'
CT_INSTALL_EDIT=1 "$REL/scripts/install.sh" --profile "$PROFILE" >"$OUT/apply.log" 2>&1
apply_rc=$?
check "apply exits 0 (rc=$apply_rc)" test "$apply_rc" -eq 0
check 'plugin package installed into the profile' \
  test -e "$PROFILE_DIR/node_modules/$PLUGIN_SCOPE"
check 'installed package declares the bundle patch' \
  node -e "const m=require('$PROFILE_DIR/node_modules/$PLUGIN_SCOPE/package.json'); process.exit(m.dsh && m.dsh.bundle && m.dsh.bundle.patch ? 0 : 1)"
check 'bundle patch file shipped' \
  test -f "$PROFILE_DIR/node_modules/$PLUGIN_SCOPE/cordis.patch.yml"
# The test-only model override (selects the provider/model for this container);
# a user-level patch row, not part of the shipped bundle. The profile's patch
# file is auto-initialized to a comment plus a bare `[]` (an empty YAML list),
# which an append would corrupt — replace it when it carries no entries.
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
patch_has_entries() {
  [ -f "$PATCH_FILE" ] || return 1
  local body
  body=$(grep -v '^[[:space:]]*#' "$PATCH_FILE" | grep -v '^[[:space:]]*$' || true)
  [ -n "$body" ] && [ "$body" != '[]' ]
}
{
  if patch_has_entries; then printf '\n'; fi
  cat <<EOF
- id: agent-default-model
  config:
    provider: zai-coding
    model: $MODEL_ID
EOF
} >"$PATCH_FILE.tmp"
mv "$PATCH_FILE.tmp" "$PATCH_FILE"
dsh --profile "$PROFILE" --dump-config >"$OUT/dump-config.txt" 2>"$OUT/dump-config.err" || true
check 'dump-config composes (rc=0)' test -s "$OUT/dump-config.txt"
check 'dump-config shows the curated-thoughts plugin row' \
  sh -c "grep -q 'dsh-curated-thoughts' '$OUT/dump-config.txt'"
check 'dump-config shows the mcp-curated-thoughts client row' \
  sh -c "grep -q 'mcp-curated-thoughts' '$OUT/dump-config.txt'"
check 'dump-config resolves no unmatched patch targets' \
  sh -c "! grep -qi 'unmatched' '$OUT/dump-config.err'"

# ---------------------------------------------------------------------------
section 'doctor'
node "$PROFILE_DIR/node_modules/$PLUGIN_SCOPE/lib/scripts/ct_doctor.js" check --json \
  >"$OUT/doctor.json" 2>"$OUT/doctor.err"
doctor_rc=$?
if jq -e . "$OUT/doctor.json" >/dev/null 2>&1; then
  jq -r '(.checks // .)[] | "      \(.status)\t\(.name)\t\(.detail | .[0:140])"' "$OUT/doctor.json"
else
  cat "$OUT/doctor.json" "$OUT/doctor.err"
fi
# 0 = all PASS, 2 = WARN only (expected: no embedding backend here).
check "doctor reports no FAIL (rc=$doctor_rc)" test "$doctor_rc" -ne 1

# ---------------------------------------------------------------------------
section "live model ($MODEL_ID)"
if [ -z "${ZAI_API_KEY:-}" ]; then
  echo 'SKIP  ZAI_API_KEY not set'
else
  # Run 1: healthy brain — the MCP tool call must complete end to end.
  run_start=$(date -Iseconds)
  timeout 300 dsh --profile "$PROFILE" \
    'Call the mcp__curated-thoughts__curated_proposals_list tool exactly once with no arguments, then reply with the single word DONE.' \
    >"$OUT/run1.out" 2>"$OUT/run1.err"
  run_rc=$?
  check "dsh headless run exits 0 (rc=$run_rc)" test "$run_rc" -eq 0
  check 'final answer is DONE' sh -c "grep -qx 'DONE' '$OUT/run1.out'"
  dump_session_log "$run_start" "$OUT/run1.session.jsonl"
  check 'session log captured' test -s "$OUT/run1.session.jsonl"
  # The task text itself names the tool, so a bare grep would match the user
  # message — require a tool/call event carrying the tool name.
  check 'session log records a tool/call for curated_proposals_list' \
    sh -c "grep 'tool/call' '$OUT/run1.session.jsonl' | grep -q 'curated_proposals_list'"
  # The session log's tool/call line for curated_proposals_list must precede
  # any line carrying the assistant's final reply text (DONE). Use the
  # already-pinned tool/call shape above; do not assume a literal
  # tool/result event name — the schema is owned by dsh and not pinned in
  # this repo. The 'final answer is DONE' check on stdout is preserved
  # separately at line ~163.
  check 'assistant DONE follows the tool/call in the session log' \
    sh -c "tool_line=\$(grep -n 'tool/call' '$OUT/run1.session.jsonl' | grep 'curated_proposals_list' | head -1 | cut -d: -f1); done_line=\$(grep -nF 'DONE' '$OUT/run1.session.jsonl' | tail -1 | cut -d: -f1); [ -n \"\$tool_line\" ] && [ -n \"\$done_line\" ] && [ \"\$tool_line\" -lt \"\$done_line\" ]"
  if [ "$run_rc" -ne 0 ]; then tail -20 "$OUT/run1.err" | sed 's/^/      /'; fi

  # Run 2: degraded brain — probe() must see the missing CURATED_BRAIN_DIR and
  # inject the DEGRADED block into the system prompt. The MCP row's own env
  # keeps the real path, so this isolates the prompt path from the sidecar.
  run2_start=$(date -Iseconds)
  CURATED_BRAIN_DIR="$HOME/.brain-missing" timeout 300 dsh --profile "$PROFILE" \
    'Reply with the single word DONE.' \
    >"$OUT/run2.out" 2>"$OUT/run2.err"
  run2_rc=$?
  check "degraded run exits 0 (rc=$run2_rc)" test "$run2_rc" -eq 0
  dump_session_log "$run2_start" "$OUT/run2.session.jsonl"
  check 'degraded session log captured' test -s "$OUT/run2.session.jsonl"
  check 'degraded health block reaches the prompt' \
    sh -c "grep -q 'Memory sidecar DEGRADED' '$OUT/run2.session.jsonl'"
  check 'routing reminder reaches the prompt' \
    sh -c "grep -q 'Curated Thoughts memory is available over MCP' '$OUT/run2.session.jsonl'"
  if [ "$run2_rc" -ne 0 ]; then tail -20 "$OUT/run2.err" | sed 's/^/      /'; fi
fi

# ---------------------------------------------------------------------------
section 'literal ~ in CURATED_BRAIN_DIR (sidecar expansion)'
# Drive the sidecar directly over MCP stdio with a literal `~` brain dir.
# VERIFIED 2026-09-18: the sidecar does NOT expand `~` — it treats the value
# as a relative path and refuses to start. That fact is what forces the
# shipped bundle patch to resolve CURATED_BRAIN_DIR with a !!js expression.
# If a future sidecar starts expanding `~`, this check fails — update the
# patch and its comment (and the test_bundle_patch assertions) accordingly.
cat >"$OUT/tilde-check.mjs" <<'EOF'
import { spawn } from 'node:child_process';
const child = spawn('curated-thoughts-mcp', ['--mcp'], {
  env: { ...process.env, CURATED_BRAIN_DIR: '~/.brain' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* not JSON — ignore */ }
  }
});
child.stderr.on('data', (d) => process.stderr.write(d));
let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 30000);
  });
}
try {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ct-e2e-tilde-check', version: '0.0.0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await rpc('tools/list', {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  if (!names.includes('curated_proposals_list')) {
    console.error('tools:', names.join(', '));
    process.exit(2);
  }
  const res = await rpc('tools/call', { name: 'curated_proposals_list', arguments: {} });
  const isError = res.result?.isError === true || res.error != null;
  process.exit(isError ? 3 : 0);
} catch (e) {
  console.error(String(e));
  process.exit(1);
} finally {
  child.kill();
}
EOF
node "$OUT/tilde-check.mjs" >"$OUT/tilde.log" 2>&1
tilde_rc=$?
if [ "$tilde_rc" -eq 0 ]; then
  bad 'sidecar now EXPANDS ~ in CURATED_BRAIN_DIR — update cordis.patch.yml and test_bundle_patch'
  sed 's/^/      /' "$OUT/tilde.log"
elif grep -q 'brain.db not found' "$OUT/tilde.log"; then
  # The sidecar fatal-exited on the literal-~ path before answering the MCP
  # handshake — the does-not-expand proof, so the probe script reports rc=1.
  ok 'sidecar treats ~ literally (shipped rows resolve paths at composition)'
else
  bad "sidecar ~ check crashed before proving either way (rc=$tilde_rc)"
  sed 's/^/      /' "$OUT/tilde.log"
fi

# ---------------------------------------------------------------------------
section 're-running the installer is a no-op'
profile_before=$(find "$PROFILE_DIR" -type f ! -path '*/.pnpm*' -print0 2>/dev/null \
  | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum)
CT_INSTALL_EDIT=1 "$REL/scripts/install.sh" --profile "$PROFILE" >"$OUT/reapply.log" 2>&1
reapply_rc=$?
check "re-apply exits 0 (rc=$reapply_rc)" test "$reapply_rc" -eq 0
profile_after=$(find "$PROFILE_DIR" -type f ! -path '*/.pnpm*' -print0 2>/dev/null \
  | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum)
check 'profile unchanged (manifest, bundle list, patch)' test "$profile_before" = "$profile_after"
check 'no duplicate patch rows appended' \
  test "$(grep -c 'dsh-curated-thoughts' "$PROFILE_DIR/cordis.patch.yml")" -le 1

printf '\n%d passed, %d failed\n' "$pass" "$fail"
test "$fail" -eq 0
