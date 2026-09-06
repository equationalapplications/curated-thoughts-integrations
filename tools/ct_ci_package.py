"""Build the release artifact for one integration (spec §4.2).

Tag grammar is `<id>-v<semver>`. The id may contain hyphens (claude-code), so
the split is on the FIRST '-v' that yields a full match.
"""
from __future__ import annotations

import fnmatch
import hashlib
import re
import tarfile
from pathlib import Path

import ct_ci_manifest

TAG_RE = re.compile(r"^(?P<id>[a-z][a-z0-9-]*?)-v(?P<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$")


def parse_tag(tag):
    """('hermes-v0.2.1') -> ('hermes', '0.2.1'). Raises ValueError otherwise."""
    match = TAG_RE.match(tag or "")
    if not match:
        raise ValueError(
            f"tag {tag!r} is not '<id>-v<semver>' (e.g. hermes-v0.2.1)"
        )
    return match.group("id"), match.group("version")


def is_prerelease(version):
    return "-" in version


def _manifest(repo_root, integration_id):
    for name, directory, data in ct_ci_manifest.discover_manifests(repo_root):
        if name == integration_id:
            return directory, data
    raise ValueError(
        f"no integrations/{integration_id}/integration.yaml — the tag names an "
        f"integration that does not exist"
    )


def _selected_files(directory, package):
    include = package.get("include") or ["**"]
    exclude = package.get("exclude") or []
    chosen = []
    for path in sorted(directory.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(directory).as_posix()
        if not any(fnmatch.fnmatch(rel, pattern) or pattern == "**" for pattern in include):
            continue
        if any(fnmatch.fnmatch(rel, pattern) or f"/{rel}".find(pattern.strip("*")) >= 0
               for pattern in exclude if pattern):
            continue
        chosen.append((path, rel))
    return chosen


def build(repo_root, integration_id, out_dir):
    """Write <id>-<version>.tar.gz into out_dir and return its path."""
    directory, data = _manifest(Path(repo_root), integration_id)
    version = data["version"]
    root = f"{integration_id}-{version}"
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"{root}.tar.gz"
    with tarfile.open(target, "w:gz") as archive:
        for path, rel in _selected_files(directory, data.get("package") or {}):
            archive.add(path, arcname=f"{root}/{rel}")
    return target


def write_checksums(paths, out_dir):
    """Write a SHA256SUMS file covering paths; return its path."""
    out_dir = Path(out_dir)
    sums = out_dir / "SHA256SUMS"
    lines = []
    for path in paths:
        digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        lines.append(f"{digest}  {Path(path).name}")
    sums.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return sums


def changelog_section(directory, version):
    """The '## <version>' section body, for the GitHub Release notes.

    The heading must carry this version as its exact first token, so
    '## 0.2.0 — 2026-09-06' matches '0.2.0' but '## 0.2.0-beta' does not.
    """
    path = Path(directory) / "CHANGELOG.md"
    if not path.exists():
        raise ValueError(f"{path} does not exist; a release needs release notes")
    lines = path.read_text(encoding="utf-8").splitlines()

    def section_headings():
        return [line[3:].strip() for line in lines if line.startswith("## ")]

    def no_section_error():
        heads = ", ".join(h.split()[0] for h in section_headings() if h) or "none"
        return ValueError(
            f"{path}: no '## {version}' section (found: {heads}). Add one "
            f"before tagging (spec §4.2)."
        )

    collected = None
    for line in lines:
        if line.startswith("## "):
            heading = line[3:].strip()
            if collected is not None:
                break  # the matched section ended at the next heading
            if heading.split() and heading.split()[0] == version:
                collected = []
            continue
        if collected is not None:
            collected.append(line)
    if collected is None or not "\n".join(collected).strip():
        raise no_section_error()
    return "\n".join(collected).strip()
