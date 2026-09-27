#!/usr/bin/env bash
# tests/test_install.sh — verifies install.sh's pack + `dsh plugin add`
# contract with stubbed dsh/pnpm/npm (no real DSH needed; CI never boots it).
# Run: bash tests/test_install.sh

set -euo pipefail
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export DSH_HOME="$TMP/dsh"
DSH_STUB_LOG="$TMP/dsh-stub.log"
REAL_NODE="$(command -v node)"

PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$PKG_ROOT/scripts/install.sh"
SCOPE_DIR="@equational-applications/dsh-curated-thoughts"

# --- stubs -----------------------------------------------------------------
# node: passthrough to the real node (installed_version() evaluates
# `node -p "require('<installed package.json>')"`).
mkdir -p "$TMP/bin"
cat >"$TMP/bin/node" <<EOF
#!/bin/sh
exec "$REAL_NODE" "\$@"
EOF
# npm pack: emit a fake tarball in the requested destination, named after the
# REAL package version — the installer compares the installed version against
# package.json, so the stub's tarball name must match it.
PKG_VERSION="$(node -p "require('$PKG_ROOT/package.json').version")"
cat >"$TMP/bin/npm" <<EOF
#!/bin/sh
dest=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = "--pack-destination" ]; then dest="\$a"; fi
  prev="\$a"
done
[ -n "\$dest" ] || { echo "npm stub: no --pack-destination" >&2; exit 1; }
: >"\$dest/fake-${PKG_VERSION}.tgz"
echo "fake-${PKG_VERSION}.tgz"
EOF
# pnpm: dsh forwards to it; the stub only needs to exist and succeed.
printf '#!/bin/sh\nexit 0\n' >"$TMP/bin/pnpm"
# dsh plugin --profile <p> add <tgz>: log the call and simulate the install
# the way the real command lays it out (package under the profile's
# node_modules, version taken from the tarball name).
cat >"$TMP/bin/dsh" <<EOF
#!/bin/sh
echo "dsh \$*" >>"$DSH_STUB_LOG"
# \$1=plugin \$2=--profile \$3=<name> \$4=add \$5=<tgz>
name="\$3"; tgz="\$5"
base="\$(basename "\$tgz")"          # fake-<version>.tgz
ver="\${base#fake-}" ; ver="\${ver%.tgz}"
dir="$DSH_HOME/profiles/\$name/node_modules/$SCOPE_DIR"
mkdir -p "\$dir"
printf '{"name": "@equational-applications/dsh-curated-thoughts", "version": "%s"}\n' "\$ver" >"\$dir/package.json"
EOF
chmod +x "$TMP/bin/node" "$TMP/bin/npm" "$TMP/bin/pnpm" "$TMP/bin/dsh"

run_install() { # run_install <mode: preview|apply> [args...]
  local mode="$1"; shift
  local env_args=()
  [ "$mode" = "apply" ] && env_args=(CT_INSTALL_EDIT=1)
  # macOS ships bash 3.2, where "${env_args[@]}" on an EMPTY array aborts
  # under set -u — hence the conditional-expansion idiom.
  env ${env_args[@]+"${env_args[@]}"} PATH="$TMP/bin:/usr/bin:/bin" bash "$INSTALLER" "$@"
}

# --- argument handling ------------------------------------------------------
for bad in '../../escaped' 'nested/name' '' '.' '..'; do
  if run_install preview --profile "$bad" >/dev/null 2>&1; then
    echo "FAIL: --profile '${bad}' was accepted"; exit 1
  fi
done
test ! -e "$TMP/escaped" || { echo "FAIL: --profile traversal wrote outside DSH_HOME"; exit 1; }

if run_install preview >/dev/null 2>&1; then
  echo "FAIL: missing --profile was accepted"; exit 1
fi
if run_install preview --profile headless extra >/dev/null 2>&1; then
  echo "FAIL: unknown argument was accepted"; exit 1
fi

# --- preview writes nothing -------------------------------------------------
run_install preview --profile headless >/dev/null
test ! -e "$DSH_HOME" || { echo "FAIL: preview created $DSH_HOME"; exit 1; }
# grep -q on a pipe exits early, SIGPIPEs the producer and (with pipefail)
# turns a match into failure — capture to a file instead.
run_install preview --profile headless >"$TMP/preview.out" 2>&1
grep -q 'npm pack' "$TMP/preview.out" \
  || { echo "FAIL: preview does not describe the pack + plugin add plan"; exit 1; }

# --- apply packs and installs via dsh plugin add ----------------------------
run_install apply --profile headless >/dev/null
grep -q "plugin --profile headless add .*fake-${PKG_VERSION}.tgz" "$DSH_STUB_LOG" \
  || { echo "FAIL: dsh plugin add was not called with the packed tarball"; exit 1; }
test -f "$DSH_HOME/profiles/headless/node_modules/$SCOPE_DIR/package.json" \
  || { echo "FAIL: simulated install did not land in the profile"; exit 1; }
# The installer must never hand-edit YAML: no patch file may appear that the
# installer itself wrote (the bundle patch ships inside the package instead).
test ! -e "$DSH_HOME/cordis.yml" \
  || { echo "FAIL: installer wrote a global cordis.yml (DSH never reads it)"; exit 1; }
! grep -q 'cordis.patch.yml' "$DSH_STUB_LOG" \
  || { echo "FAIL: installer asked dsh to apply a patch file"; exit 1; }

# --- re-apply is a no-op when the same version is installed -----------------
CALLS_BEFORE=$(wc -l < "$DSH_STUB_LOG")
run_install apply --profile headless >"$TMP/reapply.out"
CALLS_AFTER=$(wc -l < "$DSH_STUB_LOG")
[ "$CALLS_BEFORE" = "$CALLS_AFTER" ] \
  || { echo "FAIL: re-apply called dsh again for the same version"; exit 1; }
grep -q 'already installed' "$TMP/reapply.out" \
  || { echo "FAIL: re-apply does not report the already-installed state"; exit 1; }

# --- a different installed version re-adds (upgrade path) -------------------
printf '{"name": "@equational-applications/dsh-curated-thoughts", "version": "0.0.9"}\n' \
  >"$DSH_HOME/profiles/headless/node_modules/$SCOPE_DIR/package.json"
CALLS_BEFORE=$(wc -l < "$DSH_STUB_LOG")
run_install apply --profile headless >/dev/null
CALLS_AFTER=$(wc -l < "$DSH_STUB_LOG")
[ "$CALLS_AFTER" -gt "$CALLS_BEFORE" ] \
  || { echo "FAIL: version change did not trigger a re-add"; exit 1; }

# --- a version-less package.json is treated as not installed ----------------
# node -p prints the string "undefined" for a missing field; the installer must
# not report that as an installed version.
printf '{"name": "@equational-applications/dsh-curated-thoughts"}\n' \
  >"$DSH_HOME/profiles/headless/node_modules/$SCOPE_DIR/package.json"
run_install apply --profile headless >"$TMP/noversion.out"
if grep -q 'undefined' "$TMP/noversion.out"; then
  echo "FAIL: installer reported a missing version as 'undefined'"; exit 1
fi
grep -q 'already installed' "$TMP/reapply.out" \
  && ! grep -q 'already installed' "$TMP/noversion.out" \
  || { echo "FAIL: version-less install was treated as already installed"; exit 1; }

echo "OK"
