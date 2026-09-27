# End-to-end image: the real DSH CLI on top of the shared Curated Thoughts
# base (tests/e2e/base.Dockerfile — sidecar .deb, Node 24, non-root tester),
# plus this integration's packed release tarball, installed the way a user
# would. Built and driven by tests/e2e/run.sh; the build context is a staging
# dir holding the tarball and e2e.sh. run.sh builds the base image first and
# passes its tag in BASE_IMAGE.
ARG BASE_IMAGE=ct-e2e-base
FROM ${BASE_IMAGE}

ARG DSH_VERSION=0.1.5-rc.2
ARG PNPM_VERSION=10

# pnpm must be on PATH: `dsh plugin --profile <p> add` forwards to pnpm in the
# profile directory. The npm-global install is root-owned; the profile under
# the tester's HOME stays user-owned.
USER root
RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" "pnpm@${PNPM_VERSION}" \
    && dsh --version \
    && pnpm --version
USER tester

COPY --chown=tester:tester dist/ /home/tester/dist/

ENTRYPOINT ["bash", "/home/tester/dist/e2e.sh"]
