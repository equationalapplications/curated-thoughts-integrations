#!/usr/bin/env python3
"""ct_wisdom_log.py — read the Intuitive Wisdom verbose log.

Spec: docs/superpowers/specs/2026-10-16-wisdom-verbose-mode-design.md (D7).

    python3 ct_wisdom_log.py [--host hermes|claude-code] [--path FILE]
                             [-n N] [-f] [--block] [--json]

Prints the last N events (default 20) of the JSON Lines log that verbose mode
(CT_WISDOM_VERBOSE=1) writes, one readable entry per turn: what was
delivered, or why nothing was. `-f` keeps following the file like `tail -f`.
Read-only. Stdlib only. Byte-identical in the Hermes and Claude Code
integrations.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ct_wisdom_verbose  # noqa: E402

DEFAULT_HOST = "hermes"


def _claude_code_fallback(env):
    """Outside a hook CLAUDE_PLUGIN_DATA is unset: look under the Claude Code
    config dir's plugins/data/curated-thoughts*/ and take the newest log."""
    view = os.environ if env is None else env
    config = view.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    pattern = os.path.join(os.path.expanduser(config), "plugins", "data", "curated-thoughts*",
                           "wisdom", ct_wisdom_verbose.LOG_NAME)
    found = glob.glob(pattern)
    return max(found, key=os.path.getmtime) if found else None


def resolve_path(host, path, env=None):
    if path:
        return os.path.expanduser(path)
    resolved = ct_wisdom_verbose.log_path(host, env)
    if resolved is None and host == "claude-code":
        resolved = _claude_code_fallback(env)
    return resolved


def format_record(record, block=False):
    lines = ["%s %s %s session=%s  %s" % (
        record.get("ts", "?"), record.get("host", "?"), record.get("channel", "?"),
        record.get("session_id") or "-", ct_wisdom_verbose.summary(record),
    )]
    if isinstance(record.get("query"), str):
        query = record["query"].replace("\n", " ")
        lines.append('  query: "%s"' % (query[:157] + "..." if len(query) > 160 else query))
    lines += ct_wisdom_verbose.matched_lines(record)
    if block and record.get("block"):
        lines += ["", record["block"], ""]
    return "\n".join(lines)


def _parse(line):
    try:
        record = json.loads(line)
    except ValueError:
        return None
    return record if isinstance(record, dict) else None


def _emit(line, args):
    record = _parse(line)
    if record is None:
        return
    if args.json:
        print(json.dumps(record, ensure_ascii=False))
    else:
        print(format_record(record, args.block))


def main(argv=None, env=None):
    parser = argparse.ArgumentParser(description="Read the Curated Thoughts wisdom verbose log.")
    parser.add_argument("--host", default=DEFAULT_HOST, choices=("hermes", "claude-code"))
    parser.add_argument("--path", help="log file (default: the host's verbose log)")
    parser.add_argument("-n", type=int, default=20, help="events to show (default 20)")
    parser.add_argument("-f", "--follow", action="store_true", help="keep printing new events")
    parser.add_argument("--block", action="store_true", help="also print delivered blocks")
    parser.add_argument("--json", action="store_true", help="print raw JSON records")
    args = parser.parse_args(argv)

    path = resolve_path(args.host, args.path, env)
    if not path:
        print("no log location for --host %s; pass --path or set CT_WISDOM_VERBOSE_LOG"
              % args.host, file=sys.stderr)
        return 2
    try:
        handle = open(path, encoding="utf-8", errors="replace")
    except OSError as error:
        print("cannot read %s: %s (is CT_WISDOM_VERBOSE=1 set?)" % (path, error.strerror),
              file=sys.stderr)
        return 1
    with handle:
        lines = [line for line in handle.readlines() if _parse(line) is not None]
        for line in lines[-args.n:] if args.n > 0 else []:
            _emit(line, args)
        sys.stdout.flush()
        while args.follow:
            line = handle.readline()
            if line:
                _emit(line, args)
                sys.stdout.flush()
            else:
                time.sleep(0.5)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
