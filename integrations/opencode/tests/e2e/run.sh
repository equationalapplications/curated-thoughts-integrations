#!/usr/bin/env bash
# run.sh — build and run the OpenCode end-to-end container (local only; not
# wired into CI). Builds the release artifact with the same command the
# release workflow runs (`tools/ct_ci.py package`), stages it with e2e.sh,
# builds the image, and runs the checks.
#
#   tests/e2e/run.sh                 # live-model step runs if ZAI_API_KEY is set
#   CT_VERSION=2.12.1 tests/e2e/run.sh
#
# The API key is passed by NAME (`-e ZAI_API_KEY`), so it never appears on a
# command line or in the image. Container artifacts (logs, doctor JSON, the
# model's event stream) land in tests/e2e/out/ (gitignored).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$PKG/../.." && pwd)"
CT_VERSION="${CT_VERSION:-2.12.1}"
OPENCODE_VERSION="$(node -p "require('$PKG/tests/host/compatibility.json').opencode")"
IMAGE="ct-opencode-e2e:ct${CT_VERSION}-oc${OPENCODE_VERSION}"

ctx="$(mktemp -d)"
trap 'rm -rf "$ctx"' EXIT
mkdir -p "$ctx/dist"
# lib/ is gitignored and the packager ships what is on disk, so build first.
(cd "$PKG" && pnpm -s build)
VERSION="$(node -p "require('$PKG/package.json').version")"
(cd "$REPO" && python3 tools/ct_ci.py package --tag "opencode-v$VERSION" --out "$ctx/dist" >/dev/null)
cp "$HERE/e2e.sh" "$HERE/zai-provider.json" "$ctx/dist/"
cp "$HERE/Dockerfile" "$ctx/"

docker build -q \
  --build-arg "CT_VERSION=$CT_VERSION" \
  --build-arg "OPENCODE_VERSION=$OPENCODE_VERSION" \
  -t "$IMAGE" "$ctx" >/dev/null

rm -rf "$HERE/out"
mkdir -p "$HERE/out"
# The container user is uid 1000; let it write the bind-mounted out/ dir.
chmod 777 "$HERE/out"
env_args=()
[ -n "${ZAI_API_KEY:-}" ] && env_args+=(-e ZAI_API_KEY)
[ -n "${CT_E2E_MODEL:-}" ] && env_args+=(-e CT_E2E_MODEL)
docker run --rm "${env_args[@]}" -v "$HERE/out:/home/tester/out" "$IMAGE"
