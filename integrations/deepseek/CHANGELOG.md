# Changelog

## Unreleased

## 0.6.2 — 2026-10-17

- Fixed: an autonomous-work query that runs past its 3 s budget is now
  stopped. The pre-step aborts it on expiry and the `ct` child (its whole
  process tree, the capability probe included) is killed, so it no longer
  keeps running in the background. The miss counts as exactly one failure
  toward the five-minute failure pause (the shared core rule
  `recordActivityBudgetMiss`, the same on every host). The activity can
  still trigger again at a later step; the step that missed keeps its one
  query (the key is freed, the step is not).

## 0.6.1 — 2026-10-17

- Changed (no behavior change): the autonomous-work budget wait uses the
  shared `settleWithin` from `ct-wisdom-core` instead of a private copy
  (review of the OpenCode leg, PR #66: one helper for every host). The
  shared core also gained optional abort support for `ct wisdom match`
  (used by OpenCode to kill a timed-out query) and
  `ActivityTracker.releaseKey`; DeepSeek Harness does not pass a signal and
  keeps its per-step `release`.

## 0.6.0 — 2026-10-16

- Added: Intuitive Wisdom during autonomous work. While the agent works on
  its own between user messages, what it does (the file it reads, writes or
  edits, the command it runs, the pattern it searches) can bring one relevant
  CT fact, delivered before the next model step. Spec:
  `docs/superpowers/specs/2026-10-16-dsh-autonomous-work-wisdom-design.md`.
  - Trigger: `agent/pre-step` at step 2 and later of a turn, from the
    previous step's tool calls (`read`, `write`, `edit`,
    `str_replace_editor`, `grep`, `glob`, `bash`, `pwsh`). The CT call is
    prefetched at `tools/pre-execute` once the call is approved (a denied,
    cancelled or pending call sends nothing), so it overlaps the tool's own
    work; the pre-step only delivers a prefetched answer and never starts a
    query itself. A query that got no answer (a timeout, CT down, the 3 s
    budget) leaves the activity free to trigger again at a later step.
  - At most one CT call per model step, and only when the activity key is
    new (a new file, command or search; reading then editing a file is one
    key). No per-message ceiling and no session cap.
  - The query is the bare target only, under the hermes 0.6.5 privacy
    rules with the same shared test vectors
    (`tests/fixtures/activity_targets.json`, all 206 run in the core suite):
    - a path is sent only when it resolves inside a project root (the
      nearest directory at or above the session's working directory, from
      DSH's session header, holding `.git`, `package.json`,
      `pyproject.toml`, `Cargo.toml`, `go.mod`, a `*.sln` or an empty
      `.curated-thoughts-project`, among others), relative to that root.
      Home directories and their parents, `/`, `/Users`, `/home` and other
      homes locations are never a root. Files outside a project get no
      autonomous-work wisdom;
    - nothing that names you is sent (your user name, also inside a word);
    - a command sends only a bare program name (`rm`, `cat`, `pytest`; a
      script or a path as the program sends nothing), plus a known verb for
      known subcommand tools (`pnpm test`, `git rebase`, `make build`) or a
      known or in-project `python -m` module; never a path or file name
      (the hermes 0.6.6 command rules);
    - a search pattern is sent only when it is plain words (letters,
      digits, `_`, `.`, `-`; at most 6 words and 80 characters) with no
      auth word such as `token` or `password`.
    Never file contents, tool output, diffs, the agent's text, flag values,
    quoted words, URLs, env assignments or credential-shaped tokens.
  - The gates are the user-turn ones and live in the shared core
    (`startActivity` / `finishActivity`): a delivery switch that is off, a
    restored session with no known bootstrap, a missing `ct wisdom match`
    or an open breaker stop the query. A delivered id is recorded only for
    the turn's recall dedup, never in the bootstrap record, so a fact whose
    message was rejected or compacted away can arrive again.
  - One fact of at most 600 characters, marker first, under the heading
    `## Curated Thoughts — relevant to this step`, delivered as an
    identified user-role message with source kind
    `curated-thoughts-wisdom-activity`. It is persisted in the session log,
    replays on `--session-id`, and never touches the system prompt.
  - The ledger is rebuilt from the session log at every step, and the
    recall dedup learns each delivered id, so a fact is never shown twice.
  - Subagents get deliveries too (each has its own ledger); CT's own tools
    never trigger; the breaker, timeouts and capability latch are shared
    with the user-turn path.
  - Verbose mode records each activity delivery, and each activity query
    that delivered nothing, with `channel: "activity"` and the activity
    label (`read src/x.ts`).
  - Known limit: rules about a concept that a path only implies (for
    example "never edit an applied migration" from
    `src/db/migrations/0042.sql`) need CT's activity mode
    (curated-thoughts#282).
- Fixed: a user-turn delivery could show a fact twice when CT returned a
  correction whose own id was already in context, or the same id both as an
  entry and as a correction. A correction now rides only when it supersedes
  an id in context and is itself new, and each id is delivered at most once
  per block (the Hermes reference rule; shared `ct-wisdom-core` fix).

## 0.5.1 — 2026-10-16

- Fixed: a brain with an external embedder lost its API key at the sidecar.
  `@deepseek-ai/dsh-mcp-client` starts the sidecar from DSH's environment
  minus every name matching `/KEY|PASSWORD|SECRET|TOKEN/i`
  (`@deepseek-ai/dsh-subprocess` `scrubbedParentEnv` at 0.2.0-rc.2), so
  `OPENROUTER_API_KEY` was dropped. The bundle patch's MCP row now forwards
  `EMBED_API_KEY`, `OPENROUTER_API_KEY` and `OPENAI_API_KEY` from DSH's own
  environment at composition time (`!!js process.env.NAME ?? ''`; an empty
  value is what Curated Thoughts treats as unset). The patch holds names
  only.

## 0.5.0 — 2026-10-16

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
  On DeepSeek Harness the notice goes to the plugin's named logger
  (`ctx.logger('curated-thoughts').info`), and the log is
  `$DSH_HOME/logs/ct-wisdom-verbose.jsonl` (default `~/.dsh/logs/`). Reader:
  `node node_modules/@equational-applications/ct-wisdom-core/cli/ct-wisdom-log.js --host deepseek`
  from the installed plugin directory.

## 0.4.2 — 2026-10-16

- Changed: Intuitive Wisdom live delivery has no per-session cap. The
  shared core (`ct-wisdom-core`) drops `MAX_PER_SESSION = 12` and the
  `--max 0` switch, and `Ledger.liveDeliveredCount` (read only by the cap)
  is removed, with the adapter's user-role live-count scan.
  Why: an autonomous agent is better served by more wisdom than less. The
  cap stopped delivery after about 6 matching turns, though a fact that
  matches late in a session is as valuable as an early one. Noise stays
  bounded per turn (at most 2 facts in a 1200-character block, only facts
  past CT's relevance gate), delivery never touches the system prompt, and
  dedup keeps the session total to the distinct facts that match.
  Unchanged: the per-turn limits, CT's score gate, dedup and exactly-once
  delivery, the breaker, timeouts and the 256-id exclude bound.

## 0.4.1 — 2026-10-16

Fix: **a session that received a live wisdom block could not be continued.**
The `agent/pre-step` delivery message carried only `content` and `source`.
DSH 0.2.0-rc.2 persists pre-step messages as they are, but on replay
(`--session-id`, restart) it requires every `user/message` to carry a
non-empty `id` and `role: "user"`, so it rejected the whole stored session
("session event at seq N lacks an identified message"). The block is now an
identified user-role message (a fresh UUID per delivery, the same shape the
first-party pre-step plugins build). Found by the live container e2e (spec
AC 10 / m6, 2026-10-16), which now passes at the 0.2.0-rc.2 pin. That run
also confirmed `agent/created` fires for new and continued sessions, the
delivered block is persisted verbatim on the turn's first step, and a
continued session is not re-delivered the same fact (its id rides
`--exclude`, rebuilt from the session log).

Fix: **the `tools/post-execute` dedup rewrite dropped CT's other envelope
keys.** When a `curated_recall_context` result was rewritten (repeats
stubbed, or a `ct-fact` trailer added), only `wiki_entries` was serialized
back and every sibling key of the inner envelope was lost. The rewrite now
keeps the whole object in CT's key order and changes only the stubbed
entries and the trailer, as the OpenCode leg does.

e2e harness: the image's test-only `ct` is now 3.5.1. The old 2.22.0 has no
`wisdom match` (CT ≥ 3.3.0), so the plugin's capability probe switched
delivery off and the live path never ran. Session-log lookup now matches
`session.v*.jsonl.zstd`: the log is v4 at 0.2.0-rc.2, and the v3-only glob
matched nothing, so the "no block" checks passed without reading a log. A new
live pre-step section covers three turns of one session.

## 0.4.0 — 2026-10-09

New: **intuitive wisdom live delivery** (cross-harness parity, DSH leg — spec
`docs/superpowers/specs/2026-10-09-cross-harness-wisdom-parity-design.md`).
Once per user turn, on the first `agent/pre-step` step of a turn, the plugin
asks CT which wisdom facts are relevant to the user's message
(`ct wisdom match`, CT ≥ 3.3.0 owns the relevance gate), drops anything already
in context, and appends a sanitized delivery block (max 1200 chars) as a
user-role message to the pre-step decision — which the agent loop persists
verbatim in the session log. Failure handling is silent and budgeted: a
process-wide circuit breaker (three consecutive failures → five-minute open,
one half-open probe) bounds a sick backend; the `--exclude` bound is capped at
256 ids, most recent first.

The session ledger is rebuilt every turn from the persisted session log
(`agent.session.deriveMessages()` — never from the plugin's own decision),
unioned with the v1 bootstrap block's fact ids, so exactly-once survives
compaction (the agent id does not rotate) and resume within a process.
Agent-initiated CT recalls are deduped at `tools/post-execute`: repeated wiki
entries in a `curated_recall_context` envelope are rewritten to one-line stubs
inside the envelope's value.

**v1 amendments** (Hermes 0.4.0 parity): the auto-inclusion block now tags
every fact with a `<!-- ct-fact:<id> -->` marker, `ct recall` entries without a
valid id are dropped (they cannot be deduped), and the fact-id token is
stripped from rendered text to a fixpoint so a fact can never forge a ledger
entry. Memoized renders keep their byte stability (only new renders change).

**Host-pin bump:** DSH `0.1.5-rc.2` → `0.2.0-rc.2`
(`tests/host/compatibility.json`). At the new pin the lifecycle event is
`agent/created` (payload `{agent, source}`) — the pre-0.2
`agent/session-start` listener had no dispatcher there, so the health-block
refresh was dead; it now subscribes `agent/created`. The new contracts
(`agent/pre-step`, `tools/post-execute`) are source-verified from the
published tarballs; the live container e2e re-verification is pending
(spec m6) before the leg is marked done.

Shared algorithm in `packages/ct-wisdom-core` (annex A): budgets (2/turn,
12/session live), rendering, sanitizer, breaker, and the `ct wisdom match`
subprocess contract live there now; this integration binds them to the DSH
session log and the harness ToolRuntime.

## 0.3.2 — 2026-10-09

Dependency hygiene release: bump the transitive `source-map-js` 1.2.1 → 1.2.2
(Dependabot #10, GHSA-68fv-2mgg-jv7q, development scope only, reached via
`postcss`). Lockfile-only change; no shipped code or behavior is affected.

## 0.3.1 — 2026-10-09

Ships the live-wisdom usage guidance ("Wisdom that arrives on its own") in the
`curated-thoughts-usage` skill, byte-identical to the Hermes integration, so
agents on any harness read the same provenance, `in_context`, and supersession
rules.

## 0.3.0 — 2026-09-30

New system-prompt section: **wisdom auto-inclusion**. Once per agent, the
plugin recalls the brain's wisdom layer via the standalone `ct` CLI
(`ct recall --json --k 3`) and renders a sanitized digest (max 2500 chars) as
a `curated-thoughts-wisdom` prompt section. Memoized per agent id, so host
re-renders at compression boundaries are byte-identical.

The section is a **no-op** when the `ct` binary is absent or not identifiable,
when the brain has no wiki wisdom, or when the backend times out. Failure
handling is budgeted: two recall attempts per agent (≥ 60 s apart), then the
agent's block stays absent for the process; a process-wide circuit breaker
(four consecutive failures → five-minute open, one half-open probe) bounds
the worst case.

**Limitations (v1):** (1) after a harness restart on a resumed session the
memo is cold — the first step re-recalls and the block may change bytes once;
(2) the same one-time cost applies if the first recall attempt fails
transiently and a later render succeeds; (3) memo eviction beyond 256 live
agents per process; (4) when the `ct` backend is down, a session stops trying
after two failed attempts (its block stays absent for the session's life in
that process); (5) while the backend is down, the harness may pause briefly
(seconds) on recall attempts, bounded per process by the retry budget +
circuit breaker. Set `CT_WISDOM_DEBUG=1` to emit a per-render diagnostic line
on stderr.

## 0.2.2 — 2026-09-18

Fix empty-string fallback in brain-dir resolution. `??` operators in
`cordis.patch.yml` treated an empty `HOME` or `USERPROFILE` as a set value,
producing `/.brain` at the filesystem root. Both environment rows now use
`??` with a literal `~` fallback so the sidecar refuses the path explicitly
rather than silently opening `/.brain`.

## 0.2.1

Restore executable bits on shell scripts; fix empty HOME/USERPROFILE handling in
bundle patch and expandHome; update test to assert actual homedir() fallback.

## 0.2.0 — 2026-09-18

Fixed against DeepSeek Harness 0.1.5-rc.2 (container-verified end to end —
see the e2e harness below). 0.1.2 was never tagged or released because its
plugin could not load on current DSH at all; this release supersedes it, and
0.1.2's census change is included here. Minor bump: the install procedure
changed.

- **Load failure fixed.** The plugin used `ctx.plugin(string, ...)`, which
  cordis rejects (`invalid plugin ... received string`), never declared the
  `inject` services (crash: `cannot get property "systemPrompt" without
  inject`), and passed a non-finite prompt-context order (crash: `prompt
  context "undefined" order must be a finite number`). The MCP client is now
  mounted declaratively via a shipped bundle patch; the plugin declares
  `inject = ['systemPrompt', 'skills']`; the prompt context is registered as
  `{ name, order: 130, text }`.
- **Install rewritten.** The old installer appended blocks to
  `$DSH_HOME/cordis.yml`, which DSH never reads, and DSH ignores bare
  `- name:` rows in patch files — so installing did nothing. The package now
  ships `cordis.patch.yml` declared via package.json `dsh.bundle.patch`, and
  `install.sh --profile <name>` packs the package and installs it with
  `dsh plugin --profile <name> add <tarball>`. `--profile` is required;
  DSH composes per profile and has no global plugin list.
- **Doctor no longer crashes from the release tarball.** `ct_preflight.ts`
  imported `better-sqlite3` statically; the tarball ships no node_modules, so
  `ct_doctor check` died at import. It now loads lazily and degrades the
  census check to WARN, mirroring the OpenCode integration.
- **The doctor's `dsh-registration` check now inspects profile installs.**
  It scanned `$DSH_HOME/cordis.yml`, which DSH never reads, and so failed
  every correct install. It now reports which profiles have the package
  installed — installation being what activates the bundle patch.
- **Brain path handling.** The sidecar does not expand a leading `~`
  (verified: it treats `~/.brain` as a relative path and exits), so the MCP
  row resolves `CURATED_BRAIN_DIR` at composition time (ambient value wins,
  else `$HOME/.brain`), and the plugin expands `~` itself before probing.
- **New e2e harness** (`tests/e2e/`): Docker-based, container-verified
  against DSH 0.1.5-rc.2 (pinned in `tests/host/compatibility.json`), sharing
  its base image with the OpenCode harness.

## 0.1.2 — 2026-09-10

- `import-preflight` no longer counts soft-deleted `llm_wiki_entries` rows as
  live damage. The census is now scoped to rows with `deleted_at IS NULL` when
  that column exists, so retained issue-#186 corpses can no longer flip a
  healthy brain to FAIL. Soft-deleted rows are reported separately in the
  PASS/WARN detail as informational context. On brains with no `deleted_at`
  column the behavior is unchanged.

## 0.1.1 — 2026-09-09

Security: bump devDependencies to clear 9 Dependabot alerts in
`integrations/deepseek/` (vitest 2.1.9 → 4.1.11, vite 5.4.21 → 6.4.3,
esbuild 0.21.5 → 0.25.0). No shipped-code behaviour changes — tests,
build, and typecheck all still pass. See PR #11 for the full advisory
mapping.

## 0.1.0 — 2026-09-09

Initial release. Cordis plugin module wires the Curated Thoughts MCP sidecar,
registers a cache-safe health snapshot, refreshes on `agent/session-start`,
and ships three skills ported from Hermes (`curated-thoughts-usage`,
`curated-thoughts-ops`, `curated-thoughts-sidecar`). Ships a 9-check
`ct_doctor.ts` and an idempotent POSIX `install.sh`.
