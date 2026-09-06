# curated-thoughts-integrations — Hermes/CT Plugin v0 SPEC (DRAFT)

Status: DRAFT for review · 2026-09-05 · Owner: maintainer · Author: CT integrations team
Decisions: D1 monorepo · D2 name `curated-thoughts-integrations` · D3 full plugin (config + hooks + skills)

## 1. Purpose

A monorepo of open-source integrations connecting Curated Thoughts (CT) to
agent harnesses. Each integration is a self-contained, installable unit in
`integrations/<harness>/`. v0 ships the Hermes Agent plugin; OpenClaw/CT and
Claude Code/CT are planned siblings and must fit without re-architecture.

Non-goals (v0): no CT core changes, no new MCP tools, no agent-specific
content (repo docs must read correctly for any CT user).

## 2. Monorepo layout

```
curated-thoughts-integrations/
├── README.md                      # umbrella: what CT is, integration index, compat matrix
├── LICENSE                        # (matching curated-thoughts repo license)
├── CONTRIBUTING.md                # one-integration-per-dir rules, review gates
├── docs/
│   ├── architecture.md            # shared concepts: sidecar, vault, OKF, tool routing
│   └── spec-hermes-plugin-v0.md   # this document
├── integrations/
│   └── hermes/                    # ← v0 deliverable
│       ├── plugin.json            # Hermes plugin manifest
│   │   ├── hooks/
│   │   │   ├── hooks.json         # session-start hook registration
│   │   │   └── session-start.py   # context injection + health snapshot (fast, read-only)
│   │   ├── skills/
│   │   │   ├── curated-thoughts-usage/SKILL.md   # usage tier (every CT user)
│   │   │   ├── curated-thoughts-ops/SKILL.md     # troubleshooting tier (ops failures)
│   │   │   └── curated-thoughts-sidecar/SKILL.md # sidecar lifecycle tier
│   │   ├── scripts/
│   │   │   ├── ct_doctor.py       # install/doctor checks (§5)
│   │   │   └── install.sh         # idempotent installer (§6)
│   │   ├── install.md             # manual path + what install.sh changes
│   │   └── SKILLS_NOTES.md        # skill authoring conventions for this repo
└── shared/
    └── compat.yaml                # sidecar versions ↔ plugin versions ↔ tool-count tiers
```

Sibling integrations (later): `integrations/openclaw/`, `integrations/claude-code/`
— each bundles its harness's equivalent of manifest/hooks/skills; shared concepts
live in `docs/architecture.md`, never duplicated.

## 3. What the plugin replaces (dogfood target)

Current customized installation → retired by the plugin:

| Today (bespoke)                          | After plugin                                  |
|------------------------------------------|-----------------------------------------------|
| Hand-edited `mcp_servers.curated-thoughts` in ~/.hermes/config.yaml | `install.sh` writes the same block, idempotently |
| Loose CT skills in ~/.hermes/skills/     | Plugin-bundled skills (namespace: `curated-thoughts`) |
| Sidecar health knowledge in agent memory + private skills | `ct_doctor.py` checks + session-start snapshot |
| Agent-specific rules in skill copies     | Stay in the vault; repo skills are user-generic |

## 4. Plugin manifest & registration

`plugin.json` (mirrors the proven superpowers layout):

```json
{
  "name": "curated-thoughts",
  "version": "0.1.0",
  "description": "Curated Thoughts memory integration for Hermes Agent: MCP sidecar, skills, health checks",
  "skills": ["./skills"],
  "hooks": "./hooks/hooks.json"
}
```

Installed via `hermes plugin add <path|git url>` (verify exact command against
current Hermes docs at implementation time). Config ownership: the plugin does
NOT hold API keys; `.env` stays user-owned.

## 5. `ct_doctor.py` — checks (each: PASS / WARN / FAIL + fix hint)

1. Sidecar binary: `curated-thoughts-mcp` on PATH; verify it is the MAIN
   sidecar (dpkg path, e.g. /usr/bin/) not a tools-crate build (same name,
   different build — two servers on one brain is a bug).
2. Sidecar reachable: `tools/list` over MCP; print tool count.
   WARN <14 tools → write path dormant (`curated_add_wisdom` absent).
3. Vault path configured and exists (default ~/Documents/equational-wiki).
4. Vault reachable read-only probe (no out-of-band writes, ever).
5. Embedding backend: OLLAMA_HOST (or configured profile) responds.
6. Hermes registration: plugin dir listed under `plugins:` in config.yaml;
   `mcp_servers.curated-thoughts` present with `--mcp` args.
7. OKF hygiene guidance: If-Match `updated_at` semantics — surfaced as a doc
   check pointer, not a write test.
8. Version compat: sidecar version vs `shared/compat.yaml` matrix.

Exit code 0 = all PASS/WARN; nonzero = FAIL list (CI-usable).

## 6. `install.sh` (idempotent, no sudo)

- Copies plugin into ~/.hermes/plugins/curated-thoughts/ (or registers path).
- Merges `mcp_servers.curated-thoughts` block into ~/.hermes/config.yaml only
  if absent; NEVER overwrites an existing entry (prints it for review).
- Refuses to touch existing loose ~/.hermes/skills/curated-thoughts* copies —
  prints a "remove these to use plugin skills" notice (dogfood step is manual).
- Runs `ct_doctor.py` at the end.

## 7. Skills (open-source versions, agent-specific content stripped)

- **curated-thoughts** (usage): session-start memory rule (prefer
  `wiki_context`), tool routing (raw tools only for deep work), write path
  (vault notes vs CT wisdom, never raw SQLite), stale-update handling.
- **curated-thoughts-ops**: diagnosing unreachable sidecar, vault errors,
  OKF frontmatter requirements (okf_version/profile/entity_type/created_at),
  route-around discipline.
- **curated-thoughts-sidecar**: respawn semantics (lazy respawn by daemon),
  post-.deb kill-then-probe procedure, main-sidecar disambiguation.

## 8. Session-start hook

Fast (<200ms target), read-only, fail-open: locate vault + sidecar, emit a
compact health line + routing reminder into session context. If sidecar is
down: state it plainly and continue (never block session start).

## 9. Delivery flow (per house conventions)

1. Create repo `equationalapplications/curated-thoughts-integrations`
   (visibility TBD — see §10), branch `feat/hermes-plugin-spec`.
2. Spec PR first: this document as `docs/spec-hermes-plugin-v0.md` + repo
   scaffolding (README, LICENSE, CONTRIBUTING, empty integration dirs).
3. Review → merge (regular merge commit, never squash).
4. Implementation PR(s): plugin.json, hook, skills, doctor, installer.
5. CI: lint + shellcheck + `ct_doctor.py --self-test` (mock sidecar fixture).
6. Dogfood: install on the maintainer machine, retire bespoke bits, record findings.

## 10. Resolved decisions

- Repo visibility: **public from birth** — developing in public keeps
  documentation clean and machine-specific content out from day one.
- Skill collision: **warn only.** `install.sh` flags existing loose
  `~/.hermes/skills/curated-thoughts*` copies; it never moves or deletes
  bespoke user configuration.
- License: **MIT**, identical to the main curated-thoughts repository.

## 11. Implementation checklist (follow-up PRs)

- [ ] `integrations/hermes/plugin.json` + hooks skeleton
- [ ] `ct_doctor.py` with mock-sidecar self-test fixtures
- [ ] `install.sh` (idempotent, warn-only collision policy)
- [ ] Three skills (usage / ops / sidecar), user-generic content
- [ ] CI: lint + shellcheck + doctor self-test
- [ ] Dogfood install on maintainer machine; retire bespoke config
