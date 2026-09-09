#!/usr/bin/env bash
# tests/test_install.sh — verifies install.sh is idempotent.
# Run: bash tests/test_install.sh

set -euo pipefail
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export DSH_HOME="$TMP/dsh"
export CT_INSTALL_EDIT=1

# The installer needs stdlib tools (cat/mkdir/grep/awk), so a truly empty
# PATH would abort it under `set -e`. Give it a stdlib-only PATH instead:
# node is not on /usr/bin:/bin here, so the doctor's check stays
# deterministic (it fails; the test never asserts on doctor output).
INSTALLER_PATH="/usr/bin:/bin"
run_install() {
  PATH="$INSTALLER_PATH" bash "$(dirname "$0")/../scripts/install.sh" >/dev/null
}

# First run: creates the config and the entry.
run_install
test -f "$DSH_HOME/cordis.yml" || { echo "FAIL: cordis.yml not created"; exit 1; }
grep -q '@equational-applications/dsh-curated-thoughts' "$DSH_HOME/cordis.yml" \
  || { echo "FAIL: plugin entry not in cordis.yml"; exit 1; }

# Second run: must be a no-op for the cordis.yml append.
SIZE_BEFORE=$(wc -c < "$DSH_HOME/cordis.yml")
run_install
SIZE_AFTER=$(wc -c < "$DSH_HOME/cordis.yml")
[ "$SIZE_BEFORE" = "$SIZE_AFTER" ] || { echo "FAIL: cordis.yml changed on re-run"; exit 1; }

# Multi-document YAML refusal.
printf -- '---\n- name: a\n---\n- name: b\n' > "$DSH_HOME/cordis.yml"
SIZE_BEFORE=$(wc -c < "$DSH_HOME/cordis.yml")
run_install
SIZE_AFTER=$(wc -c < "$DSH_HOME/cordis.yml")
[ "$SIZE_BEFORE" = "$SIZE_AFTER" ] || { echo "FAIL: multi-document YAML was modified"; exit 1; }

# YAML containing a tab must be refused as well.
printf -- '- name: a\n\tconfig:\n' > "$DSH_HOME/cordis.yml"
SIZE_BEFORE=$(wc -c < "$DSH_HOME/cordis.yml")
run_install
SIZE_AFTER=$(wc -c < "$DSH_HOME/cordis.yml")
[ "$SIZE_BEFORE" = "$SIZE_AFTER" ] || { echo "FAIL: YAML with a tab was modified"; exit 1; }

echo "OK"
