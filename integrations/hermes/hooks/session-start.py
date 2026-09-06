#!/usr/bin/env python3
"""Hermes shell-hook entry point for the curated-thoughts plugin.

This is the *alternative* to installing the native plugin: users who would
rather not enable a plugin can wire this script straight into their Hermes
config as a shell hook.

    # ~/.hermes/config.yaml
    hooks:
      on_session_start:
        - command: "python3 ~/.hermes/plugins/curated-thoughts/hooks/session-start.py"
          timeout: 10

Shell hooks follow Hermes' documented I/O protocol: a JSON payload arrives on
stdin, a JSON directive may be written to stdout, and exit 0 means success
(hooks are fail-open by default). Hermes prompts once per (event, command)
pair before running a shell hook; `hermes hooks list` and `hermes hooks test
on_session_start` are the way to verify it.

Note this replaced a `hooks/hooks.json` file using Claude Code's plugin format
(a `SessionStart` matcher and `${CLAUDE_PLUGIN_ROOT}`), which Hermes does not
read — Hermes names the event `on_session_start`, declares hooks in
config.yaml rather than a JSON sidecar file, and exposes the plugin directory
as `PLUGIN_ROOT`.

Fast (<200ms target), read-only, fail-open: any unexpected error exits 0
silently rather than delaying or blocking session start.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Prefer PLUGIN_ROOT (set by Hermes for plugin-owned scripts); fall back to
# this file's location so the script also works when run directly.
_root = os.environ.get("PLUGIN_ROOT")
_scripts = (Path(_root) if _root else Path(__file__).resolve().parent.parent) / "scripts"
sys.path.insert(0, str(_scripts))


def _emit(payload):
    """Single-line JSON to stdout, flushed; never raises."""
    try:
        sys.stdout.write(json.dumps(payload, sort_keys=True) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def main():
    # Drain stdin: Hermes sends the hook payload there. We do not need any of
    # its fields, but leaving it unread can leave the writer blocked.
    try:
        if not sys.stdin.isatty():
            sys.stdin.read()
    except Exception:
        pass

    try:
        import ct_status

        section = ct_status.context_section()
    except Exception:
        # Fail-open: never block or delay a session for an advisory check.
        return

    if section:
        _emit({"context": section})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
