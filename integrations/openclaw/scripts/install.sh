#!/usr/bin/env bash
# install.sh — preview-first installer for the Curated Thoughts OpenClaw
# plugin.
#
# Part of curated-thoughts-integrations (MIT). POSIX bash, no sudo. OpenClaw
# owns plugin installation, so this script only drives the host's own CLI
# (pin: openclaw 2026.10.3):
#
#   1. openclaw plugins install <this plugin dir> --force
#        (--force acknowledges installing from a local source; the manifest
#        mounts the curated-thoughts MCP server and the three skills)
#   2. openclaw config set plugins.entries.curated-thoughts.hooks.allowConversationAccess true
#        (OpenClaw refuses non-bundled prompt hooks without this grant)
#   3. openclaw config set plugins.entries.curated-thoughts.hooks.timeouts.before_prompt_build 20000
#        (first-turn worst case is ~14 s against a 15 s default budget)
#   4. node lib/scripts/ct_doctor.js check   (verification)
#
# By default it PRINTS the commands and writes nothing.
#
# Environment:
#   CT_INSTALL_EDIT=1      opt-in: run the commands. Default: preview only.
#   OPENCLAW_BIN           openclaw executable (default: `openclaw` on PATH)
#   OPENCLAW_CONFIG_PATH / OPENCLAW_STATE_DIR   passed through to openclaw
#
# Exit codes: 0 ok, 1 error, 2 usage.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLUGIN_ID="curated-thoughts"
OPENCLAW="${OPENCLAW_BIN:-openclaw}"

say() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

for arg in ${1+"$@"}; do
  case "$arg" in
    -h|--help)
      sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      warn "unknown argument: $arg"
      exit 2
      ;;
  esac
done

if [ ! -f "${PLUGIN_DIR}/lib/src/index.js" ]; then
  warn "${PLUGIN_DIR}/lib/src/index.js not found — build first with: pnpm run build"
  exit 1
fi

edit=0
if [ "${CT_INSTALL_EDIT:-0}" = "1" ]; then
  edit=1
fi

run() {
  # Display every command; execute only under CT_INSTALL_EDIT=1.
  say "  $*"
  if [ "$edit" -eq 1 ]; then
    "$@"
  fi
}

if [ "$edit" -eq 1 ]; then
  say "curated-thoughts OpenClaw install.sh — CT_INSTALL_EDIT=1: applying (no sudo)"
  if ! command -v "$OPENCLAW" >/dev/null 2>&1; then
    warn "openclaw not found (set OPENCLAW_BIN or install OpenClaw >= 2026.10.3)"
    exit 1
  fi
else
  say "curated-thoughts OpenClaw install.sh — PREVIEW: nothing will be written (no sudo)"
fi
say ""
run "$OPENCLAW" plugins install "$PLUGIN_DIR" --force
run "$OPENCLAW" config set "plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess" true
run "$OPENCLAW" config set "plugins.entries.${PLUGIN_ID}.hooks.timeouts.before_prompt_build" 20000

say ""
if [ "$edit" -eq 1 ]; then
  if command -v node >/dev/null 2>&1; then
    node "${PLUGIN_DIR}/lib/scripts/ct_doctor.js" check || warn "doctor reported problems (see above)"
  fi
  say "Done. Verify the running gateway with: $OPENCLAW plugins inspect ${PLUGIN_ID} --runtime --json"
else
  say "This was a preview. To apply it:"
  say "  CT_INSTALL_EDIT=1 $0"
fi
