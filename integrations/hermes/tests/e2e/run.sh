#!/usr/bin/env bash
# run.sh — build and run the Hermes end-to-end container (local only; not
# wired into CI). Covers autonomous-work delivery against CT's REAL relevance
# gate, with verbose mode on.
#
#   ZAI_API_KEY=... OPENROUTER_API_KEY=... integrations/hermes/tests/e2e/run.sh
#
# Isolation: the container's HOME holds a scratch HERMES_HOME and a scratch
# brain; nothing on the host (no ~/.hermes, no live brain) is read or written.
# The plugin under test is bind-mounted read-only. Keys are passed by NAME
# (`-e ZAI_API_KEY`), so they never appear on a command line, in the image or
# in out/ (the script greps out/ for both values at the end).
# Artifacts land in tests/e2e/out/ (gitignored).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$PKG/../.." && pwd)"
CT_VERSION="${CT_VERSION:-2.12.1}"
BASE_IMAGE="ct-e2e-base:ct${CT_VERSION}"
IMAGE="ct-hermes-e2e:ee8dd6c8"

for name in ZAI_API_KEY OPENROUTER_API_KEY; do
  if [ -z "${!name:-}" ]; then
    echo "SKIP  $name is not set: the Hermes e2e needs ZAI (model) and OpenRouter (CT embeddings)"
    exit 0
  fi
done

docker build -q --build-arg "CT_VERSION=$CT_VERSION" -t "$BASE_IMAGE" \
  -f "$REPO/tests/e2e/base.Dockerfile" "$REPO/tests/e2e" >/dev/null
docker build -q --build-arg "BASE_IMAGE=$BASE_IMAGE" -t "$IMAGE" "$HERE" >/dev/null

rm -rf "$HERE/out"
mkdir -p "$HERE/out"
chmod 777 "$HERE/out"  # the container user is uid 1000
rc=0
docker run --rm -e ZAI_API_KEY -e OPENROUTER_API_KEY \
  -v "$PKG:/home/tester/plugin:ro" -v "$HERE/out:/home/tester/out" \
  "$IMAGE" | tee "$HERE/out/run.log" || rc=$?

leak=0
for name in ZAI_API_KEY OPENROUTER_API_KEY; do
  if grep -rqF -- "${!name}" "$HERE/out"; then
    echo "FAIL  $name value found in tests/e2e/out/"; leak=1
  fi
done
[ "$leak" -eq 0 ] && echo "ok    no key value in tests/e2e/out/"
[ "$rc" -eq 0 ] && [ "$leak" -eq 0 ]
