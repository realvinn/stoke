# syntax=docker/dockerfile:1
#
# Stoke Hub in a container, for a NUC that would rather run Docker than Node.
# Build from the REPO ROOT (the hub imports src/shared/hub and src/main/hub):
#
#   docker build -f hub/Dockerfile -t stoke-hub .
#
# or `docker compose -f hub/compose.yaml up -d`. hub/README.md is the runbook.
#
# Stage 1 bundles the hub into one file with the exact ws and esbuild versions
# package-lock.json pins (read from the lock, so there is no second list to
# drift), without installing the rest of the app's dependencies (Electron,
# node-pty) the hub never touches. Stage 2 is Node 24 plus that one file.
#
# NOT BUILT on any machine yet: the Docker daemon was not running where this
# was written. Everything it runs is what verify:hub-server runs (the bundle,
# built by hub/build.mjs, started with `serve`).

FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package-lock.json /tmp/package-lock.json
RUN set -eu; \
    deps=$(node -e "const p=require('/tmp/package-lock.json').packages;process.stdout.write(['ws','esbuild'].map(n=>n+'@'+p['node_modules/'+n].version).join(' '))"); \
    echo "installing $deps"; \
    npm install --no-save --no-package-lock --no-audit --no-fund $deps
COPY src/shared ./src/shared
COPY src/main/hub ./src/main/hub
COPY hub ./hub
RUN node hub/build.mjs /build/stoke-hub.mjs

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    STOKE_HUB_DATA=/data \
    STOKE_HUB_LISTEN=0.0.0.0:8787
WORKDIR /app
COPY --from=build /build/stoke-hub.mjs /app/stoke-hub.mjs
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
USER node
VOLUME ["/data"]
# 8787: the edge listener (publish it on the host's loopback only: -p 127.0.0.1:8787:8787).
# 8788: the optional LAN listener (set STOKE_HUB_LAN=0.0.0.0:8788 to open it).
EXPOSE 8787 8788
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s CMD ["node", "/app/stoke-hub.mjs", "health"]
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/stoke-hub.mjs", "serve"]
