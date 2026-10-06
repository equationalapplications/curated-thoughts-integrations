# curated-thoughts-integrations — INTENT invariant adjudication: spec-vs-code reconciliation

**Date:** 2026-10-05 · **Status:** Implemented 2026-10-05 (PR #26) — INTENT.md reconciled with issue #24 adjudication; dual review GLM 5.3 (Approved, 3 minors) + Opus (Changes requested, 4 findings) converged via delta commit.

## Problem

A full-pass Opus doc review of `INTENT.md` (CTI issue #24, 2026-10-05) found
genuine spec-vs-code gaps in the pre-existing injection invariants: the spec
over-claims persistence mechanics that do not exist, describes behavior the
code cannot deliver, and contains one internal contradiction (rule 5 vs
invariant 2). Every finding has since been adjudicated with owner rulings
(Kurt VanDusen, comment 6002134987 on issue #24) and verified against live
code (three research questions answered from source). The spec text must now
be reconciled with the rulings — the issue stays open until INTENT.md says
what was decided.

Current-state evidence [V] (verified 2026-10-05 against live code):

- **[V] The recorded live `ct recall --json` sample has `results` entries
  with `entity_id`, `doc_path`, and `score`, and `wiki` entries with `id`,
  `title`, `text`, `source_ref`, `confidence`, and `entity_id`.** The sample
  has no supersession-status field; the B1 design routes that status through
  the tool-result `supersedes <id>` marker.
- **[V] Hermes `plugins_dispatch.py::_render_prompt_section_text` strips the
  section value and skips it entirely when empty/whitespace** (returns `None`
  → not rendered). Invariant 3's "nothing emitted" already holds; no code
  change needed.
- **[V] PR #22's DeepSeek `wisdom.ts` memo is in-memory only** (LRU-capped, no
  TTL, no disk writes). Same as Hermes `ct_wisdom.py`. "PR #22 memo-replay is
  the pattern" is false for both harnesses.
- **[V] Hermes persists the fully rendered session prompt verbatim**
  (`plugins.py::register_system_prompt_section`: "the rendered prompt is
  persisted by core verbatim"). Resume replay needs NO plugin-side
  persistence.

## Approach

Kurt's rulings (2026-10-05, issue #24 adjudication) decide every finding:

- **B1:** verbatim replay protects **prompt caching**, not frozen knowledge.
  Rule 5 governs **render-time construction only**; post-render supersessions
  are appended as corrections via the `supersedes` marker path. An appended
  revision is NOT "unnecessary duplication" — it is highly relevant content.
- **M1:** replay is a **host guarantee** (Hermes persists the rendered prompt
  verbatim); no plugin-side persistence exists or will be built. Drop the
  RR-6 target-state work for resume replay.
- **M2:** **late fill is conditional on a memo miss** — a later render can
  retry only the failure classes that did not memoize (`timeout`, `exit`,
  `spawn`, `probe_timeout`); `discovery_miss`, `parse_error`, and
  `zero_hits` remain cached as empty blocks until LRU eviction. A
  compaction rebuild counts as a retry trigger only when it invokes the
  renderer. Each identity probe uses a 3 s subprocess timeout
  (`PROBE_TIMEOUT`) and recall uses a 5 s subprocess timeout
  (`RECALL_TIMEOUT`); discovery may probe multiple candidates per render,
  so the worst-case stall scales with the candidate list — stated
  explicitly.
- **M5:** "no query-time embedding" is false as written (recall must embed the
  query). Reword: "no query-time embedding of vault files; no ad-hoc indexing."
- **Minors m1/m2/m4/m5/m6:** accuracy wording (caps are host/spec-pinned; name
  the real recall command; note provenance fields are discarded by
  `recall_wiki`; "sidecar down" → "recall backend unavailable" for Hermes;
  document the empty-session_id no-op class in invariant 3).
- **m3** was already fixed in `2f7bc3f` (Judge marked future/not-implemented).
- **MINOR-4/5/6 + NIT-2/3** (scope-b taxonomy, ledger ownership,
  session-context overloading) fold into the mid-session-delivery design work
  per the issue's scope note — NOT this PR.

**Rejected alternative — docs-only PR:** the first handoff planned a wording-
only PR. Rejected 2026-10-05 by Kurt: EA standard operating procedure is spec
→ plan → implementation in ONE PR via the superpowers delivery flow. For this
issue the implementation is the INTENT.md reconciliation itself (the
adjudication eliminated every code change: RR-6 unnecessary, invariant 3
already holds, memo persistence ruled a non-goal), but the delivery artifacts
(spec + plan + spec-status flip) ride the same PR, and the full review ladder
applies.

**Rejected alternative — wait for the marker-path implementation:** the B1
append path depends on tool-result `supersedes` markers, which are new work.
Ruling keeps the spec honest now: rule 5 governs render time, corrections
ride the marker path (documented as the design), marker implementation stays
with the mid-session-delivery design work. The spec describes intent, not
shipped mechanics, where marked as future.

## Design

One target file: `INTENT.md` (was 120 lines pre-adjudication; 149 lines after the nine edit sites below land). Edit set:

1. **Invariant 2 / B1:** replay clause reworded — verbatim replay protects
   prompt caching; post-render supersessions append as corrections via the
   `supersedes` marker; not contradictory with rule 5.
2. **Invariant 2 / M1:** "persisted per session and REPLAYED" → replay is a
   host guarantee (host persists the rendered prompt verbatim); in-process
   memo is a speed optimization for new renders only. RR-6 replay work is
   unnecessary.
3. **Invariant 2 / M2:** "computed once, frozen" relaxed — a failed bootstrap
   render MAY be late-filled when a later render misses the session memo
   (timeout / exit / spawn / probe_timeout retry; discovery_miss /
   parse_error / zero_hits stay cached until LRU eviction); per-call
   timeouts (`PROBE_TIMEOUT=3`, `RECALL_TIMEOUT=5`) and the multi-candidate
   discovery loop bound the worst-case stall, stated explicitly.
4. **Invariant 4 / m4:** note provenance fields are currently discarded by
   `recall_wiki` (the Hermes parser reads only `title` and `text` from each
   `wiki` entry, discarding `id`, `source_ref`, and `confidence`; the full
   upstream `ct recall --json` schema also exposes a `results` array —
   `doc_path`, `chunk_text`, `score`, `symbol_name`, `entity_id` — and the
   `wiki` array fields beyond `title`/`text`; see plan erratum); closing
   RR-C needs parser changes per integration.
5. **Invariant 5 / m1:** cap values are host/spec-pinned, not "set by CT"
   (`max_chars=2500` is the Hermes host registration `__init__.py`;
   `RECALL_K=3` is local `ct_wisdom.py`).
6. **Rule 5 / B1:** reworded to govern render-time construction only.
7. **Read-only retrieval / M5:** "no query-time embedding of vault files; no
   ad-hoc indexing."
8. **Invariant 3 / m5 + m6:** "sidecar down" → "recall backend unavailable";
   document the empty-session_id no-op class.
9. **v1 mechanism step 1 / m2:** name the actual command form
   (`ct recall "<query>" --json --k 3` + cwd widening).

Out of scope: code changes of any kind (none remain after adjudication);
MINOR-4/5/6 + NIT-2/3 (mid-session-delivery design work); m3 (already fixed).

## Testing

- Wording-only diff on `INTENT.md`; no code paths change.
- Verification: every rewritten claim checked against the verified facts
  above (recall JSON fields, render-skip behavior, host persistence, memo
  semantics) — the spec may not introduce NEW over-claims while removing old
  ones.
- Review ladder per SOP: GLM 5.3 spec pass → Opus doc review with INTENT.md +
  cited sources as context → convergence per dual-review-cycle (0 BLOCKER /
  0 MAJOR).
