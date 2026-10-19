# NotebookLM Orchestrator — single-container local app (server + built web UI).
# Local single-user model: no user system, no admin token. The container binds
# to 127.0.0.1:4870 inside; docker-compose publishes it on the host loopback
# only. Data lives in a ./data volume (SQLite, job archives, vault, cookies).

FROM node:22-bookworm-slim AS builder
WORKDIR /app
# Copy the whole context (minus .dockerignore). Offline-friendly: when the
# npm registry is unreachable, the host's node_modules/ and apps/web/dist are
# shipped in the context and reused as-is; on other machines they are built.
COPY . .
RUN [ -d node_modules ] || npm ci
RUN [ -d apps/web/dist ] || npm run build --workspace @nlo/web

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# Bind to 0.0.0.0 INSIDE the container so Docker's port-forward (host →
# container-IP) reaches it. This is safe: compose publishes only to the host's
# 127.0.0.1, so nothing external can reach the container.
ENV NODE_ENV=production \
    NLO_DATA_DIR=/data \
    NLO_HOST=0.0.0.0 \
    NLO_PORT=4870

# System CA bundle: Node's own fetch has built-in roots, but the xray
# runtime (Go) trusts the SYSTEM store — without ca-certificates every VLESS
# TLS handshake inside the container fails with "unknown authority".
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Python worker (live mode): a self-contained venv at /opt/nbl-venv so the
# container never depends on a host interpreter (NLO_PYTHON_BIN).
#
# No Chromium here on purpose: the ONLY op that launches a browser is the
# interactive Google login, and it CANNOT work inside a container — it reads
# the user's REAL browser profile, which lives on the host. In Docker, attach
# accounts via storage-state upload instead (see docs/quick-start.md §3).
# So we skip `playwright install-deps`/`install` (they'd pull browser system
# libs for a browser that will never run here).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/nbl-venv \
    && /opt/nbl-venv/bin/pip install -U pip "notebooklm-py[browser]>=0.8.5,<0.9" \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# The node image ships a non-root "node" user (uid 1000) — run as it. On
# Linux a bind-mounted ./data keeps host ownership; if your host uid differs
# from 1000, chown -R <uid>:<gid> the ./data dir once.
RUN mkdir -p /data && chown node:node /data
USER node

COPY --from=builder --chown=node:node /app ./
VOLUME ["/data"]

EXPOSE 4870

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4870/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "apps/server/src/main.ts"]
