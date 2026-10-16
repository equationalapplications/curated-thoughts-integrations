# Shared env view, doctor re-sync and script parity gate (issues #32, #33) — design

**Date:** 2026-10-16 · **Status:** Approved (autonomous — design judgment delegated by Kurt; no open questions) ·
**Repo:** equationalapplications/curated-thoughts-integrations · **Base:** `main` @ `b36123b` ·
**Branch / PR:** `fix/shared-env-doctor-parity` — closes #32 and #33.
Builds on: issue #14 / #28 / #29 resolutions (PR #27, #30, #31) and the Claude Code
integration spec (`2026-09-11-claude-code-integration-design.md`).

## Problem

Two follow-ups, one root cause: **two code paths resolving different env views.**

1. **#32.** The canonical spawn-time env view — `os.environ` overlaid with a caller
   env, `""` = suppression, `None` = "not specified" — lives in
   `ct_doctor._merged_env`, not next to the discovery code that consumes it
   (`ct_env`). And `ct_status.snapshot(env=...)` hands `env` straight to
   `ct_env.find_sidecar`/`resolve_brain_paths`, which use it AS-IS: a caller passing
   `{"CURATED_BRAIN_DIR": ...}` gets a view with no HOME and no PATH. That is
   *replace* semantics, while the doctor *merges*.
2. **#33.** `integrations/claude-code/scripts/ct_doctor.py` was cut before #14/#28/#29
   landed in Hermes. Its `run_checks` discovers with no env, `mcp_tools_list` builds
   `dict(os.environ)` by hand, checks 4/5/6/8 read ambient env only, the #28
   bundled-fallback gate is missing, and `ct_env.py` lacks the `SOURCE_*`
   constants. The header says checks 1–6, 8, 9 "must not drift", but no test enforces
   that. Separately, `tools/ct_ci_package.py` applies only manifest excludes, and
   `release.yml` runs ruff in the integration dir before packaging, so
   `.ruff_cache/` ships in release tarballs.

## Decisions

### D1 — `ct_env.merged_env(env=None)` is the single source of truth

```python
def merged_env(env=None):
    """Return a NEW dict: os.environ overlaid with `env`.

    env=None or {}     -> a copy of os.environ
    key missing        -> ambient value shows through
    value None         -> treated as missing: ambient shows through
    value ""           -> kept: suppresses (hides) the ambient value
    any other str      -> wins over ambient
    """
```

* The signature is exactly `merged_env(env=None) -> dict[str, str]`. It is a pure
  read of `os.environ` at call time and always returns a fresh dict, so mutating
  the result never touches `os.environ`. Non-raising.
* The docstring carries the None / `""` / missing distinction from the GLM r3
  review (issue #32 comment) word for word. It also records the documented trade-off: a caller env **without** a
  PATH key inherits the ambient PATH, so discovery can resolve, and the doctor can
  spawn, the real installed sidecar. This is deliberate: no-PATH-key callers must
  stay unaffected. A caller that wants to control which binary runs must pass PATH,
  and the #28 gate in `ct_doctor.run_checks` covers the case where that override
  fails to resolve.
* `ct_env`'s primitives (`find_sidecar`, `resolve_brain_paths`,
  `sidecar_candidates`) keep their **as-is** contract: they consume a *view*, and
  only `None` means ambient. Merging happens once, at the public boundary
  (`ct_doctor.run_checks`/its checks, `ct_status.snapshot`). This is what lets the
  #28 gate tell the raw caller env (did the caller override PATH?) apart from the
  merged view (which always has a PATH).
* `ct_doctor._merged_env` stays as a **thin delegate**
  (`return ct_env.merged_env(env)`). It is a private, doctor-local seam that
  existing tests patch (`FindSidecarWrapperTests`). It holds no logic of its own.

*Alternatives considered:* (a) migrate every caller to `ct_env.merged_env` and delete
`_merged_env`. Rejected: this means test churn for no behavior gain, and the patch seam
is useful. (b) Make `find_sidecar`/`resolve_brain_paths` merge internally. Rejected:
it erases the raw-vs-merged distinction the #28 gate depends on, and it double-merges
on the doctor path. (c) A `base=` parameter for testability. Rejected under YAGNI:
tests patch `os.environ`, which matches how the existing suites work.

### D2 — `ct_status.snapshot(env=None)` merges

`snapshot` resolves `view = ct_env.merged_env(env)` once and passes `view` to
`find_sidecar` and `resolve_brain_paths`. `context_section(env=None)` passes `env`
through unchanged. With `env=None` the behavior is unchanged (a copy of
`os.environ` is still the ambient view). For env-passing callers this is a
**behavior change: replace → merge.** There are no live env-passing callers today:
`integrations/hermes/__init__.py`, `hooks/session-start.py` and the Claude Code
hook all call `context_section()` bare. A test pins the new contract:
`snapshot(env={"CURATED_BRAIN_DIR": X})` still sees the ambient HOME/PATH.

