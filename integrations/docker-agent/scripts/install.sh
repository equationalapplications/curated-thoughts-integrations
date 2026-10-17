#!/usr/bin/env bash
# install.sh — Curated Thoughts for Docker Agent (`docker agent run`).
#
# Part of curated-thoughts-integrations (MIT). POSIX bash, stdlib only, no
# sudo. Spec: docs/superpowers/specs/2026-10-16-docker-agent-integration-design.md (D11).
#
# Writes exactly ONE file: <config dir>/hooks.d/50-curated-thoughts.yaml, a
# Docker Agent hooks drop-in that applies to every agent of `docker agent
# run`. It never opens, edits or creates an agent file, and copies nothing:
# the drop-in points at this checkout's hooks/ct_wisdom_da.py by absolute
# path. Then it PRINTS the MCP toolset snippet for you to paste into each
# agent file (Docker Agent has no global toolsets) and runs the doctor.
#
# Usage:
#   bash scripts/install.sh              install (or rewrite) the drop-in
#   bash scripts/install.sh --uninstall  delete the drop-in (only that file)
#   bash scripts/install.sh --print-only print the drop-in and snippet, write nothing
#
# Environment (all optional):
#   DOCKER_AGENT_CONFIG_DIR / CAGENT_CONFIG_DIR   Docker Agent's own config-dir
#                         overrides, honoured in the same order; else
#                         $HOME/.config/cagent. XDG_CONFIG_HOME is ignored,
#                         because Docker Agent ignores it.
#   CT_PYTHON             the Python 3.9+ the hooks run with (default: python3
#                         on PATH, resolved to an absolute path).
#   CT_SKIP_DOCTOR=1      do not run the doctor afterwards.

set -euo pipefail

PLUGIN_NAME="curated-thoughts"
DROPIN_NAME="50-curated-thoughts.yaml"
DROPIN_MARKER="# curated-thoughts-integrations: docker-agent drop-in"
SIDECAR_NAME="curated-thoughts-mcp"

say() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

MODE="install"
case "${1:-}" in
  "") ;;
  --uninstall) MODE="uninstall" ;;
  --print-only) MODE="print" ;;
  -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
  *) die "unknown option: $1 (try --help)" ;;
esac

case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*)
    die "Windows is not supported yet: Docker Agent runs hooks under PowerShell or cmd, where the drop-in's '|| exit 0' guard is not valid syntax."
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="${ROOT}/hooks/ct_wisdom_da.py"

# The config-dir rule, identical in scripts/ct_doctor.py
# (_docker_agent_config_dir; tests/test_install.py checks they agree):
# DOCKER_AGENT_CONFIG_DIR, else CAGENT_CONFIG_DIR, each trimmed of
# surrounding whitespace and used only when non-empty, else
# $HOME/.config/cagent; then a leading "~" or "~/" becomes $HOME. Any other
# "~name" form is left as it is.
trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}
CONFIG_DIR="$(trim "${DOCKER_AGENT_CONFIG_DIR:-}")"
[ -n "$CONFIG_DIR" ] || CONFIG_DIR="$(trim "${CAGENT_CONFIG_DIR:-}")"
if [ -z "$CONFIG_DIR" ]; then
  [ -n "${HOME:-}" ] || die "HOME is not set"
  CONFIG_DIR="${HOME}/.config/cagent"
