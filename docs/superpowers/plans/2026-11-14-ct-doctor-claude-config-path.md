# ct_doctor HOME-root config path — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ct_doctor.py` stops failing healthy installs — with `CLAUDE_CONFIG_DIR` unset it reads the Claude Code user-scope config from `~/.claude.json` at the HOME root, where Claude Code actually writes it.

**Architecture:** replace the `.claude.json` default expression with a `_claude_config_path()` resolver (env override → `CLAUDE_CONFIG_DIR` relocation → HOME-root default), re-point the module constant and the test fixture's re-resolution at it, and pin the behavior with three new tests. `_claude_config_dir()` and `settings.json` resolution are untouched.

**Tech Stack:** Python 3 stdlib only; `unittest` suite in `integrations/claude-code/tests/test_ct_doctor.py`.

**Spec:** `docs/superpowers/specs/2026-11-14-ct-doctor-claude-config-path-design.md` (the plan argues from the spec; executors read both)

## Global Constraints

- Verdict contract unchanged: no registration at all stays FAIL; unparseable config stays WARN (spec, rejected alternatives).
- `CLAUDE_CONFIG_PATH` stays a test-only override of just the `.claude.json` file; `CLAUDE_CONFIG_DIR` still relocates the whole config (both files) — existing documented semantics; Task 1's third test pins the `.claude.json` side only (the `settings.json` relocation is unchanged behavior, not newly pinned).
- `settings.json` resolution unchanged (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`).
- No new dependency; stdlib only (INTENT rule 6, spec alignment).
- Version bump lands in this PR at merge time: `integration.yaml` `version:` and `.claude-plugin/plugin.json` `"version"` must both be `0.4.4` (the CI policy gate "versions" enforces the `version_mirror` pair).
- All test runs use the real interpreter: `python3 integrations/claude-code/tests/test_ct_doctor.py` must exit 0 and print a passing summary that is READ, not assumed.

---

### Task 1: HOME-root default resolution, pinned by tests (RED → GREEN)

**Files:**
- Modify: `integrations/claude-code/scripts/ct_doctor.py` (lines ~50–83: harness-config comment block, `_claude_config_dir()`, `CLAUDE_CONFIG`)
- Modify: `integrations/claude-code/tests/test_ct_doctor.py` (fixture re-resolution in `setUp` ~line 216 and `_cleanup` ~line 237; new helper + 3 tests near the registration tests ~line 684)
- Test: `integrations/claude-code/tests/test_ct_doctor.py`

**Interfaces:**
- Consumes: existing `DoctorTestCase` fixture (`patch_env`, `write_config`, `write_settings`, `check()` → `ct_doctor.check_claude_code_registration(cwd=self.fake_home)`).
- Produces: `ct_doctor._claude_config_path() -> Path` (no args; reads ambient env at call time; returns the override, `$CLAUDE_CONFIG_DIR/.claude.json`, or `Path.home() / ".claude.json"`). Task 2 and the fixture depend on this exact name.

- [ ] **Step 1: Write the failing tests + fixture re-pointing**

In `tests/test_ct_doctor.py`:

(a) In `setUp`, replace the manual constant re-resolution:

```python
        ct_doctor.CLAUDE_CONFIG = Path(os.environ["CLAUDE_CONFIG_PATH"])
```

with:

```python
        ct_doctor.CLAUDE_CONFIG = ct_doctor._claude_config_path()
```

(b) In `_cleanup`, replace:

```python
        ct_doctor.CLAUDE_CONFIG = Path(
            os.environ.get(
                "CLAUDE_CONFIG_PATH", str(Path.home() / ".claude.json")
            )
        )
```

with:

```python
        ct_doctor.CLAUDE_CONFIG = ct_doctor._claude_config_path()
```

(c) Add a helper and three tests next to the other registration tests (after `test_local_scope_registration_under_projects_is_a_pass`):

```python
    def _use_default_config_resolution(self):
        """Drop the fixture's CLAUDE_CONFIG_PATH override; re-resolve."""
        self.patch_env("CLAUDE_CONFIG_PATH", None)
        self.patch_env("CLAUDE_CONFIG_DIR", None)
        ct_doctor.CLAUDE_CONFIG = ct_doctor._claude_config_path()

    def test_default_config_resolution_is_the_home_root_file(self):
        # Issue #93: with no CLAUDE_CONFIG_DIR, Claude Code writes
        # user-scope mcpServers into ~/.claude.json at the HOME root,
        # never ~/.claude/.claude.json. The doctor must look there.
        self._use_default_config_resolution()
        self.assertEqual(
            ct_doctor.CLAUDE_CONFIG, self.fake_home / ".claude.json"
        )
        self.write_config()
        self.write_settings()
        r = self.check()
        self.assertEqual(r.status, ct_doctor.PASS, r.detail)
        self.assertIn(str(self.fake_home / ".claude.json"), r.detail)

    def test_default_fail_names_the_home_root_path(self):
        self._use_default_config_resolution()
        r = self.check()
        self.assertEqual(r.status, ct_doctor.FAIL)
        self.assertIn(str(self.fake_home / ".claude.json"), r.detail)
        self.assertNotIn(
            str(self.fake_home / ".claude" / ".claude.json"), r.detail
        )

    def test_claude_config_dir_relocates_the_config(self):
        # Pin the existing CLAUDE_CONFIG_DIR semantics for the user-scope
        # config: .claude.json follows into the custom directory. (The
        # settings.json relocation is unchanged existing behavior and is
        # not re-pinned here.)
        self.patch_env("CLAUDE_CONFIG_PATH", None)
        custom = self.fake_home / "custom"
        custom.mkdir()
        self.patch_env("CLAUDE_CONFIG_DIR", str(custom))
        ct_doctor.CLAUDE_CONFIG = ct_doctor._claude_config_path()
        self.assertEqual(ct_doctor.CLAUDE_CONFIG, custom / ".claude.json")
        (custom / ".claude.json").write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "curated-thoughts": {
                            "command": str(self.mock_path),
                            "args": ["--mcp"],
                        }
                    }
                }
            )
        )
        self.write_settings()
        r = self.check()
        self.assertEqual(r.status, ct_doctor.PASS, r.detail)
        self.assertIn(str(custom / ".claude.json"), r.detail)
