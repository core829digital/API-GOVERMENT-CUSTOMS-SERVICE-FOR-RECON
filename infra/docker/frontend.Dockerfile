# syntax=docker/dockerfile:1.7
#
# Next.js frontend (BFF + UI). Build context = repository root.
#
#   docker build -f infra/docker/frontend.Dockerfile -t recon-frontend .
#
# REQUIRES `output: "standalone"` in frontend/next.config.ts (set by the owner of frontend/; the build stage asserts it).
# NOT YET BUILT OR RUN by the author of this file: the authoring environment has no Docker (Progress.md §7).
#
# Pins (resolved from the registries on 2026-10-23; tag + manifest-list digest):
#   node:26.12.1-trixie-slim                 build stage; matches the Node 26 the frontend is developed with
#   gcr.io/distroless/nodejs26-debian13      runtime; Debian 13 glibc, Node.js 26, no shell, user `nonroot` = 65532
# Node 26 becomes an LTS line on 2026-10-28 (nodejs/Release schedule.json, read 2026-10-23); until then it is "Current".
# Runtime configuration is environment only (frontend/.env.example); nothing is baked in at build time.

ARG NODE_IMAGE=node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs26-debian13:nonroot@sha256:3a6f4e6fd37efe00042667d06fd52240f2589ed09b0694fbb3b1bf860030a839

# ---------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
# `npm ci` installs exactly the lockfile (fails on drift). The npm cache is a BuildKit cache mount.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY frontend ./
# frontend/ has no public/ directory today; create it so the runtime COPY below is valid either way.
RUN mkdir -p public && npm run build
RUN test -f .next/standalone/server.js \
    || { echo 'build did not produce .next/standalone/server.js: set output: "standalone" in frontend/next.config.ts' >&2; exit 1; }
# Writable cache directory for the read-only-root-filesystem runtime (mounted as emptyDir by the chart).
RUN mkdir -p .next/standalone/.next/cache

# ---------------------------------------------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=65532:65532 /app/.next/standalone ./
COPY --from=build --chown=65532:65532 /app/.next/static ./.next/static
COPY --from=build --chown=65532:65532 /app/public ./public
EXPOSE 3000
USER 65532:65532
# The distroless nodejs image's entrypoint is `node`.
CMD ["server.js"]
