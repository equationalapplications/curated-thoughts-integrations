# Claude Code Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `integrations/claude-code/`, a sibling to `integrations/hermes/` that wires the Curated Thoughts memory sidecar into Claude Code as a plugin directory — `.claude-plugin/plugin.json`, a `SessionStart` hook, three skills — with a doctor / status / install script that mirrors Hermes's discipline.

**Architecture:** A Python integration, same language as Hermes, so four of the five shipped scripts are **copies** rather than ports: `ct_env.py`, `ct_status.py` and `ct_preflight.py` are byte-identical to the Hermes originals, and `ct_doctor.py` differs only in check 7. The genuinely new code is `hooks/session-start.py` (adapts `ct_status.context_section()` to Claude Code's `hookSpecificOutput.additionalContext` protocol), `check_claude_code_registration` in the doctor, and `scripts/install.sh` (resolves the sidecar's absolute path and registers it with `claude mcp add`).

**Tech Stack:** Python 3.9–3.13, standard library only. POSIX bash for `install.sh`. `unittest` for tests (no pytest — stdlib only, same as Hermes). Sidecar binary `curated-thoughts-mcp --mcp`.

**Spec:** [`docs/superpowers/specs/2026-09-11-claude-code-integration-design.md`](../specs/2026-09-11-claude-code-integration-design.md) — the plan argues from the spec; executors read both. **The spec PR must be approved and the maintainer's scope sign-off recorded before this plan's first task starts** (CONTRIBUTING rule 1).

**Sibling reference (read before each task):** [`integrations/hermes/`](../../../integrations/hermes/) — every layer here mirrors a Hermes one:

- `hermes/scripts/ct_env.py` → `claude-code/scripts/ct_env.py` (**copy, unchanged**)
- `hermes/scripts/ct_status.py` → `claude-code/scripts/ct_status.py` (**copy, unchanged**)
- `hermes/scripts/ct_preflight.py` → `claude-code/scripts/ct_preflight.py` (**copy, byte-identical**)
- `hermes/scripts/ct_doctor.py` → `claude-code/scripts/ct_doctor.py` (copy; check 7 replaced)
- `hermes/hooks/session-start.py` → `claude-code/hooks/session-start.py` (adapted: different output protocol)
- `hermes/scripts/install.sh` → `claude-code/scripts/install.sh` (adapted: no file copying, `claude mcp add` instead of a YAML append)
- `hermes/skills/curated-thoughts-{usage,ops,sidecar}/SKILL.md` → `claude-code/skills/{usage,ops,sidecar}/SKILL.md` (bodies verbatim; one paragraph rewritten)
- `hermes/integration.yaml` → `claude-code/integration.yaml` (same CI contract shape)

## Global Constraints

- **Identity:** `id: claude-code`, `language: python`, `requires_sidecar: ">=2.5"`, `compat_tier: v2.5-full`, `version_mirror: .claude-plugin/plugin.json#version`.
- **Python floor is 3.9** (it is in the CI matrix). No `match`, no runtime `X | Y` unions, `from __future__ import annotations` at the top of every module.
- **Stdlib only** in shipped code. The architecture gate's allowlist is `sys.stdlib_module_names` plus `_compat_generated`, `ct_env`, `ct_doctor`, `ct_preflight`, `ct_status`.
- **`import sqlite3` only in `scripts/ct_preflight.py`**, which must be the sole entry under `policy.allow_sqlite_readonly`, and every `sqlite3.connect(...)` in it keeps its `mode=ro` URI **and** `uri=True`.
- **No cross-integration imports.** Never `from integrations.hermes import …`. Copy.
- **No absolute or drive-letter paths** in string literals in shipped `.py` files. `Path.home()` for `~/.claude.json` and `~/.claude/settings.json`. (Docstrings are exempt from the gate, but prefer env-var spellings there too.)
- **Environment contract:** exactly `CURATED_BRAIN_DIR`, `CURATED_BRAIN_DB`, `CURATED_BRAIN_CONFIG`. `CLAUDE_CONFIG_PATH` and `CT_INSTALL_EDIT` are not `CURATED_*` and are therefore outside the contract, which is why they are permitted.
- **Never restate compat values as literals** — no bare `8`, `14`, `librarian-[0-9a-f]{32}`, `librarian_evidence`, `7.1.0` in shipped code. Import from `_compat_generated`, which `python tools/ct_ci.py generate` writes from `shared/compat.yaml`. Tests may assert against the generated module's values; they may not retype them independently.
- **Fail open.** The hook never blocks a session and always exits 0. The doctor never mutates anything. `install.sh` only writes under `CT_INSTALL_EDIT=1`.
- **Path quoting is mandatory.** The real Windows sidecar path contains a space (`%LOCALAPPDATA%\Curated Thoughts\curated-thoughts-mcp.exe`). Every interpolation into a command line, JSON block, or hook command is double-quoted.
- **Do not touch** `integrations/hermes/`, `integrations/deepseek/`, or `shared/compat.yaml` in this PR.
- **Do not touch the developer's machine.** No software installs, no binary downloads, no edits to `~/.claude.json` or `~/.claude/settings.json` from an agent. Print the instructions; the human runs them (Task 9).
- **Windows is in the CI matrix** for all three integrations. Tests must pass or skip cleanly there — and Task 6 exists to make "pass" the common case rather than "skip".
- **Commits:** one task per commit, conventional prefix (`feat(claude-code):`, `test(claude-code):`, `docs(claude-code):`), merge commits only on the PR.
- **License:** MIT, matching the repo.

