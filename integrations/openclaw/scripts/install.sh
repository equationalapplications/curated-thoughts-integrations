#!/usr/bin/env bash
# install.sh — preview-first installer for the Curated Thoughts OpenClaw
# plugin.
#
# Part of curated-thoughts-integrations (MIT). POSIX bash, no sudo. OpenClaw
# owns plugin installation, so this script stages a self-contained copy of
# the plugin and drives the host's own CLI (pin: openclaw 2026.10.3):
#
#   1. stage <tmp>/curated-thoughts: lib/ (self-contained — the build's
#      scripts/vendor_core.mjs vendors ct-wisdom-core into lib/ct-wisdom-core
#      and rewrites the import, so no node_modules is needed), skills/,
#      openclaw.plugin.json and a package.json without the monorepo-relative
#      file: dependency (meaningless at the install location)
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

if [ ! -f "${PLUGIN_DIR}/lib/ct-wisdom-core/index.js" ] || \
   grep -rqE --include='*.js' "['\"]@equational-applications/ct-wisdom-core['\"]" "${PLUGIN_DIR}/lib/src" "${PLUGIN_DIR}/lib/scripts"; then
  warn "lib/ is not self-contained (ct-wisdom-core not vendored) — rebuild with: pnpm run build"
  warn "  (build the core first: cd packages/ct-wisdom-core && pnpm install && pnpm run build)"
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
  mkdir -p "$stage"
  cp -R "${PLUGIN_DIR}/lib" "${PLUGIN_DIR}/skills" "${PLUGIN_DIR}/openclaw.plugin.json" \
    "${PLUGIN_DIR}/package.json" "$stage/"
  node - "$stage/package.json" <<'NJS'
const fs = require('fs');
const p = process.argv[2];
const m = JSON.parse(fs.readFileSync(p, 'utf8'));
if (m.dependencies) delete m.dependencies['@equational-applications/ct-wisdom-core'];
if (m.dependencies && Object.keys(m.dependencies).length === 0) delete m.dependencies;
delete m.devDependencies;
delete m.scripts;
fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
NJS
  if [ ! -f "$stage/lib/src/index.js" ] || \
     [ ! -f "$stage/lib/ct-wisdom-core/index.js" ]; then
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
  STAGE="<tmp>/${PLUGIN_ID} (self-contained copy: lib/ with vendored ct-wisdom-core)"
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
say "External embedder or a custom CURATED_BRAIN_DIR? OpenClaw starts the"
say "plugin's MCP sidecar with only HOME, PATH and a few basics, so the"
say "embedding key (EMBED_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY) and a"
say "non-default brain location must be forwarded by an"
say "mcp.servers.curated-thoughts row in openclaw.json (the key as a \${NAME}"
say "reference, never its value; a brain location as an absolute path)."
say "The doctor's sidecar-env check prints the exact row for this brain:"
say "  node ${PLUGIN_DIR}/lib/scripts/ct_doctor.js check"
say ""
if [ "$edit" -eq 1 ]; then
  node "${PLUGIN_DIR}/lib/scripts/ct_doctor.js" check || warn "doctor reported problems (see above)"
  say "Done. Verify the running gateway with: $OPENCLAW plugins inspect ${PLUGIN_ID} --runtime --json"
else
  say "This was a preview. To apply it:"
  say "  CT_INSTALL_EDIT=1 $0"
fi
