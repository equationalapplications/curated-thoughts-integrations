# Shared env view, doctor re-sync and script parity gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #32 and #33: hoist the env merge into `ct_env.merged_env`, make `ct_status.snapshot` merge, re-sync the Claude Code doctor with Hermes, gate shared-script drift in CI, and keep tool caches out of release tarballs.

**Architecture:** `ct_env.merged_env` is the one env-view builder. Public entry points merge once, and `ct_env` primitives consume views as they are. The shared scripts are byte-identical across hermes and claude-code, except for three marked regions in `ct_doctor.py`. A `tests/tools` gate (it runs on every PR) enforces that. The packager filters cache directories centrally.

**Tech Stack:** Python 3.9+ stdlib, `unittest`, ruff (correctness subset).

**Spec:** `docs/superpowers/specs/2026-10-16-shared-env-doctor-parity-design.md`

## Global Constraints

- Stdlib only in shipped scripts (CONTRIBUTING rule 4); Python 3.9 compatible.
- `ct_env.merged_env(env=None) -> dict`: None value = missing (ambient shows), `""` = suppression, fresh copy always.
- Region markers: `# >>> harness-specific: <name>` / `# <<< harness-specific: <name>`; closed list `module-docstring`, `harness-config`, `registration-check` (ct_doctor.py only).
- No version bumps, no tags; CHANGELOG entries under `## Unreleased`.
- Do not touch `integrations/{opencode,deepseek,openclaw}` or `packages/`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

- Modify `integrations/hermes/scripts/ct_env.py` — add `merged_env`; neutral docstring.
- Modify `integrations/hermes/scripts/ct_status.py` — snapshot merges; neutral docstring.
- Modify `integrations/hermes/scripts/ct_preflight.py` — parity pointer in docstring.
- Modify `integrations/hermes/scripts/ct_doctor.py` — `_merged_env` delegates; region markers; `HARNESS_LABEL`; `_check_registration`; `run_checks(cwd=None)`.
- Overwrite `integrations/claude-code/scripts/{ct_env,ct_status,ct_preflight}.py` with the hermes copies.
- Rewrite `integrations/claude-code/scripts/ct_doctor.py` = hermes shared body + CC regions.
- Modify both `tests/test_ct_doctor.py` — `MergedEnvTests`, snapshot-merge test; CC: fixture simplification + ported env/gate tests.
- Create `tests/tools/test_shared_script_parity.py` — the gate.
- Modify `tools/ct_ci_package.py`, `tests/tools/test_ct_ci_package.py` — central cache filter.
- Modify both CHANGELOGs.

---

### Task 1: `ct_env.merged_env` + `ct_status.snapshot` merge (hermes)

**Files:** Modify `integrations/hermes/scripts/ct_env.py`, `ct_status.py`, `ct_doctor.py:180-197`; Test `integrations/hermes/tests/test_ct_doctor.py`.

**Interfaces:** Produces `ct_env.merged_env(env=None) -> dict`.

- [ ] **Step 1: Failing tests** (append before `ReviewRegressionTests`):

