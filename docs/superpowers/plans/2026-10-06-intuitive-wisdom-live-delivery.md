# Intuitive Wisdom — Live Delivery (Hermes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver curated-wisdom facts to a Hermes agent mid-session, on the user turn
where CT judges them relevant, exactly once per session context, without touching the
frozen system prompt.

**Architecture:** Three new stdlib-only modules under `integrations/hermes/scripts/`:
`ct_ledger.py` (id markers + ledger rebuilt from the transcript), `ct_wisdom_live.py`
(the `pre_llm_call` hook: capability probe → `ct wisdom match` → render → `{"context":
block}`), and `ct_tool_dedup.py` (the `transform_tool_result` hook that stubs repeated
facts in `curated_recall_context` results). `ct_wisdom.py` (v1) gains id markers in
its bootstrap block and a `bootstrap_block()` accessor. `__init__.py` registers the two
hooks. Everything is a silent no-op against a `ct` without the `wisdom match`
subcommand.

**Tech Stack:** Python stdlib only (`subprocess`, `json`, `re`, `threading`,
`collections.OrderedDict`), `unittest` (run by `integration.yaml` `checks.test`), ruff
`--select E9,F63,F7,F82,F401`. CI matrix unchanged: 3 OS × py3.9/3.13. Code must be
3.9 syntax (`from __future__ import annotations`, no `match`, no `X | Y` at runtime).

**Spec:** [`docs/superpowers/specs/2026-10-06-intuitive-wisdom-live-delivery-design.md`](../specs/2026-10-06-intuitive-wisdom-live-delivery-design.md)
— the plan argues from the spec; executors read both. Evidence:
[`../investigations/2026-10-06-intuitive-wisdom-live-delivery-step0-investigation.md`](../investigations/2026-10-06-intuitive-wisdom-live-delivery-step0-investigation.md).
Predecessor (v1) plan for code conventions:
[`2026-09-30-wisdom-auto-inclusion.md`](2026-09-30-wisdom-auto-inclusion.md).

## Global Constraints

- Stdlib only; no new dependencies in `integrations/hermes/`.
- Every `ct` call: `subprocess.run(<list argv>, stdin=subprocess.DEVNULL, capture_output=True, timeout=<T>, cwd=os.path.expanduser("~"))`. Never `shell=True`.
- `ct wisdom match` argv shape is exactly: `[ct, "wisdom", "match", "--json", "--max", str(n), "--exclude=<id>"..., "--", <text>]`.
- Frozen constants (spec): `LIVE_MAX_PER_TURN=2`, `LIVE_MAX_BLOCK_CHARS=1200`, `LIVE_MAX_PER_SESSION=12`, `LIVE_TIMEOUT=3`, `LIVE_QUERY_CHARS=2000`, `EXCLUDE_MAX=256`, `BREAKER_FAILS=3`, `BREAKER_PAUSE=300`. Never raised to compensate for weak matching (INTENT invariant 5).
- Fact id regex: `^[A-Za-z0-9._:-]{1,128}$`. Marker: `<!-- ct-fact:<id> -->`.
- Live block heading: `## Curated Thoughts — relevant now` (U+2014 em dash).
- Hook entry points never raise; every skip logs ONE debug line prefixed `wisdom-live:`; never INFO.
- No plugin-side persistence; no writes to CT; no direct DB access (INTENT read-only rules).
- No `[A]`/O-item may be silently assumed: O1–O3 are verified in Task 9 and recorded in the investigation.
- Tests run from the integration dir: `cd integrations/hermes && python3 -m unittest discover -s tests -v`.
- `ruff` may not be on PATH locally; `uvx ruff check --select E9,F63,F7,F82,F401 integrations/hermes` is equivalent.
- Plan pre-validated 2026-10-06: every code block below was assembled into a scratch copy of the integration — 308 tests OK (1 pre-existing skip), ruff clean, and both Task 6 mutations make the property test FAIL.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `integrations/hermes/scripts/ct_ledger.py` (new) | id validation, marker format, forged-token stripping, `scan_ids`, `history_ids`, `LedgerCache` |
| `integrations/hermes/scripts/ct_wisdom.py` (modify) | sanitizer strips `ct-fact:`; `recall_wiki` returns `(title, text, id)` and drops invalid ids; `render_block` emits markers; `WisdomMemo.last_block`; `bootstrap_block()` |
| `integrations/hermes/scripts/ct_wisdom_live.py` (new) | capability probe, `match_wisdom`, `Breaker`, `bootstrap_ids`, `user_text`, `render_live_block`, `on_pre_llm_call` |
| `integrations/hermes/scripts/ct_tool_dedup.py` (new) | `on_transform_tool_result` |
| `integrations/hermes/__init__.py` (modify) | register `pre_llm_call` + `transform_tool_result` |
| `integrations/hermes/tests/test_ct_ledger.py` (new) | ledger unit tests |
| `integrations/hermes/tests/test_ct_wisdom.py` (modify) | v1 fixtures gain ids; marker/sanitizer/last_block tests; wiring tests |
| `integrations/hermes/tests/test_ct_wisdom_live.py` (new) | live hook unit tests |
| `integrations/hermes/tests/test_ct_tool_dedup.py` (new) | dedup hook unit tests |
| `integrations/hermes/tests/test_exactly_once.py` (new) | randomized exactly-once property test |
| `INTENT.md`, `README.md`, `integrations/hermes/CHANGELOG.md`, `plugin.yaml`, `integration.yaml`, `skills/curated-thoughts-usage/SKILL.md`, spec status line | docs + version 0.4.0 |

---

### Task 0: File the CT prerequisite (external, owner-confirmed)

The Hermes code is built and unit-tested against a faked `ct wisdom match`; only Task 9
(e2e) needs the real CT build. This task produces the CT-side tracking item.

**Files:** none in this repo.

- [ ] **Step 1: Draft the CT issue body** (paste into the scratchpad, not the repo):

```markdown
Title: `ct wisdom match` — relevance-gated, read-only wisdom match contract (CTI live delivery prerequisite)

CTI spec: equationalapplications/curated-thoughts-integrations docs/superpowers/specs/2026-10-06-intuitive-wisdom-live-delivery-design.md §"CT prerequisite".

Contract (verbatim from the spec):
    ct wisdom match --json [--max N] [--exclude=<id>]... -- <text>
- exit 0 on success INCLUDING zero matches; non-zero = error
- stdout {"schema":1,"gate":"semantic-v1","entries":[...],"corrections":[...]}
  item = {id, title, text, score, supersedes:[ids], provenance}
- entries: passed CT's semantic gate (cosine over llm_wiki_entries.embedding_blob,
  CT-owned threshold); never an --exclude id; never superseded
- corrections: current replacement for every --exclude id superseded since, regardless of match
- ids match ^[A-Za-z0-9._:-]{1,128}$ (today: fact_<24 hex>, generate_llm_id)
- provenance from CT's fixed vocabulary or null
- p95 <= 1.5 s warm
- `ct wisdom match --help` exits 0 (capability probe)
Open CT work: threshold calibration; deposit-path supersession -> wiki-id `supersedes`.
```

- [ ] **Step 2: Ask the owner to confirm before filing** (outward-facing). On approval:
`gh issue create -R equationalapplications/curated-thoughts --title "<title>" --body-file <scratch file>`.
Record the issue URL in the spec header line `**Repos:**`.

---

### Task 1: `ct_ledger.py` — markers and transcript ledger

**Files:**
- Create: `integrations/hermes/scripts/ct_ledger.py`
- Test: `integrations/hermes/tests/test_ct_ledger.py`

**Interfaces:**
- Produces:
  - `FACT_ID_RE: re.Pattern`
  - `valid_id(value) -> bool`
  - `marker(fact_id: str) -> str` → `"<!-- ct-fact:%s -->"`
  - `strip_forged(value: str) -> str` — removes every `ct-fact:` until stable
  - `scan_ids(text: str) -> list[str]` — ordered unique ids found after `ct-fact:`
  - `history_ids(history, roles=None) -> list[str]` — unique ids, most recent message first
  - `class LedgerCache(max_sessions=256)`: `get(sid) -> set | None` (copy), `put(sid, ids)`, `add(sid, ids)` (no-op when sid absent), `clear()`
  - `LEDGER_CACHE: LedgerCache` module singleton

- [ ] **Step 1: Write the failing tests**

