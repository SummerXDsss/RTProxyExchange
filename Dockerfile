# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: build the React frontend -> /frontend/dist
# ---------------------------------------------------------------------------
FROM node:20-alpine AS frontend
WORKDIR /frontend
# Install deps first for better layer caching.
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: build the Rust backend (release)
# ---------------------------------------------------------------------------
FROM rust:1-bookworm AS backend
WORKDIR /app
# Copy the workspace manifests and sources.
COPY Cargo.toml Cargo.lock* ./
COPY crates/ ./crates/
# Build only the backend binary in release mode.
RUN cargo build --release -p codex-backend

# ---------------------------------------------------------------------------
# Stage 3: Docker CLI for self-update helper startup
# ---------------------------------------------------------------------------
FROM docker:27-cli AS docker-cli

# ---------------------------------------------------------------------------
# Stage 4: minimal runtime image
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
# reqwest needs TLS roots and libssl at runtime; curl for the healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 curl \
    && rm -rf /var/lib/apt/lists/*

# Run as a non-root user.
RUN useradd --system --uid 10001 --create-home appuser
WORKDIR /app

# Backend binary and built frontend assets.
COPY --from=backend /app/target/release/codex-backend /usr/local/bin/codex-backend
COPY --from=frontend /frontend/dist /app/frontend/dist
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

ENV PORT=8787 \
    STATIC_DIR=/app/frontend/dist \
    RUST_LOG=codex_backend=info,tower_http=info

EXPOSE 8787

# Lightweight healthcheck against the /api/health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT}/api/health" || exit 1

ENTRYPOINT ["codex-backend"]
