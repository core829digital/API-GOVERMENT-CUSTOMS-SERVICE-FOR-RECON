# syntax=docker/dockerfile:1.7
#
# Rust services: recon-api (+ recon-admin), recon-migrate, recon-verify. Build context = repository root.
#
#   docker build -f infra/docker/rust.Dockerfile --target api     -t recon-api     .
#   docker build -f infra/docker/rust.Dockerfile --target migrate -t recon-migrate .
#   docker build -f infra/docker/rust.Dockerfile --target tools   -t recon-tools   .
#
# NOT YET BUILT OR RUN by the author of this file: the authoring environment has no Docker (Progress.md §7).
# What is verified is stated in the comments next to each pin.
#
# Pins (resolved from the registries on 2026-10-23; tag + manifest-list digest):
#   rust:1.99.1-trixie            Debian 13 (glibc 2.41), has gcc for `ring`
#   gcr.io/distroless/cc-debian13 Debian 13 glibc + libgcc + libstdc++, no shell, no package manager
# glibc linkage: build and runtime are both Debian 13 (trixie), so the dynamically linked glibc binaries run unchanged.
# The workspace links no OpenSSL (sqlx uses rustls; Cargo.lock has ring + rustls, no openssl-sys) and needs no libpq.

ARG RUST_IMAGE=rust:1.99.1-trixie@sha256:931c2c0531a8b143e044f0f3914dfe802f15bb3d1955f0b657e9359327ac2ffc
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian13:nonroot@sha256:83b9b50586253821cf63ffcec87d3d94265a093ad30da232039af962dd8f4edf

# ---------------------------------------------------------------------------------------------------------------
# build: one cargo invocation produces every binary; registry and target dir are BuildKit cache mounts so that a
# source-only change does not re-download or re-compile dependencies.
# ---------------------------------------------------------------------------------------------------------------
FROM ${RUST_IMAGE} AS build
WORKDIR /src
ENV CARGO_HOME=/usr/local/cargo \
    CARGO_TERM_COLOR=never \
    CARGO_INCREMENTAL=0

# Manifests first, then sources: `crates/*/` is the whole workspace (Cargo.toml: members = ["crates/*"]).
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates

# --locked: the lockfile is authoritative (L1/L2 audit it); a drifting lockfile fails the image build.
# recon-api owns two binaries (recon-api, recon-admin). `--bin` selects explicitly so that a future crate
# (e.g. recon-worker) cannot silently change image content.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release --locked \
      --bin recon-api --bin recon-admin --bin recon-migrate --bin recon-verify \
    && mkdir -p /out \
    && cp target/release/recon-api target/release/recon-admin target/release/recon-migrate target/release/recon-verify /out/

# ---------------------------------------------------------------------------------------------------------------
# api: the HTTP service. 65532 is the `nonroot` user of the distroless image; there is no shell.
# RECON_BIND defaults to 127.0.0.1:8080 in the binary, so the image sets the container-wide bind explicitly.
# ---------------------------------------------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS api
COPY --from=build --chown=65532:65532 /out/recon-api /usr/local/bin/recon-api
ENV RECON_BIND=0.0.0.0:8080
EXPOSE 8080
USER 65532:65532
# recon-api drains on SIGINT only (tokio::signal::ctrl_c in crates/recon-api/src/bin/recon-api.rs), not SIGTERM.
# STOPSIGNAL asks the runtime to send SIGINT. [UNVERIFIED] that the target container runtime honours the image's
# STOPSIGNAL under Kubernetes; the durable fix is a SIGTERM handler in the binary (reported to the owner of crates/).
STOPSIGNAL SIGINT
ENTRYPOINT ["/usr/local/bin/recon-api"]

# ---------------------------------------------------------------------------------------------------------------
# migrate: DDL tool + the SQL it applies. `recon-migrate up --dir` defaults to "migrations" relative to the working
# directory, so the image's working directory is / and the migrations live in /migrations/{w,r}.
# The same image runs `up --target r`, `up --target w` and `subscribe` (distinct containers, see the chart and compose).
# ---------------------------------------------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS migrate
COPY --from=build --chown=65532:65532 /out/recon-migrate /usr/local/bin/recon-migrate
COPY --chown=65532:65532 migrations /migrations
WORKDIR /
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/recon-migrate"]

# ---------------------------------------------------------------------------------------------------------------
# tools: operator CLIs that must never ship inside the api image (recon-admin holds tenant-provisioning code paths;
# recon-verify is the offline chain verifier). The default command prints recon-verify usage; run the other tool
# with an explicit path, e.g. `/usr/local/bin/recon-admin create-tenant ...` (no shell, no PATH search).
# ---------------------------------------------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS tools
COPY --from=build --chown=65532:65532 /out/recon-admin /usr/local/bin/recon-admin
COPY --from=build --chown=65532:65532 /out/recon-verify /usr/local/bin/recon-verify
USER 65532:65532
CMD ["/usr/local/bin/recon-verify"]
