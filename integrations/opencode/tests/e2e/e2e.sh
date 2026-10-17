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
#   6. (only with ZAI_API_KEY) Intuitive Wisdom live delivery over
#      chat.message with a test-only ct stub: bootstrap + live fact reach the
#      live model, persist as synthetic parts, and are never redelivered by a
#      second (--continue) process;
#   7. re-running the installer is a no-op;
#   8. (only with CT_E2E_REAL_GATE=1, ZAI_API_KEY and OPENROUTER_API_KEY)
#      autonomous-work delivery through CT's real relevance gate: activity
#      blocks in tool results, once per key and fact, persisted, never from
#      CT tools or refused calls, bare-target queries, verbose records.
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
section "live Intuitive Wisdom via chat.message ($MODEL)"
# Parent spec AC 10 / leg spec LD12. A test-only `ct` stub (never shipped;
# tests/fixtures/ct-stub.mjs) stands in for the CT CLI, so no embedding
# backend is needed: `recall` returns one bootstrap fact, `wisdom match` one
# live fact — and it IGNORES --exclude, so only the plugin's own ledger can
# keep turn 2 from redelivering. Turn 2 runs in a NEW process (--continue):
# the model must still know both facts (persisted parts reached it), and the
# session must hold exactly one copy of each.
if [ -z "${ZAI_API_KEY:-}" ]; then
  echo 'SKIP  ZAI_API_KEY not set (AC 10 pending)'
