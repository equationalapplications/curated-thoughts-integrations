#!/usr/bin/env python3
"""ct_wisdom_cc_activity.py — the Claude Code activity map.

Spec: docs/superpowers/specs/2026-10-17-claude-code-autonomous-work-wisdom-design.md, D1, D4.

Claude Code 2.1.301 names its tools differently from Hermes. This module
only translates a Claude Code call into the Hermes call with the same
meaning and hands it to the vendored, byte-identical
scripts/ct_wisdom_activity.py, so every target rule (privacy amendments
1-7: project root, user names, the command and search allowlists, the
self-trigger guard) is the Hermes rule, run against the shared vectors in
tests/fixtures/activity_targets.json:

  Read{file_path}                   -> read_file{path}
  Write{file_path, content}         -> write_file{path}      (never content)
  Edit / MultiEdit{file_path, ...}  -> patch{path}           (never the strings)
  NotebookEdit{notebook_path, ...}  -> patch{path}
  Grep{pattern, path}               -> search_files{pattern, path}
  Glob{pattern, path}               -> search_files{pattern, path}
  Bash{command}                     -> terminal{command}

Every other tool has no activity. Built from args only; deterministic; no
scoring (INTENT rule 8). Stdlib only; never raises.
"""

from __future__ import annotations

import ct_wisdom_activity as _hermes

Activity = _hermes.Activity
query_for = _hermes.query_for
render_candidates = _hermes.render_candidates
render_activity_block = _hermes.render_activity_block

RECALL_TOOL_SUFFIX = "__curated_recall_context"

# Claude Code tool -> (Hermes tool, {hermes arg: claude code arg}).
TOOL_MAP = {
    "Read": ("read_file", {"path": "file_path"}),
    "Write": ("write_file", {"path": "file_path"}),
    "Edit": ("patch", {"path": "file_path"}),
    "MultiEdit": ("patch", {"path": "file_path"}),
    "NotebookEdit": ("patch", {"path": "notebook_path"}),
    "Grep": ("search_files", {"pattern": "pattern", "path": "path"}),
    "Glob": ("search_files", {"pattern": "pattern", "path": "path"}),
    "Bash": ("terminal", {"command": "command"}),
}
# The tools whose execution the PostToolUse / PostToolUseFailure hooks record
# (hooks.json matcher, exact names; spec D3).
ACTIVITY_TOOLS = ("Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Grep", "Glob")


def translate(tool_name, args):
    """(hermes_tool, hermes_args) for a Claude Code call, or None."""
    if not isinstance(tool_name, str) or not isinstance(args, dict):
        return None
    mapped = TOOL_MAP.get(tool_name)
    if mapped is None:
        return None
    hermes_tool, fields = mapped
    out = {}
    for hermes_arg, source in fields.items():
        value = args.get(source)
        if isinstance(value, str) and value.strip():
            out[hermes_arg] = value
    return hermes_tool, out


def activity_for(tool_name, args, cwd, env):
    """Activity for one Claude Code tool call, or None. `cwd` is the hook
    payload's cwd (the session working directory; "" or None: none); `env`
    the hook's environment view (user names, HOME for `~`)."""
    try:
        call = translate(tool_name, args)
        if call is None:
            return None
        return _hermes.activity_for(call[0], call[1], cwd=cwd if isinstance(cwd, str) else "",
                                    env=env)
    except Exception:
        return None


def is_ct_tool(tool_name):
    """Curated Thoughts' own tools: never an activity trigger (decision 6).
    Claude Code names MCP tools `mcp__<server>__<tool>`; the Hermes rule
    covers that (a `curated-thoughts` server, or a `curated_*` tool)."""
    return isinstance(tool_name, str) and _hermes.is_ct_tool(tool_name)


def is_recall_tool(tool_name):
    return (isinstance(tool_name, str) and tool_name.startswith("mcp__")
            and tool_name.endswith(RECALL_TOOL_SUFFIX))
