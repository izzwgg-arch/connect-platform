# syntax=docker/dockerfile:1.7
# Connect AI Agent service — mirrors the api image pattern (tsx runtime, no compile step).
FROM node:20-bookworm-slim
WORKDIR /app
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN apt-get update -y && apt-get install -y openssl curl && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.30.2 --activate \
  && pnpm config set store-dir /pnpm/store
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# pnpm.patchedDependencies (react-native-callkeep) lives in root package.json —
# pnpm install hashes the patch file, so the build context must include it.
COPY patches ./patches
COPY apps/agent/package.json ./apps/agent/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/db/prisma/schema.prisma ./packages/db/prisma/schema.prisma
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/integrations/package.json ./packages/integrations/package.json
COPY packages/security/package.json ./packages/security/package.json
RUN --mount=type=cache,id=connect-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @connect/agent...
# Prisma client must match the schema in this image (agent reads/writes Agent* tables).
RUN pnpm --filter @connect/db exec prisma generate --schema prisma/schema.prisma
COPY . .
ARG BUILD_COMMIT=""
ENV BUILD_COMMIT=$BUILD_COMMIT \
    AGENT_PORT=3920
EXPOSE 3920
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://127.0.0.1:3920/health || exit 1
CMD ["pnpm", "--filter", "@connect/agent", "start"]
