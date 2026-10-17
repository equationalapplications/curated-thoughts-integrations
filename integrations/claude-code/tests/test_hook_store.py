"""ct_hook_store (shared with Claude Code): lock exclusivity survives prune,
safe lock / tmp housekeeping, bounded waits, the persisted breaker."""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

HOOKS = Path(__file__).resolve().parent.parent / "hooks"
SCRIPTS = HOOKS.parent / "scripts"
for _p in (str(SCRIPTS), str(HOOKS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import ct_hook_store as hs  # noqa: E402

POSIX = hs.fcntl is not None


class HookStoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ct-hook-store-")
        self.store = os.path.join(self.dir, "s1.json")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def age(self, path, days):
        past = time.time() - days * 86400
        os.utime(path, (past, past))

    def make(self, path, days=0):
        with open(path, "w") as handle:
            handle.write("{}")
        if days:
            self.age(path, days)

    def test_prune_removes_old_stores_and_their_free_lock_files(self):
        hs.atomic_write(self.store, {"x": 1})
        with hs.locked(self.store):
            pass
        fresh = os.path.join(self.dir, "s2.json")
        hs.atomic_write(fresh, {"x": 2})
        with hs.locked(fresh):
            pass
        self.age(self.store, 40)
        hs.prune(self.dir)
        self.assertFalse(os.path.exists(self.store))
        self.assertFalse(os.path.exists(self.store + ".lock"))
        self.assertTrue(os.path.exists(fresh))
        self.assertTrue(os.path.exists(fresh + ".lock"))  # its store is still there

    @unittest.skipUnless(POSIX, "flock semantics")
    def test_a_held_lock_is_never_pruned_and_stays_exclusive(self):
        with hs.locked(self.store):
            hs.prune(self.dir, force=True)  # store absent, but the lock is held
            self.assertTrue(os.path.exists(self.store + ".lock"))
            with self.assertRaises(hs.LockTimeout):
                with hs.locked(self.store, wait=0.1):
                    pass

    @unittest.skipUnless(POSIX, "flock semantics")
    def test_lock_retries_when_its_file_was_unlinked_under_it(self):
        # A opens the lock file, the file is unlinked (old prune race), a
        # new file appears: the next locker must lock the file AT the path.
        lock_path = self.store + ".lock"
        with hs.locked(self.store):
            pass
        stale = os.open(lock_path, os.O_RDWR)
        os.remove(lock_path)
        try:
            hs.fcntl.flock(stale, hs.fcntl.LOCK_EX)  # holder of the orphan inode
            with hs.locked(self.store, wait=0.5):
                self.assertTrue(os.path.exists(lock_path))
                with self.assertRaises(hs.LockTimeout):
                    with hs.locked(self.store, wait=0.1):
                        pass
        finally:
            os.close(stale)

    def test_prune_removes_stale_tmp_files_only(self):
        old_tmp = os.path.join(self.dir, "s9.json.123.tmp")
        new_tmp = os.path.join(self.dir, "s8.json.124.tmp")
        self.make(old_tmp, days=2)
        self.make(new_tmp)
        hs.prune(self.dir)
        self.assertFalse(os.path.exists(old_tmp))
        self.assertTrue(os.path.exists(new_tmp))

    def test_prune_runs_at_most_once_a_day(self):
        hs.prune(self.dir)
        self.make(self.store, days=40)
        hs.prune(self.dir)
        self.assertTrue(os.path.exists(self.store))
        self.age(os.path.join(self.dir, hs.PRUNE_STAMP), 2)
        hs.prune(self.dir)
        self.assertFalse(os.path.exists(self.store))

    def test_lock_wait_is_bounded(self):
        with hs.locked(self.store):
            started = time.monotonic()
            with self.assertRaises(hs.LockTimeout):
                with hs.locked(self.store, wait=0.2):
                    pass
            self.assertLess(time.monotonic() - started, 2.0)

    def test_lock_serializes_threads(self):
        counter = {"n": 0, "max": 0, "inside": 0}

        def work():
            for _ in range(20):
                with hs.locked(self.store, wait=5):
                    counter["inside"] += 1
                    counter["max"] = max(counter["max"], counter["inside"])
                    counter["n"] += 1
                    counter["inside"] -= 1

        threads = [threading.Thread(target=work) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual((counter["n"], counter["max"]), (80, 1))

    def test_session_key(self):
        self.assertEqual(hs.session_key("abc-1_2"), "abc-1_2")
        self.assertEqual(len(hs.session_key("a/b")), 64)

    def test_breaker(self):
        now = [1000.0]
        b = hs.PersistedBreaker(os.path.join(self.dir, "b.json"), fails=2, pause=10,
                                clock=lambda: now[0])
        b.record_failure()
        self.assertFalse(b.is_open())
        b.record_failure()
        self.assertTrue(b.is_open())
        now[0] += 11
        self.assertFalse(b.is_open())


if __name__ == "__main__":
    unittest.main()
