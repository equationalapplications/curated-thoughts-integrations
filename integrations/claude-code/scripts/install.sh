#!/usr/bin/env bash
# install.sh — registration helper for the Curated Thoughts Claude Code plugin.
#
# Part of curated-thoughts-integrations (MIT). POSIX bash, stdlib only,
# no sudo, never destructive.
#
# Unlike the Hermes installer, this script **copies nothing**. A Claude Code
# plugin is loaded from wherever it already lives (`claude --plugin-dir`, or a
# marketplace), so there is no destination tree to populate. What is left is
# registration, and per design decision D1 registration goes through
# `claude mcp add` with an **absolute** sidecar path rather than a
# plugin-shipped .mcp.json: a .mcp.json can only name `curated-thoughts-mcp`
# and rely on PATH, which is exactly what fails on Windows, where the sidecar
# is not on PATH and lives in a directory whose name contains a space.
#
# So this script: resolves the sidecar with the same search order as
# scripts/ct_env.py, prints the registration two ways (the CLI command and the
# JSON block), prints how to load the plugin, and — only under
# CT_INSTALL_EDIT=1, and only when the entry does not already exist — shells
# out to `claude mcp add`. It never edits ~/.claude.json itself and never
# overwrites an existing entry.
#
# Environment:
#   CT_INSTALL_EDIT=1     opt-in: run `claude mcp add` for you, if and only if
#                         `claude` is on PATH and `claude mcp get
#                         curated-thoughts` reports no existing entry.
#                         Default: print, don't write.
#   CLAUDE_CT_SIDECAR     absolute path to the sidecar, skipping discovery.
#                         Read by this installer only: ct_env.py discovers
#                         the sidecar itself and honours no override, so
#                         ct_doctor.py does not see this variable.
#
# Docs: docs/superpowers/specs/2026-09-11-claude-code-integration-design.md

set -euo pipefail

PLUGIN_NAME="curated-thoughts"
MCP_SERVER_KEY="curated-thoughts"
SIDECAR_NAME="curated-thoughts-mcp"
RELEASES_URL="https://github.com/equationalapplications/curated-thoughts/releases/latest"
PLACEHOLDER="<path to ${SIDECAR_NAME}>"

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Under Git Bash / MSYS -- the only way this script runs on Windows -- `pwd`
# yields an MSYS path (/c/Users/...). Every command this script *prints* is
# for a human to paste, quite possibly into PowerShell or cmd, and neither
# those shells nor the native `claude` and `python3` binaries understand that
# form. `cygpath -m` renders C:/Users/... with forward slashes, so the
# double-quoting that already protects the space keeps working unchanged.
# Same reasoning as the sidecar path, which is a Windows path throughout.
if command -v cygpath >/dev/null 2>&1; then
  PLUGIN_DIR="$(cygpath -m "${PLUGIN_DIR}")"
fi

SIDECAR=""
SIDECAR_SOURCE="none"

say() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

# --------------------------------------------------------------------------
# sidecar discovery — same order and same candidates as scripts/ct_env.py
# --------------------------------------------------------------------------

# Windows env vars arrive as C:\... ; bash is happier with forward slashes and
# the Windows API accepts either separator.
slashes() { printf '%s\n' "${1//\\//}"; }

# Mirrors ct_env._windows_candidates(): three roots, each tried under
# "Programs/Curated Thoughts" and then "Curated Thoughts". The 2.10.x
# installer uses the second form under LOCALAPPDATA.
windows_candidates() {
  local root
  local progfiles_x86
  progfiles_x86="$(printenv 'ProgramFiles(x86)' 2>/dev/null || true)"
  for root in "${LOCALAPPDATA:-}" "${PROGRAMFILES:-}" "$progfiles_x86"; do
    [ -n "$root" ] || continue
    root="$(slashes "$root")"
    printf '%s\n' "${root}/Programs/Curated Thoughts/${SIDECAR_NAME}.exe"
    printf '%s\n' "${root}/Curated Thoughts/${SIDECAR_NAME}.exe"
  done
}

# Mirrors ct_env._macos_candidates(): a Tauri externalBin sidecar is staged
# next to the app executable inside the bundle.
macos_candidates() {
  local rel="Curated Thoughts.app/Contents/MacOS/${SIDECAR_NAME}"
  printf '%s\n' "/Applications/${rel}"
  printf '%s\n' "${HOME}/Applications/${rel}"
}

# Mirrors ct_env._linux_candidates().
linux_candidates() {
  printf '%s\n' "/usr/bin/${SIDECAR_NAME}"
  printf '%s\n' "/usr/local/bin/${SIDECAR_NAME}"
  printf '%s\n' "${HOME}/.local/bin/${SIDECAR_NAME}"
  printf '%s\n' "/opt/curated-thoughts/${SIDECAR_NAME}"
}

sidecar_candidates() {
  local kernel
  kernel="$(uname -s 2>/dev/null || printf 'unknown')"
  case "$kernel" in
    Darwin) macos_candidates ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT) windows_candidates ;;
    *) linux_candidates ;;
  esac
}

# Sets SIDECAR and SIDECAR_SOURCE. SIDECAR stays empty when nothing is found;
# that is a WARN, not an error — the registration block still prints.
resolve_sidecar() {
  SIDECAR=""
  SIDECAR_SOURCE="none"

  if [ -n "${CLAUDE_CT_SIDECAR:-}" ]; then
    SIDECAR="${CLAUDE_CT_SIDECAR}"
    SIDECAR_SOURCE="CLAUDE_CT_SIDECAR"
    return 0
  fi

  local found
  if found="$(command -v "$SIDECAR_NAME" 2>/dev/null)"; then
    SIDECAR="$found"
    SIDECAR_SOURCE="PATH"
    return 0
  fi

  local cand
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    if [ -f "$cand" ]; then
      SIDECAR="$cand"
      SIDECAR_SOURCE="bundled"
      return 0
    fi
  done <<<"$(sidecar_candidates)"

  return 0
}