```python
#!/usr/bin/env python3
"""Tests for ct_ledger.py — ct-fact markers + transcript-derived ledger.

Run: python3 -m unittest tests.test_ct_ledger -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import ct_ledger  # noqa: E402


class TestIdsAndMarkers(unittest.TestCase):
    def test_valid_ids(self):
        for good in ("fact_0123456789abcdef01234567", "a", "x.y:z-1", "A" * 128):
            self.assertTrue(ct_ledger.valid_id(good), good)

    def test_invalid_ids(self):
        for bad in ("", "a b", "a/b", "A" * 129, None, 7, "a\n"):
            self.assertFalse(ct_ledger.valid_id(bad), repr(bad))

    def test_marker_format(self):
        self.assertEqual(ct_ledger.marker("fact_1"), "<!-- ct-fact:fact_1 -->")

    def test_strip_forged_removes_token(self):
        self.assertEqual(ct_ledger.strip_forged("x ct-fact:abc y"), "x abc y")

    def test_strip_forged_splice_is_stable(self):
        # one pass would splice a fresh token together
        self.assertEqual(ct_ledger.strip_forged("ct-fct-fact:act:"), "")
        self.assertNotIn("ct-fact:", ct_ledger.strip_forged("ct-fact:ct-fact:x"))

    def test_scan_ids_ordered_unique(self):
        text = "a <!-- ct-fact:a1 --> b ct-fact:b2, ct-fact:a1 -->"
        self.assertEqual(ct_ledger.scan_ids(text), ["a1", "b2"])

    def test_scan_ids_non_str(self):
        self.assertEqual(ct_ledger.scan_ids(None), [])


class TestHistoryIds(unittest.TestCase):
    HISTORY = [
        {"role": "user", "content": "hi <!-- ct-fact:u1 -->"},
        {"role": "tool", "content": '{"result": "x\\n<!-- ct-fact:t1 -->"}'},
        {"role": "user", "content": [{"type": "text", "text": "ct-fact:u2"}]},
        {"role": "user", "content": "clean", "api_content": "clean\n\n<!-- ct-fact:u3 -->"},
        "not-a-message",
        {"role": "assistant", "content": None},
    ]

    def test_all_roles_most_recent_first(self):
        self.assertEqual(ct_ledger.history_ids(self.HISTORY), ["u3", "u2", "t1", "u1"])

    def test_role_filter(self):
        self.assertEqual(
            ct_ledger.history_ids(self.HISTORY, roles=("user",)), ["u3", "u2", "u1"]
        )

    def test_empty_and_none(self):
        self.assertEqual(ct_ledger.history_ids([]), [])
        self.assertEqual(ct_ledger.history_ids(None), [])


class TestLedgerCache(unittest.TestCase):
    def test_put_get_returns_copy(self):
        c = ct_ledger.LedgerCache()
        c.put("s", {"a"})
        got = c.get("s")
        got.add("b")
        self.assertEqual(c.get("s"), {"a"})

    def test_get_missing_is_none(self):
        self.assertIsNone(ct_ledger.LedgerCache().get("nope"))

    def test_add_only_when_present(self):
        c = ct_ledger.LedgerCache()
        c.add("s", ["a"])
        self.assertIsNone(c.get("s"))
        c.put("s", set())
        c.add("s", ["a", "b"])
        self.assertEqual(c.get("s"), {"a", "b"})

    def test_lru_eviction(self):
        c = ct_ledger.LedgerCache(max_sessions=2)
        c.put("a", set())
        c.put("b", set())
        c.get("a")  # touch
        c.put("c", set())
        self.assertIsNotNone(c.get("a"))
        self.assertIsNone(c.get("b"))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd integrations/hermes && python3 -m unittest tests.test_ct_ledger -v`
Expected: `ModuleNotFoundError: No module named 'ct_ledger'`

- [ ] **Step 3: Implement**

```python
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
```

- [ ] **Step 4: Run tests — PASS**

Run: `cd integrations/hermes && python3 -m unittest tests.test_ct_ledger -v`
Expected: all tests OK.

- [ ] **Step 5: Lint + commit**

```bash
ruff check --select E9,F63,F7,F82,F401 integrations/hermes
git add integrations/hermes/scripts/ct_ledger.py integrations/hermes/tests/test_ct_ledger.py
git commit -m "feat(hermes): ct_ledger — ct-fact markers and transcript-derived ledger

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: v1 bootstrap block carries fact ids

**Files:**
- Modify: `integrations/hermes/scripts/ct_wisdom.py` (`_sanitize` ~281, `recall_wiki` ~227-268, `render_block` ~306-347, `WisdomMemo` ~356-416, new `bootstrap_block`)
- Test: `integrations/hermes/tests/test_ct_wisdom.py`

**Interfaces:**
- Consumes: `ct_ledger.valid_id`, `ct_ledger.marker`, `ct_ledger.strip_forged` (Task 1).
- Produces:
  - `recall_wiki(ct_path, query)` success entries are now `[(title, text, fact_id), ...]`; items without a valid `id` are dropped.
  - `render_block(entries)` accepts 2-tuples (no marker, legacy/tests) or 3-tuples (marker appended to the title line: `**{title}** <!-- ct-fact:{id} -->`).
  - `WisdomMemo.last_block(session_id) -> str | None` — the last block `render_for` returned for that id in this process (memoized or not), `None` if never rendered here.
  - `bootstrap_block(session_id) -> str | None` — `_MODULE_MEMO.last_block(session_id)`.

- [ ] **Step 1: Update the three v1 recall fixtures and add new failing tests**

In `TestRecallWiki`, replace the three tests at `tests/test_ct_wisdom.py:388-418` with:

```python
    def test_success_parses_wiki_tuples(self):
        self._patch_run(
            self._ok(
                {"wiki": [
                    {"id": "fact_1", "title": "T1", "text": "X1"},
                    {"id": "fact_2", "title": "T2", "text": "X2"},
                ]}
            )
        )
        entries, cls = ct_wisdom.recall_wiki(self.CT, SEED)
        self.assertEqual(entries, [("T1", "X1", "fact_1"), ("T2", "X2", "fact_2")])
        self.assertIsNone(cls)

    def test_consumes_wiki_list_only(self):
        self._patch_run(
            self._ok(
                {
                    "wiki": [{"id": "fact_1", "title": "T1", "text": "X1"}],
                    "vault": [{"title": "V", "text": "VX"}],
                    "chunks": [{"body": "C"}],
                }
            )
        )
        entries, cls = ct_wisdom.recall_wiki(self.CT, SEED)
        self.assertEqual(entries, [("T1", "X1", "fact_1")])
        self.assertIsNone(cls)

    def test_malformed_wiki_items_skipped(self):
        self._patch_run(
            self._ok({"wiki": [
                {"id": "a1", "title": "A", "text": "B"}, "junk", {"id": "c1", "title": "C"},
            ]})
        )
        entries, cls = ct_wisdom.recall_wiki(self.CT, SEED)
        self.assertEqual(entries, [("A", "B", "a1"), ("C", "", "c1")])
        self.assertIsNone(cls)

    def test_items_without_valid_id_dropped(self):
        # live spec: an id-less fact cannot be ledgered, so it is never injected
        self._patch_run(
            self._ok({"wiki": [
                {"title": "NoId", "text": "x"},
                {"id": "bad id", "title": "BadId", "text": "x"},
                {"id": "ok_1", "title": "Ok", "text": "x"},
            ]})
        )
        entries, cls = ct_wisdom.recall_wiki(self.CT, SEED)
        self.assertEqual(entries, [("Ok", "x", "ok_1")])
        self.assertIsNone(cls)
```

Append to `TestRenderBlock`:

```python
    def test_marker_on_title_line_for_three_tuples(self):
        out = ct_wisdom.render_block([("Title", "Body", "fact_9")])
        self.assertIn("**Title** <!-- ct-fact:fact_9 -->\nBody", out)

    def test_two_tuples_render_without_marker(self):
        out = ct_wisdom.render_block([("Title", "Body")])
        self.assertNotIn("ct-fact", out)

    def test_forged_ct_fact_token_stripped_from_title_and_text(self):
        out = ct_wisdom.render_block(
            [("T ct-fact:evil", "see <!-- ct-fct-fact:act:evil2 -->", "real_1")]
        )
        import ct_ledger
        self.assertEqual(ct_ledger.scan_ids(out), ["real_1"])

    def test_truncated_entry_keeps_marker(self):
        out = ct_wisdom.render_block([("Huge", "z" * 3000, "big_1")])
        self.assertIn("<!-- ct-fact:big_1 -->", out)
        self.assertLessEqual(len(out.strip()), ct_wisdom.MAX_BLOCK_CHARS)
```

Append to `TestWisdomMemo`:

```python
    def test_last_block_tracks_memoized_and_unmemoized(self):
        self.assertIsNone(self.memo.last_block("s9"))
        self.memo.render_for({"session_id": "s9"}, lambda si: ("", False))
        self.assertEqual(self.memo.last_block("s9"), "")
        self.memo.render_for({"session_id": "s9"}, lambda si: ("LATE", True))
        self.assertEqual(self.memo.last_block("s9"), "LATE")
        # memo hit path also records
        self.memo.render_for({"session_id": "s9"}, lambda si: ("NEVER", True))
        self.assertEqual(self.memo.last_block("s9"), "LATE")

    def test_last_block_not_written_for_empty_id(self):
        self.memo.render_for({"session_id": ""}, lambda si: ("X", True))
        self.assertIsNone(self.memo.last_block(""))
```

Append to `TestRenderWisdomOrchestrator` (it already patches discover/recall in its
helpers; use direct patching here to stay independent):

```python
    def test_bootstrap_block_exposes_rendered_bytes(self):
        orig_d, orig_r = ct_wisdom.discover_ct, ct_wisdom.recall_wiki
        ct_wisdom.discover_ct = lambda env=None: ("/fake/ct", None)
        ct_wisdom.recall_wiki = lambda p, q: ([("T", "x", "fact_b1")], None)
        self.addCleanup(setattr, ct_wisdom, "discover_ct", orig_d)
        self.addCleanup(setattr, ct_wisdom, "recall_wiki", orig_r)
        block = ct_wisdom._render_wisdom({"session_id": "boot-expose-1"})
        self.assertEqual(ct_wisdom.bootstrap_block("boot-expose-1"), block)
        self.assertIn("<!-- ct-fact:fact_b1 -->", block)
        self.assertIsNone(ct_wisdom.bootstrap_block("boot-never-rendered"))
