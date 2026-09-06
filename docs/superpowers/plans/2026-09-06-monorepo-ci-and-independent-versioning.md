# Monorepo CI and Independent Per-Integration Versioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single Hermes-specific CI workflow with manifest-driven,
per-integration CI, independent tag-driven releases, and automated policy gates
that enforce the repository's architecture and data-safety rules.

**Architecture:** Each `integrations/<id>/` declares an `integration.yaml` CI
contract. A new stdlib-plus-PyYAML tool, `tools/ct_ci.py`, reads those
manifests and provides five subcommands (`validate`, `generate`, `policy`,
`discover`, `package`). CI becomes a `discover` → `integration` matrix →
`policy` → `ci-ok` pipeline; releases are driven by `<id>-v<semver>` tags.
Shipped scripts never gain a dependency: compatibility values move from
hardcoded literals into a generated constants module, freshness-gated in CI.

**Tech Stack:** Python 3.9+ (stdlib for shipped code; PyYAML permitted in
`tools/` only), `unittest`, GitHub Actions, `ruff`, `shellcheck`, `gh` CLI via
`softprops/action-gh-release`.

**Spec:** `docs/superpowers/specs/2026-09-06-monorepo-ci-and-independent-versioning-design.md`

## Global Constraints

- **Shipped code is stdlib-only.** Anything under `integrations/**` may import
  only the Python standard library plus its own sibling modules
  (`CONTRIBUTING.md` rule 4). PyYAML is permitted **only** in `tools/**`, which
  never ships.
- **Python floor is 3.9.** No `match`, no `X | Y` type unions at runtime, no
  `str.removeprefix` in shipped code (3.9 has it — it is fine; 3.8-isms are
  irrelevant since 3.9 is the floor). `tools/ct_ci.py` may assume 3.11+ because
  it runs only in CI on the pinned interpreter.
- **`shared/compat.yaml` is the single source of truth** for tiers, tool
  counts, engine pins, `source_ref_shape`, and `required_tables`. Nothing under
  `integrations/**` may restate those values except a generated module.
- **Read-only by construction.** No code added by this plan opens a brain
  database except through an existing `mode=ro` URI.
- **Merge commits only** (`CONTRIBUTING.md` rule 2). Do not squash or rebase
  when integrating.
- **Tag grammar:** `<id>-v<semver>`, e.g. `hermes-v0.2.1`, `hermes-v0.3.0-rc.1`.
- **Exit-code contract for `tools/ct_ci.py`:** `0` = all gates pass, `1` = a
  gate failed, `2` = usage error. Never raise an uncaught traceback for a
  policy violation.
- **Every gate failure message** must name the offending file, the line where
  known, and the `CONTRIBUTING.md` rule or spec section it enforces.

---

## File Structure

**Created:**

- `tools/ct_ci.py` — CLI entry point and subcommand dispatch only. Thin.
- `tools/ct_ci_manifest.py` — manifest loading and schema validation.
- `tools/ct_ci_generate.py` — renders `_compat_generated.py` from compat.yaml.
- `tools/ct_ci_policy.py` — the three policy-gate families.
- `tools/ct_ci_package.py` — tarball + SHA256SUMS construction.
- `shared/integration.schema.json` — manifest schema.
- `shared/compat.schema.json` — compat.yaml schema.
- `integrations/<id>/integration.yaml` — one per integration (3 files).
- `integrations/<id>/CHANGELOG.md` — one per integration (3 files).
- `integrations/hermes/scripts/_compat_generated.py` — generated constants.
- `tests/tools/test_ct_ci_manifest.py`, `test_ct_ci_generate.py`,
  `test_ct_ci_policy_version.py`, `test_ct_ci_policy_arch.py`,
  `test_ct_ci_policy_compat.py`, `test_ct_ci_package.py`,
  `test_ct_ci_discover.py` — one test module per gate family.
  Violation fixtures are built in-test with `tempfile` rather than checked in
  as a `fixtures/` tree: a checked-in tree containing a hardcoded
  `/Users/alice/.brain` would itself have to be exempted from the very gate it
  exercises, and a gate with a standing exemption is a gate that erodes.
- `.github/workflows/release.yml`.

**Modified:**

- `.github/workflows/ci.yml` — replaced wholesale (Task 9).
- `integrations/hermes/scripts/ct_doctor.py` — constants → generated module.
- `integrations/hermes/scripts/ct_preflight.py` — constants → generated module.
- `integrations/hermes/plugin.yaml` — unchanged content; it becomes the
  `version_mirror` target.
- `.gitignore`, `README.md`, `CONTRIBUTING.md`.

**Moved:**

- `tests/test_ct_doctor.py`, `tests/test_install.py` →
  `integrations/hermes/tests/` (Task 8), so path-filtered discovery is honest
  and the integration directory is genuinely self-contained.

Files split by responsibility: each `ct_ci_*.py` module owns one gate family
and one test module. `ct_ci.py` itself holds no logic beyond argument parsing,
so it stays readable as subcommands accumulate.

---

### Task 1: Manifest schema and `ct_ci.py validate`

**Files:**
- Create: `shared/integration.schema.json`
- Create: `tools/ct_ci_manifest.py`
- Create: `tools/ct_ci.py`
- Create: `tools/requirements-ci.txt`
- Test: `tests/tools/test_ct_ci_manifest.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `load_manifest(path: Path) -> dict` — parses YAML, returns the raw mapping.
  - `validate_manifest(data: dict, path: Path) -> list[str]` — returns a list
    of human-readable error strings; empty list means valid.
  - `discover_manifests(repo_root: Path) -> list[tuple[str, Path, dict]]` —
    returns `(id, dir_path, data)` for every `integrations/*/integration.yaml`,
    sorted by id.
  - Module constant `SCHEMA_PATH: Path`.

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/test_ct_ci_manifest.py`:

```python
"""Schema validation for integration.yaml manifests."""
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import ct_ci_manifest  # noqa: E402

VALID = {
    "id": "hermes",
    "name": "Curated Thoughts for Hermes Agent",
    "version": "0.2.0",
    "language": "python",
    "status": "implemented",
    "requires_sidecar": ">=2.5",
    "compat_tier": "v2.5-full",
    "version_mirror": "plugin.yaml#version",
    "matrix": {"os": ["ubuntu-latest"], "python": ["3.9", "3.13"]},
    "checks": {"test": "python -m unittest discover -s tests"},
    "package": {"include": ["**"], "exclude": ["**/__pycache__/**"]},
}


def errs(overrides=None, drop=()):
    data = dict(VALID)
    for key in drop:
        data.pop(key)
    data.update(overrides or {})
    return ct_ci_manifest.validate_manifest(data, Path("integrations/hermes/integration.yaml"))


class TestValidateManifest(unittest.TestCase):
    def test_valid_manifest_has_no_errors(self):
        self.assertEqual(errs(), [])

    def test_missing_required_field_is_reported_by_name(self):
        messages = errs(drop=("version",))
        self.assertTrue(any("version" in m for m in messages), messages)

    def test_non_semver_version_rejected(self):
        self.assertTrue(errs({"version": "0.2"}))

    def test_prerelease_version_accepted(self):
        self.assertEqual(errs({"version": "0.3.0-rc.1"}), [])

    def test_unknown_language_rejected(self):
        self.assertTrue(errs({"language": "cobol"}))

    def test_python_language_requires_matrix_python(self):
        messages = errs({"matrix": {"os": ["ubuntu-latest"], "node": ["20"]}})
        self.assertTrue(any("matrix.python" in m for m in messages), messages)

    def test_node_language_requires_matrix_node(self):
        messages = errs({
            "language": "node",
            "matrix": {"os": ["ubuntu-latest"], "python": ["3.13"]},
        })
        self.assertTrue(any("matrix.node" in m for m in messages), messages)

    def test_node_language_with_matrix_node_is_valid(self):
        self.assertEqual(
            errs({
                "language": "node",
                "matrix": {"os": ["ubuntu-latest"], "node": ["20"]},
                "checks": {"test": "npm test"},
            }),
            [],
        )

    def test_planned_integration_may_omit_checks_and_matrix(self):
        self.assertEqual(
            errs({"status": "planned"}, drop=("checks", "matrix", "version_mirror")),
            [],
        )

    def test_unknown_top_level_key_rejected(self):
        self.assertTrue(errs({"colour": "blue"}))

    def test_error_messages_name_the_manifest_path(self):
        messages = errs(drop=("name",))
        self.assertTrue(all("integrations/hermes/integration.yaml" in m for m in messages), messages)


class TestDiscoverManifests(unittest.TestCase):
    def test_finds_every_real_integration_sorted_by_id(self):
        found = ct_ci_manifest.discover_manifests(REPO)
        ids = [i for i, _, _ in found]
        self.assertEqual(ids, sorted(ids))
        self.assertIn("hermes", ids)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m unittest discover -s tests/tools -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ct_ci_manifest'`.

- [ ] **Step 3: Write the schema**

Create `shared/integration.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Curated Thoughts integration CI contract",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "name", "version", "language", "status", "requires_sidecar", "compat_tier"],
  "properties": {
    "id": {"type": "string", "pattern": "^[a-z][a-z0-9-]*$"},
    "name": {"type": "string", "minLength": 1},
    "version": {"type": "string"},
    "language": {"enum": ["python", "node"]},
    "status": {"enum": ["implemented", "planned"]},
    "requires_sidecar": {"type": "string"},
    "compat_tier": {"type": "string"},
    "version_mirror": {"type": "string", "pattern": "^[^#]+#[A-Za-z_][A-Za-z0-9_]*$"},
    "matrix": {
      "type": "object",
      "additionalProperties": false,
      "required": ["os"],
      "properties": {
        "os": {"type": "array", "minItems": 1, "items": {"type": "string"}},
        "python": {"type": "array", "minItems": 1, "items": {"type": "string"}},
        "node": {"type": "array", "minItems": 1, "items": {"type": "string"}}
      }
    },
    "checks": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "test": {"type": "string"},
        "lint": {"type": "string"},
        "shell": {"type": "array", "items": {"type": "string"}}
      }
    },
    "policy": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "allow_sqlite_readonly": {"type": "array", "items": {"type": "string"}}
      }
    },
    "package": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "include": {"type": "array", "items": {"type": "string"}},
        "exclude": {"type": "array", "items": {"type": "string"}}
      }
    }
  }
}
```

Note `policy.allow_sqlite_readonly`: `ct_preflight.py` legitimately opens the
brain through a `mode=ro` URI, so the architecture lint (Task 6) needs a
declared, reviewable exemption rather than a blanket ban that existing correct
code would fail.

- [ ] **Step 4: Write the manifest module**

Create `tools/ct_ci_manifest.py`:

```python
"""Loading and validating integrations/<id>/integration.yaml.

Runs in CI only, never ships, so PyYAML is permitted here (spec §3.1).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = REPO_ROOT / "shared" / "integration.schema.json"
MANIFEST_NAME = "integration.yaml"

# PEP-440-free, SemVer 2.0.0 official expression.
SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?"
    r"(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$"
)


def load_manifest(path):
    """Parse a manifest file. Raises yaml.YAMLError on malformed input."""
    with open(path, "r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def _schema():
    with open(SCHEMA_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _check_schema(data, schema, path, errors, prefix=""):
    """Validate the subset of JSON Schema the manifest schema uses.

    Deliberately hand-rolled over `jsonschema`: the vocabulary here is small
    and fixed, and one fewer CI dependency is one fewer thing to pin.
    """
    for key in schema.get("required", []):
        if key not in data:
            errors.append(f"{path}: missing required field '{prefix}{key}'")
    if schema.get("additionalProperties") is False:
        for key in data:
            if key not in schema.get("properties", {}):
                errors.append(f"{path}: unknown field '{prefix}{key}'")
    for key, rule in schema.get("properties", {}).items():
        if key not in data:
            continue
        value = data[key]
        where = f"{prefix}{key}"
        if "enum" in rule and value not in rule["enum"]:
            errors.append(
                f"{path}: field '{where}' must be one of {rule['enum']}, got {value!r}"
            )
        kind = rule.get("type")
        if kind == "string" and not isinstance(value, str):
            errors.append(f"{path}: field '{where}' must be a string")
        elif kind == "array":
            if not isinstance(value, list):
                errors.append(f"{path}: field '{where}' must be a list")
            elif len(value) < rule.get("minItems", 0):
                errors.append(f"{path}: field '{where}' must not be empty")
        elif kind == "object":
            if not isinstance(value, dict):
                errors.append(f"{path}: field '{where}' must be a mapping")
            else:
                _check_schema(value, rule, path, errors, prefix=f"{where}.")
        if isinstance(value, str) and "pattern" in rule:
            if not re.match(rule["pattern"], value):
                errors.append(
                    f"{path}: field '{where}' does not match {rule['pattern']}"
                )


def validate_manifest(data, path):
    """Return a list of error strings; empty means the manifest is valid."""
    errors = []
    if not isinstance(data, dict):
        return [f"{path}: manifest must be a YAML mapping"]

    _check_schema(data, _schema(), path, errors)

    version = data.get("version")
    if isinstance(version, str) and not SEMVER_RE.match(version):
        errors.append(f"{path}: version {version!r} is not valid SemVer 2.0.0")

    if data.get("status") == "implemented":
        for key in ("matrix", "checks", "version_mirror"):
            if key not in data:
                errors.append(
                    f"{path}: implemented integrations must declare '{key}'"
                )
        matrix = data.get("matrix") or {}
        wanted = "python" if data.get("language") == "python" else "node"
        if isinstance(matrix, dict) and wanted not in matrix:
            errors.append(
                f"{path}: language '{data.get('language')}' requires 'matrix.{wanted}'"
            )
        for unwanted in ({"python", "node"} - {wanted}):
            if isinstance(matrix, dict) and unwanted in matrix:
                errors.append(
                    f"{path}: language '{data.get('language')}' must not declare "
                    f"'matrix.{unwanted}'"
                )
    return errors


def discover_manifests(repo_root):
    """Return [(id, integration_dir, data)] for every manifest, sorted by id."""
    found = []
    for manifest in sorted((Path(repo_root) / "integrations").glob(f"*/{MANIFEST_NAME}")):
        found.append((manifest.parent.name, manifest.parent, load_manifest(manifest)))
    return sorted(found, key=lambda item: item[0])
