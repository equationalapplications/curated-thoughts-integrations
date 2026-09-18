# End-to-end image: the real OpenCode binary, the real Curated Thoughts
# sidecar (from the published .deb), and this integration's packed tarball,
# installed the way a user would. Built and driven by tests/e2e/run.sh; the
# build context is a staging dir holding the tarball and e2e.sh.
FROM node:24-bookworm-slim

ARG CT_VERSION=2.12.1
ARG OPENCODE_VERSION=1.18.31

# The sidecar links WebKit/GTK (it is the Tauri app binary built with the
# mcp-server feature), so install the whole .deb and let apt pull its
# dependencies. It runs headless; no display is needed for --mcp.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl jq; \
    curl -fsSL -o /tmp/ct.deb \
      "https://github.com/equationalapplications/curated-thoughts/releases/download/v${CT_VERSION}/Curated.Thoughts_${CT_VERSION}_amd64.deb"; \
    apt-get install -y --no-install-recommends /tmp/ct.deb; \
    rm -rf /var/lib/apt/lists/* /tmp/ct.deb; \
    curated-thoughts-mcp --version || true

RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" && opencode --version

# A plain user with an empty HOME, like a fresh machine.
RUN useradd -m -s /bin/bash tester
USER tester
WORKDIR /home/tester

COPY --chown=tester:tester dist/ /home/tester/dist/

ENTRYPOINT ["bash", "/home/tester/dist/e2e.sh"]
