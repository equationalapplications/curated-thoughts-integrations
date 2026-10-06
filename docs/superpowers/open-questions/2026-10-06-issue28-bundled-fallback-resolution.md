# Open-Question Resolution v2 — issue #28 (bundled sidecar fallback vs env-PATH mocks)

**Status:** FINAL resolution (v2). v1 (GLM 5.3 proposal) was reviewed by Opus 5.5 →
REQUEST CHANGES with 3 MAJOR + 4 MINOR, all adjudicated REAL; this revision incorporates
every amendment. Verdicts: GLM "answered (b) with spawn-gate"; Opus "RESOLUTION NEEDS
CHANGES" on v1 → this v2 is the converged resolution. The implementing PR's review ladder
(sor → GLM → Opus) validates the code against this document.

**Repo:** curated-thoughts-integrations, stacked on `fix/issue29-ambient-env-checks` @ `6b0deea` (PR #30), hermes integration v0.3.2 → 0.3.3.

---

## Decision

**Direction (b), refined into a two-layer defense — test-side primary, runtime guard secondary:**

1. **Keep the bundled fallback.** Option (a) ("skip bundled candidates when an explicit env
   was passed") is rejected: at the `ct_env.find_sidecar` layer `run_checks` always passes
   an env (the merged view), so the discriminator would fire on every doctor run. (Opus r1
   MINOR 3 corrected the layer reasoning: at the raw-`env` layer the only production caller,
   `cmd_check`, passes nothing — the guard is for programmatic/test callers either way. The
   PATH-keyed discriminator below is correct at both layers.)
2. **Runtime guard (secondary):** in `run_checks`, compute from the RAW caller `env`:
   `path_overridden = env is not None and "PATH" in env` (op. MINOR 2; note `""` — the
   documented suppression value — counts as an override, op. MINOR 1). When
   `path_overridden` AND discovery reported `source == SOURCE_BUNDLED` (constants added to
   `ct_env`; op. MINOR 4):
   - `check_sidecar_binary` returns WARN (not PASS): found via bundled fallback but the
     caller-supplied PATH override did not contain the binary; hint: fix the override.
   - `sidecar-mcp`: do NOT spawn. WARN "skipped: refusing to spawn the bundled sidecar
     against an env whose PATH override failed to resolve"; `tool_count=None` into
     `check_version_compat` (tolerates None).
   - `check_import_preflight` receives `path=None` (op. MINOR 2 — the manifest it would
     read belongs to a binary we refused to run).
   - Severity WARN (exit 2), not FAIL: the doctor diagnosed correctly; FAIL would be wrong
     for a legitimate restricted-PATH wrapper.
3. **Test-side primary defense (op. MAJOR 1–3 — the runtime guard alone CANNOT close the
   main pollution path):** with a broken/missing mock, the test helpers' PATH
   (`bin_dir + os.pathsep + ambient PATH`) lets `shutil.which` walk on to the REAL installed
   sidecar with `source == "PATH"` — the bundled guard never fires and the real binary
   spawns against the fixture brain. Fixes, all in the test fixture layer:
   - `MOCK_SIDECAR` gets an absolute shebang (`#!{sys.executable}`), so the helpers no
     longer need the ambient PATH suffix: `with_path()`/`results_by_name()` set
     `PATH = str(self.bin_dir)` ONLY. A broken mock then falls through to bundled/none —
     where the runtime guard fires — instead of to the real binary via "PATH".
   - `DoctorTestCase.setUp` precondition: discovery via `with_path()` must return
     `os.path.realpath(path) == os.path.realpath(self.mock_path)` (source `"PATH"`) — a
     broken mock fails the suite at setup. This also protects the CLI-subprocess tests
     (op. MAJOR 2: their child process calls `run_checks()` with `env=None`, invisible to
     any runtime guard).
   - New-guard tests patch `ct_env.sidecar_candidates` (poison or benign mock) instead of
     depending on host install state (op. MAJOR 3), and patch the AMBIENT PATH to a clean
     dir where the merged PATH must not contain a sidecar.
4. **`ct_status` / `ct_env.merged_env` hoist: OUT OF SCOPE** (op. answer 4 — REJECTED for
   this PR). `snapshot` never spawns; hoisting the merge changes `snapshot(env=...)`
   semantics (replace → merge), unrelated to #28. Filed as a follow-up issue.
5. **Rename `bundled` → `installed`: DEFERRED** (op. MINOR 4 — accurate on macOS/Windows
   Tauri bundle paths, only Linux is plain install dirs; `source` is detail prose, not a
   JSON field). Guard tests match the `ct_env` constant, not the literal, so a later rename
   is one line.

**Why WARN+skip is the right policy** (converged GLM + Opus): the pollution happens at
spawn time, not discovery time; discovery reporting `(path, "bundled")` is honest; the
policy layer refuses to EXECUTE an ambient binary under a caller-owned env that claimed
PATH control and failed to resolve. PASS-with-note leaves the path open; FAIL mis-grades a
correctly-functioning doctor.

## v1 → v2 disposition ledger

| Opus v1 finding | Severity | Disposition |
|---|---|---|
| Guard misses main pollution path (ambient PATH suffix + `/usr/bin/env python3` shebang) | MAJOR 1 | FIXED — test-side primary defense (item 3) |
| CLI subprocess tests unprotected by any run_checks guard | MAJOR 2 | FIXED — setUp realpath precondition covers child processes (item 3) |
| Companion/read-only tests would resolve real binary via ambient PATH | MAJOR 3 | FIXED — ambient PATH patched clean + candidates patched (item 3) |
| Empty-PATH suppression bypasses "non-empty" guard | MINOR 1 | FIXED — discriminator is `"PATH" in env` (item 2) |
| Discriminator must read raw env; withhold path from preflight | MINOR 2 | FIXED (item 2) |
| Option-(a) dismissal mixed layers | MINOR 3 | FIXED — reasoning corrected (item 1), conclusion unchanged |
| Naming caution half right; source not a JSON field | MINOR 4 | FIXED — deferred rename + constants (item 5) |

## Implementation checklist

- [ ] `ct_env.py`: `SOURCE_PATH`/`SOURCE_BUNDLED`/`SOURCE_NONE` constants used by `find_sidecar`
- [ ] `ct_doctor.py run_checks`: raw-env `path_overridden`; gated path → WARN binary check, skip probe, preflight `path=None`
- [ ] `ct_doctor.py check_sidecar_binary(found=None, gated=False)` — standalone callers unchanged
- [ ] Tests: absolute-shebang mock; bare-PATH helpers; setUp realpath precondition; 3 new guard tests; poison never runs
- [ ] Version 0.3.3 (plugin.yaml, integration.yaml, CHANGELOG, README row)
- [ ] Follow-up issue filed: ct_status/ct_env.merged_env hoist
