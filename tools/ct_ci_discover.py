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
