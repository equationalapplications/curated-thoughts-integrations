#!/usr/bin/env bash
# e2e.sh — runs INSIDE the ct-opencode-e2e container (see Dockerfile, run.sh).
#
# Installs the packed integration the way a user would, against the real
# OpenCode binary and the real curated-thoughts-mcp sidecar, then checks:
#   1. install.sh preview writes nothing;
#   2. CT_INSTALL_EDIT=1 install.sh writes payload, loader, skills, mcp entry;
#   3. the doctor reports no FAIL;
#   4. `opencode mcp list` shows the sidecar connected;
#   5. (only with ZAI_API_KEY) a live model calls a Curated Thoughts tool
#      through OpenCode and gets a real sidecar result;
#   6. re-running the installer is a no-op.
#
# No embedding backend runs here (no Ollama, no fastembed download): the live
# call uses curated_proposals_list, which needs neither.
set -uo pipefail

MODEL="${CT_E2E_MODEL:-zai/GLM-5.3-FLASH}"
CONFIG="$HOME/.config/opencode/opencode.json"
PAYLOAD="$HOME/.local/share/curated-thoughts/opencode"
LOADER="$HOME/.config/opencode/plugins/curated-thoughts.js"
SKILLS_DIR="$HOME/.config/opencode/skills"
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
section 'unpack the release tarball'
mkdir -p "$HOME/release"
check 'SHA256SUMS verifies the artifact' sh -c "cd '$HOME/dist' && sha256sum -c --quiet SHA256SUMS"
tar -xzf "$HOME"/dist/opencode-*.tar.gz -C "$HOME/release"
REL=$(find "$HOME/release" -mindepth 1 -maxdepth 1 -type d | head -1)
check 'install.sh is executable (README runs ./scripts/install.sh)' test -x "$REL/scripts/install.sh"

# ---------------------------------------------------------------------------
section 'install.sh preview writes nothing'
before=$(find "$HOME/.config" "$HOME/.local/share" -mindepth 1 2>/dev/null | sort | sha256sum)
"$REL/scripts/install.sh" >"$OUT/preview.log" 2>&1
preview_rc=$?
after=$(find "$HOME/.config" "$HOME/.local/share" -mindepth 1 2>/dev/null | sort | sha256sum)
check "preview exits 0 (rc=$preview_rc)" test "$preview_rc" -eq 0
check 'preview leaves the filesystem untouched' test "$before" = "$after"
check 'preview names the mcp entry' grep -q 'curated-thoughts-mcp' "$OUT/preview.log"

# ---------------------------------------------------------------------------
section 'CT_INSTALL_EDIT=1 install.sh applies'
CT_INSTALL_EDIT=1 "$REL/scripts/install.sh" >"$OUT/apply.log" 2>&1
apply_rc=$?
check "apply exits 0 (rc=$apply_rc)" test "$apply_rc" -eq 0
check 'payload entry installed' test -f "$PAYLOAD/lib/src/index.js"
check 'loader file written' test -f "$LOADER"
for s in curated-thoughts-usage curated-thoughts-ops curated-thoughts-sidecar; do
  check "skill $s installed" test -f "$SKILLS_DIR/$s/SKILL.md"
done
check 'mcp entry in opencode.json' \
  sh -c "jq -e '.mcp[\"curated-thoughts\"].command[0] == \"curated-thoughts-mcp\"' '$CONFIG' >/dev/null"

# ---------------------------------------------------------------------------
section 'doctor'
node "$PAYLOAD/lib/scripts/ct_doctor.js" check --json >"$OUT/doctor.json" 2>"$OUT/doctor.err"
doctor_rc=$?
if jq -e . "$OUT/doctor.json" >/dev/null 2>&1; then
  jq -r '(.checks // .)[] | "      \(.status)\t\(.name)\t\(.detail | .[0:140])"' "$OUT/doctor.json"
else
  cat "$OUT/doctor.json" "$OUT/doctor.err"
fi
# 0 = all PASS, 2 = WARN only (expected: no embedding backend here).
check "doctor reports no FAIL (rc=$doctor_rc)" test "$doctor_rc" -ne 1

# ---------------------------------------------------------------------------
section 'opencode sees the sidecar'
opencode mcp list >"$OUT/mcp-list.log" 2>&1
sed 's/\x1b\[[0-9;]*m//g' "$OUT/mcp-list.log" | sed 's/^/      /'
check 'mcp list shows curated-thoughts connected' \
  sh -c "sed 's/\x1b\[[0-9;]*m//g' '$OUT/mcp-list.log' | grep -i 'curated-thoughts' | grep -qi 'connected'"

# ---------------------------------------------------------------------------
section "live model ($MODEL)"
if [ -z "${ZAI_API_KEY:-}" ]; then
  echo 'SKIP  ZAI_API_KEY not set'
else
  # The provider lives in OPENCODE_CONFIG_CONTENT so the installer-owned
  # opencode.json stays exactly as the installer wrote it.
  OPENCODE_CONFIG_CONTENT=$(cat "$HOME/dist/zai-provider.json") \
    timeout 300 opencode run --format json -m "$MODEL" \
    'Call the curated_proposals_list tool from the curated-thoughts MCP server exactly once with no arguments, then reply with the single word DONE.' \
    >"$OUT/run.jsonl" 2>"$OUT/run.err"
  run_rc=$?
  check "opencode run exits 0 (rc=$run_rc)" test "$run_rc" -eq 0
  tool_events=$(jq -c 'select(.type == "tool_use") | .part | {tool, status: .state.status, output: (.state.output // "" | tostring | .[0:120])}' "$OUT/run.jsonl" 2>/dev/null)
  printf '      %s\n' "$tool_events"
  called() { grep -q 'curated_proposals_list' <<<"$tool_events"; }
  completed() { grep 'curated_proposals_list' <<<"$tool_events" | grep -q '"status":"completed"'; }
  check 'model called curated_proposals_list via OpenCode' called
  check 'the tool call completed' completed
  if [ "$run_rc" -ne 0 ]; then tail -20 "$OUT/run.err" | sed 's/^/      /'; fi
fi

# ---------------------------------------------------------------------------
section 're-running the installer is a no-op'
cfg_before=$(sha256sum "$CONFIG")
CT_INSTALL_EDIT=1 "$REL/scripts/install.sh" >"$OUT/reapply.log" 2>&1
reapply_rc=$?
check "re-apply exits 0 (rc=$reapply_rc)" test "$reapply_rc" -eq 0
check 'opencode.json unchanged' test "$cfg_before" = "$(sha256sum "$CONFIG")"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
test "$fail" -eq 0
