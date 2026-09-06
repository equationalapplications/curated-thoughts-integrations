"""Automated enforcement of the CONTRIBUTING.md architecture rules.

Three independent gate families (spec §5):
    gate_versions  — version/manifest hygiene
    gate_arch      — the architecture rules (Task 6)
    gate_compat    — compat.yaml drift (Task 7)

Every message names the offending file and the rule it enforces, because a
gate the author cannot act on is a gate they will route around.
"""
from __future__ import annotations

import fnmatch
import subprocess
from pathlib import Path

import yaml

import ct_ci_manifest

# A release exists to change what a user runs. Adding a missing unit test or
# fixing a typo in the README changes nothing a user runs, and forcing a bump
# for it trains maintainers to bump reflexively — which is how version numbers
# stop meaning anything (spec §5.1). The exemption is all-or-nothing: one
# shipped-code file in the same change and the bump is required again.
EXEMPT_PATTERNS = (
    "integrations/*/README.md",
    "integrations/*/CHANGELOG.md",
    "integrations/*/docs/*",
    "integrations/*/docs/**",
    "integrations/*/tests/*",
    "integrations/*/tests/**",
    "integrations/*/**/test_*.py",
    "integrations/*/**/*.test.ts",
)


def is_exempt(rel_path):
    """True when this path may change without requiring a version bump."""
    return any(
        fnmatch.fnmatch(rel_path, pattern)
        or fnmatch.fnmatch(rel_path, pattern.replace("/**", "/*/**"))
        for pattern in EXEMPT_PATTERNS
    ) or any(
        # fnmatch's '*' spans '/', so a two-segment prefix check covers nesting.
        rel_path.startswith(prefix)
        for prefix in _dir_prefixes(rel_path)
    )


def _dir_prefixes(rel_path):
    parts = rel_path.split("/")
    if len(parts) >= 3 and parts[0] == "integrations":
        for marker in ("tests", "docs"):
            if marker in parts[2:]:
                return [rel_path]
    return []


def changed_files(repo_root, base_ref):
    """Repo-relative POSIX paths that differ from base_ref."""
    result = subprocess.run(
        ["git", "diff", "--name-only", base_ref],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=True,
    )
    return [line for line in result.stdout.splitlines() if line]


def _file_at_ref(repo_root, ref, rel_path):
    """File contents at a git ref, or None when the file did not exist."""
    result = subprocess.run(
        ["git", "show", f"{ref}:{rel_path}"],
        cwd=repo_root,
        capture_output=True,
        text=True,
    )
    return result.stdout if result.returncode == 0 else None


def read_mirror(directory, mirror):
    """Read `plugin.yaml#version`-style references. None when absent."""
    filename, _, field = mirror.partition("#")
    path = Path(directory) / filename
    if not path.exists():
        return None
    if path.suffix in (".yaml", ".yml"):
        with open(path, encoding="utf-8") as handle:
            data = yaml.safe_load(handle) or {}
    else:
        import json

        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    return data.get(field)


def _semver_key(version):
    """Sort key for SemVer. A prerelease sorts below its release."""
    core, _, pre = str(version).partition("-")
    numbers = tuple(int(part) for part in core.split("."))
    return (numbers, 0 if pre else 1, pre)


def gate_versions(repo_root, base_ref):
    """Version/manifest hygiene (spec §5.1)."""
    repo_root = Path(repo_root)
    problems = []
    changed = set(changed_files(repo_root, base_ref)) if base_ref else set()

    for name, directory, data in ct_ci_manifest.discover_manifests(repo_root):
        rel_dir = f"integrations/{name}/"
        manifest_path = directory / "integration.yaml"
        problems.extend(ct_ci_manifest.validate_manifest(data, manifest_path))

        mirror = data.get("version_mirror")
        if mirror:
            mirrored = read_mirror(directory, mirror)
            if mirrored is None:
                problems.append(
                    f"{manifest_path}: version_mirror '{mirror}' does not resolve "
                    f"(spec §5.1)"
                )
            elif str(mirrored) != str(data.get("version")):
                problems.append(
                    f"{manifest_path}: version {data.get('version')!r} does not match "
                    f"{mirror} = {mirrored!r}. The CI manifest and the native manifest "
                    f"must agree (spec §5.1)."
                )

        touched = [p for p in changed if p.startswith(rel_dir)]
        material = [p for p in touched if not is_exempt(p)]
        if not material:
            continue

        old_manifest = _file_at_ref(repo_root, base_ref, f"{rel_dir}integration.yaml")
        if old_manifest is None:
            continue  # brand-new integration: nothing to bump from
        try:
            old_version = (yaml.safe_load(old_manifest) or {}).get("version")
        except yaml.YAMLError:
            problems.append(
                f"{rel_dir}integration.yaml at {base_ref}: is not valid YAML, so the "
                f"version bump cannot be verified (spec §5.1)."
            )
            continue
        new_version = data.get("version")
        try:
            bumped = _semver_key(new_version) > _semver_key(old_version)
        except (ValueError, TypeError):
            problems.append(
                f"{manifest_path}: version {new_version!r} cannot be compared "
                f"against {old_version!r}; versions must be numeric SemVer "
                f"2.0.0 (spec §5.1)."
            )
            continue
        if not bumped:
            problems.append(
                f"{rel_dir}: {len(material)} shipped file(s) changed "
                f"(e.g. {material[0]}) but version is still {new_version}. "
                f"It must be greater than {old_version} (spec §5.1). Docs and "
                f"tests are exempt; shipped code is not."
            )
            continue

        changelog = directory / "CHANGELOG.md"
        text = changelog.read_text(encoding="utf-8") if changelog.exists() else ""
        if f"## {new_version}" not in text:
            problems.append(
                f"{changelog}: no entry for version {new_version}. Add a "
                f"'## {new_version} — YYYY-MM-DD' section; the release body is "
                f"taken from it (spec §4.2, §5.1)."
            )
    return problems
