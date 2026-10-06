# Plan — INTENT invariant adjudication (issue #24 → PR #26)

**Goal:** reconcile `INTENT.md` with the 2026-10-05 issue #24 adjudication (comment 6002134987) — every finding gets its ruling-backed rewording, no new over-claims.
**Architecture:** one file (`INTENT.md`, 120 lines pre-adjudication / 149 lines post-implementation), nine edit sites, docs-only implementation (adjudication eliminated all code work).
**Tech stack:** markdown; verification by grep against on-disk content after each edit.
**Spec:** `docs/superpowers/specs/2026-10-05-intent-invariant-adjudication-design.md` (this PR).
**Global constraints:**
- No code changes. No edits outside `INTENT.md` and the plan/spec status flips in `docs/superpowers/`.
- Every rewritten claim must match the verified facts in the spec's Problem section — the diff may not introduce NEW spec-vs-code gaps.
- Rulings are closed; nothing here re-opens B1/M1/M2/M5 or the minors.
- Out of scope stays out: MINOR-4/5/6 + NIT-2/3 (mid-session-delivery design work), m3 (fixed in 2f7bc3f).

## Tasks

### Task 1: B1 — invariant 2 replay clause + rule 5 render-time gate

In `INTENT.md`:

1. **Invariant 2 (lines 61–67).** Replace:

   > The rendered block and the session ledger are persisted per session and REPLAYED on resume and compaction, never recomputed (PR #22 memo-replay is the pattern; per-host conformance is pending RR-6).

   with a clause set stating: verbatim replay exists to protect **prompt caching** (prefix intact, cache preserved), not to freeze knowledge; resume replay is guaranteed by the **host** persisting the rendered prompt verbatim (no plugin-side persistence — none will be built); the in-process memo is a speed optimization for **new renders only**; a fact superseded **after** the original render is **appended as a correction** via the tool-result `supersedes <id>` marker path (mid-session delivery: pending design work) — the append is highly relevant content, not unnecessary duplication, and the stale line stays visible but corrected, never silently relied on.

2. **Invariant 5 (rule 5 in the issue's numbering — lines 78–80), plus invariant 2's "computed once" clause for M2.** Replace:

   > The block is computed once, frozen as ONE contiguous static region at bootstrap, once per session

   with: computed at bootstrap and frozen as ONE contiguous static region; a bootstrap render that fails (timeout / spawn failure / probe timeout) MAY be **late-filled at a later rebuild boundary** (e.g. compaction rebuild) — better late wisdom than never; each identity probe uses a 3 s subprocess timeout (`PROBE_TIMEOUT`) and recall uses a 5 s subprocess timeout (`RECALL_TIMEOUT`); discovery may probe multiple candidates per render, so the worst-case stall scales with the candidate list (failure classes per `ct_wisdom.py`).

3. **Rule 5 (line 120 context — Workflow item 5's "supersession gate" wording stays; the gate itself is line 78–80 "cap" task's sibling) — in the *invariants* list**, reword the supersession gate (invariant 1's "Dedup keys on the deterministic fact id after supersession resolution" neighborhood and the rule-5 sentence "no superseded fact is ever injected" wherever it governs replay) to: rule 5 governs **render-time construction only** — at render time no superseded fact is injected; post-render supersession flows exclusively through the append-and-mark path from Task 1.1.

**Interfaces:** invariant 2's new text must not contradict invariant 1's ledger sentence or the v1 mechanism section; the `supersedes` marker must be described identically in both places it appears.

**Commit:** `docs: INTENT invariants 1-2 — replay is cache protection + host guarantee, late fill allowed (B1, M1, M2)`

### Task 2: minors batch — invariants 3–5 + read-only retrieval + v1 step 1

In `INTENT.md`:

1. **Invariant 3 (lines 68–72):** replace "sidecar down" with "**recall backend unavailable**" (Hermes has no sidecar contact); document the **empty-session_id no-op class** (a session with no session id is a silent no-op — nothing emitted, invariant's graceful-degradation behavior).
2. **Invariant 4 (lines 73–77):** keep RR-C forward-looking framing, add: recall currently returns a `results` array of chunk hits and a `wiki` array of wiki entries; `recall_wiki` reads only `title` and `text` from each wiki entry, discarding `id`, `source_ref`, and `confidence`; closing RR-C needs parser changes per integration.
   > **ERRATUM (2026-10-05, review delta):** this sentence was written from a stale field list. Verified ground truth: `ct recall --json` returns a `results` array (`doc_path`, `chunk_text`, `score`, `symbol_name`, `entity_id`) and a `wiki` array (`id`, `entity_id`, `title`, `text`, `source_ref`, `confidence`) — neither carries a provenance class. The implemented INTENT.md invariant 4 carries the correct fields; this line is preserved as review history and superseded by the erratum in the spec (§ m4).
3. **Invariant 5 (lines 78–80):** replace "values set by CT" with **host/spec-pinned values** (`max_chars=2500` is the Hermes host registration in `__init__.py`; `RECALL_K=3` is local to `ct_wisdom.py`); the never-raised-locally rule stays.
4. **Read-only retrieval (line 89–90):** replace "no query-time embedding" with "**no query-time embedding of vault files; no ad-hoc indexing**" (recall itself embeds the query).
5. **v1 mechanism step 1 (lines 37–39):** name the actual command: `ct recall "<seed>" --json --k 3` plus cwd widening.

**Interfaces:** none cross-task; all five sites are independent lines.

**Commit:** `docs: INTENT minors — host-pinned caps, real recall command, provenance-discard note, empty-session-id no-op, recall-backend wording (m1, m2, m4, m5, m6)`

### Task 3: verification + spec status flip + PR body stage update

1. **Coverage check:** `grep -n` for each old phrase — every removed claim is gone; each new claim present exactly once where intended. Grep list: `REPLAYED`, `memo-replay is the pattern`, `RR-6`, `sidecar down`, `set by CT`, `computed once`, `query-time embedding`, `persisted per session`.
2. **Consistency read:** full pass over the edited INTENT.md — no internal contradiction (esp. invariant 1 vs 2 on the marker path; v1 mechanism vs invariants on timing).
3. **Spec status flip:** `**Status:** Draft (spec stage — single-PR SOP: …)` → `**Status:** Implemented 2026-10-05 (PR #26) — INTENT.md reconciled with issue #24 adjudication`.
4. **PR body:** flip the Plan and Implementation checkboxes, note the review-ladder state.
5. **Commit:** `docs: verify INTENT reconciliation, flip spec to Implemented (PR #26)`

### Task 4: review ladder (Tier 2 GLM 5.3 → Tier 3 Opus)

1. **Tier 2:** fresh-context GLM 5.3 pass over the full PR diff (`git diff origin/main..HEAD`) per `tessera-glm53-review-procedure.md`. Fix findings.
2. **Tier 3:** `opus-review --repo . --range <merge-base>..HEAD --doc`-style pass **with context** (INTENT.md, the spec, the adjudication comment body) per dual-review-cycle. Delta cycles after round 1. Checkpoint: 4 docs cycles.
3. **Gate:** 0 BLOCKER / 0 MAJOR → flip PR ready, confirm CI green (`gh pr checks`), report to Kurt. Merge policy: **regular merges only in this repo** (Kurt, Sep 29 2026).