### D3 — Shared scripts: byte-identical, except closed named regions in `ct_doctor.py`

The four shared scripts are `ct_env.py`, `ct_status.py`, `ct_preflight.py` and
`ct_doctor.py` (`_compat_generated.py` is already pinned by
`ct_ci.py generate --check`).

* `ct_env.py`, `ct_status.py`, `ct_preflight.py`: **byte-identical** between
  `integrations/hermes/scripts/` and `integrations/claude-code/scripts/`, with
  line endings normalized. The claude-code-only "Copied byte-for-byte…" docstring
  line and the Hermes-only docstring wording ("the Hermes plugin entry point",
  "both Hermes session-start paths") are replaced in both copies by
  harness-neutral text plus a pointer to the parity gate.
* `ct_doctor.py`: identical outside **exactly three** marked regions:

  | Region | Hermes | Claude Code |
  |---|---|---|
  | `module-docstring` | title, Hermes spec ref | title, CC spec ref, check-7 note |
  | `harness-config` | `HERMES_CONFIG`, `HARNESS_LABEL`, `MCP_SERVER_KEY`, `PLUGIN_NAME`, `_plugin_version()` (reads `../plugin.yaml`) | `_claude_config_dir`, `CLAUDE_CONFIG`, `CLAUDE_SETTINGS`, `PROJECT_MCP_CONFIG`, same keys, `_plugin_version()` (reads `../.claude-plugin/plugin.json`) |
  | `registration-check` | `_plugin_listed_under_enabled`, `check_hermes_registration`, `_check_registration(cwd=None)` | `_read_json_file`, `_mcp_entry`, `_local_scope_entry`, `_registration_hint`, `_plugin_enablement_note`, `PLUGIN_ENABLEMENT_HINT`, `check_claude_code_registration`, `_check_registration(cwd=None)` |

  Markers are comment lines, `# >>> harness-specific: <name>` …
  `# <<< harness-specific: <name>`. The region names are a **closed list** in the
  gate: wrapping new drift in a new region fails until the gate itself is edited
  in review.
* To keep `run_checks`, `main` and `_self_test_suite` fully shared:
  * both copies get `run_checks(timeout=MCP_TIMEOUT, env=None, cwd=None)`. `cwd`
    is the registration context, forwarded to `_check_registration(cwd)`. Hermes's
    adapter ignores it. This is additive for Hermes: an optional keyword that
    defaults to the old behavior.
  * argparse description: `f"Curated Thoughts {HARNESS_LABEL} plugin doctor (read-only)."`.
  * the `_self_test_suite` layout comment becomes `integrations/<id>/...`.
* The Claude Code copy **gains** everything from Hermes post-#14/#28/#29:
  `_merged_env` threading through checks 3–6 and 8, the bundled-fallback gate
  (`gated`, `CT_DOCTOR_ALLOW_BUNDLED`), the `OLLAMA_DEFAULT_HOST` constant (in place of
  the import-time `OLLAMA_HOST` read), the `clientInfo.version` derived from the
  manifest (in place of the stale `"0.2.0"` literal), and `ct_env.SOURCE_*`. Check 7
  keeps its ambient, import-time config resolution. This is the same rule Hermes
  documents for `HERMES_CONFIG`: the harness config belongs to the host install,
  not to the per-call env view. The rationale comment is carried over.

*Alternatives considered:* (a) AST-level comparison with a function-name allowlist.
Rejected: it ignores comment and docstring drift, and the issue asks for "the rest"
to be identical. A marker-based textual gate also prints a readable unified diff on
failure. (b) Regex normalizers over known shapes, as `SkillBodyParityTests` does
for prose. Rejected for code: markers are explicit at the edit site, so whoever
touches a region sees it is harness-specific. (c) Move shared code into a single
vendored module. Rejected: it violates "each integration is self-contained" (no
cross-integration imports), and the shipped tarballs must stand alone.

### D4 — The parity gate lives in `tests/tools/test_shared_script_parity.py`

`discover` selects matrix entries by changed path. A PR that touches **only**
`integrations/hermes/scripts/ct_doctor.py` never runs the claude-code suite, so a
gate placed in `integrations/claude-code/tests/` would not run on exactly the change
that causes drift. `tests/tools/` runs in the `policy` job on **every** PR
(`python -m unittest discover -s tests/tools`). Like `SkillBodyParityTests`, the
gate reads both integration trees and writes nothing.

The gate asserts:
1. For each byte-identical file: equal after CRLF→LF normalization.
2. For `ct_doctor.py`: the region-name sequences are equal on both sides and drawn
   from the closed list. Markers are balanced, unnested, and each name is used at
   most once. The two files are then equal after each region is collapsed to
   `# [harness-specific: <name>]`.
3. Anti-no-op guards: injecting a stray line outside a region breaks equality; an
   unknown region name raises; an unbalanced marker raises.

On failure, the message is a unified diff of the normalized texts.

### D5 — Test-fixture simplification in `claude-code/tests/test_ct_doctor.py`

