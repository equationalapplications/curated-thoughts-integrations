# curated-thoughts-integrations — Hermes/CT Plugin v0 SPEC (DRAFT)

Status: IMPLEMENTED · 2026-09-05, revised 2026-09-06 · Owner: maintainer · Author: CT integrations team

> **Revision note (2026-09-06).** §4, §5 and §8 were written against the
> superpowers/Claude Code plugin layout and did not match Hermes. Corrected
> here: Hermes uses `plugin.yaml` + a `register(ctx)` entry point, names the
> event `on_session_start`, and exposes `PLUGIN_ROOT` (not
> `CLAUDE_PLUGIN_ROOT`). §5's environment contract was also wrong — Curated
> Thoughts reads `CURATED_BRAIN_DIR`, and the brain directory is not the
> vault. Check 7 (a static OKF advisory) is replaced by a real import
> pre-flight tied to curated-thoughts PR #188.
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
│       ├── plugin.yaml            # Hermes native plugin manifest (§4)
│       ├── hooks/
│       │   └── session-start.py   # context injection + health snapshot (fast, read-only)
│       ├── skills/
│       │   ├── curated-thoughts-usage/SKILL.md   # usage tier (every CT user)
│       │   ├── curated-thoughts-ops/SKILL.md     # troubleshooting tier (ops failures)
│       │   └── curated-thoughts-sidecar/SKILL.md # sidecar lifecycle tier
│       ├── scripts/
│       │   ├── ct_doctor.py       # install/doctor checks (§5)
│       │   └── install.sh         # idempotent installer (§6)
│       ├── install.md             # manual path + what install.sh changes
│       └── SKILLS_NOTES.md        # skill authoring conventions for this repo
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

`plugin.yaml` plus an `__init__.py` exporting `register(ctx)` — the Hermes
native plugin shape:

```yaml
name: curated-thoughts
version: 0.2.0
description: >-
  Curated Thoughts memory integration for Hermes Agent...
provides_hooks:
  - on_session_start
```

```python
def register(ctx):
    ctx.register_skill(name, path)              # ×3
    ctx.register_hook("on_session_start", cb)
    ctx.register_system_prompt_section("curated-thoughts", section)
```

Two runtime contracts verified against the real `hermes_cli.plugins` API
(dogfood 2026-09-06; both were registration bugs in v0.2.0, fixed in the
same PR):

- **Section callables receive an argument.** Hermes calls
  `register_system_prompt_section` callables with a read-only session-info
  mapping. A zero-arg callback passes registration but raises at render
  time, and Hermes skips the section — the `## Curated Thoughts` block
  silently disappears from every session. Accept the argument and ignore
  it (`def section(session_info=None)`) unless the section is
  session-scoped by design.
- **`register_skill` requires a `Path`.** It probes `path.exists()`;
  passing a `str` raises `AttributeError` for every skill, and the plugin
  swallows the exception, so all skills silently fail to register. Verify
  with `hermes plugins doctor <name>` and a fresh-session
  `skill_view("curated-thoughts:<name>")`.

Note on visibility: plugin skills are opt-in. They resolve via
`skill_view("<plugin>:<skill>")` but are deliberately **not** listed in
the `skills_list` index (plugins.py: "opt-in explicit loads only") — an
acceptance test that greps `skills_list` for the plugin skills will fail
against a healthy install. `superpowers:*` skills appear there only
because their bootstrap content self-lists.

Plugins live in `~/.hermes/plugins/<name>/` and are enabled via
`plugins.enabled` in `~/.hermes/config.yaml`; `hermes plugins install
owner/repo` is the packaged path. The plugin registers no tools of its own —
the tool surface is the MCP sidecar, registered under `mcp_servers`.

Config ownership: the plugin does NOT hold API keys; `.env` stays user-owned.

## 5. `ct_doctor.py` — checks (each: PASS / WARN / FAIL + fix hint)

1. Sidecar binary: `curated-thoughts-mcp` on PATH, else this platform's
   install location — macOS app bundle (Tauri `externalBin`), Linux
   `/usr/bin`, Windows Programs dir. No dpkg assumption: CT ships on all three.