## Gate commands (run after every task, from the repo root)

```bash
python tools/ct_ci.py validate
python tools/ct_ci.py generate --check
python tools/ct_ci.py policy --base origin/main
python tools/ct_ci.py readme --check
python tools/ct_ci.py discover --all
```

and from `integrations/claude-code/`:

```bash
python -m unittest discover -s tests
ruff check --select E9,F63,F7,F82,F401 .
python scripts/ct_doctor.py check
python scripts/ct_doctor.py --self-test
```

---

## Task 1: Scaffold + first passing test

**Files:**
- Create: `integrations/claude-code/.claude-plugin/plugin.json`
- Create: `integrations/claude-code/README.md` (stub)
- Create: `integrations/claude-code/CHANGELOG.md`
- Create: `integrations/claude-code/tests/test_manifest.py`
- Modify: `integrations/claude-code/integration.yaml` (exists as a placeholder)

**Step-by-step:**

- [ ] **Step 1.1: Fill in `integration.yaml`.** Keep `status: planned` — Task 2 flips it, so that Task 1 cannot turn CI red before there is anything to run.

```yaml
id: claude-code
name: Curated Thoughts for Claude Code
version: 0.1.0
language: python
status: planned
requires_sidecar: ">=2.5"
compat_tier: v2.5-full
version_mirror: .claude-plugin/plugin.json#version

matrix:
  os: [ubuntu-latest, macos-latest, windows-latest]
  python: ["3.9", "3.13"]

checks:
  test: python -m unittest discover -s tests
  lint: ruff check --select E9,F63,F7,F82,F401 .
  shell:
    - scripts/install.sh

policy:
  allow_sqlite_readonly:
    - scripts/ct_preflight.py

package:
  include: ["**"]
  exclude:
    - "**/__pycache__/**"
    - "**/*.pyc"
```

- [ ] **Step 1.2: Create `.claude-plugin/plugin.json`** exactly as in spec §3.1 (`name: curated-thoughts`, `version: 0.1.0`).

- [ ] **Step 1.3: Create `CHANGELOG.md`** with the load-bearing heading format (`## <version> — <date>`), starting with a `## Unreleased` section only. The `0.1.0` section is written in Task 8, when the version gate needs it.

- [ ] **Step 1.4: Create a stub `README.md`** — one paragraph plus a "status: under construction" note. Task 8 fleshes it out. A stub now keeps `readme --check` honest from the first commit.

- [ ] **Step 1.5: Write `tests/test_manifest.py`.** Asserts:
  - `plugin.json` parses as JSON and `name == "curated-thoughts"`;
  - its `version` equals the `version:` in `integration.yaml`. **Read the YAML with a three-line regex, not PyYAML** — the tests are stdlib-only too, and PyYAML is a CI-tools dependency, not an integration one;
  - `license` is `MIT` and `description` is non-empty;
  - `claude plugin validate <integration dir>` exits 0 — `skipUnless(shutil.which("claude"))`, since no CI runner has the binary.

- [ ] **Step 1.6: Gate + commit.**

```bash
python tools/ct_ci.py validate
cd integrations/claude-code && python -m unittest discover -s tests
```

Expected: `validate` exits 0 ("All integration manifests valid."); the manifest tests pass (the `claude plugin validate` one skips on CI, runs locally).

