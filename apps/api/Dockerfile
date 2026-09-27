# syntax=docker/dockerfile:1
# SmartOps API image (phase 11 M4). ONE image, three commands:
#   API:        node dist/server.js           (default)
#   worker:     node dist/worker.js
#   migrations: node node_modules/prisma/build/index.js migrate deploy
# Build from the repository root:  docker build -f apps/api/Dockerfile -t smartops-api .
# Configuration only through environment variables at runtime (no .env inside the image).

# Node 24.21 (≥ 24.19 for crypto.argon2), pinned by digest (multi-arch: amd64 + arm64).
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

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

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000
# No curl in the slim image: Node's fetch checks the health route (DB included).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
