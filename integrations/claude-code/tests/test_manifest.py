#!/usr/bin/env python3
"""Manifest tests for integrations/claude-code/.

Two manifests describe this integration and they must not drift:

  - `.claude-plugin/plugin.json` — what Claude Code itself reads;
  - `integration.yaml` — the CI contract, which points `version_mirror` at
    the JSON file's `version` key.

`tools/ct_ci.py policy` enforces the mirror repo-wide; these tests keep the
same invariant checkable from inside the integration, plus the things the
policy job cannot see (plugin name, license, a non-empty description, and
whether the real `claude` CLI accepts the plugin directory).

The YAML is read with a small regex rather than PyYAML on purpose: shipped
code and its tests are stdlib-only here, and PyYAML is a CI-tools dependency
(`tools/requirements-ci.txt`), not an integration one.

Run directly:  python3 tests/test_manifest.py
Or:            python3 -m unittest discover -s tests
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
INTEGRATION = HERE.parent
PLUGIN_JSON = INTEGRATION / ".claude-plugin" / "plugin.json"
INTEGRATION_YAML = INTEGRATION / "integration.yaml"

PLUGIN_NAME = "curated-thoughts"
# Top-level `key: value` only — enough for the flat scalars this file needs,
# and it cannot be fooled by the same key nested under `matrix:` or `checks:`.
_TOP_LEVEL_SCALAR = r"^{key}:[ \t]*(.+?)[ \t]*$"


def yaml_scalar(text: str, key: str) -> str:
    """Value of a top-level `key: value` line in *text*.

    A trailing `#` only starts a comment when whitespace precedes it, so
    `version_mirror: .claude-plugin/plugin.json#version` keeps its fragment.
    """
    match = re.search(
        _TOP_LEVEL_SCALAR.format(key=re.escape(key)), text, re.MULTILINE
    )
    if match is None:
        raise AssertionError("no top-level {0!r} key in integration.yaml".format(key))
    value = re.split(r"[ \t]+#", match.group(1), maxsplit=1)[0].strip()
    return value.strip("\"'")


class PluginManifestTest(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(PLUGIN_JSON.is_file(), "{0} is missing".format(PLUGIN_JSON))
        self.manifest = json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))

    def test_parses_as_an_object(self) -> None:
        self.assertIsInstance(self.manifest, dict)

    def test_name_is_the_plugin_namespace(self) -> None:
        # Claude Code namespaces skills as /<plugin-name>:<skill>, so this
        # string is user-visible API, not decoration.
        self.assertEqual(self.manifest.get("name"), PLUGIN_NAME)

    def test_license_is_mit(self) -> None:
        self.assertEqual(self.manifest.get("license"), "MIT")

    def test_description_is_non_empty(self) -> None:
        description = self.manifest.get("description", "")
        self.assertIsInstance(description, str)
        self.assertTrue(description.strip(), "description must not be empty")

    def test_version_mirrors_integration_yaml(self) -> None:
        yaml_text = INTEGRATION_YAML.read_text(encoding="utf-8")
        self.assertEqual(
            self.manifest.get("version"),
            yaml_scalar(yaml_text, "version"),
            "plugin.json#version and integration.yaml version have drifted",
        )

    def test_version_mirror_points_at_this_file(self) -> None:
        yaml_text = INTEGRATION_YAML.read_text(encoding="utf-8")
        mirror = yaml_scalar(yaml_text, "version_mirror")
        relative, _, key = mirror.partition("#")
        self.assertEqual(key, "version")
        self.assertEqual((INTEGRATION / relative).resolve(), PLUGIN_JSON.resolve())


@unittest.skipUnless(
    shutil.which("claude"), "the claude CLI is not on PATH (expected on CI runners)"
)
class ClaudeCliValidateTest(unittest.TestCase):
    def test_claude_plugin_validate_accepts_the_directory(self) -> None:
        completed = subprocess.run(
            [shutil.which("claude"), "plugin", "validate", str(INTEGRATION)],
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(
            completed.returncode,
            0,
            "claude plugin validate failed:\n{0}\n{1}".format(
                completed.stdout, completed.stderr
            ),
        )


if __name__ == "__main__":
    unittest.main()
