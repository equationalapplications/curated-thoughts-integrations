# Implementation plan — Claude Code wisdom parity leg (claude-code 0.2.0)

**Spec:** `docs/superpowers/specs/2026-10-16-claude-code-wisdom-parity-leg-design.md`
**Parent:** `docs/superpowers/plans/2026-10-09-cross-harness-wisdom-parity-plan.md`, Task 4.
**Base:** `origin/fix/shared-env-doctor-parity` (PR #41). Run every test command from
`integrations/claude-code/` unless it says otherwise. TDD throughout: write the failing
test, watch it fail, implement, watch it pass.

## Task 1 — Vendor the Hermes core under the parity gate (D1)

1. `tests/tools/test_shared_script_parity.py`: add `ct_ledger.py`, `ct_wisdom.py`,
   `ct_wisdom_live.py` to `IDENTICAL`. Run `python -m unittest discover -s tests/tools -p
   'test_shared_script_parity.py'` at the repo root. It fails, because the files are missing.
2. `cp integrations/hermes/scripts/{ct_ledger,ct_wisdom,ct_wisdom_live}.py
   integrations/claude-code/scripts/`. The gate turns green.
3. `tools/ct_ci_policy.py`: add `ct_wisdom_cc` to `STDLIB_ALLOWLIST`, with a test in
   `tests/tools/test_ct_ci_policy_arch.py` (a shipped file importing `ct_wisdom_cc` is clean).

## Task 2 — Store, provenance, breaker (D3, D4, D5, D8 breaker)

`tests/test_wisdom_cc.py` (in-process; imports `hooks/ct_wisdom_cc.py` via `sys.path`):

* `StoreTests`: key derivation (UUID as-is, odd ids hashed), round-trip, corrupt and
  mismatched files ⇒ `None`, atomic replace, `exclude` ordering newest-first, 30-day prune.
* `ProvenanceTests`: genuine prompt accepted. Each rule-violation case ⇒ rejected:
  missing/empty `prompt_id`, `agent_id` present, `agent_type` alone accepted, empty prompt,
  `<agent-message from=…>`, `<task-notification>`, leading whitespace before a tag, and a
  prompt with an inline `<b>` mid-text still accepted.
* `BreakerTests`: 3 failures ⇒ open, reopen after 300 s, success resets, corrupt file ⇒
  closed.

Then implement `hooks/ct_wisdom_cc.py`: `data_dir(view)`, `Store` helpers,
`is_genuine_user_turn`, `PersistedBreaker`.

## Task 3 — SessionStart rules + bootstrap (D7)

Tests (`SessionStartRuleTests`) for every row of the D7 table, using a fake bootstrap renderer:
startup seeds/re-seeds; clear-unknown fresh; clear-known OFF; resume-existing OFF with no
re-emit; resume-none OFF with recorded fresh render; compact-on replays byte-identical
without touching the ledger; compact-off stays off; compact-none writes nothing; fork/unknown ⇒
OFF. The no-re-arm path: OFF then compact then UserPromptSubmit ⇒ still no delivery.

Implement `session_start(payload, env=None, render=None) -> str` (the bootstrap text to
append, or `""`). `render_bootstrap(view, cwd)` uses the vendored `discover_ct`,
`recall_wiki`, `query_for` and `render_block`. `hooks/session-start.py` appends its result
after the status section. Update `tests/test_hook.py`: put a fake `ct` on PATH in
`HookTestCase` so no real install is reached; add a subprocess test that the bootstrap block
appears and the store is seeded under a temp `CLAUDE_PLUGIN_DATA`.

## Task 4 — UserPromptSubmit delivery (D8) + PostToolUse rewrite (D9)

Tests: `DeliveryTests` (block emitted, store written before output, post-filter, corrections
only when superseding, session budget ⇒ `max_n = 0`, exclude cap 256 newest-first, lock not
held during match); `FailClosedTests` (AC 4: no store, corrupt store, OFF, capability
missing, probe timeout, breaker open; timeout/exit counts toward the breaker);
`ToolRewriteTests` (only `*__curated_recall_context`, never `curated_get_wiki_entry`; stubs
known ids; records new ids; no output when nothing stubbed; subagent pass-through;
OFF/no-store pass-through; non-JSON text untouched; dict-with-content shape);
`MarkerHygieneTests` (AC 5); `TranscriptNeverReadTests` (AC 3).

Implement `user_prompt_submit(payload, env=None)` and `post_tool_use(payload, env=None)`,
returning the directive dict or `None`, plus `main()` (stdin ⇒ dispatch ⇒ stdout, always
exit 0).

## Task 5 — Exactly-once property test (AC 2) + manifests (AC 6)

`tests/test_exactly_once_cc.py`: 200 seeded sessions. Random turns go through the real
adapter functions with patched `match_wisdom`/`recall_wiki`/discovery. Random `PostToolUse`
recalls, compact events (history before the boundary dropped, bootstrap replay appended),
`/clear` (new id ⇒ fresh; or forced same id ⇒ OFF), resume (OFF, history replayed). It
asserts that no fact id appears twice in the model's live context, and that nothing is
delivered after OFF.

`hooks/hooks.json`: SessionStart matcher adds `fork`, timeout 15; `UserPromptSubmit`
(timeout 15); `PostToolUse` matcher `mcp__.*__curated_recall_context` (timeout 10). All use
the same `python3 … || python …` command shape. `tests/test_hook.py` `HooksManifestTests`
are updated. Bump `integration.yaml` and `plugin.json` to 0.2.0 and update the
`plugin.json` description. Add the CHANGELOG `## 0.2.0 — 2026-10-16` section (above 0.1.2),
and add a README "Intuitive Wisdom" section.

## Task 6 — Verify + live e2e (AC 10)

* `python -m unittest discover -s tests` (claude-code), `python -m unittest discover -s
  tests/tools` (repo root), `ruff check --select E9,F63,F7,F82,F401 .` (root + claude-code),
  `python tools/ct_ci.py validate`, `policy`, `generate --check`, `readme --check`.
* Live: the isolated `claude` 2.1.301 harness under the scratchpad (temp `HOME` +
  `CLAUDE_CONFIG_DIR`, ZAI endpoint, `GLM-5.3-FLASH`), loading this plugin with
  `--plugin-dir`. A `ct` test wrapper (identity `--help`, `recall`, `wisdom match` returning
  fixed facts) stands in, because there is no local CT relevance gate. The MCP recall server
  is a stdio fake (no embedder locally). Everything else is real: the hooks, the store, the
  host. Check: startup bootstrap seeded; turn 1 delivers fact A; turn 2 does not re-deliver
  A; a recall tool result containing A is stubbed; resume ⇒ no delivery; `/compact` ⇒
  continues without re-delivery; `/clear` ⇒ new id, fresh.

## Task 7 — Commit, push, PR

Commit `feat(claude-code): intuitive wisdom live delivery (0.2.0)` (plus a docs commit for
the spec and plan), push, and open a PR against `fix/shared-env-doctor-parity`. Do not merge
or tag.
