# Hermes autonomous-work wisdom delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver at most one relevant CT fact per model step to a Hermes agent while it works on its own, keyed to the file, command or search it is busy with.

**Architecture:** A new Hermes-only module `scripts/ct_wisdom_activity.py` prefetches `ct wisdom match` at `pre_tool_call` (once per `api_request_id`, only on a new activity key) and splices one marker-first fact into the triggering call's result at `transform_tool_result`. Exactly-once across the 8 tool threads comes from a new atomic `LedgerCache.claim()` in the shared `ct_ledger.py`, which `ct_tool_dedup` also adopts.

**Tech Stack:** Python 3.9+ stdlib only, `unittest`, ruff; repo CI tool `tools/ct_ci.py`.

**Spec:** `docs/superpowers/specs/2026-10-16-hermes-autonomous-work-wisdom-design.md`

## Global Constraints

- Stdlib only; must run on Python 3.9 (no `match`, no `X | Y` types at runtime).
- `ACTIVITY_MAX_PER_STEP = 1`, `ACTIVITY_MAX_BLOCK_CHARS = 600`, `ACTIVITY_QUERY_CHARS = 300`, 3 s budget = `ct_wisdom_live.LIVE_TIMEOUT`.
- `ACTIVITY_HEADING = "## Curated Thoughts — relevant to this step"`.
- Query = bare target (A6): path / bare search pattern / program+subcommand. Never the verb, contents, output, diffs or full command lines.
- `ct_wisdom_live.py` is NOT edited (parallel verbose-mode PR).
- `ct_ledger.py` changes are copied byte-identically to `integrations/claude-code/scripts/ct_ledger.py`.
- `on_pre_tool_call` never raises and always returns `None` (Hermes blocks the tool otherwise).
- Every delivery goes through `_record_activity_delivery(event)` (no-op seam).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `integrations/hermes/scripts/ct_ledger.py` (+ claude-code copy) | add `LedgerCache.claim` |
| `integrations/hermes/scripts/ct_tool_dedup.py` | use `claim` (race-free, same output) |
| `integrations/hermes/scripts/ct_wisdom_activity.py` (new) | line builder, key/step tracker, prefetch, render, splice, hooks, seam |
| `integrations/hermes/__init__.py` | register `pre_tool_call`; compose transform (dedup, then activity) |
| `integrations/hermes/tests/test_ct_ledger.py`, `test_ct_tool_dedup.py` | claim + race tests |
| `integrations/hermes/tests/test_ct_wisdom_activity.py` (new) | unit, secret-safety, rate, fail-closed, splice, hygiene, seam |
| `integrations/hermes/tests/test_exactly_once.py` | randomized property test with activity + threads |
| `integrations/hermes/{plugin.yaml,integration.yaml,CHANGELOG.md}`, `README.md` | 0.5.0 |
| `integrations/claude-code/{integration.yaml,CHANGELOG.md,...}` | patch bump if the policy gate needs it |

---

### Task 1: Atomic `LedgerCache.claim`

**Files:**
- Modify: `integrations/hermes/scripts/ct_ledger.py` (class `LedgerCache`), then `cp` to `integrations/claude-code/scripts/ct_ledger.py`
- Test: `integrations/hermes/tests/test_ct_ledger.py`

**Interfaces:**
- Produces: `LedgerCache.claim(session_id, ids) -> list[str] | None` — ids (in input order, unique) that were not in the session's set and are now added; `None` when the session has no entry.

- [ ] **Step 1: Write the failing tests**

