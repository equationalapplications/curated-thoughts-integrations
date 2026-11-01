"""Warn when an integration's manifest version has no release tag.

Releases are tags named <id>-v<version>. The rule: warn iff the exact tag
<id>-v<version> does not exist for the version in main's integration.yaml. A
bump merge that lands without its tag leaves main "unreleased". Only
implemented integrations with a SemVer version are checked. Warning-only: it
always exits 0 and never fails CI.
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

import ct_ci_manifest  # noqa: E402


def list_tags():
    """All tag names in the repo."""
    return set(subprocess.run(
        ["git", "tag", "--list"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.split())


def check(manifests, tags):
    """Return (annotation lines, summary lines) for manifests lacking a tag."""
    lines = []
    for data in manifests:
        if not isinstance(data, dict) or data.get("status") != "implemented":
            continue
        integration_id = data.get("id")
        version = str(data.get("version"))
        if not ct_ci_manifest.SEMVER_RE.match(version):
            lines.append((f"WARN: {integration_id} version {version} is not SemVer", None))
            continue
        tag = f"{integration_id}-v{version}"
        if tag not in tags:
            msg = f"{integration_id} main {version} unreleased (no tag {tag})"
            lines.append((f"::warning title=tag drift::{msg}", msg))
    return lines


def main(tags=None):
    if tags is None:
        try:
            tags = list_tags()
        except (subprocess.CalledProcessError, OSError) as exc:
            print(f"WARN: could not list tags ({exc})")
            return 0
    manifests = [
        ct_ci_manifest.load_manifest(path)
        for path in sorted((ROOT / "integrations").glob("*/integration.yaml"))
    ]
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    for line, summary in check(manifests, tags):
        print(line)
        if summary and summary_path:
            with open(summary_path, "a", encoding="utf-8") as handle:
                handle.write(f"- {summary}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
