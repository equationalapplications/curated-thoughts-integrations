# Changelog — Claude Code integration

All notable changes to `integrations/claude-code/` are recorded here. This file
is the source of the GitHub Release body for every `claude-code-v*` tag, so the
heading format below is load-bearing: `## <version> — <date>`.

## Unreleased

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