```python
class MergedEnvTests(unittest.TestCase):
    """ct_env.merged_env: the one spawn-time env view (issue #32)."""

    def setUp(self):
        self._saved = dict(os.environ)
        self.addCleanup(self._restore)
        os.environ["CT_MERGE_AMBIENT"] = "ambient"

    def _restore(self):
        os.environ.clear()
        os.environ.update(self._saved)

    def test_none_env_is_a_copy_of_ambient(self):
        view = ct_env.merged_env()
        self.assertEqual(view, dict(os.environ))
        view["CT_MERGE_AMBIENT"] = "mutated"
        self.assertEqual(os.environ["CT_MERGE_AMBIENT"], "ambient")

    def test_missing_key_shows_ambient(self):
        self.assertEqual(ct_env.merged_env({"OTHER": "x"})["CT_MERGE_AMBIENT"], "ambient")

    def test_none_value_means_not_specified(self):
        view = ct_env.merged_env({"CT_MERGE_AMBIENT": None, "CT_MERGE_NEW": None})
        self.assertEqual(view["CT_MERGE_AMBIENT"], "ambient")
        self.assertNotIn("CT_MERGE_NEW", view)
        self.assertNotIn(None, view.values())

    def test_empty_string_suppresses_ambient(self):
        self.assertEqual(ct_env.merged_env({"CT_MERGE_AMBIENT": ""})["CT_MERGE_AMBIENT"], "")

    def test_caller_value_wins(self):
        self.assertEqual(ct_env.merged_env({"CT_MERGE_AMBIENT": "caller"})["CT_MERGE_AMBIENT"], "caller")

    def test_caller_env_is_not_mutated(self):
        env = {"CT_MERGE_AMBIENT": None}
        ct_env.merged_env(env)
        self.assertEqual(env, {"CT_MERGE_AMBIENT": None})

    def test_doctor_delegate_matches(self):
        env = {"CT_MERGE_AMBIENT": "", "X": None}
        self.assertEqual(ct_doctor._merged_env(env), ct_env.merged_env(env))
```

and in `StatusSnapshotTests`:

```python
    def test_snapshot_env_merges_over_ambient(self):
        # Issue #32: an env arg used to REPLACE the view (no HOME, no PATH).
        self.make_brain()
        other = self.fake_home / "other-brain"
        snap = ct_status.snapshot(env={"CURATED_BRAIN_DIR": str(other)})
        self.assertEqual(snap["brain_dir"], str(other))
        from unittest import mock
        seen = {}
        real = ct_env.find_sidecar
        def spy(platform=None, env=None):
            seen["env"] = env
            return real(platform=platform, env=env)
        with mock.patch.object(ct_env, "find_sidecar", side_effect=spy):
            ct_status.snapshot(env={"CURATED_BRAIN_DIR": str(other)})
        self.assertEqual(seen["env"].get("HOME"), os.environ.get("HOME"))
        self.assertEqual(seen["env"].get("PATH"), os.environ.get("PATH"))
```

- [ ] **Step 2:** `cd integrations/hermes && python -m unittest tests.test_ct_doctor -k MergedEnv -k snapshot_env` → FAIL (`merged_env` missing; HOME absent).
- [ ] **Step 3: Implement** in `ct_env.py` (after `_expand`):

```python
def merged_env(env=None):
    """Ambient os.environ with `env` overlaid — the spawn-time env view.
    ... (None / "" / missing contract + no-PATH-key trade-off, see spec D1)
    """
    merged = dict(os.environ)
    if env:
        merged.update({k: v for k, v in env.items() if v is not None})
    return merged
```

`ct_doctor._merged_env` body → `return ct_env.merged_env(env)`. `ct_status.snapshot`: `view = ct_env.merged_env(env)` inside the try, and pass `view` to both calls.
- [ ] **Step 4:** Full hermes suite → PASS.
- [ ] **Step 5:** Commit `refactor(hermes): hoist env merge into ct_env.merged_env; snapshot merges (#32)`.

### Task 2: Hermes doctor regions + shared run_checks shape

**Files:** Modify `integrations/hermes/scripts/ct_doctor.py`, `ct_env.py`, `ct_status.py`, `ct_preflight.py` (docstrings only).

**Interfaces:** Produces `run_checks(timeout=MCP_TIMEOUT, env=None, cwd=None)`, `_check_registration(cwd=None)`, `HARNESS_LABEL`.

- [ ] **Step 1: Failing test** (hermes `FullRunTests`):

```python
    def test_run_checks_accepts_cwd_and_routes_registration_through_adapter(self):
        from unittest import mock
        self.make_brain(); self.write_config()
        with mock.patch.object(ct_doctor, "_check_registration",
                               wraps=ct_doctor._check_registration) as spy:
            ct_doctor.run_checks(timeout=3.0, env=self.with_path(), cwd=str(self.fake_home))
        spy.assert_called_once_with(cwd=str(self.fake_home))
```

