# Changelog — Claude Code integration

All notable changes to `integrations/claude-code/` are recorded here. This file
is the source of the GitHub Release body for every `claude-code-v*` tag, so the
heading format below is load-bearing: `## <version> — <date>`.

## Unreleased

## 0.4.1 — 2026-10-17

- Shared-builder update (the byte-identical copy of Hermes's
  `ct_wisdom_activity.py`, hermes 0.7.0). This integration uses only its
  activity builder and block renderer, so the one behavior change here is:
  `python -mpytest` and `python -umpytest` (the module attached to `-m`) now
  send `python pytest`, as `python -m pytest` always did; before, they sent
  `python` alone. The rest is internal: project packages are `stat`ed before
  any directory listing, the homes inside a project are computed once per
  project root, and a redundant second name check on the sent `python
  <module>` string is gone (the module itself is still checked). The
  Hermes-only hook changes (the query now starts after Hermes's approval
  decision) do not run here.

## 0.4.0 — 2026-10-17

- Added: **autonomous-work delivery** (Intuitive Wisdom step 3). While the
  agent works on its own, a `PostToolBatch` hook runs once per model step:
  when the step's first new file, command or search differs from what this
  agent already did, it asks `ct wisdom match --max 1` with only the bare
  target (a project-relative path, a search pattern, or a program plus a
  known subcommand, built by the shared Hermes builder under its privacy
  rules) and appends at most one fact (600 chars, marker first) after the
  step's tool results as `additionalContext`, under
  `## Curated Thoughts — relevant to this step`. The block is persisted and
  replayed on resume; the system prompt is never touched. CT's own tools
  never trigger it, and there is no per-message or per-session cap.
- Added: only calls that really ran can trigger it. New `PostToolUse` and
  `PostToolUseFailure` hooks for `Read`, `Write`, `Edit`, `MultiEdit`,
  `NotebookEdit`, `Bash`, `Grep` and `Glob` record each executed call; a call
  you (or a rule or hook) denied is in the batch but never becomes a query.
- Changed: **subagents** now get autonomous-work facts (they still get no
  per-message facts). The main thread and its subagents share one record of
  delivered facts, so a fact reaches at most one context of a session tree;
  a CT recall in a subagent is recorded and stubbed only against that
  subagent's own facts.
- The resume/fork OFF latch covers autonomous-work delivery, subagents
  included; `/compact` keeps delivering without repeats.
- A started query that got no genuine answer (CT missing, a timeout, the
  9 s budget) frees its key for a later step; CT's "nothing relevant" does
  not. The `ct` location and capability are cached for 24 h in
  `${CLAUDE_PLUGIN_DATA}/wisdom/ct.json`.
- Verbose mode records each autonomous-work decision with
  `channel: "activity"` and shows it as the hook's `systemMessage`.
- `scripts/ct_wisdom_activity.py` is a byte-identical copy of the Hermes
  0.6.9 module (parity-gated); `hooks/ct_wisdom_cc_activity.py` maps Claude
  Code tool names onto it. Session stores from 0.3.x keep working.

## 0.3.3 — 2026-10-17

- Fixed: the session-store prune deleted `.lock` files by age while
  another hook process could hold (or be about to take) their `flock`, so
  two processes could each hold an "exclusive" lock on different inodes and
  parallel `PostToolUse` hooks could interleave store writes. Now a lock
  file is removed only when its session store is gone and a non-blocking
  lock on it succeeds (it is unlinked while held), and `locked()` re-checks
  after locking that its file is still the one at the path, retrying if
  not. Prune also removes stale `*.tmp` files older than a day, and runs at
  most once a day. The store, lock, prune and persisted-breaker primitives
  moved to `hooks/ct_hook_store.py`, shared byte-identically with the
  Docker Agent integration (parity-gated). `scripts/ct_wisdom_live.py`
  gains an optional marker-first layout (shared with Hermes; unused here).
  No other behavior change.
