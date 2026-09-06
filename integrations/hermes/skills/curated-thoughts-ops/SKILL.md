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
unconditional back-rewrite that GLOB-matches every `source_ref` containing a
character outside `[A-Za-z0-9._- ]` — which every JSON blob does — and strips
it through `normalizeSourceRef`. That destroys the embedded evidence: the
`proposal_id` needed for retraction and the evidence array behind provenance
display. It fires on every app launch, over the shared `brain.db`. See
curated-thoughts issue #186 and PR #188.

The check classifies every row and reports:

- **mangled** → FAIL. Evidence already destroyed. Do not trust this graph's
  provenance. PR #188 ships a repair migration that re-derives evidence from
  `curated_proposal_items`.
- **at_risk** → FAIL. Rows still hold JSON refs; intact right now, destroyed
  at the next app launch. Do not open this brain with the desktop app until
  Curated Thoughts carries the PR #188 structural fix.
- **token** with no `librarian_evidence` table → FAIL. The entries travelled
  but their provenance did not. Re-export including that table.
- **token** with the evidence table → PASS. Engine-proof.

**Provenance can be deleted, not merely missing.** PR #188 §2.5.4 treats an
entry whose chunk anchors are all gone as an orphan and deletes it. So an
export that carries wiki entries without the `chunks` rows arrives looking
exactly like the orphan class. Export whole brains, not table subsets —
`shared/compat.yaml` lists what must travel.

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