```bash
git add integrations/claude-code
git commit -m "feat(claude-code): scaffold the plugin manifest and CI contract"
```

---

## Task 2: Copy the shared scripts and flip to implemented

**Files:**
- Create: `integrations/claude-code/scripts/ct_env.py` (copy)
- Create: `integrations/claude-code/scripts/ct_status.py` (copy)
- Create: `integrations/claude-code/scripts/ct_preflight.py` (copy)
- Create: `integrations/claude-code/scripts/_compat_generated.py` (generated)
- Create: `integrations/claude-code/tests/test_ct_doctor.py` (copy; doctor classes will fail until Task 3)
- Modify: `integrations/claude-code/integration.yaml` (`status: implemented`)
- Modify: `README.md` (repo root — via the generator)

**Step-by-step:**

- [ ] **Step 2.1: Copy the three harness-agnostic scripts** from `integrations/hermes/scripts/`. Add exactly one line to each module docstring recording provenance, e.g.:

```text
Copied from integrations/hermes; keep logically identical. Cross-integration
imports are forbidden (CONTRIBUTING, repository layout), so this is a copy by
design, not by accident.
```

`ct_preflight.py` must stay **byte-identical apart from that line** — the review gate is `diff`, and §6 of the spec commits to it.

- [ ] **Step 2.2: Flip `status: planned` → `status: implemented`** in `integration.yaml`. This is what puts the integration into the `discover` matrix and makes `generate` write its compat module.

- [ ] **Step 2.3: Generate the compat module.**

```bash
python tools/ct_ci.py generate
python tools/ct_ci.py generate --check
```

Expected: `scripts/_compat_generated.py` appears and `--check` exits 0. **Never hand-edit it** — the header says so and the gate enforces it.

- [ ] **Step 2.4: Refresh the README table.**

```bash
python tools/ct_ci.py readme
python tools/ct_ci.py readme --check
```

Expected: the Claude Code row changes from `planned / —` to `implemented / 0.1.0`.

- [ ] **Step 2.5: Copy `tests/test_ct_doctor.py`** from Hermes. At this point the env, status and pre-flight test classes must pass; the registration and full-run classes will fail because `ct_doctor.py` does not exist yet. That is expected and is fixed in Task 3 — do not paper over it by deleting tests.

- [ ] **Step 2.6: Gate + commit.**

```bash
python tools/ct_ci.py validate
python tools/ct_ci.py generate --check
python tools/ct_ci.py policy --base origin/main
python tools/ct_ci.py readme --check
```

Expected: `ok [architecture]`, `ok [compat]`, `ok [versions]`. The architecture gate now sees `ct_preflight.py` and must accept it via the `allow_sqlite_readonly` entry — if it does not, the entry or the `uri=True` argument is wrong, not the gate.

```bash
git commit -m "feat(claude-code): copy the shared env, status and pre-flight scripts"
```

---

## Task 3: Port the doctor

**Files:**
- Create: `integrations/claude-code/scripts/ct_doctor.py`
- Modify: `integrations/claude-code/tests/test_ct_doctor.py`

**Step-by-step:**

- [ ] **Step 3.1: Copy `ct_doctor.py`** from Hermes. Update the module docstring: the first line names Claude Code, and the spec reference becomes this integration's spec.

- [ ] **Step 3.2: Remove the Hermes-specific surface** — `HERMES_CONFIG`, `_plugin_listed_under_enabled`, and `check_hermes_registration`. Add:

```python
CLAUDE_CONFIG = Path(
    os.environ.get("CLAUDE_CONFIG_PATH", str(Path.home() / ".claude.json"))
)
CLAUDE_SETTINGS = Path.home() / ".claude" / "settings.json"
MCP_SERVER_KEY = "curated-thoughts"
PLUGIN_NAME = "curated-thoughts"
```

