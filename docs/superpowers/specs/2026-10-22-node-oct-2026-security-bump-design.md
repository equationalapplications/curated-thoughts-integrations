# Node October 2026 security releases: tested and recorded Node versions — design

**Date:** 2026-10-22 · **Status:** Approved (user, 2026-10-22) · **Branch:** `chore/node-oct-2026-security` ·
**Base:** `origin/main` @ `2f157d3`
**Scope:** CI matrix config, the shared e2e base image, and the version records in `tests/host/compatibility.json`
and the integration READMEs. No product code changes.

Tags: **[V]** verified in this session (repo code, the Node.js advisory, or the Docker Hub registry); **[U]**
unverified, carried as a limitation.

## Problem

On 2026-10-21 Node.js shipped security releases for every supported line: 26.12.1, 24.22.1 and 22.23.4. They fix
ten CVEs, four of them High: CVE-2026-111497 (Brotli decoder out-of-bounds write, RCE), CVE-2026-105482
(`dns.resolve` NUL truncation), CVE-2026-105483 and CVE-2026-106069 (TLS hostname-check bypasses). They also update
the bundled c-ares, OpenSSL, undici and CA store. 20.x is end-of-life and is not patched.

This repo runs Node in three places — the CI matrix, the e2e Docker harnesses, and the host contract tests — and
records the versions it verified against. Some of those either do not pick up the patch on their own or record a
version that is now known-vulnerable.

## Phase 0: facts

- **F1 [V].** Advisory: <https://nodejs.org/en/blog/vulnerability/october-2026-security-releases>. Patched:
  26.12.1, 24.22.1, 22.23.4.
- **F2 [V].** `integrations/deepseek/integration.yaml` matrix `node: ["22.19", "24.x"]`; the comment says the
  interpreters are "DSH's stated Node minimums". `actions/setup-node` resolves `"22.19"` to the newest 22.19.x
  patch, which predates 22.23.4 and is unpatched.
- **F3 [V].** opencode `["22.x", "24.x"]`, openclaw `["24.x"]`, and the two `node-version: 22` jobs in
  `.github/workflows/ci.yml` (ct-wisdom-core; the opencode leg) float to the newest patch of their line.
- **F4 [V].** `tests/tools/test_ct_ci_discover.py` asserts 33 matrix entries and deepseek's exact
  `{22.19, 24.x}` interpreter set.
- **F5 [V].** `tests/e2e/base.Dockerfile` is `FROM node:24-bookworm-slim` (floating). The deepseek, opencode and
  hermes `tests/e2e/run.sh` scripts build it with `docker build` and no `--pull`, so each machine reuses whatever copy
  of the tag it last pulled. Images on the author's machine built 4–6 days ago report `node -v` = v24.22.0.
- **F6 [V].** Docker Hub, 2026-10-22: `node:24-bookworm-slim` and `node:24.22.1-bookworm-slim` share the index
  digest `sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205`; a container from it reports
  v24.22.1.
- **F7 [V].** `integrations/deepseek/tests/host/compatibility.json` records `"node": "24-bookworm"`. opencode's
  records no e2e base Node. hermes has no `compatibility.json`.
- **F8 [V].** `integrations/opencode/tests/host/compatibility.json` records `"nodeFallback": "22.23.2"`, repeated at
  `integrations/opencode/README.md` ("Node fallback `22.23.2`"). 22.23.2 is affected by the advisory.
- **F9 [V].** `integrations/openclaw/package.json` `engines.node` is `>=24.16.0`, mirroring upstream OpenClaw's
  floor (`compatibility.json` `engines`).
- **F10 [V].** The repo has no `.github/dependabot.yml`.

## Decisions

### D1. deepseek keeps its floor and gains a patched 22 line

`node: ["22.19", "22.x", "24.x"]`. `22.19` stays because it is DSH's stated minimum and testing the floor is the point
of that entry. CI only runs our suite on it, never serves traffic, so its unpatched runtime is an accepted, stated
exposure. `22.x` adds the patched 22 line, which the matrix did not test before. The yaml comment says all of this.

