# syntax=docker/dockerfile:1
# SmartOps API image (phase 11 M4). ONE image, three commands:
#   API:        node dist/server.js           (default)
#   worker:     node dist/worker.js
#   migrations: node node_modules/prisma/build/index.js migrate deploy
# Build from the repository root:  docker build -f apps/api/Dockerfile -t smartops-api .
# Configuration only through environment variables at runtime (no .env inside the image).

# Node 24.22 (≥ 24.19 for crypto.argon2), pinned by digest (multi-arch: amd64 + arm64).
ARG NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
RUN pnpm fetch
COPY apps/api apps/api
RUN pnpm install --offline --frozen-lockfile --filter @smartops/api \
  && pnpm --filter @smartops/api build \
  && pnpm --filter @smartops/api deploy --prod /out \
  && rm -rf /out/src /out/scripts /out/test /out/coverage /out/*.config.* /out/tsconfig*.json \
  && cp apps/api/prisma.config.ts /out/ \
  && cp -r apps/api/dist /out/dist

# Deploy bundle (phase 12, ADR-023): compose, Caddyfile, server scripts, systemd units and the
# n8n workflows travel INSIDE the image of their version — the server extracts them with
# deploy/bin/fetch-bundle.sh and needs no other credential than the read-only GHCR token.
FROM ${NODE_IMAGE} AS bundle
COPY deploy /opt/smartops-deploy
COPY n8n/workflows /opt/smartops-deploy/n8n/workflows
# Modes set explicitly: the same bundle whatever OS builds it (Windows contexts mark all +x).
RUN find /opt/smartops-deploy -type d -exec chmod 755 {} + \
  && find /opt/smartops-deploy -type f -exec chmod 644 {} + \
  && chmod 755 /opt/smartops-deploy/bin/*.sh /opt/smartops-deploy/postgres-init/*.sh \
  && chmod 644 /opt/smartops-deploy/bin/lib.sh

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=4000
WORKDIR /app
# Nothing at runtime needs npm, npx or corepack (every command is `node ...`): drop them, and with
# them their bundled dependencies, from the attack surface and the vulnerability scans.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# CVE-2025-6020 (HIGH, linux-pam directory traversal): the base image (also its 2026-11-24 rebuild,
# sha256:873f586f…) still ships libpam 1.5.2-6+deb12u2; Debian's fix is 1.5.2-6+deb12u3. Upgrade only those
# four packages. Remove this step once the pinned node base image brings libpam >= 1.5.2-6+deb12u3.
RUN apt-get update \
  && apt-get install -y --no-install-recommends --only-upgrade \
     libpam0g libpam-modules libpam-modules-bin libpam-runtime \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /out ./
COPY --from=bundle /opt/smartops-deploy /opt/smartops-deploy
USER node
EXPOSE 4000
# No curl in the slim image: Node's fetch checks the health route (DB included).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