- [ ] **Step 3.3: Write `check_claude_code_registration(cwd=None)`** per spec §7 / D4. Parse with the stdlib `json` module, not a regex — this config is JSON and can be read properly. Verdicts, in evaluation order:

  1. Look up `mcpServers.curated-thoughts` in `~/.claude.json`, then in `cwd/.mcp.json`. For each file, three outcomes: **missing** (not registered there), **malformed** (exists but does not parse as a JSON object — remember it, treat as not registered there), or **parsed**.
  2. Entry in neither file:
     - if either file was malformed → **WARN** ("cannot confirm registration: `<file>` is not valid JSON"), hint = fix the file, then the `claude mcp add` line. A broken config is not proof of absence, so it is not a FAIL;
     - else → **FAIL**, hint = the exact `claude mcp add --scope user curated-thoughts -- "<path>" --mcp` line plus the JSON block. A missing `~/.claude.json` lands here — it is not a separate, earlier FAIL, because a project `.mcp.json` alone is a working install.
  3. Take the entry found (user scope wins over project scope; a project-scope entry adds a note to the detail). `args` lacks `--mcp` → **WARN**.
  4. `command` satisfies `ct_env.looks_like_dev_build` → **WARN** (reuse the function; do not reimplement the marker list).
  5. No `curated-thoughts@…` key under `enabledPlugins` in `~/.claude/settings.json` — including when that file is missing or malformed → **WARN**, with detail text saying plainly that a `--plugin-dir` install is invisible to this file. (Q3 gates this verdict.)
  6. Otherwise → **PASS** (with the project-scope note if applicable).

  No input — missing file, malformed JSON, a non-object at any level, `args` not a list — ever raises out of the check: the doctor must complete a run even on a broken config, which is exactly when a user runs it. Every verdict above is the only one for its input; there is no path on which the same file state yields FAIL in one reading and WARN in another.

- [ ] **Step 3.4: Keep the check-name list and order** — `sidecar-binary, sidecar-identity, sidecar-mcp, brain-dir, vault, embedding-backend, claude-code-registration, import-preflight, version-compat`. `check --json` consumers depend on it. Update `EXPECTED_CHECKS` in the test module to match.

- [ ] **Step 3.5: Update the hints.** The Hermes "Add the block to config.yaml" text becomes the `claude mcp add` one-liner plus the JSON snippet. Scan the whole file for stale `~/.hermes`, `config.yaml`, `mcp_servers` and `plugins.enabled` strings; none may remain outside a provenance comment.

- [ ] **Step 3.6: Rewrite the registration tests** in `test_ct_doctor.py`, replacing the Hermes ones. Cases: PASS with a well-formed `~/.claude.json`; FAIL when the file is missing; FAIL when the key is missing; WARN when `--mcp` is absent; WARN when `command` points into `target/debug`; PASS via a project `.mcp.json` in `cwd`; PASS via a project `.mcp.json` when `~/.claude.json` is **missing**; WARN-not-FAIL when `settings.json` has no `enabledPlugins`; WARN (not FAIL, no traceback) when `~/.claude.json` is truncated mid-object and no project registration exists; PASS when `~/.claude.json` is malformed but the project `.mcp.json` registers the server; WARN when `settings.json` is malformed. Drive them with `CLAUDE_CONFIG_PATH` plus `HOME`/`USERPROFILE` overrides so nothing on the host is read — `CLAUDE_CONFIG_PATH` exists precisely because `expanduser` follows `HOME` on POSIX and `USERPROFILE` on Windows.

- [ ] **Step 3.7: Gate + commit.**

```bash
cd integrations/claude-code
python -m unittest discover -s tests
python scripts/ct_doctor.py check --json
```

Expected: the suite passes; `check --json` emits nine checks in the contracted order with `{name,status,detail,hint}` keys each.

```bash
git commit -m "feat(claude-code): port the doctor with a claude-code-registration check"
```

---

## Task 4: The SessionStart hook

**Files:**
- Create: `integrations/claude-code/hooks/hooks.json`
- Create: `integrations/claude-code/hooks/session-start.py`
- Create: `integrations/claude-code/tests/test_hook.py`

**Step-by-step:**

- [ ] **Step 4.1: Write `hooks/hooks.json`** exactly as in spec §3.2 — `SessionStart`, matcher `startup|resume|clear|compact`, `python3 … || python …` with `${CLAUDE_PLUGIN_ROOT}` double-quoted, `timeout: 10`.

- [ ] **Step 4.2: Write `hooks/session-start.py`,** adapting the Hermes script. Differences from the Hermes original, all deliberate:
  - resolve the scripts directory **only** from `Path(__file__).resolve().parent.parent / "scripts"`. Do **not** read `CLAUDE_PLUGIN_ROOT` from the environment (Hermes reads `PLUGIN_ROOT`). `hooks.json` already expands `${CLAUDE_PLUGIN_ROOT}` into the script's own path, so `__file__` carries the same information, and it is also correct when the script is run directly;
  - emit `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext": section}}` rather than `{"context": section}`;
  - everything else — drain stdin, swallow every exception, `sys.exit(0)` unconditionally — stays.

  Why not read the variable: the Hermes test `RepoWideContractTests.test_claude_plugin_root_is_never_read` walks **the whole repo** and fails on any `environ[...]` / `environ.get(...)` read of `CLAUDE_PLUGIN_ROOT`. Resolving from `__file__` keeps that guard green without touching `integrations/hermes/` (spec §11 Q6, resolved). The `${CLAUDE_PLUGIN_ROOT}` expansion inside `hooks.json` is shell syntax, which the guard deliberately does not match. Gate for this step: run the Hermes suite from `integrations/hermes/` (`python -m unittest discover -s tests`) and confirm `RepoWideContractTests` still passes.

