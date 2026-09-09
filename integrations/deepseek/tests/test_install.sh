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
  PATH="$INSTALLER_PATH" bash "$(dirname "$0")/../scripts/install.sh" "$@" >/dev/null
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

# An entry with a quoted name scalar (the doctor-recommended form) is still
# detected — no duplicate append.
rm -f "$DSH_HOME/cordis.yml"
printf -- "- name: '@equational-applications/dsh-curated-thoughts'\n  config:\n    brainDir: ~/.brain\n" \
  > "$DSH_HOME/cordis.yml"
SIZE_BEFORE=$(wc -c < "$DSH_HOME/cordis.yml")
run_install
SIZE_AFTER=$(wc -c < "$DSH_HOME/cordis.yml")
[ "$SIZE_BEFORE" = "$SIZE_AFTER" ] || { echo "FAIL: quoted-name entry was not detected (duplicate appended)"; exit 1; }

# An entry carrying a trailing inline comment is still detected — the comment
# is not part of the name scalar, so this must not append a duplicate.
rm -f "$DSH_HOME/cordis.yml"
printf -- "- name: '@equational-applications/dsh-curated-thoughts' # managed\n  config:\n    brainDir: ~/.brain\n" \
  > "$DSH_HOME/cordis.yml"
SIZE_BEFORE=$(wc -c < "$DSH_HOME/cordis.yml")
run_install
SIZE_AFTER=$(wc -c < "$DSH_HOME/cordis.yml")
[ "$SIZE_BEFORE" = "$SIZE_AFTER" ] \
  || { echo "FAIL: entry with an inline comment was not detected (duplicate appended)"; exit 1; }

# The mirror image: a `#` *inside* the quoted scalar belongs to the name, so
# this is a different plugin and the entry must still be appended. Guards the
# comment stripping above against eating part of the name.
rm -f "$DSH_HOME/cordis.yml"
printf -- "- name: '@equational-applications/dsh-curated-thoughts # not-a-comment'\n" \
  > "$DSH_HOME/cordis.yml"
SIZE_BEFORE=$(wc -c < "$DSH_HOME/cordis.yml")
run_install
SIZE_AFTER=$(wc -c < "$DSH_HOME/cordis.yml")
[ "$SIZE_BEFORE" != "$SIZE_AFTER" ] \
  || { echo "FAIL: '#' inside the name scalar was treated as a comment"; exit 1; }

# --profile targets the per-profile patch, not the global config.
rm -f "$DSH_HOME/cordis.yml"
run_install --profile headless
test -f "$DSH_HOME/profiles/headless/cordis.patch.yml" \
  || { echo "FAIL: profile patch not created"; exit 1; }
test ! -e "$DSH_HOME/cordis.yml" || { echo "FAIL: --profile touched the global config"; exit 1; }
SIZE_BEFORE=$(wc -c < "$DSH_HOME/profiles/headless/cordis.patch.yml")
run_install --profile headless
SIZE_AFTER=$(wc -c < "$DSH_HOME/profiles/headless/cordis.patch.yml")
[ "$SIZE_BEFORE" = "$SIZE_AFTER" ] || { echo "FAIL: profile patch changed on re-run"; exit 1; }

# A --profile name is a single path segment: a traversal must be refused
# outright rather than aiming the CT_INSTALL_EDIT=1 write outside DSH_HOME.
# ${DSH_HOME}/profiles/../../escaped resolves to ${TMP}/escaped.
for bad in '../../escaped' 'nested/name' '' '.' '..'; do
  if run_install --profile "$bad" 2>/dev/null; then
    echo "FAIL: --profile '${bad}' was accepted"; exit 1
  fi
done
test ! -e "$TMP/escaped" || { echo "FAIL: --profile traversal wrote outside DSH_HOME"; exit 1; }

echo "OK"
