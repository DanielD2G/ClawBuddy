# ── Stage 1: Base ─────────────────────────────────────
# Install all dependencies (shared by api and web builds)
FROM oven/bun:1.3.5-debian AS base
WORKDIR /app

# Copy dependency manifests
COPY package.json bun.lock ./
COPY patches/ patches/
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/tsconfig/ packages/tsconfig/
COPY packages/eslint-config/package.json packages/eslint-config/package.json

RUN bun install; exit 0
# Ensure playwright-core is installed (bun install errors are silenced above for optional native deps)
RUN test -d node_modules/playwright-core || (bun add playwright-core@1.58.2 --no-save; exit 0)
RUN test -d node_modules/playwright-core || (echo "FATAL: playwright-core not installed" && exit 1)

# ── Stage 2: API build ───────────────────────────────
FROM base AS api-build
WORKDIR /app

ARG CLAWBUDDY_VERSION=dev
ARG CLAWBUDDY_COMMIT_SHA=local

COPY packages/ packages/
COPY apps/api/ apps/api/

# Generate Prisma client then build
RUN cd apps/api && bunx prisma generate
RUN bun run --filter @clawbuddy/api build

# ── Stage 3: Web build ───────────────────────────────
FROM base AS web-build
WORKDIR /app

ARG CLAWBUDDY_VERSION=dev
ARG CLAWBUDDY_COMMIT_SHA=local

COPY packages/ packages/
COPY apps/web/ apps/web/

RUN export VITE_CLAWBUDDY_VERSION="$CLAWBUDDY_VERSION" \
  VITE_CLAWBUDDY_COMMIT_SHA="$CLAWBUDDY_COMMIT_SHA" \
  VITE_CLAWBUDDY_BUILD_TIME="$(date -u +%FT%TZ)" && \
  bun run --filter @clawbuddy/web build

# ── Stage 4: API runtime ─────────────────────────────
FROM oven/bun:1.3.5-debian
WORKDIR /app

ARG CLAWBUDDY_VERSION=dev
ARG CLAWBUDDY_COMMIT_SHA=local
ARG CLAWBUDDY_BUILD_TIME=unknown
ENV CLAWBUDDY_VERSION=$CLAWBUDDY_VERSION
ENV CLAWBUDDY_COMMIT_SHA=$CLAWBUDDY_COMMIT_SHA
ENV CLAWBUDDY_BUILD_TIME=$CLAWBUDDY_BUILD_TIME

# Copy node_modules from api-build (includes generated Prisma client)
COPY --from=api-build /app/node_modules node_modules
# Copy built API
COPY --from=api-build /app/apps/api/dist apps/api/dist
# Copy built frontend
COPY --from=web-build /app/apps/web/dist /app/web
# Copy prisma schema (needed for db push at bootstrap)
COPY --from=api-build /app/apps/api/prisma apps/api/prisma
# Copy skills directory (synced to DB on startup)
COPY --from=api-build /app/apps/api/skills apps/api/skills
# Copy root package.json (bun needs it for workspace resolution)
COPY --from=api-build /app/package.json package.json

EXPOSE 4000
CMD ["sh", "-c", "PRISMA_BIN=$(find node_modules -path '*/prisma/build/index.js' | head -1) && bun $PRISMA_BIN db push --schema=apps/api/prisma/schema.prisma --skip-generate && bun apps/api/dist/index.js"]
