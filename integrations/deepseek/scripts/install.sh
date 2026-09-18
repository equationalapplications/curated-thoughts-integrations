#!/usr/bin/env bash
# install.sh — idempotent installer for the Curated Thoughts dsh integration.
#
# Part of curated-thoughts-integrations (MIT). POSIX bash, stdlib only.
# Prints by default; CT_INSTALL_EDIT=1 to install.
#
# DSH never reads a hand-edited $DSH_HOME/cordis.yml, and bare `- name:` rows
# in a patch file are unmatched targets — so this installer does not edit any
# YAML. The package ships its own bundle patch (cordis.patch.yml, declared in
# package.json under dsh.bundle.patch): installing the package with
# `dsh plugin add` is what activates it.
#
# Environment:
#   CT_INSTALL_EDIT=1     opt-in: pack this package and install it into the
#                         profile with `dsh plugin --profile <name> add`.
#                         Default: print, don't write.
#   DSH_HOME              override dsh config root (default: ~/.dsh)
#
# Arguments:
#   --profile <name>      target profile (required). <name> must be a single
#                         path segment. Shipped dsh profiles: web, headless,
#                         sdk, sdk-minimal, acp.
#
# Spec: docs/superpowers/specs/2026-09-09-deepseek-harness-integration-design.md §4, §7

set -euo pipefail

PLUGIN_SCOPE="@equational-applications/dsh-curated-thoughts"
DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"

PROFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      [ $# -ge 2 ] || { printf 'install.sh: --profile requires a name\n' >&2; exit 2; }
      # The name is interpolated straight into PROFILE_DIR below, so it has to
      # be a single path segment: `--profile ../../elsewhere` would otherwise
      # aim the install outside ${DSH_HOME}. Checked here rather than after
      # the loop so an explicitly empty name is caught too — post-loop, "" is
      # indistinguishable from "no --profile given".
      case "$2" in
        '' | . | ..)
          printf 'install.sh: --profile needs a single path segment, not %s\n' \
            "${2:-an empty name}" >&2
          exit 2
          ;;
        */* | *\\*)
          printf 'install.sh: --profile must not contain a path separator: %s\n' "$2" >&2
          exit 2
          ;;
      esac
      PROFILE="$2"
      shift 2
      ;;
    *)
      printf 'install.sh: unknown argument: %s\n' "$1" >&2
      printf 'usage: install.sh --profile <name>   (CT_INSTALL_EDIT=1 to apply)\n' >&2
      exit 2
      ;;
  esac
done

if [ -z "$PROFILE" ]; then
  printf 'install.sh: --profile <name> is required.\n' >&2
  printf 'DSH composes plugins per profile; there is no global plugin list to edit.\n' >&2
  printf 'Shipped profiles: web, headless, sdk, sdk-minimal, acp.\n' >&2
  printf 'Example: CT_INSTALL_EDIT=1 ./scripts/install.sh --profile headless\n' >&2
  exit 2
fi

SCRIPT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${DSH_HOME}/profiles/${PROFILE}"
INSTALLED_PKG="${PROFILE_DIR}/node_modules/${PLUGIN_SCOPE}"

say() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

# The packed-tarball staging dir, set by do_install and removed at exit. A
# script-scope variable because an EXIT trap runs after do_install's locals
# are gone (and `set -u` would abort on the unbound name).
INSTALL_TMP=""
cleanup() {
  if [ -n "$INSTALL_TMP" ]; then rm -rf "$INSTALL_TMP"; fi
}
trap cleanup EXIT

installed_version() {
  [ -f "$INSTALLED_PKG/package.json" ] || return 1
  # `|| ''` so a package.json without a version prints nothing rather than
  # the string "undefined" — an empty result means "not (properly) installed".
  local v
  v=$(node -p "require('$INSTALLED_PKG/package.json').version || ''" 2>/dev/null) || return 1
  [ -n "$v" ] || return 1
  printf '%s\n' "$v"
}

check_prerequisites() {
  local missing=0
  for tool in dsh pnpm npm node; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      warn "$tool not found on PATH"
      missing=1
    fi
  done
  if [ "$missing" -ne 0 ]; then
    warn "installing requires the dsh CLI and pnpm (dsh plugin add forwards to pnpm)."
    warn "See https://github.com/deepseek-ai/deepseek-harness for dsh install instructions."
    return 1
  fi
  return 0
}

plan_install() {
  say ""
  say "== Plugin install (${PROFILE_DIR}) =="
  local version own
  if version="$(installed_version)"; then
    own="$(node -p "require('$SCRIPT_SRC/package.json').version" 2>/dev/null || true)"
    if [ -n "$own" ] && [ "$version" = "$own" ]; then
      say "OK: ${PLUGIN_SCOPE}@${version} already installed in profile '${PROFILE}' — nothing to do."
      return 0
    fi
    say "Profile '${PROFILE}' has ${PLUGIN_SCOPE}@${version} but this package is ${own:-unknown} — re-adding."
  fi
  if [ "${CT_INSTALL_EDIT:-0}" = "1" ]; then
    say "Installing (no YAML editing — the package carries its own bundle patch):"
  else
    say "Would install (no YAML editing — the package carries its own bundle patch):"
  fi
  say ""
  say "  1. npm pack ${SCRIPT_SRC}          # packed tarball of this package"
  say "  2. dsh plugin --profile ${PROFILE} add <packed.tgz>"
  say ""
  say "The package's cordis.patch.yml (declared via package.json dsh.bundle.patch)"
  say "then activates two rows: this plugin and the @deepseek-ai/dsh-mcp-client"
  say "stdio bridge that exposes the curated-thoughts-mcp sidecar."
  if [ "${CT_INSTALL_EDIT:-0}" = "1" ]; then
    do_install
  else
    say ""
    say "Re-run with CT_INSTALL_EDIT=1 to install."
  fi
}

do_install() {
  # Pack into a temp dir OUTSIDE the package: the tarball must never be able
  # to pack itself, and an in-tree artifact would dirty a user's checkout.
  local tarball
  INSTALL_TMP="$(mktemp -d)"
  tarball="$(npm pack --pack-destination "$INSTALL_TMP" --silent "$SCRIPT_SRC" | tail -1)"
  if [ ! -f "$INSTALL_TMP/$tarball" ]; then
    warn "npm pack did not produce $tarball — aborting."
    exit 1
  fi
  say "Packed: $tarball"
  say "Installing into profile '${PROFILE}' via dsh plugin add..."
  dsh plugin --profile "$PROFILE" add "$INSTALL_TMP/$tarball"
  say "Installed ${PLUGIN_SCOPE} into ${PROFILE_DIR}."
  say "Restart any running dsh session for the profile to pick it up."
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
  # Preserve check_prerequisites failures on the write path: with
  # CT_INSTALL_EDIT=1 we'd otherwise `npm pack` successfully and only then
  # see `dsh plugin add: command not found`. The preview path keeps going
  # regardless so users can read the plan on a host that hasn't installed
  # dsh yet.
  if ! check_prerequisites && [ "${CT_INSTALL_EDIT:-0}" = "1" ]; then
    warn "refusing to install until the prerequisites above are on PATH."
    exit 1
  fi
  plan_install
  verify_with_doctor
  say ""
  say "== Done =="
  say "Next step — verify the install:"
  say "  dsh --profile ${PROFILE} --dump-config   # both curated-thoughts rows must appear"
  say "  node ${SCRIPT_SRC}/lib/scripts/ct_doctor.js check"
  say ""
  say "Importing a brain from another machine? Point CURATED_BRAIN_DIR at it"
  say "and re-run the doctor — the import pre-flight check reports whether the"
  say "graph's provenance survived the trip before an agent relies on it."
}

main "$@"
