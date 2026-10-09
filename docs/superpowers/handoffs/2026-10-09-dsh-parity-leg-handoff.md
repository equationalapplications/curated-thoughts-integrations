# Handoff — cross-harness wisdom parity, DSH leg (PR #37)

Written 2026-10-09 after the DSH leg (Task 2) work session. Read this before
touching `integrations/deepseek/` or the parity branch.

## Where things stand

**Branch:** `feat/cross-harness-wisdom-parity` — PR #37, OPEN (draft).
**Latest commits:**
- `d9cd38b` feat(deepseek): intuitive wisdom live delivery (0.4.0) — the whole leg
- `e459690` fix(deepseek): vendor ct-wisdom-core into the packed install; e2e embedder gate
- `d9ceedd` (groundwork) packages/ct-wisdom-core — annex A implementation + shared suite

**Done and verified:**
- Adapter `integrations/deepseek/src/wisdom-live/adapter.ts` implementing the
  core's HostAdapter; ledger from `deriveMessages()` snapshots (m5), async
  wisdomMatch with process-group SIGKILL (a plain child.kill leaks a hung
  `sh -c` grandchild holding the pipes — found live), capability latch.
- `src/index.ts` wiring: `agent/pre-step` (N1, once per (agent, turn)),
  `tools/post-execute` (N3), health refresh migrated `agent/session-start` →
  `agent/created` (old event has NO dispatcher at pin 0.2.0-rc.2).
- v1 marker amendment in `src/wisdom.ts` (ct-fact markers, invalid ids dropped,
  token stripped to fixpoint).
- Pin `tests/host/compatibility.json` → dsh 0.2.0-rc.2; version 0.3.2 → 0.4.0
  (package.json + integration.yaml); CHANGELOG `## 0.4.0 — 2026-10-09`;
  README table synced via `python3 tools/ct_ci.py readme`.
- Tests: 21 new (adapter unit + exactly-once property test, 200 randomized
  sessions). Suite: 221 passed / 4 failed — the 4 failures are PRE-EXISTING
  environment failures (this machine has a real sidecar + brain at
  ~/.brain; the "clean machine" tests in test_ct_env/test_status/test_ct_doctor
  fail on the untouched base tree too). Do not chase them on this box.
- Live e2e (m6 obligation) GREEN: `tests/e2e/run.sh` flow, 20 passed 0 failed,
  after fixing (a) packed installs (file: dep resolution) and (b) the wisdom
  e2e gate (probed ct status — passes once brain seeded — now probes the
  embedder with a trivial `ct recall`).
- Policy gate green: `python3 tools/ct_ci.py policy --base origin/main`.

**E2e evidence:** /tmp/ct-e2e-out/ (logs; ephemeral — /tmp). Pin tarballs used
for API verification: /tmp/dshpin/ (also ephemeral).

## TOP PRIORITY — ~~CI is red (must fix first)~~ FIXED (2026-10-09, this session)

The `deepseek (...)` matrix jobs failed on the push with `TS2307: Cannot find
module '@equational-applications/ct-wisdom-core'` — reproduced in a fresh
clone: the core's `lib/` is gitignored, nothing built it in CI, and pnpm
resolves/copies `file:` deps at install time, so the integration's `tsc` ran
against an empty package.

**Fixed in commits `0107eee` + `5e366a1` (on this branch):**
- New `core` job in `ci.yml`: frozen install + build + unit suite (45 tests)
  in `packages/ct-wisdom-core` — the spec's CI workspace node; the suite had
  previously run nowhere in CI.
- Conditional "Build shared core" step in the `integration` job, BEFORE its
  install (ordering is load-bearing), gated on the integration's
  `package.json` declaring the core as a dependency — detected, not hardcoded,
  so the OpenCode/OpenClaw legs inherit it. Runs `shell: bash` (Windows
  default shell is pwsh; the first red run after this step landed proved the
  ParserError on all four Windows entries).
- `ci-ok` hard-requires `core` (it has no skip condition).

**Verified:** full-matrix run 38003095545 on `5e366a1` — 29/29 jobs green
(includes opencode/claude-code/hermes matrices, which this run exercised for
the first time on this branch because touching `.github/` trips
`affects_all`). `gh pr checks 37` all pass.

## Remaining legs (spec ordering)

OpenCode (0.1.2 → 0.2.0, real-binary host contract + live chat.message e2e) →
Claude Code (0.1.1 → 0.2.0, SessionStart extension + plugin-data store) →
OpenClaw (greenfield 0.1.0, weakest tier + cache gate). Spec:
docs/superpowers/specs/2026-10-09-cross-harness-wisdom-parity-design.md.
Per-leg N1..N5 scope is in the spec's adapter-contracts table. The core
package is ready to consume the same way DSH does (file: dep + the SAME CI
core-build fix applies to opencode/openclaw when they land).

## Landmines (learned the hard way)

- pnpm resolves `file:` deps relative to the INSTALL location, not the
  tarball — never ship a file: dep in a packed artifact. install.sh now
  stages a self-contained copy with the core bundled under node_modules/ and
  writes the tarball with tar directly (npm pack cannot bundle it).
- `agent/session-start` does not exist as a dispatch at 0.2.0-rc.2.
  `agent/created` is the lifecycle event (payload {agent, source}).
- The e2e `out/` dir must be world-writable BEFORE docker run (run.sh handles
  it; manual runs: `mkdir -p out && chmod 777 out` — a root-owned dir fails
  every check with Permission denied).
- The 4 local test failures (sidecar/brain env) are expected on this machine.
- GitHub Actions' default shell on Windows runners is pwsh, NOT bash — any
  POSIX-syntax `run:` step in `ci.yml` must set `shell: bash` explicitly
  (the pwsh ParserError took down all four Windows matrix entries once
  already).