- [ ] **Step 4.3: Write `tests/test_hook.py`.** Run the script as a subprocess with a fake stdin payload and a temp HOME:
  - healthy fixture brain → stdout is exactly one line, parses as JSON, has the `hookSpecificOutput.hookEventName == "SessionStart"` shape, exit 0;
  - `CURATED_BRAIN_DIR` pointed at a nonexistent directory → `additionalContext` contains `DEGRADED` and names the missing directory, exit 0;
  - the hook copied into a temp `hooks/` directory with **no** sibling `scripts/` (so `ct_status` cannot be imported) → exit 0, stdout empty (fail-open, silent);
  - `CLAUDE_PLUGIN_ROOT` set to a nonexistent directory → output identical to the unset case (proves the variable is not consulted);
  - stdin closed rather than a payload → exit 0;
  - wall time under 1 s.

- [ ] **Step 4.4: Gate + commit.**

```bash
cd integrations/claude-code && python -m unittest discover -s tests
python hooks/session-start.py < /dev/null
cd ../hermes && python -m unittest discover -s tests   # RepoWideContractTests must stay green
```

```bash
git commit -m "feat(claude-code): add the SessionStart health-snapshot hook"
```

---

## Task 5: Installer

**Files:**
- Create: `integrations/claude-code/scripts/install.sh`
- Create: `integrations/claude-code/tests/test_install.py`

**Step-by-step:**

- [ ] **Step 5.1: Write `scripts/install.sh`** — POSIX bash, `set -euo pipefail`, shellcheck-clean (`checks.shell` runs it in CI). Behaviour per spec §8:

  1. Resolve the sidecar: `command -v curated-thoughts-mcp`, then the platform candidates mirroring `ct_env.py` — including **both** Windows locations, since the 2.10.1 installer uses `$LOCALAPPDATA/Curated Thoughts/`, not `$LOCALAPPDATA/Programs/Curated Thoughts/`. `CLAUDE_CT_SIDECAR` overrides. Not found → WARN with the releases URL, then continue and print the block with a placeholder path.
  2. Print the `claude mcp add --scope user curated-thoughts -- "<path>" --mcp` line **and** the equivalent JSON block. Double-quote the path in both — it contains a space on Windows.
  3. Print plugin enablement instructions: `claude --plugin-dir "<abs plugin dir>"` now, marketplace later.
  4. Under `CT_INSTALL_EDIT=1` **and** `claude` on PATH: run `claude mcp get curated-thoughts` first; register only if absent. Never edit `~/.claude.json` directly. Never overwrite.
  5. Close with `Next step: python3 <plugin>/scripts/ct_doctor.py check`.

  Unlike the Hermes installer this script copies nothing — Claude Code loads a plugin in place — so there is no destination tree, no merge-copy, no prune, and none of the symlink handling that carries.

