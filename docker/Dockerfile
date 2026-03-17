# ── Stage 1: Base ─────────────────────────────────────
# Install all dependencies (shared by api and web builds)
FROM oven/bun:1.3.5-debian AS base
WORKDIR /app

# Copy dependency manifests
COPY package.json bun.lock ./
COPY patches/ patches/
COPY libs/browsergrid/sdk/typescript/ libs/browsergrid/sdk/typescript/
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

COPY packages/ packages/
COPY apps/api/ apps/api/

# Generate Prisma client then build
RUN cd apps/api && bunx prisma generate
RUN bun run --filter @agentbuddy/api build

# ── Stage 3: Web build ───────────────────────────────
FROM base AS web-build
WORKDIR /app

COPY packages/ packages/
COPY apps/web/ apps/web/

RUN bun run --filter @agentbuddy/web build

# ── Stage 4: API runtime ─────────────────────────────
FROM oven/bun:1.3.5-debian AS api
WORKDIR /app

# Copy node_modules from api-build (includes generated Prisma client)
COPY --from=api-build /app/node_modules node_modules
# Copy built API
COPY --from=api-build /app/apps/api/dist apps/api/dist
# Copy prisma schema (needed for db push at bootstrap)
COPY --from=api-build /app/apps/api/prisma apps/api/prisma
# Copy skills directory (synced to DB on startup)
COPY --from=api-build /app/apps/api/skills apps/api/skills
# Copy root package.json (bun needs it for workspace resolution)
COPY --from=api-build /app/package.json package.json

EXPOSE 4000
CMD ["sh", "-c", "PRISMA_BIN=$(find node_modules -path '*/prisma/build/index.js' | head -1) && bun $PRISMA_BIN db push --schema=apps/api/prisma/schema.prisma --skip-generate && bun apps/api/dist/index.js"]

# ── Stage 5: Web runtime (nginx) ─────────────────────
FROM nginx:alpine AS web

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
