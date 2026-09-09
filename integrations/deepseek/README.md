# Curated Thoughts for DeepSeek Harness

Cordis plugin module that wires the Curated Thoughts memory sidecar into
DeepSeek Harness (`pnpm dsh`). See the design spec at
[`docs/superpowers/specs/2026-09-09-deepseek-harness-integration-design.md`](../../docs/superpowers/specs/2026-09-09-deepseek-harness-integration-design.md).

## Status

Planned — `status: planned` in `integration.yaml` until the doctor, status
probe, and install.sh are all green.

## Install

`./scripts/install.sh` (prints by default; `CT_INSTALL_EDIT=1` to write).

## Verify

`pnpm exec tsc --noEmit && pnpm test`.