```

- [ ] **Step 2: Run to verify failure**

Run: `cd integrations/hermes && python3 -m unittest tests.test_ct_wisdom -v`
Expected: the new/updated tests FAIL (2-tuples returned, no `last_block`, no `bootstrap_block`).

- [ ] **Step 3: Implement**

At the top of `ct_wisdom.py`, after `from collections.abc import Mapping`:

```python
import ct_ledger
```

In the module docstring "Sanitization order" bullet, prepend: `(0) strip every
\`ct-fact:\` token until stable (live-delivery spec — a fact must not forge a ledger
entry);`.

`_sanitize` — first statement after the `isinstance` coercion:

```python
    value = ct_ledger.strip_forged(value)
```

`recall_wiki` — docstring success line becomes
`([(title, text, fact_id), ...], None) — success (items without a valid id dropped)`,
and the loop becomes:

```python
    entries = []
    for item in data["wiki"]:
        if not isinstance(item, dict):
            continue
        fact_id = item.get("id")
        if not ct_ledger.valid_id(fact_id):
            logger.debug("wisdom: wiki item without a valid id dropped")
            continue
        title = item.get("title")
        text = item.get("text")
        entries.append(
            (
                title if isinstance(title, str) else "",
                text if isinstance(text, str) else "",
                fact_id,
            )
        )
    return entries, None
```

`render_block` — replace `for title, text in entries:` and the `title_line` assignment:

```python
    for entry in entries:
        title, text = entry[0], entry[1]
        fact_id = entry[2] if len(entry) > 2 else None
        clean_title = _sanitize(title).strip()
        clean_text = _sanitize(text)
        if not clean_title and not clean_text.strip():
            continue  # no usable content: do not burn a k=3 slot on "****\n"
        title_line = "**%s**" % clean_title
        if ct_ledger.valid_id(fact_id):
            title_line += " " + ct_ledger.marker(fact_id)
```

(the rest of the loop is unchanged — it already budgets with `len(title_line)`).

`WisdomMemo.__init__` — add `self._last = OrderedDict()`. Add method and wire it into
`render_for`:

```python
    def _remember(self, sid, block):
        with self._lock:
            self._last[sid] = block
            self._last.move_to_end(sid)
            while len(self._last) > self._max:
                self._last.popitem(last=False)

    def last_block(self, session_id):
        """Last block render_for returned for this id in THIS process
        (memoized or not); None if never rendered here. The live hook reads
        bootstrap fact ids from it (live spec, "Ledger")."""
        with self._lock:
            return self._last.get(session_id)
```

In `render_for`: on the cache-hit path, call `self._remember(sid, cached)` before
`return cached`; on the raising-`recall_fn` path call `self._remember(sid, "")` before
`return ""`; and call `self._remember(sid, block)` just before the final `return block`.

After `_MODULE_MEMO = WisdomMemo()`:

```python
def bootstrap_block(session_id):
    """The bootstrap block this process last rendered for session_id, or None."""
    return _MODULE_MEMO.last_block(session_id)
```

- [ ] **Step 4: Run the whole suite — PASS**

Run: `cd integrations/hermes && python3 -m unittest discover -s tests -v`
Expected: all OK (including the pre-existing render/memo/orchestrator/wiring tests,
which use 2-tuples and stay valid).

- [ ] **Step 5: Lint + commit**