- Fixed: doctor check 6 (`embedding-backend`) now also accepts
  `EMBED_API_KEY` and `OPENROUTER_API_KEY`, the names the external-embedder
  contract (check 6b, `ct_env.external_embed_key_var`) uses. A valid
  OpenRouter setup no longer gets a false "no embedding API key" warning.

## 0.3.2 — 2026-10-16

- Added: doctor check `sidecar-env` (after `embedding-backend`), shared with
  Hermes. Claude Code starts a stdio MCP server with its whole environment
  (verified in the 2.1.301 build), so this check only warns when the brain's
  external-embedder key (`EMBED_API_KEY`, else `OPENROUTER_API_KEY` or
  `OPENAI_API_KEY`) or a non-default brain location is missing from that
  environment. With `CLAUDE_CODE_MCP_ALLOWLIST_ENV` on, Claude Code passes
  only a short default list, and the check prints the `"env"` keys to add to
  the `mcpServers.curated-thoughts` entry as `${NAME:-}` references. It
  prints names only, never values. `scripts/ct_env.py` gains the shared
  `sidecar_env_needs` helper.

## 0.3.1 — 2026-10-16

- Changed: the vendored `scripts/ct_ledger.py` gains
  `LedgerCache.claim()`, an atomic check-and-add, kept byte-identical with
  the Hermes reference (shared-script parity gate). No behavior change:
  Claude Code's hooks do not call it. It is there for Claude Code's later
  autonomous-work leg (Hermes 0.6.0 uses it).
- Changed: the vendored `scripts/ct_wisdom_verbose.py` records an optional
  `activity` field when an event carries one (Hermes autonomous-work
  delivery). Claude Code's events never do, so its log is unchanged.

## 0.3.0 — 2026-10-16