- [ ] **Step 2:** Run → FAIL (unexpected kwarg `cwd`).
- [ ] **Step 3:** Wrap the docstring, config block and registration block in markers. Add `HARNESS_LABEL = "Hermes"` and `def _check_registration(cwd=None): return check_hermes_registration()`. Add `cwd=None` to `run_checks` and call `_check_registration(cwd=cwd)`. Use the argparse description `f"Curated Thoughts {HARNESS_LABEL} plugin doctor (read-only)."` and the generic `_self_test_suite` comment. Give the docstrings of the three other shared scripts neutral wording plus the parity pointer.
- [ ] **Step 4:** Hermes suite + `python scripts/ct_doctor.py --self-test` → PASS.
- [ ] **Step 5:** Commit `refactor(hermes): mark harness-specific doctor regions; shared run_checks(cwd=)`.

### Task 3: Parity gate (fails first against the stale claude-code copies)

**Files:** Create `tests/tools/test_shared_script_parity.py`.

- [ ] **Step 1: Write the gate:**

```python
REPO = Path(__file__).resolve().parents[2]
HERMES = REPO / "integrations" / "hermes" / "scripts"
CLAUDE = REPO / "integrations" / "claude-code" / "scripts"
IDENTICAL = ("ct_env.py", "ct_status.py", "ct_preflight.py")
REGIONED = {"ct_doctor.py": ("module-docstring", "harness-config", "registration-check")}
BEGIN = re.compile(r"^# >>> harness-specific: ([a-z0-9-]+)$")
END = re.compile(r"^# <<< harness-specific: ([a-z0-9-]+)$")

def normalize(text, allowed):
    """Collapse each marked region to a placeholder; return (text, names)."""
    out, names, open_ = [], [], None
    for n, line in enumerate(text.replace("\r\n", "\n").split("\n"), 1):
        b, e = BEGIN.match(line), END.match(line)
        if b:
            if open_: raise ValueError(f"line {n}: nested region {b.group(1)!r} inside {open_!r}")
            if b.group(1) not in allowed: raise ValueError(f"line {n}: unknown region {b.group(1)!r}")
            if b.group(1) in names: raise ValueError(f"line {n}: region {b.group(1)!r} used twice")
            open_ = b.group(1); names.append(open_); out.append(f"# [harness-specific: {open_}]")
        elif e:
            if e.group(1) != open_: raise ValueError(f"line {n}: end {e.group(1)!r} does not close {open_!r}")
            open_ = None
        elif open_ is None:
            out.append(line)
    if open_: raise ValueError(f"region {open_!r} never closed")
    return "\n".join(out), names
```

Tests: identical files equal (unified diff on failure); regioned equal + same names == allowed tuple; anti-no-op guards (stray line, unknown name, unbalanced, nested).
- [ ] **Step 2:** `python -m unittest discover -s tests/tools -p "test_shared_script_parity.py"` → FAIL on all four files (expected: claude-code is stale).
- [ ] **Step 3:** No implementation in this task; Task 4 makes it pass. Commit together with Task 4.

### Task 4: Re-sync claude-code scripts

**Files:** Overwrite `integrations/claude-code/scripts/{ct_env,ct_status,ct_preflight}.py` from hermes. Rewrite `integrations/claude-code/scripts/ct_doctor.py` as the hermes file with its three regions replaced by the claude-code ones (spec D3 table). `_read_json_file` moves into `registration-check`. `_plugin_version` reads `.claude-plugin/plugin.json` via `json`. `HARNESS_LABEL = "Claude Code"`. `_check_registration(cwd=None)` returns `check_claude_code_registration(cwd=cwd)`.

- [ ] **Step 1:** Generate the file mechanically (scratch script: hermes text with regions spliced from a CC regions file), then hand-review the diff vs the old CC copy. Only intended changes should appear.
- [ ] **Step 2:** Parity gate → PASS.
- [ ] **Step 3:** claude-code suite: expect failures only where tests encoded the stale API (`OLLAMA_HOST` module constant, `find_sidecar()` no-env). Fix in Task 5.
- [ ] **Step 4:** Commit `fix(claude-code): re-sync shared scripts with Hermes post-#14; add parity gate (#33)`.

