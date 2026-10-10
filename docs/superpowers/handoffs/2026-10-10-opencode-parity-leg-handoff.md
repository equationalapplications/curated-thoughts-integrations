# Handoff — cross-harness wisdom parity, OpenCode leg (Task 2 of 4)

Written 2026-10-10 after the DSH leg merged and `deepseek-v0.4.0` shipped.
Read this before touching `integrations/opencode/`. Spec:
`docs/superpowers/specs/2026-10-09-cross-harness-wisdom-parity-design.md`
(per-leg N1–N5 scope is the "Per-host adapter contracts" table; decisions
referenced below live in the same file).

## Where things stand (all verified on GitHub 2026-10-10)

- **PR #37 MERGED** (`9eabfb3`), **PR #39 MERGED** (`b36123b`). Main CI green.
- **`deepseek-v0.4.0` RELEASED** and byte-verified: the published tarball
  carries `lib/ct-wisdom-core/index.js` (vendored core) + `lib/src/index.js`
  + `install.sh`; SHA256SUMS OK. Release train proven end-to-end including
  the new core staging.
- **README** on main is correct (all implemented rows link their releases;
  OpenClaw row is `planned`).
- **Only tag due after THIS leg:** `opencode-v0.2.0` (opencode is at 0.1.2 on
  main; claude-code 0.1.1 and hermes 0.4.1 already have matching tags — do not
  re-tag them; openclaw is `planned` at 0.0.0, tagged only after its leg).
- **Branch for this leg (already created):** `feat/opencode-parity` off main
  (first commit = this handoff). `git checkout feat/opencode-parity` to start;
  origin/main tip should be `b36123b` or later.

## The leg (spec §opencode + decisions 3)

OpenCode 0.1.2 → **0.2.0**. Version bump in `integration.yaml` +
`package.json` (version_mirror) + CHANGELOG entry + README row via
`python3 tools/ct_ci.py readme`.

Adapter contract (from the spec table — do not re-derive):
- **N1**: `chat.message` hook, UserMessage, pre-LLM, once per turn.
- **N2**: same `chat.message` channel, appended part with `synthetic: true`.
- **N3**: `tool.execute.after` transform.
- **Ledger**: persisted session history via `client.session.messages()` —
  the persisted history IS the record. Compaction carry-forward via
  `experimental.session.compacting` (decision 3 deviation).
- **Restore**: persisted history; fail-safe child policy per decision 3.
- Host pin: `tests/host/compatibility.json` `opencode` field (currently
  1.18.35 — re-verify the latest real release before freezing; the host
  contract runs the REAL pinned binary, and there is a live
  `chat.message` e2e obligation like DSH's m6).

The `@equational-applications/ct-wisdom-core` `file:` dep (now carrying the
trailer-emitting `onToolResult` and the 3.3.0 `matchArgs`) is consumed the
same way DSH consumes it. **No `ci.yml`/`release.yml` edits are needed** —
the `core` job, the integration-job pre-install build step, the opencode
host-contract pre-build, and all three release probes auto-detect the dep
from `package.json`.

## First task

Branch off main, port the adapter per the contract, run the ladder below.
Do NOT start from the old parity branch.

## Review ladder (mandatory, per dual-review-cycle)

1. Tier 1: `system-one-reviewer --repo . --staged|--range <base>..HEAD` —
   adjudicate every finding in writing (the scorer flags new conditional
   shell blocks generically; verify regions against job context).
2. Tier 2: `hermes chat -Q -m glm-5.3 --provider zai -t terminal -q "<...>"`
   (NON-flash only; first attempt may outlive a foreground timeout — run it
   backgrounded from the start). Verify every GLM finding against the real
   files before acting (GLM was right about the release.yml gap and the
   oracle blindness; both were real).
3. CodeRabbit fires on the ready-for-review flip — evaluate per
   reviewer-evaluation-policy; its round 1 on #37 was 5/5 real findings,
   two of them exactly-once bugs local tests missed. No `@coderabbitai`
   re-request, ever.
4. Opus only on dual-review-cycle triggers.

## Landmines (all current; the starred ones bit THIS week)

- **GitHub Windows default shell is pwsh** — every POSIX-syntax `run:` step
  in any workflow needs explicit `shell: bash`. (*) first red run proved it.
- **Job-level `working-directory` relocates relative paths** — release.yml
  probes are anchored to `$GITHUB_WORKSPACE` for this reason; keep any new
  probe CWD-proof. (*) cost a failed release (38065796391).
- **pnpm copies `file:` deps at install time** — build the core before the
  consumer's install, not just its build. (*)
- **Tool envelopes may carry ct-fact trailers** — anything parsing a recall
  envelope must parse line 1 only (JSON.stringify emits no literal
  newlines). The exactly-once oracles enforce this; keep new tests honest.
- `agent/session-start` is dead at the DSH pin; OpenCode's triggers are
  `chat.message`/`tool.execute.after` per the spec — do not port DSH event
  names.
- e2e `out/` must be world-writable BEFORE docker run (`chmod 777`); a
  root-owned dir fails everything.
- The 4–5 local deepseek test failures (real sidecar/brain on this box) are
  expected noise in `test_ct_env`/`test_status`/`test_ct_doctor` — do not
  chase them here either.
- Same-name tag re-push does not re-fire the release (delete + recreate the
  ref fires it). Verify releases BYTE-LEVEL: download the asset,
  `sha256sum -c` from the asset's own directory, grep the tarball for the
  vendored core.
- `/tmp` on this box was at 81% — download release assets to
  `~/.hermes/cache/scratch`, not /tmp.

## Definition of done (leg)

- [ ] OpenCode adapter implements N1/N2/N3 + ledger per the contract table
- [ ] Unit suite + shared core suite green (core suite must stay 47+/47+)
- [ ] Host contract green against the pinned real binary
- [ ] Live e2e green (chat.message flow)
- [ ] CI full matrix green (28+ jobs); sor/GLM ladder closed with written
      adjudications; CodeRabbit round(s) clean after ready flip
- [ ] Merged; `opencode-v0.2.0` tagged on the merge commit; release published
      and byte-verified; README row shows 0.2.0

## Standing rules

- Spec is the contract; deviations get written up as decision requests for
  Kurt, not silent choices.
- docs ride the PR; handoffs get an INDEX row the same session.
- Verify reviewer claims against real files; verify artifacts by
  downloading them; verify releases by reading guards + checksums.
