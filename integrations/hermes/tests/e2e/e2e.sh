#!/usr/bin/env bash
# e2e.sh — Hermes autonomous-work wisdom delivery, end to end (runs INSIDE the
# ct-hermes-e2e container; see run.sh). Spec:
# docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md.
#
# One user message makes the agent work on its own (it reads TASK.md and does
# five tool steps). CT's REAL relevance gate decides: CT 3.5.1 with
# qwen/qwen3-embedding-4b (OpenRouter) under the instr1 scheme, the only
# calibrated embedder. Facts are seeded with `ct wisdom deposit` (CT's own
# agent write path; the Librarian runs on ZAI GLM-5.3-FLASH). A transparent
# `ct` tap first on PATH records every `ct wisdom match` argv and CT's answer;
# it never alters a result. Verbose mode is on (CT_WISDOM_VERBOSE=1).
#
# Checks:
#   1. an activity block arrives in a tool result, exactly once, with its marker;
#   2. a later step on the same activity key neither re-queries nor re-delivers;
#   3. a write_file result carries the spliced JSON key and Hermes's own write
#      verifier still says the write landed;
#   4. CT's own tools never trigger a query;
#   5. every activity query CT receives is the bare target;
#   plus verbose mode: the stderr notice and the JSONL line for a delivery.
set -uo pipefail
OUT=/home/tester/out
mkdir -p "$OUT"
export HERMES_HOME="$HOME/hermes-home"
export CURATED_VAULT_ROOT="$HOME/vault"
section() { printf '\n== %s ==\n' "$*"; }
# Setup must not fail silently: a broken step would make later checks vacuous.
die() { echo "FAIL  setup: $*"; echo 'RESULT FAIL (setup)'; exit 1; }

section 'scratch brain: onboard, migrate, real-gate config'
printf '1\n0\n1\n' | curated-thoughts-mcp --onboard --vault "$HOME/vault" --force >"$OUT/onboard.log" 2>&1
curated-thoughts-mcp >"$OUT/migrate.log" 2>&1 || true
test -s "$HOME/.brain/brain.db" || die 'brain.db was not migrated'
cfg="$HOME/.brain/config.json"
# The Librarian's generation block has no env fallback, so the key is written
# into this throwaway container's brain config for the deposits only, then
# removed. The embedding key stays in the environment. jq reads the key as
# env.ZAI_API_KEY, so it never appears in a process argument vector.
jq '
  .embed_profile = {type: "external", base_url: "https://openrouter.ai/api/v1", model: "qwen/qwen3-embedding-4b"}
  | .generation = {provider: "external", external_url: "https://api.z.ai/api/coding/paas/v4",
                   model_name: "GLM-5.3-FLASH", api_key: env.ZAI_API_KEY, model_path: null, timeout_secs: 120}' \
  "$cfg" >"$cfg.tmp" || die 'brain config edit'
mv "$cfg.tmp" "$cfg" || die 'brain config write'
deposit() { # deposit <slug> <title> <body>
  ct wisdom deposit --yes --path "immutable-source-files/agents/e2e/$1.md" \
    --title "$2" --body "$3" >>"$OUT/deposit.log" 2>&1 || die "deposit $1 (see deposit.log)"
  echo "deposit $1 ok"
}
# Facts whose words the bare targets share (A6), plus distractors.
deposit pnpm 'Run pnpm test before every commit' \
  'In this repository, always run pnpm test before committing. CI rejects pushes when pnpm test fails.'
deposit envlocal '.env.local holds local secrets and is never committed' \
  'The .env.local file holds local-only secrets. Never commit .env.local; it is listed in .gitignore.'
deposit tire 'Fleet tire pressure is 42 psi' \
  'The fleet tire pressure for all e2e fleet vehicles is 42 psi, checked cold every Monday.'
deposit freeze 'Production deploy freeze starts Friday 15:00' \
  'Production deploys are frozen from Friday 15:00 until Monday 09:00 local time.'
