"""ct_hook_store (shared with Claude Code): lock exclusivity survives prune,
bounded waits, atomic writes, the persisted breaker."""

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


class HookStoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ct-hook-store-")
        self.store = os.path.join(self.dir, "s1.json")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def age(self, path, days):
        past = time.time() - days * 86400
        os.utime(path, (past, past))

    def test_prune_removes_old_stores_and_never_lock_files(self):
        hs.atomic_write(self.store, {"x": 1})
        with hs.locked(self.store):
            pass
        fresh = os.path.join(self.dir, "s2.json")
        hs.atomic_write(fresh, {"x": 2})
        self.age(self.store, 40)
        self.age(self.store + ".lock", 40)
        hs.prune(self.dir)
        self.assertFalse(os.path.exists(self.store))
        self.assertTrue(os.path.exists(self.store + ".lock"))
        self.assertTrue(os.path.exists(fresh))

    def test_lock_stays_exclusive_across_a_prune(self):
        # The race the old prune allowed: A holds the lock, the lock file is
        # old, prune runs; B must still be excluded.
        with hs.locked(self.store):
            self.age(self.store + ".lock", 40)
            hs.prune(self.dir)
            with self.assertRaises(hs.LockTimeout):
                with hs.locked(self.store, wait=0.1):
                    pass

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
