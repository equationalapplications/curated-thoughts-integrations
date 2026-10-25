# Changelog

## Unreleased

## 0.4.10 — 2026-10-25

- Internal: refresh the transitive `undici` (via node-gyp) to 6.29.1 to clear Dependabot security alert #35; dev-tooling scope. No behavior change.

## 0.4.9 — 2026-10-25

- Internal: pin `toml` to 5.0.1 via pnpm override to clear Dependabot security alerts #27-#28 (quadratic-complexity DoS in `toml.parse()`); config-parsing tooling scope. No behavior change.

## 0.4.8 — 2026-10-25

- Internal: bump the `vitest` dev dependency to 4.1.12 (carries `@vitest/mocker` 4.1.12) to clear Dependabot security alerts #24-#25; test-tooling scope. No behavior change.

## 0.4.7 — 2026-10-25

- Internal: bump the `vite` dev dependency to 6.4.4 (exact pin) to clear Dependabot security alerts #19-#23; all dev-server/test-tooling scope. No behavior change.

## 0.4.6 — 2026-10-18

- Fixed: on Windows, stopping `ct` (timeout, cancel or output cap) now also stops the processes it started, using Windows' own `taskkill /T /F` by its full system path; if that fails, the old direct stop is used. No change on macOS or Linux.

## 0.4.5 — 2026-10-17

- Internal: the pre-flight census tests get a 20 s timeout (they ran past 5 s on Windows CI). No behavior change.

## 0.4.4 — 2026-10-17

- **Fix: a `ct` that hangs past the activity budget now counts against the breaker.** The miss is charged when the budget runs out, not when the query settles (which a hung child never did), so a `ct` that keeps hanging pauses CT after three misses, as on DSH and Hermes.

## 0.4.3 — 2026-10-17

- **Fix: no more hang when a killed `ct` never closes its output** (Windows, or a child process that escaped its process group). The spawn binding now lives in the shared core: one kill path, a 250 ms grace for the output to close once `ct` has exited (for any reason, so a background helper holding the output open no longer turns a finished call into a timeout), no signal to a child that never started or already exited, output capped with no gap after the cap, and a call aborted before it starts spawns nothing.

## 0.4.2 — 2026-10-17

- Budget misses now count once toward the failure pause (shared core rule
  `recordActivityBudgetMiss`: one failure per miss on every host; DeepSeek
  Harness additionally clears it when the `ct` child had already
  answered). No other change.

## 0.4.1 — 2026-10-17

Robustness and cost fixes for autonomous-work delivery (post-merge review of
0.4.0). Delivery semantics are unchanged.

- Cheap gates first: an unknown session, a latched-off `ct`, or an open
  breaker now costs no `session.messages` fetch.
- No spawn with less than 200 ms of the 3 s budget left; nothing is recorded
  as tried, so the activity can trigger later.
- A failing `session.get` is remembered for 10 s instead of being retried on
  every tool call, and the plan-time wait is capped at 300 ms.
- An aborted spawn reports `aborted: true`, which the shared core
  classifies as its own outcome and never counts toward the breaker. The
  abort listener is removed on every exit path. (Counting a budget miss as
  one breaker failure comes from the shared core in a follow-up, for every
  host alike.)
- Internal: the gate host delegates explicitly to the adapter; the unused MCP
  placement branches are gone (only builtin tools are planned); one expiry
  rule for not-yet-persisted ids; one shared object guard.

## 0.4.0 — 2026-10-17

- Added: Intuitive Wisdom during autonomous work. While the agent works on
  its own, each approved `read`/`write`/`edit`/`grep`/`glob`/`bash` call can
  bring one fact (≤ 600 chars), appended marker-first to that tool's result
  (`## Curated Thoughts — relevant to this step`), persisted with the
  session and never repeated (the ledger scans the session's own tool
  outputs, plus a process-local set for parallel results that are not
  persisted yet). At most one CT call per model step, only on a new file,
  command or search key; the query is the bare target from the shared
  `ct-wisdom-core` builder (all 290 shared privacy vectors pass through this
  binding). The query starts in `tool.execute.after`, because OpenCode asks
  permission after `tool.execute.before` and exposes no approval result to
  plugins: a call the host refuses sends nothing. Subagent sessions are
  included (own ledger); per-message delivery stays parent-only. CT tools
  and experimental code-mode child calls never trigger. Verbose mode reports
  these on channel `activity`. One 3 s deadline covers the whole hook
  (session lookups included); on expiry the `ct` child is killed and the
  key, not the step, is freed for a later step. Not-yet-persisted ids
  expire (60 s) and are dropped when the step is aborted or undone.
  Spec: `docs/superpowers/specs/2026-10-17-opencode-autonomous-work-wisdom-design.md`.