2. Sidecar identity: the resolved binary is an installed sidecar, not a build
   output from a source checkout (`target/`, `tools/`). Two servers on one
   brain is a bug; disambiguate by path, OS-agnostically.
3. Sidecar reachable: `tools/list` over MCP; the tool count determines the
   tier (8 = v2.4-read, 14 = v2.5-full). WARN at 8 → write path dormant.
4. Brain directory: resolved as Curated Thoughts resolves it —
   `CURATED_BRAIN_DIR` / `CURATED_BRAIN_DB` / `CURATED_BRAIN_CONFIG`,
   default `~/.brain`. Holds `brain.db` + `config.json`.
5. Vault: the documents tree named by `vault_path` **inside config.json** —
   a different thing from the brain dir, and machine-specific, so it is the
   usual casualty of importing a brain. Read-only probe; no writes, ever.
6. Embedding backend: OLLAMA_HOST (or configured profile) responds.
7. Hermes registration: `mcp_servers.curated-thoughts` with `--mcp` args, AND
   `curated-thoughts` under `plugins.enabled`.
8. Import pre-flight: engine version + a census of every
   `llm_wiki_entries.source_ref`, classifying rows as token / at_risk /
   mangled and checking that `librarian_evidence` travelled with the entries.
   Read-only (`mode=ro` URI). See curated-thoughts PR #188.
9. Version compat: best-effort sidecar version vs `shared/compat.yaml`. The
   sidecar has no `--version` flag and MCP `serverInfo` reports the rmcp
   framework version, so an undiscoverable version is PASS, not WARN; this
   check warns only when a discoverable version disagrees with the live tool
   count.

Exit code 0 = all PASS, 1 = any FAIL, 2 = WARNs only (CI-usable).

## 6. `install.sh` (idempotent, no sudo)

- Copies plugin into ~/.hermes/plugins/curated-thoughts/ (or registers path).
- Prunes build junk and stale Claude Code-era manifests (`plugin.json`,
  `hooks/hooks.json`) left by pre-0.2 installs — Hermes never read them;
  a stale copy at the destination masks the real `plugin.yaml`.
- Neither the copy nor the prune ever follows a symlink out of the
  plugin-owned destination: a symlinked `hooks/` is unlinked first (the link
  only — its target's contents are left untouched) and replaced by the real
  directory, so no write or delete can escape the destination.
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

Fast (<200ms target), read-only, fail-open: locate brain + vault + sidecar,
emit a compact health line + routing reminder into session context. If the
sidecar is down: state it plainly and continue (never block session start).

**Emit-always, never silent.** Verified 2026-09-06: on a healthy machine
the hook emits a "Memory sidecar ready (brain: …)" block plus the routing
reminder — silence is *not* the success signal. Degraded machines get a
"Memory sidecar DEGRADED" block listing the first findings; both paths
exit 0 (fail-open). The degraded knob is `CURATED_BRAIN_DIR` (point it at
a missing directory to exercise the degraded path); `CT_VAULT_DIR` is not
a Curated Thoughts variable and nothing reads it.

Hermes offers two mechanisms and the plugin supports both:

- **Native plugin hook** — `ctx.register_hook("on_session_start", ...)` plus
  `ctx.register_system_prompt_section(...)` for the injected block.
- **Shell hook** — `hooks/session-start.py`, wired into the `hooks:` block of
  `~/.hermes/config.yaml`, following Hermes' stdin-JSON / stdout-JSON
  protocol. Shell hooks are consent-gated per (event, command) pair.

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

## 12. Process-matching contract

Any script in this repo (or shipped by it) that must find, signal, or wait
on the Curated Thoughts sidecar process uses the path-anchored full-command
line pattern — never name-based matching (`pgrep -x` / `pkill -x` /
`killall`), which can never match the sidecar (15-character `/proc/<pid>/comm`
limit), and never an unanchored `-f` pattern, which also matches supervisor
wrappers and the invoking shell:

```bash
pgrep -f '^/usr/bin/curated-thoughts-mcp([[:space:]]|$)'
pkill -f '^/usr/bin/curated-thoughts-mcp([[:space:]]|$)'
```

Full contract, forbidden-pattern table, and the launch-path assumption:
[`docs/process-matching.md`](process-matching.md).
