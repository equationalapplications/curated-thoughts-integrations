# Hermes activity delivery split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Hermes-only `transform_tool_result` delivery out of the shared `ct_wisdom_activity.py` into a
Hermes-only `ct_wisdom_activity_delivery.py`, with no behavior change. The shared builder stays byte-identical in
hermes, claude-code and docker-agent.

**Architecture:** A one-off split script (run from the scratchpad, never committed) cuts the module at its section
markers. The builder keeps constants, targets, `activity_for`, `query_for`, render and splice. The delivery module
gets the state, prefetch, breaker, `proves_ran`, `_transform` and `_deliver`, and calls builder names as
`builder.<name>`. Tests are re-pointed mechanically, and the parity gate learns the new boundary.

**Tech Stack:** Python 3 stdlib, `unittest`; `uvx ruff` for the lint CI runs (`ruff check --select E9,F63,F7,F82,F401 .`).

**Spec:** `docs/superpowers/specs/2026-10-17-hermes-activity-delivery-split-design.md`

## Global Constraints

- No behavior change: same queries, skip classes, blocks and splice. Every existing test keeps its assertions.
- Shared builder file name stays `ct_wisdom_activity.py`; the new Hermes-only file is `integrations/hermes/scripts/ct_wisdom_activity_delivery.py`.
- The delivery module calls the builder only as `builder.<name>` (`import ct_wisdom_activity as builder`), never `from ct_wisdom_activity import …`.
- The shared builder must not define `on_transform_tool_result`, `ActivityState`, `_transform`, `_deliver` or `proves_ran`, and must not import `ct_wisdom_live` or `ct_wisdom_verbose`.
- `ct_wisdom_activity.py` and `ct_wisdom.py` stay byte-identical across `integrations/{hermes,claude-code,docker-agent}/scripts/`.
- Versions: hermes `0.7.1 → 0.7.2`, claude-code `0.4.2 → 0.4.3`, docker-agent `0.1.2 → 0.1.3`.
- Stdlib only; the Hermes hook never raises. Never run `ct`, `curated-thoughts-mcp` or any Curated Thoughts command.
- Run Hermes tests from `integrations/hermes`: `python3 -m unittest discover -s tests` (about 60 s).

A throwaway prototype of Tasks 1-2 (scratchpad, 2026-10-17) passed: hermes 562 OK, claude-code OK, docker-agent OK,
the target vectors, the golden and the parity tests OK, and ruff clean on both modules.

## File Structure

- Modify `integrations/hermes/scripts/ct_wisdom_activity.py`: builder only, a new docstring, a new `reset_caches()`, and `_nonempty` moved in.
- Create `integrations/hermes/scripts/ct_wisdom_activity_delivery.py`: the Hermes delivery, with the old docstring.
- Modify `integrations/hermes/__init__.py`: import the delivery module.
- Modify the Hermes tests `test_ct_wisdom_activity.py`, `test_ct_wisdom_activity_ran.py` and `test_exactly_once.py`.
- Modify `tests/tools/test_shared_script_parity.py`: move the builder into `IDENTICAL`, and add `HERMES_ONLY` and the boundary guard.
- Copy the builder into the claude-code and docker-agent `scripts/`. In their tests and `tests/tools/test_activity_target_vectors.py`, change `reset_state` to `reset_caches`.
- Modify `ct_wisdom.py` (all three copies): one docstring line.
- Release files: the three versions, CHANGELOGs, README rows, and the docker-agent version literals in tests.

---

### Task 1: Split the Hermes module

**Files:**
- Modify: `integrations/hermes/scripts/ct_wisdom_activity.py`
- Create: `integrations/hermes/scripts/ct_wisdom_activity_delivery.py`
- Modify: `integrations/hermes/__init__.py` (lines ~167-169 and the two comments at ~20 and ~156 that name `ct_wisdom_activity` for the delivery)
- Modify: `integrations/hermes/tests/test_ct_wisdom_activity.py`, `integrations/hermes/tests/test_ct_wisdom_activity_ran.py`, `integrations/hermes/tests/test_exactly_once.py`

