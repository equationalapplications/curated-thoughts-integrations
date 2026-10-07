# curated-thoughts-integrations — Intuitive Wisdom: relevance-timed mid-session delivery (Hermes) design

**Date:** 2026-10-06 · **Status:** Implemented 2026-10-06 (PR #<n> — pending merge) ·
**Branch:** `feat/intuitive-wisdom-live-delivery` · **Repos:** this repo (Hermes plugin
0.3.3 → 0.4.0) + `curated-thoughts` (prerequisite contract, delivered first —
[curated-thoughts#265](https://github.com/equationalapplications/curated-thoughts/issues/265),
CT spec `docs/superpowers/specs/2026-10-06-issue265-wisdom-match-design.md` on CT branch
`feat/issue-265-wisdom-match`)

Investigation: [`../investigations/2026-10-06-intuitive-wisdom-live-delivery-step0-investigation.md`](../investigations/2026-10-06-intuitive-wisdom-live-delivery-step0-investigation.md)
(pinned: Hermes `ee8dd6c8`, CT `f7d9f56`; every `[V]` below has its evidence there).
Builds on: [`2026-09-30-wisdom-auto-inclusion-design.md`](2026-09-30-wisdom-auto-inclusion-design.md)
(v1 bootstrap block) and [`2026-10-05-intent-invariant-adjudication-design.md`](2026-10-05-intent-invariant-adjudication-design.md)
(B1 append-and-mark, M1 host-owned replay).

## Problem

INTENT defines Intuitive Wisdom as the agent **knowing the curated fact at the time it
is relevant**. v1 only guarantees presence at bootstrap: one frozen block built from a
hand-chosen seed query. A fact that becomes relevant on turn 7 never arrives unless
the agent decides to call a CT tool. INTENT leaves five decisions open: matching
trigger, judge involvement, delivery surface, ledger ownership, and scope-b labeling.

Three facts from the investigation shape the answer:

- **[V]** Hermes's `pre_llm_call` hook runs once per user turn, sees `user_message` and
  `conversation_history`, and its `{"context": ...}` return is appended to that turn's
  user message. The host stores the exact sent bytes (`api_content`) and replays them
  on later turns. That makes it a cache-safe append channel that never touches the
  system prompt.
- **[V]** CT's wiki leg is lexical term overlap (`LIKE '%term%'` per token ≥ 2 chars,
  no stopwords, no score, fixed 5 results). Fed a raw user message it matches almost
  everything. INTENT forbids integrations from scoring, so the relevance signal has to
  come from CT.
- **[V]** CT has no session ledger and no wiki-level supersession field. Supersession
  exists only between deposits (`okf/mod.rs:44-46`).

## Decisions (brainstorm, owner-approved 2026-10-06)

| Open question (INTENT) | Decision |
|---|---|
| Matching trigger | Each user turn, via `pre_llm_call`; the query is the user's message |
| Judge involvement | Inside CT only. CT's new command applies a semantic gate with a CT-owned threshold; a System One judge is a later CT-internal upgrade behind the same contract. The plugin never scores, ranks or thresholds |
| Delivery surface | Host-persisted append channels: the user-message context (`pre_llm_call`) for proactive delivery, and tool results (`transform_tool_result`) for dedup of agent-initiated CT calls |
| Ledger ownership | **The transcript.** Each delivered fact carries a stable id marker, and the ledger is rebuilt each turn from what the host already persists. No plugin persistence (M1). CT stays read-only and accepts exclude ids |
| Scope-b labeling | Scope b = everything in the session's *current* context: the frozen bootstrap block, user-message injections, and tool results. A fact compacted out of context is no longer "in context" and may be delivered again |

## Architecture

```
curated-thoughts (CT)                         Hermes plugin (this repo)
─────────────────────                         ──────────────────────────
ct wisdom match  ◄── subprocess (read-only) ── ct_wisdom_live.py
  semantic wiki leg + CT threshold               ├─ ledger: rebuild from history + bootstrap memo
  exclude ids → corrections                      ├─ pre_llm_call hook  → {"context": block}
                                                 └─ transform_tool_result hook → stub repeats
                                              ct_wisdom.py (v1, amended)
                                                 └─ bootstrap block now carries ct-fact id markers
```

Two units, one contract. The plugin depends only on the CT contract below, behind a
capability probe. Against an older `ct` the new hooks are silent no-ops and v1
behavior is unchanged.

### Delivery order

1. **CT PR** (curated-thoughts repo): the `ct wisdom match` contract. Gets its own CT
   spec and plan, which turn the "CT prerequisite" section below into CT-side detail
   (threshold calibration over the wiki embeddings CT already stores —
   `llm_wiki_entries.embedding_blob`, filled by `embed_sweep.rs` [V] — and
   deposit→wiki supersession resolution). Investigation items O4 and O5.
2. **Hermes PR** (this repo): built and unit-tested against a fake `ct` that speaks
   the contract; e2e runs once a CT build with the contract is installed in the
   scratch profile.

## CT prerequisite — the `ct wisdom match` contract

Read-only. Same subprocess rules as v1: list argv, `stdin=DEVNULL`, timeout, `cwd=~`.

```
ct wisdom match --json [--max N] [--exclude=<id>]... -- <text>
```

- `<text>`: one argv element of up to 2000 characters, always after `--` (a user
  message may start with `-`, which an argument parser would otherwise read as a
  flag). CT may truncate further.
- `--max N`: the most relevance-gated `entries` to return (default 2). `corrections`
  are not counted against it.
- `--exclude=<id>`, repeatable, always in `=` form (an id may start with `-`): ids
  already in the caller's context. CT must not return them in `entries`.
- **Exit 0** on success, including no matches (unlike `ct recall`'s exit 2). Any
  non-zero exit means an error.

stdout (`--json`):

```json
{
  "schema": 1,
  "gate": "semantic-v1:<embed model>",
  "entries": [
    {"id": "…", "title": "…", "text": "…", "score": 0.0,
     "supersedes": ["…"], "provenance": "…"}
  ],
  "corrections": [
    {"id": "…", "title": "…", "text": "…", "score": null,
     "supersedes": ["<an excluded id>"], "provenance": "…"}
  ]
}
```

CT guarantees:

1. **Gate:** every `entries` item passed CT's relevance gate for `<text>`. `gate` is
   `"semantic-v1:<model>"`, or `"uncalibrated"` when CT has no calibrated floor for the
   brain's embed model — then `entries` is always empty (CT abstains) while
   `corrections` still flow. An empty list
   means nothing is relevant enough, not that something failed. `score` is
   informational only, and the plugin never thresholds on it.
2. **Render-time supersession:** a superseded entry is never returned in `entries` or
   `corrections` (INTENT invariant 1 at render time).
3. **Append-and-mark:** `corrections` lists the current replacement for every
   `--exclude` id that has since been superseded, whether or not it matches `<text>`.
   Each correction's `supersedes` names the excluded id(s) it replaces.
4. **Ids:** `id` is the wiki entry's stable primary key and matches
   `^[A-Za-z0-9._:-]{1,128}$`. The same fact always has the same id.
5. **Provenance:** `provenance` comes from CT's fixed vocabulary, or `null` when not yet
   classified. This closes RR-C for the live path.
6. **Latency:** p95 ≤ 1.5 s warm on the reference machine. Acceptance is measured in
   the CT PR.

Capability probe: `ct wisdom match --help` exits 0. The plugin checks once per process
per discovered `ct` path and memoizes the result.

## Hermes plugin design

### New module `scripts/ct_wisdom_live.py`

Reuses `ct_wisdom.discover_ct`, the identity probe, the subprocess contract and
`_sanitize`. New constants, frozen in code with no config surface (same rule as v1):

| Constant | Value | Why |
|---|---|---|
| `LIVE_MAX_PER_TURN` | 2 | `--max` |
| `LIVE_MAX_BLOCK_CHARS` | 1200 | per-turn block cap, well under the host spill limit of 10 000 [V] |
| `LIVE_MAX_PER_SESSION` | 12 | session budget for proactive `entries`; corrections are exempt |
| `LIVE_TIMEOUT` | 3 s | runs on the turn path, so it is tighter than v1's 5 s |
| `LIVE_QUERY_CHARS` | 2000 | truncation of the user message |
| `EXCLUDE_MAX` | 256 | argv bound; see "Ledger" |
| `BREAKER_FAILS` / `BREAKER_PAUSE` | 3 / 300 s | per-process: after 3 consecutive timeout or exit failures, skip live matching for 300 s |

INTENT invariant 5 applies to these caps: they are never raised to compensate for weak
matching.

### Fact id marker (shared by v1 and live)

Every delivered fact is rendered with an id marker on its title line:

```
**<title>** <!-- ct-fact:<id> -->
```

- **v1 change:** `recall_wiki` also parses `id` (it is already in `ct recall --json`
  [V]). `render_block` emits the marker, and an entry without a valid id is dropped
  because it cannot be deduped. The memo records the block's id list next to its bytes.
  Only new renders change, so the byte stability of memoized renders still holds.
- **Sanitizer:** `_sanitize` additionally removes every `ct-fact:` substring
  repeatedly until stable, before the existing two steps (the ledger scan matches
  `ct-fact:<id>` with or without the comment wrapper, so the bare token is what
  must be stripped). That way a fact's text cannot
  forge a ledger entry.
- A forged marker elsewhere in the transcript, for example typed by the user, can only
  **suppress** a delivery. It can never cause a duplicate. That is the safe direction,
  and it is documented.

### Ledger (rebuilt each turn, never stored)

`ledger(session_id, history) = memo_ids(session_id) ∪ scan(history)`

- `memo_ids`: the bootstrap block's ids from the v1 memo.
- `scan`: a regex for `ct-fact:<id>` over every history message, in both `content`
  (str or list of text parts) and `api_content`. Investigation O1: which field the hook
  sees on turn N+1 is unverified, so it reads both.
- **Restored-session rule (fail closed):** the hook can't see the system prompt [V], and
  no sanctioned API exposes it (O6). If `memo_ids` has no entry for this session and the
  history is non-empty (a restore, `/branch`, `/resume` or process restart), the
  bootstrap ids are unknowable. **Live delivery is disabled for that session.** A first
  turn (`is_first_turn`) with no memo entry means the bootstrap render was skipped or
  empty, so `memo_ids = ∅` is correct there.
- **Compaction:** if in-place compaction summarizes a turn away, its markers leave the
  history, so the fact leaves the ledger and may be delivered again. That matches scope
  b ("in current context"). If compaction keeps the bytes, the markers keep the fact
  ledgered. Both outcomes are correct (O3, checked at e2e).
- `--exclude` sends up to `EXCLUDE_MAX` ids, most recent first. The plugin **always
  post-filters** returned `entries` against the full ledger, so correctness never
  depends on the argv bound.
- A per-process `{session_id → ledger}` cache, LRU 256 like v1, holds the latest
  rebuild so `transform_tool_result` (which gets no history) can use it within the turn.
  The cache is a speed aid only and is never a source of truth across turns.

### `pre_llm_call` hook

```
_on_pre_llm_call(session_id, user_message, conversation_history, is_first_turn, **_):
  1. empty session_id → None                                    (invariant 3 no-op)
  2. capability probe fails / breaker open → None
  3. ledger rebuild; restored-session rule → None
  4. query = text of user_message (str, or joined text parts), stripped,
     truncated to LIVE_QUERY_CHARS; empty → None
  5. session budget: distinct ct-fact ids scanned from user-role messages
     (where live blocks land; bootstrap ids live in the system prompt and tool
     trailers in tool-role messages, so neither counts) ≥ LIVE_MAX_PER_SESSION
     → still run, but with --max 0 (corrections only)
  6. ct wisdom match --json --max k --exclude=<id>… -- <query>  (LIVE_TIMEOUT)
  7. drop any entry or correction whose id is invalid or already ∈ ledger;
     additionally drop a correction whose `supersedes` ∩ ledger is empty
     (nothing in context for it to correct). Corrections exist only for ids
     actually sent via --exclude (the EXCLUDE_MAX most recent) — an older
     ledgered fact's supersession is caught once it is re-sent, never missed
     silently by design but possibly late (documented).
  8. render (below); "" → None; else {"context": block}
  9. update the ledger cache with the delivered ids
  every exception → debug log, None
```

Rendered block, with corrections first:

```
## Curated Thoughts — relevant now
**<title>** <!-- ct-fact:<id> --> (provenance: <p|unlabeled>)
<sanitized text>

**<title>** <!-- ct-fact:<id> --> (provenance: …) — supersedes ct-fact:<old-id>
<sanitized text>
```

It is bounded by `LIVE_MAX_BLOCK_CHARS` with v1's fit, truncate, drop rule. A
correction is never truncated away in favor of an entry. The provenance label satisfies
INTENT invariant 4 on this path: `null` renders as `unlabeled`, never as verified.

Not memoized per turn. Every turn is a fresh query, and a failed turn simply delivers
nothing.

### `transform_tool_result` hook (dedup of agent-initiated CT calls)

- Matches only tool names ending in `__curated_recall_context`
  (`mcp__<server>__<tool>` [V]; suffix match tolerates the installed server name).
  `curated_get_wiki_entry` is NOT matched: it returns document chunks
  (`full_text`, `chunks`) with no wiki ids [V `curated_thoughts_mcp.rs:280-333`],
  so there is nothing to dedup by id (plan-time correction). Any other tool → `None` (pass-through).
- Unwraps the two-layer envelope (investigation Target 5, O7 resolved [V]): the outer
  string is Hermes's `{"result": "<CT JSON>"}` (plus optional `structuredContent` /
  `_meta`); `json.loads(outer["result"])` gives CT's object, whose wiki list is
  `wiki_entries`. After stubbing, the inner object is re-serialized into
  `outer["result"]` and the outer object re-serialized with its other keys intact.
  A `tool_error`, missing `result`, or unparseable inner string (e.g. head+tail
  truncated) → pass through. For each wiki entry:
  - `id` ∈ ledger cache → replace the entry with `{"id": id, "in_context": true,
    "note": "already in context: ct-fact:<id>"}`, dropping title and text (option A);
  - otherwise leave it as is and add the id to the ledger cache.
- Appends a trailer line `<!-- ct-fact:<id> -->` per newly seen id, so the next turn's
  history scan ledgers them.
- No ledger cache for the session, or a parse failure → return the result unmodified
  but still append trailers when ids are parseable. Never raises. Rewriting happens
  before the result first enters context, so cache safety is unaffected.

### Registration (`__init__.py`)

`ctx.register_hook("pre_llm_call", ...)` and `ctx.register_hook("transform_tool_result",
...)`, each wrapped in the existing `try/except` + warning pattern.

## Error handling

Every failure means **no delivery this turn**, logged at debug with a `wisdom-live`
prefix and never raised. The classes are v1's (`discovery_miss`, `spawn`, `timeout`,
`exit`, `parse_error`) plus `capability_missing` (memoized per process),
`restored_unknown_bootstrap` (per session, fail closed), and `breaker_open`. A turn the
host runs with `_persist_disabled` gets no `pre_llm_call` context anyway [V]. Not every
host mode is confirmed to deliver `pre_llm_call` context (O2: MoA, `codex_app_server`);
where it doesn't, the feature is a silent no-op.

