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