- Tests: binding vectors and golden blocks, rate/coalescing, subagents,
  fail-closed, verbose byte-identity, a randomized exactly-once test with
  parallel activity steps, refused calls, recalls, compaction and restarts;
  a real-binary host-contract test; an opt-in real-gate live e2e
  (`CT_E2E_REAL_GATE=1`). The e2e image now carries the `ct` 3.5.1 CLI and
  pnpm (test-only provisioning).

## 0.3.1 — 2026-10-16

- Fixed (shared `ct-wisdom-core`): a live delivery could show a fact twice
  when CT returned a correction whose own id was already in context, or the
  same id both as an entry and as a correction. A correction now rides only
  when it supersedes an id in context and is itself new, and each id is
  delivered at most once per block. This deliberately aligns the TypeScript
  core with the Hermes reference (`ct_wisdom_live.render_live_block`) and
  the live-delivery spec's step 7. Also fixed: the block and query caps
  now count and cut by code point, so a cut never splits an emoji or other
  non-BMP character (the Python hosts already did). The core
  also gained the autonomous-work activity API for a later OpenCode leg;
  OpenCode does not call it yet, so there is no other behavior change.
  Why dropping a correction loses nothing: CT emits a correction only for
  an id the plugin sent in `--exclude`, which is always a fact in context
  (the live-delivery spec, CT guarantee 3). A correction that supersedes
  nothing in context can only come from a stale exclude list, and its job
  (marking a fact the agent sees as replaced, INTENT rule 3) has no target.
  A newer fact that replaces something the agent has NOT seen is an ordinary
  fact: CT returns it in `entries` whenever it matches the query, and it is
  delivered like any other (CT guarantee 2 keeps the superseded one out).

## 0.3.0 — 2026-10-16

- Added: Verbose mode for Intuitive Wisdom (opt-in, off by default). With
  `CT_WISDOM_VERBOSE=1`, every live-delivery decision is recorded: the
  delivered block with its fact ids, titles, provenance and CT's scores, or
  the reason nothing was delivered (`deduped`, `no_match`,
  `gate_uncalibrated`, `budget`, `breaker_open`, a timeout, ...). It goes to a
  local JSON Lines log (`CT_WISDOM_VERBOSE_LOG` overrides the path) and to a
  channel the user sees and the model does not. Verbose output never changes
  the system prompt, the delivered block or any tool result; with verbose off
  the hooks behave and return exactly as before (tests compare both).
  Spec: `docs/superpowers/specs/2026-10-16-wisdom-verbose-mode-design.md`.
  On OpenCode the notice is a TUI toast (`client.tui.showToast`): what was
  delivered, with titles, or why nothing was. The log is
  `$XDG_DATA_HOME/opencode/log/ct-wisdom-verbose.jsonl` (default
  `~/.local/share/opencode/log/`), next to OpenCode's own logs. Reader:
  `node lib/ct-wisdom-core/cli/ct-wisdom-log.js --host opencode` from the
  installed plugin directory.

## 0.2.1 — 2026-10-16