- Added: Verbose mode for Intuitive Wisdom (opt-in, off by default). With
  `CT_WISDOM_VERBOSE=1`, every live-delivery decision is recorded: the
  delivered block with its fact ids, titles, provenance and CT's scores, or
  the reason nothing was delivered (`deduped`, `no_match`,
  `gate_uncalibrated`, `budget`, `breaker_open`, a timeout, ...). It goes to a
  local JSON Lines log (`CT_WISDOM_VERBOSE_LOG` overrides the path) and to a
  channel the user sees and the model does not. Verbose output never changes
  the system prompt, the delivered block or any tool result; with verbose off
  the hooks behave and return exactly as before (tests compare both).
  Spec: `docs/superpowers/specs/2026-10-16-wisdom-verbose-mode-design.md`.
  On Claude Code the notice is the `UserPromptSubmit` hook's top-level
  `systemMessage`, shown in the transcript ("… says: Curated Thoughts
  wisdom: …") and never sent to the model (verified in Claude Code 2.1.301).
  The log is `${CLAUDE_PLUGIN_DATA}/wisdom/ct-wisdom-verbose.jsonl`. Reader:
  `python3 scripts/ct_wisdom_log.py --host claude-code [-n N] [-f]` (outside
  a hook it finds the log under `~/.claude/plugins/data/curated-thoughts*/`).
  `additionalContext` is byte-identical with verbose on or off.
- Changed: the shared `scripts/ct_wisdom_live.py` keeps CT's `gate` and
  `score` for the log (never rendered).

## 0.2.1 — 2026-10-16

- Changed: Intuitive Wisdom live delivery has no per-session cap. The
  `UserPromptSubmit` hook no longer drops to `--max 0` after 12 live facts
  (`hooks/ct_wisdom_cc.py`), and `LIVE_MAX_PER_SESSION` is gone from the
  shared `scripts/ct_wisdom_live.py`; every turn asks `ct wisdom match --max 2`.
  The session store's `live_ids` list stays: it is part of the ledger.
  Why: an autonomous agent is better served by more wisdom than less. The
  cap stopped delivery after about 6 matching turns, though a fact that
  matches late in a session is as valuable as an early one. Noise stays
  bounded per turn (at most 2 facts in a 1200-character block, only facts
  past CT's relevance gate), delivery never touches the system prompt, and
  dedup keeps the session total to the distinct facts that match.
  Unchanged: the per-turn limits, CT's score gate, dedup and exactly-once
  delivery, the breaker, timeouts and the 256-id exclude bound.

## 0.2.0 — 2026-10-16

- Added: **Intuitive Wisdom** for Claude Code, a port of the Hermes 0.4.x
  live-delivery algorithm (cross-harness parity spec, decision 4; leg spec
  `2026-10-16-claude-code-wisdom-parity-leg-design.md`). CT ≥ 3.3.0
  (`ct wisdom match`) is required for live delivery. On older CT, or with no
  CT at all, it is a silent no-op.
  - **Bootstrap block** at `SessionStart`: after the status section comes a
    `## Curated Thoughts — relevant memory` block (Hermes v1 render, with
    `ct-fact:<id>` markers). Its ids seed a per-session store in
    `${CLAUDE_PLUGIN_DATA}/wisdom/sessions/`.
  - **Live delivery** at `UserPromptSubmit`: at most 2 facts per turn and 12
    per session (corrections exempt), in a 1,200-char block, appended as
    `additionalContext`. The system prompt is never touched. Delivery happens
    only on genuine main-thread user turns: a background-agent report
    (`<agent-message …>`), any prompt that opens with a harness envelope tag,
    a missing `prompt_id`, or a subagent (`agent_id`) is skipped.
  - **Dedup stubs** at `PostToolUse`, on `mcp__*__curated_recall_context`
    only (never `curated_get_wiki_entry`). A wiki entry whose id is already
    in this session's context is replaced by a one-line stub through
    `updatedToolOutput`, in the same MCP content-block shape.
  - **Exactly-once ledger** = the plugin-data store, never the transcript.
    `/compact` continues, with no re-delivery, and the stored bootstrap block
    is replayed. `--resume`/`/resume`/`--continue` and forked sessions turn
    live delivery OFF for the life of the session (the bootstrap is
    untouched). `/clear` starts a new session id on Claude Code 2.1.301, so it
    is a fresh session. A `/clear` that kept its id would latch OFF too.
  - A persisted circuit breaker (3 timeouts/exits ⇒ 300 s pause). The `ct`
    calls are bounded at 3 s each.
- Added: `scripts/ct_ledger.py`, `scripts/ct_wisdom.py`,
  `scripts/ct_wisdom_live.py`, byte-identical copies of the Hermes core,
  held identical by `tests/tools/test_shared_script_parity.py`. The adapter
  is `hooks/ct_wisdom_cc.py`.
- Changed: `hooks/hooks.json` registers `UserPromptSubmit` (15 s) and
  `PostToolUse` (10 s). The `SessionStart` matcher gains `fork`, and its
  timeout goes from 10 s to 15 s for the bootstrap recall.

## 0.1.2 — 2026-10-16

- Fixed: `scripts/ct_doctor.py` re-synced with the Hermes doctor post-#14
  (issue #33). `run_checks(env=...)` now discovers the sidecar and resolves
  the brain, vault, embedding and engine-manifest checks through the
  caller's env merged over `os.environ` (previously discovery and checks
  4/5/6/8 read the ambient process env only, so a caller-supplied PATH could
  be ignored and the real installed sidecar spawned against a test brain).
  Adds the issue #28 bundled-fallback gate (refuse to spawn an ambient
  install when the caller's PATH override fails to resolve;
  `CT_DOCTOR_ALLOW_BUNDLED=1` opts out) and derives the MCP `clientInfo`
  version from `.claude-plugin/plugin.json` instead of a stale literal.
  Check 7 (Claude Code registration) is unchanged.
- Changed: `ct_env.py`, `ct_status.py`, `ct_preflight.py` are byte-identical
  to Hermes, gaining `ct_env.merged_env(env=None)` and the `SOURCE_*`
  discovery constants; `ct_status.snapshot(env=...)` now merges `env` over
  `os.environ` instead of replacing the view (issue #32 — no shipped caller
  passes `env`). A repo-level parity gate
  (`tests/tools/test_shared_script_parity.py`) now fails CI on any drift
  outside the doctor's marked harness-specific regions.
- Tests: the `SCRUBBED_PATH` workaround is gone — the POSIX mock sidecar is
  a `/bin/sh` shim exec'ing the absolute interpreter, so a bare mock-dir
  PATH suffices, and a setUp precondition fails the suite if discovery does
  not resolve the mock. Env-view and #28 gate tests ported from Hermes.
- Fixed (packaging): release tarballs no longer pick up `.ruff_cache/` and
  other tool caches (issue #33).

## 0.1.1 — 2026-10-09

- Sync `skills/usage/SKILL.md` with Hermes: the `## Wisdom that arrives on
  its own` section shipped to Hermes's `curated-thoughts-usage` skill in the
  0.4.0 live-delivery work (PR #35) was missing from this port, so both
  parity tests in `tests/test_skills_content.py` failed. The section is
  added verbatim; the ops cross-reference keeps the `/curated-thoughts:ops`
  spelling per the parity test's normalization rule 3.

## 0.1.0 — 2026-09-11

- Scaffold the Claude Code plugin: `.claude-plugin/plugin.json` (plugin name
  `curated-thoughts`), the `integration.yaml` CI contract with
  `version_mirror: .claude-plugin/plugin.json#version`, and manifest tests that
  keep the two from drifting.
- Add the shared stdlib-only scripts, copied from `integrations/hermes/` and
  kept logically identical: `ct_env.py` (brain/vault/sidecar resolution),
  `ct_status.py` (session-start snapshot) and `ct_preflight.py` (read-only
  import pre-flight census). `status` flips to `implemented`, so the
  integration now generates `scripts/_compat_generated.py` from
  `shared/compat.yaml` and appears as implemented in the README table.
- Add `scripts/ct_doctor.py`, the read-only install/health doctor, copied from
  `integrations/hermes/` with checks 1-6, 8 and 9 unchanged. Check 7 is the one
  harness-specific check: `claude-code-registration` reads the JSON config
  Claude Code writes (`~/.claude.json`, honored through `CLAUDE_CONFIG_DIR`
  for the directory, or the test-only `CLAUDE_CONFIG_PATH` for the single
  file) plus the local-scope `projects[<cwd>].mcpServers` and a
  project-scope `.mcp.json`, and reports plugin enablement from
  `~/.claude/settings.json` (also relocatable through `CLAUDE_CONFIG_DIR`,
  or the test-only `CLAUDE_SETTINGS_PATH`) as a WARN-only note, because a
  `--plugin-dir` install leaves nothing on disk to verify.
- Add the SessionStart hook: `hooks/hooks.json` registers
  `hooks/session-start.py` for the `startup|resume|clear|compact` sources with
  a 10s timeout, invoked as `python3 ... || python ...` so one manifest works
  on Windows and POSIX. The script is adapted from `integrations/hermes/` —
  same stdin drain, fail-open and always-exit-0 discipline — and emits Claude
  Code's `hookSpecificOutput` / `additionalContext` envelope instead of
  Hermes's bare `context` key. It resolves the scripts directory from
  `__file__`, never from `CLAUDE_PLUGIN_ROOT`: the manifest already
  substitutes `${CLAUDE_PLUGIN_ROOT}` into the hook's invocation path (shell
  syntax), so `__file__` carries the same information and remains correct
  under direct execution too. `CLAUDE_PLUGIN_ROOT` is read by nothing in the
  integration, and the repo-wide guard against reading it stays green without
  editing anything under `integrations/hermes/` (spec §11 Q6, resolved by
  design).
- Add `scripts/install.sh`, the registration helper. Per design decision D1 it
  copies nothing — a Claude Code plugin loads in place — and registers the
  sidecar by absolute path through `claude mcp add --scope user`, not through a
  plugin-shipped `.mcp.json`, which could only name `curated-thoughts-mcp` and
  rely on PATH. It resolves the sidecar with the same search order and the same
  candidate list as `scripts/ct_env.py` (both Windows locations included,
  `CLAUDE_CT_SIDECAR` honoured), double-quotes the path everywhere it is
  printed because the Windows install directory contains a space, prints the
  registration as both a CLI command and a JSON block, prints the
  `claude --plugin-dir` line, and ends with the doctor next step. A missing
  sidecar is a WARN plus a placeholder block, never a failure. The script
  never edits `~/.claude.json` itself: under `CT_INSTALL_EDIT=1` it checks
  `claude mcp get` first and shells out to `claude mcp add` only when no entry
  exists, so an existing registration is never overwritten.
- Add `tests/test_install.py`. The text tests — candidate-list parity with
  `ct_env.py`, "copies nothing", the `CLAUDE_CT_SIDECAR` override name, no
  direct config writes — inspect the script and run on every OS. The
  subprocess tests run it under bash against tempdirs and are skipped on
  Windows, as in `integrations/hermes/`, because CI's Windows runner has no
  bash. `CT_INSTALL_EDIT=1` is exercised only against a fake `claude` shim on
  a temp PATH that logs its argv, never the real binary.
- Make the doctor tests hermetic on all three OSes, so a developer with
  Curated Thoughts installed gets a green suite (the upstream issue #14 class
  of bug). Two leaks, one per platform family. On Windows the mock sidecar was
  an extensionless `#!` script that `shutil.which` cannot resolve, so
  `ct_env.find_sidecar()` fell through to the bundled candidates, found the
  real `curated-thoughts-mcp.exe` and spawned it against the fixture brain —
  the V18 repair migration then wrote `.brain/repair-export-186/` into the
  fixture home and `FullRunTests.test_doctor_is_read_only` caught it. The
  fixture now writes a `curated-thoughts-mcp.bat` shim next to the Python
  mock, which `shutil.which` resolves via PATHEXT and Windows can execute. On
  POSIX `which` always resolved the shebang mock, but a developer with the
  sidecar in `/usr/bin` still had it on the PATH tail, so `DoctorTestCase`
  now also scrubs every PATH entry that holds a real `curated-thoughts-mcp`
  and patches the *process* PATH, not just the env dict passed to
  `run_checks` — discovery calls `find_sidecar()` with no env and reads
  `os.environ` directly. `tests/test_ct_doctor.py` goes from
  `FAILED (failures=5, skipped=13)` to `OK (skipped=2)`; only the two
  POSIX-absolute-candidate-path assertions stay skipped on Windows. No
  shipped script changed.
- Add the three skills: `skills/usage/`, `skills/ops/` and `skills/sidecar/`.
  Per design decision D2 the directories are the bare names and the
  frontmatter `name` key is dropped, because Claude Code namespaces plugin
  skills as `/<plugin>:<skill>` and falls back to the directory name — keeping
  Hermes's `curated-thoughts-*` directories would have produced
  `/curated-thoughts:curated-thoughts-usage`. `description` stays; it is what
  drives skill selection. Bodies are verbatim from `integrations/hermes/`
  except for three regions: doctor-check list item 7 and the whole
  "Registration in Hermes" section, both rewritten for Claude Code
  (`~/.claude.json` `mcpServers`, `claude mcp add --scope user`, `/mcp` to
  verify, `--plugin-dir` or a marketplace for the plugin), and the
  cross-reference to the ops skill, which now names `/curated-thoughts:ops` —
  the name a user can actually type here.
- Add `tests/test_skills_content.py`, ported from deepseek's
  `test_skills_content.ts`. It asserts each body is byte-identical to its
  Hermes original after normalizing away exactly those three harness-specific
  regions, with an anti-no-op guard proving the normalizer does not equalize
  arbitrary content, plus a stricter check that `usage` and `sidecar` match
  Hermes on the nose. The content assertions from the plan are scoped to what
  they actually protect: the three golden rules are asserted against the file
  that carries each one rather than per-file, and "no absolute paths" is
  scoped to machine-specific paths (a developer's home directory), since the
  verbatim bodies legitimately mention `/usr/bin` as illustrative prose about
  per-OS install locations. `claude plugin validate` (2.1.263) reports nothing
  about skills either way, so this test is the only gate on the port.