else
  mkdir -p "$HOME/.local/bin"
  cp "$HOME/dist/ct-stub.mjs" "$HOME/.local/bin/ct"
  chmod 755 "$HOME/.local/bin/ct"
  export PATH="$HOME/.local/bin:$PATH"
  export CT_STUB_LOG="$OUT/ct-stub.jsonl"
  export CT_STUB_RECALL='[{"id":"e2e-boot-depot","title":"E2E depot city","text":"The e2e fleet depot is in Lisbon."}]'
  export CT_STUB_MATCH='[{"id":"e2e-fact-tire","title":"E2E fleet tire pressure","text":"The e2e fleet tire pressure is 42 psi."}]'
  export CT_STUB_IGNORE_EXCLUDE=1
  : >"$CT_STUB_LOG"
  check 'ct stub answers the identity probe' sh -c "ct --help | grep -q 'Curated Thoughts'"

  OPENCODE_CONFIG_CONTENT=$(cat "$HOME/dist/zai-provider.json") \
    timeout 300 opencode run --format json -m "$MODEL" \
    'What is the e2e fleet tire pressure? Answer from the curated memory attached to this message, in one short line.' \
    >"$OUT/wisdom1.jsonl" 2>"$OUT/wisdom1.err"
  w1_rc=$?
  check "turn 1 exits 0 (rc=$w1_rc)" test "$w1_rc" -eq 0
  answer1=$(jq -r 'select(.type == "text") | .part.text' "$OUT/wisdom1.jsonl" 2>/dev/null | tr '\n' ' ')
  echo "      turn 1 answer: ${answer1:0:200}"
  check 'turn 1: the model answers from the delivered fact (42)' grep -q '42' <<<"$answer1"
  SID=$(jq -r '.part.sessionID // .sessionID // empty' "$OUT/wisdom1.jsonl" 2>/dev/null | head -n 1)
  check 'turn 1: session id captured' test -n "$SID"

  OPENCODE_CONFIG_CONTENT=$(cat "$HOME/dist/zai-provider.json") \
    timeout 300 opencode run --continue --format json -m "$MODEL" \
    'Which city is the e2e fleet depot in, and what is the tire pressure? One short line.' \
    >"$OUT/wisdom2.jsonl" 2>"$OUT/wisdom2.err"
  w2_rc=$?
  check "turn 2 (new process, --continue) exits 0 (rc=$w2_rc)" test "$w2_rc" -eq 0
  answer2=$(jq -r 'select(.type == "text") | .part.text' "$OUT/wisdom2.jsonl" 2>/dev/null | tr '\n' ' ')
  echo "      turn 2 answer: ${answer2:0:200}"
  check 'turn 2: bootstrap fact reached the model from persisted history (Lisbon)' grep -qi 'lisbon' <<<"$answer2"
  check 'turn 2: live fact still known without redelivery (42)' grep -q '42' <<<"$answer2"

  opencode export "$SID" >"$OUT/wisdom-export.json" 2>"$OUT/wisdom-export.err"
  wisdom_parts() { # wisdom_parts <marker line> → count of our persisted parts
    jq --arg m "$1" '[.messages[] | select(.info.role == "user") | .parts[]
      | select(.type == "text" and .synthetic == true and ((.text // "") | split("\n") | index($m)))] | length' \
      "$OUT/wisdom-export.json"
  }
  live_n=$(wisdom_parts 'source.kind: curated-thoughts/wisdom')
  boot_n=$(wisdom_parts 'source.kind: curated-thoughts/wisdom-bootstrap')
  echo "      persisted parts: live=$live_n bootstrap=$boot_n"
  check 'exactly one live delivery part persisted (no redelivery on turn 2)' test "$live_n" = 1
  check 'exactly one bootstrap part persisted (first turn only)' test "$boot_n" = 1
  tire_n=$(jq '[.messages[] | select(.info.role == "user") | .parts[] | select(.synthetic == true) | .text // "" | scan("ct-fact:e2e-fact-tire")] | length' "$OUT/wisdom-export.json")
  check "the live fact id appears once in persisted user parts (n=$tire_n)" test "$tire_n" = 1
  check 'our parts carry host-format prt_ ids' sh -c "jq -e '[.messages[].parts[] | select(.synthetic == true and ((.text // \"\") | test(\"source.kind: curated-thoughts/wisdom\"))) | .id | test(\"^prt_[0-9a-f]{12}[0-9A-Za-z]{14}\$\")] | all' '$OUT/wisdom-export.json' >/dev/null"
  match_n=$(grep -c '"wisdom","match","--json"' "$CT_STUB_LOG")
  check "ct wisdom match called once per turn (n=$match_n)" test "$match_n" = 2
  check 'turn 2 excluded the delivered ids' sh -c "grep '\"wisdom\",\"match\",\"--json\"' '$CT_STUB_LOG' | tail -n 1 | grep -q 'exclude=e2e-fact-tire' && grep '\"wisdom\",\"match\",\"--json\"' '$CT_STUB_LOG' | tail -n 1 | grep -q 'exclude=e2e-boot-depot'"
  if [ "$w1_rc" -ne 0 ] || [ "$w2_rc" -ne 0 ]; then tail -20 "$OUT/wisdom1.err" "$OUT/wisdom2.err" | sed 's/^/      /'; fi
fi

# ---------------------------------------------------------------------------
section 're-running the installer is a no-op'
cfg_before=$(sha256sum "$CONFIG")
CT_INSTALL_EDIT=1 "$REL/scripts/install.sh" >"$OUT/reapply.log" 2>&1
reapply_rc=$?
check "re-apply exits 0 (rc=$reapply_rc)" test "$reapply_rc" -eq 0
check 'opencode.json unchanged' test "$cfg_before" = "$(sha256sum "$CONFIG")"

# ---------------------------------------------------------------------------
section 'autonomous-work delivery through CT'"'"'s REAL relevance gate (opt-in: CT_E2E_REAL_GATE=1, verbose on)'
# Spec: docs/superpowers/specs/2026-10-17-opencode-autonomous-work-wisdom-design.md.
# CT 3.5.1's real gate (the deepseek e2e's real-gate setup): embeddings from
# OpenRouter qwen/qwen3-embedding-4b (the one calibrated model; key from
# OPENROUTER_API_KEY, env only), the Librarian on ZAI GLM-5.3-FLASH (its key
# sits in this throwaway container's brain config for the deposits only),
# facts via `ct wisdom deposit`, then `ct wisdom scheme activate instr1`.
# Everything runs under the container's own HOME and ~/.brain.
# ONE user message makes the agent work on its own in a project (a `.git`
# root): bash `pnpm test` twice, write `.env.local`, a CT recall, then a read
# of `secrets.env`, which OpenCode's default ruleset asks for and `opencode
# run` auto-rejects. Checks, mirroring the DSH/Hermes harnesses:
#   1. an activity block arrives in a tool result, exactly once per fact,
#      marker first;
#   2. a later step on the same key neither re-queries nor re-delivers;
#   3. the block persists in the tool part, and the session continues with
#      --continue in a new process without re-delivery;
#   4. CT's own tools never trigger a query;
#   5. every activity query is the bare target, the single argv element after `--`;
#   6. a call the host refused sends nothing to CT;
#   plus verbose mode (JSONL `activity` records).
if [ "${CT_E2E_REAL_GATE:-0}" != 1 ]; then
  echo 'SKIP  real relevance gate not requested (set CT_E2E_REAL_GATE=1)'
elif [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo 'SKIP  CT_E2E_REAL_GATE=1 but OPENROUTER_API_KEY is not set — real gate not exercised'
elif [ -z "${ZAI_API_KEY:-}" ]; then
  echo 'SKIP  CT_E2E_REAL_GATE=1 but ZAI_API_KEY is not set — real gate not exercised'
else
  REAL_CT=/usr/local/bin/ct
  check 'real ct CLI present (image provisioning)' sh -c "'$REAL_CT' --help | grep -q 'Curated Thoughts'"
  # The default section above put the test-only stub first on PATH: drop it.
  base_path=$(printf '%s' "$PATH" | tr ':' '\n' | grep -vx "$HOME/.local/bin" | paste -sd: -)
  unset CT_STUB_LOG CT_STUB_RECALL CT_STUB_MATCH CT_STUB_IGNORE_EXCLUDE
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
  deposit() { # deposit <slug> <title> <body>
    PATH="$base_path" "$REAL_CT" wisdom deposit --yes --path "immutable-source-files/agents/e2e/$1.md" \
      --title "$2" --body "$3" >>"$OUT/gate-deposit.log" 2>&1
  }
  deposit pnpm 'Run pnpm test before every commit' \
    'In this repository, always run pnpm test before committing. CI rejects pushes when pnpm test fails.'
  deposit envlocal '.env.local holds local secrets and is never committed' \
    'The .env.local file holds local-only secrets. Never commit .env.local; it is listed in .gitignore.'
  deposit backups 'Staging database backups run nightly at 02:00 UTC' \
    'Staging Postgres backups run nightly at 02:00 UTC and are kept for 14 days.'
  deposit freeze 'Production deploy freeze starts Friday 15:00' \
    'Production deploys are frozen from Friday 15:00 until Monday 09:00 local time.'
  deposit oncall 'On-call handoff happens Tuesdays at 10:00' \
    'The on-call rotation hands off every Tuesday at 10:00 in the ops channel.'
  PATH="$base_path" "$REAL_CT" wisdom scheme activate instr1 >>"$OUT/gate-deposit.log" 2>&1
  # The Librarian key was needed for the deposits only.
  jq 'del(.generation.api_key)' "$cfg" >"$cfg.tmp" && mv "$cfg.tmp" "$cfg"
  PATH="$base_path" "$REAL_CT" wisdom scheme status >"$OUT/gate-scheme.txt" 2>&1
  sed 's/^/      /' "$OUT/gate-scheme.txt"
  check 'wiki entries exist and the active read scheme is instr1' \
    sh -c "grep -q '^active read scheme: instr1' '$OUT/gate-scheme.txt' && ! grep -qE '^instr1: +0$' '$OUT/gate-scheme.txt'"
  for q in 'pnpm test' '.env.local' 'secrets.env'; do
    PATH="$base_path" "$REAL_CT" wisdom match --json --max 1 -- "$q" >"$OUT/gate-probe.json" 2>/dev/null
    echo "      probe \"$q\": $(jq -c '{gate, entries: [.entries[] | {id, score, title}]}' "$OUT/gate-probe.json" 2>/dev/null)"
  done

  # The tap: records each `ct wisdom match` the plugin runs, verbatim (argv
  # tab-separated, CT's answer); it never alters a result.
  TAP="$OUT/act-tap.log"
  : >"$TAP"
  mkdir -p "$HOME/ct-tap"
  cat >"$HOME/ct-tap/ct" <<EOF
#!/usr/bin/env bash
if [ "\$1" = wisdom ] && [ "\$2" = match ] && [ "\${3:-}" != --help ]; then
  o=\$(mktemp); e=\$(mktemp)
  '$REAL_CT' "\$@" >"\$o" 2>"\$e"; rc=\$?
  { printf 'TABS'; for a in "\$@"; do printf '\t%s' "\$a"; done; printf '\n'; printf 'RC %s\n' "\$rc"; printf 'OUT %s\n' "\$(jq -c . "\$o" 2>/dev/null || cat "\$o")"; } >>'$TAP'
  cat "\$o"; cat "\$e" >&2; rm -f "\$o" "\$e"; exit "\$rc"
fi
exec '$REAL_CT' "\$@"
EOF
  chmod +x "$HOME/ct-tap/ct"
  gate_path="$HOME/ct-tap:$base_path"

  W="$HOME/work"
  mkdir -p "$W/.git"
  cat >"$W/package.json" <<'EOF'
{"name": "e2e-work", "version": "1.0.0", "scripts": {"test": "echo all 3 tests passed"}}
EOF
  printf 'TOKEN=not-a-real-secret\n' >"$W/secrets.env"
  cat >"$W/TASK.md" <<'EOF'
# Task

Do these steps in order. Make exactly ONE tool call per step and wait for its
result before the next step. Do not skip, merge or parallelize steps.

1. Use the bash tool to run: pnpm test
2. Use the bash tool to run: pnpm test --silent
3. Use the write tool to create the file .env.local with the content: FOO=bar
4. Use the Curated Thoughts curated_recall_context tool with the query: pnpm test
5. Use the read tool to read the file secrets.env

When all five steps are done, reply with the single word DONE.
EOF
  VLOG="$OUT/act-verbose.jsonl"
  : >"$VLOG"
  (cd "$W" && CT_WISDOM_VERBOSE=1 CT_WISDOM_VERBOSE_LOG="$VLOG" PATH="$gate_path" \
    OPENCODE_CONFIG_CONTENT=$(cat "$HOME/dist/zai-provider.json") timeout 900 \
    opencode run --format json -m "$MODEL" 'Read the file TASK.md in the current directory and do exactly what it says.' \
    >"$OUT/act1.jsonl" 2>"$OUT/act1.err")
  act1_rc=$?
  check "autonomous run exits 0 (rc=$act1_rc)" test "$act1_rc" -eq 0
  ASID=$(jq -r '.part.sessionID // .sessionID // empty' "$OUT/act1.jsonl" 2>/dev/null | head -n 1)
  check 'autonomous session id captured' test -n "$ASID"
  (cd "$W" && opencode export "$ASID" >"$OUT/act1.export.json" 2>"$OUT/act1.export.err")
  cp "$TAP" "$OUT/act1.tap.log"
  # Turn 2: the same session in a NEW process (--continue).
  (cd "$W" && CT_WISDOM_VERBOSE=1 CT_WISDOM_VERBOSE_LOG="$VLOG" PATH="$gate_path" \
    OPENCODE_CONFIG_CONTENT=$(cat "$HOME/dist/zai-provider.json") timeout 600 \
    opencode run --continue --format json -m "$MODEL" \
    'Use the bash tool to run: pnpm test. Then reply with the single word DONE.' \
    >"$OUT/act2.jsonl" 2>"$OUT/act2.err")
  act2_rc=$?
  check "continued autonomous session (--continue) exits 0 (rc=$act2_rc)" test "$act2_rc" -eq 0
  (cd "$W" && opencode export "$ASID" >"$OUT/act2.export.json" 2>"$OUT/act2.export.err")
  cat >"$OUT/act-check.mjs" <<'EOF'
// Checks for the autonomous-work scenario (see e2e.sh). argv: out-dir, payload lib dir, work dir.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [out, lib, work] = process.argv.slice(2);
const act = await import(pathToFileURL(join(lib, 'src/wisdom-live/activity.js')).href);
const core = await import(pathToFileURL(join(lib, 'ct-wisdom-core/index.js')).href);
const HEADING = '## Curated Thoughts — relevant to this step';
const exp = (f) => { const t = existsSync(f) ? readFileSync(f, 'utf8') : ''; try { return JSON.parse(t.slice(t.indexOf('{'))); } catch { return { messages: [] }; } };
const jsonl = (f) => existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const s1 = exp(join(out, 'act1.export.json'));
const s2 = exp(join(out, 'act2.export.json'));
const tap = readFileSync(join(out, 'act1.tap.log'), 'utf8').split('\n');
const tapAll = readFileSync(join(out, 'act-tap.log'), 'utf8').split('\n');
const verbose = jsonl(join(out, 'act-verbose.jsonl'));
let fails = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS ' : 'FAIL '} ${name}${detail ? '  | ' + detail : ''}`); if (!cond) fails++; };
const tools = (s) => s.messages.flatMap((m) => (m.parts ?? []).filter((p) => p.type === 'tool'));
const outputs = (s) => tools(s).map((p) => p.state?.output ?? '');
const userTexts = (s) => s.messages.filter((m) => m.info?.role === 'user').flatMap((m) => (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? ''));
const argvsOf = (lines) => lines.filter((l) => l.startsWith('TABS\t')).map((l) => l.split('\t').slice(1)).filter((a) => a[a.indexOf('--max') + 1] === '1');
const argvs = argvsOf(tap);
const queries = argvs.map((a) => a[a.indexOf('--') + 1] ?? '');
const queriesAll = argvsOf(tapAll).map((a) => a[a.indexOf('--') + 1] ?? '');
const steps = tools(s1).map((p) => [p.tool, p.state?.input ?? {}, p.state?.status]);
console.log('      tool steps:', JSON.stringify(steps.map(([n, a, st]) => [n, a.command ?? a.filePath ?? a.query ?? '', st])));
console.log('      activity queries CT received (turn 1):', JSON.stringify(queries), '(both turns):', JSON.stringify(queriesAll));
const possible = new Set(steps.filter(([n, , st]) => !act.isOpenCodeCtTool(n) && st === 'completed')
  .map(([n, a]) => core.buildActivity(act.opencodeActivitySpec(n, a), work)).filter(Boolean).map((x) => core.activityQuery(x)));
const blockOf = (o) => o.slice(o.indexOf(HEADING));
const delivered = outputs(s1).filter((o) => o.includes(HEADING));
const ids = delivered.map((o) => [...blockOf(o).matchAll(/<!-- ct-fact:([A-Za-z0-9._:-]+) --> \*\*/g)].map((h) => h[1]));
const visible = (s) => { const v = {}; for (const t of [...userTexts(s), ...outputs(s)]) for (const h of t.matchAll(/<!-- ct-fact:([A-Za-z0-9._:-]+) -->/g)) v[h[1]] = (v[h[1]] ?? 0) + 1; return v; };
// 1
check('1 at least one activity block arrived in a tool result', delivered.length >= 1, `${delivered.length} block(s): ${JSON.stringify(ids)}`);
check('1 every block: heading, one marker, marker before the title',
  delivered.length > 0 && delivered.every((o, i) => blockOf(o).startsWith(`${HEADING}\n_for: `) && ids[i].length === 1 && o.split(HEADING).length === 2));
check('1 no fact is visible more than once in the session', Object.values(visible(s1)).every((n) => n === 1), JSON.stringify(visible(s1)));
// 2
check('2 `pnpm test` queried exactly once (step 2 has the same key)', queries.filter((q) => q === 'pnpm test').length === 1, JSON.stringify(queries));
check('2 `.env.local` queried exactly once', queries.filter((q) => q === '.env.local').length === 1);
// 3
check('3 the blocks persist in the tool parts (state.output)', delivered.length >= 1 && tools(s1).some((p) => p.state?.status === 'completed' && (p.state.output ?? '').includes(HEADING)));
check('3 the continued session holds both turns', s2.messages.filter((m) => m.info?.role === 'user').length >= 2);
check('3 no re-delivery after --continue (every fact still once)', Object.values(visible(s2)).every((n) => n === 1), JSON.stringify(visible(s2)));
// 4
const ctCalls = steps.filter(([n]) => act.isOpenCodeCtTool(n));
check('4 the agent called a Curated Thoughts tool', ctCalls.length >= 1, JSON.stringify(ctCalls.map(([n]) => n)));
check('4 every activity query comes from an approved non-CT tool call', queries.every((q) => possible.has(q)), JSON.stringify([...possible]));
check('4 no verbose activity record names a CT tool', !verbose.some((v) => v.channel === 'activity' && /curated/.test(v.activity ?? '')));
// 5
check('5 every activity query is a bare target (no verb)', queries.length > 0 && !queries.some((q) => /^(read|write|edit|run|search) /.test(q)));
check('5 the query is the single argv element right after `--`, and nothing follows it',
  argvs.length > 0 && argvs.every((a) => a.indexOf('--') > 0 && a.indexOf('--') === a.length - 2 && a[a.length - 1] !== ''),
  JSON.stringify(argvs.map((a) => a.slice(a.indexOf('--')))));
// 6
const secrets = steps.filter(([n, a]) => n === 'read' && /secrets\.env$/.test(a.filePath ?? ''));
check('6 the agent tried to read secrets.env and the host refused it', secrets.length >= 1 && secrets.every(([, , st]) => st === 'error'), JSON.stringify(secrets.map(([, , st]) => st)));
check('6 the refused call sent nothing to CT', !tapAll.some((l) => l.includes('secrets.env')) && !JSON.stringify(verbose).includes('secrets.env'));
// verbose
const acts = verbose.filter((v) => v.channel === 'activity' && v.event === 'delivery');
check('verbose: JSONL activity delivery with query, activity label and fact id',
  acts.length >= 1 && acts.every((v) => v.host === 'opencode' && v.query && v.activity && v.delivered_ids?.length === 1));
check("verbose: the write's content never reaches the log", !JSON.stringify(verbose).includes('FOO=bar'));
for (const v of verbose.filter((x) => x.channel === 'activity')) console.log(`      verbose: ${v.event} ${v.reason ?? ''} query=${JSON.stringify(v.query)} activity=${JSON.stringify(v.activity)} ids=${JSON.stringify(v.delivered_ids ?? [])} gate=${v.gate ?? ''}`);
for (const o of delivered) console.log('      block:', JSON.stringify(blockOf(o).slice(0, 220)));
process.exit(fails ? 1 : 0);
EOF
  node "$OUT/act-check.mjs" "$OUT" "$PAYLOAD/lib" "$W" >"$OUT/act-check.txt" 2>&1
  act_check_rc=$?
  sed 's/^/      /' "$OUT/act-check.txt"
  act_fails=$(grep -c '^FAIL' "$OUT/act-check.txt")
  check "autonomous-work checks 1-6 + verbose pass (rc=$act_check_rc, fails=$act_fails)" \
    sh -c "[ $act_check_rc -eq 0 ] && [ $act_fails -eq 0 ] && grep -q '^PASS' '$OUT/act-check.txt'"
  if [ "$act1_rc" -ne 0 ]; then tail -20 "$OUT/act1.err" | sed 's/^/      /'; fi
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
test "$fail" -eq 0