### Task 5: claude-code test fixture + ported tests

**Files:** Modify `integrations/claude-code/tests/test_ct_doctor.py`.

- [ ] **Step 1:** Delete `_scrub_path`/`SCRUBBED_PATH` and the `shutil` import if unused. POSIX mock = `#!/bin/sh\nexec "<sys.executable>" "<bin_dir>/mock_sidecar.py" "$@"\n` (shell-quoted with `shlex.quote`). Patch process PATH to `str(self.bin_dir)`. `results_by_name`/`with_path` use `{"PATH": str(self.bin_dir)}`. Add the setUp discovery precondition (all platforms).
- [ ] **Step 2:** Add `MergedEnvTests`, `test_snapshot_env_merges_over_ambient`, `FindSidecarWrapperTests`, the embedding env tests, a brain-dir env test, and a `BundledFallbackGuardTests` subset (gated warn+no spawn, empty-string PATH gated, ALLOW_BUNDLED exact "1", path-None no gate [POSIX], version-compat single PASS). Each is copied from hermes with `write_config` adapted to JSON.
- [ ] **Step 3:** claude-code suite → PASS; hermes suite → PASS.
- [ ] **Step 4:** Commit `test(claude-code): drop SCRUBBED_PATH; port env-view and #28 gate tests`.

### Task 6: Central cache filter in the packager

**Files:** Modify `tools/ct_ci_package.py`, `tests/tools/test_ct_ci_package.py`.

- [ ] **Step 1: Failing tests:**

```python
class TestCacheFiltering(unittest.TestCase):
    PLANTED = (".ruff_cache/0.16.9/abc", "__pycache__/m.cpython-313.pyc",
               "scripts/__pycache__/x.pyc", ".pytest_cache/v/cache/nodeids",
               ".mypy_cache/3.13/x.json", "top.pyc", "sub/.ruff_cache/y")
    def _tree(self, tmp):
        d = Path(tmp)
        for rel in self.PLANTED + ("scripts/ct_doctor.py", "README.md"):
            p = d / rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_text("x")
        return d
    def test_caches_never_selected_regardless_of_manifest(self):
        for name in ("hermes", "claude-code", None):
            package = {} if name is None else ct_ci_manifest.load_manifest(
                REPO / "integrations" / name / "integration.yaml").get("package") or {}
            with self.subTest(manifest=name), tempfile.TemporaryDirectory() as tmp:
                rels = [rel for _p, rel in ct_ci_package._selected_files(self._tree(tmp), package)]
                self.assertEqual(sorted(rels), ["README.md", "scripts/ct_doctor.py"])
    def test_build_tarball_has_no_cache_dirs(self): ...  # temp repo with integrations/x/integration.yaml
```

- [ ] **Step 2:** Run → FAIL (`.ruff_cache` selected for the manifests; everything selected for `{}`).
- [ ] **Step 3:** Add `CACHE_DIR_NAMES` and `CACHE_SUFFIXES = (".pyc", ".pyo")`, and skip such files first in `_selected_files`.
- [ ] **Step 4:** `python -m unittest discover -s tests/tools` → PASS.
- [ ] **Step 5:** Commit `fix(ci): packager drops tool caches centrally (.ruff_cache et al.) (#33)`.

### Task 7: CHANGELOGs, verification, PR

- [ ] Add `## Unreleased` entries (hermes: merged_env, snapshot merge, run_checks cwd; claude-code: doctor re-sync incl. #28 gate, parity, `snapshot` merge).
- [ ] Verify: both integration suites, `tests/tools`, `ruff check --select E9,F63,F7,F82,F401 .` (root + each integration), `python tools/ct_ci.py validate`, `generate --check`, hermes `--self-test`.
- [ ] Push. `gh pr create` with "Closes #32" and "Closes #33", the note on the version-gate bump, and the untouched minor findings.
