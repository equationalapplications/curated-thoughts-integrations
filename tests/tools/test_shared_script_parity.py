"""Shared-script parity gate: Hermes vs Claude Code and Docker Agent (issue #33).

`integrations/hermes/scripts/` and `integrations/claude-code/scripts/` carry
copies of the same stdlib scripts. Each integration ships standalone (no
cross-integration imports), so the code is duplicated, and duplicated code
drifts. Drift here caused the #14/#28/#29 bug class to come back in the
Claude Code doctor. This gate is what makes the copies' "keep identical"
claim enforceable.

Contract (spec 2026-10-16-shared-env-doctor-parity-design.md, D3/D4):

  * ct_env.py, ct_status.py, ct_preflight.py, ct_wisdom_activity.py (the
    autonomous-work builder) and the other IDENTICAL scripts are
    byte-identical (line endings normalized: Windows checkouts may be CRLF
    on disk).
  * ct_tool_dedup.py and ct_wisdom_activity_delivery.py are Hermes-only:
    present in Hermes, absent from the copies, and the builder must not
    define or import the Hermes delivery.
  * ct_doctor.py is identical outside a CLOSED list of named marker regions:

        # >>> harness-specific: <name>
        ...
        # <<< harness-specific: <name>

    Each region collapses to a placeholder before comparison. Both copies
    must carry the same regions in the same order. A new region name fails
    here until this file's allowlist is edited, so a reviewer sees it.

It lives in tests/tools/ rather than an integration's tests/ because CI's
path filter only runs an integration's suite when that integration changes.
A Hermes-only edit would never run a Claude Code-side gate. The policy job
runs tests/tools on every PR. Nothing is written; both trees are only read.
"""
from __future__ import annotations

import ast
import difflib
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
REFERENCE = REPO / "integrations" / "hermes" / "scripts"
COPIES = (
    REPO / "integrations" / "claude-code" / "scripts",
    REPO / "integrations" / "docker-agent" / "scripts",
)

IDENTICAL = (
    "ct_env.py",
    "ct_status.py",
    "ct_preflight.py",
    # The Intuitive Wisdom core (ledger markers, bootstrap render, live
    # match/render/breaker). Claude Code's hooks/ct_wisdom_cc.py adapter runs
    # this exact algorithm; an installed plugin cannot reach ../hermes, so it
    # ships a byte-identical copy (spec 2026-10-16-claude-code-wisdom-parity-
    # leg-design.md, D1).
    "ct_ledger.py",
    "ct_wisdom.py",
    "ct_wisdom_live.py",
    # Verbose mode: the recorder and its log reader (spec 2026-10-16-wisdom-
    # verbose-mode-design.md, D6/D7).
    "ct_wisdom_verbose.py",
    "ct_wisdom_log.py",
    # The autonomous-work activity builder (spec 2026-10-17-hermes-activity-delivery-split-design.md).
    "ct_wisdom_activity.py",
)
# Hook-side modules shared by the command-hook adapters (no Hermes copy:
# Hermes keeps this state in process). Every listed tree must carry an
# identical copy (PR #59 review: the store/lock/prune/breaker primitives).
HOOK_SHARED = {
    "ct_hook_store.py": (
        REPO / "integrations" / "claude-code" / "hooks",
        REPO / "integrations" / "docker-agent" / "hooks",
    ),
}
# Hermes-only scripts: they must exist in Hermes and never in the copies
# (spec 2026-10-17-hermes-activity-delivery-split-design.md).
HERMES_ONLY = ("ct_tool_dedup.py", "ct_wisdom_activity_delivery.py")
# The shared builder must not grow the Hermes delivery back.
BUILDER = "ct_wisdom_activity.py"
BUILDER_FORBIDDEN_NAMES = ("on_transform_tool_result", "ActivityState", "_transform", "_deliver",
                           "proves_ran", "reset_state", "_Prefetch", "_run_prefetch",
                           "_ct_unusable", "CT_UNUSABLE_PAUSE", "STEP_IDS_MAX", "SESSIONS_MAX",
                           "_STATE")
BUILDER_FORBIDDEN_IMPORTS = ("ct_wisdom_live", "ct_wisdom_verbose", "ct_wisdom_activity_delivery")
REGIONED = {
    "ct_doctor.py": ("module-docstring", "harness-config", "registration-check"),
}

BEGIN = re.compile(r"^# >>> harness-specific: (\S+)$")
END = re.compile(r"^# <<< harness-specific: (\S+)$")


def read(path):
    return Path(path).read_bytes().decode("utf-8").replace("\r\n", "\n")