fi
case "$CONFIG_DIR" in
  \~) CONFIG_DIR="${HOME}" ;;
  \~/*) CONFIG_DIR="${HOME}/${CONFIG_DIR#\~/}" ;;
esac
DROPIN_DIR="${CONFIG_DIR}/hooks.d"
DROPIN="${DROPIN_DIR}/${DROPIN_NAME}"

if [ "$MODE" = "uninstall" ]; then
  if [ -f "$DROPIN" ]; then
    if grep -qF "$DROPIN_MARKER" "$DROPIN"; then
      rm -f "$DROPIN"
      say "removed: ${DROPIN}"
    else
      die "${DROPIN} was not written by this installer (no marker line); left untouched."
    fi
  else
    say "nothing to remove: ${DROPIN} does not exist"
  fi
  exit 0
fi

# --- Python 3.9+ (actually run it: a macOS Xcode stub fails here) ----------
PY="${CT_PYTHON:-$(command -v python3 || true)}"
[ -n "$PY" ] || die "python3 not found. Install Python 3.9 or newer, then re-run."
case "$PY" in
  /*) ;;
  *) PY="$(command -v "$PY" || true)"; [ -n "$PY" ] || die "CT_PYTHON is not on PATH" ;;
esac
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
  die "${PY} is not a working Python 3.9+ (on macOS, /usr/bin/python3 can be the Xcode Command Line Tools stub). Install Python 3.9+ or set CT_PYTHON."
fi
# Absolute, as the drop-in needs (a relative CT_PYTHON like ./venv/bin/python
# would resolve against whatever directory Docker Agent runs in). abspath,
# not realpath: a versioned symlink target (python3 -> python3.13) would
# break the hook on the next Python upgrade, while the link keeps working.
PY="$("$PY" -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$PY")"

# --- paths must be quotable in the drop-in ----------------------------------
for p in "$PY" "$HOOK"; do
  case "$p" in
    *\"*|*\'*|*\`*|*\$*|*\\*|*$'\n'*)
      die "path cannot be quoted safely in the drop-in: ${p}" ;;
  esac
done
[ -f "$HOOK" ] || die "hook script missing: ${HOOK}"

VERSION="$("$PY" -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "${ROOT}/plugin.json" 2>/dev/null || echo unknown)"
CMD="'\"${PY}\" \"${HOOK}\" || exit 0'"

dropin() {
  cat <<EOF
${DROPIN_MARKER}
# version: ${VERSION}
# Generated by ${ROOT}/scripts/install.sh. Delete this file (or run
# install.sh --uninstall) to uninstall. Every hook ignores its own errors and
# exits 0, so a missing file or a broken Python can never block a prompt.
before_llm_call:
  - name: ${PLUGIN_NAME}
    type: command
    command: ${CMD}
    timeout: 20
    on_error: ignore
user_prompt_submit:
  - name: ${PLUGIN_NAME}
    type: command
    command: ${CMD}
    timeout: 10
    on_error: ignore
user_followup_submit:
  - name: ${PLUGIN_NAME}
    type: command
    command: ${CMD}
    timeout: 10
    on_error: ignore
tool_response_transform:
  - matcher: "*"
    hooks:
      - name: ${PLUGIN_NAME}
        type: command
        command: ${CMD}
        timeout: 15
        on_error: ignore
EOF
}

# --- the MCP toolset snippet (printed, never written) -----------------------
SIDECAR="$("$PY" -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import ct_env; print(ct_env.find_sidecar()[0] or "")' "${ROOT}/scripts" 2>/dev/null || true)"
[ -n "$SIDECAR" ] || SIDECAR="<path to ${SIDECAR_NAME}>"
NEEDS_STATUS=0
NEEDS="$("$PY" -I "${ROOT}/scripts/ct_env.py" sidecar-env 2>/dev/null)" || NEEDS_STATUS=$?

yaml_quote() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}

snippet() {
  say "    toolsets:"
  say "      - type: mcp"
  say "        command: $(yaml_quote "$SIDECAR")"
  say "        args: [\"--mcp\"]"
  local kind name value wrote=0
  if [ -n "$NEEDS" ]; then
    say "        # What this brain needs, by name only. Docker Agent also passes"
    say "        # its whole environment to the sidecar; listing the names keeps"
    say "        # the requirement visible. A \${env.NAME} that is unset stops the"
    say "        # toolset, so keep only names that are set where you run it."
    say "        env:"
    while IFS=$'\t' read -r kind name value; do
      [ -n "$name" ] || continue
      wrote=1
      if [ "$kind" = "path" ]; then
        say "          ${name}: $(yaml_quote "$value")"
      else
        say "          ${name}: \${env.${name}}"
      fi
    done <<<"$NEEDS"
  fi
  if [ "$wrote" -eq 0 ] || [ "$NEEDS_STATUS" -ne 0 ]; then
    say "        # External embedder (brain embed_profile.type \"external\")? Name its"
    say "        # key here (OPENROUTER_API_KEY for OpenRouter, else OPENAI_API_KEY;"
    say "        # EMBED_API_KEY overrides both). Only reference a variable that is set."
    say "        # env:"
    say "        #   OPENROUTER_API_KEY: \${env.OPENROUTER_API_KEY}"
  fi
}

if [ "$MODE" = "print" ]; then
  say "== drop-in (${DROPIN}) =="
  dropin
  say ""
  say "== MCP toolset snippet =="
  snippet
  exit 0
fi

mkdir -p "$DROPIN_DIR"
if [ -f "$DROPIN" ] && ! grep -qF "$DROPIN_MARKER" "$DROPIN"; then
  die "${DROPIN} exists and was not written by this installer; move it away first."
fi
TMP="${DROPIN}.tmp.$$"
dropin >"$TMP"
mv -f "$TMP" "$DROPIN"
say "wrote: ${DROPIN}"
say "  Docker Agent loads it for every agent of \`docker agent run\` on this machine."
say "  Sandbox, cloud, ACP/editor and API-server runs do not use it (Intuitive"
say "  Wisdom is a silent no-op there)."
say ""
say "== MCP sidecar: paste into each agent's YAML (this installer never edits agent files) =="
say ""
snippet
say ""
say "The hooks work without the snippet; it adds Curated Thoughts' own search tools."

if [ "${CT_SKIP_DOCTOR:-}" != "1" ]; then
  say ""
  say "== doctor =="
  "$PY" -I "${ROOT}/scripts/ct_doctor.py" check || true
fi
