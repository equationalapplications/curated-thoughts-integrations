# Hermes end-to-end image (local only; not wired into CI): the shared Curated
# Thoughts base (tests/e2e/base.Dockerfile: sidecar .deb, Node 24, jq, the
# non-root tester user), the ct CLI, pnpm for the workspace's test command,
# and Hermes Agent at the pinned commit, installed from its own uv.lock with
# its pinned uv (pm/lock.json) and Python 3.14. Built and driven by run.sh;
# the plugin under test is bind-mounted read-only at /home/tester/plugin.
ARG BASE_IMAGE=ct-e2e-base
FROM ${BASE_IMAGE}

USER root
# ct CLI: `ct wisdom match` ships in CT >= 3.3.0; 3.5.1 has the real gate.
ARG CT_CLI_VERSION=3.5.1
ARG CT_CLI_SHA256=912d1be65de3aa8b714e82a2b5f5809bd8daf17bb308514a69c970fab706dce0
ENV CT_CLI_VERSION=${CT_CLI_VERSION}
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git procps; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL -o /tmp/ct.tar.gz \
      "https://github.com/equationalapplications/curated-thoughts/releases/download/v${CT_CLI_VERSION}/ct_${CT_CLI_VERSION}_linux_amd64.tar.gz"; \
    echo "${CT_CLI_SHA256}  /tmp/ct.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/ct.tar.gz -C /usr/local/bin ct; \
    rm /tmp/ct.tar.gz; \
    ct --help | grep -q 'Curated Thoughts'; \
    npm install -g pnpm@10; \
    pnpm --version

# uv, pinned as in hermes-agent pm/lock.json at the host pin.
ARG UV_VERSION=0.12.3
ARG UV_SHA256=600cf9a742aca00d292673b16b5acffaa7b8c269a364ad0c2e79498dcb1fe101
RUN set -eux; \
    curl -fsSL -o /tmp/uv.tgz \
      "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz"; \
    echo "${UV_SHA256}  /tmp/uv.tgz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tgz -C /tmp; \
    install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uv /usr/local/bin/uv; \
    rm -rf /tmp/uv.tgz /tmp/uv-x86_64-unknown-linux-gnu; \
    mkdir -p /opt/hermes; chown tester:tester /opt/hermes

USER tester
# Hermes Agent at the pin the specs cite (NousResearch/hermes-agent@ee8dd6c8).
ARG HERMES_COMMIT=ee8dd6c886326db4b468c2ba18d9409f123da827
ARG HERMES_SHA256=d21aa0fb5aad9493d5e1f888ec4b8859a749615526142680d459cc7bacd7450a
ENV UV_PYTHON_INSTALL_DIR=/opt/hermes/.python UV_NO_CONFIG=1
RUN set -eux; \
    curl -fsSL -o /tmp/hermes.tgz \
      "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/${HERMES_COMMIT}"; \
    echo "${HERMES_SHA256}  /tmp/hermes.tgz" | sha256sum -c -; \
    tar -xzf /tmp/hermes.tgz -C /opt/hermes --strip-components=1; \
    rm /tmp/hermes.tgz; \
    cd /opt/hermes; \
    uv python install 3.14; \
    uv sync --frozen --no-dev --python 3.14 --extra mcp; \
    /opt/hermes/.venv/bin/hermes --version
ENV PATH=/opt/hermes/.venv/bin:$PATH
WORKDIR /home/tester

COPY --chown=tester:tester e2e.sh /home/tester/e2e.sh
ENTRYPOINT ["bash", "/home/tester/e2e.sh"]
