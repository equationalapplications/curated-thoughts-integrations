# Sidecar process-matching contract — plan

**Goal:** Record the verified process-matching contract in the integrations
repo and apply it to the one-off v2.6.0 install script, so no future
release-install script reintroduces the silent `pgrep -x` no-op.

**Architecture:** Docs-only change in the integrations repo (new contract
doc + cross-reference from the existing plugin spec) plus a two-line fix to
a repo-external script (`~/Downloads/install-ct-2.6.0.sh`). No runtime code,
no daemons, no data paths.

**Tech stack:** Bash (script patch), Markdown (docs), shellcheck + `bash -n`
(validation), live `pgrep` against the running sidecar for acceptance.

**Spec:** `docs/superpowers/specs/2026-09-06-sidecar-process-matching-design.md`
(same branch, latest content as of commit 2194a8d)

**Global constraints:**

- REGULAR merge commits only (Kurt, Aug 2026) — never squash.
- The repo is public: agent-internal narrative (session ids, handoff paths
  as narrative) stays out of repo docs; the contract doc must read as
  written for any Curated Thoughts user.
- The one-off script's checksum, dpkg, and md5-freshness sections must
  remain byte-identical — only the two process-matching lines (and their
  comment) change.
- Never verify the sidecar via `--version` (hangs on stdio); live checks
  use `pgrep -f '^/usr/bin/curated-thoughts-mcp([[:space:]]|$)'` and
  `/proc/<pid>/exe`.

## Tasks

### Task 1: Write the contract doc

- [ ] Create `docs/process-matching.md` with exactly these sections:
  - **The contract** (one paragraph + the two code lines: `pgrep -f
    '^/usr/bin/curated-thoughts-mcp([[:space:]]|$)'` / `pkill -f
    '^/usr/bin/curated-thoughts-mcp([[:space:]]|$)'`; the `^` anchor is
    mandatory and so is the trailing `([[:space:]]|$)` boundary — it
    excludes same-prefix sibling paths like `...-mcp-helper`).
  - **Why name matching never works** — 15-char `/proc/<pid>/comm`
    truncation; comm is not guaranteed to derive from the binary name;
    `pgrep -x`'s >15-char warning is easy to swallow with `2>/dev/null`.
  - **Why the anchor is mandatory** — three false-positive classes of
    unanchored `-f`: (1) supervisor/wrapper processes whose cmdline
    contains the sidecar path as an ARGUMENT (mcp_stdio_watchdog — killing
    it kills Hermes' supervisor), (2) the invoking shell whose own cmdline
    embeds the pattern text, (3) unrelated tools mentioning the path.
  - **Pattern table:** find → `pgrep -f '^<abs-path>'`; kill → `pkill -f
    '^<abs-path>'`; forbidden → `pgrep -x <name>`, `pkill -x <name>`,
    `killall <name>`, unanchored `pgrep -f <name>`; verification (not
    find/kill) → `readlink /proc/<pid>/exe` + md5 compare.
  - **Launch-path assumption** — the anchored pattern presumes the sidecar
    starts via the absolute installed path; symlink / relative-path /
    relocated-binary / interpreter-launched styles are out of contract
    (they do not occur for the dpkg-installed sidecar), with
    `readlink /proc/<pid>/exe` as the launch-independent fallback.
  - **Do NOT truncate to 15 chars** warning (the truncation "fix" is a red
    herring).
- [ ] Commit: `docs: sidecar process-matching contract`

Note: the Provenance section references the internal incident handoff
(`fix-sidecar-pgrep-install-script-2026-09-06`) by name/date only — spec
Design item 1's link requirement satisfied path-free, agent-internal
narrative excluded (public repo).

### Task 2: Cross-reference from the plugin spec

- [ ] Append a short `## Process-matching contract` section to
  `docs/spec-hermes-plugin-v0.md`: two sentences — any script that must
  find/signal the sidecar uses the path-anchored pattern; full contract in
  `docs/process-matching.md`. Link it.
- [ ] Commit: `docs: cross-reference process-matching contract from plugin spec`

### Task 3: Patch the one-off script (repo-external)

- [ ] In `/home/kv-thinkpad-t420-ubuntu/Downloads/install-ct-2.6.0.sh`:
  line 67 → `SIDE_PIDS="$(pgrep -f '^/usr/bin/curated-thoughts-mcp([[:space:]]|$)' 2>/dev/null || true)"`;
  line 78 → `pkill -f '^/usr/bin/curated-thoughts-mcp([[:space:]]|$)' || true`;
  the comment block above line 67 is replaced with EXACTLY (three lines):

  ```
  # Match the sidecar by path-anchored full-cmdline -f match: pgrep -x
  # compares /proc/<pid>/comm, truncated to 15 chars ('curated-thought'),
  # so the 20-char binary name can never match with -x.
  ```

  Nothing else changes (checksum, install, dpkg verification, and the md5
  freshness loop are byte-identical).

**Interfaces (cross-task contract):** the exact pattern string
`'^/usr/bin/curated-thoughts-mcp([[:space:]]|$)'` is identical in Tasks 1–3 —
copy it, do not retype variants.

### Task 4: Validate

- [ ] `bash -n /home/kv-thinkpad-t420-ubuntu/Downloads/install-ct-2.6.0.sh`
  → exit 0.
- [ ] `shellcheck` on the script → exit 0, zero findings (spec Testing bar:
  clean; verified live result already meets it).
- [ ] Live run: `sudo bash
  /home/kv-thinkpad-t420-ubuntu/Downloads/install-ct-2.6.0.sh` (Kurt runs
  it, or it exits early without root) → expect checksum OK,
  "already installed on dpkg", and the sidecar-freshness section reporting
  the matched pid + "running sidecar already matches the installed binary".
- [ ] `python3 ~/.hermes/plugins/curated-thoughts/scripts/ct_doctor.py check`
  still → 9 PASS / 0 FAIL.

### Task 5: PR

- [ ] Push branch `docs/sidecar-process-matching-contract`; open PR with
  body linking spec + plan, conventional title
  (`docs: sidecar process-matching contract`). PR body also documents the
  spec's negative check (stale-sidecar branch reports and pkills) and why
  it is documented rather than force-tested live (it requires a genuinely
  stale sidecar; the md5/exe comparison logic it depends on is exercised
  by the live fresh-sidecar run).
- [ ] Watch CI to green (`gh pr checks` — never claim green unchecked);
  adjudicate reviewer findings with fix commits (no amending pushed
  commits).
- [ ] HOLD for Kurt's independent review before merge (standing rule) —
  report status, do not merge unilaterally.