- Changed: Intuitive Wisdom live delivery has no per-session cap. The
  vendored shared core drops `MAX_PER_SESSION = 12` and the `--max 0`
  switch, and `Ledger.liveDeliveredCount` (read only by the cap) is
  removed, with the adapter's live-part count.
  Why: an autonomous agent is better served by more wisdom than less. The
  cap stopped delivery after about 6 matching turns, though a fact that
  matches late in a session is as valuable as an early one. Noise stays
  bounded per turn (at most 2 facts in a 1200-character block, only facts
  past CT's relevance gate), delivery never touches the system prompt, and
  dedup keeps the session total to the distinct facts that match.
  Unchanged: the per-turn limits, CT's score gate, dedup and exactly-once
  delivery, the breaker, timeouts and the 256-id exclude bound.

## 0.2.0 — 2026-10-16

New: **Intuitive Wisdom live delivery** for OpenCode. This is the cross-harness
parity OpenCode leg. Specs: `docs/superpowers/specs/2026-10-09-cross-harness-wisdom-parity-design.md`
and the leg refinement `docs/superpowers/specs/2026-10-16-opencode-wisdom-parity-leg-design.md`.

- **v1 bootstrap (new for OpenCode).** On a session's first turn the plugin
  recalls the brain's wisdom layer:
  - it runs `ct recall "curated thoughts agent memory wisdom procedures"
    --json --k 3`;
  - it attaches the sanitized block (at most 2500 chars, one
    `<!-- ct-fact:<id> -->` marker per fact) to the user's message as a
    `synthetic: true` part.
  It renders only once per session. Later turns and later processes find the
  block's ids in the saved history.
- **Live delivery (`chat.message`).** Before each user turn reaches the model,
  the plugin:
  - asks `ct wisdom match` (CT ≥ 3.3.0 owns relevance) about the user's own
    text;
  - drops anything already in context;
  - appends up to 2 facts per turn (1200-char block, at most 12 facts per
    session; corrections are exempt) as another `synthetic: true` part.
  The parts are saved by OpenCode, so the system prompt and its provider
  cache are never touched.
- **Exactly once.** Each turn the list of delivered facts is rebuilt from the
  saved session (`client.session.messages()`); the plugin keeps no store of
  its own. It survives `--continue` and restarts. Compaction carries every
  delivered fact forward on purpose: a fact compacted out of context is never
  re-delivered (parent decision 3).
- **Recall dedup (`tool.execute.after`).** When the agent calls
  `curated_recall_context` itself, entries already in context are rewritten to
  one-line stubs, and the facts it brings in are tagged so later turns know
  them.
- **Main sessions only.** Subagent (child) sessions receive no bootstrap and no
  live delivery. Their recall results are deduped against the parent's context.
- **Self-trigger guard.** Only the user's genuine text drives a match.
  Synthetic parts, ours or OpenCode's, never do, and a re-fired hook delivers
  nothing more.
- **Failure handling.** Failures are silent and bounded:
  - a missing `ct`, or one without `wisdom match`, makes the plugin a no-op;
  - three consecutive failures open a five-minute pause;
  - each `ct` call has a 3 s budget.

**Host pin:** OpenCode `1.18.31` → `1.18.35`, for both `opencode-ai` and
`@opencode-ai/plugin` (the hook types are byte-identical). The host contract
now runs the real built plugin against the real binary end to end (bootstrap,
live append, recall rewrite, and no redelivery across two processes).

**Packaging:** the plugin now depends on the workspace-internal
`@equational-applications/ct-wisdom-core`. The build copies it into
`lib/ct-wisdom-core/` and rewrites the import to a relative path, so the
installed payload still runs with no `node_modules`. No installer change is
needed.

**Known caveat:** auxiliary OpenCode calls such as title generation re-read the
session and see delivered parts. Exactly-once is not affected.

## 0.1.2 — 2026-10-09

Dependency hygiene release: bump the transitive `source-map-js` 1.2.1 → 1.2.2
(Dependabot #11, GHSA-68fv-2mgg-jv7q, development scope only, reached via
`postcss`). Lockfile-only change; no shipped code or behavior is affected.

## 0.1.1 — 2026-10-09

Ships the live-wisdom usage guidance ("Wisdom that arrives on its own") in the
`curated-thoughts-usage` skill, byte-identical to the Hermes integration, so
agents on any harness read the same provenance, `in_context`, and supersession
rules.

## 0.1.0 — 2026-09-18

Initial release. OpenCode plugin wires the Curated Thoughts MCP sidecar,
registers a bounded health snapshot in the system prompt (refreshed once per
session via the `system` transform), and ships three skills ported from Hermes
(`curated-thoughts-usage`, `curated-thoughts-ops`, `curated-thoughts-sidecar`).
Ships a `ct_doctor.ts`, a provenance pre-flight (`ct_preflight.ts`), and a
preview-first POSIX `install.sh` that stages the payload, loader file, skills,
and the `mcp` entry in `opencode.json`. Delivered as a GitHub release tarball
(`opencode-v<version>`); no npm publish.
