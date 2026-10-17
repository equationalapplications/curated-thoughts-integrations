# End-to-end image: the real OpenCode binary on top of the shared Curated
# Thoughts base (tests/e2e/base.Dockerfile — sidecar .deb, Node 24, non-root
# tester), plus this integration's packed tarball, installed the way a user
# would. Built and driven by tests/e2e/run.sh; the build context is a staging
# dir holding the tarball and e2e.sh. run.sh builds the base image first and
# passes its tag in BASE_IMAGE.
ARG BASE_IMAGE=ct-e2e-base
FROM ${BASE_IMAGE}

ARG OPENCODE_VERSION=1.18.35

# The shared base ends as the non-root tester; the global npm install needs
# root (same pattern as the deepseek harness Dockerfile).
USER root
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" "pnpm@10" && opencode --version && pnpm --version
# ct CLI (test-only provisioning; NOT part of the user-visible install) for
# the opt-in real-gate autonomous-work section (CT_E2E_REAL_GATE=1): the
# pinned sidecar .deb does not ship `ct`, and `ct wisdom match` / `ct wisdom
# deposit` need CT >= 3.3.0. Same pin and recorded digest as the deepseek
# e2e image. The default run still uses the test-only stub, placed first on
# PATH by e2e.sh.
ARG CT_CLI_VERSION=3.5.1
ARG CT_CLI_SHA256=912d1be65de3aa8b714e82a2b5f5809bd8daf17bb308514a69c970fab706dce0
ENV CT_CLI_VERSION=${CT_CLI_VERSION}
RUN set -eux; \
    curl -fsSL -o /tmp/ct.tar.gz \
      "https://github.com/equationalapplications/curated-thoughts/releases/download/v${CT_CLI_VERSION}/ct_${CT_CLI_VERSION}_linux_amd64.tar.gz"; \
    echo "${CT_CLI_SHA256}  /tmp/ct.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/ct.tar.gz -C /usr/local/bin ct; \
    rm /tmp/ct.tar.gz; \
    ct --help | grep -q 'Curated Thoughts'
USER tester

COPY --chown=tester:tester dist/ /home/tester/dist/

ENTRYPOINT ["bash", "/home/tester/dist/e2e.sh"]