report_sidecar() {
  say "== Sidecar =="
  if [ -n "$SIDECAR" ]; then
    say "found (via ${SIDECAR_SOURCE}): ${SIDECAR}"
    if [ ! -f "$SIDECAR" ]; then
      warn "that path does not exist; the commands below are printed anyway."
    fi
    return 0
  fi
  warn "no ${SIDECAR_NAME} found on PATH or in the usual install locations."
  warn "Install Curated Thoughts first: ${RELEASES_URL}"
  warn "Then re-run this script, or set CLAUDE_CT_SIDECAR to the absolute path."
  say "Continuing with a placeholder path so you can see the shape of the"
  say "registration; substitute the real path before running it."
}

# --------------------------------------------------------------------------
# registration, printed two ways
# --------------------------------------------------------------------------

# The path as it appears in printed shell commands. Always double-quoted: the
# Windows install directory is "Curated Thoughts", with a space in it.
quoted_sidecar() {
  if [ -n "$SIDECAR" ]; then
    printf '"%s"' "$SIDECAR"
  else
    printf '"%s"' "$PLACEHOLDER"
  fi
}

mcp_add_command() {
  printf 'claude mcp add --scope user %s -- %s --mcp\n' \
    "$MCP_SERVER_KEY" "$(quoted_sidecar)"
}

# The same registration as JSON, for ~/.claude.json (user scope) or a project
# .mcp.json. Printed with forward slashes: Windows accepts them and they need
# no JSON escaping, unlike a pasted backslash path.
mcp_json_block() {
  local path
  if [ -n "$SIDECAR" ]; then
    path="$(slashes "$SIDECAR")"
  else
    path="$PLACEHOLDER"
  fi
  cat <<EOF
{
  "mcpServers": {
    "${MCP_SERVER_KEY}": {
      "command": "${path}",
      "args": ["--mcp"]
    }
  }
}
EOF
}

print_registration() {
  say ""
  say "== MCP registration =="
  say "Register the sidecar with Claude Code at user scope:"
  say ""
  say "  $(mcp_add_command)"
  say ""
  say "The path is double-quoted on purpose — the Windows install directory"
  say "contains a space. The equivalent JSON, for ~/.claude.json (user scope)"
  say "or a project-scope .mcp.json beside your repo:"
  say ""
  mcp_json_block | sed 's/^/  /'
  say ""
  say "Verify afterwards with 'claude mcp list' (the server should report"
  say "connected), or /mcp inside a session."
}

print_plugin_enablement() {
  say ""
  say "== Plugin enablement =="
  say "The MCP registration above gives you the tools. The plugin adds the"
  say "skills and the session-start health snapshot. Load this checkout with:"
  say ""
  say "  claude --plugin-dir \"${PLUGIN_DIR}\""
  say ""
  say "Once the plugin is published to a marketplace, the permanent form is:"
  say ""
  say "  claude plugin marketplace add equationalapplications/curated-thoughts-integrations"
  say "  claude plugin install ${PLUGIN_NAME}"
  say ""
  say "Check either with /plugin inside a session."
}

# --------------------------------------------------------------------------
# opt-in write: shell out to `claude mcp add`, never edit ~/.claude.json
# --------------------------------------------------------------------------

maybe_register() {
  say ""
  say "== Registering (CT_INSTALL_EDIT) =="
  if [ "${CT_INSTALL_EDIT:-0}" != "1" ]; then
    say "Nothing was written. This script never edits ~/.claude.json directly."
    say "Re-run with CT_INSTALL_EDIT=1 to have it run the 'claude mcp add' line"
    say "above for you (only when no '${MCP_SERVER_KEY}' entry exists yet; an"
    say "existing entry is never overwritten)."
    return 0
  fi

  if ! command -v claude >/dev/null 2>&1; then
    warn "CT_INSTALL_EDIT=1 but 'claude' is not on PATH; nothing was written."
    warn "Run the 'claude mcp add' line above by hand."
    return 0
  fi

  if [ -z "$SIDECAR" ]; then
    warn "CT_INSTALL_EDIT=1 but no sidecar was found; nothing was written."
    warn "Install Curated Thoughts (${RELEASES_URL}) or set CLAUDE_CT_SIDECAR."
    return 0
  fi

  if claude mcp get "$MCP_SERVER_KEY" >/dev/null 2>&1; then
    say "OK: '${MCP_SERVER_KEY}' is already registered — nothing changed."
    return 0
  fi

  say "no '${MCP_SERVER_KEY}' entry found; running:"
  say "  $(mcp_add_command)"
  if claude mcp add --scope user "$MCP_SERVER_KEY" -- "$SIDECAR" --mcp; then
    say "registered."
  else
    warn "'claude mcp add' failed; nothing else was attempted."
    warn "Run the command above by hand and check its output."
  fi
}

main() {
  say "curated-thoughts Claude Code plugin installer"
  say "(prints instructions; writes only with CT_INSTALL_EDIT=1)"
  say ""
  resolve_sidecar
  report_sidecar
  print_registration
  print_plugin_enablement
  maybe_register
  say ""
  say "== Done =="
  say "Next step — verify the install:"
  say "  python3 \"${PLUGIN_DIR}/scripts/ct_doctor.py\" check"
  say ""
  say "Importing a brain from another machine? Point CURATED_BRAIN_DIR at it"
  say "and re-run the doctor — the import pre-flight check reports whether the"
  say "graph's provenance survived the trip before an agent relies on it."
}

main "$@"
