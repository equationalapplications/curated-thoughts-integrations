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
#   8. (always) a seeded wiki entry reaches the wisdom section: `ct` (installed
#      test-only in the image) ingests a one-note vault, the cold `ct recall`
#      is timed against RECALL_TIMEOUT_MS, run 1's prompt carries EXACTLY ONE
#      wisdom block containing the seeded entry, and the degraded run 2
#      (missing brain dir) carries NO wisdom block (silent no-op).
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
# The log's schema generation is in the file name and moves with the host pin
# (0.1.5-rc.2: session.v3; 0.2.0-rc.2: session.v4 — the v3-only glob matched
# nothing at the new pin, so every session-log check failed or, for the
# negative "no block" checks, passed vacuously). Match any generation.
SESSION_LOG_GLOB='session.v*.jsonl.zstd'
newest_session_log() {
  local after="$1" found
  found=$(find "$DSH_HOME_DIR/sessions" -name "$SESSION_LOG_GLOB" -newermt "$after" 2>/dev/null | sort -r)
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
# The log of one named session (its directory carries the id), for runs that
# continue a session with --session-id — "newest" is ambiguous there.
dump_session_log_by_id() { # dump_session_log_by_id <session-id> <out-file>
  local zlog
  zlog=$(find "$DSH_HOME_DIR/sessions" -path "*/$1/*" -name "$SESSION_LOG_GLOB" 2>/dev/null | sort | tail -1)
  if [ -n "$zlog" ]; then zstd -dc "$zlog" >"$2" 2>/dev/null; else : >"$2"; fi
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

# ---------------------------------------------------------------------------
section 'seed wisdom (ct CLI + vault ingest)'
# Test-only provisioning (plan Step 8.3): the wisdom section recalls the brain's
# wiki layer through the standalone `ct` binary. Seed one wiki-bearing note so
# recall has something to return; without this the wisdom checks below would
# pass vacuously (a no-op section renders '').
#
# CONDITIONAL on an embedding backend, like the live-model block: `ct ingest`
# and `ct recall` embed through Ollama (localhost:11434 by default) — the same
# dependency that keeps the container's live MCP check on
# curated_proposals_list. With no backend these checks SKIP (rc=2 in 2026-09-30
# run 3 proved it: ingest 0/1, recall refused on connect), and the wisdom
# behavior is covered at unit level (test_wisdom.ts, mocked recall). To run the
# full wisdom e2e, provide an embedder in the container.
WISDOM_E2E=1
if ! ct --help 2>/dev/null | grep -q 'Curated Thoughts'; then
  bad 'ct CLI not on PATH — wisdom seed skipped, wisdom checks would be vacuous'
  WISDOM_E2E=0
else
  # Probe the EMBEDDER, not the brain: `ct status` exits 0 here because the
  # brain was seeded above, but ingest/recall embed through Ollama and fail
  # on connection (run 3, rc=2; 2026-10-09 run: 3 FAILs from the same gap).
  # A trivial recall is exactly what ingest does first, so its rc is the
  # honest gate.
  if ! ct recall 'embedder probe' --json --k 1 >/dev/null 2>&1; then
    echo 'SKIP  no embedding backend for ct ingest/recall — wisdom e2e covered at unit level'
    WISDOM_E2E=0
  fi
fi
if [ "$WISDOM_E2E" -eq 1 ]; then
  mkdir -p "$HOME/vault/notes"
  cat >"$HOME/vault/notes/e2e-wisdom-seed.md" <<'EOF'
---
okf_version: 0.1
profile: llm-wiki/1
title: E2E wisdom seed — tire pressure is 42 psi
entity_type: fact
created_at: 2026-09-30T00:00:00Z
---

The e2e wisdom seed fact is: the fleet tire pressure is 42 psi.
EOF
  ct ingest --yes >"$OUT/ingest.log" 2>&1
  ingest_rc=$?
  check "ct ingest exits 0 (rc=$ingest_rc)" test "$ingest_rc" -eq 0
  # Prove recall returns the entry BEFORE any dsh session runs (cold-path
  # timing also lands here: plan Step 8.1 measures the first real recall).
  # Enforce the recall deadline (CodeRabbit cycle-6 stability): elapsed-time
  # measurement AFTER the call can't bound the script's wait if `ct` hangs;
  # GNU timeout SIGTERMs at 5 s and SIGKILLs 1 s later. exit 124 = timed out,
  # which trips the rc-check below loudly.
  recall_start=$(date +%s%N)
  timeout --kill-after=1s 5s ct recall 'tire pressure' --json --k 3 >"$OUT/recall.json" 2>"$OUT/recall.err"
  recall_rc=$?
  recall_ms=$(( ($(date +%s%N) - recall_start) / 1000000 ))
  check "ct recall exits 0 (rc=$recall_rc, cold ${recall_ms}ms)" test "$recall_rc" -eq 0
  echo "      cold recall: ${recall_ms}ms (RECALL_TIMEOUT_MS budget: 5000ms)"
  check 'recall JSON carries the seeded entry' \
    sh -c "grep -q 'tire pressure' '$OUT/recall.json'"
  if [ "$recall_ms" -gt 5000 ]; then
    bad "cold recall ${recall_ms}ms exceeds RECALL_TIMEOUT_MS=5000 — bump the constant per spec pre-authorization"
  else
    ok "cold recall within the 5000ms budget"
  fi
fi

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
  if patch_has_entries; then cat "$PATCH_FILE"; printf '\n'; fi
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
  # The block text is '' until the agent/created listener runs probe(), so
  # the DEGRADED block in the prompt also proves that listener fired.
  check 'degraded health block reaches the prompt (agent/created fired)' \
    sh -c "grep -q 'Memory sidecar DEGRADED' '$OUT/run2.session.jsonl'"
  check 'routing reminder reaches the prompt' \
    sh -c "grep -q 'Curated Thoughts memory is available over MCP' '$OUT/run2.session.jsonl'"
  # Wisdom assertions (plan Step 8.2): Run 1 has a healthy brain, so its
  # system prompt behavior depends on the wisdom seed — assert only when the
  # seed ran (WISDOM_E2E=1); with no embedder the section is a silent no-op
  # (recall fails → memoized '') in run 1, still worth pinning:
  if [ "$WISDOM_E2E" -eq 1 ]; then
    check 'wisdom block reaches the system prompt' \
      sh -c "grep -q '## Curated Thoughts — relevant memory' '$OUT/run1.session.jsonl'"
    check 'wisdom block carries the seeded entry' \
      sh -c "grep -q 'tire pressure is 42 psi' '$OUT/run1.session.jsonl'"
    check 'exactly one wisdom block in the prompt' \
      sh -c "[ \"\$(grep -c '## Curated Thoughts — relevant memory' '$OUT/run1.session.jsonl')\" -eq 1 ]"
  else
    # Real CT >= 3.3.0 is on PATH, so run 1's pre-step also ran the REAL
    # `ct wisdom match` (an empty, uncalibrated brain answers entries: []):
    # no v1 block, no live block (no ct-fact marker), no error text. The log
    # must exist — a missing log would make these negatives pass vacuously.
    check 'wisdom is a silent no-op without a backend (no v1 block, no live block, no error)' \
      sh -c "test -s '$OUT/run1.session.jsonl' && ! grep -q '## Curated Thoughts — relevant memory' '$OUT/run1.session.jsonl' && ! grep -q 'ct-fact:' '$OUT/run1.session.jsonl' && ! grep -qiE 'wisdom.*(error|fail)' '$OUT/run1.err'"
  fi
  # Degraded run 2 points at a MISSING brain dir: the wisdom section must be a
  # silent no-op there (no block, no error text).
  check 'degraded run has NO wisdom block (missing brain → no-op)' \
    sh -c "test -s '$OUT/run2.session.jsonl' && ! grep -q '## Curated Thoughts — relevant memory' '$OUT/run2.session.jsonl' && ! grep -q 'ct-fact:' '$OUT/run2.session.jsonl'"
  if [ "$run2_rc" -ne 0 ]; then tail -20 "$OUT/run2.err" | sed 's/^/      /'; fi
fi

# ---------------------------------------------------------------------------
section 'live pre-step wisdom delivery (spec AC 10 / m6)'
# The 0.4.0 live path, on the real DSH agent loop and the live model:
#   (a) CT gate: live delivery needs `ct wisdom match` (CT >= 3.3.0). The
#       image's ct is checked here; an older ct fails this section loudly.
#   (b) turn 1 (fresh session, a multi-step turn — it makes a tool call): the
#       FIRST pre-step of the turn delivers the block, appended as a user-role
#       message that the loop persists verbatim in the session log; later steps
#       of the same turn do not call CT again;
#   (c) turn 2 (same session, continued with --session-id in a NEW process —
#       the in-memory state is gone, only the session log carries over): the
#       ledger is rebuilt from the log (the fact id rides --exclude) and the
#       fact is NOT re-delivered, even though the fixture below still returns
#       it (the plugin's own post-filter must drop it);
#   (d) the `agent/created` listener fired: the health block reached the
#       system prompt of both the fresh and the continued session.
#
# Embedder gate: CT's relevance gate scores embeddings (semantic-v1, cosine
# over wiki embeddings, calibrated per embed model). This container has no
# embedding backend by design (no Ollama; see the wisdom seed section), so a
# real `ct wisdom match` here answers `"gate": "uncalibrated", entries: []`
# and can never select a fact. With WISDOM_E2E=0 the CT-owned gate is
# replaced by a contract-shaped fixture — a `ct` wrapper first on PATH that
# answers `wisdom match <query>` with one fixed fact (and logs its argv) and
# delegates EVERYTHING else, the `wisdom match --help` capability probe and
# the `--help` identity probe included, to the real ct. Only CT's scoring is
# fixtured; the plugin, the DSH 0.2.0-rc.2 loop, the session log, and the
# model are all real. With an embedder (WISDOM_E2E=1) the real gate is used.
CT_MIN='3.3.0'
ct_ver="${CT_CLI_VERSION:-unknown}"
echo "      ct CLI version: $ct_ver (live delivery requires >= $CT_MIN)"
check "ct CLI is >= $CT_MIN (have $ct_ver)" \
  sh -c "[ '$ct_ver' != unknown ] && [ \"\$(printf '%s\n' '$CT_MIN' '$ct_ver' | sort -V | head -1)\" = '$CT_MIN' ]"
check 'real ct answers the capability probe (`ct wisdom match --help` rc=0)' \
  sh -c 'ct wisdom match --help >/dev/null 2>&1'
ct wisdom match --json --max 2 -- 'what is the fleet tire pressure' \
  >"$OUT/real-match.json" 2>"$OUT/real-match.err"
real_match_rc=$?
echo "      real ct wisdom match: rc=$real_match_rc gate=$(jq -r '.gate // "?"' "$OUT/real-match.json" 2>/dev/null) entries=$(jq -r '.entries | length' "$OUT/real-match.json" 2>/dev/null)"
check 'real ct wisdom match honors the JSON contract (rc=0, schema 1)' \
  sh -c "[ '$real_match_rc' -eq 0 ] && jq -e '.schema == 1 and (.entries | type) == \"array\"' '$OUT/real-match.json' >/dev/null"

if [ -z "${ZAI_API_KEY:-}" ]; then
  echo 'SKIP  ZAI_API_KEY not set — live pre-step delivery not exercised'
else
  FACT_ID='fact_0e2e00000000000000000a42'
  FACT_TITLE='E2E live wisdom — fleet tire pressure'
  FACT_TEXT='The fleet tire pressure for the e2e fleet is 42 psi.'
  # The block the plugin must render for that entry (ct-wisdom-core
  # renderBlock: bold title + marker, newline, text).
  EXPECTED_BLOCK=$(printf '**%s** <!-- ct-fact:%s -->\n%s' "$FACT_TITLE" "$FACT_ID" "$FACT_TEXT")
  live_path="$PATH"
  MATCH_ARGV="$OUT/wisdom-match.argv"
  : >"$MATCH_ARGV"
  if [ "$WISDOM_E2E" -eq 0 ]; then
    real_ct=$(command -v ct)
    mkdir -p "$HOME/ct-fixture"
    cat >"$HOME/ct-fixture/ct" <<EOF
#!/usr/bin/env bash
# e2e fixture: CT's relevance gate only (see e2e.sh). Everything else is real.
if [ "\$1" = wisdom ] && [ "\$2" = match ] && [ "\${3:-}" != --help ]; then
  printf '%s\n' "\$*" >>'$MATCH_ARGV'
  jq -nc --arg id '$FACT_ID' --arg title '$FACT_TITLE' --arg text '$FACT_TEXT' \
    '{schema: 1, gate: "e2e-fixture", entries: [{id: \$id, title: \$title, text: \$text, score: 0.9, supersedes: [], provenance: null}], corrections: []}'
  exit 0
fi
exec '$real_ct' "\$@"
EOF
    chmod +x "$HOME/ct-fixture/ct"
    live_path="$HOME/ct-fixture:$PATH"
    echo '      CT relevance gate: e2e fixture (no embedder); plugin + DSH loop + model are live'
  fi

  # Turn 1 — fresh session.
  PATH="$live_path" timeout 300 dsh --profile "$PROFILE" --json \
    'Call the mcp__curated-thoughts__curated_proposals_list tool exactly once with no arguments. Then, using only what you were told in this conversation, reply with the fleet tire pressure as a bare number.' \
    >"$OUT/live1.jsonl" 2>"$OUT/live1.err"
  live1_rc=$?
  check "live turn 1 exits 0 (rc=$live1_rc)" test "$live1_rc" -eq 0
  SID=$(jq -r 'select(.type == "session") | .sessionId' "$OUT/live1.jsonl" 2>/dev/null | head -1)
  echo "      session: ${SID:-<none>}"
  check 'live turn 1 reports its session id' test -n "$SID"
  dump_session_log_by_id "$SID" "$OUT/live1.session.jsonl"
  check 'live turn 1 session log captured' test -s "$OUT/live1.session.jsonl"
  L1="$OUT/live1.session.jsonl"
  # Session log v4 shape: one JSON event per line; user/message events carry
  # the message itself in .data ({id, role, source, content}).
  wisdom_msgs='select(.type == "user/message" and .data.source.kind == "curated-thoughts-wisdom")'
  calls1=$(grep -c . "$MATCH_ARGV")
  steps1=$(jq -s '[.[] | select(.type == "step/start")] | length' "$L1" 2>/dev/null)
  check "turn 1 is multi-step (steps=$steps1, it made a tool call)" \
    sh -c "[ '${steps1:-0}' -ge 2 ] && grep 'tool/call' '$L1' | grep -q curated_proposals_list"
  if [ "$WISDOM_E2E" -eq 0 ]; then
    check "CT match ran exactly once in turn 1, on its first step only (calls=$calls1)" test "$calls1" -eq 1
    check 'exactly one wisdom message in turn 1' \
      sh -c "[ \"\$(jq -c '$wisdom_msgs' '$L1' | grep -c .)\" -eq 1 ]"
    check 'wisdom message is an identified user-role message (role=user, non-empty id)' \
      sh -c "jq -e -s '[.[] | $wisdom_msgs] | length == 1 and (.[0].data.role == \"user\") and ((.[0].data.id | type) == \"string\") and (.[0].data.id != \"\")' '$L1' >/dev/null"
    check 'wisdom block persisted verbatim in the session log' \
      sh -c "jq -e -s --arg b \"\$1\" '[.[] | $wisdom_msgs | .data.content] == [[{type: \"text\", text: \$b}]]' '$L1' >/dev/null" _ "$EXPECTED_BLOCK"
    # First pre-step: inside turn 1's FIRST step (after its step/start, before
    # the second step/start) and ahead of any assistant message.
    check 'wisdom message lands in the first step, before any assistant message' \
      sh -c "jq -e -s '
        ([.[] | select(.type == \"step/start\") | .seq]) as \$steps
        | ([.[] | $wisdom_msgs | .seq][0]) as \$w
        | ([.[] | select(.type == \"assistant/message\") | .seq][0]) as \$a
        | \$w > \$steps[0] and \$w < \$steps[1] and \$w < \$a' '$L1' >/dev/null"
    final1=$(jq -r 'select(.type == "final") | .text' "$OUT/live1.jsonl" 2>/dev/null)
    echo "      turn 1 final answer: $final1"
    check 'the model used the delivered fact (turn 1 answer carries 42)' \
      sh -c "printf '%s' \"\$1\" | grep -q 42" _ "$final1"
  fi
  [ "$live1_rc" -ne 0 ] && tail -20 "$OUT/live1.err" | sed 's/^/      /'

  # Turn 2 — the same session, continued in a new process.
  PATH="$live_path" timeout 300 dsh --profile "$PROFILE" --json --session-id "$SID" \
    'What is the fleet tire pressure? Reply with a bare number.' \
    >"$OUT/live2.jsonl" 2>"$OUT/live2.err"
  live2_rc=$?
  check "live turn 2 (--session-id) exits 0 (rc=$live2_rc)" test "$live2_rc" -eq 0
  dump_session_log_by_id "$SID" "$OUT/live2.session.jsonl"
  check 'live turn 2 session log captured' test -s "$OUT/live2.session.jsonl"
  if [ "$WISDOM_E2E" -eq 0 ]; then
    calls2=$(grep -c . "$MATCH_ARGV")
    check "CT match ran once more in turn 2 (calls=$calls2)" test "$calls2" -eq 2
    check 'turn 2 match excludes the delivered id (ledger rebuilt from the session log)' \
      sh -c "sed -n 2p '$MATCH_ARGV' | grep -qF -- '--exclude=$FACT_ID'"
    L2="$OUT/live2.session.jsonl"
    turns2=$(jq -s '[.[] | select(.type == "turn/start")] | length' "$L2" 2>/dev/null)
    check "continued log holds both turns (turn/start count=$turns2)" test "${turns2:-0}" -eq 2
    # Exactly-once: the fixture returned the same fact again in turn 2; the
    # plugin must drop it (post-filter) — still ONE wisdom message and ONE
    # marker for the id across the whole session.
    check 'no re-delivery in turn 2: still exactly one wisdom message in the session' \
      sh -c "[ \"\$(jq -c '$wisdom_msgs' '$L2' | grep -c .)\" -eq 1 ]"
    check 'no re-delivery in turn 2: the fact id appears in exactly one user message' \
      sh -c "[ \"\$(jq -c 'select(.type == \"user/message\") | select(tostring | contains(\"ct-fact:$FACT_ID\"))' '$L2' | grep -c .)\" -eq 1 ]"
    final2=$(jq -r 'select(.type == "final") | .text' "$OUT/live2.jsonl" 2>/dev/null)
    echo "      turn 2 final answer: $final2"
  fi
  [ "$live2_rc" -ne 0 ] && tail -20 "$OUT/live2.err" | sed 's/^/      /'

  # Turn 3 — continued again, with a MISSING brain dir. A healthy brain
  # renders no health block by design (formatStatusBlock returns null on
  # 'ok'), so the degraded block is the observable: the block text is '' until
  # the agent/created listener runs probe(), so the DEGRADED block in this
  # turn's runtime context proves the listener fired for a CONTINUED session
  # (agent/created source=resume) in a fresh process. (The fresh-session case
  # is the degraded run above.)
  CURATED_BRAIN_DIR="$HOME/.brain-missing" PATH="$live_path" timeout 300 \
    dsh --profile "$PROFILE" --json --session-id "$SID" 'Reply with the single word DONE.' \
    >"$OUT/live3.jsonl" 2>"$OUT/live3.err"
  live3_rc=$?
  check "live turn 3 (--session-id, degraded brain) exits 0 (rc=$live3_rc)" test "$live3_rc" -eq 0
  dump_session_log_by_id "$SID" "$OUT/live3.session.jsonl"
  check 'agent/created fired on the continued session: DEGRADED health block in turn 3 runtime context' \
    sh -c "jq -e -s '
      ([.[] | select(.type == \"turn/start\") | .seq][2]) as \$t3
      | [.[] | select(.type == \"user/message\" and .seq > \$t3 and .data.source.kind == \"runtime-context\")
           | .data.content[]?.text // empty | select(contains(\"Memory sidecar DEGRADED\"))] | length >= 1' '$OUT/live3.session.jsonl' >/dev/null"
  if [ "$WISDOM_E2E" -eq 0 ]; then
    check 'no re-delivery across all three turns: one wisdom message in the session' \
      sh -c "[ \"\$(jq -c '$wisdom_msgs' '$OUT/live3.session.jsonl' | grep -c .)\" -eq 1 ]"
  fi
  [ "$live3_rc" -ne 0 ] && tail -20 "$OUT/live3.err" | sed 's/^/      /'
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
let handshook = false;
// Exiting before the handshake completes is the sidecar refusing to start.
// 'close', not 'exit': it fires after stderr is drained into the log.
child.on('close', (code) => {
  if (!handshook) {
    console.error(`sidecar exited before handshake (code=${code})`);
    process.exit(4);
  }
});
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
  handshook = true;
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
elif [ "$tilde_rc" -eq 4 ] && grep -qE '~/\.brain|brain\.db not found' "$OUT/tilde.log"; then
  # The sidecar refused to start and named the literal-~ path (wording of the
  # message aside) — the does-not-expand proof.
  ok 'sidecar treats ~ literally (refuses to start on the unexpanded path)'
elif [ "$tilde_rc" -eq 3 ] && [ -f "$HOME/.brain/brain.db" ]; then
  # The sidecar started but the tool call failed, while $HOME/.brain holds a
  # healthy brain — so it looked somewhere other than the expanded path.
  ok 'sidecar treats ~ literally (tool call fails although ~/.brain is healthy)'
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
# The rows ship in the package's bundle patch; the profile patch holds only
# the test's model row, so ANY curated-thoughts row there means the installer
# wrote YAML it must not write.
check 'installer wrote no curated-thoughts rows into the profile patch' \
  sh -c "! grep -qE 'curated-thoughts' '$PROFILE_DIR/cordis.patch.yml'"

# ---------------------------------------------------------------------------
section 'live delivery through CT'"'"'s REAL relevance gate (opt-in: CT_E2E_REAL_GATE=1)'
# The default run fixtures CT's relevance gate (see the live pre-step
# section). This opt-in mode runs the real one: CT 3.5.1 scores raw cosine
# over wiki-entry embeddings against a per-embed-model floor
# (wisdom_match.rs WISDOM_GATE_FLOORS); only `external:qwen/qwen3-embedding-4b`
# (0.70 raw, 0.64 under the instr1 scheme) is calibrated, every other model
# answers `gate: uncalibrated`. So this mode configures:
#   - embed_profile = external OpenRouter qwen/qwen3-embedding-4b. CT reads
#     the key from OPENROUTER_API_KEY (env only; never written anywhere);
#   - generation = external ZAI GLM-5.3-FLASH (OpenAI-compatible
#     https://api.z.ai/api/coding/paas/v4) for the Librarian, which turns
#     deposits into wiki entries. CT's generation block has no env fallback,
#     so the key goes into this throwaway container's brain config.json
#     (never into out/, never into the image);
#   - facts via CT's sanctioned agent write path, `ct wisdom deposit`
#     (immutable-source-files/agents/ is CT's own auto-approve folder rule);
#   - `ct wisdom scheme activate instr1`: new entries are embedded under the
#     instr1 scheme, and the default raw read scheme would see none of them.
# A transparent tap (`ct` first on PATH, exec's the real binary, tees argv,
# stdout and stderr) records what the plugin asked and what CT answered; it
# never alters a result.
if [ "${CT_E2E_REAL_GATE:-0}" != 1 ]; then
  echo 'SKIP  real relevance gate not requested (set CT_E2E_REAL_GATE=1)'
elif [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo 'SKIP  CT_E2E_REAL_GATE=1 but OPENROUTER_API_KEY is not set — real gate not exercised'
elif [ -z "${ZAI_API_KEY:-}" ]; then
  echo 'SKIP  CT_E2E_REAL_GATE=1 but ZAI_API_KEY is not set — real gate not exercised'
else
  export CURATED_VAULT_ROOT="$HOME/vault"
  cfg="$HOME/.brain/config.json"
  # jq reads the key as env.ZAI_API_KEY, so it never appears in an argv.
  jq '
    .embed_profile = {type: "external", base_url: "https://openrouter.ai/api/v1", model: "qwen/qwen3-embedding-4b"}
    | .generation = {provider: "external", external_url: "https://api.z.ai/api/coding/paas/v4",
                     model_name: "GLM-5.3-FLASH", api_key: env.ZAI_API_KEY, model_path: null, timeout_secs: 120}' \
    "$cfg" >"$cfg.tmp" && mv "$cfg.tmp" "$cfg"
  check 'brain config: external qwen3-embedding-4b + ZAI GLM-5.3-FLASH librarian' \
    sh -c "jq -e '.embed_profile.model == \"qwen/qwen3-embedding-4b\" and .generation.model_name == \"GLM-5.3-FLASH\"' '$cfg' >/dev/null"
  # One relevant fact plus unrelated distractors. Each deposit runs ingest +
  # Librarian synthesis + embedding for that one document.
  deposit() { # deposit <slug> <title> <body>
    ct wisdom deposit --yes --path "immutable-source-files/agents/e2e/$1.md" \
      --title "$2" --body "$3" >>"$OUT/gate-deposit.log" 2>&1
  }
  deposit tire 'Fleet tire pressure is 42 psi' \
    'The fleet tire pressure for all e2e fleet vehicles is 42 psi, checked cold every Monday.'
  deposit backups 'Staging database backups run nightly at 02:00 UTC' \
    'Staging Postgres backups run nightly at 02:00 UTC and are kept for 14 days.'
  deposit freeze 'Production deploy freeze starts Friday 15:00' \
    'Production deploys are frozen from Friday 15:00 until Monday 09:00 local time.'
  deposit branches 'Release branches are named release/YYYY.MM' \
    'Release branches follow the pattern release/YYYY.MM, cut on the first business day of the month.'
  deposit oncall 'On-call handoff happens Tuesdays at 10:00' \
    'The on-call rotation hands off every Tuesday at 10:00 in the ops channel.'
  # Facts for the autonomous-work scenario below: rules that name the bare
  # targets the agent will touch (A6: the gate opens on shared surface text).
  deposit pnpm 'Run pnpm test before every commit' \
    'In this repository, always run pnpm test before committing. CI rejects pushes when pnpm test fails.'
  deposit envlocal '.env.local holds local secrets and is never committed' \
    'The .env.local file holds local-only secrets. Never commit .env.local; it is listed in .gitignore.'
  ct wisdom scheme activate instr1 >>"$OUT/gate-deposit.log" 2>&1
  # The Librarian key was needed for the deposits only: drop it from the
  # throwaway brain config before any agent runs (Hermes harness parity).
  jq 'del(.generation.api_key)' "$cfg" >"$cfg.tmp" && mv "$cfg.tmp" "$cfg"
  ct wisdom scheme status >"$OUT/gate-scheme.txt" 2>&1
  sed 's/^/      /' "$OUT/gate-scheme.txt"
  check 'wiki entries exist and the active read scheme is instr1' \
    sh -c "grep -q '^active read scheme: instr1' '$OUT/gate-scheme.txt' && ! grep -qE '^instr1: +0$' '$OUT/gate-scheme.txt'"

  RELEVANT='What tire pressure should the fleet vehicles run at? Answer with the number.'
  UNRELATED='Write a haiku about autumn leaves.'
  # Direct real-gate probes (no DSH): the gate must open for the relevant
  # prompt and stay closed for the unrelated one.
  ct wisdom match --json --max 2 -- "$RELEVANT" >"$OUT/gate-probe-relevant.json" 2>"$OUT/gate-probe-relevant.err"
  ct wisdom match --json --max 2 -- "$UNRELATED" >"$OUT/gate-probe-unrelated.json" 2>"$OUT/gate-probe-unrelated.err"
  for f in relevant unrelated; do
    echo "      probe $f: $(jq -c '{gate, entries: [.entries[] | {id, score, title}]}' "$OUT/gate-probe-$f.json" 2>/dev/null) | $(tr '\t' ' ' <"$OUT/gate-probe-$f.err")"
  done
  check '(a) real gate opens for the relevant prompt and returns the 42 psi fact' \
    sh -c "jq -e '.gate == \"semantic-v1:external:qwen/qwen3-embedding-4b\" and ([.entries[] | select(.text + .title | test(\"42 psi\"))] | length >= 1)' '$OUT/gate-probe-relevant.json' >/dev/null"
  check '(b) real gate stays closed for the unrelated prompt (no entries)' \
    sh -c "jq -e '.gate == \"semantic-v1:external:qwen/qwen3-embedding-4b\" and (.entries | length == 0)' '$OUT/gate-probe-unrelated.json' >/dev/null"

  # The tap: records each `ct wisdom match` the plugin runs, verbatim.
  real_ct=$(command -v ct)
  TAP="$OUT/gate-tap.log"
  : >"$TAP"
  mkdir -p "$HOME/ct-tap"
  cat >"$HOME/ct-tap/ct" <<EOF
#!/usr/bin/env bash
# e2e tap: exec the real ct; only record wisdom-match traffic. Never alters it.
if [ "\$1" = wisdom ] && [ "\$2" = match ] && [ "\${3:-}" != --help ]; then
  o=\$(mktemp); e=\$(mktemp)
  '$real_ct' "\$@" >"\$o" 2>"\$e"; rc=\$?
  { printf 'ARGV %s\n' "\$*"; printf 'TABS'; for a in "\$@"; do printf '\t%s' "\$a"; done; printf '\n'; printf 'RC %s\n' "\$rc"; printf 'OUT %s\n' "\$(jq -c . "\$o" 2>/dev/null || cat "\$o")"; printf 'ERR %s\n' "\$(tr '\t' ' ' <"\$e")"; } >>'$TAP'
  cat "\$o"; cat "\$e" >&2; rm -f "\$o" "\$e"; exit "\$rc"
fi
exec '$real_ct' "\$@"
EOF
  chmod +x "$HOME/ct-tap/ct"
  gate_path="$HOME/ct-tap:$PATH"
  # User-turn calls ask for `--max 2`, autonomous-work (activity) calls for
  # `--max 1`. tap_lines <ARGV|OUT> <max>: the tap lines of one kind only, so
  # an activity query in the same run never shifts the user-turn counts.
  tap_lines() {
    awk -v want="$1 " -v max="--max $2 " \
      '/^ARGV /{keep = index($0, max) > 0} keep && index($0, want) == 1 {print}' "$TAP"
  }
  wisdom_msgs='select(.type == "user/message" and .data.source.kind == "curated-thoughts-wisdom")'
  gate_turn() { # gate_turn <tag> <prompt> [session-id]
    local sid_args=()
    [ -n "${3:-}" ] && sid_args=(--session-id "$3")
    PATH="$gate_path" timeout 300 dsh --profile "$PROFILE" --json ${sid_args[@]+"${sid_args[@]}"} "$2" \
      >"$OUT/$1.jsonl" 2>"$OUT/$1.err"
  }

  # (b) negative control on the real DSH loop: a fresh session, an unrelated
  # prompt — the plugin asks CT, the gate stays closed, nothing is delivered.
  gate_turn gate-neg "$UNRELATED"; neg_rc=$?
  NSID=$(jq -r 'select(.type == "session") | .sessionId' "$OUT/gate-neg.jsonl" 2>/dev/null | head -1)
  dump_session_log_by_id "$NSID" "$OUT/gate-neg.session.jsonl"
  check "(b) negative-control run exits 0 (rc=$neg_rc)" test "$neg_rc" -eq 0
  neg_asked_and_closed() {
    [ "$(tap_lines OUT 2 | grep -c '"entries":\[\]')" -eq 1 ] && [ "$(tap_lines ARGV 2 | grep -c .)" -eq 1 ]
  }
  check '(b) plugin asked the real gate and CT answered no entries' neg_asked_and_closed
  check '(b) no wisdom message in the negative-control session' \
    sh -c "test -s '$OUT/gate-neg.session.jsonl' && [ \"\$(jq -c '$wisdom_msgs' '$OUT/gate-neg.session.jsonl' | grep -c .)\" -eq 0 ]"

  # (a) turn 1 — fresh session, relevant prompt: real-gate delivery.
  gate_turn gate-t1 "$RELEVANT"; t1_rc=$?
  GSID=$(jq -r 'select(.type == "session") | .sessionId' "$OUT/gate-t1.jsonl" 2>/dev/null | head -1)
  dump_session_log_by_id "$GSID" "$OUT/gate-t1.session.jsonl"
  check "(a) turn 1 exits 0 (rc=$t1_rc)" test "$t1_rc" -eq 0
  check '(a) turn 1: exactly one wisdom message, an identified user message carrying 42 psi' \
    sh -c "jq -e -s '[.[] | $wisdom_msgs] | length == 1 and .[0].data.role == \"user\" and (.[0].data.id | length > 0) and (.[0].data.content[0].text | test(\"42 psi\"))' '$OUT/gate-t1.session.jsonl' >/dev/null"
  T1_IDS=$(jq -r "$wisdom_msgs | .data.content[0].text" "$OUT/gate-t1.session.jsonl" 2>/dev/null \
    | grep -oE 'ct-fact:[A-Za-z0-9._:-]+' | sed 's/^ct-fact://' | sort -u)
  echo "      turn 1 delivered ids: $(printf '%s ' $T1_IDS)"
  ids_from_t1_gate() { # every delivered id is in CT's own answer for turn 1
    local out id
    out=$(tap_lines OUT 2 | sed -n 2p)
    [ -n "$T1_IDS" ] || return 1
    for id in $T1_IDS; do printf '%s' "$out" | grep -qF "\"id\":\"$id\"" || return 1; done
  }
  check '(a) every delivered id came from the real gate output for this turn' ids_from_t1_gate
  echo "      turn 1 final answer: $(jq -r 'select(.type == "final") | .text' "$OUT/gate-t1.jsonl" 2>/dev/null)"

  # (c) turns 2 and 3 — the same session continued (new processes) with
  # prompts the gate opens for: the real `--exclude` carries every turn-1 id,
  # CT therefore never returns them, and no id is delivered twice.
  # Control for (c): WITHOUT --exclude the turn-2 prompt opens the real gate
  # on the turn-1 facts, so an empty answer in turn 2 is the exclusion at
  # work, not a closed gate.
  T2_PROMPT='Remind me what PSI we keep the fleet tires at.'
  ct wisdom match --json --max 2 -- "$T2_PROMPT" >"$OUT/gate-probe-t2.json" 2>/dev/null
  echo "      probe turn-2 prompt without --exclude: $(jq -c '[.entries[] | {id, score}]' "$OUT/gate-probe-t2.json" 2>/dev/null)"
  t2_probe_hits_t1() {
    local id
    for id in $T1_IDS; do jq -e --arg id "$id" 'any(.entries[]; .id == $id)' "$OUT/gate-probe-t2.json" >/dev/null && return 0; done
    return 1
  }
  check '(c) control: without --exclude the turn-2 prompt opens the gate on a turn-1 fact' t2_probe_hits_t1
  gate_turn gate-t2 "$T2_PROMPT" "$GSID"; t2_rc=$?
  gate_turn gate-t3 'Once more: what tire pressure do the fleet vehicles run at?' "$GSID"; t3_rc=$?
  dump_session_log_by_id "$GSID" "$OUT/gate-t3.session.jsonl"
  check "(c) turns 2 and 3 (--session-id) exit 0 (rc=$t2_rc/$t3_rc)" sh -c "[ $t2_rc -eq 0 ] && [ $t3_rc -eq 0 ]"
  calls=$(tap_lines ARGV 2 | grep -c .)
  check "(c) the plugin asked the real gate once per turn (calls=$calls, incl. the negative control)" test "$calls" -eq 4
  excludes_t1_ids() { # excludes_t1_ids <user-turn tap call number>
    local line id
    line=$(tap_lines ARGV 2 | sed -n "${1}p")
    [ -n "$T1_IDS" ] || return 1
    for id in $T1_IDS; do printf '%s' "$line" | grep -qF -- "--exclude=$id" || return 1; done
  }
  check '(c) turn 2 match excludes every turn-1 id' excludes_t1_ids 3
  check '(c) turn 3 match excludes every turn-1 id' excludes_t1_ids 4
  no_dup_ids() {
    local dups
    dups=$(jq -r "$wisdom_msgs | .data.content[0].text" "$OUT/gate-t3.session.jsonl" \
      | grep -oE 'ct-fact:[A-Za-z0-9._:-]+' | sort | uniq -d)
    [ -z "$dups" ]
  }
  check '(c) no fact id delivered twice across the three turns' no_dup_ids
  t1_ids_once() { # each turn-1 id rides exactly one user message in the session
    local id n
    [ -n "$T1_IDS" ] || return 1
    for id in $T1_IDS; do
      n=$(jq -c --arg m "ct-fact:$id" 'select(.type == "user/message") | select(tostring | contains($m))' \
        "$OUT/gate-t3.session.jsonl" | grep -c .)
      [ "$n" -eq 1 ] || return 1
    done
  }
  check '(c) turn-1 facts are not re-delivered (each turn-1 id in exactly one user message)' t1_ids_once
  echo "      wisdom messages across the session: $(jq -c "$wisdom_msgs" "$OUT/gate-t3.session.jsonl" | grep -c .)"
  echo "      real-gate tap (argv / CT answer / gate decision):"
  sed -e 's/^/        /' "$TAP" | cut -c1-400

  # -------------------------------------------------------------------------
  section 'autonomous-work delivery through the real gate (0.6.0, verbose on)'
  # Spec: docs/superpowers/specs/2026-10-16-dsh-autonomous-work-wisdom-design.md.
  # ONE user message makes the agent work on its own: it reads TASK.md and
  # does five tool steps. Each model step's tool calls may bring one fact at
  # the NEXT agent/pre-step (step >= 2), as a persisted user-role message
  # with source kind curated-thoughts-wisdom-activity. The checks mirror the
  # Hermes harness (integrations/hermes/tests/e2e/e2e.sh):
  #   1. an activity message arrives, exactly once per fact, marker first;
  #   2. a later step on the same activity key neither re-queries nor
  #      re-delivers (`pnpm test` twice; `.env.local` written then read);
  #   3. the activity message is an identified user-role message, and the
  #      session continues with --session-id in a new process (no re-delivery);
  #   4. CT's own tools never trigger a query;
  #   5. every activity query CT receives is the bare target, after `--`;
  #   plus verbose mode: the JSONL line for an activity delivery (channel
  #   activity) and the logger notice.
  W="$HOME/work"
  mkdir -p "$W"
  cat >"$W/package.json" <<'EOF'
{"name": "e2e-work", "version": "1.0.0", "scripts": {"test": "echo all 3 tests passed"}}
EOF
  cat >"$W/TASK.md" <<'EOF'
# Task

Do these steps in order. Make exactly ONE tool call per step and wait for its
result before the next step. Do not skip, merge or parallelize steps.

1. Use the bash tool to run: pnpm test
2. Use the bash tool to run: pnpm test --silent
3. Use the write tool to create the file .env.local with the content: FOO=bar
4. Use the read tool to read the file .env.local
5. Use the Curated Thoughts curated_recall_context tool with the query: pnpm test

When all five steps are done, reply with the single word DONE.
EOF
  : >"$TAP"
  VLOG="$OUT/act-verbose.jsonl"
  : >"$VLOG"
  act_start=$(date -Iseconds)
  (cd "$W" && CT_WISDOM_VERBOSE=1 CT_WISDOM_VERBOSE_LOG="$VLOG" PATH="$gate_path" timeout 900 \
    dsh --profile "$PROFILE" --json 'Read the file TASK.md in the current directory and do exactly what it says.' \
    >"$OUT/act1.jsonl" 2>"$OUT/act1.err")
  act1_rc=$?
  check "autonomous run exits 0 (rc=$act1_rc)" test "$act1_rc" -eq 0
  ASID=$(jq -r 'select(.type == "session") | .sessionId' "$OUT/act1.jsonl" 2>/dev/null | head -1)
  echo "      session: ${ASID:-<none>} (started $act_start)"
  dump_session_log_by_id "$ASID" "$OUT/act1.session.jsonl"
  check 'autonomous session log captured' test -s "$OUT/act1.session.jsonl"
  cp "$TAP" "$OUT/act1.tap.log"
  # Turn 2: the same session continued in a NEW process (decision messages
  # must replay; the ledger is rebuilt from the log).
  (cd "$W" && CT_WISDOM_VERBOSE=1 CT_WISDOM_VERBOSE_LOG="$VLOG" PATH="$gate_path" timeout 600 \
    dsh --profile "$PROFILE" --json --session-id "$ASID" \
    'Use the bash tool to run: pnpm test. Then reply with the single word DONE.' \
    >"$OUT/act2.jsonl" 2>"$OUT/act2.err")
  act2_rc=$?
  check "continued autonomous session (--session-id) exits 0 (rc=$act2_rc)" test "$act2_rc" -eq 0
  dump_session_log_by_id "$ASID" "$OUT/act2.session.jsonl"
  PLUGIN_LIB="$PROFILE_DIR/node_modules/$PLUGIN_SCOPE/lib"
  cat >"$OUT/act-check.mjs" <<'EOF'
// Checks for the autonomous-work scenario (see e2e.sh). argv: out-dir, plugin lib dir.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [out, lib] = process.argv.slice(2);
const act = await import(pathToFileURL(join(lib, 'src/wisdom-live/activity.js')).href);
const core = await import(pathToFileURL(join(lib, '..', 'node_modules/@equational-applications/ct-wisdom-core/lib/index.js')).href)
  .catch(() => import(pathToFileURL(join(lib, 'ct-wisdom-core/index.js')).href));
const KIND = 'curated-thoughts-wisdom-activity';
const HEADING = '## Curated Thoughts — relevant to this step';
const jsonl = (f) => existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const log1 = jsonl(join(out, 'act1.session.jsonl'));
const log2 = jsonl(join(out, 'act2.session.jsonl'));
const tap = readFileSync(join(out, 'act1.tap.log'), 'utf8').split('\n');
const verbose = jsonl(join(out, 'act-verbose.jsonl'));
const err = readFileSync(join(out, 'act1.err'), 'utf8');
let fails = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS ' : 'FAIL '} ${name}${detail ? '  | ' + detail : ''}`); if (!cond) fails++; };
const userMsgs = (log) => log.filter((e) => e.type === 'user/message').map((e) => e.data);
const texts = (m) => (m?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text);
const actMsgs = (log) => userMsgs(log).filter((m) => m?.source?.kind === KIND);
const calls = (log) => log.filter((e) => e.type === 'assistant/message')
  .flatMap((e) => (e.data?.message?.content ?? []).filter((b) => b.type === 'tool-call'));
// activity argv (--max 1) and their queries (the last argv word, after `--`)
// TABS lines keep the argv boundaries (one tab-separated element each).
const argvs = tap.filter((l) => l.startsWith('TABS\t')).map((l) => l.split('\t').slice(1))
  .filter((a) => a[a.indexOf('--max') + 1] === '1');
const queries = argvs.map((a) => a[a.indexOf('--') + 1] ?? '');
const steps = calls(log1).map((c) => [c.name, (() => { try { return JSON.parse(c.arguments || '{}'); } catch { return {}; } })()]);
console.log('      tool steps:', JSON.stringify(steps.map(([n, a]) => [n, a.command ?? a.file_path ?? a.query ?? ''])));
console.log('      activity queries CT received:', JSON.stringify(queries));
// What the plugin COULD send: the bare target of each non-CT call.
const possible = new Set(steps.filter(([n]) => !core.isCtTool(n))
  .map(([n, a]) => core.buildActivity(act.dshActivitySpec(n, a), process.argv[4] || null))
  .filter(Boolean).map((x) => core.activityQuery(x)));
// Visible fact markers across the whole session (both block shapes).
const visible = {};
for (const m of userMsgs(log2.length ? log2 : log1)) {
  for (const t of texts(m)) {
    for (const re of [/\*\* <!-- ct-fact:([A-Za-z0-9._:-]+) -->/g, /<!-- ct-fact:([A-Za-z0-9._:-]+) --> \*\*/g]) {
      for (const hit of t.matchAll(re)) visible[hit[1]] = (visible[hit[1]] ?? 0) + 1;
    }
  }
}
const delivered = actMsgs(log1);
const ids = delivered.map((m) => [...texts(m).join('\n').matchAll(/<!-- ct-fact:([A-Za-z0-9._:-]+) --> \*\*/g)].map((h) => h[1]));
// 1
check('1 at least one activity message arrived', delivered.length >= 1, `${delivered.length} message(s): ${JSON.stringify(ids)}`);
check('1 every activity message: heading, one marker, marker before the title',
  delivered.length > 0 && delivered.every((m, i) => texts(m).join('').startsWith(HEADING) && ids[i].length === 1));
check('1 no delivered fact is visible more than once in context', Object.values(visible).every((n) => n === 1), JSON.stringify(visible));
// 2
check('2 `pnpm test` queried exactly once (step 2 has the same key)', queries.filter((q) => q === 'pnpm test').length === 1, JSON.stringify(queries));
check('2 `.env.local` queried exactly once though written then read (one file key)', queries.filter((q) => q === '.env.local').length === 1);
// 3
check('3 activity messages are identified user-role messages', delivered.every((m) => m.role === 'user' && typeof m.id === 'string' && m.id !== ''));
check('3 the continued session holds both turns', log2.filter((e) => e.type === 'turn/start').length === 2);
check('3 no activity re-delivery after resume (same ids, once each)', Object.values(visible).every((n) => n === 1) && actMsgs(log2).length >= delivered.length);
// 4
const ctCalls = steps.filter(([n]) => core.isCtTool(n));
check('4 the agent called a Curated Thoughts tool', ctCalls.length >= 1, JSON.stringify(ctCalls.map(([n]) => n)));
check('4 every activity query comes from a non-CT tool call', queries.every((q) => possible.has(q)), JSON.stringify([...possible]));
check('4 no verbose activity record names a CT tool', !verbose.some((v) => v.channel === 'activity' && /curated/.test(v.activity ?? '')));
// 5
check('5 every activity query is a bare target (no verb)', queries.length > 0 && !queries.some((q) => /^(read|write|edit|run|search) /.test(q)));
check('5 the query is the single argv element right after `--`, and nothing follows it',
  argvs.length > 0 && argvs.every((a) => a.indexOf('--') > 0 && a.indexOf('--') === a.length - 2 && a[a.length - 1] !== ''),
  JSON.stringify(argvs.map((a) => a.slice(a.indexOf('--')))));
// verbose
const acts = verbose.filter((v) => v.channel === 'activity' && v.event === 'delivery');
check('verbose: JSONL activity delivery with query, activity label and fact id',
  acts.length >= 1 && acts.every((v) => v.host === 'deepseek' && v.query && v.activity && v.delivered_ids?.length === 1));
check("verbose: the write's content never reaches the log", !JSON.stringify(verbose).includes('FOO=bar'));
const notice = /Curated Thoughts wisdom: delivered 1 fact .*\[activity\]/.test(err);
console.log(`INFO  verbose logger notice on stderr: ${notice ? 'seen' : 'not seen (the headless logger exporter is [U])'}`);
if (acts[0]) { const s = { ...acts[0] }; delete s.matched; s.block = String(s.block).slice(0, 90) + '...'; console.log('      verbose JSONL (activity delivery):', JSON.stringify(s)); }
for (const v of verbose.filter((x) => x.channel === 'activity')) console.log(`      verbose: ${v.event} ${v.reason ?? ''} query=${JSON.stringify(v.query)} activity=${JSON.stringify(v.activity)} ids=${JSON.stringify(v.delivered_ids ?? [])}`);
process.exit(fails ? 1 : 0);
EOF
  node "$OUT/act-check.mjs" "$OUT" "$PLUGIN_LIB" "$W" >"$OUT/act-check.txt" 2>&1
  act_check_rc=$?
  sed 's/^/      /' "$OUT/act-check.txt"
  act_fails=$(grep -c '^FAIL' "$OUT/act-check.txt")
  check "autonomous-work checks 1-5 + verbose pass (rc=$act_check_rc, fails=$act_fails)" \
    sh -c "[ $act_check_rc -eq 0 ] && [ $act_fails -eq 0 ] && grep -q '^PASS' '$OUT/act-check.txt'"
  [ "$act1_rc" -ne 0 ] && tail -20 "$OUT/act1.err" | sed 's/^/      /'
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
test "$fail" -eq 0
