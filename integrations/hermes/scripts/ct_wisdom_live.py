#!/usr/bin/env python3
"""ct_wisdom_live.py — relevance-timed mid-session wisdom delivery (Hermes).

Spec: docs/superpowers/specs/2026-10-06-intuitive-wisdom-live-delivery-design.md.

Once per user turn (Hermes `pre_llm_call`), ask CT which wisdom facts are
relevant to the user's message (`ct wisdom match`, CT owns the relevance
gate), drop anything already in context (transcript-derived ledger,
ct_ledger), and return {"context": block}. The host appends the block to the
turn's user message and persists the exact bytes for replay — the system
prompt is never touched.

Failure classes (all -> no delivery this turn, one debug line):
  empty_id, restored_unknown_bootstrap, breaker_open, empty_query,
  discovery_miss, probe_timeout, capability_missing, timeout, spawn, exit,
  parse_error, zero_hits.

Read-only: `ct` subprocess only. Stdlib only. Never raises.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
from collections import OrderedDict

import ct_ledger
import ct_wisdom

logger = logging.getLogger(__name__)

# Frozen (spec "New module"); INTENT invariant 5: never raised to compensate
# for weak matching.
LIVE_MAX_PER_TURN = 2
LIVE_MAX_BLOCK_CHARS = 1200
LIVE_MAX_PER_SESSION = 12
LIVE_TIMEOUT = 3  # seconds; on the turn path
LIVE_QUERY_CHARS = 2000
EXCLUDE_MAX = 256
BREAKER_FAILS = 3
BREAKER_PAUSE = 300  # seconds
FIRST_TURN_MAX_SESSIONS = 256

LIVE_HEADING = "## Curated Thoughts — relevant now"
_ELLIPSIS = "…"

# ---------------------------------------------------------------------------
# capability probe
# ---------------------------------------------------------------------------

_capability = {}
_capability_lock = threading.Lock()


def reset_capability_cache():
    """Clear the per-path capability memo (tests; spawn-failure recovery)."""
    with _capability_lock:
        _capability.clear()


def has_match_capability(ct_path):
    """True/False (memoized per path) whether `ct wisdom match` exists;
    None on probe timeout or spawn failure (NOT memoized — retry next turn)."""
    with _capability_lock:
        if ct_path in _capability:
            return _capability[ct_path]
    try:
        proc = subprocess.run(
            [ct_path, "wisdom", "match", "--help"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=ct_wisdom.PROBE_TIMEOUT,
            cwd=os.path.expanduser("~"),
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    with _capability_lock:
        return _capability.setdefault(ct_path, proc.returncode == 0)


# ---------------------------------------------------------------------------
# ct wisdom match
# ---------------------------------------------------------------------------


def _normalize_item(item):
    if not isinstance(item, dict):
        return None
    fact_id = item.get("id")
    if not ct_ledger.valid_id(fact_id):
        return None
    title = item.get("title")
    text = item.get("text")
    supersedes = item.get("supersedes")
    provenance = item.get("provenance")
    return {
        "id": fact_id,
        "title": title if isinstance(title, str) else "",
        "text": text if isinstance(text, str) else "",
        "supersedes": [s for s in supersedes if ct_ledger.valid_id(s)]
        if isinstance(supersedes, list) else [],
        "provenance": provenance
        if isinstance(provenance, str) and provenance.strip() else None,
    }


def match_wisdom(ct_path, text, max_n, exclude):
    """Run `ct wisdom match` per the spec contract.

    Returns (result | None, failure_class | None); result is
    {"entries": [item], "corrections": [item]} with invalid items dropped.
    `text` goes after `--` and ids use `--exclude=` so neither can be read as
    a flag.
    """
    argv = [ct_path, "wisdom", "match", "--json", "--max", str(max_n)]
    argv += ["--exclude=%s" % fact_id for fact_id in exclude]
    argv += ["--", text]
    try:
        proc = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=LIVE_TIMEOUT,
            cwd=os.path.expanduser("~"),
        )
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except OSError:
        return None, "spawn"
    if proc.returncode != 0:
        return None, "exit"
    try:
        data = json.loads(proc.stdout.decode("utf-8", errors="replace"))
    except (ValueError, UnicodeDecodeError):
        return None, "parse_error"
    if not isinstance(data, dict):
        return None, "parse_error"
    result = {}
    for key in ("entries", "corrections"):
        raw = data.get(key, [])
        if not isinstance(raw, list):
            return None, "parse_error"
        result[key] = [n for n in (_normalize_item(i) for i in raw) if n is not None]
    return result, None


# ---------------------------------------------------------------------------
# circuit breaker (per process)
# ---------------------------------------------------------------------------


class Breaker:
    """After `fails` consecutive timeout/exit failures, skip live matching
    for `pause` seconds so a sick backend cannot add LIVE_TIMEOUT to every
    turn."""

    def __init__(self, fails=BREAKER_FAILS, pause=BREAKER_PAUSE, clock=time.monotonic):
        self._fails = fails
        self._pause = pause
        self._clock = clock
        self._count = 0
        self._open_until = None
        self._lock = threading.Lock()

    def is_open(self):
        with self._lock:
            if self._open_until is None:
                return False
            if self._clock() >= self._open_until:
                self._open_until = None
                self._count = 0
                return False
            return True

    def record_failure(self):
        with self._lock:
            self._count += 1
            if self._count >= self._fails:
                self._open_until = self._clock() + self._pause

    def record_success(self):
        with self._lock:
            self._count = 0


_BREAKER = Breaker()


# ---------------------------------------------------------------------------
# ledger inputs
# ---------------------------------------------------------------------------

_first_turn_sessions = OrderedDict()
_first_turn_lock = threading.Lock()


def reset_session_state():
    """TEST-ONLY: forget which sessions were seen on their first turn."""
    with _first_turn_lock:
        _first_turn_sessions.clear()


def bootstrap_ids(session_id, is_first_turn):
    """Fact ids in this session's frozen bootstrap block.

    The hook cannot see the system prompt (investigation Target 2), so the ids
    come from the bootstrap block this process rendered. A first turn with no
    rendered block means there is no block -> []. Any other session with no
    rendered block was restored (/resume, /branch, restart): its ids are
    unknowable -> None, and the caller fails closed (spec "Ledger").
    """
    block = ct_wisdom.bootstrap_block(session_id)
    if block is not None:
        return ct_ledger.scan_ids(block)
    with _first_turn_lock:
        if is_first_turn:
            _first_turn_sessions[session_id] = True
            _first_turn_sessions.move_to_end(session_id)
            while len(_first_turn_sessions) > FIRST_TURN_MAX_SESSIONS:
                _first_turn_sessions.popitem(last=False)
            return []
        if session_id in _first_turn_sessions:
            return []
    return None


def user_text(user_message):
    """The user's message as one stripped string, truncated to LIVE_QUERY_CHARS."""
    if isinstance(user_message, str):
        text = user_message
    elif isinstance(user_message, list):
        parts = []
        for part in user_message:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        text = "\n".join(parts)
    else:
        return ""
    return text.strip()[:LIVE_QUERY_CHARS]


