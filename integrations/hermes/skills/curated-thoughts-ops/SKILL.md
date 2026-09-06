---
name: curated-thoughts-ops
description: Use when Curated Thoughts looks broken — sidecar unreachable, vault errors, tier mismatches, or failed MCP tool calls.
---

# Curated Thoughts Operations

Diagnose and report problems with a Curated Thoughts (CT) integration — for
maintainers and power users. Scope is diagnosis and safe routing, never repair
by out-of-band writes.

## First move: run the doctor

Run the plugin's `ct_doctor.py` before guessing. It reports PASS / WARN / FAIL
per check, each with a fix hint:

1. **Sidecar binary** — `curated-thoughts-mcp` on PATH, or in this platform's
   install location (macOS app bundle, Linux `/usr/bin`, Windows Programs
   dir). FAIL here invalidates everything downstream.
2. **Sidecar identity** — the binary is an installed sidecar, not a build
   output from a source checkout (`target/`, `tools/`). A same-named dev build
   shadowing the installed one gives two servers on one brain.
3. **Sidecar reachable** — `tools/list` over MCP; prints the tool count, which
   is what determines the capability tier. WARN at 8 tools means the write
   path is dormant (`curated_add_wisdom` absent) — an older sidecar, not
   breakage.
4. **Brain directory** — the directory holding `brain.db` and `config.json`,
   resolved exactly as Curated Thoughts resolves it: `CURATED_BRAIN_DIR`,
   defaulting to `~/.brain`.
5. **Vault** — the documents tree named by `vault_path` **inside
   config.json**. This is a different thing from the brain directory, and it
   is machine-specific: a brain imported from another machine almost always
   has a `vault_path` that does not exist here.
6. **Embedding backend** — the configured embedding host responds. WARN/FAIL
   degrades semantic search but the sidecar may still answer.
7. **Harness registration** — `mcp_servers.curated-thoughts` present with
   `--mcp` args, and `curated-thoughts` listed under `plugins.enabled` so the
   skills and session-start hook actually load.
8. **Import pre-flight** — reads the engine version and censuses every
   `llm_wiki_entries.source_ref`. See below; this is the check that protects
   an imported graph.
9. **Version compat** — best-effort sidecar version against
   `shared/compat.yaml`. Undiscoverable on most platforms, which is fine and
   reported as PASS; it only warns when a discoverable version disagrees with
   the live tool count (the signature of a stale sidecar process).

Exit code 0 = all PASS, 1 = any FAIL, 2 = WARNs but no FAIL.

## Import pre-flight: when a brain arrives from another machine

Curated Thoughts is memory-in-a-box, so a brain is meant to travel. Two things
can destroy an imported graph before an agent reads a word of it, and the
pre-flight check reports both.

**The engine rewrites `source_ref`.** core-llm-wiki's `setup()` runs an
unconditional back-rewrite. `findRowsForSourceRefMigration()` selects a row if
**any of five predicates** holds — `TRIM(source_ref) != source_ref`,
`INSTR '/'`, `INSTR '\'`, `INSTR CHAR(0)`, or the GLOB
`'*[^-A-Za-z0-9._ ]*'` — then strips it through `normalizeSourceRef`. Every
JSON blob qualifies, destroying the `proposal_id` needed for retraction and the
evidence array behind provenance display. It fires on every app launch, over
the shared `brain.db`. The current engine pin, 7.1.0, still mangles.

Note the GLOB is not the whole selector: **space is inside the keep-set**, so a
whitespace-padded ref clears the GLOB and is still caught by `TRIM`.

Detection is a **positive token-shape test** (§2.5.1): a row is damaged iff its
`source_ref` does not match `^librarian-[0-9a-f]{32}$`. The `evidence…` prefixes
drive *recovery* (§2.5.4), never detection.

The census is scoped to `source_type = 'librarian_inferred'`, and this matters:
a legitimate document-sourced ref can itself reach the 255-char cap (long vault
paths normalize to exactly 255), so an unscoped shape test would report a
healthy brain as damaged. `NULL` refs are legitimate engine-era data, counted
separately as `null_ref_count`.

Verdicts:

- **mangled** → FAIL. Evidence already destroyed. Do not trust this graph's
  provenance. The V18 repair migration re-derives it (outbox-first, then
  proposal lookup) and exports before mutating.
- **at_risk** → FAIL. Rows still hold JSON or whitespace-padded refs; intact
  right now, destroyed at the next app launch. Do not open this brain with the
  desktop app until Curated Thoughts carries the PR #188 fix.
- **token** with no `librarian_evidence` **table** → FAIL. The entries
  travelled, their provenance did not — a broken import contract.
- **token** rows missing individual evidence **rows** → WARN. §2.3 treats these
  as still-grounded and never auto-purges them, so nothing is being deleted;
  provenance display and retraction just cannot resolve them.
- **token** with evidence → PASS. `unanchored=1` rows are expected under §2.4
  Phase 1 write-with-flag, not damage.

**Export whole brains, not table subsets.** §2.5.5 defines a supported export
as brain-complete — entries, evidence, chunks and proposals. A partial export
made legitimately-anchored facts look like orphans, so the repair migration now
asserts a complete chunk schema before any orphan deletion and skips it loudly
if the assertion fails. `shared/compat.yaml` lists what must travel.

## Registration in Hermes

The MCP server is registered in `~/.hermes/config.yaml` under
`mcp_servers.curated-thoughts` with `--mcp` arguments, and the plugin is
listed under `plugins.enabled`. Both halves matter: without the `mcp_servers`
block there are no tools, and without the `plugins` entry the skills and the
`on_session_start` hook never load. The installer merges this block only if
absent — it never overwrites an existing entry. If both a plugin copy and a
loose `~/.hermes/skills/curated-thoughts*` skill exist, remove the loose copy
to avoid skill collisions (the installer warns; it never deletes user files).

## Safe routing when things fail

- **Report, don't improvise.** Capture the exact tool error, the doctor check
  that failed, and the tool count. Sidecar errors mean route around: use
  non-CT sources for this session and surface the error to the user.
- **Never write out-of-band.** Fixing a vault problem by hand-editing files or
  opening the database directly corrupts indexing and embeddings. The sidecar
  is the only writer, always.
- **Tier mismatch ≠ failure.** A WARN on tool count just means the sidecar
  version predates the write path; read tools still work. Check
  `shared/compat.yaml` for the expected surface at that version.
- **Fail open.** A down sidecar must not block a session; state it plainly and
  continue without CT memory.
