#!/usr/bin/env python3
"""ct_hook_store.py — the per-session store primitives shared by the
command-hook adapters (Claude Code `hooks/ct_wisdom_cc.py`, Docker Agent
`hooks/ct_wisdom_da.py`).

Each hook is its own short-lived process, so what Hermes keeps in memory
lives on disk here: an atomically written JSON file per session, guarded by
an exclusive advisory lock on a sibling `.lock` file, plus a persisted
circuit breaker.

Lock files are NEVER deleted. A process may open a lock file and block on
it while another unlinks it; the next process then creates a fresh file and
both hold an "exclusive" lock on different inodes. No unlink protocol avoids
that race without a second lock, so prune() removes old session stores and
leaves their (empty) lock files alone.

Byte-identical in integrations/claude-code/hooks and
integrations/docker-agent/hooks (tests/tools/test_shared_script_parity.py).
Stdlib only; nothing here raises except LockTimeout (by design) and OSError
from an explicit write.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import time

import ct_wisdom_live

try:  # POSIX
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None
try:  # Windows
    import msvcrt
except ImportError:
    msvcrt = None

logger = logging.getLogger(__name__)

LOCK_WAIT = 2.0  # seconds; a hook never blocks longer than this on a store
STORE_MAX_AGE = 30 * 86400  # prune() removes session stores older than this
_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class LockTimeout(Exception):
    """The store lock could not be taken within its bounded wait."""


def session_key(session_id):
    """The file stem for a session id: the id itself when it is a safe
    name, else its sha256 hex digest."""
    if _KEY_RE.match(session_id):
        return session_id
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()


def atomic_write(path, data):
    """Write `data` as JSON to `path` via a temp file and os.replace."""
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False)
    os.replace(tmp, path)


@contextlib.contextmanager
def locked(path, wait=None):
    """Exclusive advisory lock on `<path>.lock`, waiting at most `wait` s
    (LOCK_WAIT by default); raises LockTimeout past it."""
    wait = LOCK_WAIT if wait is None else wait
    lock_path = path + ".lock"
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    deadline = time.monotonic() + wait
    try:
        while True:
            try:
                if fcntl is not None:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                elif msvcrt is not None:  # pragma: no cover - Windows
                    os.lseek(fd, 0, 0)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise LockTimeout(lock_path)
                time.sleep(0.01)
        try:
            yield
        finally:
            try:
                if fcntl is not None:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                elif msvcrt is not None:  # pragma: no cover - Windows
                    os.lseek(fd, 0, 0)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
    finally:
        os.close(fd)


def prune(directory, now=None, max_age=STORE_MAX_AGE):
    """Remove session stores (`*.json`) in `directory` not touched in
    max_age seconds. Lock files are never removed (see the module doc)."""
    now = time.time() if now is None else now
    try:
        names = os.listdir(directory)
    except OSError:
        return
    for name in names:
        if not name.endswith(".json"):
            continue
        path = os.path.join(directory, name)
        try:
            if now - os.path.getmtime(path) > max_age:
                os.remove(path)
        except OSError:
            pass


class PersistedBreaker:
    """ct_wisdom_live.Breaker semantics over a JSON file: after
    BREAKER_FAILS consecutive timeout/exit failures, CT calls pause
    BREAKER_PAUSE s. An unreadable file reads as closed (the breaker only
    ever suppresses)."""

    def __init__(self, path, fails=ct_wisdom_live.BREAKER_FAILS,
                 pause=ct_wisdom_live.BREAKER_PAUSE, clock=time.time):
        self._path = path
        self._fails = fails
        self._pause = pause
        self._clock = clock

    def _read(self):
        try:
            with open(self._path, encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            return {"count": 0, "open_until": None}
        count = data.get("count") if isinstance(data, dict) else None
        until = data.get("open_until") if isinstance(data, dict) else None
        return {
            "count": count if isinstance(count, int) else 0,
            "open_until": until if isinstance(until, (int, float)) else None,
        }

    def _write(self, state):
        try:
            atomic_write(self._path, state)
        except OSError:
            logger.debug("ct-hook-store: breaker write failed", exc_info=True)

    def is_open(self):
        state = self._read()
        if state["open_until"] is None:
            return False
        if self._clock() >= state["open_until"]:
            self._write({"count": 0, "open_until": None})
            return False
        return True

    def record_failure(self):
        state = self._read()
        state["count"] += 1
        if state["count"] >= self._fails:
            state["open_until"] = self._clock() + self._pause
        self._write(state)

    def record_success(self):
        state = self._read()
        if state["count"] or state["open_until"] is not None:
            self._write({"count": 0, "open_until": None})