# ---------------------------------------------------------------------------
# render
# ---------------------------------------------------------------------------


def _one_line(value):
    return ct_wisdom._sanitize(value).strip().replace("\n", " ")


def _title_line(item, superseded):
    line = "**%s** %s (provenance: %s)" % (
        _one_line(item["title"]),
        ct_ledger.marker(item["id"]),
        _one_line(item["provenance"] or "unlabeled"),
    )
    if superseded:
        line += " — supersedes " + ", ".join("ct-fact:%s" % s for s in superseded)
    return line


def render_live_block(entries, corrections, ledger):
    """Render corrections (first) then entries not already in `ledger`.

    Returns (block, delivered_ids); ("", []) when nothing survives. Same
    fit / truncate-one / stop rule as v1 render_block, budget
    LIVE_MAX_BLOCK_CHARS; corrections come first so an entry can never take
    a correction's budget. A correction survives only if it supersedes
    something actually in context.
    """
    chosen = []
    seen = set(ledger)
    for item in corrections:
        superseded = [s for s in item["supersedes"] if s in ledger]
        if item["id"] in seen or not superseded:
            continue
        seen.add(item["id"])
        chosen.append((item, superseded))
    for item in entries:
        if item["id"] in seen:
            continue
        seen.add(item["id"])
        chosen.append((item, []))

    parts = []
    delivered = []
    used = len(LIVE_HEADING) + 2
    for item, superseded in chosen:
        text = ct_wisdom._sanitize(item["text"])
        if not item["title"].strip() and not text.strip():
            continue
        title_line = _title_line(item, superseded)
        body = title_line + "\n" + text
        sep = 2 if parts else 0
        remaining = LIVE_MAX_BLOCK_CHARS - used - sep
        if remaining <= len(title_line) + 1:
            continue
        if len(body) <= remaining:
            parts.append(body)
            used += sep + len(body)
            delivered.append(item["id"])
            continue
        text_budget = remaining - len(title_line) - 1 - len(_ELLIPSIS)
        if text_budget > 0:
            parts.append(title_line + "\n" + text[:text_budget] + _ELLIPSIS)
            delivered.append(item["id"])
        break
    if not parts:
        return "", []
    return LIVE_HEADING + "\n\n" + "\n\n".join(parts), delivered


