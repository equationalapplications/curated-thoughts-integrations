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

Since 0.2.0 the payload is parsed (not just drained): after the status
section comes the Intuitive Wisdom bootstrap block, whose per-`source` rules
live in hooks/ct_wisdom_cc.py (spec
docs/superpowers/specs/2026-10-16-claude-code-wisdom-parity-leg-design.md, D7).

Read-only toward the brain, fail-open: any unexpected error exits 0
silently rather than blocking session start. The status section stays
<200ms; the bootstrap adds at most one `ct` identity probe (3 s) and one
`ct recall` (5 s), inside the 15 s hooks.json timeout. Its only write is the
plugin's own ${CLAUDE_PLUGIN_DATA} store.
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


def _read_payload():
    """Drain stdin (leaving it unread can block the writer) and parse it."""
    try:
        if sys.stdin.isatty():
            return None
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else None
    except Exception:
        return None


def _bootstrap(payload):
    """The wisdom bootstrap block for this SessionStart source, or "".

    hooks/ct_wisdom_cc.py owns the per-source rules (startup seeds the
    ${CLAUDE_PLUGIN_DATA} store, resume/fork latch live delivery OFF, compact
    replays the stored block). Fail-open: any error means no block.
    """
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import ct_wisdom_cc

        return ct_wisdom_cc.session_start(payload) or ""
    except Exception:
        return ""


def main():
    payload = _read_payload()

    try:
        import ct_status

        section = ct_status.context_section()
    except Exception:
        # Fail-open: never block or delay a session for an advisory check.
        section = None

    parts = [part for part in (section, _bootstrap(payload)) if part]
    if parts:
        _emit(
            {
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": "\n\n".join(parts),
                }
            }
        )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
