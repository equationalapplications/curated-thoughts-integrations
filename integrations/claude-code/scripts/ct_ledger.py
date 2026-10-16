#!/usr/bin/env python3
"""ct_ledger.py — `ct-fact:<id>` markers and the transcript-derived ledger.

Spec: docs/superpowers/specs/2026-10-06-intuitive-wisdom-live-delivery-design.md
("Fact id marker", "Ledger"). The ledger is NEVER stored: it is rebuilt each
turn from host-persisted context (INTENT M1 — no plugin persistence).
LedgerCache only carries the latest rebuild from the pre_llm_call hook to the
transform_tool_result hook within one turn; it is a speed aid, never a source
of truth across turns.

Stdlib only; every function tolerates malformed input without raising.
"""

from __future__ import annotations

import re
import threading
from collections import OrderedDict
from collections.abc import Mapping

FACT_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_SCAN_RE = re.compile(r"ct-fact:([A-Za-z0-9._:-]{1,128})")
_FORGE_TOKEN = "ct-fact:"
LEDGER_CACHE_MAX = 256


def valid_id(value):
    """True for a CT fact id usable in a marker (spec CT guarantee 4)."""
    return isinstance(value, str) and FACT_ID_RE.fullmatch(value) is not None


def marker(fact_id):
    return "<!-- ct-fact:%s -->" % fact_id


def strip_forged(value):
    """Remove every `ct-fact:` token, repeatedly until stable (one pass can
    splice a fresh token together). Applied to fact titles/text so a fact can
    never forge a ledger entry."""
    while _FORGE_TOKEN in value:
        value = value.replace(_FORGE_TOKEN, "")
    return value


def scan_ids(text):
    """Ordered unique ids following `ct-fact:` in text."""
    if not isinstance(text, str):
        return []
    out = []
    for fid in _SCAN_RE.findall(text):
        if fid not in out:
            out.append(fid)
    return out


def _message_texts(msg):
    """Every text field of one history message: `content` (str or list of
    text parts) and the host's `api_content` sidecar (investigation O1: which
    one a hook sees on turn N+1 is unverified, so both are read)."""
    texts = []
    for key in ("content", "api_content"):
        value = msg.get(key)
        if isinstance(value, str):
            texts.append(value)
        elif isinstance(value, list):
            for part in value:
                if isinstance(part, str):
                    texts.append(part)
                elif isinstance(part, Mapping) and isinstance(part.get("text"), str):
                    texts.append(part["text"])
    return texts


def history_ids(history, roles=None):
    """Unique ids in history, most recent message first (the order the
    --exclude bound keeps). `roles` restricts to messages with those roles."""
    if not isinstance(history, list):
        return []
    out = []
    seen = set()
    for msg in reversed(history):
        if not isinstance(msg, Mapping):
            continue
        if roles is not None and msg.get("role") not in roles:
            continue
        for text in _message_texts(msg):
            for fid in scan_ids(text):
                if fid not in seen:
                    seen.add(fid)
                    out.append(fid)
    return out


class LedgerCache:
    """{session_id -> set(ids)}, LRU-bounded, lock-guarded."""

    def __init__(self, max_sessions=LEDGER_CACHE_MAX):
        self._store = OrderedDict()
        self._lock = threading.Lock()
        self._max = max_sessions

    def get(self, session_id):
        with self._lock:
            ids = self._store.get(session_id)
            if ids is None:
                return None
            self._store.move_to_end(session_id)
            return set(ids)

    def put(self, session_id, ids):
        with self._lock:
            self._store[session_id] = set(ids)
            self._store.move_to_end(session_id)
            while len(self._store) > self._max:
                self._store.popitem(last=False)

    def add(self, session_id, ids):
        with self._lock:
            current = self._store.get(session_id)
            if current is not None:
                current.update(ids)

    def clear(self):
        with self._lock:
            self._store.clear()


LEDGER_CACHE = LedgerCache()
