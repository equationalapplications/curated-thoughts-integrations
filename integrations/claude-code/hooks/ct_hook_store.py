#!/usr/bin/env python3
"""ct_hook_store.py — the per-session store primitives shared by the
command-hook adapters (Claude Code `hooks/ct_wisdom_cc.py`, Docker Agent
`hooks/ct_wisdom_da.py`).

Each hook is its own short-lived process, so what Hermes keeps in memory
lives on disk here: an atomically written JSON file per session, guarded by
an exclusive advisory lock on a sibling `.lock` file, plus a persisted
circuit breaker.

Lock files and pruning. Unlinking a lock file that another process has
open (or is about to lock) lets two processes each hold an "exclusive" lock
on different inodes. Two rules close that:

  * locked() re-checks, after taking the lock, that its descriptor is still
    the file at the lock path (same device and inode); if the file was
    unlinked or replaced meanwhile, it lets go and starts over;
  * prune() removes a lock file only when its session store is gone and a
    non-blocking lock on it succeeds (nobody holds it), and unlinks it while
    holding that lock. On Windows an open file cannot be unlinked, so the
    remove simply fails and the file stays.

prune() also removes session stores older than 30 days and stale `*.tmp`
files (a writer killed mid-write) older than a day, and runs at most once a
day (a stamp file in the directory).

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
TMP_MAX_AGE = 86400  # and leftover *.tmp files older than this
PRUNE_EVERY = 86400  # prune() does its work at most this often
PRUNE_STAMP = ".pruned"
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


def _try_lock(fd):
    """Take an exclusive lock without blocking; False when it is held."""
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        elif msvcrt is not None:  # pragma: no cover - Windows
            os.lseek(fd, 0, 0)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        return True
    except OSError:
        return False


def _unlock(fd):
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_UN)
        elif msvcrt is not None:  # pragma: no cover - Windows
            os.lseek(fd, 0, 0)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    except OSError:
        pass


def _same_file(fd, path):
    """True while `path` still names the file open as `fd`."""
    try:
        a, b = os.fstat(fd), os.stat(path)
    except OSError:
        return False
    return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)


@contextlib.contextmanager
def locked(path, wait=None):
    """Exclusive advisory lock on `<path>.lock`, waiting at most `wait` s
    (LOCK_WAIT by default); raises LockTimeout past it."""
    wait = LOCK_WAIT if wait is None else wait
    lock_path = path + ".lock"
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    deadline = time.monotonic() + wait
    while True:
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        if _try_lock(fd):
            if fcntl is None or _same_file(fd, lock_path):
                break
            _unlock(fd)  # pruned under us: retry on the file now at the path
        os.close(fd)
        if time.monotonic() >= deadline:
            raise LockTimeout(lock_path)
        time.sleep(0.01)
    try:
        yield
    finally:
        _unlock(fd)
        os.close(fd)


def _old(path, now, max_age):
    try:
        return now - os.path.getmtime(path) > max_age
    except OSError:
        return False


def _remove_free_lock(lock_path):
    """Unlink a lock file nobody holds, while holding it ourselves."""
    try:
        fd = os.open(lock_path, os.O_RDWR)
    except OSError:
        return
    try:
        if _try_lock(fd):
            try:
                if _same_file(fd, lock_path):
                    os.remove(lock_path)
            except OSError:
                pass
            finally:
                _unlock(fd)
    finally:
        os.close(fd)


def prune(directory, now=None, max_age=STORE_MAX_AGE, force=False):
    """Housekeeping for a sessions directory, at most once per PRUNE_EVERY
    (unless `force`): session stores (`*.json`) older than max_age, lock
    files whose store is gone and that nobody holds, and `*.tmp` files older
    than TMP_MAX_AGE."""
    now = time.time() if now is None else now
    stamp = os.path.join(directory, PRUNE_STAMP)
    if not force and os.path.exists(stamp) and not _old(stamp, now, PRUNE_EVERY):
        return
    try:
        names = os.listdir(directory)
    except OSError:
        return
    try:
        with open(stamp, "w", encoding="utf-8"):
            pass
        os.utime(stamp, (now, now))
    except OSError:
        pass
    for name in names:
        path = os.path.join(directory, name)
        try:
            if name.endswith(".json"):
                if _old(path, now, max_age):
                    os.remove(path)
            elif name.endswith(".tmp"):
                if _old(path, now, TMP_MAX_AGE):
                    os.remove(path)
        except OSError:
            pass
    for name in names:
        if name.endswith(".json.lock") and not os.path.exists(
                os.path.join(directory, name[: -len(".lock")])):
            _remove_free_lock(os.path.join(directory, name))


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