```

- [ ] **Step 5: Write the CLI entry point**

Create `tools/ct_ci.py`:

```python
#!/usr/bin/env python3
"""ct_ci.py — monorepo CI tooling for curated-thoughts-integrations.

Runs in CI only and never ships to a user, so unlike everything under
integrations/, this may use PyYAML (spec §3.1).

Subcommands:
    validate    Schema-check every integration.yaml.

Exit codes: 0 = pass, 1 = a gate failed, 2 = usage error.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ct_ci_manifest  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]


def cmd_validate(args):
    errors = []
    for _id, _dir, data in ct_ci_manifest.discover_manifests(args.repo):
        errors.extend(ct_ci_manifest.validate_manifest(data, _dir / "integration.yaml"))
    for error in errors:
        print(f"FAIL {error}", file=sys.stderr)
    if errors:
        print(f"\n{len(errors)} manifest problem(s).", file=sys.stderr)
        return 1
    print("All integration manifests valid.")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="ct_ci.py", description=__doc__)
    parser.add_argument(
        "--repo", type=Path, default=REPO_ROOT, help="repository root"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("validate", help="schema-check every integration.yaml")

    args = parser.parse_args(argv)
    if args.command == "validate":
        return cmd_validate(args)
    parser.error(f"unknown command {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
```

Create `tools/requirements-ci.txt`:

```
PyYAML==6.0.2
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pip install -r tools/requirements-ci.txt && python -m unittest discover -s tests/tools -v`
Expected: PASS. `TestDiscoverManifests` fails until Task 2 adds manifests —
if so, proceed to Task 2 and re-run at the end of it.

- [ ] **Step 7: Commit**

```bash
git add tools/ct_ci.py tools/ct_ci_manifest.py tools/requirements-ci.txt \
        shared/integration.schema.json tests/tools/test_ct_ci_manifest.py
git commit -m "feat(ci): integration manifest schema and validator"
```

---

### Task 2: Author the three integration manifests

**Files:**
- Create: `integrations/hermes/integration.yaml`
- Create: `integrations/openclaw/integration.yaml`
- Create: `integrations/claude-code/integration.yaml`
- Delete: `integrations/openclaw/.gitkeep`, `integrations/claude-code/.gitkeep`
- Create: `integrations/hermes/CHANGELOG.md`
- Test: `tests/tools/test_ct_ci_manifest.py` (existing; add one case)

**Interfaces:**
- Consumes: `ct_ci_manifest.validate_manifest`, `discover_manifests` (Task 1).
- Produces: three manifests every later task reads. `hermes` declares
  `version: 0.2.0`, `compat_tier: v2.5-full`, `requires_sidecar: ">=2.5"`,
  `version_mirror: plugin.yaml#version`, and
  `policy.allow_sqlite_readonly: [scripts/ct_preflight.py]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/tools/test_ct_ci_manifest.py`:

```python
class TestRealManifests(unittest.TestCase):
    def test_every_shipped_manifest_validates(self):
        problems = []
        for _id, directory, data in ct_ci_manifest.discover_manifests(REPO):
            problems.extend(
                ct_ci_manifest.validate_manifest(data, directory / "integration.yaml")
            )
        self.assertEqual(problems, [])

    def test_all_three_integrations_are_declared(self):
        ids = [i for i, _, _ in ct_ci_manifest.discover_manifests(REPO)]
        self.assertEqual(ids, ["claude-code", "hermes", "openclaw"])

    def test_hermes_version_matches_plugin_yaml(self):
        import yaml
        manifest = ct_ci_manifest.load_manifest(
            REPO / "integrations" / "hermes" / "integration.yaml"
        )
        with open(REPO / "integrations" / "hermes" / "plugin.yaml", encoding="utf-8") as fh:
            native = yaml.safe_load(fh)
        self.assertEqual(manifest["version"], native["version"])
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m unittest tests.tools.test_ct_ci_manifest -v`
Expected: FAIL — `discover_manifests` returns `[]`.

- [ ] **Step 3: Write the Hermes manifest**

Create `integrations/hermes/integration.yaml`:

```yaml
# CI contract for the Hermes Agent integration.
#
# This is the *CI* manifest. plugin.yaml remains the manifest Hermes itself
# reads; `version_mirror` below is what keeps the two from drifting.
# Spec: docs/superpowers/specs/2026-09-06-monorepo-ci-and-independent-versioning-design.md
id: hermes
name: Curated Thoughts for Hermes Agent
version: 0.2.0
language: python
status: implemented
requires_sidecar: ">=2.5"
compat_tier: v2.5-full
version_mirror: plugin.yaml#version

matrix:
  # The README claims macOS, Linux and Windows. Sidecar discovery and path
  # handling are exactly where that claim breaks, so Windows is not optional.
  os: [ubuntu-latest, macos-latest, windows-latest]
  # The code is stdlib-only, so the interpreter range is the whole
  # compatibility surface: oldest supported and current.
  python: ["3.9", "3.13"]

checks:
  test: python -m unittest discover -s tests
  lint: ruff check --select E9,F63,F7,F82,F401 .
  shell:
    - scripts/install.sh

policy:
  # ct_preflight.py is the import pre-flight census. It opens brain.db through
  # a mode=ro URI and issues nothing but SELECT — read-only by construction.
  # The architecture lint asserts exactly that for every file listed here.
  allow_sqlite_readonly:
    - scripts/ct_preflight.py

package:
  include: ["**"]
  exclude:
    - "**/__pycache__/**"
    - "**/*.pyc"
```

- [ ] **Step 4: Write the two planned manifests**

Create `integrations/openclaw/integration.yaml`:

```yaml
# CI contract for the OpenClaw integration (not yet implemented).
# `status: planned` means: schema-validated, but skipped for tests,
# packaging and release until the integration exists.
id: openclaw
name: Curated Thoughts for OpenClaw
version: 0.0.0
language: python
status: planned
requires_sidecar: ">=2.5"
compat_tier: v2.5-full
```

Create `integrations/claude-code/integration.yaml`:

```yaml
# CI contract for the Claude Code integration (not yet implemented).
# `status: planned` means: schema-validated, but skipped for tests,
# packaging and release until the integration exists.
id: claude-code
name: Curated Thoughts for Claude Code
version: 0.0.0
language: python
status: planned
requires_sidecar: ">=2.5"
compat_tier: v2.5-full
```

Then remove the placeholders:

```bash
git rm integrations/openclaw/.gitkeep integrations/claude-code/.gitkeep
```

- [ ] **Step 5: Write the Hermes changelog**

Create `integrations/hermes/CHANGELOG.md`:

```markdown
# Changelog — Hermes Agent integration

All notable changes to `integrations/hermes/` are recorded here. This file is
the source of the GitHub Release body for every `hermes-v*` tag, so the heading
format below is load-bearing: `## <version> — <date>`.

## 0.2.0 — 2026-09-06

- Match the Hermes runtime contracts for system-prompt sections and skills.
- Environment contract: resolve the brain via `CURATED_BRAIN_DIR`,
  `CURATED_BRAIN_DB` and `CURATED_BRAIN_CONFIG` only.
- Import pre-flight reporting engine-mangled `source_ref` provenance damage.
```

Planned integrations get no changelog until they have a release.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `python -m unittest discover -s tests/tools -v`
Expected: PASS, including `TestDiscoverManifests` and `TestRealManifests`.

- [ ] **Step 7: Verify the CLI agrees**

Run: `python tools/ct_ci.py validate`
Expected: `All integration manifests valid.` and exit 0
(`echo $?` prints `0`).

- [ ] **Step 8: Commit**

```bash
git add integrations/*/integration.yaml integrations/hermes/CHANGELOG.md \
        tests/tools/test_ct_ci_manifest.py
git commit -m "feat(ci): declare CI manifests for all three integrations"
```

---

### Task 3: `ct_ci.py generate` — compat constants for stdlib-only scripts

**Files:**
- Create: `shared/compat.schema.json`
- Create: `tools/ct_ci_generate.py`
- Modify: `tools/ct_ci.py` (add the `generate` subcommand)
- Create: `integrations/hermes/scripts/_compat_generated.py` (generated output)
- Test: `tests/tools/test_ct_ci_generate.py`

**Interfaces:**
- Consumes: `ct_ci_manifest.discover_manifests` (Task 1).
- Produces:
  - `render(compat: dict) -> str` — the full text of a `_compat_generated.py`.
  - `targets(repo_root: Path) -> list[Path]` — every path the generator writes
    (`integrations/<id>/scripts/_compat_generated.py` for implemented Python
    integrations).
  - `check_current(repo_root: Path) -> list[str]` — stale-file report; empty
    means every generated file matches a fresh render.
  - The generated module exposes: `TIERS` (tuple of
    `(name, min_version, max_version_exclusive, tools, write_path)`),
    `FULL_TIER_TOOLS: int`, `READ_TIER_TOOLS: int`,
    `SOURCE_REF_SHAPE: str`, `EVIDENCE_TABLE: str`,
    `ENGINE_PINNED_VERSION: str`, `ENGINE_SAFE: bool`,
    `REQUIRED_TABLES: tuple[str, ...]`, `COMPAT_SOURCE: str`.

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/test_ct_ci_generate.py`:

```python
"""The generated compat constants module and its freshness gate."""
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import ct_ci_generate  # noqa: E402

COMPAT = {
    "compat": {
        "tiers": {
            "v2.4-read": {"sidecar": ">=2.4,<2.5", "tools": 8, "write_path": "dormant"},
            "v2.5-full": {"sidecar": ">=2.5", "tools": 14, "write_path": "full"},
        },
        "engine": {
            "states": {
                "mangles-structured-refs": {
                    "engine": "<=7.1.0",
                    "safe": False,
                    "pinned_version": "7.1.0",
                }
            },
            "data_safety": {
                "source_ref_shape": "^librarian-[0-9a-f]{32}$",
                "evidence_table": "librarian_evidence",
            },
        },
        "portability": {"required_tables": ["llm_wiki_entries", "librarian_evidence"]},
    }
}


class TestRender(unittest.TestCase):
    def setUp(self):
        self.text = ct_ci_generate.render(COMPAT)

    def test_output_is_importable_python(self):
        namespace = {}
        exec(compile(self.text, "_compat_generated.py", "exec"), namespace)
        self.assertEqual(namespace["FULL_TIER_TOOLS"], 14)
        self.assertEqual(namespace["READ_TIER_TOOLS"], 8)
        self.assertEqual(namespace["EVIDENCE_TABLE"], "librarian_evidence")
        self.assertEqual(namespace["SOURCE_REF_SHAPE"], "^librarian-[0-9a-f]{32}$")
        self.assertEqual(namespace["ENGINE_PINNED_VERSION"], "7.1.0")
        self.assertIs(namespace["ENGINE_SAFE"], False)

    def test_tiers_carry_parsed_version_bounds(self):
        namespace = {}
        exec(compile(self.text, "_compat_generated.py", "exec"), namespace)
        self.assertEqual(
            namespace["TIERS"],
            (
                ("v2.4-read", (2, 4), (2, 5), 8, "dormant"),
                ("v2.5-full", (2, 5), None, 14, "full"),
            ),
        )

    def test_header_forbids_hand_editing_and_names_its_source(self):
        self.assertIn("DO NOT EDIT", self.text)
        self.assertIn("shared/compat.yaml", self.text)
        self.assertIn("tools/ct_ci.py generate", self.text)

    def test_render_is_deterministic(self):
        self.assertEqual(self.text, ct_ci_generate.render(COMPAT))

    def test_generated_module_imports_nothing(self):
        self.assertNotIn("\nimport ", self.text)


class TestFreshness(unittest.TestCase):
    def test_committed_files_are_current(self):
        self.assertEqual(ct_ci_generate.check_current(REPO), [])

    def test_targets_covers_implemented_python_integrations_only(self):
        names = [p.parent.parent.name for p in ct_ci_generate.targets(REPO)]
        self.assertEqual(names, ["hermes"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m unittest tests.tools.test_ct_ci_generate -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ct_ci_generate'`.

- [ ] **Step 3: Write the compat schema**

Create `shared/compat.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Shared sidecar/engine compatibility matrix",
  "type": "object",
  "required": ["compat"],
  "properties": {
    "compat": {
      "type": "object",
      "required": ["tiers", "engine", "portability"],
      "properties": {
        "tiers": {"type": "object", "minProperties": 1},
        "engine": {
          "type": "object",
          "required": ["states", "data_safety"],
          "properties": {
            "data_safety": {
              "type": "object",
              "required": ["source_ref_shape", "evidence_table"]
            }
          }
        },
        "portability": {
          "type": "object",
          "required": ["required_tables"]
        }
      }
    }
  }
}
```

- [ ] **Step 4: Write the generator**

Create `tools/ct_ci_generate.py`:

```python
"""Render shared/compat.yaml into a stdlib-only Python constants module.

Shipped scripts may not depend on a YAML parser (CONTRIBUTING rule 4), and a
hand-rolled mini-YAML loader is a trap whose edge cases would surface as a
broken doctor on a user's machine. So the compatibility matrix is compiled,
here in CI, into a plain Python module that ships alongside the scripts. CI
regenerates and diffs it on every run, so it cannot drift (spec §3.1, §5.3).
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

import ct_ci_manifest

