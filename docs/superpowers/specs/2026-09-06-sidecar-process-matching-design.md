# Sidecar process-matching contract — spec

**Date:** 2026-09-06
**Status:** Draft
**Branch:** docs/sidecar-process-matching-contract
**Priority:** Medium (correctness of every future release-install script; no release blocked — v2.6.0 artifact itself is unaffected)

## Problem

Any script that must find or kill the Curated Thoughts sidecar by name is
silently broken on Linux. Verified live on this machine (2026-09-06, CT
2.6.0, sidecar pid 190635):

1. **comm truncation.** `pgrep -x <name>` matches `/proc/<pid>/comm`, which
   the kernel truncates to 15 characters. The sidecar binary is
   `curated-thoughts-mcp` (20 chars); its comm reads `curated-thought`.
   `pgrep -x curated-thoughts-mcp` can never match.
2. **The comm is not even the binary name.** On launcher-style binaries the
   comm can be entirely different (earlier this bug was observed with the
   comm reading `python`). Name-based matching is unfixable in general;
   matching must be on the full command line, anchored to the executable
   path.
3. **Silence.** `pgrep` warns on stderr when the pattern exceeds 15 chars,
   but the script pattern `pgrep -x ... 2>/dev/null || true` swallows the
   warning, so the failure is invisible: the script takes the "no sidecar
   running" branch while one is serving.

Concrete harm: in `~/Downloads/install-ct-2.6.0.sh` (one-off release-install
script, line 67/78), a stale pre-install sidecar would be missed and left
serving the old binary while the script reports success. The integrations
repo's own `integrations/hermes/scripts/install.sh` does NOT contain this
bug (it never pgreps); the repo gap is that no document records the correct
pattern for the scripts that WILL be written against this repo (future
release-install helpers, doctor scripts, process checks).

Verified live (same session, `pgrep -af`):

```
190631 ... mcp_stdio_watchdog.py --ppid 190616 -- /usr/bin/curated-thoughts-mcp --mcp   # wrapper: binary path is an ARGUMENT
190635 /usr/bin/curated-thoughts-mcp --mcp                                              # the real sidecar
198147 /usr/bin/bash -c ... pgrep -f 'curated-thoughts-mcp' ...                          # a shell whose cmdline embeds the pattern
```

An unanchored `pgrep -f curated-thoughts-mcp` matches all three. Anchored:

```
$ pgrep -f '^/usr/bin/curated-thoughts-mcp'
190635
```

Killing the watchdog wrapper (190631) kills Hermes' supervisor process — a
real destructive failure mode, not a cosmetic false positive.

## Approach

Adopt and document a single **process-matching contract**; apply it to the
one-off script.

**The contract:** any script that must find, signal, or wait on the CT
sidecar matches on the anchored absolute executable path in the full
command line:

```bash
# find
pgrep -f '^/usr/bin/curated-thoughts-mcp'
# kill
pkill -f '^/usr/bin/curated-thoughts-mcp'
```

The leading `^` is mandatory: it excludes (a) supervisor/wrapper processes
whose cmdline merely contains the path as an argument (mcp_stdio_watchdog),
and (b) the invoking shell itself, whose own cmdline embeds the pattern
text. `pgrep -x`/`pkill -x`/`killall` by name are forbidden for the sidecar
(never match: comm truncation). Unanchored `-f` matching is forbidden (three
false-positive classes above). Do not "fix" by truncating the pattern to 15
chars — the comm is not guaranteed to be a truncation of the binary name at
all.

**Assumption of the contract:** the anchored pattern presumes the sidecar is
started via the absolute installed path (`/usr/bin/curated-thoughts-mcp`).
A sidecar launched through a symlink, a relative path, a relocated binary,
or an interpreter (e.g. `bash /usr/bin/curated-thoughts-mcp`) has a cmdline
that does not begin with the path and is **out of contract** — those launch
styles do not occur for the dpkg-installed sidecar (the Hermes daemon starts
it with the absolute path). Verification flows should keep using the
`/proc/<pid>/exe` readlink check, which is launch-style independent and
remains the fallback if a launch style ever changes.

Rejected alternatives:

- **`pgrep -x curated-thought` (15-char truncation of the name):** matches
  nothing in general; the comm equals a truncated binary name only by luck.
  On this machine today the comm happens to read `curated-thought`, but the
  same sidecar was previously observed with comm `python` (launcher binary),
  so the truncation "fix" is a red herring.
- **`/proc/*/exe` readlink enumeration** (the technique the release-install
  reference uses for *verification*): robust, but read-only — it cannot feed
  `pkill`, and shell enumeration loops are what the contract is trying to
  replace for find/kill. Keep it for verification flows; the anchored `-f`
  pattern is the find/kill equivalent.

## Design: where the contract lives

1. **`docs/process-matching.md`** (new): the contract statement, the three
   false-positive classes with the live evidence above, correct/forbidden
   pattern table, and a link to the Tessera handoff for full reproduction
   detail (`agents/people/tessera/handoffs/fix-sidecar-pgrep-install-script-2026-09-06.md`,
   referenced by path only — the repo doc must read as written for any CT
   user, so agent-internal narrative stays out).
2. **`docs/spec-hermes-plugin-v0.md`**: add a short "Process-matching
   contract" cross-reference section pointing at `docs/process-matching.md`,
   so anyone extending the plugin's installer/doctor scripts hits it from
   the existing spec.
3. **One-off script fix (not in this repo, same change-set):**
   `~/Downloads/install-ct-2.6.0.sh` line 67
   `pgrep -x curated-thoughts-mcp 2>/dev/null || true` →
   `pgrep -f '^/usr/bin/curated-thoughts-mcp' 2>/dev/null || true`, and
   line 78 `pkill -x curated-thoughts-mcp || true` →
   `pkill -f '^/usr/bin/curated-thoughts-mcp' || true`. The md5
   freshness loop is correct as-is (it compares `/proc/<pid>/exe` of the
   matched pids against the installed binary — which is exactly why the pid
   set must be exact). These two line edits are the complete script
   change-set: no other line of `install-ct-2.6.0.sh` changes — the
   checksum, install, and dpkg verification sections are untouched.

## Error handling

Not applicable to a docs change; the script change keeps its existing
`|| true` / empty-string guards. The one behavioral change: with the fix,
an actually-running stale sidecar is now detected and killed (previously
silently missed) — that is the point of the fix.

## Testing

- `bash -n` and `shellcheck` on the patched one-off script must be clean.
- Live run on this machine (2.6.0 installed, sidecar running): the
  sidecar-freshness section must report the matched pid and the
  "already matches the installed binary" branch (sidecar is fresh, so no
  kill path fires).
- Negative check (documented, not scripted): on a machine where the
  sidecar is stale, the loop must report the stale pid and pkill it — this
  is the branch the old code silently skipped. Not force-tested live (would
  require installing an older sidecar); accepted on the strength of the
  live positive test plus the pgrep evidence above.
- Repo docs: markdown render check only (no code to test).

## Out of scope

- D5 Axon/DeepSeek integration shape — parked, awaiting Kurt.
- Any new CT release — v2.6.0 artifact is unaffected; script-side only.
- Retroactively fixing historical one-off install scripts other than
  `install-ct-2.6.0.sh` (they are period records in Downloads/).

## Open questions for Kurt

1. Approve adding `docs/process-matching.md` to the integrations repo (vs.
   folding the contract into `docs/spec-hermes-plugin-v0.md` only)? Default
   if unanswered: separate doc + cross-reference, as specced.