```

- [ ] **Step 2: Run to verify RED**

Run: `python3 integrations/claude-code/tests/test_ct_doctor.py`
Expected: FAIL/error — `AttributeError: module 'ct_doctor' has no attribute '_claude_config_path'` (fixture calls the function before it exists). Read the output; do not assume.

Sanity sub-step (TDD evidence — the AttributeError alone doesn't demonstrate the bug): temporarily stub the resolver to the OLD expression
(`def _claude_config_path(): return Path.home() / ".claude" / ".claude.json"`),
re-run, and confirm tests 1 and 2 now FAIL on their path assertions while test 3 still passes; then remove the stub. This proves the new tests actually catch the HOME-root defect.

- [ ] **Step 3: Implement the resolver (minimal GREEN)**

In `scripts/ct_doctor.py`, replace the `CLAUDE_CONFIG` assignment (lines ~78–83):

```python
CLAUDE_CONFIG = Path(
    os.environ.get(
        "CLAUDE_CONFIG_PATH", str(_claude_config_dir() / ".claude.json")
    )
)
```

with:

```python
def _claude_config_path():
    """The .claude.json Claude Code actually reads and writes.

    Claude Code keeps user-scope `mcpServers` in `.claude.json`. With
    CLAUDE_CONFIG_DIR set, that file is `$CLAUDE_CONFIG_DIR/.claude.json`.
    Without it, Claude Code writes `~/.claude.json` in the HOME root —
    `~/.claude/` holds settings.json and plugin data, never `.claude.json`
    (issue #93). CLAUDE_CONFIG_PATH remains a test-only override of just
    this file.
    """
    override = os.environ.get("CLAUDE_CONFIG_PATH")
    if override:
        return Path(override)
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    if config_dir:
        return Path(config_dir) / ".claude.json"
    return Path.home() / ".claude.json"


