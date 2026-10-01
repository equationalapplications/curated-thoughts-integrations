"""Parity and content tests for the three shipped SKILL.md files.

Ported from `integrations/deepseek/tests/test_skills_content.ts`. The contract
is not "the right words appear somewhere" -- it is that each skill **body is
byte-identical to the Hermes copy** once a closed, named list of
harness-specific regions is normalized away on both sides. That is what D2's
"bodies verbatim" means in practice, and it is the only automated gate that
sees the skills at all (`tools/ct_ci.py` has no skills-aware check).

Reading `integrations/hermes/` is deliberate and mirrors what the deepseek
test does; nothing under it is ever written.

Three normalization rules apply here, where deepseek needed three of its own:

  1. Doctor-check list item 7 ("Harness registration") -- each harness
     describes its own registration check in its own terms.
  2. The whole `## Registration in <Harness>` section -- likewise.
  3. The cross-reference to the ops skill. Hermes names it
     `curated-thoughts-ops`; under D2's directory names a Claude Code user
     types `/curated-thoughts:ops`, so shipping Hermes's spelling would ship a
     name nobody can invoke. This is a deliberate divergence from deepseek,
     which kept the Hermes spelling verbatim.

Note that deepseek's rule (1), the doctor-invocation sentence, has no analogue
here: deepseek ships `node lib/scripts/ct_doctor.js`, but this integration
ships `scripts/ct_doctor.py` exactly as Hermes does, so that line stays
verbatim and needs no rule.

Anything NOT covered by the three rules must remain byte-identical.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

INTEGRATION_ROOT = Path(__file__).resolve().parent.parent
SKILLS_ROOT = INTEGRATION_ROOT / "skills"
HERMES_SKILLS_ROOT = INTEGRATION_ROOT.parent / "hermes" / "skills"

# (shipped directory name, Hermes directory name). D2: the plugin is already
# called `curated-thoughts`, so Hermes's directory names would namespace to
# `/curated-thoughts:curated-thoughts-usage`.
SKILLS = (
    ("usage", "curated-thoughts-usage"),
    ("ops", "curated-thoughts-ops"),
    ("sidecar", "curated-thoughts-sidecar"),
)

FRONTMATTER_RE = re.compile(r"\A---\n(?P<fm>.*?)\n---\n", re.DOTALL)


def read_skill(path: Path) -> str:
    """Read a SKILL.md with newlines normalized.

    The repo is checked out with `core.autocrlf=true` on Windows, so the same
    file is LF in git and CRLF on disk. Byte-parity is a claim about content,
    not about the checkout's line-ending policy.
    """
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def split_frontmatter(text: str):
    match = FRONTMATTER_RE.match(text)
    if match is None:
        raise AssertionError("SKILL.md has no YAML frontmatter")
    return match.group("fm"), text[match.end():]


def normalize_harness_specific(body: str) -> str:
    # (1) doctor-check list item 7 (multi-line; ends right before item 8)
    body = re.sub(
        r"7\. \*\*Harness registration\*\* —.*?(?=\n8\. )",
        "7. **Harness registration** (harness-specific description).",
        body,
        flags=re.DOTALL,
    )
    # (2) "Registration in <Harness>" section: heading through the next
    # heading (exclusive)
    body = re.sub(
        r"^## Registration in .*?(?=^## )",
        "## Registration (harness-specific).\n\n",
        body,
        flags=re.DOTALL | re.MULTILINE,
    )
    # (3) the ops-skill cross-reference, named in each harness's own scheme
    body = re.sub(
        r"the (?:curated-thoughts-ops|`/curated-thoughts:ops`) skill",
        "the ops skill",
        body,
    )
    return body


class SkillFilesShipTests(unittest.TestCase):
    def test_each_skill_file_exists(self):
        for shipped, _ in SKILLS:
            path = SKILLS_ROOT / shipped / "SKILL.md"
            self.assertTrue(path.is_file(), "missing %s" % path)

    def test_frontmatter_has_a_description(self):
        for shipped, _ in SKILLS:
            frontmatter, _body = split_frontmatter(
                read_skill(SKILLS_ROOT / shipped / "SKILL.md")
            )
            self.assertRegex(
                frontmatter,
                r"(?m)^description: \S",
                "%s frontmatter has no non-empty description" % shipped,
            )

    def test_frontmatter_drops_the_name_key(self):
        # D2: Claude Code namespaces plugin skills as `/<plugin>:<skill>` and
        # falls back to the directory name when `name` is absent. Keeping
        # Hermes's `name` would give `/curated-thoughts:curated-thoughts-ops`.
        for shipped, _ in SKILLS:
            frontmatter, _body = split_frontmatter(
                read_skill(SKILLS_ROOT / shipped / "SKILL.md")
            )
            self.assertNotRegex(
                frontmatter, r"(?m)^name:", "%s frontmatter still sets name" % shipped
            )


class SkillBodyParityTests(unittest.TestCase):
    """The real contract: bodies verbatim, modulo the three named regions."""

    def test_bodies_match_hermes_after_normalization(self):
        for shipped, hermes in SKILLS:
            _fm, ours = split_frontmatter(
                read_skill(SKILLS_ROOT / shipped / "SKILL.md")
            )
            _fm, theirs = split_frontmatter(
                read_skill(HERMES_SKILLS_ROOT / hermes / "SKILL.md")
            )
            self.assertEqual(
                normalize_harness_specific(ours),
                normalize_harness_specific(theirs),
                "%s/SKILL.md body diverges from Hermes outside the three "
                "normalized regions" % shipped,
            )

    def test_normalization_does_not_equalize_arbitrary_content(self):
        # Anti-no-op guard: a normalizer that erased everything would make the
        # parity test above vacuous.
        _fm, body = split_frontmatter(read_skill(SKILLS_ROOT / "usage" / "SKILL.md"))
        self.assertEqual(
            normalize_harness_specific(body), normalize_harness_specific(body)
        )
        self.assertNotEqual(
            normalize_harness_specific(body + "\nstray\n"),
            normalize_harness_specific(body),
        )

    def test_sidecar_and_usage_need_no_normalization_at_all(self):
        # These two carry no harness-specific content: they must be identical
        # to Hermes on the nose, apart from rule (3). Asserting it separately
        # keeps the normalizer from hiding a real drift in them.
        for shipped, hermes in (("usage", "curated-thoughts-usage"),
                                ("sidecar", "curated-thoughts-sidecar")):
            _fm, ours = split_frontmatter(
                read_skill(SKILLS_ROOT / shipped / "SKILL.md")
            )
            _fm, theirs = split_frontmatter(
                read_skill(HERMES_SKILLS_ROOT / hermes / "SKILL.md")
            )
            ours = ours.replace("`/curated-thoughts:ops`", "curated-thoughts-ops")
            self.assertEqual(ours, theirs)


class SkillContentRuleTests(unittest.TestCase):
    """The plan's content spec, read against the set rather than each file.

    The three rules are distributed across the skill set, not repeated in
    every file, so a per-file assertion would fail on a correct port. Each
    rule is asserted against the file that actually carries it.
    """

    RULES = (
        ("sidecar", "One sidecar per brain"),
        ("usage", "**Never touch the vault out-of-band.**"),
        ("ops", "**Fail open.**"),
    )

    def test_each_rule_appears_in_the_skill_that_carries_it(self):
        for shipped, rule in self.RULES:
            body = read_skill(SKILLS_ROOT / shipped / "SKILL.md")
            self.assertIn(rule, body, "%s/SKILL.md lost the rule %r" % (shipped, rule))

    def test_no_hermes_registration_strings_remain(self):
        for shipped, _ in SKILLS:
            body = read_skill(SKILLS_ROOT / shipped / "SKILL.md")
            self.assertNotIn("~/.hermes", body)
            # The brain's own `config.json` is a different file and must stay.
            self.assertNotIn("config.yaml", body)

    def test_no_machine_specific_paths_leak_in(self):
        # The plan says "no absolute paths", but the verbatim Hermes bodies
        # legitimately contain `/usr/bin` three times as illustrative prose
        # about where the sidecar installs per OS. What that assertion was
        # actually protecting against is a developer's own home directory
        # leaking into a shipped skill, so it is scoped to that.
        leaks = (
            re.compile(r"[A-Za-z]:\\\\?Users\\\\?"),
            re.compile(r"/home/(?!<)[A-Za-z0-9_.-]+"),
            re.compile(r"/Users/(?!<)[A-Za-z0-9_.-]+"),
            re.compile(r"curated-thoughts-integrations/"),
        )
        for shipped, _ in SKILLS:
            body = read_skill(SKILLS_ROOT / shipped / "SKILL.md")
            for pattern in leaks:
                self.assertIsNone(
                    pattern.search(body),
                    "%s/SKILL.md leaks a machine-specific path (%s)"
                    % (shipped, pattern.pattern),
                )


if __name__ == "__main__":
    unittest.main()
