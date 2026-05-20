# syntax=docker/dockerfile:1.7
FROM node:20-bookworm-slim
WORKDIR /app
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
# ffmpeg powers the MMS audio converter (apps/worker/src/mmsAudioConvert.ts)
# which transcodes voice notes into a tiny mono AAC m4a so they survive
# carrier MMS gateways. openssl stays for prisma + general TLS.
RUN apt-get update -y && apt-get install -y openssl ffmpeg && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.30.2 --activate \
  && pnpm config set store-dir /pnpm/store
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/db/prisma/schema.prisma ./packages/db/prisma/schema.prisma
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/integrations/package.json ./packages/integrations/package.json
COPY packages/security/package.json ./packages/security/package.json
# Install only worker dependency graph (includes @connect/db/shared/integrations/security)
# so runtime tools like tsx/prisma are present without pulling unrelated app deps.
RUN --mount=type=cache,id=connect-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @connect/worker...
# Generate Prisma client inside the image so the worker has a valid client
# regardless of whether it was generated on the build host.
RUN pnpm --filter @connect/db exec prisma generate --schema prisma/schema.prisma
COPY . .
CMD ["sh", "-c", "pnpm --filter @connect/worker dev"]
