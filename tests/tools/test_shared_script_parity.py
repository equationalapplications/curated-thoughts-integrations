"""Shared-script parity gate: Hermes vs Claude Code (issue #33).

`integrations/hermes/scripts/` and `integrations/claude-code/scripts/` carry
copies of the same stdlib scripts. Each integration ships standalone (no
cross-integration imports), so the code is duplicated, and duplicated code
drifts. Drift here caused the #14/#28/#29 bug class to come back in the
Claude Code doctor. This gate is what makes the copies' "keep identical"
claim enforceable.

Contract (spec 2026-10-16-shared-env-doctor-parity-design.md, D3/D4):

  * ct_env.py, ct_status.py, ct_preflight.py are byte-identical (line
    endings normalized: Windows checkouts may be CRLF on disk).
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

import difflib
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
REFERENCE = REPO / "integrations" / "hermes" / "scripts"
COPIES = (REPO / "integrations" / "claude-code" / "scripts",)

IDENTICAL = ("ct_env.py", "ct_status.py", "ct_preflight.py")
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