```bash
ruff check --select E9,F63,F7,F82,F401 integrations/hermes
git add integrations/hermes/scripts/ct_wisdom.py integrations/hermes/tests/test_ct_wisdom.py
git commit -m "feat(hermes): v1 wisdom block carries ct-fact id markers; bootstrap_block accessor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `ct_wisdom_live.py` — subprocess layer (capability, match, breaker)

**Files:**
- Create: `integrations/hermes/scripts/ct_wisdom_live.py`
- Test: `integrations/hermes/tests/test_ct_wisdom_live.py`

**Interfaces:**
- Consumes: `ct_wisdom.PROBE_TIMEOUT`, `ct_ledger.valid_id`.
- Produces:
  - `has_match_capability(ct_path) -> True | False | None` (memoized True/False per path; `None` = probe timeout/spawn, not memoized); `reset_capability_cache()`
  - `match_wisdom(ct_path, text, max_n, exclude) -> (result | None, failure_class | None)`, `result = {"entries": [item], "corrections": [item]}`, `item = {"id", "title", "text", "supersedes": [ids], "provenance": str | None}`; classes `"timeout" | "spawn" | "exit" | "parse_error"`
  - `class Breaker(fails=BREAKER_FAILS, pause=BREAKER_PAUSE, clock=time.monotonic)`: `is_open()`, `record_failure()`, `record_success()`; module `_BREAKER`

- [ ] **Step 1: Write the failing tests**

```python
#!/usr/bin/env python3
"""Tests for ct_wisdom_live.py — relevance-timed mid-session delivery.

Behavior tests patch `ct_wisdom_live.subprocess.run` (same pattern as
test_ct_wisdom.SubprocessPatchMixin) so they run on every OS.

Run: python3 -m unittest tests.test_ct_wisdom_live -v
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import ct_ledger  # noqa: E402
import ct_wisdom  # noqa: E402
import ct_wisdom_live  # noqa: E402

CT = "/fake/ct"


def _item(fid, title="T", text="x", supersedes=None, provenance="human-verified"):
    return {"id": fid, "title": title, "text": text, "score": 0.9,
            "supersedes": supersedes or [], "provenance": provenance}


class RunPatch:
    def _patch_run(self, handler):
        orig = ct_wisdom_live.subprocess.run
        ct_wisdom_live.subprocess.run = handler
        self.addCleanup(setattr, ct_wisdom_live.subprocess, "run", orig)

    def _ok(self, payload, seen=None):
        def handler(cmd, *a, **k):
            if seen is not None:
                seen.append((cmd, k))
            return subprocess.CompletedProcess(cmd, 0, json.dumps(payload).encode(), b"")
        return handler


class TestCapability(unittest.TestCase, RunPatch):
    def setUp(self):
        ct_wisdom_live.reset_capability_cache()
        self.addCleanup(ct_wisdom_live.reset_capability_cache)

    def test_exit_zero_is_capable_and_memoized(self):
        calls = []

        def handler(cmd, *a, **k):
            calls.append(cmd)
            return subprocess.CompletedProcess(cmd, 0, b"usage", b"")

        self._patch_run(handler)
        self.assertTrue(ct_wisdom_live.has_match_capability(CT))
        self.assertTrue(ct_wisdom_live.has_match_capability(CT))
        self.assertEqual(calls, [[CT, "wisdom", "match", "--help"]])

    def test_nonzero_is_incapable_and_memoized(self):
        self._patch_run(lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 2, b"", b"no"))
        self.assertFalse(ct_wisdom_live.has_match_capability(CT))
        self._patch_run(lambda cmd, *a, **k: self.fail("must be memoized"))
        self.assertFalse(ct_wisdom_live.has_match_capability(CT))

    def test_timeout_is_none_not_memoized(self):
        def boom(cmd, *a, **k):
            raise subprocess.TimeoutExpired(cmd, 3)

        self._patch_run(boom)
        self.assertIsNone(ct_wisdom_live.has_match_capability(CT))
        self._patch_run(lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 0, b"", b""))
        self.assertTrue(ct_wisdom_live.has_match_capability(CT))


class TestMatchWisdom(unittest.TestCase, RunPatch):
    def test_argv_and_subprocess_contract(self):
        seen = []
        self._patch_run(self._ok({"entries": [], "corrections": []}, seen))
        ct_wisdom_live.match_wisdom(CT, "-weird query", 2, ["-a1", "b2"])
        cmd, kwargs = seen[0]
        self.assertEqual(
            cmd,
            [CT, "wisdom", "match", "--json", "--max", "2",
             "--exclude=-a1", "--exclude=b2", "--", "-weird query"],
        )
        self.assertIs(kwargs["stdin"], subprocess.DEVNULL)
        self.assertTrue(kwargs["capture_output"])
        self.assertEqual(kwargs["timeout"], ct_wisdom_live.LIVE_TIMEOUT)
        self.assertEqual(kwargs["cwd"], os.path.expanduser("~"))
        self.assertNotIn("shell", kwargs)

    def test_success_normalizes_items(self):
        self._patch_run(self._ok({
            "entries": [_item("e1"), {"id": "bad id"}, "junk",
                        {"id": "e2", "title": 5, "supersedes": ["ok", "bad id"],
                         "provenance": " "}],
            "corrections": [_item("c1", supersedes=["e0"])],
        }))
        result, cls = ct_wisdom_live.match_wisdom(CT, "q", 2, [])
        self.assertIsNone(cls)
        self.assertEqual([i["id"] for i in result["entries"]], ["e1", "e2"])
        self.assertEqual(result["entries"][1],
                         {"id": "e2", "title": "", "text": "", "supersedes": ["ok"],
                          "provenance": None})
        self.assertEqual(result["corrections"][0]["supersedes"], ["e0"])

    def test_missing_lists_default_empty(self):
        self._patch_run(self._ok({"schema": 1}))
        result, cls = ct_wisdom_live.match_wisdom(CT, "q", 2, [])
        self.assertEqual(result, {"entries": [], "corrections": []})
        self.assertIsNone(cls)

    def test_failure_classes(self):
        def timeout(cmd, *a, **k):
            raise subprocess.TimeoutExpired(cmd, 3)

        def spawn(cmd, *a, **k):
            raise OSError("gone")

        cases = [
            (timeout, "timeout"),
            (spawn, "spawn"),
            (lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 1, b"", b""), "exit"),
            (lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 0, b"not json", b""), "parse_error"),
            (lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 0, b"[]", b""), "parse_error"),
            (lambda cmd, *a, **k: subprocess.CompletedProcess(cmd, 0, b'{"entries": {}}', b""), "parse_error"),
        ]
        for handler, expected in cases:
            self._patch_run(handler)
            result, cls = ct_wisdom_live.match_wisdom(CT, "q", 2, [])
            self.assertIsNone(result)
            self.assertEqual(cls, expected)


class TestBreaker(unittest.TestCase):
    def test_opens_after_n_failures_and_closes_after_pause(self):
        now = [100.0]
        b = ct_wisdom_live.Breaker(fails=3, pause=300, clock=lambda: now[0])
        b.record_failure()
        b.record_failure()
        self.assertFalse(b.is_open())
        b.record_failure()
        self.assertTrue(b.is_open())
        now[0] += 299
        self.assertTrue(b.is_open())
        now[0] += 1
        self.assertFalse(b.is_open())
        b.record_failure()
        self.assertFalse(b.is_open())  # count reset on close

    def test_success_resets_count(self):
        b = ct_wisdom_live.Breaker(fails=2, pause=10, clock=lambda: 0.0)
        b.record_failure()
        b.record_success()
        b.record_failure()
        self.assertFalse(b.is_open())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd integrations/hermes && python3 -m unittest tests.test_ct_wisdom_live -v`
Expected: `ModuleNotFoundError: No module named 'ct_wisdom_live'`

- [ ] **Step 3: Implement (first half of the module)**

```python
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
```


- [ ] **Step 4: Run tests — PASS**

Run: `cd integrations/hermes && python3 -m unittest tests.test_ct_wisdom_live -v`
Expected: all OK.

- [ ] **Step 5: Lint + commit**

```bash
ruff check --select E9,F63,F7,F82,F401 integrations/hermes
```

```bash
git add integrations/hermes/scripts/ct_wisdom_live.py integrations/hermes/tests/test_ct_wisdom_live.py
git commit -m "feat(hermes): ct_wisdom_live subprocess layer — capability probe, match_wisdom, breaker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `ct_wisdom_live.py` — ledger, render, `pre_llm_call` hook

**Files:**
- Modify: `integrations/hermes/scripts/ct_wisdom_live.py` (append)
- Test: `integrations/hermes/tests/test_ct_wisdom_live.py` (append)

**Interfaces:**
- Consumes: Task 1 (`ct_ledger.*`, `LEDGER_CACHE`), Task 2 (`ct_wisdom.bootstrap_block`, `ct_wisdom._sanitize`, `ct_wisdom.discover_ct`, `ct_wisdom.reset_discovery_cache`), Task 3.
- Produces:
  - `bootstrap_ids(session_id, is_first_turn) -> list[str] | None` (`None` = unknowable → fail closed); `reset_session_state()`
  - `user_text(user_message) -> str`
  - `render_live_block(entries, corrections, ledger: set) -> (block: str, delivered_ids: list[str])`
  - `on_pre_llm_call(**kwargs) -> {"context": str} | None` — reads `session_id`, `user_message`, `conversation_history`, `is_first_turn`

- [ ] **Step 1: Append the failing tests**

```python
class LiveHarness(RunPatch):
    """Patches discovery + capability + match; resets all process state."""

    def setUp(self):
        ct_wisdom_live.reset_capability_cache()
        ct_wisdom_live.reset_session_state()
        ct_ledger.LEDGER_CACHE.clear()
        orig_breaker = ct_wisdom_live._BREAKER
        ct_wisdom_live._BREAKER = ct_wisdom_live.Breaker()
        self.addCleanup(setattr, ct_wisdom_live, "_BREAKER", orig_breaker)
        self.addCleanup(ct_wisdom_live.reset_capability_cache)
        self.addCleanup(ct_wisdom_live.reset_session_state)
        self.addCleanup(ct_ledger.LEDGER_CACHE.clear)
        orig_d = ct_wisdom.discover_ct
        ct_wisdom.discover_ct = lambda env=None: (CT, None)
        self.addCleanup(setattr, ct_wisdom, "discover_ct", orig_d)
        orig_c = ct_wisdom_live.has_match_capability
        ct_wisdom_live.has_match_capability = lambda p: True
        self.addCleanup(setattr, ct_wisdom_live, "has_match_capability", orig_c)
        self.calls = []
        self.reply = ({"entries": [], "corrections": []}, None)
        orig_m = ct_wisdom_live.match_wisdom

        def fake_match(path, text, max_n, exclude):
            self.calls.append({"text": text, "max_n": max_n, "exclude": list(exclude)})
            return self.reply

        ct_wisdom_live.match_wisdom = fake_match
        self.addCleanup(setattr, ct_wisdom_live, "match_wisdom", orig_m)
        orig_b = ct_wisdom.bootstrap_block
        self.boot = {}
        ct_wisdom.bootstrap_block = lambda sid: self.boot.get(sid)
        self.addCleanup(setattr, ct_wisdom, "bootstrap_block", orig_b)

    def hook(self, sid="s1", msg="how do I deploy?", history=None, first=False):
        return ct_wisdom_live.on_pre_llm_call(
            session_id=sid, user_message=msg,
            conversation_history=history or [], is_first_turn=first,
            task_id="t", turn_id="u", model="m", platform="cli",
        )


class TestBootstrapIds(LiveHarness, unittest.TestCase):
    def test_known_block_ids(self):
        self.boot["s1"] = "## h\n\n**A** <!-- ct-fact:b1 -->\nx"
        self.assertEqual(ct_wisdom_live.bootstrap_ids("s1", False), ["b1"])

    def test_first_turn_without_block_is_empty_and_remembered(self):
        self.assertEqual(ct_wisdom_live.bootstrap_ids("s2", True), [])
        self.assertEqual(ct_wisdom_live.bootstrap_ids("s2", False), [])

    def test_restored_session_unknown(self):
        self.assertIsNone(ct_wisdom_live.bootstrap_ids("s3", False))


class TestUserText(unittest.TestCase):
    def test_str_list_and_other(self):
        self.assertEqual(ct_wisdom_live.user_text("  hi  "), "hi")
        self.assertEqual(
            ct_wisdom_live.user_text([{"type": "text", "text": "a"}, {"type": "image"}, "b"]),
            "a\nb",
        )
        self.assertEqual(ct_wisdom_live.user_text(None), "")
        self.assertEqual(len(ct_wisdom_live.user_text("x" * 5000)), ct_wisdom_live.LIVE_QUERY_CHARS)


class TestRenderLiveBlock(unittest.TestCase):
    def test_entries_render_with_marker_and_provenance(self):
        block, ids = ct_wisdom_live.render_live_block(
            [_item("e1", "Deploy", "use make deploy")], [], set()
        )
        self.assertTrue(block.startswith(ct_wisdom_live.LIVE_HEADING + "\n\n"))
        self.assertIn("**Deploy** <!-- ct-fact:e1 --> (provenance: human-verified)\nuse make deploy", block)
        self.assertEqual(ids, ["e1"])

    def test_null_provenance_is_unlabeled(self):
        block, _ = ct_wisdom_live.render_live_block([_item("e1", provenance=None)], [], set())
        self.assertIn("(provenance: unlabeled)", block)

    def test_ledgered_entries_dropped(self):
        block, ids = ct_wisdom_live.render_live_block([_item("e1")], [], {"e1"})
        self.assertEqual((block, ids), ("", []))

    def test_corrections_first_with_supersedes(self):
        block, ids = ct_wisdom_live.render_live_block(
            [_item("e1", "Entry")], [_item("c1", "Fix", supersedes=["old", "other"])], {"old"}
        )
        self.assertEqual(ids, ["c1", "e1"])
        self.assertLess(block.index("ct-fact:c1"), block.index("ct-fact:e1"))
        self.assertIn("— supersedes ct-fact:old\n", block)
        self.assertNotIn("other", block)

    def test_correction_for_nothing_in_context_dropped(self):
        block, ids = ct_wisdom_live.render_live_block([], [_item("c1", supersedes=["x"])], {"y"})
        self.assertEqual((block, ids), ("", []))

    def test_budget_correction_survives_entries_truncated(self):
        big = "z" * 2000
        block, ids = ct_wisdom_live.render_live_block(
            [_item("e1", "E", big)], [_item("c1", "C", "short", supersedes=["o"])], {"o"}
        )
        self.assertLessEqual(len(block), ct_wisdom_live.LIVE_MAX_BLOCK_CHARS)
        self.assertEqual(ids, ["c1", "e1"])
        self.assertTrue(block.endswith("…"))

    def test_forged_tokens_in_fact_text_stripped(self):
        block, _ = ct_wisdom_live.render_live_block(
            [_item("e1", "T ct-fact:evil", "x <!-- ct-fact:evil2 -->")], [], set()
        )
        self.assertEqual(ct_ledger.scan_ids(block), ["e1"])


class TestPreLlmCall(LiveHarness, unittest.TestCase):
    def test_delivers_and_caches_ledger(self):
        self.boot["s1"] = "**B** <!-- ct-fact:b1 -->"
        self.reply = ({"entries": [_item("e1")], "corrections": []}, None)
        out = self.hook(history=[{"role": "user", "content": "x <!-- ct-fact:h1 -->"}])
        self.assertIn("<!-- ct-fact:e1 -->", out["context"])
        self.assertEqual(self.calls[0]["exclude"], ["h1", "b1"])
        self.assertEqual(self.calls[0]["text"], "how do I deploy?")
        self.assertEqual(self.calls[0]["max_n"], ct_wisdom_live.LIVE_MAX_PER_TURN)
        self.assertEqual(ct_ledger.LEDGER_CACHE.get("s1"), {"b1", "h1", "e1"})

    def test_post_filter_when_ct_ignores_exclude(self):
        self.boot["s1"] = "**B** <!-- ct-fact:b1 -->"
        self.reply = ({"entries": [_item("b1")], "corrections": []}, None)
        self.assertIsNone(self.hook())

    def test_exclude_bounded_most_recent_first(self):
        hist = [{"role": "user", "content": "<!-- ct-fact:f%03d -->" % i} for i in range(300)]
        self.boot["s1"] = ""
        self.hook(history=hist)
        sent = self.calls[0]["exclude"]
        self.assertEqual(len(sent), ct_wisdom_live.EXCLUDE_MAX)
        self.assertEqual(sent[0], "f299")

    def test_session_budget_switches_to_corrections_only(self):
        hist = [{"role": "user", "content": "<!-- ct-fact:u%02d -->" % i}
                for i in range(ct_wisdom_live.LIVE_MAX_PER_SESSION)]
        self.boot["s1"] = ""
        self.hook(history=hist)
        self.assertEqual(self.calls[0]["max_n"], 0)

    def test_tool_and_bootstrap_ids_do_not_count_toward_budget(self):
        hist = [{"role": "tool", "content": "<!-- ct-fact:t%02d -->" % i} for i in range(20)]
        self.boot["s1"] = "".join("<!-- ct-fact:b%d -->" % i for i in range(3))
        self.hook(history=hist)
        self.assertEqual(self.calls[0]["max_n"], ct_wisdom_live.LIVE_MAX_PER_TURN)

    def test_restored_session_fails_closed(self):
        out = self.hook(sid="restored", history=[{"role": "user", "content": "hi"}])
        self.assertIsNone(out)
        self.assertEqual(self.calls, [])
        self.assertIsNone(ct_ledger.LEDGER_CACHE.get("restored"))

    def test_first_turn_without_bootstrap_proceeds(self):
        self.reply = ({"entries": [_item("e1")], "corrections": []}, None)
        self.assertIsNotNone(self.hook(sid="fresh", first=True))

    def test_empty_session_id_noop(self):
        self.assertIsNone(self.hook(sid=""))
        self.assertEqual(self.calls, [])

    def test_empty_query_noop_but_ledger_cached(self):
        self.boot["s1"] = "<!-- ct-fact:b1 -->"
        self.assertIsNone(self.hook(msg="   "))
        self.assertEqual(self.calls, [])
        self.assertEqual(ct_ledger.LEDGER_CACHE.get("s1"), {"b1"})

    def test_capability_missing_noop(self):
        ct_wisdom_live.has_match_capability = lambda p: False
        self.boot["s1"] = ""
        self.assertIsNone(self.hook())
        self.assertEqual(self.calls, [])

    def test_breaker_opens_after_timeouts(self):
        self.boot["s1"] = ""
        self.reply = (None, "timeout")
        for _ in range(ct_wisdom_live.BREAKER_FAILS):
            self.assertIsNone(self.hook())
        self.assertIsNone(self.hook())
        self.assertEqual(len(self.calls), ct_wisdom_live.BREAKER_FAILS)

    def test_spawn_failure_resets_discovery_and_capability(self):
        self.boot["s1"] = ""
        self.reply = (None, "spawn")
        resets = []
        orig = ct_wisdom.reset_discovery_cache
        ct_wisdom.reset_discovery_cache = lambda: resets.append(1)
        self.addCleanup(setattr, ct_wisdom, "reset_discovery_cache", orig)
        self.assertIsNone(self.hook())
        self.assertEqual(resets, [1])

    def test_never_raises(self):
        def boom(*a, **k):
            raise RuntimeError("boom")

        ct_wisdom_live.match_wisdom = boom
        self.boot["s1"] = ""
        self.assertIsNone(self.hook())
```

- [ ] **Step 2: Run to verify failure**

Run: `cd integrations/hermes && python3 -m unittest tests.test_ct_wisdom_live -v`
Expected: FAIL — `AttributeError: module 'ct_wisdom_live' has no attribute 'reset_session_state'` (and the other new names).

- [ ] **Step 3: Implement (append to `ct_wisdom_live.py`)**

First add `from collections import OrderedDict` to the imports (after `import time`), then append:

```python
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
```

Note: the tests patch `ct_wisdom_live.match_wisdom` / `has_match_capability` /
`_BREAKER` as module attributes, so `_pre_llm_call` must reference them as bare module
globals (as written), not via `from ... import`.

- [ ] **Step 4: Run — PASS**

Run: `cd integrations/hermes && python3 -m unittest tests.test_ct_wisdom_live -v`
Expected: all OK.

- [ ] **Step 5: Lint + commit**

```bash
ruff check --select E9,F63,F7,F82,F401 integrations/hermes
git add integrations/hermes/scripts/ct_wisdom_live.py integrations/hermes/tests/test_ct_wisdom_live.py
git commit -m "feat(hermes): pre_llm_call live wisdom delivery — ledger rebuild, render, fail-closed restore

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `ct_tool_dedup.py` — stub repeated facts in `curated_recall_context`

**Files:**
- Create: `integrations/hermes/scripts/ct_tool_dedup.py`
- Test: `integrations/hermes/tests/test_ct_tool_dedup.py`

**Interfaces:**
- Consumes: `ct_ledger.valid_id`, `ct_ledger.marker`, `ct_ledger.LEDGER_CACHE` (Task 1).
- Produces: `RECALL_TOOL_SUFFIX = "__curated_recall_context"`; `on_transform_tool_result(**kwargs) -> str | None` — reads `tool_name`, `result`, `session_id`.

- [ ] **Step 1: Write the failing tests**

```python
#!/usr/bin/env python3
"""Tests for ct_tool_dedup.py — transform_tool_result dedup of CT recall.