ct wisdom scheme activate instr1 >>"$OUT/deposit.log" 2>&1 || die 'scheme activate instr1'
ct wisdom scheme status | tee "$OUT/scheme.txt"
grep -q '^active read scheme: instr1' "$OUT/scheme.txt" || die 'instr1 is not the active read scheme'
jq 'del(.generation.api_key)' "$cfg" >"$cfg.tmp" || die 'brain config key removal'
mv "$cfg.tmp" "$cfg" || die 'brain config write'

section 'direct real-gate probes'
for q in 'pnpm test' '.env.local' 'TASK.md'; do
  printf '%s\t%s\n' "$q" "$(ct wisdom match --json --max 1 -- "$q" 2>/dev/null \
    | jq -c '{gate, entries: [.entries[] | {score, title}]}')"
done | tee "$OUT/probes.tsv"

section 'ct tap'
real_ct=$(command -v ct)
TAP="$OUT/tap.log"; : >"$TAP"
mkdir -p "$HOME/ct-tap"
cat >"$HOME/ct-tap/ct" <<EOF
#!/usr/bin/env bash
# e2e tap: exec the real ct; record wisdom-match traffic only. Never alters it.
if [ "\$1" = wisdom ] && [ "\$2" = match ] && [ "\${3:-}" != --help ]; then
  o=\$(mktemp); e=\$(mktemp)
  '$real_ct' "\$@" >"\$o" 2>"\$e"; rc=\$?
  { printf 'ARGV'; for a in "\$@"; do printf '\t%s' "\$a"; done; printf '\n'
    printf 'OUT\t%s\n' "\$(jq -c '{gate, entries: [.entries[] | {id, score, title}]}' "\$o" 2>/dev/null || cat "\$o")"; } >>'$TAP'
  cat "\$o"; cat "\$e" >&2; rm -f "\$o" "\$e"; exit "\$rc"
fi
exec '$real_ct' "\$@"
EOF
chmod +x "$HOME/ct-tap/ct"
export PATH="$HOME/ct-tap:$PATH"
echo "tap installed in front of $real_ct"

section 'scratch Hermes profile + plugin install'
mkdir -p "$HERMES_HOME"
# The MCP server gets the embedding key through Hermes's ${VAR} substitution
# (resolved at connect time); the literal placeholder is what is on disk.
cat >"$HERMES_HOME/config.yaml" <<'EOF'
model:
  default: GLM-5.3-FLASH
  provider: zai
plugins:
  enabled:
    - curated-thoughts
mcp_servers:
  curated-thoughts:
    command: curated-thoughts-mcp
    args: ["--mcp"]
    env:
      OPENROUTER_API_KEY: "${OPENROUTER_API_KEY}"
EOF
bash /home/tester/plugin/scripts/install.sh >"$OUT/install.log" 2>&1 || die 'plugin install (see install.log)'
test -f "$HERMES_HOME/plugins/curated-thoughts/__init__.py" || die 'plugin files not installed'
echo 'install ok'

section 'workspace'
W="$HOME/work"; mkdir -p "$W"; cd "$W" || exit 1
cat >package.json <<'EOF'
{"name": "e2e-work", "version": "1.0.0", "scripts": {"test": "echo all 3 tests passed"}}
EOF
cat >TASK.md <<'EOF'
# Task

Do these steps in order. Make exactly ONE tool call per step and wait for its
result before the next step. Do not skip, merge or parallelize steps.

1. Use the terminal tool to run: pnpm test
2. Use the terminal tool to run: pnpm test --silent
3. Use the write_file tool to create the file .env.local with the content: FOO=bar
4. Use the read_file tool to read the file .env.local
5. Use the Curated Thoughts curated_recall_context tool with the query: pnpm test

When all five steps are done, reply with the single word DONE.
EOF

