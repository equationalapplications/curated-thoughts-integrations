# ct_doctor: resolve the Claude Code user-scope config path like Claude Code — design

**Date:** 2026-11-14 · **Status:** Approved (owner, Discord 2026-11-14) · **Branch:** `fix/ct-doctor-claude-config-path` · **Issue:** #93

## Problem

`ct_doctor.py check` fails a healthy Claude Code install. After a successful
`claude mcp add --scope user curated-thoughts ... --mcp`, the doctor reports
`[FAIL] claude-code-registration` and exits 1, while `claude mcp get
curated-thoughts` reports the server Connected in user scope. Any
install-verification step that treats the doctor's exit code as the gate
breaks on every stock install.

## Root cause

`ct_doctor.py` resolves the user-scope config as
`_claude_config_dir() / ".claude.json"`. With `CLAUDE_CONFIG_DIR` unset the
default directory is `~/.claude`, so the doctor reads `~/.claude/.claude.json`.
Real Claude Code never writes that file. `claude mcp add --scope user` writes
the `mcpServers` entry into `~/.claude.json` in the HOME root (verified on
Claude Code CLI 2.1.308, Linux; issue #93). `~/.claude/` holds `settings.json`,
plugins, and other data — no `.claude.json`.

Evidence:

- `integrations/claude-code/scripts/ct_doctor.py`, `CLAUDE_CONFIG` default:
  `str(_claude_config_dir() / ".claude.json")` resolves to
  `~/.claude/.claude.json` when `CLAUDE_CONFIG_DIR` is unset.
- Healthy-install output (issue #93): `[FAIL] claude-code-registration: Claude
  Code config /home/<user>/.claude/.claude.json not found, and no
  .../.mcp.json registers 'curated-thoughts' either` — `1 FAIL, 1 WARN, 8
  PASS — exit 1`.
- Same install: `~/.claude.json` at the HOME root holds the working
  `curated-thoughts` entry.

## Rule (proposed change)

When `CLAUDE_CONFIG_PATH` is unset, `ct_doctor.py` must resolve the
user-scope config the way Claude Code writes it:

- `CLAUDE_CONFIG_DIR` set: read `$CLAUDE_CONFIG_DIR/.claude.json` (unchanged).
- `CLAUDE_CONFIG_DIR` unset: read `~/.claude.json` in the HOME root (was
  `~/.claude/.claude.json`).

`CLAUDE_SETTINGS_PATH` and the `settings.json` resolution stay unchanged;
`~/.claude/settings.json` is the real location and stays right. The
harness-specific comment block above `_claude_config_dir()` must be rewritten
to state the HOME-root default. Every check message already prints the
resolved path (`CLAUDE_CONFIG`), so FAIL, WARN, and hint text follow the fix
with no message edits.

## Scope — files touched

- `integrations/claude-code/scripts/ct_doctor.py` — path resolution plus the
  comment block that documents it.
- `integrations/claude-code/tests/test_ct_doctor.py` — new tests that pin the
  default resolution (see test plan).
- `integrations/claude-code/integration.yaml` — version bump 0.4.3 → 0.4.4 at
  merge time (repo release model).
- `integrations/claude-code/package.json` — same version bump.
- `integrations/claude-code/CHANGELOG.md` — new 0.4.4 section.

## Test plan

The existing fixture fakes `HOME`/`USERPROFILE` and pins the config with an
explicit `CLAUDE_CONFIG_PATH`, so existing tests are unaffected. New tests in
`tests/test_ct_doctor.py`:

1. **Default finds the HOME-root registration.** With `CLAUDE_CONFIG_PATH` and
   `CLAUDE_CONFIG_DIR` unset under the fake HOME, a registration in
   `<fake-home>/.claude.json` yields PASS and the message names that path.
2. **Default FAIL names the HOME-root path.** With both env vars unset and no
   config anywhere, the FAIL message names `<fake-home>/.claude.json` (not
   `<fake-home>/.claude/.claude.json`).
3. **`CLAUDE_CONFIG_DIR` still relocates the config.** With
   `CLAUDE_CONFIG_DIR=<fake-home>/custom` and the registration in
   `custom/.claude.json`, the check PASSes — pinning the existing semantics.

Run the whole suite locally and read the output:
`python3 integrations/claude-code/tests/test_ct_doctor.py` (must exit 0), then
CI green on the PR.

## Rejected alternatives

- **Probe both `~/.claude.json` and `~/.claude/.claude.json`.** Real Claude
  Code never writes the second path. A two-path probe doubles the message
  surface to chase a file that does not exist. Rule 6 (keep it small) says
  match where Claude Code actually writes.
- **Downgrade "no config found" from FAIL to WARN.** The bug is the path, not
  the verdict contract. An unregistered sidecar must stay a FAIL.
- **Fix only install.sh hints.** `install.sh` already shells out to
  `claude mcp add` and never edits config; its `~/.claude.json` mentions are
  already correct. The doctor is the only wrong reader.

## Alignment with INTENT.md

- **Rule 6 (keep it small):** the fix is one default plus tests; no new
  dependency, no new check.
- **Rule 4 (failing quietly beats failing the session):** the doctor stops
  failing healthy installs, which is what it exists to verify.
- The doctor is install-verification tooling, not delivery behavior; no
  delivery rule changes. **No departure from INTENT.md.**