Envelope (investigation Target 5 [V]): Hermes hands the hook
json.dumps({"result": "<CT JSON string>"}) for an MCP tool.

Run: python3 -m unittest tests.test_ct_tool_dedup -v
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import ct_ledger  # noqa: E402
import ct_tool_dedup  # noqa: E402

TOOL = "mcp__curated-thoughts__curated_recall_context"


def envelope(ids, extra_outer=None):
    inner = {
        "wiki_entries": [{"id": i, "title": "T" + i, "text": "body " + i} for i in ids],
        "code_chunks": [],
        "query": "q",
    }
    outer = {"result": json.dumps(inner)}
    outer.update(extra_outer or {})
    return json.dumps(outer)


def unwrap(out):
    outer = json.loads(out)
    text = outer["result"]
    inner = json.loads(text.split("\n<!-- ct-fact:")[0])
    return outer, inner, text


class TestToolDedup(unittest.TestCase):
    def setUp(self):
        ct_ledger.LEDGER_CACHE.clear()
        self.addCleanup(ct_ledger.LEDGER_CACHE.clear)

    def call(self, result, tool=TOOL, sid="s1"):
        return ct_tool_dedup.on_transform_tool_result(
            tool_name=tool, args={}, result=result, session_id=sid,
            task_id="", tool_call_id="c", turn_id="u", api_request_id="",
            duration_ms=1, status="ok", error_type=None, error_message=None,
        )

    def test_stubs_ledgered_and_trails_new(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"f1"})
        outer, inner, text = unwrap(self.call(envelope(["f1", "f2"])))
        self.assertEqual(
            inner["wiki_entries"][0],
            {"id": "f1", "in_context": True, "note": "already in context: ct-fact:f1"},
        )
        self.assertEqual(inner["wiki_entries"][1]["title"], "Tf2")
        self.assertTrue(text.endswith("\n<!-- ct-fact:f2 -->"))
        self.assertEqual(ct_ledger.LEDGER_CACHE.get("s1"), {"f1", "f2"})

    def test_other_outer_keys_preserved(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"f1"})
        outer, _inner, _ = unwrap(self.call(envelope(["f1"], {"_meta": {"k": 1}})))
        self.assertEqual(outer["_meta"], {"k": 1})

    def test_no_cache_trails_all_without_stubbing(self):
        outer, inner, text = unwrap(self.call(envelope(["f1"])))
        self.assertEqual(inner["wiki_entries"][0]["title"], "Tf1")
        self.assertIn("<!-- ct-fact:f1 -->", text)
        self.assertIsNone(ct_ledger.LEDGER_CACHE.get("s1"))

    def test_all_known_and_none_new_still_stubs(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"f1"})
        _o, inner, text = unwrap(self.call(envelope(["f1"])))
        self.assertTrue(inner["wiki_entries"][0]["in_context"])
        self.assertNotIn("\n<!-- ct-fact:", text)

    def test_pass_through_cases(self):
        ct_ledger.LEDGER_CACHE.put("s1", {"f1"})
        cases = [
            (envelope(["f1"]), "mcp__curated-thoughts__curated_get_wiki_entry"),
            (envelope(["f1"]), "terminal"),
            ("not json", TOOL),
            (json.dumps({"error": "boom"}), TOOL),
            (json.dumps({"result": "truncated {not json"}), TOOL),
            (json.dumps({"result": json.dumps({"no_wiki": []})}), TOOL),
            (envelope([]), TOOL),
            (None, TOOL),
        ]
        for result, tool in cases:
            self.assertIsNone(self.call(result, tool=tool), (tool, result))

    def test_invalid_ids_left_alone(self):
        result = json.dumps({"result": json.dumps({"wiki_entries": [{"id": "bad id"}]})})
        self.assertIsNone(self.call(result))

    def test_never_raises(self):
        self.assertIsNone(ct_tool_dedup.on_transform_tool_result())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd integrations/hermes && python3 -m unittest tests.test_ct_tool_dedup -v`
Expected: `ModuleNotFoundError: No module named 'ct_tool_dedup'`

- [ ] **Step 3: Implement**

```python
#!/usr/bin/env python3
"""ct_tool_dedup.py — exactly-once for agent-initiated CT recall (Hermes).

Spec: docs/superpowers/specs/2026-10-06-intuitive-wisdom-live-delivery-design.md
("transform_tool_result hook"). For `curated_recall_context` results only
(`curated_get_wiki_entry` carries no wiki ids): a wiki entry whose id is
already in this session's context is replaced by a one-line stub (option A —
the agent still sees the hit), and every newly seen id gets a trailing
`<!-- ct-fact:<id> -->` marker so the next turn's ledger scan finds it.

Envelope (investigation Target 5 [V]): the hook receives
json.dumps({"result": "<CT JSON>", ...optional keys}). Anything else — tool
errors, head+tail-truncated payloads, other tools — passes through
unmodified (return None). Never raises.
"""

