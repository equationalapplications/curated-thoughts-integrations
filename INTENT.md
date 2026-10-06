# INTENT — curated-thoughts-integrations (Intuitive Wisdom & Harness Injection)

**Read this file first.** It explains why this repo exists, the business rules
every harness integration must obey, what is out of scope, and the workflow.
This file wins on *intent*; specs win on *detail*.

## Why CTI exists

Curated Thoughts (CT) is a local second brain with a curated wisdom layer.
This repo carries the harness integrations (Hermes, DeepSeek Harness, and
followers) that make CT's wisdom appear in an agent's context automatically.
Each integration implements a shared v1 mechanism that serves Intuitive
Wisdom (Kurt, 2026-10-05; supersedes the 2026-10-01 algorithm framing;
reference spec: PR #21, ported in PR #22).

## Intuitive Wisdom (what every integration serves)

Intuitive Wisdom is the agent **knowing the curated wisdom fact at the time it
is relevant** (Kurt, 2026-10-05). It is defined by this timeliness property,
not by any particular mechanism.

What ships today (v1) is the first, partial mechanism: session-start injection
via frozen seed + session context. It guarantees presence at bootstrap only —
relevance is approximated by seed similarity. (Only the DSH integration has
shipped this; the Hermes port is implemented and tested on an unmerged
branch.) The end state is
**relevance-timed delivery**: when a fact becomes relevant mid-session, it
reaches the agent at that moment — via cache-safe channels that never rewrite
the frozen system-prompt block (tool results are the v1-proven channel), and
ledger-deduped so no fact appears twice. The matching trigger, judge
involvement, and delivery surface for mid-session relevance are **open design
work**, not settled by this file; open questions carried from the invariants
(ledger ownership, scope-b labeling) resolve there.

### v1 mechanism — bootstrap-time relevance (what every integration implements)

1. **Analyze:** at bootstrap there is no conversation yet — recall is driven by
   the frozen seed constant plus session context, per PR #21 (`ct recall
   "<seed>" --json --k 3`, with cwd widened as needed); the seed does the
   semantic work.
2. **Match:** find wisdom-layer facts via CT's recall (semantic similarity).
3. **Judge (in CT, optional — future; not implemented in v1):** if System One
   is configured, CT's recall
   applies its relevance judgment before returning results. Integrations never
   call System One directly and never wire their own judges.
4. **Traverse — deferred:** deeper graph traversal is NOT part of
   session-start injection in v1 (edges are sparse; it stays in `wiki_context`
   on demand). Any injection-time traversal needs a new CT decision first.
5. **Inject:** append the surviving facts to the prompt under the invariants
   below.

## Injection invariants (non-negotiable)

1. **Exactly once (scope b).** A fact never appears twice anywhere in a
   session's context: once in the injected block, never again via tool
   results. The ledger lives in CT's session context (keyed by session id);
   CT recall tools filter against it. Dedup keys on the deterministic fact id
   after supersession resolution. The supersession gate governs **render-time
   construction only**: at render time, no superseded fact is injected.
   Post-render supersession flows exclusively through the append-and-mark
   path: a replacement surfaced mid-session is delivered with an explicit
   "supersedes <id>" tool-result marker; the frozen block is never edited.
   (Ledger ownership and the supersession marker are new work —
   pending decisions.)
2. **Cache safety.** The block is computed at bootstrap and frozen as ONE
   contiguous static region, additive with existing plugin context. Verbatim
   replay exists to protect **prompt caching** — the prefix stays intact so
   the cache is preserved — not to freeze knowledge. Resume replay is
   guaranteed by the **host** persisting the fully rendered prompt verbatim;
   there is no plugin-side persistence — none will be built — and the
   in-process memo (PR #22) is a speed optimization for **new renders only**.
   A fact superseded **after** the original render is **appended as a
   correction** via an explicit "supersedes <id>" tool-result marker
   (mid-session delivery: pending design work); the append is highly
   relevant content, not unnecessary duplication, and the stale line stays
   visible but corrected — never silently relied on. A bootstrap render that
   fails (timeout / exit / spawn / probe timeout) MAY be **late-filled when
   a later render misses the session memo** — `discovery_miss`,
   `parse_error`, and `zero_hits` remain cached as empty blocks until LRU
   eviction, so a later rebuild only retries the non-memoized failure
   classes; a compaction rebuild counts as a trigger only when it invokes
   the renderer; each identity probe uses a 3 s subprocess timeout
   (`PROBE_TIMEOUT`) and recall uses a 5 s subprocess timeout
   (`RECALL_TIMEOUT`); discovery may probe multiple candidates per render,
   so the worst-case stall scales with the candidate list (failure classes per
   `ct_wisdom.py`). Mid-session learning arrives only as tool
   results; the system prompt is never rewritten.
3. **Graceful degradation.** Recall backend unavailable, timeout, empty
   corpus → the integration is a silent no-op (no empty block, nothing
   emitted), logged locally, never surfaced as a session error. A session
   with no session id is likewise a silent no-op — nothing emitted. A bounded
   recall timeout prevents a hung recall backend from stalling bootstrap. An
   agent session must never fail because its brain is unreachable.
4. **Provenance labeling.** Every injected fact is labeled with its provenance
   class from a fixed vocabulary OWNED BY CT and emitted by `ct recall`
   (on successful recalls with chunk hits, `ct recall --json` returns a
   `results` array of chunks — `doc_path`, `chunk_text`, `score`,
   `symbol_name`, `entity_id` — and a `wiki` array of entries — `id`,
   `entity_id`, `title`, `text`, `source_ref`, `confidence`; neither array
   carries a provenance class — RR-C; closing it needs parser changes per
   integration, so until then this invariant is forward-looking). The Hermes
   parser reads only `title` and `text` from `wiki`, discarding the rest.
   Integrations never present agent-tier
   wisdom as verified knowledge.
5. **Bound the block.** The injection block has a size/item cap with
   host/spec-pinned values (`max_chars=2500` is the Hermes host registration
   in `__init__.py`; `RECALL_K=3` is local to `ct_wisdom.py`); the cap is
   never raised locally to compensate for weak matching.

## Read-only retrieval

- Integration CODE never writes to CT. Agents running inside the harness may
  use CT's deposit tools (`wisdom_deposit`, `wisdom_propose_supersession`)
  — which write files under `immutable-source-files/agents/` and report
  `pending ingest` honestly. Integrations never call row-level
  insert/update/approve/archive tools.
- Injection never reads uningested vault files — no lexical grepping, no
  query-time embedding of vault files, no ad-hoc indexing. Freshness is CT's
  deposit-kicked-ingest job, not ours.
- Integrations only READ the brain via the sanctioned recall surface (`ct
  recall` subprocess / read-only sidecar tools). No direct brain DB access.
- Reuse proven decisions: new ports fork the converged Hermes design and
  record deliberate divergences (PR #22 is the model).

## Non-goals

- No general-purpose CT client library; bind thinly to each host's extension
  points.
- No recall-quality logic (scoring models, judges, expansion, ranking) — that
  lives in CT; integrations consume results and never call System One.
- No human review/attestation UX — that lives in the CT app.
- No support for harnesses lacking the needed extension points (a stable
  system-prompt region + a read-only recall path).

## Workflow

1. Spec first under `docs/superpowers/specs/`, from a Step-0 investigation
   with `[V]`-evidenced answers from pinned host sources (PR #22 is the
   standard).
2. TDD: unit-test the invariant logic (dedup ledger, memo byte
   stability across new renders, sanitizer); e2e in the isolated container on
   a scratch profile — never the live default profile or live brain.
3. Dual review to convergence (GLM + Opus) before merge; open questions park
   the PR.
4. Version bump + CHANGELOG + README table per integration.
5. The invariants ARE the test surface: any injection-touching PR must
   demonstrate exactly-once across randomized sessions with mid-session tool
   results, byte-identical injected blocks across memoized renders (retries
   after timeout / exit / spawn failure are allowed and may fill the block
   the first render left dark), and the
   supersession gate (at render time, no superseded fact is ever injected —
   post-render supersessions ride the append-and-mark path, per invariant 2).