def normalize(text, allowed=()):
    """Collapse each harness-specific region to a placeholder.

    Returns (normalized_text, region_names_in_order). Raises ValueError on an
    unknown, repeated, nested or unbalanced region, because a malformed
    marker would otherwise silently swallow shared code.
    """
    out, names, current = [], [], None
    for number, line in enumerate(text.split("\n"), 1):
        begin, end = BEGIN.match(line), END.match(line)
        if begin:
            name = begin.group(1)
            if current is not None:
                raise ValueError(f"line {number}: region {name!r} nested in {current!r}")
            if name not in allowed:
                raise ValueError(
                    f"line {number}: unknown harness-specific region {name!r} "
                    f"(allowed: {', '.join(allowed) or 'none'})"
                )
            if name in names:
                raise ValueError(f"line {number}: region {name!r} appears twice")
            current = name
            names.append(name)
            out.append(f"# [harness-specific: {name}]")
        elif end:
            if end.group(1) != current:
                raise ValueError(
                    f"line {number}: end marker {end.group(1)!r} does not close "
                    f"{current!r}"
                )
            current = None
        elif current is None:
            out.append(line)
    if current is not None:
        raise ValueError(f"region {current!r} is never closed")
    return "\n".join(out), names


def drift_report(reference, copy, ref_label, copy_label):
    return "".join(
        difflib.unified_diff(
            reference.splitlines(keepends=True),
            copy.splitlines(keepends=True),
            ref_label,
            copy_label,
            n=2,
        )
    )