from __future__ import annotations

import json
import logging

import ct_ledger

logger = logging.getLogger(__name__)

RECALL_TOOL_SUFFIX = "__curated_recall_context"


def on_transform_tool_result(**kwargs):
    """Hermes `transform_tool_result` callback: str replaces the result, None keeps it."""
    try:
        return _transform(
            kwargs.get("tool_name"), kwargs.get("result"), kwargs.get("session_id")
        )
    except Exception:
        logger.debug("wisdom-live: tool dedup failed", exc_info=True)
        return None


def _stub(fact_id):
    return {"id": fact_id, "in_context": True,
            "note": "already in context: ct-fact:%s" % fact_id}


def _transform(tool_name, result, session_id):
    if not isinstance(tool_name, str) or not tool_name.endswith(RECALL_TOOL_SUFFIX):
        return None
    if not isinstance(result, str):
        return None
    try:
        outer = json.loads(result)
    except ValueError:
        return None
    if not isinstance(outer, dict) or not isinstance(outer.get("result"), str):
        return None
    try:
        inner = json.loads(outer["result"])
    except ValueError:
        return None
    if not isinstance(inner, dict) or not isinstance(inner.get("wiki_entries"), list):
        return None

    has_sid = isinstance(session_id, str) and bool(session_id)
    ledger = ct_ledger.LEDGER_CACHE.get(session_id) if has_sid else None
    rewritten = []
    new_ids = []
    stubbed = 0
    for entry in inner["wiki_entries"]:
        fact_id = entry.get("id") if isinstance(entry, dict) else None
        if not ct_ledger.valid_id(fact_id):
            rewritten.append(entry)
        elif ledger is not None and fact_id in ledger:
            rewritten.append(_stub(fact_id))
            stubbed += 1
        else:
            rewritten.append(entry)
            if fact_id not in new_ids:
                new_ids.append(fact_id)
    if not stubbed and not new_ids:
        return None

    inner["wiki_entries"] = rewritten
    if ledger is not None:
        ct_ledger.LEDGER_CACHE.add(session_id, new_ids)
    trailer = "".join("\n" + ct_ledger.marker(fact_id) for fact_id in new_ids)
    outer["result"] = json.dumps(inner, ensure_ascii=False) + trailer
    logger.debug("wisdom-live: tool dedup session=%s stubbed=%d new=%d",
                 session_id or "<empty>", stubbed, len(new_ids))
    return json.dumps(outer, ensure_ascii=False)
```

- [ ] **Step 4: Run — PASS**

Run: `cd integrations/hermes && python3 -m unittest tests.test_ct_tool_dedup -v`
Expected: all OK.

- [ ] **Step 5: Lint + commit**

```bash
ruff check --select E9,F63,F7,F82,F401 integrations/hermes
git add integrations/hermes/scripts/ct_tool_dedup.py integrations/hermes/tests/test_ct_tool_dedup.py
git commit -m "feat(hermes): transform_tool_result stubs facts already in context (curated_recall_context)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Exactly-once property test (INTENT workflow rule 5)

**Files:**
- Test: `integrations/hermes/tests/test_exactly_once.py`

**Interfaces:**
- Consumes: `ct_wisdom._render_wisdom`, `ct_wisdom._MODULE_MEMO`, `ct_wisdom_live.on_pre_llm_call`, `ct_tool_dedup.on_transform_tool_result`, `ct_ledger.LEDGER_CACHE`.

The simulator models the host order verified in the investigation: system prompt built
first (`turn_context.py:1123`), then in-place compaction at turn start, then
`pre_llm_call` (`:1160`), then 0-2 tool calls in the turn. A fact counts as "fully
present" when its title-line marker `<!-- ct-fact:<id> -->` appears in the system block
or a user message, or a non-stub `wiki_entries` item with that id appears in a tool
result. The fake CT deliberately ignores `--exclude` half the time to exercise the
post-filter.

- [ ] **Step 1: Write the test**

