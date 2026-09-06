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
