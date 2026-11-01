"""Warn when an integration's manifest version is ahead of its newest tag.

Releases are annotated tags named <id>-v<semver>. A bump merge that lands
without its tag leaves main "unreleased"; this prints one WARN line per such
integration. Warning-only: it always exits 0 and never fails CI.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")


def version_key(text):
    """Sortable key for a semver string, or None if it is not one.

    A pre-release (0.2.1-rc.1) sorts below its release (0.2.1); numeric
    pre-release identifiers compare as numbers, below alphanumeric ones.
    """
    m = SEMVER.match(text)
    if not m:
        return None
    core = tuple(int(p) for p in m.groups()[:3])
    if m.group(4) is None:
        return core, (1,)
    ids = tuple(
        (0, int(p), "") if p.isdigit() else (1, 0, p) for p in m.group(4).split(".")
    )
    return core, (0, ids)


def manifest_field(text, name):
    m = re.search(rf"^{name}:\s*['\"]?([^\s'\"#]+)", text, re.MULTILINE)
    return m.group(1) if m else None


def newest_tag_version(integration_id):
    out = subprocess.run(
        ["git", "tag", "--list", f"{integration_id}-v*"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.split()
    prefix = f"{integration_id}-v"
    best = None
    for tag in out:
        ver = tag[len(prefix):]
        key = version_key(ver)
        if key is not None and (best is None or key > best[0]):
            best = (key, ver)
    return best[1] if best else None


def main():
    for manifest in sorted((ROOT / "integrations").glob("*/integration.yaml")):
        text = manifest.read_text(encoding="utf-8")
        integration_id = manifest_field(text, "id")
        version = manifest_field(text, "version")
        if not integration_id or not version:
            print(f"WARN: {manifest.parent.name} integration.yaml lacks id/version")
            continue
        try:
            tagged = newest_tag_version(integration_id)
        except (subprocess.CalledProcessError, OSError) as exc:
            print(f"WARN: {integration_id} could not list tags ({exc})")
            continue
        if tagged is None:
            print(f"WARN: {integration_id} main {version} unreleased (no {integration_id}-v* tag)")
        elif version_key(version) != version_key(tagged):
            print(f"WARN: {integration_id} main {version} unreleased (latest tag {integration_id}-v{tagged})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
