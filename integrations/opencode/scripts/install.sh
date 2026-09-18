#!/usr/bin/env bash
# install.sh — preview-first installer for the Curated Thoughts OpenCode
# integration.
#
# Part of curated-thoughts-integrations (MIT). POSIX bash, no sudo. A thin
# wrapper: all logic lives in lib/scripts/install.js (a self-contained Node
# bundle — no node_modules needed), which this script runs with the same
# arguments and whose exit code it returns.
#
# What it does (spec §4, §7):
#   - unpacks the payload to ${XDG_DATA_HOME:-~/.local/share}/curated-thoughts/opencode/
#   - writes ONE loader file, ~/.config/opencode/plugins/curated-thoughts.js
#   - copies the three skills to ~/.config/opencode/skills/<name>/SKILL.md
#   - adds mcp["curated-thoughts"] to ~/.config/opencode/opencode.json[c]
#     (comment-preserving; .bak backup first; never touches the plugin array)
#   - runs the doctor as the verification step
# It never runs `npm install -g`.
#
# Environment:
#   CT_INSTALL_EDIT=1     opt-in: apply the proposal. Default: preview only,
#                         nothing is written.
#   XDG_CONFIG_HOME       OpenCode config root (default: ~/.config)
#   XDG_DATA_HOME         payload root (default: ~/.local/share)
#   CURATED_BRAIN_DIR     brain directory written into the mcp entry
#                         (default: ~/.brain)
#
# Arguments:
#   --skip-config         install payload, loader and skills; print the mcp
#                         block for manual merge instead of editing opencode.json
#   -h, --help            usage
#
# Exit codes: 0 ok, 1 error/aborted, 2 usage, 3 conflicts reported.
#
# Spec: docs/superpowers/specs/2026-09-17-opencode-integration-design.md §4, §7

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="${SCRIPT_DIR}/../lib/scripts/install.js"

say() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

if ! command -v node >/dev/null 2>&1; then
  warn "node not found on PATH — the installer needs Node.js (>= 22)."
  exit 1
fi

if [ ! -f "$INSTALLER" ]; then
  warn "${INSTALLER} not found — build first with: pnpm run build"
  exit 1
fi

edit=0
if [ "${CT_INSTALL_EDIT:-0}" = "1" ]; then
  edit=1
fi

if [ "$edit" -eq 1 ]; then
  say "curated-thoughts OpenCode install.sh — CT_INSTALL_EDIT=1: applying (no sudo)"
else
  say "curated-thoughts OpenCode install.sh — PREVIEW: nothing will be written (no sudo)"
fi
say ""

status=0
node "$INSTALLER" "$@" || status=$?

if [ "$edit" -eq 0 ] && [ "$status" -ne 2 ]; then
  say ""
  say "This was a preview. To apply it:"
  say "  CT_INSTALL_EDIT=1 $0${*:+ $*}"
fi

exit "$status"
