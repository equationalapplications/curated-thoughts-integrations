# Claude Code leg: Intuitive Wisdom live delivery (claude-code 0.2.0) — design

**Date:** 2026-10-16 · **Status:** Approved (autonomous — design judgment delegated by Kurt; no open questions) ·
**Repo:** equationalapplications/curated-thoughts-integrations ·
**Base:** `origin/fix/shared-env-doctor-parity` @ `24970b5` (PR #41, not yet merged) ·
**Branch / PR:** `feat/claude-code-wisdom-parity` (PR base `fix/shared-env-doctor-parity`).
**Parent spec:** `2026-10-09-cross-harness-wisdom-parity-design.md` (decision 4 a–e, M2, N3 rule m4,
N5 table, AC 1–11, annex A). **Plan:** `docs/superpowers/plans/2026-10-16-claude-code-wisdom-parity-leg.md`
(parent plan Task 4). **Env API:** `2026-10-16-shared-env-doctor-parity-design.md` ("Final API").

> **Amendment 2026-10-16:** the per-session cap (annex M1, `live_delivered_count`) was removed on every
> host by user decision; the per-turn limits (2 facts, 1200 chars) are unchanged.
> The store's `live_ids` list stays: it is part of the ledger. See [`2026-10-16-remove-session-wisdom-cap-design.md`](2026-10-16-remove-session-wisdom-cap-design.md).
> The text below is kept as the historical design.

## Problem

The Claude Code plugin (0.1.1) emits only a status section at `SessionStart`. It has no
bootstrap wisdom block, no per-turn delivery, and no dedup of agent-initiated recall. This
leg ports the Hermes 0.4.x behavior (annex A) to Claude Code's hook surface, under the
Claude Code policies the parent spec binds (decision 4). Nothing here changes Hermes.

## Verified host facts (Claude Code 2.1.301, 2026-10-16)

Two sources. **[D]** is a quote from the official docs (code.claude.com/docs/en/hooks,
/plugins-reference, /headless, /sessions, /cli-reference, fetched 2026-10-16). **[E]** is
observed in a live, isolated run of the local `claude` 2.1.301 CLI: temp `HOME` and
`CLAUDE_CONFIG_DIR` under the session scratchpad, `--plugin-dir` with a hook-recorder
plugin, a stdio fake MCP server named `curated-thoughts` passed through
`--mcp-config --strict-mcp-config`, and the ZAI Anthropic-compatible endpoint
(`GLM-5.3-FLASH`). The user's real `~/.claude` was never read or written.

| # | Fact | Evidence |
|---|---|---|
| F1 | `UserPromptSubmit` input: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `prompt`, `prompt_id` ("UUID identifying the user prompt currently being processed … Absent until the first user input"); `session_title` when set. | [D] [E] |
| F2 | `UserPromptSubmit` also fires on non-typed input: "A scheduled task firing, including a `/loop` iteration · A background subagent reporting back to the session that started it · A message another session sends to your main conversation". No input field names the origin. | [D] |
| F3 | A background-subagent report arrives as a main-thread `UserPromptSubmit` with **no** `agent_id`, a fresh `prompt_id`, and a `prompt` that starts `<agent-message from="…">`. | [E] |
| F4 | A subagent's own first prompt does **not** fire `UserPromptSubmit`. Hooks inside a subagent carry `agent_id` + `agent_type` (seen on `SubagentStart` and on `PostToolUse` of an MCP call made by the subagent). Main-thread events carry neither. `agent_type` alone also appears on the main thread of a `--agent` session [D]; `agent_id` is "for the subagent or in-process teammate the hook fires in" [D]. | [D] [E] |
| F5 | Slash commands (`/compact`, `/clear`) do not fire `UserPromptSubmit`; `/skill` runs fire `UserPromptExpansion`. | [D] [E] |
| F6 | `UserPromptSubmit` output `hookSpecificOutput.additionalContext` is injected "alongside the submitted prompt" as a system reminder — not the system prompt. Capped at 10,000 chars (over ⇒ saved to a file, path + 2,000-char preview). Default timeout 30 s; timeout discards the output and the prompt proceeds. | [D] |
| F7 | Hook-injected context is persisted as `attachment` / `hook_additional_context` records in the session JSONL and **replayed on `--resume`** (a startup `SessionStart` marker and a `UserPromptSubmit` marker were both visible to the model after resume). | [E] |
| F8 | `PostToolUse` for an MCP tool: `tool_name` = `mcp__curated-thoughts__curated_recall_context`; `tool_response` is the MCP **content-block array** `[{"type":"text","text":"<CT JSON>"}]`; plus `tool_input`, `tool_use_id`, `duration_ms`, `mcp_server: {"name","source"}`. | [D] (fields) [E] (shape) |
| F9 | `hookSpecificOutput.updatedToolOutput` "replaces the tool's output … The value must match the tool's output shape"; `updatedMCPToolOutput` is MCP-only and the docs say "Prefer `updatedToolOutput`". Returning the content-block array with rewritten text replaced what the model saw, and the **transcript stores only the rewritten text** (the original string never reached the JSONL), so the stub survives resume. | [D] [E] |
| F10 | `SessionStart.source` ∈ `startup`, `resume` (`--resume`, `--continue`, `/resume`), `clear`, `compact`, `fork` ("Before v2.1.214, forked sessions reported source `resume`"). | [D] |
| F11 | `--resume <id>` keeps `session_id` byte-identical and fires `SessionStart(source=resume)`. `/compact` keeps `session_id` and fires `SessionStart(source=compact)`. | [E] |
| F12 | **`/clear` starts a NEW `session_id`:** `SessionEnd(reason=clear)` for the old id, then `SessionStart(source=clear)` with a fresh UUID. | [E] |
| F13 | After `/compact`, context recorded before the `compact_boundary` (including the startup `SessionStart` attachment) is gone except as the model-written summary; the `SessionStart(compact)` context is what is live. | [E] |
| F14 | `CLAUDE_PLUGIN_DATA` — "`~/.claude/plugins/data/<id>/`, created on first reference and kept across plugin updates"; "every hook process receives `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` in its environment". Observed under `$CLAUDE_CONFIG_DIR/plugins/data/<name>-inline/` for a `--plugin-dir` load, both as an env var and via `${CLAUDE_PLUGIN_DATA}` substitution in the command. | [D] [E] |
| F15 | Exit codes: non-zero other than 2 ⇒ "The action goes ahead"; exit 2 blocks `UserPromptSubmit`. We always exit 0. | [D] |

Not established (named, not relied on): whether a scheduled-task / `/loop` prompt or a
cross-session message carries a recognizable wrapper (F2 says they fire; their text shape was
not observed). The rule below handles the first two classes only by shape, so scheduled
prompts whose text looks like plain user text **will** be treated as user turns. This is a
named residual risk; it is benign for exactly-once because the ledger still applies.

## Decisions

### D1 — The Hermes core is vendored byte-identical, not imported across trees

The parent architecture line says `hooks/wisdom.py` imports `integrations/hermes/scripts/`
("no copy"). That cannot work for an installed plugin. Claude Code loads a plugin from its
own directory (`--plugin-dir`, or the marketplace cache), and the release tarball is
integration-scoped (`tools/ct_ci_package.py`), so `../hermes/` does not exist at runtime.
The arch gate also rejects cross-integration imports (CONTRIBUTING rule, `gate_arch`), and
the 2026-10-16 env spec D3 already settled the pattern: committed copies plus a parity gate.

So `ct_ledger.py`, `ct_wisdom.py` and `ct_wisdom_live.py` are copied **byte-for-byte** from
`integrations/hermes/scripts/` into `integrations/claude-code/scripts/`, and
`tests/tools/test_shared_script_parity.py` adds them to its `IDENTICAL` list. The algorithm
has one source (Hermes), and any drift fails the `policy` job on every PR. Their docstrings
still say "Hermes". They are not edited, because editing them would force a Hermes release
for prose.

*Alternatives:* (a) `sys.path` to `../../hermes/scripts` — breaks every installed plugin.
(b) Package-time vendoring in `release.yml` — `--plugin-dir` and marketplace installs read
the git tree, not the tarball, so they would ship without the core. (c) Fork the logic into
a Claude Code-specific module — the "N copies drift" class again, with no gate.
(d) Neutralize the docstrings first — this needs a Hermes bump for prose. Deferred.

### D2 — One adapter module, `hooks/ct_wisdom_cc.py`, dispatching on `hook_event_name`

It holds all Claude Code-specific logic: the provenance filter, the store, the persisted
breaker, the SessionStart rules, the PostToolUse rewrite, and the I/O envelopes. Algorithm
pieces come from the vendored core: `discover_ct`, `recall_wiki`, `query_for`,
`render_block`, `has_match_capability`, `match_wisdom`, `render_live_block`, `user_text`,
the frozen constants, and `ct_ledger.scan_ids`/`valid_id`. `hooks.json` runs it directly for
`UserPromptSubmit` and `PostToolUse`, and `session-start.py` imports it for the bootstrap.

*Name:* the parent spec said `hooks/wisdom.py`. `gate_arch` allows only stdlib plus a closed
list of sibling module names (`STDLIB_ALLOWLIST`). Adding a bare `wisdom` there would whitelist
any third-party package of that name, so the module takes the repo's `ct_` prefix and the
allowlist gains `ct_wisdom_cc`.

*Alternatives:* three entry scripts (one per event) — more files, same logic. Putting the
adapter in `scripts/` — `scripts/` is the shared, parity-gated tree, and this module is
Claude Code-only.

### D3 — The ledger is the `${CLAUDE_PLUGIN_DATA}` store, and nothing else (decision 4c)

`<data>/wisdom/sessions/<key>.json`, one file per `session_id`. The key is the id itself
when it matches `[A-Za-z0-9_-]{1,128}` (Claude Code ids are UUIDs), and a sha256 hex digest
otherwise.

```json
{"v": 1, "session_id": "…", "state": "on" | "off", "off_reason": null | "resume" | "clear_same_id" | "fork" | "unknown_source",
 "bootstrap_block": "…", "bootstrap_ids": ["…"], "live_ids": ["…"], "tool_ids": ["…"],
 "order": ["…"], "updated": 1760000000.0}
```

* ledger = `bootstrap_ids ∪ live_ids ∪ tool_ids`. `order` is append-only, so
  `exclude = unique(reversed(order))[:EXCLUDE_MAX]` — newest first (annex m8).
* `live_delivered_count = len(live_ids)` (annex M1; Hermes counts user-role markers,
  corrections included, and so do we).
* The data dir is read from the hook's env through `ct_env.merged_env(env)` — the one
  public-boundary merge the env spec requires. It is unset or empty ⇒ there is no store ⇒
  live delivery never runs.
* Writes: the session file is locked (`fcntl.flock`, or `msvcrt.locking` on Windows) for
  read-modify-write, and written with tmp + `os.replace`. `PostToolUse` can run in parallel
  for parallel tool calls, so the lock is mandatory.
* **The transcript is never opened.** `transcript_path` is ignored (a test asserts the
  module never reads it).
* Missing store, corrupt store, wrong `session_id` or `v` ⇒ **fail closed**: no live
  delivery and no stubs.
* Housekeeping: `startup` deletes session files whose mtime is older than 30 days.

*Alternatives:* transcript-derived ledger (Hermes-style) — forbidden by 4c. One shared
store file — global lock contention across sessions, and a corrupt file poisons every
session.

### D4 — Write the store before emitting: at-most-once over at-least-once

`UserPromptSubmit` records `live_ids` **before** it prints `additionalContext`. If the hook is
killed between the two steps (timeout, F6), that fact counts as delivered without being
seen. That is a lost delivery, never a duplicate, which is the INTENT ordering (exactly-once,
failing toward silence). `SessionStart` likewise writes the store before it emits the block.
A block whose store write failed still renders. Its ids are unknown, so the missing store
keeps live delivery off.

### D5 — Provenance filter (decision 4a): a genuine user turn must prove itself

A `UserPromptSubmit` payload counts as a genuine user turn only if **all** of these hold:

1. `hook_event_name == "UserPromptSubmit"`;
2. `session_id` and `prompt_id` are non-empty strings (F1: `prompt_id` exists exactly for
   user prompts being processed);
3. `agent_id` is absent or empty (F4; `agent_type` alone is the `--agent` main thread and is
   allowed);
4. `prompt` is a non-empty string;
5. the prompt, after leading whitespace, does **not** start with a harness envelope tag:
   `<` + `[A-Za-z][A-Za-z0-9_-]*` + whitespace, `>` or `/`. This catches `<agent-message …>`
   (F3) and any `<task-notification>`, `<teammate-message>`, `<cross-session-message>`,
   `<system-reminder>`, `<command-name>`, `<local-command-stdout>`, `<bash-input>`-style
   wrapper. A human prompt that genuinely starts with a tag is skipped (fail-safe: no
   delivery, nothing breaks).

Any failure ⇒ skip, with nothing written. Residual risk: scheduled prompts (see
"Not established").

*Alternatives:* an allowlist of known wrapper tags only — new wrappers would leak through,
so it fails open. Reading the transcript to see the message's role/origin — forbidden by 4c.

### D6 — Main-thread only (decision 4b)

`agent_id` present ⇒ `UserPromptSubmit` skips (rule 3). `PostToolUse` passes through
untouched and writes nothing: the subagent's context is not the main thread's, so stubbing
there would hide facts the subagent never saw, and recording its ids would suppress main-
thread delivery of facts the main thread never saw. Residual risk (4e): a subagent's report
can quote a fact that live delivery later sends to the main thread. That duplicate is in
the model's view but not ours; mitigation is 4b itself.

### D7 — SessionStart source rules (decision 4d + M2), encoded from F10–F13

| `source` | Store before | Action | Bootstrap emitted |
|---|---|---|---|
| `startup` | any | **re-seed**: `state=on`, fresh render's ids | fresh render (recall) |
| `clear`, unknown id | none | **fresh** (= startup) | fresh render |
| `clear`, known id | exists | **OFF for life** (`clear_same_id`); keep ids | fresh render (context was wiped) |
| `resume` | exists | **OFF for life** (`resume`); keep everything | **none** — the original is in the replayed transcript (F7) |
| `resume` | none | create `state=off` (`resume`) | fresh render, recorded |
| `compact` | exists, on | **continues**; ledger untouched | **replay** the stored block byte-identically (F13: the original is gone) |
| `compact` | exists, off | stays off | replay the stored block |
| `compact` | none | nothing written (still fail-closed) | fresh render, not recorded |
| `fork` / other | any | `state=off` (`fork` / `unknown_source`) | fresh render, recorded |

* **`/clear` is empirical and fail-closed.** F12 shows `/clear` mints a new id on 2.1.301, so
  in practice it is a fresh session. The rule does not depend on that. A `clear` whose id the
  store already knows is exactly the "retained id with wiped context" case in decision 4, and
  it latches OFF. Both branches are tested.
* `fork` joins the hooks.json matcher (`startup|resume|clear|compact|fork`). A forked
  session holds its parent's history, so its ids are unknowable ⇒ OFF. Without the matcher
  entry, a fork would get no status block and no bootstrap. It would still fail closed,
  because no store exists.
* **OFF has no re-arm path.** Only `startup` re-seeds (or `clear` with a fresh id, which is
  a new session).
* The status section (`ct_status.context_section()`) keeps being emitted on every source.
  The bootstrap block is appended after it, separated by a blank line, in the same
  `additionalContext`.
* Replay-on-compact keeps one marker-bearing copy of the bootstrap live (Hermes parity: its
  bootstrap lives in the system prompt and survives compaction), and the ledger is not
  touched, so live delivery after compaction excludes those ids (AC 2).

### D8 — `UserPromptSubmit` delivery = annex A over the store

The order is fixed: provenance (D5) → store present and parseable → `state == on` (latch,
before anything else) → breaker → `query = user_text(prompt)` → `discover_ct(env=view)` →
`has_match_capability` → `max_n = 0 if len(live_ids) >= 12 else 2` →
`match_wisdom(path, query, max_n, exclude)`. The lock is **not** held across the match. The
store is re-read after it. Then post-filter against the fresh ledger with
`render_live_block` (cap 1,200 chars, corrections first, only if they supersede something in
the ledger), write `live_ids`/`order`, and emit
`{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": block}}`.

Failure actions follow Hermes: `timeout`/`exit` ⇒ breaker failure, `spawn` ⇒
`reset_discovery_cache` + `reset_capability_cache` (process-local, so moot, but kept for
fidelity), success ⇒ breaker reset.

**Persisted breaker.** Each hook is a fresh process, so the in-memory `Breaker` cannot
count. `<data>/wisdom/breaker.json` holds `{"count", "open_until"}` (wall clock), with the
Hermes thresholds `BREAKER_FAILS = 3`, `BREAKER_PAUSE = 300 s`. It is machine-wide, the
analogue of Hermes's per-process breaker on a multi-session gateway. A corrupt file reads as
closed: fail-open on availability, which is safe, because the breaker only ever suppresses.

**Capability probe** — not persisted (YAGNI). Each turn spends at most 3 s (identity probe)
+ 3 s (`match --help`) + 3 s (match). The `UserPromptSubmit` hook timeout is 15 s.

### D9 — `PostToolUse` stub rewrite (rule m4)

* `hooks.json` matcher `mcp__.*__curated_recall_context`. The code re-checks:
  `tool_name` starts with `mcp__` and ends with `__curated_recall_context`.
  `curated_get_wiki_entry` and everything else pass through.
* Precondition: main thread (D6), store present, `state == on`. Otherwise pass through.
  Hermes parity: a restored session has no cached ledger, so it never stubs.
* Envelope: `tool_response` is a content-block list (F8). For each `{"type": "text"}` block
  whose `text` parses as a JSON object with a `wiki_entries` list (the CT recall envelope),
  an entry whose valid `id` is in the ledger becomes the Hermes stub
  `{"id", "in_context": true, "note": "already in context: ct-fact:<id>"}`. Other new valid
  ids are recorded in `tool_ids`. Raw text that does not parse is never touched. A dict
  `tool_response` with a `content` list gets the same treatment, defensively, in case the
  host shape changes; any other shape passes through.
* Output only when something was stubbed:
  `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "updatedToolOutput": <same-shape list>}}`.
  When nothing was stubbed, the ids are recorded and nothing is emitted, so the tool output
  stays byte-for-byte.
* No `ct-fact:` trailer markers (Hermes appends them so its *transcript* scan finds tool
  ids). Here the store is the ledger, so the markers would only change bytes for nothing.

### D10 — Marker hygiene (AC 5)

Ids reach the store from three places only. (1) `scan_ids(bootstrap_block)`: the block is
rendered by `render_block`, whose `_sanitize` strips every `ct-fact:` token from titles and
text before the id marker is added, so only real ids are scanned. (2) `render_live_block`'s
`delivered` list: validated `item["id"]`, never text. (3) The `id` field of recall entries,
validated with `valid_id`. Entry text is never scanned. A fact whose text carries a forged
`ct-fact:evil` therefore never adds `evil` to the ledger. A forged id field could only add
an id, and adding an id only ever suppresses delivery, never duplicates it.

## Release

claude-code **0.1.2 → 0.2.0** (minor: new capability; PR #41 head `24970b5` ships 0.1.2
and hermes 0.4.2). `integration.yaml` `version` and `.claude-plugin/plugin.json#version`
are both set to 0.2.0. The CHANGELOG gets `## 0.2.0 — 2026-10-16` above `## 0.1.2`, and the
empty `## Unreleased` heading stays in place. Hermes is untouched, so it gets no bump. The
top-level README is out of scope (revised separately); the claude-code README gains a
"Wisdom" section.

## Acceptance criteria → evidence (this leg)

| AC | Obligation | Evidence |
|---|---|---|
| 1 | import path green | parity gate (3 vendored core files byte-identical) + `ImportPathTests` (adapter imports the vendored modules from `scripts/`, not from Hermes) |
| 2 | exactly-once randomized incl. compact-continues and clear/resume-OFF | `tests/test_exactly_once_cc.py` (200 sessions, seeded) |
| 3 | ledger = what the next trigger reads | store round-trip tests; "transcript never read" test |
| 4 | fail-closed: probe absent, breaker, resume | `FailClosedTests` |
| 5 | marker hygiene | `MarkerHygieneTests` |
| 6 | manifests + tests | version 0.2.0 mirror, hooks.json registration tests |
| 7 | CI tier | shape-level only (no host in CI): hook registration + unit; `ct_ci.py` gates |
| 8 | CHANGELOG / README | `## 0.2.0 — 2026-10-16`; claude-code README section |
| 10 | live e2e | isolated `claude` 2.1.301 run (plan Task 6); `ct` is a test wrapper (no local CT, no embedder) — see the PR |
| 9, 11 | OpenClaw / OpenCode / DSH only | n/a |

### Live e2e record (AC 10, 2026-10-16)

The setup was the real `claude` 2.1.301 with this plugin loaded via `--plugin-dir`, the real
hooks and the real `${CLAUDE_PLUGIN_DATA}` store. It ran in an isolated temp `HOME` +
`CLAUDE_CONFIG_DIR`, against ZAI `GLM-5.3-FLASH`. **Stand-ins:** `ct` is a test wrapper. It
passes the identity probe, `recall` returns the fixed fact `e2e_boot`, and `wisdom match`
returns the fixed fact `e2e_live` *even when excluded*, which exercises our post-filter. The
MCP sidecar is a stdio fake whose `curated_recall_context` returns `e2e_live` and
`e2e_other`. No local CT relevance gate or embedder exists on this machine, and none was used.

1. **startup + live + stub.** `SessionStart` context carried `ct-fact:e2e_boot`, and the
   store seeded `bootstrap_ids = [e2e_boot]`. `UserPromptSubmit` context carried
   `ct-fact:e2e_live`, with `ct wisdom match --exclude=e2e_boot`. The model's recall call
   came back with `e2e_live` as `{"in_context": true, …}` and `e2e_other` intact. The store
   ended at `live_ids = [e2e_live]`, `tool_ids = [e2e_other]`.
2. **resume.** The same `session_id`. `SessionStart(resume)` emitted the status only (no
   bootstrap re-emit). The store went `state = off`, `off_reason = resume`. No
   `ct wisdom match` call was made, no `UserPromptSubmit` context was injected, and the model
   still answered from the replayed history.
3. **compact + clear** (a single `--input-format stream-json` session). Turn 1 delivered
   `e2e_live`. `/compact` replayed the bootstrap (`ct-fact:e2e_boot`) after the
   `compact_boundary`. Turn 2 called `match` with `--exclude=e2e_live --exclude=e2e_boot`
   (newest first). The wrapper returned `e2e_live` anyway and **nothing was injected** (the
   post-filter held). The model reported `e2e_live` survived only as summary paraphrase.
   `/clear` produced a **new** `session_id` (F12, reconfirmed). The new id got a fresh store,
   a fresh bootstrap and a fresh `e2e_live` delivery.

## Self-review

* Placeholders: none. Every threshold is named and has a value.
* Consistency: the D7 table covers every `source` value, and D3's fail-closed list matches
  D8 and D9 preconditions. D4 ordering matches D7 ("writes store before it emits").
* Scope: Claude Code only. No Hermes, opencode, deepseek, openclaw or `packages/` changes.
  The `tools/` changes are an allowlist name and the parity list.
* Ambiguity resolved: "bootstrap still renders" on resume means the original stays in the
  replayed transcript (F7), and nothing new is re-emitted when the store has it. Re-emitting
  would put the bootstrap in context twice.
