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

## TOP PRIORITY — CI is red (must fix first)

The new `deepseek (...)` matrix jobs FAIL on the push. Root cause (reproduced
in a fresh clone at /tmp/ci-repro): the plugin imports
`@equational-applications/ct-wisdom-core` (a `file:../../packages/...` dep),
but nothing builds the CORE before the deepseek job runs — `lib/` doesn't
exist → `error TS2307: Cannot find module '@equational-applications/ct-wisdom-core'`.
Verify locally: `cd /tmp/ci-repro/integrations/deepseek && pnpm exec tsc --noEmit`.

Fix (spec-sanctioned — the parity spec says "New CI workspace node
packages/ct-wisdom-core"): teach `.github/workflows/ci.yml` to build the core
before integration jobs that need it. Either:
- a new `core` job (pnpm install + build + vitest in packages/ct-wisdom-core),
  and make the deepseek matrix job depend on it / run the core build as a
  step; the cleanest minimal edit is a conditional step in the `integration`
  job: when `matrix.entry.dir == 'integrations/deepseek'`, run
  `pnpm install --frozen-lockfile && pnpm build` in
  `packages/ct-wisdom-core` before the deepseek build; or
- extend `tools/ct_ci.py discover` so the deepseek manifest can declare the
  dependency (bigger change; only if the controller prefers manifest-driven).
Check `gh pr checks 37` after pushing the fix — the run that failed is
37994397452.

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