## Known limitations (README list grows from 3 to 5)

4. **Restored sessions get no live delivery** when the bootstrap memo is gone (`/resume`,
   `/branch`, process restart), because the host offers plugins no way to read the
   stored prompt (O6). An upstream ask would lift this.
5. **An agent-initiated CT tool call in such a restored session** can repeat a bootstrap
   fact, because the ledger cache can't know the bootstrap ids. This was already true of
   v1 for every session; this design closes it for all non-restored sessions.

## INTENT.md amendments (same PR)

1. "Intuitive Wisdom" paragraph: replace "matching trigger, judge involvement, and
   delivery surface … are **open design work**" with the decisions table above, by
   reference to this spec.
2. Delivery surface: "tool results are the v1-proven channel" → "host-persisted append
   channels: the user-message context (`pre_llm_call`) and tool results".
3. Invariant 1: "The ledger lives in CT's session context (keyed by session id); CT
   recall tools filter against it" → "The ledger is the transcript: delivered facts carry
   `ct-fact:<id>` markers and the ledger is rebuilt from host-persisted context; CT
   accepts exclude ids and returns corrections." Drop "(Ledger ownership and the
   supersession marker are new work — pending decisions.)" and define scope b.
4. v1 step 2: "semantic similarity" → name the lexical wiki leg honestly, and point to
   `ct wisdom match` as the semantic path.