HEADER = '''"""Compatibility constants generated from shared/compat.yaml.

DO NOT EDIT. This file is generated by `tools/ct_ci.py generate` and verified
in CI. Change shared/compat.yaml and regenerate; a hand edit will fail the
generated-files-are-current gate.

shared/compat.yaml is the single source of truth for sidecar tiers, engine
data-safety state, and export portability. This module exists so stdlib-only
shipped scripts can read those values without a YAML dependency.
"""
'''

_BOUND_RE = re.compile(r"(>=|<)(\d+)\.(\d+)")


def _bounds(expression):
    """Parse a range like '>=2.4,<2.5' into ((2, 4), (2, 5))."""
    low, high = None, None
    for operator, major, minor in _BOUND_RE.findall(expression or ""):
        pair = (int(major), int(minor))
        if operator == ">=":
            low = pair
        else:
            high = pair
    return low, high


def render(compat):
    """Return the full text of a _compat_generated.py for this matrix."""
    root = compat["compat"]
    tiers = []
    for name in sorted(root["tiers"]):
        tier = root["tiers"][name]
        low, high = _bounds(tier.get("sidecar"))
        tiers.append((name, low, high, tier["tools"], tier["write_path"]))

    read_tools = next(t[3] for t in tiers if t[4] == "dormant")
    full_tools = next(t[3] for t in tiers if t[4] == "full")

    unsafe = [
        state
        for state in root["engine"]["states"].values()
        if not state.get("safe", True)
    ]
    pinned = unsafe[0]["pinned_version"] if unsafe else ""
    safety = root["engine"]["data_safety"]

    lines = [HEADER, "", "TIERS = ("]
    for name, low, high, tools, write_path in tiers:
        lines.append(f"    ({name!r}, {low!r}, {high!r}, {tools!r}, {write_path!r}),")
    lines += [
        ")",
        "",
        f"READ_TIER_TOOLS = {read_tools!r}",
        f"FULL_TIER_TOOLS = {full_tools!r}",
        "",
        f"SOURCE_REF_SHAPE = {safety['source_ref_shape']!r}",
        f"EVIDENCE_TABLE = {safety['evidence_table']!r}",
        f"ENGINE_PINNED_VERSION = {pinned!r}",
        f"ENGINE_SAFE = {not unsafe!r}",
        "",
        "REQUIRED_TABLES = (",
    ]
    for table in root["portability"]["required_tables"]:
        lines.append(f"    {table!r},")
    lines += [
        ")",
        "",
        'COMPAT_SOURCE = "shared/compat.yaml"',
        "",
    ]
    return "\n".join(lines)


def _compat(repo_root):
    with open(Path(repo_root) / "shared" / "compat.yaml", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def targets(repo_root):
    """Every generated-file path, for implemented Python integrations."""
    paths = []
    for _id, directory, data in ct_ci_manifest.discover_manifests(repo_root):
        if data.get("status") == "implemented" and data.get("language") == "python":
            paths.append(directory / "scripts" / "_compat_generated.py")
    return paths


def write_all(repo_root):
    """Regenerate every target. Returns the paths written."""
    text = render(_compat(repo_root))
    written = []
    for path in targets(repo_root):
        path.write_text(text, encoding="utf-8")
        written.append(path)
    return written


def check_current(repo_root):
    """Return a stale-file report; empty list means everything is current."""
    text = render(_compat(repo_root))
    stale = []
    for path in targets(repo_root):
        if not path.exists():
            stale.append(f"{path}: missing — run `python tools/ct_ci.py generate`")
        elif path.read_text(encoding="utf-8") != text:
            stale.append(
                f"{path}: stale — shared/compat.yaml changed; "
                "run `python tools/ct_ci.py generate` and commit the result"
            )
    return stale
```

- [ ] **Step 5: Wire the subcommand**

In `tools/ct_ci.py`, add `import ct_ci_generate  # noqa: E402` beside the
existing import, add this function:

```python
def cmd_generate(args):
    if args.check:
        stale = ct_ci_generate.check_current(args.repo)
        for problem in stale:
            print(f"FAIL {problem}", file=sys.stderr)
        return 1 if stale else 0
    for path in ct_ci_generate.write_all(args.repo):
        print(f"wrote {path.relative_to(args.repo)}")
    return 0
```

and register it in `main`:

```python
    generate = sub.add_parser("generate", help="render compat constants")
    generate.add_argument(
        "--check",
        action="store_true",
        help="fail if a generated file is missing or stale, writing nothing",
    )
```

plus the dispatch line, after the `validate` branch:

```python
    if args.command == "generate":
        return cmd_generate(args)
```

- [ ] **Step 6: Generate the file and run the tests**

Run:
```bash
python tools/ct_ci.py generate
python -m unittest discover -s tests/tools -v
```
Expected: `wrote integrations/hermes/scripts/_compat_generated.py`, then PASS.

- [ ] **Step 7: Verify the check mode**

Run:
```bash
python tools/ct_ci.py generate --check; echo "clean=$?"
printf '\n# tampered\n' >> integrations/hermes/scripts/_compat_generated.py
python tools/ct_ci.py generate --check; echo "tampered=$?"
python tools/ct_ci.py generate
```
Expected: `clean=0`, then a `stale` FAIL line with `tampered=1`, then the file
is restored.

- [ ] **Step 8: Commit**

```bash
git add tools/ct_ci.py tools/ct_ci_generate.py shared/compat.schema.json \
        integrations/hermes/scripts/_compat_generated.py \
        tests/tools/test_ct_ci_generate.py
git commit -m "feat(ci): generate stdlib compat constants from shared/compat.yaml"
```

---

### Task 4: Move the doctor and pre-flight onto the generated constants

**Files:**
- Modify: `integrations/hermes/scripts/ct_doctor.py:60-69`
- Modify: `integrations/hermes/scripts/ct_preflight.py` (its `source_ref`
  shape regex, evidence table name, and required-tables list)
- Test: `tests/test_ct_doctor.py` (existing suite must keep passing)

**Interfaces:**
- Consumes: `_compat_generated` (Task 3): `TIERS`, `FULL_TIER_TOOLS`,
  `READ_TIER_TOOLS`, `SOURCE_REF_SHAPE`, `EVIDENCE_TABLE`, `REQUIRED_TABLES`,
  `ENGINE_PINNED_VERSION`.
- Produces: nothing new. `COMPAT_TIERS` keeps its name and tuple shape so the
  existing doctor code and tests are untouched below the constant definition.

This task is what makes the Task 7 literal-ban gate meaningful: the gate is
worthless while the values it bans still live in the code.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_ct_doctor.py`:

```python
class TestCompatConstantsAreGenerated(unittest.TestCase):
    """The tier matrix must come from shared/compat.yaml, not from literals.

    shared/compat.yaml is the single source of truth (spec §5.3). If these
    values are ever retyped into the doctor, the compatibility matrix and the
    doctor can disagree, which is precisely the drift the generated module
    exists to prevent.
    """

    def test_doctor_tiers_come_from_the_generated_module(self):
        import _compat_generated

        self.assertIs(ct_doctor.COMPAT_TIERS, _compat_generated.TIERS)
        self.assertIs(ct_doctor.FULL_TIER_TOOLS, _compat_generated.FULL_TIER_TOOLS)
        self.assertIs(ct_doctor.READ_TIER_TOOLS, _compat_generated.READ_TIER_TOOLS)

    def test_generated_tiers_match_the_shipped_expectations(self):
        import _compat_generated

        by_name = {tier[0]: tier for tier in _compat_generated.TIERS}
        self.assertEqual(by_name["v2.4-read"][3], 8)
        self.assertEqual(by_name["v2.5-full"][3], 14)
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m unittest tests.test_ct_doctor -v -k CompatConstants`
Expected: FAIL — `ct_doctor.COMPAT_TIERS` is a locally defined tuple, not the
generated one (`AssertionError: ... is not ...`).

- [ ] **Step 3: Replace the literals in `ct_doctor.py`**

Replace lines 60-69 (the `# Tier matrix, mirrored from shared/compat.yaml`
comment block through `READ_TIER_TOOLS = 8`) with:

```python
# Tier matrix. shared/compat.yaml is the source of truth; _compat_generated.py
# is compiled from it by `tools/ct_ci.py generate` and verified current in CI,
# so these values cannot drift from the matrix (spec §3.1, §5.3).
import _compat_generated  # noqa: E402

COMPAT_TIERS = _compat_generated.TIERS
FULL_TIER_TOOLS = _compat_generated.FULL_TIER_TOOLS
READ_TIER_TOOLS = _compat_generated.READ_TIER_TOOLS
```

The import goes below the existing `sys.path.insert(0, str(Path(__file__).resolve().parent))`
line so it resolves the same way `ct_env` and `ct_preflight` already do.

- [ ] **Step 4: Replace the literals in `ct_preflight.py`**

Find every module-level constant holding a value that now lives in
`shared/compat.yaml` — the `^librarian-[0-9a-f]{32}$` token-shape regex, the
`librarian_evidence` table name, and any required-tables list — and source them
from the generated module instead. Add near the other imports:

```python
sys.path.insert(0, str(Path(__file__).resolve().parent))

import _compat_generated  # noqa: E402

# Token shape and evidence table are normative (PR #188 §2.2, §2.5.1) and are
# declared in shared/compat.yaml. Never restate them here.
TOKEN_RE = re.compile(_compat_generated.SOURCE_REF_SHAPE)
EVIDENCE_TABLE = _compat_generated.EVIDENCE_TABLE
REQUIRED_TABLES = _compat_generated.REQUIRED_TABLES
```

Keep the existing prose docstrings verbatim: the literal ban in Task 6 scans
code, not comments or docstrings, precisely so this reasoning survives.

Wherever the SQL previously interpolated a hardcoded `librarian_evidence`, use
`EVIDENCE_TABLE`. The table name comes from a repository-controlled data file,
never from user input, so f-string interpolation into the statement is correct
here; do not switch to a parameter (SQLite cannot parameterise identifiers).

- [ ] **Step 5: Run the full Hermes suite**

Run: `python -m unittest discover -s tests -v`
Expected: PASS, all pre-existing tests plus the two new ones.

- [ ] **Step 6: Verify the doctor still runs clean-room**

Run:
```bash
cd "$(mktemp -d)" && python "$OLDPWD/integrations/hermes/scripts/ct_doctor.py" check --json; echo "exit=$?"; cd -
```
Expected: valid JSON with 9 checks and `exit=1` (no sidecar, no brain), no
traceback — the same contract the current workflow asserts.

- [ ] **Step 7: Commit**

```bash
git add integrations/hermes/scripts/ct_doctor.py \
        integrations/hermes/scripts/ct_preflight.py tests/test_ct_doctor.py
git commit -m "refactor(hermes): read compat constants from the generated module"
```

---

### Task 5: Version and manifest hygiene gate

**Files:**
- Create: `tools/ct_ci_policy.py`
- Modify: `tools/ct_ci.py` (add the `policy` subcommand)
- Test: `tests/tools/test_ct_ci_policy_version.py`

**Interfaces:**
- Consumes: `ct_ci_manifest.discover_manifests`, `validate_manifest` (Task 1).
- Produces:
  - `changed_files(repo_root: Path, base_ref: str) -> list[str]` — repo-relative
    POSIX paths changed against `base_ref`.
  - `is_exempt(rel_path: str) -> bool` — True for docs/test paths that do not
    require a version bump.
  - `gate_versions(repo_root: Path, base_ref: str | None) -> list[str]` —
    version/manifest hygiene failures.
  - `read_mirror(directory: Path, mirror: str) -> str | None` — reads
    `plugin.yaml#version`-style references.
  - Module constant `EXEMPT_PATTERNS: tuple[str, ...]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/test_ct_ci_policy_version.py`:

```python
"""Version hygiene: bumps, mirrors and changelog entries."""
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import ct_ci_policy  # noqa: E402


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def make_repo(tmp, version="0.1.0", changelog="## 0.1.0 — 2026-01-01\n\n- initial\n"):
    """A throwaway git repo holding one implemented integration."""
    root = Path(tmp)
    d = root / "integrations" / "demo"
    (d / "scripts").mkdir(parents=True)
    (d / "integration.yaml").write_text(textwrap.dedent(f"""\
        id: demo
        name: Demo
        version: {version}
        language: python
        status: implemented
        requires_sidecar: ">=2.5"
        compat_tier: v2.5-full
        version_mirror: plugin.yaml#version
        matrix:
          os: [ubuntu-latest]
          python: ["3.13"]
        checks:
          test: python -m unittest discover -s tests
        """), encoding="utf-8")
    (d / "plugin.yaml").write_text(f"name: demo\nversion: {version}\n", encoding="utf-8")
    (d / "CHANGELOG.md").write_text(changelog, encoding="utf-8")
    (d / "scripts" / "run.py").write_text("VALUE = 1\n", encoding="utf-8")
    (d / "README.md").write_text("# demo\n", encoding="utf-8")
    (d / "tests").mkdir()
    (d / "tests" / "test_run.py").write_text("def test_x():\n    pass\n", encoding="utf-8")
    git(root, "init", "-b", "main")
    git(root, "config", "user.email", "ci@example.com")
    git(root, "config", "user.name", "CI")
    git(root, "add", "-A")
    git(root, "commit", "-m", "base")
    return root


class TestExemptions(unittest.TestCase):
    def test_readme_is_exempt(self):
        self.assertTrue(ct_ci_policy.is_exempt("integrations/demo/README.md"))

    def test_changelog_is_exempt(self):
        self.assertTrue(ct_ci_policy.is_exempt("integrations/demo/CHANGELOG.md"))

    def test_tests_are_exempt(self):
        self.assertTrue(ct_ci_policy.is_exempt("integrations/demo/tests/test_run.py"))

    def test_docs_are_exempt(self):
        self.assertTrue(ct_ci_policy.is_exempt("integrations/demo/docs/notes.md"))

    def test_shipped_script_is_not_exempt(self):
        self.assertFalse(ct_ci_policy.is_exempt("integrations/demo/scripts/run.py"))


class TestVersionGate(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = make_repo(self.tmp.name)

    def change(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-m", f"change {rel}")

    def test_unchanged_tree_passes(self):
        self.assertEqual(ct_ci_policy.gate_versions(self.root, "HEAD"), [])

    def test_code_change_without_bump_fails(self):
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.strip()
        self.change("integrations/demo/scripts/run.py", "VALUE = 2\n")
        problems = ct_ci_policy.gate_versions(self.root, base)
        self.assertTrue(any("version" in p and "demo" in p for p in problems), problems)

    def test_docs_only_change_without_bump_passes(self):
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.strip()
        self.change("integrations/demo/README.md", "# demo\n\nmore words\n")
        self.assertEqual(ct_ci_policy.gate_versions(self.root, base), [])

    def test_tests_only_change_without_bump_passes(self):
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.strip()
        self.change("integrations/demo/tests/test_run.py", "def test_y():\n    pass\n")
        self.assertEqual(ct_ci_policy.gate_versions(self.root, base), [])

    def test_mixed_tests_and_code_change_without_bump_fails(self):
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.strip()
        self.change("integrations/demo/tests/test_run.py", "def test_y():\n    pass\n")
        self.change("integrations/demo/scripts/run.py", "VALUE = 3\n")
        self.assertTrue(ct_ci_policy.gate_versions(self.root, base))

    def test_bump_without_changelog_entry_fails(self):
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.strip()
        self.change("integrations/demo/scripts/run.py", "VALUE = 4\n")
        self.change(
            "integrations/demo/integration.yaml",
            (self.root / "integrations/demo/integration.yaml")
            .read_text(encoding="utf-8").replace("0.1.0", "0.2.0"),
        )
        self.change("integrations/demo/plugin.yaml", "name: demo\nversion: 0.2.0\n")
        problems = ct_ci_policy.gate_versions(self.root, base)
        self.assertTrue(any("CHANGELOG" in p for p in problems), problems)

    def test_bump_with_changelog_entry_passes(self):
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.strip()
        self.change("integrations/demo/scripts/run.py", "VALUE = 5\n")
        self.change(
            "integrations/demo/integration.yaml",
            (self.root / "integrations/demo/integration.yaml")
            .read_text(encoding="utf-8").replace("0.1.0", "0.2.0"),
        )
        self.change("integrations/demo/plugin.yaml", "name: demo\nversion: 0.2.0\n")
        self.change(
            "integrations/demo/CHANGELOG.md",
            "## 0.2.0 — 2026-02-02\n\n- bumped\n\n## 0.1.0 — 2026-01-01\n\n- initial\n",
        )
        self.assertEqual(ct_ci_policy.gate_versions(self.root, base), [])

    def test_mirror_mismatch_fails_even_with_no_change(self):
        self.change("integrations/demo/plugin.yaml", "name: demo\nversion: 9.9.9\n")
        problems = ct_ci_policy.gate_versions(self.root, "HEAD")
        self.assertTrue(any("plugin.yaml#version" in p for p in problems), problems)

    def test_lowered_version_fails(self):
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True
        ).stdout.strip()
        self.change(
            "integrations/demo/integration.yaml",
            (self.root / "integrations/demo/integration.yaml")
            .read_text(encoding="utf-8").replace("0.1.0", "0.0.9"),
        )
        self.change("integrations/demo/plugin.yaml", "name: demo\nversion: 0.0.9\n")
        problems = ct_ci_policy.gate_versions(self.root, base)
        self.assertTrue(any("greater" in p for p in problems), problems)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m unittest tests.tools.test_ct_ci_policy_version -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ct_ci_policy'`.

- [ ] **Step 3: Write the version gate**

Create `tools/ct_ci_policy.py`:

```python
"""Automated enforcement of the CONTRIBUTING.md architecture rules.

Three independent gate families (spec §5):
    gate_versions  — version/manifest hygiene
    gate_arch      — the architecture rules (Task 6)
    gate_compat    — compat.yaml drift (Task 7)

Every message names the offending file and the rule it enforces, because a
gate the author cannot act on is a gate they will route around.
"""
from __future__ import annotations

import fnmatch
import subprocess
from pathlib import Path

import yaml

import ct_ci_manifest

# A release exists to change what a user runs. Adding a missing unit test or
# fixing a typo in the README changes nothing a user runs, and forcing a bump
# for it trains maintainers to bump reflexively — which is how version numbers
# stop meaning anything (spec §5.1). The exemption is all-or-nothing: one
# shipped-code file in the same change and the bump is required again.
EXEMPT_PATTERNS = (
    "integrations/*/README.md",
    "integrations/*/CHANGELOG.md",
    "integrations/*/docs/*",
    "integrations/*/docs/**",
    "integrations/*/tests/*",
    "integrations/*/tests/**",
    "integrations/*/**/test_*.py",
    "integrations/*/**/*.test.ts",
)


def is_exempt(rel_path):
    """True when this path may change without requiring a version bump."""
    return any(
        fnmatch.fnmatch(rel_path, pattern)
        or fnmatch.fnmatch(rel_path, pattern.replace("/**", "/*/**"))
        for pattern in EXEMPT_PATTERNS
    ) or any(
        # fnmatch's '*' spans '/', so a two-segment prefix check covers nesting.
        rel_path.startswith(prefix)
        for prefix in _dir_prefixes(rel_path)
    )


def _dir_prefixes(rel_path):
    parts = rel_path.split("/")
    if len(parts) >= 3 and parts[0] == "integrations":
        for marker in ("tests", "docs"):
            if marker in parts[2:]:
                return [rel_path]
    return []


def changed_files(repo_root, base_ref):
    """Repo-relative POSIX paths that differ from base_ref."""
    result = subprocess.run(
        ["git", "diff", "--name-only", base_ref],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=True,
    )
    return [line for line in result.stdout.splitlines() if line]


def _file_at_ref(repo_root, ref, rel_path):
    """File contents at a git ref, or None when the file did not exist."""
    result = subprocess.run(
        ["git", "show", f"{ref}:{rel_path}"],
        cwd=repo_root,
        capture_output=True,
        text=True,
    )
    return result.stdout if result.returncode == 0 else None


def read_mirror(directory, mirror):
    """Read `plugin.yaml#version`-style references. None when absent."""
    filename, _, field = mirror.partition("#")
    path = Path(directory) / filename
    if not path.exists():
        return None
    if path.suffix in (".yaml", ".yml"):
        with open(path, encoding="utf-8") as handle:
            data = yaml.safe_load(handle) or {}
    else:
        import json

        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    return data.get(field)


def _semver_key(version):
    """Sort key for SemVer. A prerelease sorts below its release."""
    core, _, pre = str(version).partition("-")
    numbers = tuple(int(part) for part in core.split("."))
    return (numbers, 0 if pre else 1, pre)


def gate_versions(repo_root, base_ref):
    """Version/manifest hygiene (spec §5.1)."""
    repo_root = Path(repo_root)
    problems = []
    changed = set(changed_files(repo_root, base_ref)) if base_ref else set()

    for name, directory, data in ct_ci_manifest.discover_manifests(repo_root):
        rel_dir = f"integrations/{name}/"
        manifest_path = directory / "integration.yaml"
        problems.extend(ct_ci_manifest.validate_manifest(data, manifest_path))

        mirror = data.get("version_mirror")
        if mirror:
            mirrored = read_mirror(directory, mirror)
            if mirrored is None:
                problems.append(
                    f"{manifest_path}: version_mirror '{mirror}' does not resolve"
                )
            elif str(mirrored) != str(data.get("version")):
                problems.append(
                    f"{manifest_path}: version {data.get('version')!r} does not match "
                    f"{mirror} = {mirrored!r}. The CI manifest and the native manifest "
                    f"must agree (spec §5.1)."
                )

        touched = [p for p in changed if p.startswith(rel_dir)]
        material = [p for p in touched if not is_exempt(p)]
        if not material:
            continue

        old_manifest = _file_at_ref(repo_root, base_ref, f"{rel_dir}integration.yaml")
        if old_manifest is None:
            continue  # brand-new integration: nothing to bump from
        old_version = (yaml.safe_load(old_manifest) or {}).get("version")
        new_version = data.get("version")
        if old_version and _semver_key(new_version) <= _semver_key(old_version):
            problems.append(
                f"{rel_dir}: {len(material)} shipped file(s) changed "
                f"(e.g. {material[0]}) but version is still {new_version}. "
                f"It must be greater than {old_version} (spec §5.1). Docs and "
                f"tests are exempt; shipped code is not."
            )
            continue

        changelog = directory / "CHANGELOG.md"
        text = changelog.read_text(encoding="utf-8") if changelog.exists() else ""
        if f"## {new_version}" not in text:
            problems.append(
                f"{changelog}: no entry for version {new_version}. Add a "
                f"'## {new_version} — YYYY-MM-DD' section; the release body is "
                f"taken from it (spec §4.2, §5.1)."
            )
    return problems
```

- [ ] **Step 4: Wire the `policy` subcommand**

In `tools/ct_ci.py`, add `import ct_ci_policy  # noqa: E402`, then:

```python
GATES = {
    "versions": ct_ci_policy.gate_versions,
}


def cmd_policy(args):
    failures = []
    for name, gate in sorted(GATES.items()):
        problems = gate(args.repo, args.base) if name == "versions" else gate(args.repo)
        for problem in problems:
            print(f"FAIL [{name}] {problem}", file=sys.stderr)
        failures.extend(problems)
        if not problems:
            print(f"ok   [{name}]")
    if failures:
        print(f"\n{len(failures)} policy violation(s).", file=sys.stderr)
        return 1
    return 0
```

and in `main`:

```python
    policy = sub.add_parser("policy", help="run the repository policy gates")
    policy.add_argument(
        "--base",
        default=None,
        help="git ref to diff against for version hygiene (e.g. origin/main)",
    )
```

plus the dispatch branch:

```python
    if args.command == "policy":
        return cmd_policy(args)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python -m unittest discover -s tests/tools -v`
Expected: PASS.

- [ ] **Step 6: Run the gate against the real repository**

Run: `python tools/ct_ci.py policy --base origin/main; echo "exit=$?"`
Expected: `ok   [versions]` and `exit=0`. If it reports a missing CHANGELOG
entry for Hermes, that is the gate working — the entry from Task 2 covers
0.2.0, so bump or annotate as the change actually warrants.

- [ ] **Step 7: Commit**

```bash
git add tools/ct_ci_policy.py tools/ct_ci.py tests/tools/test_ct_ci_policy_version.py
git commit -m "feat(ci): version and manifest hygiene gate"
```

---

### Task 6: Architecture lint gate

**Files:**
- Modify: `tools/ct_ci_policy.py` (add `gate_arch` and its helpers)
- Modify: `tools/ct_ci.py` (register the gate)
- Create: `tests/tools/fixtures/` (violation fixtures)
- Test: `tests/tools/test_ct_ci_policy_arch.py`

**Interfaces:**
- Consumes: `ct_ci_manifest.discover_manifests` (Task 1),
  `policy.allow_sqlite_readonly` from the manifests (Task 2).
- Produces:
  - `gate_arch(repo_root: Path) -> list[str]`.
  - `scan_python(path: Path, rel: str, allow_sqlite: bool) -> list[str]` — the
    per-file AST scan, exposed so tests can hit one file at a time.
  - Module constants `STDLIB_ALLOWLIST: frozenset[str]`,
    `CONTRACT_ENV_VARS: frozenset[str]`, `ABS_PATH_RE`.