`SCRUBBED_PATH` existed for two reasons. Discovery read the *process* PATH, and the
`#!/usr/bin/env python3` mock needed `python3` on that PATH, so the ambient PATH had
to be kept, and any real sidecar on it scrubbed. After the re-sync, discovery
honors the caller env. The scrub goes. Its replacements:

* POSIX mock = a `#!/bin/sh` shim that `exec`s the absolute `sys.executable` on
  `mock_sidecar.py`. This is the POSIX twin of the existing Windows `.bat` shim.
  Unlike Hermes's `#!<sys.executable>` shebang it works with a spaced interpreter
  path, so the suite never needs to skip.
* PATH = bare `bin_dir`, both in the helpers' env and in the patched process PATH
  (for the CLI-subprocess tests, whose child calls `run_checks()` with `env=None`).
* A setUp precondition (ported from Hermes, issue #28): discovery against
  `with_path()` must resolve the mock via `SOURCE_PATH`, or the suite fails at setup.
  Because the claude-code fixture has a `.bat` shim, this runs on Windows too.

The env-threading and #28-gate behaviors gain claude-code tests: a ported subset of
Hermes's `BundledFallbackGuardTests`, `FindSidecarWrapperTests` and the
embedding/brain-dir env tests. The parity gate guarantees the code under test is the
same, so a representative subset is enough. Shared `MergedEnvTests` (None / `""` /
missing / fresh-copy) and the snapshot merge test are added to **both** suites.

### D6 — Dot-dir caches are filtered centrally in the packager

`tools/ct_ci_package.py` drops any file whose path (relative to the integration)
has a component in `CACHE_DIR_NAMES = {"__pycache__", ".ruff_cache",
".pytest_cache", ".mypy_cache"}`, or a `.pyc`/`.pyo` suffix, **before** manifest
include/exclude apply.

*Why central and not per-manifest:* the leak comes from tooling, not integration
content. `release.yml` runs ruff in the integration directory. A per-manifest
exclude has to be remembered by every future integration, which is the same
"N copies drift" class this PR fixes. A central filter covers all integrations
(including ones this PR must not touch) without editing their manifests, and a
cache file is never legitimate release content. The existing manifest
`__pycache__`/`*.pyc` excludes stay; they are harmless and remain valid.
*Alternative considered:* adding `"**/.ruff_cache/**"` to both manifests. It works
with the current matcher, but it fixes two integrations and leaves the class open.

Packager tests: run `_selected_files` over a temp integration tree with planted
`.ruff_cache/0.16.9/x`, `__pycache__/m.cpython-313.pyc`, `.pytest_cache/v/x`,
`.mypy_cache/x` and a stray `top.pyc`. Use the real hermes and claude-code
`package` blocks *and* an empty one, so the filter is proven independent of the
manifests, and assert that no cache ships while real files do. A full `build()` of
a temp repo (manifest + planted `.ruff_cache`) asserts the same at the tarball level.

### D7 — Minor findings from the PR #23 review: not fixed here

The install.sh JSON-escaping of exotic paths, the raw MSYS `$SIDECAR` passed to
`claude mcp add`, and `claude plugin validate` portability are each install-path
behavior changes with Windows/MSYS surface that cannot be verified on this machine.
None of them is trivial and safe, so they stay open, listed in the PR body.

## Releases

Each touched integration's CHANGELOG gets entries under `## Unreleased`. No version
bump and no tag (per instructions). **Note:** the `policy` version gate
(`gate_versions`) requires a bump whenever shipped files change. Both integrations'
`scripts/` change, so the policy job is expected to be red until the maintainer
adds the bump: hermes 0.4.1→0.4.2, claude-code 0.1.1→0.1.2, both patch. The PR
body states this.

## Final API (for the Claude Code wisdom leg)

```python
# ct_env (both integrations, byte-identical)
merged_env(env=None) -> dict          # D1 semantics
find_sidecar(platform=None, env=None) -> (path|None, realpath|None, source)  # env AS-IS
resolve_brain_paths(env=None) -> BrainPaths                                   # env AS-IS
SOURCE_PATH, SOURCE_BUNDLED, SOURCE_NONE

# ct_status (byte-identical)
snapshot(env=None) -> dict            # merges via ct_env.merged_env
context_section(env=None) -> str|None

# ct_doctor (shared outside 3 regions)
run_checks(timeout=MCP_TIMEOUT, env=None, cwd=None) -> list[CheckResult]
```

New Python code that resolves env for discovery or spawning calls
`ct_env.merged_env(env)` once at its public boundary. It passes the result to the
`ct_env` primitives and to `subprocess.run(env=...)`.

## Testing

* hermes: `python -m unittest discover -s tests` (+ `ct_doctor.py --self-test`).
* claude-code: `python -m unittest discover -s tests`.
* tooling: `python -m unittest discover -s tests/tools`.
* `ruff check --select E9,F63,F7,F82,F401 .` at repo root and in each integration.
* `python tools/ct_ci.py validate` and `generate --check`.
