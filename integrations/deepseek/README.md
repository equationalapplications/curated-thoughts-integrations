# Curated Thoughts for DeepSeek Harness

A Cordis plugin package that connects DeepSeek Harness (`dsh`) to the
[Curated Thoughts](https://github.com/equationalapplications/curated-thoughts)
memory sidecar. Sibling to the
[Hermes integration](../hermes/) — same skills, same doctor, same three-rule
discipline.

## What you get

- **MCP sidecar wired in** — the package ships a DSH bundle patch
  (`cordis.patch.yml`, declared via package.json `dsh.bundle.patch`) that
  mounts `@deepseek-ai/dsh-mcp-client` against `curated-thoughts-mcp --mcp`
  and exposes the Curated Thoughts tool surface as
  `mcp__curated-thoughts__<tool>`.
- **Cached health snapshot** — a named prompt context whose text is the
  latest health probe, refreshed on every `agent/session-start`. The model
  knows whether memory is usable before its first tool call.
- **Three skills** — `curated-thoughts-usage`, `curated-thoughts-ops`,
  `curated-thoughts-sidecar` (verbatim from Hermes).
- **Doctor** — `node lib/scripts/ct_doctor.js check` runs the nine deep checks
  (sidecar binary / identity / MCP reachable / brain / vault / embedding
  backend / dsh registration / import pre-flight / version compat).
- **Idempotent installer** — `scripts/install.sh`.

## Install

From the release tarball (what `scripts/install.sh` automates):

```bash
tar -xzf deepseek-<version>.tar.gz && cd deepseek-<version>
# <profile> is a dsh profile name: headless, web, sdk, sdk-minimal, acp, ...
CT_INSTALL_EDIT=1 ./scripts/install.sh --profile <profile>
```

The installer packs the package with `npm pack` and installs it into the
profile with `dsh plugin --profile <name> add <tarball>`; DSH then activates
the bundle patch automatically. **No YAML is ever edited** — DSH does not
read a hand-edited `$DSH_HOME/cordis.yml`, and hand-written `- name:` rows in
a patch file are unmatched targets, which is why older instructions that
appended blocks do nothing on current DSH.

Without `CT_INSTALL_EDIT=1`, the installer prints the plan and does not write
anything.

> **Custom brain location:** the rows default to `$HOME/.brain`. If your
> brain lives elsewhere, set `CURATED_BRAIN_DIR` (absolute path) in the
> environment when starting dsh — the MCP row resolves it at composition
> time and the plugin's health probe reads the same variable. Note the
> sidecar does not expand `~` itself. To change the rows permanently, add a
> profile patch (later layers win) targeting the row's `id`.

## Verify

```bash
dsh --profile headless --dump-config   # both curated-thoughts rows must appear
node lib/scripts/ct_doctor.js check
node lib/scripts/ct_doctor.js check --json   # machine-readable
```

## End-to-end test

`tests/e2e/run.sh` (local only, not wired into CI) builds the release
artifact, installs it inside a Docker container against a real `dsh` CLI and
the real sidecar, and runs the full check list: installer preview/apply
semantics, `--dump-config` row activation, the doctor, a live-model MCP tool
call, the degraded-health prompt block, literal-`~` handling in
`CURATED_BRAIN_DIR`, and installer idempotency. The verified DSH version is
pinned in `tests/host/compatibility.json`. It shares its base image
(Node 24, sidecar `.deb`, non-root user) with the OpenCode harness — see
`tests/e2e/base.Dockerfile` at the repo root. Requires Docker and, for the
live-model steps, `ZAI_API_KEY` in the environment.

## Compatibility

- **Sidecar:** `curated-thoughts-mcp` ≥ 2.5 (compat tier `v2.5-full`).
- **DeepSeek Harness:** 0.1.5-rc.2 is the pinned, container-verified version
  (`tests/host/compatibility.json`; every published release so far is a
  pre-release). Requires Node ≥ 22.19 or ≥ 24.
- **Platforms:** macOS, Linux, Windows (verified by the CI matrix; the e2e
  container itself is linux/amd64).

## License

MIT — identical to the main Curated Thoughts repository.