section 'run: ONE user message, autonomous work, CT_WISDOM_VERBOSE=1'
export GLM_BASE_URL=https://api.z.ai/api/coding/paas/v4
export CT_WISDOM_VERBOSE=1
# `hermes chat -q` on non-TTY stdio answers and exits. (`hermes -z` sends
# stderr to /dev/null, which would hide the verbose notice.)
timeout 900 hermes chat -q 'Read the file TASK.md in the current directory and do exactly what it says.' \
  </dev/null >"$OUT/hermes.out" 2>"$OUT/hermes.err"
echo "hermes rc=$?"
cp "$HERMES_HOME/logs/ct-wisdom-verbose.jsonl" "$OUT/verbose.jsonl" 2>/dev/null || : >"$OUT/verbose.jsonl"

/opt/hermes/.venv/bin/python - "$HERMES_HOME/state.db" "$OUT/transcript.json" <<'PY'
import json, sqlite3, sys
con = sqlite3.connect(sys.argv[1])
cols = [r[1] for r in con.execute("pragma table_info(messages)")]
keep = ("role", "tool_name", "tool_call_id", "tool_calls", "content", "api_content")
rows = [{k: v for k, v in zip(cols, r) if k in keep}
        for r in con.execute("select * from messages order by rowid")]
json.dump(rows, open(sys.argv[2], "w"), indent=1, default=str)
PY

section 'checks'
/opt/hermes/.venv/bin/python - "$OUT" "$W" <<'PY'
import json, os, re, sys
sys.path.insert(0, "/opt/hermes")
from agent.tool_result_classification import file_mutation_result_landed

out, work = sys.argv[1], sys.argv[2]
rows = json.load(open(os.path.join(out, "transcript.json")))
tap = [line.rstrip("\n").split("\t") for line in open(os.path.join(out, "tap.log"))]
argvs = [t[1:] for t in tap if t[0] == "ARGV"]
answers = [json.loads(t[1]) for t in tap if t[0] == "OUT"]
verbose = [json.loads(l) for l in open(os.path.join(out, "verbose.jsonl")) if l.strip()]
stderr = open(os.path.join(out, "hermes.err"), encoding="utf-8", errors="replace").read()
KEY = "curated_thoughts_wisdom"
HEADING = "## Curated Thoughts — relevant to this step"
fails = 0

def check(name, cond, detail=""):
    global fails
    print(("ok    " if cond else "FAIL  ") + name + (("  | " + detail) if detail else ""))
    fails += 0 if cond else 1

def calls():
    """(tool_name, args, tool result content) in order."""
    pending = {}
    seq = []
    for r in rows:
        if r.get("role") == "assistant" and r.get("tool_calls"):
            tcs = json.loads(r["tool_calls"]) if isinstance(r["tool_calls"], str) else r["tool_calls"]
            for tc in tcs:
                fn = tc.get("function", {})
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except ValueError:
                    args = {}
                pending[tc.get("id")] = (fn.get("name"), args)
        elif r.get("role") == "tool":
            name, args = pending.get(r.get("tool_call_id"), (r.get("tool_name"), {}))
            seq.append((r.get("tool_name") or name, args, r.get("content") or ""))
    return seq

def block_ids(text):
    return re.findall(r"<!-- ct-fact:([A-Za-z0-9._:-]+) --> \*\*", text)

seq = calls()
print("tool steps:", [(n, (a.get("command") or a.get("path") or a.get("query") or "")) for n, a, _ in seq])
activity_argv = [a for a in argvs if "--max" in a and a[a.index("--max") + 1] == "1"]
queries = [a[-1] for a in activity_argv]
print("activity queries CT received:", queries)

# visible fact counts across the whole current context
visible = {}
for r in rows:
    text = (r.get("api_content") or "") + "\n" + str(r.get("content") or "")
    for fid in block_ids(text) + re.findall(r"ct-fact:([A-Za-z0-9._:-]+) \(provenance", text):
        visible[fid] = visible.get(fid, 0) + 1
