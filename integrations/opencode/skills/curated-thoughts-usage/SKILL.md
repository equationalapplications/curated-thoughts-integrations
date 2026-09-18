---
name: curated-thoughts-usage
description: Use when a harness session needs Curated Thoughts memory — search, recall, or wisdom writes via the CT MCP sidecar.
---

# Curated Thoughts Usage

How to use Curated Thoughts (CT) — a local-first second brain exposed to agent
harnesses through an MCP sidecar — correctly and safely. This skill is for any
CT user on any harness; nothing here is machine-specific.

## What CT is

CT maintains a curated vault of notes (OKF markdown) plus a "wisdom" store of
distilled facts. An MCP sidecar process exposes both over standard MCP tools.
You never touch files or databases directly; every read and write goes through
the sidecar's tools.

## Tool surface by tier

The number of tools the sidecar exposes depends on its version
(see `shared/compat.yaml` in the curated-thoughts-integrations repo for the
authoritative matrix):

- **8-tool tier (sidecar < 2.5)** — search/recall only, plus vault-note
  authoring: `wiki_context`, `wiki_search`, `wiki_traverse_graph`,
  `wiki_get_ontology`, `vault_semantic_search`, `vault_related_chunks`,
  `vault_write_note`, `vault_upsert_index_entry`. Wisdom write tools are
  absent; the write path is dormant.
- **14-tool tier (sidecar >= 2.5)** — adds the wisdom write path:
  `curated_add_wisdom`, `curated_update_wisdom`, `curated_archive_wisdom`
  and companions. All read tools remain.

Check which tier you have by listing tools at session start; route accordingly.

## Prefer one-call recall

For most questions, use the one-call recall tool (`wiki_context`-style) rather
than composing raw searches. It bundles semantic search with graph context and
returns an answer-ready digest in a single round trip. Reach for the raw tools
(`wiki_search`, `vault_semantic_search`, `wiki_traverse_graph`,
`vault_related_chunks`) only for deep work: exhaustive enumeration, targeted
graph walks, or when the digest is not enough.

## Writing

- **Vault notes** (`vault_write_note`, `vault_upsert_index_entry`) are
  available at both tiers. Notes require OKF frontmatter
  (`okf_version`, `profile`, `entity_type`, `created_at`).
- **Wisdom writes** (`curated_add_wisdom` / `curated_update_wisdom` /
  `curated_archive_wisdom`) exist only at the 14-tool tier. Updates use
  If-Match on the entry's `updated_at`; on a stale-match error, re-read the
  entry and retry once — do not loop.
- Decide deliberately between a durable vault note and a wisdom entry; don't
  duplicate the same content in both.

## The golden rule

**Never touch the vault out-of-band.** No direct SQLite access, no hand-editing
files in the brain, no scripts that bypass the sidecar — not even to "fix"
something. The sidecar is the only writer; it owns indexing, embeddings, and
consistency. If a tool call fails, report the error and route around it (see
the curated-thoughts-ops skill) instead of working around the sidecar.