5. Read-only retrieval: add `ct wisdom match` to the sanctioned recall surface.

## Testing

**Unit (stdlib unittest, fake `ct` on PATH that speaks the contract):**

- ledger rebuild from synthetic histories: str content, list parts, `api_content`, tool
  trailers, forged markers (suppress only);
- **exactly-once property test:** randomized sessions (bootstrap ids, N turns, random
  tool calls returning overlapping ids, random compaction dropping prefixes). Assert that
  no id appears twice in the reconstructed current context;
- post-filter holds when the ledger exceeds `EXCLUDE_MAX`;
- corrections render first with a `supersedes` marker; a correction for a non-ledgered
  id is dropped;
- the session budget switches to `--max 0` while corrections still flow;
- restored-session fail-closed; first-turn-without-memo proceeds;
- capability probe miss → no-op, and v1 bytes are unchanged;
- breaker opens after 3 failures and closes after the pause (injected clock);
- the sanitizer strips `<!-- ct-fact` (including the splice case) before the existing
  steps;
- the v1 block carries markers; an id-less entry is dropped; the memo stores ids; memoized
  renders stay byte-identical;
- the `transform_tool_result` stub, pass-through for other tools, parse-failure
  pass-through, and trailer emission;
- subprocess contract: argv shape, `stdin=DEVNULL`, timeout, `cwd=~`.