**Interfaces:**
- Produces: `ct_wisdom_activity.reset_caches()` (test-only; clears the builder caches), and
  `ct_wisdom_activity._nonempty(value)` (moved from the delivery half; the builder's `session_cwd` uses it).
  `ct_wisdom_activity_delivery` exposes `on_transform_tool_result(**kwargs)`, `reset_state()`, `proves_ran`,
  `ActivityState`, `CT_UNUSABLE_PAUSE`, `STEP_IDS_MAX`, `SESSIONS_MAX` and every other delivery name, unchanged.

- [ ] **Step 1: Write the new failing tests**

Append to `integrations/hermes/tests/test_ct_wisdom_activity.py`, just before `if __name__ == "__main__":`:

```python
class TestModuleSplit(unittest.TestCase):
    """Spec 2026-10-17-hermes-activity-delivery-split-design.md."""

    def test_reset_caches_clears_builder_caches_only(self):
        import ct_wisdom_activity as builder
        import ct_wisdom_activity_delivery as delivery
        delivery._STATE.start("s-split", "r-split", ("file", "x"))
        builder.reset_caches()
        self.assertIsNotNone(delivery._STATE.peek("s-split", "r-split", None),
                             "reset_caches must leave delivery state alone")
        delivery.reset_state()
        self.assertIsNone(delivery._STATE.peek("s-split", "r-split", None))

    def test_reset_state_also_clears_builder_caches(self):
        import ct_wisdom_activity as builder
        import ct_wisdom_activity_delivery as delivery
        calls = []
        orig = builder.reset_caches
        builder.reset_caches = lambda: calls.append(1)
        self.addCleanup(setattr, builder, "reset_caches", orig)
        delivery.reset_state()
        self.assertEqual(calls, [1])

    def test_delivery_calls_the_builder_through_the_module(self):
        """Patching a builder name changes what delivery builds."""
        import ct_wisdom_activity as builder
        import ct_wisdom_activity_delivery as delivery
        seen = []
        orig = builder.activity_for
        builder.activity_for = lambda *a, **k: seen.append(a[0]) or None
        self.addCleanup(setattr, builder, "activity_for", orig)
        delivery.reset_state()
        self.addCleanup(delivery.reset_state)
        ct_ledger.LEDGER_CACHE.put("s-split", set())
        self.addCleanup(ct_ledger.LEDGER_CACHE.clear)
        delivery.on_transform_tool_result(
            tool_name="read_file", args={"path": "src/x.py"}, result=READ_RESULT,
            task_id="", session_id="s-split", tool_call_id="c1", api_request_id="r1")
        self.assertEqual(seen, ["read_file"])

    def test_builder_has_no_delivery(self):
        import ct_wisdom_activity as builder
        for name in ("on_transform_tool_result", "ActivityState", "_transform", "_deliver",
                     "proves_ran", "reset_state"):
            self.assertFalse(hasattr(builder, name), name)
```

(`ActivityState.start(session_id, api_request_id, key)` records the step; `peek(session_id, api_request_id, None)`
then answers `"step_used"`, and `None` after a reset.)

- [ ] **Step 2: Run them to verify they fail**

Run (from `integrations/hermes`): `python3 -m unittest tests.test_ct_wisdom_activity.TestModuleSplit -v`
Expected: 3 ERROR (`ModuleNotFoundError: No module named 'ct_wisdom_activity_delivery'`) and 1 FAIL
(`test_builder_has_no_delivery`: the builder still defines the delivery). Checked against a scratch run.

- [ ] **Step 3: Run the split script**

Write this to the scratchpad (not the repo) as `split.py`, then run it with `python3 split.py integrations/hermes`
from the repo root:

```python
import re, sys

root = sys.argv[1]
F = root + "/scripts/ct_wisdom_activity.py"
src = open(F).read()
L = src.split("\n")

def header_line(title):
    """Index of the '# ----' line that opens the section titled `title`."""
    for i in range(1, len(L) - 1):
        if L[i] == "# " + title and L[i - 1].startswith("# ----") and L[i + 1].startswith("# ----"):
            return i - 1
    raise SystemExit("section not found: " + title)

k = header_line("key tracker and per-step rate rule")
r = header_line("render and splice")
t = header_line("transform_tool_result hook")
assert k < r < t

# Old module docstring -> delivery; the builder gets a new one.
assert L[0].startswith("#!") and L[1].startswith('"""')
doc_end = next(i for i in range(1, len(L)) if L[i].strip() == '"""' or (i > 1 and L[i].endswith('"""')))
old_doc = "\n".join(L[1:doc_end + 1])

builder = "\n".join(L[:k] + L[r:t]).rstrip("\n") + "\n"
delivery_body = "\n".join(L[k:r] + L[t:])

new_doc = '''"""ct_wisdom_activity.py — autonomous-work activity builder and renderer.

Shared, byte-identical, by Hermes, Claude Code and Docker Agent
(tests/tools/test_shared_script_parity.py). It builds the activity for one
tool call from its ARGS only (the bare target sent to CT: a relative path, a
search pattern, or program plus subcommand; never contents, output, diffs,
reasoning or full command lines), renders the marker-first activity block
and splices it into a tool result.

The Hermes `transform_tool_result` delivery (step and key state, prefetch,
breaker, proves_ran) lives in ct_wisdom_activity_delivery.py (Hermes only).
Specs: docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md,
docs/superpowers/specs/2026-10-17-hermes-activity-delivery-split-design.md.

Stdlib only. Never raises on bad input; returns None instead.
"""'''
builder = builder.replace(old_doc, new_doc, 1)
builder = builder.replace("STEP_IDS_MAX = 16\nSESSIONS_MAX = 256\n", "", 1)
builder = builder.replace("import ct_wisdom_live\nimport ct_wisdom_verbose\n", "", 1)
builder = builder.replace(
    "\ndef session_cwd(",
    "\ndef _nonempty(value):\n    return isinstance(value, str) and bool(value)\n\n\ndef session_cwd(", 1)
builder = builder.rstrip("\n") + '''


def reset_caches():
    """TEST-ONLY: forget the root, *.sln, homes and module caches and the
    pwd lookup."""
    for cache in (_root_cache, _sln_cache, _homes_cache, _module_cache):
        cache.clear()
    _pwd_identity.cache_clear()
'''

NAMES = ["ACTIVITY_MAX_PER_STEP", "RECENT_KEYS_MAX", "_is_activity_tool", "_parse", "_splice_mode",
         "activity_for", "is_ct_tool", "query_for", "render_activity_block", "render_candidates", "splice",
         "_nonempty", "ACTIVITY_RESULT_KEY", "Activity", "ACTIVITY_HEADING"]
d = delivery_body
before = d
d = d.replace('''    _STATE.reset()
    for cache in (_root_cache, _sln_cache, _homes_cache, _module_cache):
        cache.clear()
    _pwd_identity.cache_clear()
''', '''    _STATE.reset()
    builder.reset_caches()
''', 1)
assert d != before, "reset_state body not found"
d, n = re.subn(r"\ndef _nonempty\(value\):\n    return isinstance\(value, str\) and bool\(value\)\n\n", "\n", d)
assert n == 1, "_nonempty def not found in the delivery half"
for name in NAMES:
    d = re.sub(r"(?<![\w.])" + re.escape(name) + r"\b(?!\s*=[^=])", "builder." + name, d)
d = re.sub(r"def builder\.", "def ", d)

delivery_doc = old_doc.replace('"""ct_wisdom_activity.py — autonomous-work wisdom delivery (Hermes).',
                               '"""ct_wisdom_activity_delivery.py — autonomous-work wisdom delivery (Hermes only).', 1)
delivery_doc = delivery_doc.replace(
    "Spec: docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md.",
    "Spec: docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md.\n"
    "Split out of the shared builder (ct_wisdom_activity.py, imported as `builder`):\n"
    "docs/superpowers/specs/2026-10-17-hermes-activity-delivery-split-design.md.", 1)
header = "#!/usr/bin/env python3\n" + delivery_doc + '''

from __future__ import annotations

import logging
import os
import threading
import time
from collections import OrderedDict

import ct_ledger
import ct_wisdom
import ct_wisdom_activity as builder
import ct_wisdom_live
import ct_wisdom_verbose

logger = logging.getLogger(__name__)

# Delivery-only limits (moved from the builder).
STEP_IDS_MAX = 16
SESSIONS_MAX = 256

'''
open(root + "/scripts/ct_wisdom_activity_delivery.py", "w").write(header + d.lstrip("\n").rstrip("\n") + "\n")
open(F, "w").write(builder)
print("ok", len(builder.splitlines()), "builder lines,", len((header + d).splitlines()), "delivery lines")
```

Then check both modules:

```bash
cd integrations/hermes/scripts
uvx ruff check --select E9,F63,F7,F82,F401 ct_wisdom_activity.py ct_wisdom_activity_delivery.py
git diff --color-moved=zebra --stat
```
Expected: `All checks passed!`. If ruff flags an unused import in the delivery header (for example `ct_wisdom` or
`os`), remove only that import. If it flags an undefined name, it is a builder name missing from `NAMES`: qualify
it with `builder.` by hand and record it in the report. Open both files and confirm:
- the builder docstring is the new one;
- the delivery docstring is the old one, retitled;
- `reset_caches` is at the end of the builder;
- `_nonempty` sits just above `session_cwd`.

- [ ] **Step 4: Point Hermes at the delivery module**

In `integrations/hermes/__init__.py`, replace

```python
        import ct_wisdom_activity
```

with

```python
        import ct_wisdom_activity_delivery
```

and `return ct_wisdom_activity.on_transform_tool_result(**kwargs)` with
`return ct_wisdom_activity_delivery.on_transform_tool_result(**kwargs)`. In the two comments (around lines 20 and
156) that say `(ct_wisdom_activity)` about the delivery, write `(ct_wisdom_activity_delivery)`.

- [ ] **Step 5: Re-point the Hermes tests**

Write this to the scratchpad as `migrate_tests.py` and run `python3 migrate_tests.py integrations/hermes` from the
repo root. In each test file, every `act.NAME` / `ct_wisdom_activity.NAME`, and every `(act, "NAME"` /
`setattr(act, "NAME"`, whose NAME the delivery module defines becomes `dlv.NAME`. An import
`import ct_wisdom_activity_delivery as dlv  # noqa: E402` is added. Builder names keep `act`.

```python
import ast, re, sys

root = sys.argv[1]
d = open(root + "/scripts/ct_wisdom_activity_delivery.py").read()
D = set()
for n in ast.parse(d).body:
    if isinstance(n, (ast.FunctionDef, ast.ClassDef)):
        D.add(n.name)
    elif isinstance(n, ast.Assign):
        for t in n.targets:
            if isinstance(t, ast.Name):
                D.add(t.id)
D.discard("logger")
IMPORTS = {"act": "import ct_wisdom_activity as act  # noqa: E402\n",
           "ct_wisdom_activity": "import ct_wisdom_activity  # noqa: E402\n"}
for f, alias in (("test_ct_wisdom_activity.py", "act"), ("test_ct_wisdom_activity_ran.py", "act"),
                 ("test_exactly_once.py", "ct_wisdom_activity")):
    p = root + "/tests/" + f
    s = open(p).read()
    used = set()

    def attr(m):
        if m.group(1) in D:
            used.add(m.group(1))
            return "dlv." + m.group(1)
        return m.group(0)

    def named(m):
        if m.group(2) in D:
            used.add(m.group(2))
            return m.group(1) + 'dlv, "' + m.group(2) + '"'
        return m.group(0)

    s = re.sub(r"(?<![\w.])" + alias + r"\.(\w+)", attr, s)
    s = re.sub(r"(\(|setattr\()" + alias + r', "(\w+)"', named, s)
    if used:
        assert IMPORTS[alias] in s, (f, "import line not found")
        s = s.replace(IMPORTS[alias], IMPORTS[alias] + "import ct_wisdom_activity_delivery as dlv  # noqa: E402\n", 1)
    open(p, "w").write(s)
    print(f, sorted(used))
```

Then fix the one dynamic patch loop by hand. In `test_ct_wisdom_activity.py`, `TestReview3.test_exception_after_start_frees_the_key`
patches names from a string list, and one of them (`render_activity_block`) is a builder name. Replace

```python
        for name in ("_Prefetch", "_ct_warm", "render_activity_block"):
            with self.subTest(name=name):
                dlv.reset_state()
                ct_ledger.LEDGER_CACHE.put("s1", set())
                orig = getattr(act, name)

                def boom(*a, **k):
                    raise RuntimeError("boom")

                setattr(act, name, boom)
                self.assertIsNone(self.step(1, path="same.py"))
                setattr(act, name, orig)
```

with

```python
        for mod, name in ((dlv, "_Prefetch"), (dlv, "_ct_warm"), (act, "render_activity_block")):
            with self.subTest(name=name):
                dlv.reset_state()
                ct_ledger.LEDGER_CACHE.put("s1", set())
                orig = getattr(mod, name)

                def boom(*a, **k):
                    raise RuntimeError("boom")

                setattr(mod, name, boom)
                self.assertIsNone(self.step(1, path="same.py"))
                setattr(mod, name, orig)
```

Also update the module docstring line `Spec:` of `test_ct_wisdom_activity.py` to add the split spec path. In the
`TestModuleSplit` class from Step 1, the local imports stay as written; they are explicit on purpose.

- [ ] **Step 6: Run the Hermes suite**

Run: `python3 -m unittest discover -s tests` (from `integrations/hermes`)
Expected: OK (566 tests: 562 plus the 4 new ones; 1 skipped). Then:
`uvx ruff check --select E9,F63,F7,F82,F401 .` from `integrations/hermes`. Expected: `All checks passed!`.
(`tests/tools/test_shared_script_parity.py` now fails, because the claude-code and docker-agent copies still hold
the old file. Task 2 fixes that. Don't run it here.)

- [ ] **Step 7: Commit**

```bash
git add integrations/hermes
git commit -m "refactor(hermes): split the activity delivery out of the shared builder

Co-Authored-By: <the model you run as> <noreply@anthropic.com>"
```

---

### Task 2: Parity gate, copies and the other suites

**Files:**
- Modify: `tests/tools/test_shared_script_parity.py`
- Modify: `integrations/claude-code/scripts/ct_wisdom_activity.py`, `integrations/docker-agent/scripts/ct_wisdom_activity.py` (copies)
- Modify: `integrations/{hermes,claude-code,docker-agent}/scripts/ct_wisdom.py` (one docstring line, all three identical)
- Modify: every `reset_state` use under `integrations/claude-code/tests`, `integrations/docker-agent/tests` and `tests/tools/test_activity_target_vectors.py`

**Interfaces:**
- Consumes: the Task 1 builder (`reset_caches`) and `ct_wisdom_activity_delivery.py`.

- [ ] **Step 1: Update the parity gate (tests first)**

In `tests/tools/test_shared_script_parity.py`:
- Add `"ct_wisdom_activity.py",` to `IDENTICAL` with the comment
  `# The autonomous-work activity builder (spec 2026-10-17-hermes-activity-delivery-split-design.md).`
- Delete the `IDENTICAL_EXTRA` dict and its comments. In `test_identical_scripts_are_byte_identical`, iterate
  over `IDENTICAL` only.
- Add, after `HOOK_SHARED`:

```python
# Hermes-only scripts: they must exist in Hermes and never in the copies
# (spec 2026-10-17-hermes-activity-delivery-split-design.md).
HERMES_ONLY = ("ct_tool_dedup.py", "ct_wisdom_activity_delivery.py")
# The shared builder must not grow the Hermes delivery back.
BUILDER = "ct_wisdom_activity.py"
BUILDER_FORBIDDEN_DEFS = ("on_transform_tool_result", "ActivityState", "_transform", "_deliver",
                          "proves_ran")
BUILDER_FORBIDDEN_IMPORTS = ("ct_wisdom_live", "ct_wisdom_verbose")
```

- Add this test class, and `import ast` at the top:

```python
class HermesOnlyBoundaryTests(unittest.TestCase):
    def test_hermes_only_scripts_stay_in_hermes(self):
        for name in HERMES_ONLY:
            with self.subTest(script=name):
                self.assertTrue((REFERENCE / name).is_file(), f"hermes/{name} missing")
                for copy_dir in COPIES:
                    self.assertFalse((copy_dir / name).exists(),
                                     f"{copy_dir.parent.name} must not carry Hermes-only {name}")

    def test_builder_has_no_hermes_delivery(self):
        tree = ast.parse(read(REFERENCE / BUILDER))
        defined = {n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
        imported = set()
        for n in ast.walk(tree):
            if isinstance(n, ast.Import):
                imported.update(a.name.split(".")[0] for a in n.names)
            elif isinstance(n, ast.ImportFrom) and n.module:
                imported.add(n.module.split(".")[0])
        for name in BUILDER_FORBIDDEN_DEFS:
            self.assertNotIn(name, defined, f"{BUILDER} must not define {name} (Hermes delivery)")
        for name in BUILDER_FORBIDDEN_IMPORTS:
            self.assertNotIn(name, imported, f"{BUILDER} must not import {name} (Hermes delivery)")
```

- Update the module docstring's contract list: `ct_wisdom_activity.py` is byte-identical, and the Hermes-only
  scripts are listed.

- [ ] **Step 2: Run the gate to verify it fails**

Run (repo root): `python3 -m unittest tests.tools.test_shared_script_parity -v`
Expected: FAIL in `test_identical_scripts_are_byte_identical` for `ct_wisdom_activity.py` (the copies are stale).
`HermesOnlyBoundaryTests` passes.

- [ ] **Step 3: Sync the copies and the `ct_wisdom.py` docstring**

```bash
cp integrations/hermes/scripts/ct_wisdom_activity.py integrations/claude-code/scripts/ct_wisdom_activity.py
cp integrations/hermes/scripts/ct_wisdom_activity.py integrations/docker-agent/scripts/ct_wisdom_activity.py
```

In `integrations/hermes/scripts/ct_wisdom.py`, the `discover_ct` docstring line
`cooldown, ct_wisdom_activity.CT_UNUSABLE_PAUSE)` becomes
`cooldown, ct_wisdom_activity_delivery.CT_UNUSABLE_PAUSE, Hermes)`. Re-wrap the surrounding docstring lines only if
the line exceeds the file's width. Then copy `ct_wisdom.py` to the claude-code and docker-agent `scripts/`.

- [ ] **Step 4: `reset_state` → `reset_caches` outside Hermes**

```bash
grep -rln "reset_state" integrations/claude-code/tests integrations/docker-agent/tests tests/tools/test_activity_target_vectors.py
```
In each listed file, replace `ct_wisdom_activity.reset_state` with `ct_wisdom_activity.reset_caches` and
`act.reset_state` with `act.reset_caches` (`act` is the builder alias there). Then grep again: only non-builder
`reset_state` uses (if any) may remain. Check each by hand and list them in the report.

- [ ] **Step 5: Run everything**

```bash
python3 -m unittest tests.tools.test_shared_script_parity -v
(cd integrations/hermes && python3 -m unittest discover -s tests)
(cd integrations/claude-code && python3 -m unittest discover -s tests)
(cd integrations/docker-agent && python3 -m unittest discover -s tests)
python3 -m unittest discover -s tests/tools
for d in integrations/hermes integrations/claude-code integrations/docker-agent; do (cd $d && uvx ruff check --select E9,F63,F7,F82,F401 .); done
```
Expected: all OK and ruff clean. If a `tests/tools` policy check fails because versions weren't bumped, that's
Task 3. Note it and don't bump here.

- [ ] **Step 6: Commit**

```bash
git add tests/tools integrations/claude-code integrations/docker-agent integrations/hermes/scripts/ct_wisdom.py
git commit -m "test(parity): ct_wisdom_activity.py is a shared identical builder; Hermes-only delivery boundary guard

Co-Authored-By: <the model you run as> <noreply@anthropic.com>"
```

---

### Task 3: Release hygiene

**Files:** `integrations/hermes/{plugin.yaml,integration.yaml,CHANGELOG.md}`,
`integrations/claude-code/{.claude-plugin/plugin.json,integration.yaml,CHANGELOG.md}`,
`integrations/docker-agent/{plugin.json,integration.yaml,CHANGELOG.md}`, `README.md` (the three table rows),
`integrations/docker-agent/tests/test_ct_doctor.py` and `tests/test_install.py` (version literal `0.1.2`).

- [ ] **Step 1: Bump the versions:** hermes `0.7.1 → 0.7.2` (plugin.yaml, integration.yaml); claude-code `0.4.2 → 0.4.3`
  (.claude-plugin/plugin.json, integration.yaml); docker-agent `0.1.2 → 0.1.3` (plugin.json, integration.yaml, and the
  `0.1.2` literal in `tests/test_ct_doctor.py` and `tests/test_install.py`). In the README rows, change `[0.7.1]` to
  `[0.7.2]`, `[0.4.2]` to `[0.4.3]` and `[0.1.2]` to `[0.1.3]`.
- [ ] **Step 2: Add the CHANGELOG entries** directly under `## Unreleased`, keeping that heading:

hermes:
```markdown
## 0.7.2 — 2026-10-17

- Internal: the autonomous-work delivery moved out of the shared builder into
  a Hermes-only `ct_wisdom_activity_delivery.py`. No behavior change. Later
  Hermes-only fixes no longer require Claude Code and Docker Agent releases.
```
claude-code (and docker-agent, with its own version heading `## 0.1.3 — 2026-10-17`):
```markdown
## 0.4.3 — 2026-10-17

- Internal: the shared `ct_wisdom_activity.py` no longer carries the Hermes-only
  delivery code (about 540 fewer shipped lines). No behavior change.
```
- [ ] **Step 3: Run the full verification** (the same commands as Task 2 Step 5). Expected: all OK.
- [ ] **Step 4: Commit** `release: hermes 0.7.2, claude-code 0.4.3, docker-agent 0.1.3 (activity delivery split)` with the trailer.

---

### Task 4: e2e, PR and review (controller)

- [ ] Run the Hermes e2e in its container (scratch HOME and brain; `zsh -ic 'integrations/hermes/tests/e2e/run.sh'`).
  **Read run.sh's own exit code and the `RESULT` line**, not a wrapper's status. Expected: `RESULT PASS`, exit 0.
- [ ] Push the branch, open the PR. The body links the spec and plan, says "no behavior change; review with
  `git diff --color-moved`", gives the e2e result, and ends with the attribution line.
- [ ] Run `/code-review <PR> high`. Fix findings in the same flow (commit and push), then merge on the user's go-ahead
  and tag `hermes-v0.7.2`, `claude-code-v0.4.3` and `docker-agent-v0.1.3` after main CI is green.