# ---------------------------------------------------------------------------
# pre_llm_call hook
# ---------------------------------------------------------------------------


def _skip(session_id, failure_class):
    logger.debug("wisdom-live: skip session=%s class=%s",
                 session_id or "<empty>", failure_class)
    return None


def on_pre_llm_call(**kwargs):
    """Hermes `pre_llm_call` callback. Never raises; None = inject nothing."""
    try:
        return _pre_llm_call(
            kwargs.get("session_id"),
            kwargs.get("user_message"),
            kwargs.get("conversation_history"),
            bool(kwargs.get("is_first_turn")),
        )
    except Exception:
        logger.debug("wisdom-live: hook failed", exc_info=True)
        return None


def _pre_llm_call(session_id, user_message, history, is_first_turn):
    if not isinstance(session_id, str) or not session_id:
        return _skip(session_id, "empty_id")
    boot = bootstrap_ids(session_id, is_first_turn)
    if boot is None:
        return _skip(session_id, "restored_unknown_bootstrap")
    history = history if isinstance(history, list) else []
    recent = ct_ledger.history_ids(history)
    recent_set = set(recent)
    ledger_list = recent + [i for i in boot if i not in recent_set]
    ledger = set(ledger_list)
    # Cached BEFORE any early return so the transform_tool_result hook can
    # dedup agent-initiated CT calls even on turns with nothing to deliver.
    ct_ledger.LEDGER_CACHE.put(session_id, ledger)

    if _BREAKER.is_open():
        return _skip(session_id, "breaker_open")
    query = user_text(user_message)
    if not query:
        return _skip(session_id, "empty_query")
    path, dclass = ct_wisdom.discover_ct()
    if path is None:
        return _skip(session_id, dclass or "discovery_miss")
    capable = has_match_capability(path)
    if not capable:
        return _skip(session_id, "probe_timeout" if capable is None else "capability_missing")

    live_used = len(ct_ledger.history_ids(history, roles=("user",)))
    max_n = 0 if live_used >= LIVE_MAX_PER_SESSION else LIVE_MAX_PER_TURN
    result, rclass = match_wisdom(path, query, max_n, ledger_list[:EXCLUDE_MAX])
    if rclass is not None:
        if rclass in ("timeout", "exit"):
            _BREAKER.record_failure()
        elif rclass == "spawn":
            ct_wisdom.reset_discovery_cache()
            reset_capability_cache()
        return _skip(session_id, rclass)
    _BREAKER.record_success()

    block, delivered = render_live_block(result["entries"], result["corrections"], ledger)
    if not block:
        return _skip(session_id, "zero_hits")
    ct_ledger.LEDGER_CACHE.add(session_id, delivered)
    logger.debug("wisdom-live: deliver session=%s ids=%s", session_id, ",".join(delivered))
    return {"context": block}
