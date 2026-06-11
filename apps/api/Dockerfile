# syntax=docker/dockerfile:1.7
FROM node:20-bookworm-slim
WORKDIR /app
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN apt-get update -y && apt-get install -y openssl ffmpeg curl && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.30.2 --activate \
  && pnpm config set store-dir /pnpm/store
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/db/prisma/schema.prisma ./packages/db/prisma/schema.prisma
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/integrations/package.json ./packages/integrations/package.json
COPY packages/security/package.json ./packages/security/package.json
# Ensure workspace deps (e.g. mysql2 for Ombutel DID sync) are installed in the image.
RUN --mount=type=cache,id=connect-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @connect/api...
# Regenerate Prisma client so it always matches the schema in this image.
# This is needed when new models are added (e.g. ConnectCdr).
RUN pnpm --filter @connect/db exec prisma generate --schema prisma/schema.prisma
COPY . .
RUN pnpm --filter @connect/integrations build
# Bake the deployed commit into the image so deploy-api.sh can read it back from
# the running container as a reliable OLD_HEAD for change-detection (mirrors the
# portal image). Kept as the last layer so per-commit changes never bust the
# expensive install/build layers above.
ARG BUILD_COMMIT=""
LABEL org.opencontainers.image.revision=$BUILD_COMMIT
RUN printf '%s\n' "$BUILD_COMMIT" > /app/.build-commit
CMD ["sh", "-c", "pnpm --filter @connect/api start"]
