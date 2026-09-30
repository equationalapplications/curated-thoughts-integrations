#!/usr/bin/env python3
"""SessionStart hook for the Curated Thoughts Claude Code plugin.

Claude Code runs this from `hooks/hooks.json` on the `startup|resume|clear|
compact` matchers, via `python3 ... || python ...` so it works on machines
where only one of the two names exists (Windows ships `python`, most POSIX
installs ship `python3`).

Hook I/O protocol: a JSON payload arrives on stdin, a JSON directive may be
written to stdout, exit 0 means success. The directive shape is Claude
Code's, not Hermes's -- Hermes reads a bare `{"context": ...}`, Claude Code
reads:

    {"hookSpecificOutput": {"hookEventName": "SessionStart",
                            "additionalContext": "..."}}

Adapted from integrations/hermes/hooks/session-start.py; the structure
(stdin drain, single-line emit, fail-open, exit 0) is deliberately identical
and only the plugin-root variable and the output envelope differ.

Fast (<200ms target), read-only, fail-open: any unexpected error exits 0
silently rather than delaying or blocking session start.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Resolve the scripts directory from this file's own location, and never read
# CLAUDE_PLUGIN_ROOT. hooks.json already expands ${CLAUDE_PLUGIN_ROOT} into the
# path this script is invoked by, so __file__ carries the same information; it
# is also correct when the script is run directly, and it keeps Hermes's
# repo-wide guard against reading that variable green without editing anything
# under integrations/hermes/ (spec s11 Q6, resolved by design).
_scripts = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(_scripts))


def _emit(payload):
    """Single-line JSON to stdout, flushed; never raises."""
    try:
        sys.stdout.write(json.dumps(payload, sort_keys=True) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def main():
    # Drain stdin: Claude Code sends the hook payload there. We do not need
    # any of its fields, but leaving it unread can leave the writer blocked.
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
        _emit(
            {
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": section,
                }
            }
        )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
