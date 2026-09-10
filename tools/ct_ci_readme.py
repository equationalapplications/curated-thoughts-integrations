"""Keeping README.md's integrations table in step with the manifests.

The table is the user-facing version index, and it used to be hand-edited —
which meant it drifted (the README said hermes 0.2.1 while integration.yaml
said 0.2.2). `rewrite` regenerates the Status and Version cells of every row
from the manifests; `check` reports the same drift without writing, so CI can
fail a version-bump PR that forgets the README row.

Rows are keyed by the integration id parsed out of the Directory cell, so a
row only ever changes when *its* manifest changes — regenerating after a
release can't clobber a neighbouring row that has moved on since the tag.
"""
from __future__ import annotations

import re
from pathlib import Path

from ct_ci_manifest import discover_manifests

README_NAME = "README.md"
RELEASES_URL = (
    "https://github.com/equationalapplications/curated-thoughts-integrations/releases"
)

# The Directory cell is the one stable handle on a row: it always mentions
# integrations/<id>/, whatever the Harness cell calls the project.
_DIR_CELL_RE = re.compile(r"integrations/([a-z0-9][a-z0-9-]*)", re.IGNORECASE)


def _manifest_state(repo_root):
    """{id: (version, status)} for every manifest under integrations/."""
    return {
        ident: (str(data["version"]), str(data.get("status", "planned")))
        for ident, _directory, data in discover_manifests(repo_root)
    }


def _row_cells(line):
    """Split a 4-cell table row; anything else (or not a row) is None."""
    stripped = line.strip()
    if not (stripped.startswith("|") and stripped.endswith("|")):
        return None
    cells = [cell.strip() for cell in stripped[1:-1].split("|")]
    return cells if len(cells) == 4 else None


def _process(repo_root, write):
    """One pass over README.md. Returns (changed, problems)."""
    root = Path(repo_root)
    readme = root / README_NAME
    text = readme.read_text(encoding="utf-8")
    state = _manifest_state(root)
    seen = set()
    problems = []
    out = []
    for line in text.splitlines():
        cells = _row_cells(line)
        match = cells and _DIR_CELL_RE.search(cells[1])
        if not match:
            out.append(line)
            continue
        ident = match.group(1).lower()
        if ident not in state:
            problems.append(f"README row references unknown integration '{ident}'")
            out.append(line)
            continue
        seen.add(ident)
        version, status = state[ident]
        version_cell = (
            f"[{version}]({RELEASES_URL}?q={ident})"
            if status == "implemented"
            else "—"
        )
        if cells[2] != status or cells[3] != version_cell:
            problems.append(
                f"{ident}: README table shows status={cells[2]!r} "
                f"version={cells[3]!r}; integration.yaml says "
                f"status={status!r} version={version}"
            )
            cells = [cells[0], cells[1], status, version_cell]
            line = "| " + " | ".join(cells) + " |"
        out.append(line)
    for ident in sorted(set(state) - seen):
        problems.append(f"README has no row for {ident} ({state[ident][1]})")
    new_text = "\n".join(out) + ("\n" if text.endswith("\n") else "")
    changed = new_text != text
    if write and changed:
        readme.write_text(new_text, encoding="utf-8")
    return changed, problems


def rewrite(repo_root):
    """Regenerate the table in place. True if the README changed."""
    changed, _problems = _process(repo_root, write=True)
    return changed


def check(repo_root):
    """Report drift without writing. Empty list means the table is current."""
    _changed, problems = _process(repo_root, write=False)
    return problems
