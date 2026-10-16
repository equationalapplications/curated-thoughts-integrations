# End-to-end image: the real DSH CLI on top of the shared Curated Thoughts
# base (tests/e2e/base.Dockerfile — sidecar .deb, Node 24, non-root tester),
# plus this integration's packed release tarball, installed the way a user
# would. Built and driven by tests/e2e/run.sh; the build context is a staging
# dir holding the tarball and e2e.sh. run.sh builds the base image first and
# passes its tag in BASE_IMAGE.
ARG BASE_IMAGE=ct-e2e-base
FROM ${BASE_IMAGE}

ARG DSH_VERSION=0.2.0-rc.2
ARG PNPM_VERSION=10

# pnpm must be on PATH: `dsh plugin --profile <p> add` forwards to pnpm in the
# profile directory. The npm-global install is root-owned; the profile under
# the tester's HOME stays user-owned.
USER root
RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" "pnpm@${PNPM_VERSION}" \
    && dsh --version \
    && pnpm --version
USER root
# ct CLI (test-only provisioning; NOT part of the user-visible install): the
# pinned sidecar .deb (2.12.1) does not ship `ct` — it ships standalone from
# v2.22.0+. Wisdom recall in the e2e needs the real binary on PATH, and live
# delivery (0.4.0) needs `ct wisdom match`, which ships in CT >= 3.3.0 — the
# 2.22.0 pin this image used before answered `wisdom match --help` with rc=1,
# so the plugin's capability probe latched delivery OFF and the live pre-step
# path was never exercised. The digest is GitHub's recorded asset digest.
# `ct` has no --version flag; CT_CLI_VERSION is exported so e2e.sh can report
# and gate on the version it actually exercised.
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