- [ ] **Step 5.2: Write `tests/test_install.py`,** adapted from Hermes and skipped on Windows for the same reason (`bash` is not on a Windows runner's PATH). Cases:
  - default run writes nothing anywhere under a temp HOME and exits 0;
  - stdout contains the `claude mcp add` line and the JSON block;
  - with a fake `claude` shim on PATH that logs its argv and reports "not found" for `mcp get`: `CT_INSTALL_EDIT=1` invokes `mcp add` exactly once;
  - second run with the shim now reporting "found": `mcp add` invoked zero times, output says "already present — nothing changed";
  - `CLAUDE_CT_SIDECAR` override appears, quoted, in the printed command;
  - a sidecar path containing a space survives quoting — assert the printed command line, not just the presence of the path.

- [ ] **Step 5.3: Gate + commit.**

```bash
cd integrations/claude-code
bash scripts/install.sh          # prints, writes nothing
python -m unittest discover -s tests
```

```bash
git commit -m "feat(claude-code): add the idempotent MCP registration installer"
```

---

## Task 6: Hermetic tests on all three OSes

**Files:**
- Modify: `integrations/claude-code/tests/test_ct_doctor.py`

This is the task that keeps the Hermes issue #14 class of bug out of this integration. It is not optional polish: with Curated Thoughts actually installed, the Hermes suite goes from `OK` to `FAILED (failures=5, skipped=28)` because the tests' `PATH` still reaches the real sidecar.

**Step-by-step:**

- [ ] **Step 6.1: Scrub `PATH` in `DoctorTestCase.setUp`.** Build the subprocess `PATH` as the fake bin directory followed by only those inherited directories that do **not** contain a `curated-thoughts-mcp` (any extension). A developer with Curated Thoughts installed must get a green suite; that is the whole point.

- [ ] **Step 6.2: Add a Windows-resolvable mock.** Write the Python mock as `mock_sidecar.py` and, on Windows, have `setUp` **generate** `curated-thoughts-mcp.bat` next to it containing `@"<sys.executable>" "%~dp0mock_sidecar.py" %*`. Embed the running interpreter's absolute path, double-quoted, so the shim never depends on which name resolves on PATH: a bare `python` can hit the Microsoft Store alias stub on a developer machine. `shutil.which` then resolves the shim under PATHEXT, and the MCP-spawn tests run on Windows instead of skipping. Keep the POSIX shebang script for POSIX.

- [ ] **Step 6.3: Drop the now-unnecessary skips.** `MOCK_SPAWN_SKIP` guards disappear from every test that only needed a spawnable mock. Keep skips only for: tests asserting POSIX-absolute candidate paths (`POSIX_PATHS_SKIP`), the `~`-expansion test (POSIX `HOME` semantics), and `test_install.py` (bash).

- [ ] **Step 6.4: Verify the count.** Record the skip count on Windows in the PR description. Acceptance: 0 failures and materially fewer skips than Hermes's 28.

- [ ] **Step 6.5: Gate + commit.** The decisive check is `--self-test` on a machine that has a real sidecar installed:

```bash
cd integrations/claude-code
python -m unittest discover -s tests
python scripts/ct_doctor.py --self-test     # must exit 0 with CT installed
```

```bash
git commit -m "test(claude-code): make the suite hermetic against a real sidecar install"
```

---

## Task 7: Skills

**Files:**
- Create: `integrations/claude-code/skills/usage/SKILL.md`
- Create: `integrations/claude-code/skills/ops/SKILL.md`
- Create: `integrations/claude-code/skills/sidecar/SKILL.md`
- Create: `integrations/claude-code/tests/test_skills_content.py`

**Step-by-step:**

- [ ] **Step 7.1: Copy the three bodies verbatim** from `integrations/hermes/skills/curated-thoughts-{usage,ops,sidecar}/SKILL.md` into the new directory names. Frontmatter depends on the maintainer's answer to Q2, which must be recorded on the spec PR **before this step starts** (do not start on the recommendation alone):
  - Q2 = recommendation (spec D2): drop the frontmatter `name:` key so Claude Code takes the name from the directory; keep `description:` unchanged.
  - Q2 = keep frontmatter identical: copy the frontmatter byte-for-byte too.

  Either way the **body** is identical, and Step 7.3's equality test strips frontmatter before comparing, so the only thing Q2 changes is the frontmatter assertion in 7.3.

- [ ] **Step 7.2: Rewrite one paragraph in `ops/SKILL.md`.** "Registration in Hermes" → "Registration in Claude Code": `~/.claude.json` under `mcpServers`, `/mcp` to verify the server is connected, plugin enablement via `--plugin-dir` or the marketplace, and a note that a project-level `.mcp.json` is equally valid. Also rewrite check 7's description in the numbered list, which names `mcp_servers` / `plugins.enabled`, in Claude Code terms. Keep the item's `7. **Harness registration** —` prefix exactly: Step 7.3's normalizer keys on it, as does deepseek's. Keep the section heading in the form `## Registration in Claude Code` for the same reason. Everything else in the file stays byte-identical.

- [ ] **Step 7.3: Write `tests/test_skills_content.py`,** porting `integrations/deepseek/tests/test_skills_content.ts`. The load-bearing assertion is **body equality with Hermes**, not substring presence:
  - for each pair (`usage`↔`curated-thoughts-usage`, `ops`↔`curated-thoughts-ops`, `sidecar`↔`curated-thoughts-sidecar`), strip frontmatter from both files, apply a `normalize_harness_specific()` that is a line-for-line port of deepseek's `normalizeHarnessSpecific` (the doctor-invocation sentence, check-list item 7, the `## Registration in <Harness>` section), and `assertEqual` the results. Anything outside those three rules must be byte-identical;
  - port the guard that normalization is not a no-op-everything: `normalize(body + "\nstray\n") != normalize(body)`;
  - read the Hermes files by **path** (`Path(__file__).resolve().parents[2] / "hermes" / "skills"`), never by import. Use `skipUnless(<that dir>.is_dir())` because the release tarball ships `tests/` without the sibling tree;

  plus the structural checks:
  - all three files exist and open with YAML frontmatter carrying a non-empty `description` (and, per Q2, either no `name:` key or a `name:` equal to Hermes's);
  - the three rules appear somewhere across the set: "one sidecar" (per brain), "never touch the vault out-of-band", "fail open";
  - no `~/.hermes` and no `config.yaml` string survives anywhere;
  - no absolute or drive-letter path appears (same shape of check the architecture gate applies to `.py`);
  - `usage` still names the routing preference (`wiki_context` before raw searches), since the hook's routing reminder and this skill must not drift apart.

- [ ] **Step 7.4: Gate + commit.**

```bash
cd integrations/claude-code && python -m unittest discover -s tests
grep -rn "hermes" skills/ -i          # expect: no hits
```

```bash
git commit -m "feat(claude-code): add the usage, ops and sidecar skills"
```

---

## Task 8: README, CHANGELOG, version

**Files:**
- Modify: `integrations/claude-code/README.md`
- Modify: `integrations/claude-code/CHANGELOG.md`
- Modify: `README.md` (repo root — via the generator)

**Step-by-step:**

- [ ] **Step 8.1: Write the README,** mirroring `integrations/deepseek/README.md`: what you get (the four layers), install (the `install.sh` run and the `claude mcp add` line), verify (`ct_doctor.py check`, `/mcp`, `/hooks`, `/curated-thoughts:usage`), compatibility (sidecar `>=2.5`, tier `v2.5-full`, OS support), license. Include the Windows note that the sidecar path contains a space and must be quoted.

- [ ] **Step 8.2: Add the `## 0.1.0 — <date>` CHANGELOG section,** describing the four layers. The heading format is load-bearing — it becomes the GitHub Release body for the `claude-code-v0.1.0` tag.

- [ ] **Step 8.3: Refresh the root README table.**

```bash
python tools/ct_ci.py readme
python tools/ct_ci.py readme --check
```

- [ ] **Step 8.4: Confirm the version gate.**

```bash
python tools/ct_ci.py policy --base origin/main
```

Expected: `ok [versions]` — `integration.yaml` `0.1.0` agrees with `.claude-plugin/plugin.json` `0.1.0`, and the CHANGELOG has a matching section.

- [ ] **Step 8.5: Commit.**

```bash
git commit -m "docs(claude-code): README and CHANGELOG for the v0.1.0 release"
```

---

## Task 9: End-to-end dogfood (human + agent together)

**Files:** none. This is the acceptance run, on a real machine with Curated Thoughts installed.

The agent prepares and explains the commands; **the human runs anything that touches `~/.claude.json`, `~/.claude/settings.json`, or installs software.**

- [ ] **Step 9.1: Close the Curated Thoughts desktop app** so the `brain.db` WAL is flushed and the lock released. A running app both holds the lock and (on first launch after 2.10.x) runs the V18 repair migration.

- [ ] **Step 9.2 (B1): Doctor before registering.**

```bash
python integrations/claude-code/scripts/ct_doctor.py check
```

Expected: checks 1–6 PASS/WARN as appropriate, **7 FAIL** with a hint printing the exact `claude mcp add` line, 8 PASS, 9 PASS. Exit 1.

- [ ] **Step 9.3 (B2): Installer, no env.**

```bash
bash integrations/claude-code/scripts/install.sh
```

Expected: prints the `claude mcp add` line and JSON block; `claude mcp list` still does not show `curated-thoughts`. Nothing written.

- [ ] **Step 9.4 (B3): Installer with the opt-in.**

```bash
CT_INSTALL_EDIT=1 bash integrations/claude-code/scripts/install.sh
```

Expected: `claude mcp list` now shows `curated-thoughts` with the **absolute** `.exe` path including the space, `--mcp` in the args, and status **connected** — the connection is what proves the quoting survived. A second run says "already present — nothing changed".

- [ ] **Step 9.5 (B4): Doctor again.** All nine PASS (an embedding WARN is acceptable). Exit 0 or 2.

- [ ] **Step 9.6 (B5–B7): Load the plugin.**

```bash
claude --plugin-dir "<abs path>/integrations/claude-code"
```

Then in-session: `/mcp` shows `curated-thoughts` connected with the live tool count (16 on 2.10.1); `/hooks` shows a `SessionStart` entry from plugin `curated-thoughts`. Restart with `--debug` and confirm the hook exits 0 and injects context starting with `## Curated Thoughts`.

- [ ] **Step 9.7 (B8–B10): Behavioural checks.** Ask what it knows about CT memory status (it should quote the injected snapshot without a tool call); ask it to recall something from the test vault (it should reach for `wiki_context` / `curated_recall_context` before raw `vault_semantic_search`); run `/curated-thoughts:usage`, `:ops`, `:sidecar`.

- [ ] **Step 9.8 (B11–B12): Break it on purpose.** Point `CURATED_BRAIN_DIR` at a nonexistent directory → the session still starts, the context says DEGRADED and names the missing directory, and the doctor FAILs `brain-dir`. Then rename the sidecar `.exe` → the session still starts, `/mcp` shows the server failed, the hook context says the sidecar was not found. **Restore the file.**

- [ ] **Step 9.9 (B13): Timing.** `python hooks/session-start.py < /dev/null` prints one JSON line, exits 0, well under 1 s.

- [ ] **Step 9.10: Run the full automated set** (A1–A12 in the spec's sibling acceptance table), then open the PR:

```bash
gh pr create --title "feat(claude-code): Claude Code integration plugin" --body "…"
```

The body references the spec PR and pastes the B-table outputs from the real machine — the maintainer dogfooded Hermes the same way (PR #6). Also include: `grep -rn "hermes" integrations/claude-code -i` showing only provenance comments, and the Windows skip count from Task 6.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Implemented by |
|---|---|
| §2 Layout | Tasks 1, 2, 4, 5, 7 |
| §3 Plugin shape (manifest, hooks.json, skills) | Task 1 (manifest), Task 4 (hooks.json), Task 7 (skills) |
| §4 Install path / registration | Task 5 (`install.sh`), Task 3 (the check that verifies it) |
| §5 Status probe + hook | Task 2 (`ct_status.py` copy), Task 4 (the adapter) |
| §6 Import pre-flight | Task 2 (byte-identical copy) |
| §7 Doctor, nine checks | Task 3 |
| §8 Installer | Task 5 |
| §9 Skills | Task 7 |
| §10 Testing and CI | Tasks 1, 2 (matrix + gates), Task 6 (hermetic/Windows) |
| §11 Decisions D1–D5 | D1 → Task 5; D2 → Task 7; D3 → Task 4; D4 → Task 3; D5 → Task 1 |
| §11 Q4 (compat tier), Q5 (`install_kind`) | Deliberately out of scope — recorded as maintainer questions, not code |
| §12 Checklist | This plan's Tasks 1–9 |

No spec gaps.

**2. Ordering dependencies:** Task 2 must precede Task 3 (the doctor imports `ct_env`, `ct_preflight`, `_compat_generated`). Task 2 must precede Task 4 (the hook imports `ct_status`). Task 3 must precede Task 6 (Task 6 edits the doctor's test module). Task 8's version gate needs Tasks 1 and 2 done (both halves of the mirror). Task 9 needs everything.

**3. Known red-until-fixed states:** after Task 2 the doctor test classes fail because `ct_doctor.py` does not exist. This is the only intentionally-red intermediate state, and Task 3 closes it. Every other task ends with all gates green.

**4. Open items carried from the spec:** Q1 (registration mechanism) gates Task 5's shape; Q2 (skill frontmatter fidelity) gates Task 7's Step 7.1; Q3 (WARN vs FAIL for unconfirmable enablement) gates Task 3's Step 3.3. All three must be answered on the spec PR before the corresponding task starts. Q6 (the Hermes repo-wide `CLAUDE_PLUGIN_ROOT` guard) is resolved by design, not by an answer: the hook resolves its location from `__file__` and never reads the variable (Step 4.2), so no Hermes file changes and Task 4 is unblocked.

**5. Placeholder scan:** no "TBD" or unfilled blocks. Every step names the file it touches and the command that proves it worked.
