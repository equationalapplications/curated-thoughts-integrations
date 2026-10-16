# Curated Thoughts for DeepSeek Harness

A Cordis plugin package that connects DeepSeek Harness (`dsh`) to the
[Curated Thoughts](https://github.com/equationalapplications/curated-thoughts)
memory sidecar. Sibling to the
[Hermes integration](../hermes/) — same skills, same doctor, same three-rule
discipline.

## What you get

- **MCP sidecar wired in** — the package ships a DSH bundle patch
  (`cordis.patch.yml`, declared via package.json `dsh.bundle.patch`) that
  mounts `@deepseek-ai/dsh-mcp-client` against `curated-thoughts-mcp --mcp`
  and exposes the Curated Thoughts tool surface as
  `mcp__curated-thoughts__<tool>`.
- **Cached health snapshot** — a named prompt context whose text is the
  latest completed health probe, refreshed on every `agent/created` (the
  lifecycle event at the 0.2.0-rc.2 pin; the pre-0.2 `agent/session-start`
  has no dispatcher there). A probe that throws leaves the previous snapshot
  in place, or an empty block before the first probe completes. A degraded
  result is a completed probe and replaces the snapshot. The model knows
  whether memory is usable before its first tool call.
- **Intuitive Wisdom live delivery** (0.4.0): relevant facts arrive once per
  user turn, never repeating one already in context. See [Intuitive Wisdom](#intuitive-wisdom)
  below.
- **Three skills** — `curated-thoughts-usage`, `curated-thoughts-ops`,
  `curated-thoughts-sidecar` (verbatim from Hermes).
- **Doctor** — `node lib/scripts/ct_doctor.js check` runs the nine deep checks
  (sidecar binary / identity / MCP reachable / brain / vault / embedding
  backend / dsh registration / import pre-flight / version compat).
- **Idempotent installer** — `scripts/install.sh`.

- **Wisdom auto-inclusion** — a `curated-thoughts-wisdom` system-prompt
  section (system node 0, after the health snapshot). Once per agent the
  plugin recalls the brain's wisdom layer through the standalone `ct` CLI and
  renders a sanitized digest; the block is memoized so host re-renders are
  byte-identical. It is a no-op when `ct` is absent, the brain has no wiki
  wisdom, or the backend is down.

  **Limitations (v1):** (1) after a harness restart on a resumed session the
  memo is cold — the first step re-recalls and the block may change bytes
  once; (2) the same one-time cost if the first recall attempt fails
  transiently and a later render succeeds; (3) memo eviction beyond 256 live
  agents per process; (4) when the `ct` backend is down, a session stops
  trying after two failed attempts (its block stays absent for the session's
  life in that process); (5) while the backend is down, the harness may pause
  briefly (seconds) on recall attempts, bounded per process by the retry
  budget + circuit breaker. Troubleshooting: set `CT_WISDOM_DEBUG=1` to emit
  a per-render `wisdom:` line on stderr.

## Intuitive Wisdom

Needs the standalone `ct` CLI from Curated Thoughts ≥ 3.3.0
(`ct wisdom match`). Without it, live delivery is a silent no-op.

- **Live delivery (every turn).** On the first `agent/pre-step` step of each
  user turn, the plugin asks `ct wisdom match` which facts are relevant to
  the user's message (CT owns relevance), drops anything already in context,
  and appends up to 2 of them (1200 characters max, at most 12 per session;
  corrections to a fact already shown still flow after the cap) as a
  user-role message. The agent loop persists it
  verbatim in the session log. The system prompt is never touched.
- **Exactly once.** Each fact carries a `<!-- ct-fact:<id> -->` marker. Every
  turn the plugin rebuilds the list of facts already in context from the
  session log (`agent.session.deriveMessages()`), plus the ids this process
  recorded next to the auto-inclusion block (its own ids and the ones
  delivered since). A session continued with `--session-id`, or after a
  restart, is not re-delivered a fact it already has. The agent id survives
  compaction, so within one process compaction repeats nothing; after a
  restart, a fact whose marker was compacted out of the session log may be
  delivered again.
- **Recall dedup.** When the agent calls `curated_recall_context` itself
  (`tools/post-execute`), entries already in context become one-line stubs;
  the rest of CT's envelope is kept as is.
- **Failure handling.** Silent and bounded: each `ct` call has a 3 s budget,
  and three consecutive timeouts, non-zero exits or unparseable results
  pause matching for five minutes (one half-open probe then retries). A `ct`
  that cannot be started does not count.
- **Since 0.4.1** the delivery message is an identified user message (`id`,
  `role: "user"`), so a session that received a block can be continued; in
  0.4.0 DSH rejected such a session on replay.

## Install

From the release tarball (what `scripts/install.sh` automates):

```bash
tar -xzf deepseek-<version>.tar.gz && cd deepseek-<version>
# <profile> is a dsh profile name: headless, web, sdk, sdk-minimal, acp, ...
CT_INSTALL_EDIT=1 ./scripts/install.sh --profile <profile>
```

The installer packs the package with `npm pack` and installs it into the
profile with `dsh plugin --profile <name> add <tarball>`; DSH then activates
the bundle patch automatically. **No YAML is ever edited** — DSH does not
read a hand-edited `$DSH_HOME/cordis.yml`, and hand-written `- name:` rows in
a patch file are unmatched targets, which is why older instructions that
appended blocks do nothing on current DSH.

Without `CT_INSTALL_EDIT=1`, the installer prints the plan and does not write
anything.

> **Custom brain location:** the rows default to `$HOME/.brain`. If your
> brain lives elsewhere, set `CURATED_BRAIN_DIR` (absolute path) in the
> environment when starting dsh — the MCP row resolves it at composition
> time and the plugin's health probe reads the same variable. Note the
> sidecar does not expand `~` itself. To change the rows permanently, add a
> profile patch (later layers win) targeting the row's `id`.

## Verify

```bash
dsh --profile headless --dump-config   # both curated-thoughts rows must appear
node lib/scripts/ct_doctor.js check
node lib/scripts/ct_doctor.js check --json   # machine-readable
```

## End-to-end test

`tests/e2e/run.sh` (local only, not wired into CI) builds the release
artifact, installs it inside a Docker container against a real `dsh` CLI and
the real sidecar, and runs the full check list: installer preview/apply
semantics, `--dump-config` row activation, the doctor, a live-model MCP tool
call, the degraded-health prompt block, live wisdom delivery on the real
`agent/pre-step` loop (delivery persisted verbatim in the session log, no
re-delivery when the session is continued with `--session-id`, CT ≥ 3.3.0
capability gate), literal-`~` handling in `CURATED_BRAIN_DIR`, and installer
idempotency. With no embedding backend in the container, CT's relevance gate
is replaced by a fixture that returns one fact; everything else is real.
`CT_E2E_REAL_GATE=1` (also needs `OPENROUTER_API_KEY`) adds a run against
CT's real gate. It embeds with OpenRouter `qwen/qwen3-embedding-4b`, the
model CT has a calibrated floor for, and synthesizes facts with the ZAI
librarian. It checks that the gate delivers a relevant fact, delivers
nothing for an unrelated prompt, and stays exactly-once across
`--session-id` turns. The verified DSH version is
pinned in `tests/host/compatibility.json`. It shares its base image
(Node 24, sidecar `.deb`, non-root user) with the OpenCode harness — see
`tests/e2e/base.Dockerfile` at the repo root. Requires Docker and, for the
live-model steps, `ZAI_API_KEY` in the environment.

## Compatibility

- **Sidecar:** `curated-thoughts-mcp` ≥ 2.5 (compat tier `v2.5-full`).
- **DeepSeek Harness:** 0.2.0-rc.2 is the pinned, container-verified version
  (`tests/host/compatibility.json`; every published release so far is a
  pre-release). Requires Node ≥ 22.19 or ≥ 24.
- **Platforms:** macOS, Linux, Windows (verified by the CI matrix; the e2e
  container itself is linux/amd64).

## License

MIT — identical to the main Curated Thoughts repository.
