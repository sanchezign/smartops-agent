# syntax=docker/dockerfile:1
# SmartOps panel image (phase 11 M4): Next.js standalone server (deploy option D — Caddy routes
# /api to the API on the same origin, so the image needs no API URL).
# Build from the repository root:  docker build -f apps/admin/Dockerfile -t smartops-admin .
# NEXT_PUBLIC_API_BASE is inlined into the browser bundle at BUILD time (default /api/v1).

ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

FROM ${NODE_IMAGE} AS build
ARG NEXT_PUBLIC_API_BASE=/api/v1
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true NEXT_TELEMETRY_DISABLED=1 \
  NEXT_OUTPUT=standalone NEXT_PUBLIC_API_BASE=${NEXT_PUBLIC_API_BASE}
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
RUN pnpm fetch
COPY apps/admin apps/admin
RUN pnpm install --offline --frozen-lockfile --filter @smartops/admin \
  && pnpm --filter @smartops/admin build \
  && cp -r apps/admin/.next/static apps/admin/.next/standalone/apps/admin/.next/static \
  && cp -r apps/admin/public apps/admin/.next/standalone/apps/admin/public

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/admin/.next/standalone ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/admin/server.js"]
