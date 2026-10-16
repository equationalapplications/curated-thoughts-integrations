# Changelog — Claude Code integration

All notable changes to `integrations/claude-code/` are recorded here. This file
is the source of the GitHub Release body for every `claude-code-v*` tag, so the
heading format below is load-bearing: `## <version> — <date>`.

## Unreleased

## 0.2.2 — 2026-10-16

- Changed: the vendored `scripts/ct_ledger.py` gains
  `LedgerCache.claim()`, an atomic check-and-add, kept byte-identical with
  the Hermes reference (shared-script parity gate). No behavior change:
  Claude Code's hooks do not call it. It is there for Claude Code's later
  autonomous-work leg (Hermes 0.5.0 uses it).

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
