# Contributing

Thanks for your interest in improving the Curated Thoughts integrations.

## Repository layout

- `integrations/<harness>/` — one self-contained integration per agent
  harness. Nothing in one integration may depend on another.
- `docs/` — shared architecture and per-integration specs.
- `shared/` — cross-integration data (compatibility matrices). No code.

## Rules

1. **Spec before implementation.** Every new integration or significant
   change lands as a spec PR in `docs/` first, gets review, then a separate
   implementation PR.
2. **Merge commits only.** PRs merge via regular merge commits — no squash,
   no rebase merges.
3. **No machine-specific content.** No hardcoded home directories, usernames,
   API keys, or environment quirks. Anything user-specific belongs in that
   user's own configuration, never in the repo.
4. **Zero dependencies for scripts.** Doctor/install/hook scripts use the
   standard library of their language only (Python stdlib, POSIX shell).
5. **Fail open.** Runtime hooks must never block an agent session; doctor
   scripts must never mutate configuration without an explicit flag.
6. **Respect the vault.** Integrations read and write Curated Thoughts
   exclusively through the sidecar's MCP tools. Any code that opens the
   brain's database directly will be rejected.

## Review gates

CI is manifest-driven: `discover` selects the integrations a change affects
(everything, on `main` and tags), each runs its declared checks, and a
repository-wide `policy` job enforces the rules above automatically —
version and changelog hygiene, the architecture rules in this document, and
`shared/compat.yaml` drift. Branch protection requires the single `ci-ok`
check. See [`docs/ci.md`](docs/ci.md) for what each gate means and how to run
it locally.

One review approval is required; spec PRs also need the maintainer's sign-off
on scope before the implementation PR opens.

## License

By contributing you agree your contributions are licensed under the MIT
License covering this repository.
