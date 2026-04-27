# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && pnpm config set store-dir /pnpm/store

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/portal/package.json ./apps/portal/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN --mount=type=cache,id=connect-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @connect/portal...

FROM deps AS builder
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_TELEPHONY_WS_URL="wss://app.connectcomunications.com/ws/telephony"
ARG NEXT_PUBLIC_FORCE_ICE_RELAY=""
COPY apps/portal ./apps/portal
COPY packages/shared ./packages/shared
RUN NEXT_OUTPUT_STANDALONE=1 \
  NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL}" \
  NEXT_PUBLIC_TELEPHONY_WS_URL="${NEXT_PUBLIC_TELEPHONY_WS_URL}" \
  NEXT_PUBLIC_FORCE_ICE_RELAY="${NEXT_PUBLIC_FORCE_ICE_RELAY}" \
  pnpm --filter @connect/portal build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/apps/portal/.next/standalone ./
COPY --from=builder /app/apps/portal/.next/static ./apps/portal/.next/static
COPY --from=builder /app/apps/portal/public ./apps/portal/public
CMD ["node", "apps/portal/server.js"]