def builder_defined_names(source):
    """Every name the builder binds anywhere in the module, at any depth.

    Catches: function and class definitions (sync or async) at any nesting
    depth; every Name target of an assignment, annotated assignment or
    augmented assignment, including names inside tuple/list unpacking and
    assignments nested in `if`/`try` blocks or functions; and import
    bindings (`import x as NAME`, `from x import y as NAME`, `from x import
    NAME`). It over-approximates on purpose: a forbidden Hermes delivery
    name appearing anywhere in the builder is a failure.
    """
    names = set()

    def targets(node):
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, (ast.Tuple, ast.List)):
            for elt in node.elts:
                targets(elt)
        elif isinstance(node, ast.Starred):
            targets(node.value)

    for node in ast.walk(ast.parse(source)):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                targets(t)
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
            targets(node.target)
        elif isinstance(node, ast.Import):
            for a in node.names:
                names.add(a.asname or a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for a in node.names:
                names.add(a.asname or a.name)
    return names


class SharedScriptParityTests(unittest.TestCase):
    def test_identical_scripts_are_byte_identical(self):
        for copy_dir in COPIES:
            for name in IDENTICAL:
                with self.subTest(copy=copy_dir.parent.name, script=name):
                    ref, copy = read(REFERENCE / name), read(copy_dir / name)
                    # normalize() with no allowed regions also rejects a
                    # marker smuggled into a must-be-identical file.
                    normalize(ref)
                    normalize(copy)
                    if ref != copy:
                        self.fail(
                            f"{name} drifted from the Hermes copy; shared scripts "
                            f"must stay byte-identical:\n"
                            + drift_report(ref, copy, f"hermes/{name}",
                                           f"{copy_dir.parent.name}/{name}")
                        )

    def test_regioned_scripts_match_outside_harness_regions(self):
        for copy_dir in COPIES:
            for name, allowed in REGIONED.items():
                with self.subTest(copy=copy_dir.parent.name, script=name):
                    ref, ref_regions = normalize(read(REFERENCE / name), allowed)
                    copy, copy_regions = normalize(read(copy_dir / name), allowed)
                    self.assertEqual(
                        ref_regions, list(allowed),
                        f"hermes/{name} must carry exactly the regions {allowed}",
                    )
                    self.assertEqual(
                        copy_regions, list(allowed),
                        f"{copy_dir.parent.name}/{name} must carry exactly the "
                        f"regions {allowed}",
                    )
                    if ref != copy:
                        self.fail(
                            f"{name} drifted from the Hermes copy outside the "
                            f"harness-specific regions:\n"
                            + drift_report(ref, copy, f"hermes/{name}",
                                           f"{copy_dir.parent.name}/{name}")
                        )


class HookSharedParityTests(unittest.TestCase):
    def test_hook_modules_are_byte_identical(self):
        for name, dirs in HOOK_SHARED.items():
            ref_dir = dirs[0]
            ref = read(ref_dir / name)
            normalize(ref)
            for other in dirs[1:]:
                with self.subTest(script=name, copy=other.parent.name):
                    copy = read(other / name)
                    if ref != copy:
                        self.fail(
                            f"{name} drifted between {ref_dir.parent.name} and "
                            f"{other.parent.name}:\n"
                            + drift_report(ref, copy, f"{ref_dir.parent.name}/{name}",
                                           f"{other.parent.name}/{name}")
                        )


class HermesOnlyBoundaryTests(unittest.TestCase):
    def test_hermes_only_scripts_stay_in_hermes(self):
        for name in HERMES_ONLY:
            with self.subTest(script=name):
                self.assertTrue((REFERENCE / name).is_file(), f"hermes/{name} missing")
                for copy_dir in COPIES:
                    self.assertFalse((copy_dir / name).exists(),
                                     f"{copy_dir.parent.name} must not carry Hermes-only {name}")

    def test_builder_has_no_hermes_delivery(self):
        source = read(REFERENCE / BUILDER)
        tree = ast.parse(source)
        defined = builder_defined_names(source)
        imported = set()
        for n in ast.walk(tree):
            if isinstance(n, ast.Import):
                imported.update(a.name.split(".")[0] for a in n.names)
            elif isinstance(n, ast.ImportFrom) and n.module:
                imported.add(n.module.split(".")[0])
        for name in BUILDER_FORBIDDEN_NAMES:
            self.assertNotIn(name, defined, f"{BUILDER} must not define {name} (Hermes delivery)")
        for name in BUILDER_FORBIDDEN_IMPORTS:
            self.assertNotIn(name, imported, f"{BUILDER} must not import {name} (Hermes delivery)")


class BuilderDefinedNamesTests(unittest.TestCase):
    def test_collects_async_defs_and_top_level_assignments(self):
        names = builder_defined_names("async def proves_ran(): pass\n_transform = 1\n")
        self.assertIn("proves_ran", names)
        self.assertIn("_transform", names)

    def test_collects_nested_unpacked_and_imported_names(self):
        for source in (
            "try:\n    def proves_ran(): pass\nexcept ImportError:\n    pass\n",
            "proves_ran, _x = 1, 2\n",
            "from m import y as proves_ran\n",
            "import m as proves_ran\n",
            "from m import proves_ran\n",
            "if 1:\n    [a, (proves_ran, b)] = 1, (2, 3)\n",
            "class A:\n    async def proves_ran(self): pass\n",
        ):
            with self.subTest(source=source):
                self.assertIn("proves_ran", builder_defined_names(source))


class NormalizerGuardTests(unittest.TestCase):
    """Anti-no-op guards: a normalizer that erased too much would make the
    parity tests above vacuous."""

    ALLOWED = ("a",)
    SAMPLE = (
        "shared 1\n"
        "# >>> harness-specific: a\n"
        "harness only\n"
        "# <<< harness-specific: a\n"
        "shared 2\n"
    )

    def test_region_body_is_collapsed(self):
        text, names = normalize(self.SAMPLE, self.ALLOWED)
        self.assertEqual(names, ["a"])
        self.assertNotIn("harness only", text)
        self.assertIn("# [harness-specific: a]", text)

    def test_differing_region_bodies_normalize_equal(self):
        other = self.SAMPLE.replace("harness only", "something else entirely")
        self.assertEqual(normalize(self.SAMPLE, self.ALLOWED),
                         normalize(other, self.ALLOWED))

    def test_stray_shared_line_is_not_equalized(self):
        drifted = self.SAMPLE.replace("shared 2", "shared 2 (edited)")
        self.assertNotEqual(normalize(self.SAMPLE, self.ALLOWED)[0],
                            normalize(drifted, self.ALLOWED)[0])

    def test_unknown_region_raises(self):
        with self.assertRaises(ValueError):
            normalize(self.SAMPLE.replace(": a", ": b"), self.ALLOWED)

    def test_unclosed_region_raises(self):
        with self.assertRaises(ValueError):
            normalize("# >>> harness-specific: a\nx\n", self.ALLOWED)

    def test_mismatched_end_raises(self):
        with self.assertRaises(ValueError):
            normalize("# >>> harness-specific: a\n# <<< harness-specific: b\n",
                      ("a", "b"))

    def test_nested_region_raises(self):
        with self.assertRaises(ValueError):
            normalize(
                "# >>> harness-specific: a\n# >>> harness-specific: b\n",
                ("a", "b"),
            )

    def test_repeated_region_raises(self):
        with self.assertRaises(ValueError):
            normalize(self.SAMPLE + self.SAMPLE, self.ALLOWED)

    def test_markers_in_identical_files_are_rejected(self):
        with self.assertRaises(ValueError):
            normalize(self.SAMPLE)


if __name__ == "__main__":
    unittest.main()
