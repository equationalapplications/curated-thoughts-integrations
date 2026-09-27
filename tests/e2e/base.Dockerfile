# Shared base for the per-integration end-to-end images (opencode, deepseek):
# the real Curated Thoughts sidecar from the published .deb on Node 24, plus a
# plain non-root user with an empty HOME, like a fresh machine. Each
# integrations/<name>/tests/e2e/run.sh builds this image first (tagged
# ct-e2e-base:ct<CT_VERSION>), then builds its own image FROM it — see the
# opencode Dockerfile for the consuming side.
#
# The sidecar links WebKit/GTK (it is the Tauri app binary built with the
# mcp-server feature), so install the whole .deb and let apt pull its
# dependencies. It runs headless; no display is needed for --mcp.
FROM node:24-bookworm-slim

ARG CT_VERSION=2.12.1

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl jq zstd; \
    curl -fsSL -o /tmp/ct.deb \
      "https://github.com/equationalapplications/curated-thoughts/releases/download/v${CT_VERSION}/Curated.Thoughts_${CT_VERSION}_amd64.deb"; \
    apt-get install -y --no-install-recommends /tmp/ct.deb; \
    rm -rf /var/lib/apt/lists/* /tmp/ct.deb; \
    curated-thoughts-mcp --version || true

RUN useradd -m -s /bin/bash tester
USER tester
WORKDIR /home/tester
