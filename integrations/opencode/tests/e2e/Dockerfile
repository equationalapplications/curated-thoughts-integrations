# End-to-end image: the real OpenCode binary on top of the shared Curated
# Thoughts base (tests/e2e/base.Dockerfile — sidecar .deb, Node 24, non-root
# tester), plus this integration's packed tarball, installed the way a user
# would. Built and driven by tests/e2e/run.sh; the build context is a staging
# dir holding the tarball and e2e.sh. run.sh builds the base image first and
# passes its tag in BASE_IMAGE.
ARG BASE_IMAGE=ct-e2e-base
FROM ${BASE_IMAGE}

ARG OPENCODE_VERSION=1.18.31

# The shared base ends as the non-root tester; the global npm install needs
# root (same pattern as the deepseek harness Dockerfile).
USER root
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" && opencode --version
USER tester

COPY --chown=tester:tester dist/ /home/tester/dist/

ENTRYPOINT ["bash", "/home/tester/dist/e2e.sh"]
