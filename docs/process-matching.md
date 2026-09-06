# Process-matching contract for Curated Thoughts scripts

Any script that must **find, signal, or wait on** the Curated Thoughts
sidecar must match it by **anchored absolute executable path** in the full
command line — never by process name.

## The contract

```bash
# find
pgrep -f '^/usr/bin/curated-thoughts-mcp([[:space:]]|$)'
# kill
pkill -f '^/usr/bin/curated-thoughts-mcp([[:space:]]|$)'
```

The leading `^` is **mandatory** (see "Why the anchor is mandatory" below),
and the trailing `([[:space:]]|$)` boundary is too: without it, a
same-prefix sibling path such as `/usr/bin/curated-thoughts-mcp-helper`
would also match the anchored pattern.

## Why name matching never works

- `pgrep -x <name>` / `pkill -x <name>` / `killall <name>` match
  `/proc/<pid>/comm`, which the kernel limits to **15 characters**. The
  sidecar binary name `curated-thoughts-mcp` is 20 characters; its comm
  reads `curated-thought`. A longer-than-15-char name therefore **can
  never match** — pgrep even warns about this on stderr, a warning that
  is easy to swallow with `2>/dev/null` (which is exactly how this bug
  stayed hidden in a release-install script).
- The comm is not guaranteed to derive from the binary name at all: the
  same sidecar has been observed with comm `python` under a
  launcher-style binary. Do **not** "fix" name matching by truncating
  the pattern to 15 characters — that only works by luck.

## Why the anchor is mandatory

`pgrep -f <pattern>` matches the full command line. An **unanchored**
pattern containing the sidecar path matches three classes of processes
you must never touch:

1. **Supervisor/wrapper processes** whose command line merely *contains*
   the path as an argument — e.g. the Hermes MCP stdio watchdog:
   `python .../mcp_stdio_watchdog.py --ppid N -- /usr/bin/curated-thoughts-mcp --mcp`.
   Killing it kills Hermes' supervisor.
2. **The invoking shell itself**, whose own command line embeds the
   pattern text (a script or interactive command containing the pattern).
3. **Unrelated tools** that mention the path (editors, greps, other
   agents' command lines).

Anchoring with `^` matches only processes whose command line *begins*
with the absolute sidecar path — exactly the real sidecar(s).

## Forbidden patterns

| Pattern | Status |
|---|---|
| `pgrep -x curated-thoughts-mcp` | Forbidden — never matches (>15-char comm) |
| `pkill -x curated-thoughts-mcp` | Forbidden — never matches |
| `killall curated-thoughts-mcp` | Forbidden — same name-matching failure |
| `pgrep -f curated-thoughts-mcp` (unanchored) | Forbidden — false positives above |
| `pgrep -x curated-thought` (15-char) | Forbidden — luck-based, not a fix |

## Verification (not find/kill)

For *verifying* which binary a running pid executes (e.g. freshness
checks after an upgrade), readlink the exe and compare hashes:

```bash
readlink "/proc/${pid}/exe"        # → /usr/bin/curated-thoughts-mcp
md5sum "/proc/${pid}/exe"
```

Note the limit: `/proc/<pid>/exe` resolves the *actually executed*
binary. For direct executions of the installed sidecar this is
launch-style independent (symlinked or relocated start paths still
resolve here). For an interpreter launch (`bash
/usr/bin/curated-thoughts-mcp`), it resolves to the *interpreter*, not
the script — in that case validate the script path from the command
line instead. This launch style does not occur for the
dpkg-installed sidecar.

## Launch-path assumption

The anchored pattern presumes the sidecar is started via the absolute
installed path (`/usr/bin/curated-thoughts-mcp`), which is how the
Hermes daemon launches the dpkg-installed sidecar. A sidecar launched
through a symlink, a relative path, a relocated binary, or an
interpreter (e.g. `bash /usr/bin/curated-thoughts-mcp`) has a command
line that does not begin with the path and is **out of contract**; if a
launch style like that ever appears, fall back to the
`/proc/<pid>/exe` readlink verification above to identify sidecar
pids.

## Provenance

Diagnosed and verified live on 2026-09-06 (CT 2.6.0): a one-off
release-install script used `pgrep -x curated-thoughts-mcp` and
silently skipped stale-sidecar detection while a sidecar was running —
the freshness check fell into its "no sidecar running" branch, and the
`pgrep` warning about >15-character name patterns was hidden by a
`2>/dev/null`. The reproduction is self-contained in this document:
run `pgrep -x curated-thoughts-mcp` on any machine with the sidecar
running and observe zero matches despite a live sidecar.