```python
#!/usr/bin/env python3
"""Exactly-once property test across randomized sessions (INTENT workflow 5).

Run: python3 -m unittest tests.test_exactly_once -v
"""

from __future__ import annotations

import json
import random
import sys
import unittest
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import ct_ledger  # noqa: E402
import ct_tool_dedup  # noqa: E402
import ct_wisdom  # noqa: E402
import ct_wisdom_live  # noqa: E402

UNIVERSE = ["fact_%02d" % i for i in range(16)]
TOOL = "mcp__curated-thoughts__curated_recall_context"
SESSIONS = 200


def item(fid, supersedes=None):
    return {"id": fid, "title": "T" + fid, "text": "body " + fid,
            "supersedes": supersedes or [], "provenance": None}


def present_counts(system_block, history):
    counts = Counter()
    for fid in ct_ledger.scan_ids(system_block):
        counts[fid] += system_block.count(ct_ledger.marker(fid) + "\n")
    for msg in history:
        if msg["role"] == "user":
            text = msg.get("api_content") or msg["content"]
            for fid in UNIVERSE:
                # title-line marker is followed by " (provenance:" in live blocks
                counts[fid] += text.count(ct_ledger.marker(fid) + " (provenance:")
        elif msg["role"] == "tool":
            outer = json.loads(msg["content"])
            inner = json.loads(outer["result"].split("\n<!-- ct-fact:")[0])
            for entry in inner["wiki_entries"]:
                if not entry.get("in_context"):
                    counts[entry["id"]] += 1
    return counts


class TestExactlyOnce(unittest.TestCase):
    def setUp(self):
        ct_wisdom_live.reset_capability_cache()
        ct_wisdom_live.reset_session_state()
        ct_ledger.LEDGER_CACHE.clear()
        orig_breaker = ct_wisdom_live._BREAKER
        ct_wisdom_live._BREAKER = ct_wisdom_live.Breaker(fails=10 ** 9)
        self.addCleanup(setattr, ct_wisdom_live, "_BREAKER", orig_breaker)
        for mod, name, value in [
            (ct_wisdom, "discover_ct", lambda env=None: ("/fake/ct", None)),
            (ct_wisdom_live, "has_match_capability", lambda p: True),
        ]:
            orig = getattr(mod, name)
            setattr(mod, name, value)
            self.addCleanup(setattr, mod, name, orig)
        self.addCleanup(ct_ledger.LEDGER_CACHE.clear)
        self.addCleanup(ct_wisdom_live.reset_session_state)

    def test_no_fact_twice_in_current_context(self):
        rng = random.Random(20261006)
        orig_recall = ct_wisdom.recall_wiki
        orig_match = ct_wisdom_live.match_wisdom
        self.addCleanup(setattr, ct_wisdom, "recall_wiki", orig_recall)
        self.addCleanup(setattr, ct_wisdom_live, "match_wisdom", orig_match)

        def fake_match(path, text, max_n, exclude):
            pool = UNIVERSE if rng.random() < 0.5 else [f for f in UNIVERSE if f not in exclude]
            entries = [item(f) for f in rng.sample(pool, min(len(pool), max_n))]
            corrections = []
            if exclude and rng.random() < 0.3:
                corrections.append(item(rng.choice(UNIVERSE), supersedes=[rng.choice(exclude)]))
            return {"entries": entries, "corrections": corrections}, None

        ct_wisdom_live.match_wisdom = fake_match

        for s in range(SESSIONS):
            sid = "prop-%d" % s
            boot = rng.sample(UNIVERSE, rng.randint(0, 3))
            ct_wisdom.recall_wiki = lambda p, q, b=boot: (
                [("T" + f, "body " + f, f) for f in b], None)
            system_block = ct_wisdom._render_wisdom({"session_id": sid})
            history = []
            for turn in range(rng.randint(1, 12)):
                if history and rng.random() < 0.15:  # in-place compaction at turn start
                    del history[: rng.randint(1, len(history))]
                out = ct_wisdom_live.on_pre_llm_call(
                    session_id=sid, user_message="question %d" % turn,
                    conversation_history=list(history), is_first_turn=(turn == 0),
                )
                content = "question %d" % turn
                msg = {"role": "user", "content": content}
                if out:
                    msg["api_content"] = content + "\n\n" + out["context"]
                history.append(msg)
                history.append({"role": "assistant", "content": "ok"})
                for _ in range(rng.randint(0, 2)):
                    ids = rng.sample(UNIVERSE, rng.randint(0, 4))
                    raw = json.dumps({"result": json.dumps({
                        "wiki_entries": [{"id": f, "title": "T" + f, "text": "body " + f} for f in ids],
                        "code_chunks": [], "query": "q"})})
                    new = ct_tool_dedup.on_transform_tool_result(
                        tool_name=TOOL, result=raw, session_id=sid)
                    history.append({"role": "tool", "content": new or raw})
                    counts = present_counts(system_block, history)
                    dupes = {f: n for f, n in counts.items() if n > 1}
                    self.assertEqual(dupes, {}, "session %s turn %d" % (sid, turn))
                counts = present_counts(system_block, history)
                dupes = {f: n for f, n in counts.items() if n > 1}
                self.assertEqual(dupes, {}, "session %s turn %d" % (sid, turn))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run — expect PASS on first run** (Tasks 1-5 implement the behavior;
this test is the invariant gate)

Run: `cd integrations/hermes && python3 -m unittest tests.test_exactly_once -v`
Expected: OK. If it fails, it prints the session/turn and duplicated ids — debug with
superpowers:systematic-debugging; do NOT weaken the assertion.

- [ ] **Step 3: Mutation check (prove the test bites).** Temporarily change
`render_live_block`'s `if item["id"] in seen: continue` (entries loop) to `pass`; run
the test; expect FAIL. Revert. Do the same for the `ledger is not None and fact_id in
ledger` branch in `ct_tool_dedup._transform`; expect FAIL; revert.

- [ ] **Step 4: Commit**

```bash
git add integrations/hermes/tests/test_exactly_once.py
git commit -m "test(hermes): randomized exactly-once property test across bootstrap, live and tool paths

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Register the hooks in `__init__.py`

**Files:**
- Modify: `integrations/hermes/__init__.py` (module docstring; new callbacks after `_wisdom_prompt_section`; `register`)
- Test: `integrations/hermes/tests/test_ct_wisdom.py` (`TestPluginWiring`)

**Interfaces:**
- Consumes: `ct_wisdom_live.on_pre_llm_call`, `ct_tool_dedup.on_transform_tool_result`.
- Produces: hooks `pre_llm_call` → `_pre_llm_call`, `transform_tool_result` → `_transform_tool_result`.

- [ ] **Step 1: Append failing wiring tests to `TestPluginWiring`**

```python
    def _hooks(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "ct_plugin_under_test3", INTEGRATION / "__init__.py"
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        ctx = _StubCtx()
        mod.register(ctx)
        return dict(ctx.hooks)

    def test_registers_live_hooks(self):
        hooks = self._hooks()
        self.assertIn("on_session_start", hooks)
        self.assertIn("pre_llm_call", hooks)
        self.assertIn("transform_tool_result", hooks)

    def test_live_hooks_fail_open(self):
        hooks = self._hooks()
        self.assertIsNone(hooks["pre_llm_call"](session_id=""))
        self.assertIsNone(hooks["transform_tool_result"](tool_name="terminal", result="x"))

    def test_hook_registration_error_does_not_break_register(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "ct_plugin_under_test4", INTEGRATION / "__init__.py"
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        ctx = _StubCtx()

        def bad_register(name, fn):
            if name != "on_session_start":
                raise ValueError("unknown hook")
            ctx.hooks.append((name, fn))

        ctx.register_hook = bad_register
        mod.register(ctx)  # must not raise
        self.assertEqual(
            sorted(s for s, _f, _m in ctx.sections),
            ["curated-thoughts", "curated-thoughts-wisdom"],
        )
```

- [ ] **Step 2: Run to verify failure**

Run: `cd integrations/hermes && python3 -m unittest tests.test_ct_wisdom.TestPluginWiring -v`
Expected: `test_registers_live_hooks` FAILS (`pre_llm_call` missing).

- [ ] **Step 3: Implement**

Module docstring: after the bullet about the system-prompt section, add:

```
  * a `pre_llm_call` hook that delivers wisdom facts relevant to the current
    user turn (ct_wisdom_live), and a `transform_tool_result` hook that keeps
    agent-initiated CT recall from repeating a fact already in context
    (ct_tool_dedup) — the Intuitive Wisdom live path;
```

After `_wisdom_prompt_section`:

```python
def _pre_llm_call(**kwargs):
    """Relevance-timed wisdom for this user turn (ct_wisdom_live, imported
    lazily so an import problem can never take down registration)."""
    try:
        import ct_wisdom_live

        return ct_wisdom_live.on_pre_llm_call(**kwargs)
    except Exception:  # pragma: no cover - defensive
        logger.debug("curated-thoughts: live wisdom hook failed", exc_info=True)
        return None


def _transform_tool_result(**kwargs):
    """Stub CT recall entries already in context (ct_tool_dedup)."""
    try:
        import ct_tool_dedup

        return ct_tool_dedup.on_transform_tool_result(**kwargs)
    except Exception:  # pragma: no cover - defensive
        logger.debug("curated-thoughts: tool dedup hook failed", exc_info=True)
        return None
```

In `register(ctx)`, right after the `on_session_start` registration block:

```python
    for hook_name, callback in (
        ("pre_llm_call", _pre_llm_call),
        ("transform_tool_result", _transform_tool_result),
    ):
        try:
            ctx.register_hook(hook_name, callback)
        except Exception:  # pragma: no cover - host API variance
            logger.warning(
                "curated-thoughts: could not register %s hook", hook_name, exc_info=True
            )
```

- [ ] **Step 4: Full suite — PASS**

Run: `cd integrations/hermes && python3 -m unittest discover -s tests -v`
Expected: all OK.

- [ ] **Step 5: Lint + commit**

