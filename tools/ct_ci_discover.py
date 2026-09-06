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


def _entries(name, directory, data, repo_root):
    """One flat matrix entry per (id, os, interpreter) triple (spec §4.1).

    The workflow consumes these with a single `matrix: entry:` axis. A
    cross-product over a nested `entry.os` list would instead run every
    entry on entry[0]'s interpreters, so the expansion happens here, in
    code a unit test can see.
    """
    matrix = data.get("matrix") or {}
    language = data.get("language")
    key = "python" if language == "python" else "node"
    interpreters = matrix.get(key) or []
    oses = matrix.get("os") or []
    if not oses or not interpreters:
        raise ValueError(
            f"integrations/{name}/integration.yaml: implemented integration "
            f"declares an empty matrix; it would silently vanish from CI"
        )
    entries = []
    for os_name in oses:
        for interpreter in interpreters:
            entries.append(
                {
                    "id": name,
                    "version": str(data["version"]),
                    "dir": directory.relative_to(repo_root).as_posix(),
                    "language": language,
                    "os": os_name,
                    key: interpreter,
                    "checks": data.get("checks") or {},
                }
            )
    return entries


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
    return [
        entry
        for name, directory, data in chosen
        for entry in _entries(name, directory, data, repo_root)
    ]
