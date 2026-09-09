#!/usr/bin/env bash
# install.sh — idempotent installer for the Curated Thoughts dsh integration.
#
# Part of curated-thoughts-integrations (MIT). POSIX bash, stdlib only.
# Prints by default; CT_INSTALL_EDIT=1 to write.
#
# Environment:
#   CT_INSTALL_EDIT=1     opt-in: append the plugin entry to cordis.yml
#                         (only when absent). Default: print, don't write.
#   DSH_HOME              override dsh config root (default: ~/.dsh)
#
# Arguments:
#   --profile <name>      target the per-profile patch
#                         (${DSH_HOME}/profiles/<name>/cordis.patch.yml)
#                         instead of the global ${DSH_HOME}/cordis.yml
#
# Spec: docs/superpowers/specs/2026-09-09-deepseek-harness-integration-design.md §4, §7

set -euo pipefail

PLUGIN_NAME="@equational-applications/dsh-curated-thoughts"
DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"

PROFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      [ $# -ge 2 ] || { printf 'install.sh: --profile requires a name\n' >&2; exit 2; }
      PROFILE="$2"
      shift 2
      ;;
    *)
      printf 'install.sh: unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

CONFIG_FILE="${DSH_HOME}/cordis.yml"
if [ -n "$PROFILE" ]; then
  CONFIG_FILE="${DSH_HOME}/profiles/${PROFILE}/cordis.patch.yml"
fi

SCRIPT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

plugin_block() {
  cat <<EOF
# Curated Thoughts integration (idempotent — install.sh detects + skips duplicates)
- name: '${PLUGIN_NAME}'
  config:
    brainDir: ~/.brain
EOF
}

# True if the plugin entry is already in cordis.yml as a list item.
# Accepts both bare and quoted name scalars — a leading @ is a reserved YAML
# indicator, so the doctor (and hand-edited files) use the quoted form.
has_plugin_entry() {
  [ -f "$CONFIG_FILE" ] || return 1
  awk -v name="$PLUGIN_NAME" -v sq="'" '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*-[[:space:]]*name:[[:space:]]*/ {
      line = $0
      sub(/^[[:space:]]*-[[:space:]]*name:[[:space:]]*/, "", line)
      gsub(/[[:space:]]*$/, "", line)
      q1 = substr(line, 1, 1)
      qn = substr(line, length(line), 1)
      if (q1 == "\"" && qn == "\"") { line = substr(line, 2, length(line) - 2) }
      else if (q1 == sq && qn == sq) { line = substr(line, 2, length(line) - 2) }
      if (line == name) { found = 1 }
    }
    END { if (found) exit 0; exit 1 }
  ' "$CONFIG_FILE"
}

config_is_appendable() {
  [ -f "$CONFIG_FILE" ] || return 0
  if grep -qE '^(---|\.\.\.)' "$CONFIG_FILE"; then
    return 1
  fi
  # A literal tab in the pattern (not grep -P): BSD grep rejects -P with
  # exit 2, which a suppressed-stderr -q check cannot tell from "no tabs".
  if grep -q "$(printf '\t')" "$CONFIG_FILE" 2>/dev/null; then
    return 1
  fi
  return 0
}

check_mcp_mount() {
  say ""
  say "== Plugin entry (${CONFIG_FILE}) =="
  if has_plugin_entry; then
    say "OK: ${PLUGIN_NAME} already present — nothing changed."
    return 0
  fi
  say "Append the following to ${CONFIG_FILE} (as a list item, not under any key):"
  say ""
  plugin_block
  say ""
  if [ "${CT_INSTALL_EDIT:-0}" = "1" ]; then
    if config_is_appendable; then
      if [ ! -f "$CONFIG_FILE" ]; then
        mkdir -p "$(dirname "$CONFIG_FILE")"
        # Create a minimal cordis.yml if absent — the plugin entry as the only
        # list item. dsh accepts a single-entry list.
        plugin_block >"$CONFIG_FILE"
        say "CT_INSTALL_EDIT=1: created ${CONFIG_FILE} with the block above."
      else
        say "CT_INSTALL_EDIT=1: appending block to ${CONFIG_FILE}"
        {
          printf '\n'
          plugin_block
        } >>"$CONFIG_FILE"
        say "appended."
      fi
    else
      warn "${CONFIG_FILE} has a non-simple structure (multi-document YAML or tabs);"
      warn "please add the block above manually. Nothing was written."
    fi
  else
    say "Re-run with CT_INSTALL_EDIT=1 to append this block automatically"
    say "(only when absent; your file is never overwritten or reformatted)."
  fi
}

verify_with_doctor() {
  say ""
  say "== Doctor =="
  local doctor="${SCRIPT_SRC}/lib/scripts/ct_doctor.js"
  if [ -f "$doctor" ]; then
    if node "$doctor" check; then
      say "OK: doctor reports all checks passing."
    else
      say "doctor reported warnings or failures. Re-run for details:"
      say "  node ${doctor} check"
    fi
  else
    warn "${doctor} not found — build first with: pnpm run build"
  fi
}

main() {
  say "curated-thoughts dsh installer (idempotent, no sudo)"
  say ""
  check_mcp_mount
  verify_with_doctor
  say ""
  say "== Done =="
  say "Next step — verify the install:"
  say "  node ${SCRIPT_SRC}/lib/scripts/ct_doctor.js check"
  say ""
  say "Importing a brain from another machine? Point CURATED_BRAIN_DIR at it"
  say "and re-run the doctor — the import pre-flight check reports whether the"
  say "graph's provenance survived the trip before an agent relies on it."
}

main "$@"