CLAUDE_CONFIG = _claude_config_path()
```

Also, in the same edit: (a) trim the now-duplicated comment block at lines ~76–78
("User-scope MCP servers: ... in production.") to a one-line pointer at the new
docstring, and (b) append one sentence to the `_claude_config_path()` docstring:
an empty `CLAUDE_CONFIG_DIR` or `CLAUDE_CONFIG_PATH` counts as unset here,
while `_claude_config_dir()` treats any value (including empty) as set — a
harmless asymmetry on a value no real Claude Code install ever sets (review
cycle 1, MINOR 4).

And rewrite the harness-config comment block above `_claude_config_dir()` (lines ~50–67): keep the `CLAUDE_CONFIG_DIR` relocation and ambient-env-at-import paragraphs, replace the last sentence ("Without CLAUDE_CONFIG_DIR set, the directory is ~/.claude, the same default Claude Code uses.") with: without `CLAUDE_CONFIG_DIR` the config *directory* defaults to `~/.claude` for `settings.json` and plugin data, while `.claude.json` itself sits in the HOME root — that split is what `_claude_config_path()` encodes (issue #93).

- [ ] **Step 4: Run the whole suite to verify GREEN**

Run: `python3 integrations/claude-code/tests/test_ct_doctor.py`
Expected: exit 0, all tests PASS including the 3 new ones. READ the summary line.

- [ ] **Step 5: Commit**

```bash
git add integrations/claude-code/scripts/ct_doctor.py integrations/claude-code/tests/test_ct_doctor.py
git commit -m "fix(claude-code): ct_doctor reads the user-scope config from the HOME root (#93)"
```

---

### Task 2: Version bump 0.4.4 + CHANGELOG

**Files:**
- Modify: `integrations/claude-code/integration.yaml:13` (`version: 0.4.3` → `version: 0.4.4`)
- Modify: `integrations/claude-code/.claude-plugin/plugin.json:3` (`"version": "0.4.3"` → `"version": "0.4.4"`)
- Modify: `integrations/claude-code/CHANGELOG.md` (new section between `## Unreleased` and `## 0.4.3 — 2026-10-17`)

**Interfaces:**
- Consumes: Task 1's merged behavior (the entry describes it).
- Produces: nothing downstream; the CI policy gate ("versions") re-checks the `version_mirror` pair.

- [ ] **Step 1: Bump both version surfaces to 0.4.4** (exact strings above; both files, no others — no `package.json` exists in this integration)

- [ ] **Step 2: Add the CHANGELOG section** (heading format is load-bearing — `## <version> — <date>`):

```markdown
## 0.4.4 — 2026-11-14

- Fixed: `ct_doctor.py check` no longer reports a false
  `claude-code-registration` FAIL on healthy installs. With
  `CLAUDE_CONFIG_DIR` unset the doctor now reads the user-scope config
  from `~/.claude.json` in the HOME root — where Claude Code actually
  writes it — instead of `~/.claude/.claude.json` (#93).
```

- [ ] **Step 3: Sanity-run the suite once more** (`python3 integrations/claude-code/tests/test_ct_doctor.py`, expect exit 0 — the manifest/mirror tests are in `tests/test_manifest.py`, run by CI)

- [ ] **Step 4: Commit**

```bash
git add integrations/claude-code/integration.yaml integrations/claude-code/.claude-plugin/plugin.json integrations/claude-code/CHANGELOG.md
git commit -m "chore(release): bump claude-code 0.4.4 — ct_doctor HOME-root config path (#93)"
```

---

### Task 3: Verify, flip ready, merge-lane handoff

- [ ] **Step 1: Push and confirm CI fully green on the PR head** (`gh pr checks --watch` until every required check passes; read the final state, do not assume).
- [ ] **Step 2: Update the PR body's Spec section** (spec approved; implementation landed).
- [ ] **Step 3: Independent review pass per the review ladder, then request Kurt's review-and-merge approval.** Merge is a merge commit (repo forbids squash/rebase). After merge: close #93, add the delivery-board row, write the vault session record, and re-run the release-drift audit — the new 0.4.4 bump adds a fourth untagged ladder (claude-code) to the deferred tag batch.
