#!/usr/bin/env python3
"""ct_wisdom_verbose.py — opt-in verbose mode for Intuitive Wisdom live delivery.

Spec: docs/superpowers/specs/2026-10-16-wisdom-verbose-mode-design.md.

With CT_WISDOM_VERBOSE=1, every live-delivery decision (a delivery, or the
reason nothing was delivered) is:

  * appended to a local JSON Lines log (the integration's own file, never the
    brain; CT_WISDOM_VERBOSE_LOG overrides the per-host default), and
  * handed, as a short readable notice, to a user-only sink: stderr by
    default (Hermes); Claude Code installs a collecting sink and returns the
    text as the hook's `systemMessage`.

Nothing here can change what the model sees: the recorder runs after the
delivery decision, reads copies of its inputs, and returns None. With verbose
off it returns before doing any work. Every entry point swallows every error
(INTENT rule 4). Events are built from an allowlist: environment variables
are never logged, and the only user text is the query as CT received it.

Byte-identical in integrations/hermes/scripts and integrations/claude-code/
scripts (tests/tools/test_shared_script_parity.py). Stdlib only.
"""

from __future__ import annotations

import datetime
import json
import os
import sys

VERBOSE_ENV = "CT_WISDOM_VERBOSE"
LOG_ENV = "CT_WISDOM_VERBOSE_LOG"
LOG_NAME = "ct-wisdom-verbose.jsonl"
SCHEMA = 1
MAX_LOG_BYTES = 5 * 1024 * 1024  # rotate to <file>.1 past this size
_TRUE = ("1", "true", "yes", "on")


def _stderr_sink(text):
    sys.stderr.write(text.rstrip("\n") + "\n")
    sys.stderr.flush()


_sink = _stderr_sink


def set_sink(fn):
    """Replace the notice sink (fn(text) -> None, or None for stderr).
    Returns the previous sink so callers can restore it."""
    global _sink
    previous = _sink
    _sink = fn if callable(fn) else _stderr_sink
    return previous


def _get(env, key):
    try:
        value = env.get(key)
    except Exception:
        return None
    return value if isinstance(value, str) else None


def _view(env):
    return os.environ if env is None else env


def enabled(env=None):
    """True when CT_WISDOM_VERBOSE is 1/true/yes/on (case-insensitive)."""
    value = _get(_view(env), VERBOSE_ENV)
    return value is not None and value.strip().lower() in _TRUE


def _hermes_home(view):
    # Use Hermes's own resolver only when the host already loaded it; this
    # module never imports host code.
    constants = sys.modules.get("hermes_constants")
    resolver = getattr(constants, "get_hermes_home", None)
    if callable(resolver):
        try:
            return str(resolver())
        except Exception:
            pass
    home = _get(view, "HERMES_HOME")
    if home and home.strip():
        return os.path.expanduser(home)
    return os.path.join(os.path.expanduser("~"), ".hermes")


def log_path(host, env=None):
    """The verbose log file for `host`, or None when it has no location."""
    view = _view(env)
    override = _get(view, LOG_ENV)
    if override and override.strip():
        return os.path.expanduser(override.strip())
    if host == "hermes":
        return os.path.join(_hermes_home(view), "logs", LOG_NAME)
    if host == "claude-code":
        data = _get(view, "CLAUDE_PLUGIN_DATA")
        if data and data.strip():
            return os.path.join(data, "wisdom", LOG_NAME)
    return None


# ---------------------------------------------------------------------------
# event building (allowlist only)
# ---------------------------------------------------------------------------


def _str_or_none(value):
    return value if isinstance(value, str) else None


def _ids(value):
    if isinstance(value, (list, tuple, set, frozenset)):
        return [i for i in value if isinstance(i, str)]
    return []


def _items(result, key):
    raw = result.get(key) if isinstance(result, dict) else None
    return [i for i in raw if isinstance(i, dict)] if isinstance(raw, list) else []


def _score(item):
    score = item.get("score")
    if isinstance(score, bool) or not isinstance(score, (int, float)):
        return None
    return score


def _matched(result, ledger, delivered):
    out = []
    for kind, key in (("correction", "corrections"), ("entry", "entries")):
        for item in _items(result, key):
            fid = _str_or_none(item.get("id"))
            supersedes = _ids(item.get("supersedes"))
            if fid is not None and fid in delivered:
                outcome = "delivered"
            elif fid is not None and fid in ledger:
                outcome = "in_context"
            elif kind == "correction" and not any(s in ledger for s in supersedes):
                outcome = "not_applicable"
            else:
                outcome = "budget"
            out.append({
                "id": fid,
                "kind": kind,
                "title": _str_or_none(item.get("title")) or "",
                "text": _str_or_none(item.get("text")) or "",
                "score": _score(item),
                "provenance": _str_or_none(item.get("provenance")),
                "supersedes": supersedes,
                "outcome": outcome,
            })
    return out