```python
class TestClaim(unittest.TestCase):
    def test_claim_returns_only_new_and_adds_them(self):
        c = ct_ledger.LedgerCache()
        c.put("s", {"a"})
        self.assertEqual(c.claim("s", ["a", "b", "b", "c"]), ["b", "c"])
        self.assertEqual(c.get("s"), {"a", "b", "c"})
        self.assertEqual(c.claim("s", ["b"]), [])

    def test_claim_without_entry_is_none(self):
        self.assertIsNone(ct_ledger.LedgerCache().claim("nope", ["a"]))

    def test_claim_race_each_id_won_once(self):
        c = ct_ledger.LedgerCache(); c.put("s", set())
        wins = []; barrier = threading.Barrier(8)
        def worker():
            barrier.wait()
            wins.extend(c.claim("s", ["x", "y"]))
        ts = [threading.Thread(target=worker) for _ in range(8)]
        [t.start() for t in ts]; [t.join() for t in ts]
        self.assertEqual(sorted(wins), ["x", "y"])
```

- [ ] **Step 2: Run** `cd integrations/hermes && python3 -m unittest tests.test_ct_ledger -v` → FAIL (`AttributeError: claim`).
- [ ] **Step 3: Implement**

```python
    def claim(self, session_id, ids):
        """Atomically add the ids not yet in this session's set; return them
        (input order, unique), or None when the session has no entry. The one
        check-and-add the 8 Hermes tool threads share (rule 1)."""
        with self._lock:
            current = self._store.get(session_id)
            if current is None:
                return None
            claimed = []
            for fact_id in ids:
                if fact_id not in current:
                    current.add(fact_id)
                    claimed.append(fact_id)
            self._store.move_to_end(session_id)
            return claimed
```

- [ ] **Step 4: Run** the test → PASS; `cp` to claude-code; `python3 -m unittest discover -s tests/tools` → PASS (parity).
- [ ] **Step 5: Commit** `feat(ledger): atomic LedgerCache.claim`.

### Task 2: `ct_tool_dedup` uses `claim`

**Files:** Modify `integrations/hermes/scripts/ct_tool_dedup.py` (`_transform`); Test `tests/test_ct_tool_dedup.py`.

**Interfaces:** Consumes `LedgerCache.claim`. Output format unchanged.

- [ ] **Step 1: Failing test** — a fact claimed by another thread between dedup's read and write must be stubbed: patch `LEDGER_CACHE.get` to return a stale snapshot without `f1` while the store already holds `f1`; assert `f1` is stubbed. (With get+add it is not stubbed → FAIL.)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — collect valid ids in order; `claimed = LEDGER_CACHE.claim(sid, ids)` when `has_sid`, else `None`. `claimed is None` → no stubs, every valid id gets a trailer marker (old no-ledger behavior). Otherwise entries whose id is not in `claimed` are stubbed and `claimed` gets trailer markers.
- [ ] **Step 4: Run** the whole hermes suite → PASS (existing dedup tests unchanged).
- [ ] **Step 5: Commit** `refactor(dedup): race-free ledger update via claim`.

### Task 3: Activity line builder (secret-safe) and query

**Files:** Create `integrations/hermes/scripts/ct_wisdom_activity.py`; Test `tests/test_ct_wisdom_activity.py`.

**Interfaces:**
- Produces: `Activity = namedtuple("Activity", "verb target key line query")`;
  `normalize_path(raw, cwd=None) -> str | None`; `command_target(command) -> str | None`;
  `activity_for(tool_name, args, cwd=None) -> Activity | None`; `query_for(activity) -> str`;
  `is_ct_tool(name) -> bool`.

- [ ] **Step 1: Failing tests** (table-driven):

