# Changelog

## Unreleased

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
