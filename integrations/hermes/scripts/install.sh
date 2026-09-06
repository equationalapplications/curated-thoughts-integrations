#!/usr/bin/env bash
# install.sh — idempotent installer for the Curated Thoughts Hermes plugin.
#
# Part of curated-thoughts-integrations (MIT). POSIX bash, stdlib only,
# no sudo, never destructive: it never overwrites an existing config entry,
# never moves/renames/deletes user files, and only writes inside
# ~/.hermes/plugins/curated-thoughts/ (plus an opt-in config append).
#
# Environment:
#   CT_INSTALL_EDIT=1     opt-in: create ~/.hermes/config.yaml (if absent) or
#                         append an mcp_servers block (only when the file has
#                         no mcp_servers section). Default: print, don't write.
#   HERMES_CT_SIDECAR     override the sidecar command shown in the printed
#                         MCP block (default: curated-thoughts-mcp).
#   HERMES_CONFIG         override config path (default: ~/.hermes/config.yaml).
#
# Docs: docs/spec-hermes-plugin-v0.md §6 and install.md.

set -euo pipefail

PLUGIN_NAME="curated-thoughts"
SIDECAR_CMD="${HERMES_CT_SIDECAR:-curated-thoughts-mcp}"
HERMES_HOME="${HOME}/.hermes"
CONFIG_FILE="${HERMES_CONFIG:-${HERMES_HOME}/config.yaml}"

SCRIPT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${HERMES_HOME}/plugins/${PLUGIN_NAME}"

say() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

mcp_block() {
  cat <<EOF
mcp_servers:
  ${PLUGIN_NAME}:
    command: ${SIDECAR_CMD}
    args: ["--mcp"]
EOF
}

# True if a top-level "mcp_servers:" key exists in the config.
has_mcp_servers_section() {
  [ -f "$CONFIG_FILE" ] && grep -qE '^mcp_servers:' "$CONFIG_FILE"
}