```bash
ruff check --select E9,F63,F7,F82,F401 integrations/hermes
git add integrations/hermes/__init__.py integrations/hermes/tests/test_ct_wisdom.py
git commit -m "feat(hermes): register pre_llm_call + transform_tool_result live wisdom hooks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Docs, INTENT amendments, version 0.4.0

**Files:**
- Modify: `INTENT.md`, `README.md` (Hermes paragraph ~lines 40-53), `integrations/hermes/CHANGELOG.md`, `integrations/hermes/plugin.yaml:8`, `integrations/hermes/integration.yaml:8`, `integrations/hermes/skills/curated-thoughts-usage/SKILL.md`, spec status line.

- [ ] **Step 1: INTENT.md — five amendments (spec "INTENT.md amendments")**

1. In "Intuitive Wisdom", replace the sentence beginning "The matching trigger, judge
   involvement, and delivery surface for mid-session relevance are **open design
   work**" through "resolve there." with:

```
The mid-session design is settled for Hermes in
`docs/superpowers/specs/2026-10-06-intuitive-wisdom-live-delivery-design.md`:
trigger = each user turn; judge = inside CT only (`ct wisdom match`, CT-owned
semantic gate); delivery = host-persisted append channels (the user-message
context and tool results); ledger = the transcript (below). Other ports fork
that design.
```

2. Same paragraph: replace "(tool results are the v1-proven channel)" with
   "(host-persisted append channels: the user-message context and tool results)".
3. Invariant 1: replace "The ledger lives in CT's session context (keyed by session
   id); CT recall tools filter against it." with:

```
The ledger is the transcript: every delivered fact carries a
`<!-- ct-fact:<id> -->` marker and the ledger is rebuilt each turn from
host-persisted context — no plugin persistence, no CT write. CT accepts the
ids as `--exclude` and returns `corrections` for superseded ones. "Anywhere
in a session's context" (scope b) means the CURRENT context: the frozen
block, user-message injections and tool results; a fact compacted out of
context may be delivered again.
```

   and delete "(Ledger ownership and the supersession marker are new work —
   pending decisions.)"; in invariant 2 replace "(mid-session delivery: pending design
   work)" with "(mid-session delivery: see the live-delivery spec)".
4. v1 step 2 "**Match:** find wisdom-layer facts via CT's recall (semantic
   similarity)." → "**Match:** find wisdom-layer facts via CT's recall (the v1 wiki
   leg is lexical term overlap; the semantic, gated path is `ct wisdom match`)."
5. "Read-only retrieval", third bullet: `(\`ct recall\` subprocess / read-only sidecar
   tools)` → `(\`ct recall\` / \`ct wisdom match\` subprocesses / read-only sidecar
   tools)`.

- [ ] **Step 2: README Hermes paragraph** — after "...simply means the block is
absent." insert:

```
Since 0.4.0, with a Curated Thoughts build that ships `ct wisdom match`, it
also delivers facts mid-session: on each user turn CT decides which wisdom
facts are relevant to the message, and any not already in context are
appended to that turn (never to the system prompt), each exactly once; a
CT recall the agent runs itself shows already-delivered facts as short
"already in context" stubs. Older CT builds keep the 0.3 behavior.
```

and extend "Known gaps:" with: "; a restored session gets no mid-session delivery
(its bootstrap facts cannot be seen from the hook), and an agent-run CT recall there can
repeat a bootstrap fact".

- [ ] **Step 3: CHANGELOG** — under `## Unreleased` add a `## 0.4.0 — <date>` section:

```
## 0.4.0 — YYYY-MM-DD

- Added: relevance-timed mid-session wisdom delivery (Intuitive Wisdom, spec
  2026-10-06-intuitive-wisdom-live-delivery-design.md). A `pre_llm_call` hook
  asks `ct wisdom match` which facts are relevant to the user's message and
  appends new ones to that turn (≤2/turn, ≤1200 chars, ≤12/session;
  corrections for superseded facts always flow). A `transform_tool_result`
  hook stubs `curated_recall_context` wiki entries already in context.
  Exactly-once is enforced by a ledger rebuilt each turn from `ct-fact:<id>`
  markers in the transcript — no plugin persistence. Requires a CT build with
  `ct wisdom match`; otherwise a silent no-op. Restored sessions fail closed.
- Changed: the bootstrap wisdom block now tags each fact with its CT id
  (`<!-- ct-fact:<id> -->`) and drops wiki entries without a valid id; the
  sanitizer strips forged `ct-fact:` tokens.
```

(the date is filled at release time — the release task replaces `YYYY-MM-DD`.)

- [ ] **Step 4: Versions** — `plugin.yaml` and `integration.yaml`: `version: 0.3.3` →
`version: 0.4.0`. Then:

Run: `python3 tools/ct_ci.py readme && python3 tools/ct_ci.py validate && python3 tools/ct_ci.py policy`
Expected: README table shows 0.4.0; validate and policy exit 0.

- [ ] **Step 5: Usage skill** — append to `skills/curated-thoughts-usage/SKILL.md`:

```markdown
## Wisdom that arrives on its own

With a recent Curated Thoughts build, facts relevant to the current message
can appear in your context under "Curated Thoughts — relevant now", each with
a provenance label. Treat `unlabeled` and agent-tier facts as unverified. A
`curated_recall_context` hit marked `"in_context": true` is a fact you
already have — don't re-fetch it. A line ending in "supersedes ct-fact:<id>"
replaces that earlier fact; stop relying on the old one.
```

Then run the skills drift check from the v1 plan (`grep -rn "relevant memory\|wisdom" integrations/hermes/skills`) and fix any wording that now contradicts the plugin.

- [ ] **Step 6: Spec status** — header `**Status:** Draft (...)` → `**Status:** Implemented <date> (PR #<n> — pending merge)`; fill `<n>` once the PR exists (Task 10).

- [ ] **Step 7: Full verification + commit**

Run: `cd integrations/hermes && python3 -m unittest discover -s tests -v && cd ../.. && ruff check --select E9,F63,F7,F82,F401 integrations/hermes && python3 tools/ct_ci.py policy`
Expected: all OK.

```bash
git add INTENT.md README.md integrations/hermes docs/superpowers/specs/2026-10-06-intuitive-wisdom-live-delivery-design.md
git commit -m "docs(hermes): 0.4.0 — live wisdom delivery; INTENT closes mid-session decisions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: e2e on the scratch profile + close O1–O3 (requires CT ≥ 3.3.0)

Task 0's CT work shipped in curated-thoughts#266 (CT 3.3.0); the shipped contract matches
the spec (see spec "As shipped"). **Scope note (2026-10-08):** this e2e proves the delivery
*mechanics* — marker, ledger, exactly-once, byte-stable replay, fail-closed. It does not
measure match quality on real messages: CT's live gate opens rarely today
(curated-thoughts#271), which is why Step 2 seeds a fact with distinctive wording. A zero-hit
on an ordinary message is expected and is not a plugin failure. Runs on the Linux machine with Hermes installed
(`~/.hermes/hermes-agent/`) and the `ct-test` scratch profile — **never** the live
default profile or the live brain (INTENT workflow 2; memory: no Ollama on the Mac).

- [ ] **Step 1: Pin the host.** Record `git -C ~/.hermes/hermes-agent log -1 --format='%h %cd'` in the investigation header; re-check the cited line numbers (`turn_context.py` `_collect_pre_llm_call_context`, `_stamp_api_content_sidecar`, `:1123`/`:1160` ordering; `model_tools.py` `_apply_transform_tool_result_hook`; `mcp_tool_handlers.py` `_render_call_tool_result`) and update any that moved.
- [ ] **Step 2: Install** the branch payload into the scratch profile: `HERMES_HOME=~/.hermes/profiles/ct-test bash integrations/hermes/scripts/install.sh` with the CT build carrying `ct wisdom match` on PATH. Seed the scratch brain with one wiki fact about a distinctive topic (e.g. "zebra-release checklist").
- [ ] **Step 3: O1** — add a temporary debug line in the hook printing `[sorted(m.keys()) for m in conversation_history]` on turn 2; record whether `api_content` is present. Remove the debug line.
- [ ] **Step 4: Delivery + exactly-once.** Turn 1: unrelated message. Turn 2: ask about the zebra-release checklist → expect one `wisdom-live: deliver` debug line and the block in the stored user row (`SessionDB.get_session` / `messages` table `api_content`). Turn 3: ask about it again → expect `class=zero_hits` (filtered), no second copy. Ask the agent to call `curated_recall_context` for it → result shows the `in_context` stub.
- [ ] **Step 5: Byte-stable replay.** Read the turn-2 user row's `api_content` before and after turn 3; assert identical bytes.
- [ ] **Step 6: O3** — induce in-place compaction (method from the v1 plan Task 7); record whether the injected bytes survive; confirm behavior matches the spec "Compaction" rule either way.
- [ ] **Step 7: Supersession.** CT fills `corrections` only from `superseded_by`, which only the engine's `supersede` writes; the Active Librarian does not yet call it for supersession deposits (CT spec "Dependency"), so `wisdom_propose_supersession` + ingest alone yields **no** correction. On the **scratch brain only**, insert a replacement row and point the delivered fact's `superseded_by` at it (or call the engine's `supersede` if a CLI path exists by then), then send another message → expect a correction line with `supersedes ct-fact:<old>`. Record which method was used. If neither is possible, record "blocked on CT Librarian supersession" and keep the unit-test coverage as the evidence.
- [ ] **Step 8: Fail-closed.** `/resume` the session in a fresh process and send a message → expect `class=restored_unknown_bootstrap`, no delivery.
- [ ] **Step 9: O2** — if MoA or `codex_app_server` mode is available in the scratch config, run one turn and record whether the context reaches the model; otherwise record "not exercised".
- [ ] **Step 10: Latency** — record p50/p95 hook wall time over 20 turns (debug timestamps); confirm well under `plugins.hook_callback_timeout` (default 30 s [V]).
- [ ] **Step 11: Record + commit.** Write results into the investigation (O1–O3 rows → resolved with [V] evidence; O2 resolved or "not exercised"), then:

```bash
git add docs/superpowers/investigations/2026-10-06-intuitive-wisdom-live-delivery-step0-investigation.md
git commit -m "docs(investigation): e2e results — O1/O2/O3 resolved on scratch profile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Review ladder and PR

- [ ] **Step 1:** Run superpowers:verification-before-completion: full suite, ruff, `tools/ct_ci.py policy` — paste outputs.
- [ ] **Step 2:** Local first pass with the `system-one-review` skill on `origin/main...HEAD`; address findings.
- [ ] **Step 3:** Dual review to convergence (GLM 5.3 + Opus) per INTENT workflow 3 — 0 BLOCKER / 0 MAJOR. Open questions park the PR.
- [ ] **Step 4:** Push and open the PR (title: `feat(hermes): Intuitive Wisdom live delivery (0.4.0)`), body links spec, investigation, plan, CT issue; ends with the Claude Code attribution line. Fill the spec status PR number (Task 8 Step 6) in a follow-up commit and push it in the same flow.