delivered = [(n, a, c, block_ids(c)) for n, a, c in seq if HEADING in c]

# 1. an activity block in a tool result, exactly once, with the marker
check("1 at least one activity block arrived in a tool result", bool(delivered),
      ", ".join("%s:%s" % (n, ids) for n, _, _, ids in delivered))
check("1 every activity block carries exactly one ct-fact marker before its fact",
      all(len(ids) == 1 for *_, ids in delivered))
check("1 no delivered fact is visible more than once in context",
      all(visible.get(i, 0) == 1 for *_, ids in delivered for i in ids), json.dumps(visible))

# 2. same key later: no re-query, no re-delivery
term = [(a, c) for n, a, c in seq if n == "terminal"]
reads_env = [(a, c) for n, a, c in seq if n == "read_file" and str(a.get("path", "")).endswith(".env.local")]
check("2 `pnpm test` was queried exactly once (step 2, same key, did not re-query)",
      queries.count("pnpm test") == 1, "queries=%s" % queries)
check("2 the second terminal step (same key) carries no block",
      len(term) >= 2 and HEADING not in term[1][1])
check("2 `.env.local` queried once though written then read (same key)",
      queries.count(".env.local") == 1 and bool(reads_env) and all(HEADING not in c for _, c in reads_env))

# 3. write_file result: spliced key, Hermes still sees the write as landed
writes = [c for n, a, c in seq if n == "write_file"]
w = writes[0] if writes else ""
try:
    wd = json.loads(w)
except ValueError:
    wd = {}
check("3 write_file result is valid JSON with the spliced key", KEY in wd, w[:120])
check("3 Hermes's write verifier: file_mutation_result_landed(write_file) is True",
      bool(w) and file_mutation_result_landed("write_file", w))
on_disk = open(os.path.join(work, ".env.local")).read() if os.path.exists(os.path.join(work, ".env.local")) else None
check("3 the file landed on disk with the requested content", on_disk is not None and on_disk.strip() == "FOO=bar")

# 4. CT's own tools never trigger a query
ct_steps = [n for n, a, c in seq if "curated" in (n or "")]
check("4 the agent called a Curated Thoughts tool", bool(ct_steps), str(ct_steps))
check("4 no activity query besides the three expected targets (none from CT tools)",
      sorted(set(queries)) == [".env.local", "TASK.md", "pnpm test"] and len(queries) == 3,
      "queries=%s" % queries)
check("4 no verbose activity record names a CT tool",
      not any("curated" in (v.get("activity") or "") for v in verbose if v.get("channel") == "activity"))

# 5. the query is the bare target
check("5 every activity query is a bare target (no verb, no extra tokens)",
      all(q in ("TASK.md", "pnpm test", ".env.local") for q in queries)
      and not any(re.match(r"^(read|write|edit|run|search) ", q) for q in queries))
check("5 the argv puts the query after `--`", all(a[-2] == "--" for a in activity_argv))

# verbose mode
acts = [v for v in verbose if v.get("channel") == "activity" and v.get("event") == "delivery"]
check("verbose: stderr notice for an activity delivery", "[activity]" in stderr and "delivered 1 fact" in stderr)
check("verbose: JSONL delivery line with query, activity label and fact id",
      bool(acts) and all(v.get("query") and v.get("activity") and v.get("delivered_ids") for v in acts))
check("verbose: the write's content never reaches the log", "FOO=bar" not in json.dumps(verbose))
if acts:
    shown = dict(acts[0]); shown.pop("matched", None); shown["block"] = shown.get("block", "")[:80] + "..."
    print("      verbose JSONL (activity delivery):", json.dumps(shown, ensure_ascii=False))
for line in stderr.splitlines():
    if line.startswith("Curated Thoughts wisdom:"):
        print("      stderr:", line)
print("RESULT", "PASS" if fails == 0 else "FAIL (%d)" % fails)
sys.exit(1 if fails else 0)
PY
