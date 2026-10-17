#!/usr/bin/env python3
"""ct_wisdom_da_activity.py — the Docker Agent activity map.

Spec: docs/superpowers/specs/2026-10-16-docker-agent-integration-design.md, D7.

Docker Agent v1.150.0 names its tools differently from Hermes. This module
only translates a Docker Agent call into the Hermes call with the same
meaning and hands it to the vendored, byte-identical
scripts/ct_wisdom_activity.py, so every target rule (the privacy amendment
R1-R4, the program-plus-subcommand rule, the credential shapes, the
self-trigger guard) is the Hermes rule, run against the shared vectors in
tests/fixtures/activity_targets.json:

  read_file{path}                    -> read_file{path}
  write_file{path, content}          -> write_file{path}        (never content)
  edit_file{path, edits}             -> patch{path}             (never edits)
  search_files_content{query, path}  -> search_files{pattern, path}
  shell{cmd | command}               -> terminal{command}

Every other tool has no activity. Built from args only; deterministic; no
scoring (INTENT rule 8). Stdlib only; never raises.
"""

from __future__ import annotations

import re

import ct_wisdom_activity as _hermes

Activity = _hermes.Activity
query_for = _hermes.query_for

# Docker Agent tool -> (Hermes tool, {hermes arg: docker agent arg(s)}).
TOOL_MAP = {
    "read_file": ("read_file", {"path": ("path",)}),
    "write_file": ("write_file", {"path": ("path",)}),
    "edit_file": ("patch", {"path": ("path",)}),
    "search_files_content": ("search_files", {"pattern": ("query",), "path": ("path",)}),
    "shell": ("terminal", {"command": ("cmd", "command")}),
}


def translate(tool_name, args):
    """(hermes_tool, hermes_args) for a Docker Agent call, or None."""
    if not isinstance(tool_name, str) or not isinstance(args, dict):
        return None
    mapped = TOOL_MAP.get(tool_name)
    if mapped is None:
        return None
    hermes_tool, fields = mapped
    out = {}
    for hermes_arg, sources in fields.items():
        for source in sources:
            value = args.get(source)
            if isinstance(value, str) and value.strip():
                out[hermes_arg] = value
                break
    return hermes_tool, out


def activity_for(tool_name, args, cwd, env):
    """Activity for one Docker Agent tool call, or None. `cwd` is the hook
    payload's cwd ("" or None: no working directory); `env` the hook's
    environment view (user names, HOME for `~`)."""
    try:
        call = translate(tool_name, args)
        if call is None:
            return None
        return _hermes.activity_for(call[0], call[1], cwd=cwd if isinstance(cwd, str) else "",
                                    env=env)
    except Exception:
        return None


_CT_NAME_RE = re.compile(r"(^|_)curated_[a-z_]+$")


def is_ct_tool(tool_name, category=None):
    """Curated Thoughts' own tools: never an activity trigger (decision 3).

    The vendored Hermes rule, plus Docker Agent's `<toolset>_<tool>` naming
    for an MCP toolset that has a `name:` (investigation §5)."""
    if not isinstance(tool_name, str):
        return False
    if _hermes.is_ct_tool(tool_name):
        return True
    return category == "mcp" and _CT_NAME_RE.search(tool_name.lower()) is not None


def is_recall_tool(tool_name, category=None):
    return (is_ct_tool(tool_name, category) and isinstance(tool_name, str)
            and tool_name.lower().endswith("curated_recall_context"))
