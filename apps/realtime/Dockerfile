# syntax=docker/dockerfile:1.7
FROM node:20-bookworm-slim
WORKDIR /app
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.30.2 --activate && pnpm config set store-dir /pnpm/store
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/realtime/package.json ./apps/realtime/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/integrations/package.json ./packages/integrations/package.json
RUN --mount=type=cache,id=connect-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @connect/realtime...
COPY . .
CMD ["sh", "-c", "pnpm --filter @connect/realtime dev"]