Scanning is AST-based, not textual: docstrings and comments must keep their
prose (the issue #186 / PR #188 reasoning lives there), so the lint inspects
code nodes and string literals used as values, never `ast.Expr` docstrings or
`#` comments.

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/test_ct_ci_policy_arch.py`:

```python
"""The CONTRIBUTING architecture rules, enforced (spec §5.2)."""
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import ct_ci_policy  # noqa: E402


def scan(source, rel="integrations/demo/scripts/run.py", allow_sqlite=False):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "run.py"
        path.write_text(textwrap.dedent(source), encoding="utf-8")
        return ct_ci_policy.scan_python(path, rel, allow_sqlite)


class TestCrossIntegrationImports(unittest.TestCase):
    def test_importing_another_integration_fails(self):
        problems = scan("from integrations.openclaw import thing\n")
        self.assertTrue(any("cross-integration" in p for p in problems), problems)

    def test_sibling_module_import_passes(self):
        self.assertEqual(scan("import ct_env\n"), [])


class TestThirdPartyImports(unittest.TestCase):
    def test_third_party_import_fails(self):
        problems = scan("import requests\n")
        self.assertTrue(any("requests" in p and "stdlib" in p for p in problems), problems)

    def test_stdlib_imports_pass(self):
        self.assertEqual(scan("import json\nimport re\nfrom pathlib import Path\n"), [])

    def test_generated_module_import_passes(self):
        self.assertEqual(scan("import _compat_generated\n"), [])


class TestDirectBrainAccess(unittest.TestCase):
    def test_sqlite3_import_fails_without_declared_exemption(self):
        problems = scan("import sqlite3\n")
        self.assertTrue(any("sqlite3" in p for p in problems), problems)

    def test_sqlite3_import_passes_when_declared(self):
        self.assertEqual(scan("import sqlite3\n", allow_sqlite=True), [])

    def test_declared_exemption_still_requires_read_only_uri(self):
        problems = scan(
            """
            import sqlite3
            def open_db(path):
                return sqlite3.connect(f"file:{path}", uri=True)
            """,
            allow_sqlite=True,
        )
        self.assertTrue(any("mode=ro" in p for p in problems), problems)

    def test_read_only_uri_passes(self):
        self.assertEqual(
            scan(
                """
                import sqlite3
                def open_db(path):
                    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)
                """,
                allow_sqlite=True,
            ),
            [],
        )


class TestMachineSpecificPaths(unittest.TestCase):
    def test_hardcoded_user_home_fails(self):
        self.assertTrue(scan('BRAIN = "/Users/alice/.brain"\n'))

    def test_hardcoded_linux_home_fails(self):
        self.assertTrue(scan('BRAIN = "/home/alice/.brain"\n'))

    def test_hardcoded_windows_user_path_fails(self):
        self.assertTrue(scan(r'BRAIN = "C:\\Users\\alice\\.brain"' + "\n"))

    def test_hardcoded_program_files_fails(self):
        problems = scan(r'BIN = "C:\\Program Files\\CuratedThoughts\\ct.exe"' + "\n")
        self.assertTrue(any("drive-letter" in p or "absolute" in p for p in problems), problems)

    def test_home_expansion_passes(self):
        self.assertEqual(scan("from pathlib import Path\nBRAIN = Path.home() / '.brain'\n"), [])

    def test_fixture_paths_are_exempt(self):
        self.assertEqual(
            scan(
                r'FAKE = "C:\\Program Files\\x"' + "\n",
                rel="integrations/demo/tests/fixtures/paths.py",
            ),
            [],
        )


class TestEnvironmentContract(unittest.TestCase):
    def test_contract_variables_pass(self):
        self.assertEqual(
            scan(
                """
                import os
                d = os.environ.get("CURATED_BRAIN_DIR")
                b = os.environ.get("CURATED_BRAIN_DB")
                c = os.environ.get("CURATED_BRAIN_CONFIG")
                """
            ),
            [],
        )

    def test_rogue_curated_variable_fails(self):
        problems = scan('import os\nx = os.environ.get("CURATED_HERMES_MODE")\n')
        self.assertTrue(any("CURATED_HERMES_MODE" in p for p in problems), problems)

    def test_non_curated_variable_passes(self):
        self.assertEqual(scan('import os\nx = os.environ.get("OLLAMA_HOST")\n'), [])


class TestRealTree(unittest.TestCase):
    def test_the_repository_passes_its_own_architecture_gate(self):
        self.assertEqual(ct_ci_policy.gate_arch(REPO), [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m unittest tests.tools.test_ct_ci_policy_arch -v`
Expected: FAIL with `AttributeError: module 'ct_ci_policy' has no attribute 'scan_python'`.

- [ ] **Step 3: Implement the scanner**

Append to `tools/ct_ci_policy.py`:

```python
import ast
import re
import sys

# Modules a shipped script may import: the standard library, its own siblings,
# and the generated compat module. Everything else violates CONTRIBUTING rule 4.
STDLIB_ALLOWLIST = frozenset(sys.stdlib_module_names) | {
    "_compat_generated",
    "ct_env",
    "ct_doctor",
    "ct_preflight",
    "ct_status",
}

# CONTRIBUTING rule 3 / the environment contract: these three and nothing else.
CONTRACT_ENV_VARS = frozenset(
    {"CURATED_BRAIN_DIR", "CURATED_BRAIN_DB", "CURATED_BRAIN_CONFIG"}
)

# Any drive-letter path, not merely C:\Users\ — a hardcoded
# "C:\Program Files\..." binary location is just as machine-specific.
ABS_PATH_RE = re.compile(
    r"(^/Users/[^/\s]+)|(^/home/[^/\s]+)|(^[A-Za-z]:[\\/])"
)

_ENV_GETTERS = {"getenv", "get"}


def _is_env_lookup(node):
    """True for os.environ.get('X'), os.getenv('X') and os.environ['X']."""
    if isinstance(node, ast.Subscript):
        target = ast.unparse(node.value)
        return target.endswith("environ")
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        if node.func.attr in _ENV_GETTERS:
            return ast.unparse(node.func.value).endswith(("environ", "os"))
    return False


def _env_name(node):
    if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant):
        return node.slice.value
    if isinstance(node, ast.Call) and node.args:
        first = node.args[0]
        if isinstance(first, ast.Constant):
            return first.value
    return None


def _string_constants(tree):
    """Yield (node, value) for string literals that are values, not docstrings."""
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                docstrings.add(id(body[0].value))
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if id(node) not in docstrings:
                yield node, node.value


def scan_python(path, rel, allow_sqlite):
    """Architecture violations in one Python file. rel is repo-relative POSIX."""
    problems = []
    source = Path(path).read_text(encoding="utf-8")
    try:
        tree = ast.parse(source, filename=str(rel))
    except SyntaxError as exc:
        return [f"{rel}:{exc.lineno}: syntax error, cannot audit ({exc.msg})"]

    in_fixtures = "/tests/fixtures/" in f"/{rel}"
    integration = rel.split("/")[1] if rel.startswith("integrations/") else None
    imports_sqlite = False

    for node in ast.walk(tree):
        names = []
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names = [node.module]
        for name in names:
            root = name.split(".")[0]
            if root == "integrations" or (
                name.startswith("integrations.")
            ):
                other = name.split(".")[1] if "." in name else ""
                if other != integration:
                    problems.append(
                        f"{rel}:{node.lineno}: cross-integration import of "
                        f"'{name}'. Nothing in one integration may depend on "
                        f"another (CONTRIBUTING rule: repository layout)."
                    )
                continue
            if root == "sqlite3":
                imports_sqlite = True
                if not allow_sqlite:
                    problems.append(
                        f"{rel}:{node.lineno}: imports sqlite3. Integrations reach "
                        f"the brain through the sidecar's MCP tools "
                        f"(CONTRIBUTING rule 6). A read-only census may be "
                        f"exempted via policy.allow_sqlite_readonly in "
                        f"integration.yaml."
                    )
                continue
            if root not in STDLIB_ALLOWLIST:
                problems.append(
                    f"{rel}:{node.lineno}: imports '{name}', which is not stdlib. "
                    f"Shipped scripts use the standard library only "
                    f"(CONTRIBUTING rule 4)."
                )

    for node, value in _string_constants(tree):
        if not in_fixtures and ABS_PATH_RE.search(value):
            problems.append(
                f"{rel}:{node.lineno}: hardcoded absolute or drive-letter path "
                f"{value!r}. No machine-specific content (CONTRIBUTING rule 3); "
                f"resolve paths at runtime."
            )

    for node in ast.walk(tree):
        if _is_env_lookup(node):
            name = _env_name(node)
            if (
                isinstance(name, str)
                and name.startswith("CURATED_")
                and name not in CONTRACT_ENV_VARS
            ):
                problems.append(
                    f"{rel}:{node.lineno}: reads '{name}'. The environment "
                    f"contract is exactly {sorted(CONTRACT_ENV_VARS)}; there are "
                    f"no integration-specific variables (README: the environment "
                    f"contract)."
                )

    if allow_sqlite and imports_sqlite:
        if "mode=ro" not in source:
            problems.append(
                f"{rel}: declared in policy.allow_sqlite_readonly but never opens "
                f"the database with a 'mode=ro' URI. The exemption is for "
                f"read-only census only (spec §5.2)."
            )
    return problems


def gate_arch(repo_root):
    """The CONTRIBUTING architecture rules across integrations/ (spec §5.2)."""
    repo_root = Path(repo_root)
    problems = []
    for name, directory, data in ct_ci_manifest.discover_manifests(repo_root):
        exempt = set((data.get("policy") or {}).get("allow_sqlite_readonly") or [])
        for path in sorted(directory.rglob("*.py")):
            if "__pycache__" in path.parts:
                continue
            rel_in_integration = path.relative_to(directory).as_posix()
            rel = path.relative_to(repo_root).as_posix()
            problems.extend(
                scan_python(path, rel, rel_in_integration in exempt)
            )
    return problems
```

Register it in `tools/ct_ci.py` by extending `GATES`:

```python
GATES = {
    "versions": ct_ci_policy.gate_versions,
    "architecture": ct_ci_policy.gate_arch,
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m unittest tests.tools.test_ct_ci_policy_arch -v`
Expected: PASS, including `TestRealTree` — the live tree must satisfy its own
gate. If `ct_preflight.py` fails the sqlite check, confirm Task 2's
`allow_sqlite_readonly` entry names it by its path relative to the integration
directory (`scripts/ct_preflight.py`).

- [ ] **Step 5: Prove the gate catches a real violation**

Run:
```bash
printf '\nDEBUG_BRAIN = "/Users/alice/.brain"\n' >> integrations/hermes/scripts/ct_status.py
python tools/ct_ci.py policy; echo "exit=$?"
git checkout integrations/hermes/scripts/ct_status.py
python tools/ct_ci.py policy; echo "exit=$?"
```
Expected: a FAIL naming `ct_status.py` and its line with `exit=1`, then
`exit=0` after the revert.

- [ ] **Step 6: Commit**

```bash
git add tools/ct_ci_policy.py tools/ct_ci.py tests/tools/test_ct_ci_policy_arch.py
git commit -m "feat(ci): architecture lint enforcing the CONTRIBUTING rules"
```

---

### Task 7: Compat drift gate

**Files:**
- Modify: `tools/ct_ci_policy.py` (add `gate_compat`)
- Modify: `tools/ct_ci.py` (register the gate)
- Test: `tests/tools/test_ct_ci_policy_compat.py`

**Interfaces:**
- Consumes: `ct_ci_generate.check_current` (Task 3),
  `ct_ci_manifest.discover_manifests` (Task 1).
- Produces:
  - `gate_compat(repo_root: Path) -> list[str]`.
  - `banned_literals(repo_root: Path) -> dict[str, str]` — literal value →
    the compat.yaml key it must come from.
  - `ranges_intersect(a: str, b: str) -> bool`.

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/test_ct_ci_policy_compat.py`:

```python
"""compat.yaml drift: tiers, ranges, generated freshness, banned literals."""
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import ct_ci_policy  # noqa: E402


class TestRangeIntersection(unittest.TestCase):
    def test_open_range_intersects_open_tier(self):
        self.assertTrue(ct_ci_policy.ranges_intersect(">=2.5", ">=2.5"))

    def test_requiring_newer_than_a_closed_tier_does_not_intersect(self):
        self.assertFalse(ct_ci_policy.ranges_intersect(">=2.5", ">=2.4,<2.5"))

    def test_overlapping_ranges_intersect(self):
        self.assertTrue(ct_ci_policy.ranges_intersect(">=2.4", ">=2.4,<2.5"))


class TestBannedLiterals(unittest.TestCase):
    def test_the_matrix_values_are_banned(self):
        banned = ct_ci_policy.banned_literals(REPO)
        self.assertIn("librarian_evidence", banned)
        self.assertIn("^librarian-[0-9a-f]{32}$", banned)
        self.assertIn("7.1.0", banned)

    def test_literal_in_code_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "x.py"
            path.write_text(
                textwrap.dedent(
                    '''
                    """Docstring mentioning librarian_evidence is fine."""
                    TABLE = "librarian_evidence"
                    '''
                ),
                encoding="utf-8",
            )
            problems = ct_ci_policy.scan_compat_literals(
                path, "integrations/demo/scripts/x.py", ct_ci_policy.banned_literals(REPO)
            )
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("librarian_evidence", problems[0])

    def test_docstrings_and_comments_are_not_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "x.py"
            path.write_text(
                textwrap.dedent(
                    '''
                    """The evidence lives in librarian_evidence (PR #188 §2.2)."""
                    # tool counts are 8 and 14
                    import _compat_generated
                    TABLE = _compat_generated.EVIDENCE_TABLE
                    '''
                ),
                encoding="utf-8",
            )
            problems = ct_ci_policy.scan_compat_literals(
                path, "integrations/demo/scripts/x.py", ct_ci_policy.banned_literals(REPO)
            )
        self.assertEqual(problems, [])

    def test_the_generated_module_itself_is_exempt(self):
        problems = ct_ci_policy.scan_compat_literals(
            REPO / "integrations/hermes/scripts/_compat_generated.py",
            "integrations/hermes/scripts/_compat_generated.py",
            ct_ci_policy.banned_literals(REPO),
        )
        self.assertEqual(problems, [])


class TestCompatGate(unittest.TestCase):
    def test_the_repository_passes_its_own_compat_gate(self):
        self.assertEqual(ct_ci_policy.gate_compat(REPO), [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m unittest tests.tools.test_ct_ci_policy_compat -v`
Expected: FAIL — `ranges_intersect` does not exist.

- [ ] **Step 3: Implement the gate**

Append to `tools/ct_ci_policy.py`:

```python
import ct_ci_generate


def _range_bounds(expression):
    low, high = None, None
    for operator, major, minor in re.findall(r"(>=|<)(\d+)\.(\d+)", expression or ""):
        pair = (int(major), int(minor))
        if operator == ">=":
            low = pair
        else:
            high = pair
    return low, high


def ranges_intersect(required, tier):
    """True when two '>=2.5' / '>=2.4,<2.5' style ranges overlap."""
    req_low, req_high = _range_bounds(required)
    tier_low, tier_high = _range_bounds(tier)
    low = max(filter(None, [req_low, tier_low]), default=(0, 0))
    highs = [h for h in (req_high, tier_high) if h is not None]
    high = min(highs) if highs else None
    return high is None or low < high


def banned_literals(repo_root):
    """Compat values that must never be retyped into integration code."""
    with open(Path(repo_root) / "shared" / "compat.yaml", encoding="utf-8") as handle:
        compat = yaml.safe_load(handle)["compat"]
    banned = {}
    safety = compat["engine"]["data_safety"]
    banned[safety["source_ref_shape"]] = "compat.engine.data_safety.source_ref_shape"
    banned[safety["evidence_table"]] = "compat.engine.data_safety.evidence_table"
    for state in compat["engine"]["states"].values():
        if state.get("pinned_version"):
            banned[state["pinned_version"]] = "compat.engine.states[].pinned_version"
    for table in compat["portability"]["required_tables"]:
        banned.setdefault(table, "compat.portability.required_tables")
    return banned


def scan_compat_literals(path, rel, banned):
    """Report compat.yaml values appearing as literals in code (not prose)."""
    if rel.endswith("_compat_generated.py"):
        return []
    problems = []
    tree = ast.parse(Path(path).read_text(encoding="utf-8"), filename=str(rel))
    for node, value in _string_constants(tree):
        if value in banned:
            problems.append(
                f"{rel}:{node.lineno}: literal {value!r} duplicates "
                f"{banned[value]}. shared/compat.yaml is the single source of "
                f"truth; read it from _compat_generated instead (spec §5.3)."
            )
    return problems


def gate_compat(repo_root):
    """compat.yaml drift and generated-file freshness (spec §5.3)."""
    repo_root = Path(repo_root)
    problems = list(ct_ci_generate.check_current(repo_root))

    with open(repo_root / "shared" / "compat.yaml", encoding="utf-8") as handle:
        compat = yaml.safe_load(handle)["compat"]
    tiers = compat["tiers"]
    banned = banned_literals(repo_root)

    for name, directory, data in ct_ci_manifest.discover_manifests(repo_root):
        manifest_path = f"integrations/{name}/integration.yaml"
        tier_name = data.get("compat_tier")
        tier = tiers.get(tier_name)
        if tier is None:
            problems.append(
                f"{manifest_path}: compat_tier {tier_name!r} is not defined in "
                f"shared/compat.yaml (spec §5.3). Known tiers: {sorted(tiers)}."
            )
            continue
        if not ranges_intersect(data.get("requires_sidecar", ""), tier.get("sidecar", "")):
            problems.append(
                f"{manifest_path}: requires_sidecar "
                f"{data.get('requires_sidecar')!r} cannot be satisfied by tier "
                f"{tier_name} ({tier.get('sidecar')!r}) (spec §5.3)."
            )
        for path in sorted(directory.rglob("*.py")):
            if "__pycache__" in path.parts:
                continue
            problems.extend(
                scan_compat_literals(path, path.relative_to(repo_root).as_posix(), banned)
            )
    return problems
```

Register it in `tools/ct_ci.py`:

```python
GATES = {
    "versions": ct_ci_policy.gate_versions,
    "architecture": ct_ci_policy.gate_arch,
    "compat": ct_ci_policy.gate_compat,
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m unittest discover -s tests/tools -v`
Expected: PASS. `TestCompatGate` failing means a literal survived Task 4 —
fix the source file, not the gate.

- [ ] **Step 5: Prove the gate catches drift**

Run:
```bash
python - <<'PY'
from pathlib import Path
p = Path("integrations/hermes/scripts/ct_status.py")
p.write_text(p.read_text() + '\nTABLE = "librarian_evidence"\n')
PY
python tools/ct_ci.py policy; echo "exit=$?"
git checkout integrations/hermes/scripts/ct_status.py
```
Expected: `FAIL [compat] ... duplicates compat.engine.data_safety.evidence_table`
with `exit=1`.

- [ ] **Step 6: Commit**

```bash
git add tools/ct_ci_policy.py tools/ct_ci.py tests/tools/test_ct_ci_policy_compat.py
git commit -m "feat(ci): compat drift gate and generated-file freshness check"
```

---

### Task 8: Make the Hermes integration self-contained

**Files:**
- Move: `tests/test_ct_doctor.py` → `integrations/hermes/tests/test_ct_doctor.py`
- Move: `tests/test_install.py` → `integrations/hermes/tests/test_install.py`
- Modify: `integrations/hermes/scripts/ct_doctor.py:918-939` (`_self_test_suite`)
- Modify: `.github/workflows/ci.yml` (paths in the existing steps, temporarily)

**Interfaces:**
- Consumes: the manifest's `checks.test` (`python -m unittest discover -s tests`,
  run with the integration directory as cwd).
- Produces: `integrations/hermes/tests/` as the integration's test root.
  `tests/tools/` at the repository root stays where it is — it tests
  repository tooling, not an integration.

Path-filtered discovery is only honest if an integration's tests live inside
it; otherwise a change to `tests/test_ct_doctor.py` would trigger no
integration job at all.

- [ ] **Step 1: Move the files**

```bash
mkdir -p integrations/hermes/tests
git mv tests/test_ct_doctor.py integrations/hermes/tests/test_ct_doctor.py
git mv tests/test_install.py integrations/hermes/tests/test_install.py
```

- [ ] **Step 2: Run the suite from the integration directory to see it fail**

Run: `cd integrations/hermes && python -m unittest discover -s tests -v; cd -`
Expected: FAIL or ERROR — the moved tests compute their import paths from the
old depth (`parents[2]`-style walks to the repo root).

- [ ] **Step 3: Fix the import paths in the moved tests**

In both moved files, the `sys.path` bootstrap must resolve the scripts
directory relative to the new location. Replace whatever root-walk they use
with:

```python
HERE = Path(__file__).resolve().parent
INTEGRATION = HERE.parent
sys.path.insert(0, str(INTEGRATION / "scripts"))
```

Any reference to the repository root (for example reading
`shared/compat.yaml`) becomes `INTEGRATION.parents[1]`.

- [ ] **Step 4: Fix the doctor's self-test resolution**

Replace `_self_test_suite` in `integrations/hermes/scripts/ct_doctor.py`
(lines 918-939) with:

```python
def _self_test_suite():
    # tests/ lives inside this integration:
    # integrations/hermes/{scripts/ct_doctor.py, tests/test_ct_doctor.py}.
    # Resolve relative to __file__ so the self-test works from any cwd.
    import importlib.util

    tests_dir = Path(__file__).resolve().parents[1] / "tests"
    sys.path.insert(0, str(tests_dir))
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    candidate = tests_dir / "test_ct_doctor.py"
    if not candidate.exists():
        raise RuntimeError(
            f"self-test suite not found at {candidate}; the doctor must ship "
            f"alongside its tests"
        )
    spec = importlib.util.spec_from_file_location("test_ct_doctor", candidate)
    module = importlib.util.module_from_spec(spec)
    sys.modules["test_ct_doctor"] = module
    spec.loader.exec_module(module)
    return unittest.defaultTestLoader.loadTestsFromModule(module)
```

The old two-branch fallback existed only to tolerate the ambiguous layout;
with tests inside the integration there is one location, so a missing suite is
a real error rather than something to paper over.

- [ ] **Step 5: Run both entry points to verify they pass**

Run:
```bash
cd integrations/hermes && python -m unittest discover -s tests -v; cd -
cd "$(mktemp -d)" && python "$OLDPWD/integrations/hermes/scripts/ct_doctor.py" --self-test; echo "exit=$?"; cd -
```
Expected: PASS from the integration directory, and `exit=0` for the self-test
run from an unrelated cwd.

- [ ] **Step 6: Verify the policy gates still pass**

Run: `python tools/ct_ci.py policy; echo "exit=$?"`
Expected: `exit=0`. Test files are exempt from the version bump, so this move
requires no release.

- [ ] **Step 7: Commit**

```bash
git add -A integrations/hermes tests
git commit -m "refactor(hermes): move the test suite inside the integration"
```

---

### Task 9: Split `ci.yml` into discover / integration / policy / ci-ok

**Files:**
- Modify: `tools/ct_ci.py` (add the `discover` subcommand)
- Test: `tests/tools/test_ct_ci_discover.py`
- Modify: `.github/workflows/ci.yml` (replaced wholesale)

**Interfaces:**
- Consumes: every gate from Tasks 5-7, `discover_manifests` (Task 1).
- Produces:
  - `select(repo_root: Path, base_ref: str | None, all_: bool) -> list[dict]` —
    matrix entries `{"id", "dir", "language", "os", "python"|"node", "checks"}`.
  - `ct_ci.py discover --base <ref> [--all]` prints one JSON array on stdout.

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/test_ct_ci_discover.py`:

```python
"""Which integrations CI exercises for a given change."""
import json
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import ct_ci_discover  # noqa: E402


class TestSelect(unittest.TestCase):
    def test_all_selects_every_implemented_integration(self):
        entries = ct_ci_discover.select(REPO, base_ref=None, all_=True)
        self.assertEqual([e["id"] for e in entries], ["hermes"])

    def test_planned_integrations_are_never_selected(self):
        entries = ct_ci_discover.select(REPO, base_ref=None, all_=True)
        self.assertNotIn("openclaw", [e["id"] for e in entries])

    def test_entries_carry_the_matrix_and_checks(self):
        entry = ct_ci_discover.select(REPO, base_ref=None, all_=True)[0]
        self.assertIn("windows-latest", entry["os"])
        self.assertIn("3.9", entry["python"])
        self.assertIn("test", entry["checks"])
        self.assertEqual(entry["dir"], "integrations/hermes")

    def test_shared_path_change_selects_everything(self):
        self.assertTrue(
            ct_ci_discover.affects_all(["shared/compat.yaml"])
        )
        self.assertTrue(ct_ci_discover.affects_all(["tools/ct_ci.py"]))
        self.assertTrue(ct_ci_discover.affects_all([".github/workflows/ci.yml"]))

    def test_integration_only_change_does_not_affect_all(self):
        self.assertFalse(
            ct_ci_discover.affects_all(["integrations/hermes/scripts/ct_env.py"])
        )


class TestCli(unittest.TestCase):
    def test_discover_all_emits_json(self):
        out = subprocess.run(
            [sys.executable, str(REPO / "tools" / "ct_ci.py"), "discover", "--all"],
            capture_output=True, text=True, check=True,
        ).stdout
        entries = json.loads(out)
        self.assertEqual([e["id"] for e in entries], ["hermes"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m unittest tests.tools.test_ct_ci_discover -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ct_ci_discover'`.

- [ ] **Step 3: Implement discovery**

Create `tools/ct_ci_discover.py`:

```python
"""Choose which integrations a CI run exercises (spec §4.1).

Path filtering is a PR-only optimisation. It is notoriously brittle around
shared assets, so main and tags always run everything: PRs may be fast, main
must be ground truth.
"""
from __future__ import annotations

from pathlib import Path

import ct_ci_manifest
import ct_ci_policy

SHARED_PREFIXES = ("shared/", "tools/", ".github/")
SHARED_FILES = (".gitignore", "CONTRIBUTING.md")


def affects_all(changed):
    """True when a change touches anything every integration depends on."""
    return any(
        path.startswith(SHARED_PREFIXES) or path in SHARED_FILES for path in changed
    )


def _entry(name, directory, data, repo_root):
    matrix = data.get("matrix") or {}
    entry = {
        "id": name,
        "dir": directory.relative_to(repo_root).as_posix(),
        "language": data.get("language"),
        "os": matrix.get("os", ["ubuntu-latest"]),
        "checks": data.get("checks") or {},
    }
    entry["python" if data.get("language") == "python" else "node"] = matrix.get(
        "python" if data.get("language") == "python" else "node", []
    )
    return entry


def select(repo_root, base_ref, all_=False):
    """Matrix entries for the integrations this run must exercise."""
    repo_root = Path(repo_root)
    manifests = [
        (name, directory, data)
        for name, directory, data in ct_ci_manifest.discover_manifests(repo_root)
        if data.get("status") == "implemented"
    ]
    if all_ or base_ref is None:
        chosen = manifests
    else:
        changed = ct_ci_policy.changed_files(repo_root, base_ref)
        if affects_all(changed):
            chosen = manifests
        else:
            chosen = [
                (name, directory, data)
                for name, directory, data in manifests
                if any(path.startswith(f"integrations/{name}/") for path in changed)
            ]
    return [_entry(name, directory, data, repo_root) for name, directory, data in chosen]
```

Add to `tools/ct_ci.py`: `import ct_ci_discover  # noqa: E402`, then

```python
def cmd_discover(args):
    entries = ct_ci_discover.select(args.repo, args.base, args.all)
    print(json.dumps(entries))
    return 0
```

with `import json` at the top, this parser registration in `main`:

```python
    discover = sub.add_parser("discover", help="emit the CI matrix as JSON")
    discover.add_argument("--base", default=None, help="git ref to diff against")
    discover.add_argument(
        "--all", action="store_true", help="select every implemented integration"
    )
```

and the dispatch branch:

```python
    if args.command == "discover":
        return cmd_discover(args)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m unittest discover -s tests/tools -v`
Expected: PASS.

- [ ] **Step 5: Replace the workflow**

Overwrite `.github/workflows/ci.yml`:

```yaml
name: CI

# Manifest-driven monorepo CI.
# Spec: docs/superpowers/specs/2026-09-06-monorepo-ci-and-independent-versioning-design.md
#
# discover -> integration (matrix) -> policy -> ci-ok
#
# Adding a harness means adding integrations/<id>/integration.yaml. This file
# should not need to change again.

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  discover:
    name: discover integrations
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.select.outputs.matrix }}
      empty: ${{ steps.select.outputs.empty }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          # Repository-controlled Python executes after checkout. Without this,
          # checkout leaves the job token in .git/config where that code could
          # read it; `contents: read` limits the token's power, not its
          # disclosure. Nothing here pushes, so no credential is needed.
          persist-credentials: false
          # Path filtering needs the merge base, so the history must be there.
          fetch-depth: 0

      - uses: actions/setup-python@0b93645e9fea7318ecaed2b359559ac225c90a2b # v5.3.0
        with:
          python-version: "3.13"

      - run: pip install --disable-pip-version-check -r tools/requirements-ci.txt

      - id: select
        # main and tags run everything: path filters are brittle around shared
        # assets, and main must be ground truth.
        run: |
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            git fetch --no-tags --depth=0 origin "${{ github.base_ref }}"
            MATRIX=$(python tools/ct_ci.py discover --base "origin/${{ github.base_ref }}")
          else
            MATRIX=$(python tools/ct_ci.py discover --all)
          fi
          echo "matrix=$MATRIX" >> "$GITHUB_OUTPUT"
          python - <<PY >> "$GITHUB_OUTPUT"
          import json
          print("empty=" + str(not json.loads('''$MATRIX''')).lower())
          PY
          echo "selected: $MATRIX"

  integration:
    name: ${{ matrix.entry.id }} (${{ matrix.os }}, py${{ matrix.python }})
    needs: discover
    if: needs.discover.outputs.empty == 'false'
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        entry: ${{ fromJson(needs.discover.outputs.matrix) }}
        # Expanded from each entry's declared matrix by the include below.
        os: ${{ fromJson(needs.discover.outputs.matrix)[0].os }}
        python: ${{ fromJson(needs.discover.outputs.matrix)[0].python }}
    defaults:
      run:
        working-directory: ${{ matrix.entry.dir }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false

      - uses: actions/setup-python@0b93645e9fea7318ecaed2b359559ac225c90a2b # v5.3.0
        if: matrix.entry.language == 'python'
        with:
          python-version: ${{ matrix.python }}

      - name: Tests
        if: matrix.entry.checks.test != ''
        run: ${{ matrix.entry.checks.test }}

      - name: Doctor self-test (spec §9.5)
        # Runs the same suite through the shipped entry point from outside the
        # checkout, proving the script resolves tests/ relative to __file__.
        if: matrix.entry.id == 'hermes'
        working-directory: ${{ runner.temp }}
        run: python "${{ github.workspace }}/integrations/hermes/scripts/ct_doctor.py" --self-test

      - name: Doctor runs clean-room without crashing
        # No sidecar, no brain: every check must still resolve to a verdict and
        # the process must exit 1 (FAILs), never traceback.
        if: matrix.entry.id == 'hermes' && runner.os != 'Windows'
        working-directory: ${{ runner.temp }}
        run: |
          set +e
          python "${{ github.workspace }}/integrations/hermes/scripts/ct_doctor.py" check --json > out.json
          rc=$?
          set -e
          test "$rc" = "1" || { echo "expected exit 1 with no sidecar/brain, got $rc"; exit 1; }
          python -c "
          import json
          d = json.load(open('out.json'))
          names = [c['name'] for c in d['checks']]
          assert len(names) == 9, names
          assert d['exit_code'] == 1, d['exit_code']
          print('checks:', ', '.join(names))
          "

  policy:
    name: policy gates
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false
          fetch-depth: 0

      - uses: actions/setup-python@0b93645e9fea7318ecaed2b359559ac225c90a2b # v5.3.0
        with:
          python-version: "3.13"

      - run: pip install --disable-pip-version-check -r tools/requirements-ci.txt ruff

      - name: Tooling tests
        run: python -m unittest discover -s tests/tools -v

      - name: Manifest schema
        run: python tools/ct_ci.py validate

      - name: Generated compat constants are current
        run: python tools/ct_ci.py generate --check

      - name: Policy gates (versions, architecture, compat)
        run: |
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            git fetch --no-tags origin "${{ github.base_ref }}"
            python tools/ct_ci.py policy --base "origin/${{ github.base_ref }}"
          else
            python tools/ct_ci.py policy
          fi

      - name: Ruff (errors and undefined names)
        # Deliberately the correctness subset, not a style opinion: syntax
        # errors, undefined names, broken f-strings, unused imports.
        run: ruff check --select E9,F63,F7,F82,F401 .

      - name: Shellcheck every declared script
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y -qq shellcheck
          python - <<'PY' | xargs -r shellcheck
          import sys
          sys.path.insert(0, "tools")
          import ct_ci_manifest
          for name, directory, data in ct_ci_manifest.discover_manifests("."):
              for script in (data.get("checks") or {}).get("shell", []):
                  print(directory / script)
          PY

      - name: Plugin entry point registers against a stub host
        # The Hermes contract is verified against a stub ctx rather than a live
        # host (Hermes is not installable in CI): three skills, the
        # on_session_start hook, and graceful degradation when the optional
        # system-prompt API is absent.
        run: |
          python - <<'PY'
          import importlib.util, sys
          from pathlib import Path
          root = Path("integrations/hermes").resolve()
          spec = importlib.util.spec_from_file_location("ct_plugin", root / "__init__.py")
          m = importlib.util.module_from_spec(spec); sys.modules["ct_plugin"] = m
          spec.loader.exec_module(m)

          class Ctx:
              def __init__(self): self.skills=[]; self.hooks=[]; self.sections=[]
              def register_skill(self, n, p): self.skills.append((n, p))
              def register_hook(self, e, cb): self.hooks.append((e, cb))
              def register_system_prompt_section(self, i, cb): self.sections.append((i, cb))

          ctx = Ctx(); m.register(ctx)
          assert len(ctx.skills) == 3, ctx.skills
          assert [e for e, _ in ctx.hooks] == ["on_session_start"], ctx.hooks
          assert len(ctx.sections) == 1, ctx.sections
          ctx.hooks[0][1](session_id="ci", cwd=".")
          assert ctx.sections[0][1](), "system prompt section rendered empty"

          class Minimal(Ctx):
              pass
          mc = Minimal(); mc.register_system_prompt_section = None
          m.register(mc)
          assert [e for e, _ in mc.hooks] == ["on_session_start"]
          print("plugin entry point OK")
          PY

  ci-ok:
    # The single required status check. Branch protection names this job and
    # nothing else, so adding an integration never means editing protection
    # rules. An empty (skipped) integration matrix is success; a failed or
    # cancelled dependency is not.
    name: ci-ok
    if: always()
    needs: [discover, integration, policy]
    runs-on: ubuntu-latest
    steps:
      - name: Check dependency results
        run: |
          echo "discover=${{ needs.discover.result }}"
          echo "integration=${{ needs.integration.result }}"
          echo "policy=${{ needs.policy.result }}"
          for result in "${{ needs.discover.result }}" "${{ needs.policy.result }}"; do
            [ "$result" = "success" ] || { echo "a required job did not succeed"; exit 1; }
          done
          case "${{ needs.integration.result }}" in
            success|skipped) ;;
            *) echo "integration matrix did not succeed"; exit 1 ;;
          esac
          echo "all green"
```

- [ ] **Step 6: Validate the workflow YAML locally**

Run:
```bash
python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('workflow parses')"
python tools/ct_ci.py discover --all
```
Expected: `workflow parses`, then a JSON array with one `hermes` entry.

- [ ] **Step 7: Commit and push a PR to watch it run**

```bash
git add .github/workflows/ci.yml tools/ct_ci.py tools/ct_ci_discover.py \
        tests/tools/test_ct_ci_discover.py
git commit -m "ci: manifest-driven discover/integration/policy/ci-ok pipeline"
```

Open a PR and confirm on GitHub: `discover` selects `hermes`, the integration
matrix expands to 6 jobs (3 OS x 2 Python), `policy` is green, and `ci-ok`
reports success. **Do not proceed to Task 10 until a real run is green** —
matrix expansion is the one part of this plan that cannot be verified locally.
If the `matrix.os` / `matrix.python` expansion in the `integration` job does
not resolve as intended for multiple integrations, replace the two
`fromJson(...)[0]` lines with a fully pre-expanded matrix: have
`ct_ci_discover.select` emit one entry per `(id, os, interpreter)` triple and
use `matrix: {include: ${{ fromJson(needs.discover.outputs.matrix) }}}`.

---

### Task 10: Tag-driven releases

**Files:**
- Create: `tools/ct_ci_package.py`
- Modify: `tools/ct_ci.py` (add the `package` subcommand)
- Create: `.github/workflows/release.yml`
- Test: `tests/tools/test_ct_ci_package.py`

**Interfaces:**
- Consumes: `discover_manifests` (Task 1), each manifest's `package` block.
- Produces:
  - `parse_tag(tag: str) -> tuple[str, str]` — `("hermes", "0.2.1")`; raises
    `ValueError` on a malformed tag.
  - `build(repo_root: Path, integration_id: str, out_dir: Path) -> Path` —
    writes `<id>-<version>.tar.gz`, returns its path.
  - `write_checksums(paths: list[Path], out_dir: Path) -> Path` — writes
    `SHA256SUMS`.
  - `changelog_section(directory: Path, version: str) -> str` — the release
    body; raises `ValueError` when the section is absent.
  - `is_prerelease(version: str) -> bool`.

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/test_ct_ci_package.py`:

```python
"""Release tag parsing, tarball construction and release bodies."""
import hashlib
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import ct_ci_package  # noqa: E402


class TestParseTag(unittest.TestCase):
    def test_simple_tag(self):
        self.assertEqual(ct_ci_package.parse_tag("hermes-v0.2.1"), ("hermes", "0.2.1"))

    def test_hyphenated_id(self):
        self.assertEqual(
            ct_ci_package.parse_tag("claude-code-v1.0.0"), ("claude-code", "1.0.0")
        )

    def test_prerelease_tag(self):
        self.assertEqual(
            ct_ci_package.parse_tag("hermes-v0.3.0-rc.1"), ("hermes", "0.3.0-rc.1")
        )

    def test_malformed_tag_raises(self):
        for bad in ("hermes-0.2.1", "v0.2.1", "hermes-vX.Y.Z", "hermes"):
            with self.subTest(tag=bad):
                with self.assertRaises(ValueError):
                    ct_ci_package.parse_tag(bad)


class TestPrerelease(unittest.TestCase):
    def test_release_is_not_prerelease(self):
        self.assertFalse(ct_ci_package.is_prerelease("0.2.1"))

    def test_rc_is_prerelease(self):
        self.assertTrue(ct_ci_package.is_prerelease("0.3.0-rc.1"))


class TestBuild(unittest.TestCase):
    def test_tarball_contains_scripts_and_excludes_pycache(self):
        with tempfile.TemporaryDirectory() as out:
            path = ct_ci_package.build(REPO, "hermes", Path(out))
            self.assertEqual(path.name, "hermes-0.2.0.tar.gz")
            with tarfile.open(path) as archive:
                names = archive.getnames()
            self.assertTrue(any(n.endswith("scripts/ct_doctor.py") for n in names), names[:5])
            self.assertTrue(any(n.endswith("_compat_generated.py") for n in names))
            self.assertFalse(any("__pycache__" in n for n in names))

    def test_archive_members_share_a_versioned_root(self):
        with tempfile.TemporaryDirectory() as out:
            path = ct_ci_package.build(REPO, "hermes", Path(out))
            with tarfile.open(path) as archive:
                roots = {n.split("/")[0] for n in archive.getnames()}
            self.assertEqual(roots, {"hermes-0.2.0"})

    def test_checksums_match_the_files(self):
        with tempfile.TemporaryDirectory() as out:
            tarball = ct_ci_package.build(REPO, "hermes", Path(out))
            sums = ct_ci_package.write_checksums([tarball], Path(out))
            digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
            self.assertIn(digest, sums.read_text(encoding="utf-8"))
            self.assertIn(tarball.name, sums.read_text(encoding="utf-8"))


class TestChangelogSection(unittest.TestCase):
    def test_extracts_the_matching_section(self):
        body = ct_ci_package.changelog_section(REPO / "integrations" / "hermes", "0.2.0")
        self.assertIn("Environment contract", body)
        self.assertNotIn("# Changelog", body)

    def test_missing_section_raises(self):
        with self.assertRaises(ValueError):
            ct_ci_package.changelog_section(REPO / "integrations" / "hermes", "9.9.9")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails**

Run: `python -m unittest tests.tools.test_ct_ci_package -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ct_ci_package'`.

- [ ] **Step 3: Implement packaging**

Create `tools/ct_ci_package.py`:

```python
"""Build the release artifact for one integration (spec §4.2).

Tag grammar is `<id>-v<semver>`. The id may contain hyphens (claude-code), so
the split is on the LAST '-v' that is followed by a digit.
"""
from __future__ import annotations

import fnmatch
import hashlib
import re
import tarfile
from pathlib import Path

import ct_ci_manifest

TAG_RE = re.compile(r"^(?P<id>[a-z][a-z0-9-]*?)-v(?P<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$")


def parse_tag(tag):
    """('hermes-v0.2.1') -> ('hermes', '0.2.1'). Raises ValueError otherwise."""
    match = TAG_RE.match(tag or "")
    if not match:
        raise ValueError(
            f"tag {tag!r} is not '<id>-v<semver>' (e.g. hermes-v0.2.1)"
        )
    return match.group("id"), match.group("version")


def is_prerelease(version):
    return "-" in version


def _manifest(repo_root, integration_id):
    for name, directory, data in ct_ci_manifest.discover_manifests(repo_root):
        if name == integration_id:
            return directory, data
    raise ValueError(
        f"no integrations/{integration_id}/integration.yaml — the tag names an "
        f"integration that does not exist"
    )


def _selected_files(directory, package):
    include = package.get("include") or ["**"]
    exclude = package.get("exclude") or []
    chosen = []
    for path in sorted(directory.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(directory).as_posix()
        if not any(fnmatch.fnmatch(rel, pattern) or pattern == "**" for pattern in include):
            continue
        if any(fnmatch.fnmatch(rel, pattern) or f"/{rel}".find(pattern.strip("*")) >= 0
               for pattern in exclude if pattern):
            continue
        chosen.append((path, rel))
    return chosen


def build(repo_root, integration_id, out_dir):
    """Write <id>-<version>.tar.gz into out_dir and return its path."""
    directory, data = _manifest(Path(repo_root), integration_id)
    version = data["version"]
    root = f"{integration_id}-{version}"
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"{root}.tar.gz"
    with tarfile.open(target, "w:gz") as archive:
        for path, rel in _selected_files(directory, data.get("package") or {}):
            archive.add(path, arcname=f"{root}/{rel}")
    return target


def write_checksums(paths, out_dir):
    """Write a SHA256SUMS file covering paths; return its path."""
    out_dir = Path(out_dir)
    sums = out_dir / "SHA256SUMS"
    lines = []
    for path in paths:
        digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        lines.append(f"{digest}  {Path(path).name}")
    sums.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return sums


def changelog_section(directory, version):
    """The '## <version>' section body, for the GitHub Release notes."""
    path = Path(directory) / "CHANGELOG.md"
    if not path.exists():
        raise ValueError(f"{path} does not exist; a release needs release notes")
    lines = path.read_text(encoding="utf-8").splitlines()
    collected, capturing = [], False
    for line in lines:
        if line.startswith("## "):
            if capturing:
                break
            capturing = line[3:].strip().startswith(version)
            continue
        if capturing:
            collected.append(line)
    if not capturing and not collected:
        raise ValueError(
            f"{path}: no '## {version}' section. Add one before tagging "
            f"(spec §4.2)."
        )
    return "\n".join(collected).strip()
```

Wire the subcommand in `tools/ct_ci.py`:

```python
def cmd_package(args):
    integration_id, version = ct_ci_package.parse_tag(args.tag)
    directory, data = ct_ci_package._manifest(args.repo, integration_id)
    if str(data.get("version")) != version:
        print(
            f"FAIL tag {args.tag} declares {version} but "
            f"{directory}/integration.yaml says {data.get('version')}",
            file=sys.stderr,
        )
        return 1
    tarball = ct_ci_package.build(args.repo, integration_id, args.out)
    sums = ct_ci_package.write_checksums([tarball], args.out)
    body = ct_ci_package.changelog_section(directory, version)
    (Path(args.out) / "RELEASE_NOTES.md").write_text(body + "\n", encoding="utf-8")
    print(f"artifact={tarball}")
    print(f"checksums={sums}")
    print(f"prerelease={str(ct_ci_package.is_prerelease(version)).lower()}")
    return 0
```

with the parser registration:

```python
    package = sub.add_parser("package", help="build the artifact for a tag")
    package.add_argument("--tag", required=True, help="e.g. hermes-v0.2.1")
    package.add_argument("--out", type=Path, default=Path("dist"))
```

and the dispatch branch, plus `import ct_ci_package  # noqa: E402`:

```python
    if args.command == "package":
        return cmd_package(args)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m unittest discover -s tests/tools -v`
Expected: PASS.

- [ ] **Step 5: Build an artifact locally**

Run:
```bash
python tools/ct_ci.py package --tag hermes-v0.2.0 --out /tmp/ct-dist
tar -tzf /tmp/ct-dist/hermes-0.2.0.tar.gz | head
cat /tmp/ct-dist/SHA256SUMS /tmp/ct-dist/RELEASE_NOTES.md
```
Expected: a `hermes-0.2.0/` rooted listing with no `__pycache__`, one checksum
line, and the 0.2.0 changelog entries as notes.

- [ ] **Step 6: Write the release workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

# Independent per-integration releases (spec §4.2).
# Tag grammar: <id>-v<semver>, e.g. hermes-v0.2.1 or hermes-v0.3.0-rc.1.
# A release never trusts a previous CI run: it re-runs the integration's full
# checks across its full declared matrix before publishing anything.

on:
  push:
    tags:
      - "*-v*"

permissions:
  contents: read

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  identify:
    name: identify and validate the tag
    runs-on: ubuntu-latest
    outputs:
      id: ${{ steps.parse.outputs.id }}
      version: ${{ steps.parse.outputs.version }}
      dir: ${{ steps.parse.outputs.dir }}
      os: ${{ steps.parse.outputs.os }}
      python: ${{ steps.parse.outputs.python }}
      test: ${{ steps.parse.outputs.test }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false

      - uses: actions/setup-python@0b93645e9fea7318ecaed2b359559ac225c90a2b # v5.3.0
        with:
          python-version: "3.13"

      - run: pip install --disable-pip-version-check -r tools/requirements-ci.txt

      - id: parse
        run: |
          python - <<'PY' >> "$GITHUB_OUTPUT"
          import json, os, sys
          sys.path.insert(0, "tools")
          import ct_ci_manifest, ct_ci_package
          tag = os.environ["GITHUB_REF_NAME"]
          ident, version = ct_ci_package.parse_tag(tag)
          directory, data = ct_ci_package._manifest(".", ident)
          if str(data["version"]) != version:
              raise SystemExit(
                  f"tag {tag} does not match {directory}/integration.yaml "
                  f"version {data['version']}"
              )
          if data.get("status") != "implemented":
              raise SystemExit(f"{ident} is status={data.get('status')}; nothing to release")
          # Fails loudly here, before anything is published, if notes are missing.
          ct_ci_package.changelog_section(directory, version)
          matrix = data["matrix"]
          print(f"id={ident}")
          print(f"version={version}")
          print(f"dir={directory.as_posix()}")
          print("os=" + json.dumps(matrix["os"]))
          print("python=" + json.dumps(matrix.get("python", [])))
          print("test=" + data["checks"]["test"])
          PY

      - name: Policy gates must pass at the tagged commit
        run: python tools/ct_ci.py policy

  verify:
    name: ${{ needs.identify.outputs.id }} (${{ matrix.os }}, py${{ matrix.python }})
    needs: identify
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: true
      matrix:
        os: ${{ fromJson(needs.identify.outputs.os) }}
        python: ${{ fromJson(needs.identify.outputs.python) }}
    defaults:
      run:
        working-directory: ${{ needs.identify.outputs.dir }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false
      - uses: actions/setup-python@0b93645e9fea7318ecaed2b359559ac225c90a2b # v5.3.0
        with:
          python-version: ${{ matrix.python }}
      - run: ${{ needs.identify.outputs.test }}

  publish:
    name: publish the release
    needs: [identify, verify]
    runs-on: ubuntu-latest
    permissions:
      # The only job in the repository that may write. Everything upstream of
      # here runs with contents: read.
      contents: write
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false

      - uses: actions/setup-python@0b93645e9fea7318ecaed2b359559ac225c90a2b # v5.3.0
        with:
          python-version: "3.13"

      - run: pip install --disable-pip-version-check -r tools/requirements-ci.txt

      - name: Build the artifact and release notes
        run: python tools/ct_ci.py package --tag "${GITHUB_REF_NAME}" --out dist

      - name: Create the GitHub Release
        uses: softprops/action-gh-release@c95fe1489396fe8a9eb87c0abf8aa5b2ef267fda # v2.2.1
        with:
          name: ${{ needs.identify.outputs.id }} v${{ needs.identify.outputs.version }}
          body_path: dist/RELEASE_NOTES.md
          prerelease: ${{ contains(needs.identify.outputs.version, '-') }}
          files: |
            dist/*.tar.gz
            dist/SHA256SUMS
```

- [ ] **Step 7: Validate and dry-run the release path**

Run:
```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('release workflow parses')"
python tools/ct_ci.py package --tag hermes-v9.9.9 --out /tmp/ct-bad; echo "exit=$?"
```
Expected: `release workflow parses`, then a FAIL naming the mismatch with
`exit=1` — a tag that disagrees with the manifest must never publish.

- [ ] **Step 8: Commit**

```bash
git add tools/ct_ci_package.py tools/ct_ci.py .github/workflows/release.yml \
        tests/tools/test_ct_ci_package.py
git commit -m "feat(ci): tag-driven per-integration releases"
```

- [ ] **Step 9: Exercise it for real with a prerelease tag**

After merging, run:

```bash
git tag hermes-v0.2.1-rc.1 && git push origin hermes-v0.2.1-rc.1
```

First bump `integrations/hermes/integration.yaml` and `plugin.yaml` to
`0.2.1-rc.1` and add the matching CHANGELOG section, or `identify` will
correctly refuse. Confirm on GitHub: a prerelease appears with the tarball,
`SHA256SUMS`, and the changelog body. Delete the prerelease and the tag
afterwards if it was only a rehearsal.

---

### Task 11: Documentation, badges and repository hygiene

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Create: `docs/ci.md`

**Interfaces:**
- Consumes: everything above. Produces no code.

- [ ] **Step 1: Ignore the ruff cache**

```bash
printf '.ruff_cache/\ndist/\n' >> .gitignore
```

- [ ] **Step 2: Document the release process**

Create `docs/ci.md`:

```markdown
# CI and releases

## Adding an integration

1. Create `integrations/<id>/` with an `integration.yaml`
   (see `shared/integration.schema.json`).
2. Start it as `status: planned`. Nothing runs against it until it is
   `implemented`.
3. Put its tests inside the integration, at `integrations/<id>/tests/`.
4. No workflow file changes. `discover` finds it from the manifest.

## Running the gates locally

```bash
pip install -r tools/requirements-ci.txt
python tools/ct_ci.py validate
python tools/ct_ci.py generate --check
python tools/ct_ci.py policy --base origin/main
python tools/ct_ci.py discover --all
```

## Releasing

Releases are per-integration and independent. There is no repository version.

1. Bump `version` in `integrations/<id>/integration.yaml` **and** in the
   native manifest named by `version_mirror`.
2. Add a `## <version> — YYYY-MM-DD` section to
   `integrations/<id>/CHANGELOG.md`. It becomes the release body.
3. Merge, then tag: `git tag <id>-v<version> && git push origin <id>-v<version>`.
4. `release.yml` re-runs the full matrix, builds
   `<id>-<version>.tar.gz` + `SHA256SUMS`, and publishes the GitHub Release.
   A SemVer prerelease suffix marks it as a prerelease.

## When a policy gate fails

| Gate | What it means |
|------|---------------|
| `versions` | Shipped code changed without a version bump, the CI and native manifests disagree, or the CHANGELOG has no entry for the new version. Docs and tests are exempt from the bump. |
| `architecture` | A cross-integration import, a non-stdlib import in shipped code, direct `sqlite3` access, a hardcoded absolute path, or a `CURATED_*` variable outside the three-variable environment contract. |
| `compat` | `_compat_generated.py` is stale (run `python tools/ct_ci.py generate`), a `compat_tier` does not exist, `requires_sidecar` cannot be satisfied by its tier, or a compat.yaml value was retyped as a literal in integration code. |

## Branch protection

Require exactly one status check: **`ci-ok`**. It aggregates `discover`,
the `integration` matrix, and `policy`, so the required-check list never has
to change when integrations are added.
```

- [ ] **Step 3: Update the README**

In the integration table, add a Version column and per-integration release
links:

```markdown
| Harness | Directory | Status | Version |
|---------|-----------|--------|---------|
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | [`integrations/hermes/`](integrations/hermes/) | implemented | [0.2.0](https://github.com/equationalapplications/curated-thoughts-integrations/releases?q=hermes) |
| OpenClaw | `integrations/openclaw/` | planned | — |
| Claude Code | `integrations/claude-code/` | planned | — |
```

Add the CI badge under the title:

```markdown
[![CI](https://github.com/equationalapplications/curated-thoughts-integrations/actions/workflows/ci.yml/badge.svg)](https://github.com/equationalapplications/curated-thoughts-integrations/actions/workflows/ci.yml)
```

And a short section after "The three rules every integration encodes":

```markdown
## Versioning

Each integration versions independently on its own SemVer line and releases
from a `<id>-v<semver>` tag — `hermes-v0.2.0`. There is no repository-wide
version. An integration declares the sidecar range it needs
(`requires_sidecar`) and the `shared/compat.yaml` tier it targets; CI enforces
that the two agree. See [`docs/ci.md`](docs/ci.md).
```

- [ ] **Step 4: Update CONTRIBUTING**

Replace the "Review gates" section with:

```markdown
## Review gates

CI is manifest-driven: `discover` selects the integrations a change affects
(everything, on `main` and tags), each runs its declared checks, and a
repository-wide `policy` job enforces the rules above automatically —
version and changelog hygiene, the architecture rules in this document, and
`shared/compat.yaml` drift. Branch protection requires the single `ci-ok`
check. See [`docs/ci.md`](docs/ci.md) for what each gate means and how to run
it locally.

One review approval is required; spec PRs also need the maintainer's sign-off
on scope before the implementation PR opens.
```

- [ ] **Step 5: Verify everything still passes**

Run:
```bash
python -m unittest discover -s tests/tools -v
cd integrations/hermes && python -m unittest discover -s tests -v; cd -
python tools/ct_ci.py validate && python tools/ct_ci.py generate --check && python tools/ct_ci.py policy
echo "exit=$?"
```
Expected: all suites PASS and `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add .gitignore README.md CONTRIBUTING.md docs/ci.md
git commit -m "docs: document the CI pipeline, gates and release process"
```

- [ ] **Step 7: Switch branch protection**

Manual, on GitHub: Settings → Branches → `main` → Required status checks →
remove the old per-job entries, add `ci-ok`. This cannot be scripted from the
repository and is the last step, after a green run on `main`.

---

## Notes for the executor

- **Task 9 Step 7 is a hard gate.** GitHub Actions matrix expansion from a
  dynamic JSON output cannot be verified locally. Do not start Task 10 until a
  real PR run is green, and take the pre-expanded-matrix fallback described
  there if the nested expansion misbehaves.
- **`language: node` is designed but unexercised.** The schema, discovery and
  packaging paths accept it; no integration uses it yet. Do not add speculative
  `vsce` wiring — the first VS Code extension adds it, with tests, then.
- **Never weaken a gate to make a build pass.** If `gate_arch` or `gate_compat`
  fails against the real tree, the source file is wrong, not the gate. The one
  legitimate escape is a reviewed `policy.allow_sqlite_readonly` entry, which
  still requires a `mode=ro` open.