# True if "curated-thoughts:" appears inside the mcp_servers mapping.
# Scope-aware: the key must be indented and within the mcp_servers section
# (section ends at the next non-indented, non-comment top-level key).
has_curated_thoughts_entry() {
  [ -f "$CONFIG_FILE" ] || return 1
  awk '
    /^[[:space:]]*#/ { next }
    /^mcp_servers:/  { insec = 1; next }
    /^[^[:space:]#-]/ { insec = 0 }
    insec && /^[[:space:]]+curated-thoughts:/ { found = 1 }
    END { if (found) exit 0; exit 1 }
  ' "$CONFIG_FILE"
}

# True if the config looks unsafe for a blind append (multi-document YAML,
# tabs, or block anchors/scalars that an appended top-level key could break).
config_is_appendable() {
  [ -f "$CONFIG_FILE" ] || return 0
  if grep -qE '^(---|\.\.\.)' "$CONFIG_FILE"; then
    return 1
  fi
  if grep -qP '\t' "$CONFIG_FILE" 2>/dev/null; then
    return 1
  fi
  return 0
}

install_plugin_files() {
  say "== Plugin files =="
  if [ ! -d "$SCRIPT_SRC" ]; then
    warn "source directory not found: ${SCRIPT_SRC}"
    return 1
  fi
  if [ -d "$DEST_DIR" ]; then
    say "destination exists: ${DEST_DIR}"
    say "refreshing plugin files (existing extra files are left in place)"
  else
    say "creating: ${DEST_DIR}"
    mkdir -p "$DEST_DIR"
  fi
  # Merge-copy: overwrites plugin-owned files, never removes anything.
  cp -R "${SCRIPT_SRC}/." "${DEST_DIR}/"
  # Prune build junk that may exist in a source checkout (plugin-owned dir,
  # so pruning here never touches user files).
  find "${DEST_DIR}" \( -name '__pycache__' -o -name '.git' \) -type d \
    -prune -exec rm -rf {} + 2>/dev/null
  say "copied plugin contents from: ${SCRIPT_SRC}"
}

check_mcp_registration() {
  say ""
  say "== MCP registration (${CONFIG_FILE}) =="
  if has_mcp_servers_section; then
    if has_curated_thoughts_entry; then
      say "OK: mcp_servers.${PLUGIN_NAME} already present — nothing changed."
      return 0
    fi
    say "An 'mcp_servers:' section exists but has no '${PLUGIN_NAME}' key."
    say "Insert the following block INSIDE that section (indent one level):"
    say ""
    mcp_block | sed 's/^/    /'
    say ""
    say "Automatic insertion was skipped to avoid reformatting your config."
    return 0
  fi
  say "No 'mcp_servers:' section found. Add the following to ${CONFIG_FILE}:"
  say ""
  mcp_block
  say ""
  if [ "${CT_INSTALL_EDIT:-0}" = "1" ]; then
    if config_is_appendable; then
      if [ ! -f "$CONFIG_FILE" ]; then
        mkdir -p "$(dirname "$CONFIG_FILE")"
        mcp_block >"$CONFIG_FILE"
        say "CT_INSTALL_EDIT=1: created ${CONFIG_FILE} with the block above."
      else
        say "CT_INSTALL_EDIT=1: appending block to ${CONFIG_FILE}"
        {
          printf '\n'
          mcp_block
        } >>"$CONFIG_FILE"
        say "appended."
      fi
    else
      warn "${CONFIG_FILE} has a non-simple structure (multi-document YAML or tabs);"
      warn "please add the block above manually. Nothing was written."
    fi
  else
    say "Re-run with CT_INSTALL_EDIT=1 to append this block automatically"
    say "(only when the file has no mcp_servers section; your file is never"
    say "overwritten or reformatted)."
  fi
  return 0
}

# True if the plugin is listed under plugins.enabled specifically.
# Scope-aware: a bare list-item scan would also match an entry under
# plugins.disabled and report a disabled plugin as enabled.
has_plugin_enabled() {
  [ -f "$CONFIG_FILE" ] || return 1
  awk -v name="$PLUGIN_NAME" '
    /^[[:space:]]*#/ { next }
    /^plugins:/      { inplugins = 1; inenabled = 0; next }
    /^[^[:space:]#-]/ { inplugins = 0; inenabled = 0 }
    inplugins && /^[[:space:]]+enabled:[[:space:]]*$/ { inenabled = 1; next }
    # any other key at the same level (disabled:, hook_callback_timeout:, ...)
    # closes the enabled list
    inplugins && /^[[:space:]]+[A-Za-z_][A-Za-z0-9_-]*:/ { inenabled = 0; next }
    inenabled && $0 ~ ("^[[:space:]]+-[[:space:]]+" name "[[:space:]]*$") { found = 1 }
    END { if (found) exit 0; exit 1 }
  ' "$CONFIG_FILE"
}

check_plugin_enablement() {
  say ""
  say "== Plugin enablement =="
  if ! grep -qE '^plugins:' "$CONFIG_FILE" 2>/dev/null; then
    say "No 'plugins:' section found. Add to ${CONFIG_FILE}:"
    say ""
    say "plugins:"
    say "  enabled:"
    say "    - ${PLUGIN_NAME}"
    say ""
    say "Without this the MCP tools still work, but the plugin's skills and"
    say "session-start hook stay dormant."
    return 0
  fi
  if has_plugin_enabled; then
    say "OK: '${PLUGIN_NAME}' is listed under plugins.enabled — nothing changed."
  else
    say "A 'plugins:' section exists but does not list '${PLUGIN_NAME}'."
    say "Add it under plugins.enabled:"
    say ""
    say "    - ${PLUGIN_NAME}"
    say ""
    say "Automatic insertion was skipped to avoid reformatting your config."
  fi
}

check_skill_collisions() {
  say ""
  say "== Skill collision check =="
  local found=0 path
  for path in "${HERMES_HOME}/skills/${PLUGIN_NAME}" "${HERMES_HOME}/skills/${PLUGIN_NAME}"-*; do
    if [ -e "$path" ]; then
      found=1
      say "COLLISION (pre-existing, untouched): ${path}"
    fi
  done
  if [ "$found" -eq 0 ]; then
    say "no pre-existing ~/.hermes/skills/${PLUGIN_NAME}* paths — nothing to warn about."
  else
    warn "the plugin ships its own copies of these skills."
    warn "Remove the loose copies manually (or keep them — this installer will"
    warn "never move, rename, or delete user files)."
  fi
}

main() {
  say "curated-thoughts plugin installer (idempotent, no sudo)"
  say ""
  install_plugin_files
  check_mcp_registration
  check_plugin_enablement
  check_skill_collisions
  say ""
  say "== Done =="
  say "Next step — verify the install:"
  say "  python3 ~/.hermes/plugins/${PLUGIN_NAME}/scripts/ct_doctor.py check"
  say ""
  say "Importing a brain from another machine? Point CURATED_BRAIN_DIR at it"
  say "and re-run the doctor — the import pre-flight check reports whether the"
  say "graph's provenance survived the trip before an agent relies on it."
}

main "$@"