`test_ct_ci_discover.py`: the expected count goes from 33 to 36, deepseek's set gains `"22.x"`, and the count comment
is updated.

### D2. The e2e base image is pinned by digest

```dockerfile
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
FROM ${NODE_IMAGE}
```

The digest is the multi-arch index, so amd64 and arm64 builds both resolve. The header comment names the version
(24.22.1) and the bump procedure: look up the new tag's index digest, replace this line, update the records in D3,
and re-run the three harnesses. The tag stays in the reference for readability; Docker resolves by the digest.

A digest pin makes the harnesses reproducible and keeps "verified against" records true. The cost is a manual bump
per Node release (F10: no Dependabot; adding it is out of scope).

### D3. Records name the exact e2e base Node

- deepseek `compatibility.json`: `"node"` becomes `"24.22.1-bookworm-slim"`, and `verifiedWith.platform` names the
  digest.
- opencode `compatibility.json`: adds `"e2eBaseNode": "24.22.1-bookworm-slim@sha256:55fb5f5a…"` beside the other
  pins.
- hermes: no compatibility file; `tests/e2e/base.Dockerfile` is its record.

Each record changes only after its harness passes on the new base (D5).

### D4. opencode `nodeFallback` is re-verified on 22.23.4

Re-run the host contract (`tests/host/contract.test.ts`, darwin-x64, the command in `verifiedWith`) with Node 22.23.4
first on `PATH`. On a pass, `nodeFallback` and the README line become `22.23.4` and `verifiedWith.date` becomes
2026-10-22. The number is never changed without the run, because the record claims a test.

### D5. Failure handling

Each of D2/D3 (per harness) and D4 stands alone. If a harness or the contract fails on the new Node, that item stops:
its record keeps the old value, and an investigation note is added to this spec under **Outcome**. The other items
still ship.

### D6. Deliberately unchanged

- openclaw `engines.node >=24.16.0` (F9): it mirrors upstream, and a stricter floor in our package would not patch
  anyone's runtime.
- The floating CI entries (F3): they already pick up 24.22.1 and 22.23.4.
- No Dependabot (F10).

## Verification

1. `python -m unittest tests.tools.test_ct_ci_discover` passes with 36 entries.
2. `integrations/{deepseek,opencode,hermes}/tests/e2e/run.sh` pass; inside each built image `node -v` is v24.22.1.
3. The opencode host contract passes under Node 22.23.4.
4. CI on the PR is green, including the new deepseek `22.x` jobs on all three OSes.

## Out of scope

Rebuilding e2e images on other machines (they rebuild on their next `run.sh`, because the Dockerfile changed), the
author's local machine and Docker cleanup, and deployments of other repos.

## Outcome

Verified 2026-10-22 on darwin-x64. Every item passed; nothing was stopped under D5.

- **D1:** `python -m unittest discover -s tests/tools`: 138 tests OK. A second count assertion
  (`TestCli.test_discover_all_emits_json`) also expected 33 and was updated to 36.
- **D2/D3:** with the pinned base image, `integrations/deepseek/tests/e2e/run.sh` 54 passed / 0 failed,
  `integrations/opencode/tests/e2e/run.sh` 34 passed / 0 failed, `integrations/hermes/tests/e2e/run.sh` RESULT PASS
  (live model steps ran; the opt-in `CT_E2E_REAL_GATE=1` steps were skipped as usual). `node -v` is v24.22.1 in
  `ct-e2e-base`, `ct-opencode-e2e` and `ct-hermes-e2e`.
- **D4:** opencode-ai 1.18.35 and bun 1.4.2 installed under Node 22.23.4 (throwaway HOME and prefix in the session
  scratchpad); `tests/host/contract.test.ts` 7 pass / 0 fail, 85 expects.
- **Pending:** CI on the PR (Verification step 4).