```python
CASES = [
    ("read_file", {"path": "src/billing/invoice.py"}, "read src/billing/invoice.py", "src/billing/invoice.py"),
    ("write_file", {"path": "./a/b.py", "content": "SECRET"}, "write a/b.py", "a/b.py"),
    ("patch", {"path": "x.py", "old_string": "o", "new_string": "SECRET"}, "edit x.py", "x.py"),
    ("search_files", {"pattern": "MCP tool name", "path": "src"}, "search MCP tool name in src", "MCP tool name"),
    ("terminal", {"command": "pnpm test"}, "run pnpm test", "pnpm test"),
    ("terminal", {"command": "npm run build"}, "run npm run", "npm run"),
    ("terminal", {"command": "pytest tests/billing -q"}, "run pytest tests/billing", "pytest tests/billing"),
    ("terminal", {"command": "API_KEY=sk-123 python deploy.py --token x"}, "run python deploy.py", "python deploy.py"),
    ("terminal", {"command": "curl -H 'Authorization: Bearer x' https://h"}, "run curl", "curl"),
    ("terminal", {"command": "git commit -m 'msg SECRET'"}, "run git commit", "git commit"),
]
```
plus: absolute path under cwd → relative; outside cwd → last two components; `~/x/y/z.py` → `y/z.py`; patch without path → None; unknown tool → None; `execute_code` → None; CT tool names → `is_ct_tool` True; and the **secret-safety property**: for 500 random commands built from a vocabulary of secret-looking tokens (`sk-…`, `ghp_…`, `user:pw@host`, `$TOKEN`, `A=B`, quoted strings, flags, pipes), the query has ≤ 2 tokens, both equal to the first two non-flag tokens of the first simple command, and contains none of `= @ : $ ' "`; and no `content`/`old_string`/`new_string`/`patch` arg text ever appears in `line` or `query`.

- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** per spec "Activity line builder" (shlex with fallback, operator stop, env-assignment skip, basename program, word-shape regex `^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$`, credential heuristic, free-text program list; path rule; 200-char target cap). `query_for` returns `strip_forged(activity.query)[:300]`; the query is the bare target (search: bare pattern).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(hermes): secret-safe activity line builder`.

### Task 4: Key tracker and rate rule

**Files:** Modify `ct_wisdom_activity.py`; Test `tests/test_ct_wisdom_activity.py`.

**Interfaces:** Produces `class ActivityState` with `admit(session_id, api_request_id, key) -> str | None` (None = admitted; else failure class `seen_key` / `step_used`), `reset()`. Key = `(verb class, target)`; `read`/`write`/`edit` → `file`.

- [ ] **Step 1: Failing tests:** second admit in the same `api_request_id` → `step_used` even with a new key; same key in a new step → `seen_key`; read then edit same path → `seen_key`; 33 distinct keys evict the oldest; sessions are independent.
- [ ] **Step 2–4:** run (FAIL), implement with one lock, per-session `OrderedDict` of keys (32) and step ids (16), sessions LRU 256; run (PASS).
- [ ] **Step 5: Commit** `feat(hermes): activity key tracker and per-step rate rule`.

### Task 5: Render, splice, hooks, seam

**Files:** Modify `ct_wisdom_activity.py`; Test `tests/test_ct_wisdom_activity.py`.

**Interfaces:**
- Produces: `render_candidates(entries, corrections, ledger) -> list[(item, superseded)]`;
  `render_activity_block(item, superseded, activity) -> str` (marker-first, ≤ 600);
  `splice(result, block) -> str | None`; `on_pre_tool_call(**kw) -> None`;
  `on_transform_tool_result(**kw) -> str | None`; `_record_activity_delivery(event) -> None`;
  `reset_state()` (tests); module hooks `_clock` and `_spawn(target)` for tests.
- Consumes: `ct_wisdom_live.match_wisdom/has_match_capability/_BREAKER/EXCLUDE_MAX/LIVE_TIMEOUT`, `ct_wisdom.discover_ct/_sanitize/reset_discovery_cache`, `ct_ledger.LEDGER_CACHE.get/claim`.

- [ ] **Step 1: Failing tests:**
  - pre → transform happy path: result JSON object gets `curated_thoughts_wisdom`; `json.loads` still works; `bytes_written` still present; marker is in the raw text; fact id claimed in `LEDGER_CACHE`; `match_wisdom` got `max_n == 1`, query `src/x.py` (no verb), exclude = ledger.
  - plain-text result → `"\n\n" + block` appended; JSON list / non-str / existing key → None and nothing claimed.
  - block ≤ 600 chars, heading + `_for:` label, marker index < title index < text index; long text truncated with `…`.
  - correction survives only when it supersedes a ledger id.
  - fail-closed: no ledger, empty ids, CT tool, breaker open, step used, seen key, prefetch timeout past budget (`_clock` advanced; `done` never set) → None; `timeout`/`exit` call `_BREAKER.record_failure`; `spawn` resets caches; zero hits → None.
  - `on_pre_tool_call` returns None even if internals raise (patch `activity_for` to raise).
  - seam: `_record_activity_delivery` called once per delivery with keys `kind, session_id, fact_ids, block, query, tool_name, api_request_id, gate`, `kind == "activity"`; not called on skip.
  - concurrent: two prefetches would deliver the same id to two calls of different steps → the second skips it (claim).
- [ ] **Step 2–4:** run (FAIL), implement per spec "Trigger", "Channel", "Splice rule", "3 s budget"; run (PASS).
- [ ] **Step 5: Commit** `feat(hermes): activity prefetch, delivery and verbose seam`.

### Task 6: Registration and marker hygiene

**Files:** Modify `integrations/hermes/__init__.py`; Test `tests/test_ct_wisdom_activity.py` (hygiene) and the install/registration tests if they assert the hook list.

- [ ] **Step 1: Failing tests:** `register(ctx)` registers `pre_tool_call`; the composed transform returns the dedup result for CT recall tools and the activity result otherwise; **hygiene:** an activity query never contains `ct-fact:` or the heading (args stuffed with a rendered block), the user-turn path's query comes only from `user_message` (history containing an activity block does not change `match_wisdom`'s text), `ct_ledger.history_ids` finds activity markers in tool-role messages for both splice shapes.
- [ ] **Step 2–4:** run (FAIL), implement `_pre_tool_call` (always `None`) and compose `_transform_tool_result` (dedup first; if it returned a string, return it; else activity; each in its own try); run (PASS).
- [ ] **Step 5: Commit** `feat(hermes): register pre_tool_call; compose transform`.

### Task 7: Randomized exactly-once with activity and threads

**Files:** Modify `integrations/hermes/tests/test_exactly_once.py`.

- [ ] **Step 1:** add `test_no_fact_twice_with_activity` — 120 sessions; per turn: optional compaction, optional restore (clears `LEDGER_CACHE` + session state → everything fails closed), `on_pre_llm_call`; then 1–4 model steps each with an `api_request_id` and 1–5 tool calls mixing `read_file`/`terminal`/`search_files` and CT recalls, run concurrently on real threads (pre then transform per call); fake `match_wisdom` ignores `exclude` half the time. After every step, count visible facts (bootstrap block, user-turn blocks, activity blocks inside `curated_thoughts_wisdom` keys or appended text, unstubbed recall entries) and assert no id > 1; also assert at most one activity block per `api_request_id`.
- [ ] **Step 2:** run → PASS (property holds by construction of Tasks 1–6; if it fails, debug with superpowers:systematic-debugging).
- [ ] **Step 3: Commit** `test(hermes): exactly-once across activity, live and recall`.

### Task 8: Release 0.5.0 and gates

- [ ] Bump `integrations/hermes/plugin.yaml` and `integration.yaml` to `0.5.0`; CHANGELOG `## 0.5.0 — 2026-10-16` (exact format) with the feature, query shape (A6), limits (1 fact/600 chars/step, concept rules unreachable from paths), and the `claim` change.
- [ ] README: Intuitive Wisdom section gains the autonomous-work step and the limitation; run `python3 tools/ct_ci.py readme`.
- [ ] Run `python3 tools/ct_ci.py policy --base origin/main`; if it requires a claude-code bump, patch-bump claude-code with a CHANGELOG "no behavior change" note.
- [ ] Run: hermes suite, claude-code suite, `python3 -m unittest discover -s tests/tools`, `ruff check --select E9,F63,F7,F82,F401 .` in each integration, `tools/ct_ci.py validate`, `policy --base origin/main`, `generate --check`, `readme --check`.
- [ ] Commit `release(hermes): 0.5.0 autonomous-work wisdom`; push; open the PR.
