#!/usr/bin/env bash
# install.sh — preview-first installer for the Curated Thoughts OpenClaw
# plugin.
#
# Part of curated-thoughts-integrations (MIT). POSIX bash, no sudo. OpenClaw
# owns plugin installation, so this script stages a self-contained copy of
# the plugin and drives the host's own CLI (pin: openclaw 2026.10.3):
#
#   1. stage <tmp>/curated-thoughts: lib/, skills/, openclaw.plugin.json and a
#      package.json whose monorepo-relative ct-wisdom-core dependency is
#      replaced by the BUILT core vendored at node_modules/ (a file: dep is
#      meaningless at the install location — deepseek fix e459690)
#   2. openclaw plugins install <stage> --force --accept-capabilities
#        (--force/--accept-capabilities: OpenClaw asks before installing a
#        local copy; you review and accept by opting in with CT_INSTALL_EDIT=1)
#   3. openclaw config set plugins.entries.curated-thoughts.hooks.allowConversationAccess true
#        (OpenClaw refuses non-bundled prompt hooks without this grant)
#   4. openclaw config set plugins.entries.curated-thoughts.hooks.timeouts.before_prompt_build 20000
#        (first-turn worst case is ~14 s against a 15 s default budget)
#   5. node lib/scripts/ct_doctor.js check   (verification)
#
# By default it PRINTS the plan and writes nothing.
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
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

core_lib=""
for candidate in \
  "${PLUGIN_DIR}/lib/ct-wisdom-core" \
  "${PLUGIN_DIR}/../../packages/ct-wisdom-core/lib"; do
  if [ -f "${candidate}/index.js" ]; then
    core_lib="$candidate"
    break
  fi
done
if [ -z "$core_lib" ]; then
  warn "ct-wisdom-core build output not found — build it first:"
  warn "  (cd packages/ct-wisdom-core && pnpm install && pnpm run build)"
  exit 1
fi

edit=0
if [ "${CT_INSTALL_EDIT:-0}" = "1" ]; then
  edit=1
fi

stage_plugin() {
  # $1 = the staged plugin path. Called directly (never inside $(...)) so
  # that `set -e` applies: bash clears errexit in command substitutions
  # (macOS bash 3.2 has no inherit_errexit), and a half-staged copy must
  # never reach `plugins install --force`.
  local stage="$1"
  mkdir -p "$stage/node_modules/@equational-applications/ct-wisdom-core"
  cp -R "${PLUGIN_DIR}/lib" "${PLUGIN_DIR}/skills" "${PLUGIN_DIR}/openclaw.plugin.json" \
    "${PLUGIN_DIR}/package.json" "$stage/"
  rm -rf "$stage/lib/ct-wisdom-core"
  cp -R "${core_lib}/." "$stage/node_modules/@equational-applications/ct-wisdom-core/"
  cat >"$stage/node_modules/@equational-applications/ct-wisdom-core/package.json" <<'VPKG'
{
  "name": "@equational-applications/ct-wisdom-core",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "types": "index.d.ts"
}
VPKG
  node - "$stage/package.json" <<'NJS'
const fs = require('fs');
const p = process.argv[2];
const m = JSON.parse(fs.readFileSync(p, 'utf8'));
if (m.dependencies) delete m.dependencies['@equational-applications/ct-wisdom-core'];
if (m.dependencies && Object.keys(m.dependencies).length === 0) delete m.dependencies;
delete m.devDependencies;
delete m.scripts;
m.bundleDependencies = ['@equational-applications/ct-wisdom-core'];
fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
NJS
  if [ ! -f "$stage/lib/src/index.js" ] || \
     [ ! -f "$stage/node_modules/@equational-applications/ct-wisdom-core/index.js" ]; then
    warn "staging incomplete at $stage — aborting before install"
    exit 1
  fi
}

if [ "$edit" -eq 1 ]; then
  say "curated-thoughts OpenClaw install.sh — CT_INSTALL_EDIT=1: applying (no sudo)"
  if ! command -v "$OPENCLAW" >/dev/null 2>&1; then
    warn "openclaw not found (set OPENCLAW_BIN or install OpenClaw >= 2026.10.3)"
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    warn "node not found on PATH — OpenClaw itself requires Node >= 24.16"
    exit 1
  fi
  INSTALL_TMP="$(mktemp -d)"
  trap 'rm -rf "$INSTALL_TMP"' EXIT
  STAGE="${INSTALL_TMP}/${PLUGIN_ID}"
  stage_plugin "$STAGE"
else
  say "curated-thoughts OpenClaw install.sh — PREVIEW: nothing will be written (no sudo)"
  STAGE="<tmp>/${PLUGIN_ID} (self-contained copy with ct-wisdom-core from ${core_lib})"
fi
say ""

run() {
  # Display every command; execute only under CT_INSTALL_EDIT=1.
  say "  $*"
  if [ "$edit" -eq 1 ]; then
    "$@"
  fi
}

run "$OPENCLAW" plugins install "$STAGE" --force --accept-capabilities
run "$OPENCLAW" config set "plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess" true
run "$OPENCLAW" config set "plugins.entries.${PLUGIN_ID}.hooks.timeouts.before_prompt_build" 20000

say ""
if [ "$edit" -eq 1 ]; then
  node "${PLUGIN_DIR}/lib/scripts/ct_doctor.js" check || warn "doctor reported problems (see above)"
  say "Done. Verify the running gateway with: $OPENCLAW plugins inspect ${PLUGIN_ID} --runtime --json"
else
  say "This was a preview. To apply it:"
  say "  CT_INSTALL_EDIT=1 $0"
fi