**e2e (scratch profile `ct-test` only, CT build with the contract):**

- a multi-turn CLI session where turn 3's message targets a seeded wiki fact: it is
  delivered once, and a later turn about the same topic does not repeat it;
- an agent-called `curated_recall_context` returns the stub for that id;
- the persisted `api_content` for the delivery turn is byte-identical on replay (read
  back from the session DB);
- an induced in-place compaction is followed by checking O3 behavior against the ledger
  rule;
- a deposit supersession followed by `ct` ingest, then the next turn: the correction
  arrives with its `supersedes` marker;
- `/resume`: no `wisdom-live` delivery lines (fail-closed path).

**CI:** existing matrix (3 OS × py3.9-3.13) + ruff; no new dependencies.

## Versioning and docs

- Hermes `plugin.yaml` / `integration.yaml` → **0.4.0**, plus a CHANGELOG entry.
- README: one paragraph on live delivery, the five-item limitations list, and the minimum
  CT version.
- Skills drift: `curated-thoughts-usage` tells the agent that `relevant now` blocks and
  `in_context` stubs are expected and that facts already in context need no re-recall.

## Out of scope

- Tool-event triggers (file touched, command run), and semantic-drift triggers. A later
  slice could add them behind the same ledger.
- System One judge wiring. That is CT-internal, behind `ct wisdom match`.
- Switching the v1 bootstrap query to `ct wisdom match`. It stays on `ct recall` and only
  gains id markers.
- DeepSeek Harness and other ports. They fork this design later, per INTENT ("reuse
  proven decisions").
- Any plugin-side persistence, and any integration write to CT.