def _zero_hits_reason(gate, matched):
    if not matched:
        return "gate_uncalibrated" if gate == "uncalibrated" else "no_match"
    outcomes = {m["outcome"] for m in matched}
    if "budget" in outcomes:
        return "budget"
    if "in_context" in outcomes:
        return "deduped"
    return "no_match"


def _now():
    stamp = datetime.datetime.now(datetime.timezone.utc)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (stamp.microsecond // 1000)


def build_event(kind, event):
    """The v1 log record for a caller's raw event dict (see the spec)."""
    result = event.get("result")
    ledger = set(_ids(event.get("ledger")))
    delivered = _ids(event.get("delivered"))
    gate = _str_or_none(result.get("gate")) if isinstance(result, dict) else None
    matched = _matched(result, ledger, set(delivered))
    reason = None if kind == "delivery" else (_str_or_none(event.get("reason")) or "unknown")
    if reason == "zero_hits":
        reason = _zero_hits_reason(gate, matched)
    record = {
        "v": SCHEMA,
        "ts": _now(),
        "host": _str_or_none(event.get("host")),
        "channel": _str_or_none(event.get("channel")),
        "session_id": _str_or_none(event.get("session_id")),
        "event": kind,
        "reason": reason,
    }
    query = _str_or_none(event.get("query"))
    if query is not None:
        record["query"] = query
    activity = _str_or_none(event.get("activity"))
    if activity is not None:  # autonomous-work label, e.g. "read src/x.py"
        record["activity"] = activity
    if isinstance(result, dict):
        record["gate"] = gate
        record["matched"] = matched
    if kind == "delivery":
        block = _str_or_none(event.get("block")) or ""
        record["delivered_ids"] = delivered
        record["block_chars"] = len(block)
        record["block"] = block
    if event.get("ledger") is not None:
        record["ledger_size"] = len(ledger)
    return record


# ---------------------------------------------------------------------------
# rendering (shared with ct_wisdom_log.py)
# ---------------------------------------------------------------------------

_MARK = {"delivered": "+", "in_context": "=", "budget": "-", "not_applicable": "-"}
_NOTE = {"in_context": " (already in context)", "budget": " (did not fit)",
         "not_applicable": " (supersedes nothing in context)"}


def matched_lines(record):
    lines = []
    for m in record.get("matched") or []:
        if not isinstance(m, dict):
            continue
        score = m.get("score")
        score_text = ("%.3f" % score) if isinstance(score, (int, float)) else "-"
        lines.append("  %s %s %s %s%s \"%s\"" % (
            _MARK.get(m.get("outcome"), "?"), m.get("id"), score_text,
            m.get("provenance") or "unlabeled", _NOTE.get(m.get("outcome"), ""),
            (m.get("title") or "").replace("\n", " ")[:80],
        ))
    return lines


def summary(record):
    if record.get("event") == "delivery":
        count = len(record.get("delivered_ids") or [])
        head = "delivered %d fact%s (%d chars)" % (
            count, "" if count == 1 else "s", record.get("block_chars") or 0)
    else:
        head = "nothing delivered (%s)" % record.get("reason")
    gate = record.get("gate")
    if gate:
        head += " gate=%s" % gate
    return head


def format_notice(record):
    """The readable text shown to the user for one record."""
    lines = ["Curated Thoughts wisdom: %s [%s]" % (summary(record), record.get("channel") or "?")]
    lines += matched_lines(record)
    block = record.get("block")
    if block:
        lines += ["", block]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------


def _append(path, record):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    try:
        if os.path.getsize(path) > MAX_LOG_BYTES:
            os.replace(path, path + ".1")
    except OSError:
        pass
    line = json.dumps(record, ensure_ascii=False) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, line.encode("utf-8"))
    finally:
        os.close(fd)


def _record(kind, event, env):
    try:
        if not enabled(env) or not isinstance(event, dict):
            return
        record = build_event(kind, event)
    except Exception:
        return
    try:
        path = log_path(record.get("host"), env)
        if path:
            _append(path, record)
    except Exception:
        pass
    try:
        _sink(format_notice(record))
    except Exception:
        pass


def record_delivery(event, env=None):
    """Record one live delivery. Never raises; no-op unless verbose is on."""
    _record("delivery", event, env)


def record_non_delivery(event, env=None):
    """Record why a turn delivered nothing. Never raises; no-op unless on."""
    _record("skip", event, env)
