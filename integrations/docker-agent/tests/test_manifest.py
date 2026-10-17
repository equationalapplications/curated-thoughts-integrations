"""Manifest tests: integration.yaml and plugin.json agree; the adapter and
the drop-in register the same events. Stdlib only (regex, not PyYAML)."""

from __future__ import annotations

import json
import re
import unittest

from _support import INTEGRATION

import ct_doctor
import ct_wisdom_da


def scalar(text, key):
    m = re.search(r"^%s:[ \t]*(.+?)[ \t]*$" % re.escape(key), text, re.M)
    return m.group(1) if m else None


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.yaml = (INTEGRATION / "integration.yaml").read_text(encoding="utf-8")
        self.plugin = json.loads((INTEGRATION / "plugin.json").read_text(encoding="utf-8"))

    def test_versions_agree(self):
        self.assertEqual(scalar(self.yaml, "version"), self.plugin["version"])
        self.assertEqual(scalar(self.yaml, "version_mirror"), "plugin.json#version")
        self.assertEqual(scalar(self.yaml, "id"), "docker-agent")
        self.assertEqual(scalar(self.yaml, "language"), "python")
        self.assertEqual(scalar(self.yaml, "status"), "implemented")

    def test_changelog_has_the_release(self):
        text = (INTEGRATION / "CHANGELOG.md").read_text(encoding="utf-8")
        self.assertRegex(text, r"(?m)^## %s — \d{4}-\d{2}-\d{2}$" % re.escape(self.plugin["version"]))

    def test_registered_events_match_the_adapter(self):
        installer = (INTEGRATION / "scripts" / "install.sh").read_text(encoding="utf-8")
        events = set(re.findall(r"(?m)^([a-z_]+):$", installer))
        self.assertEqual(events, set(ct_wisdom_da._HANDLERS))
        self.assertEqual(set(ct_doctor.DROPIN_EVENTS), set(ct_wisdom_da._HANDLERS))
        self.assertIn(ct_doctor.DROPIN_MARKER, installer)


if __name__ == "__main__":
    unittest.main()
