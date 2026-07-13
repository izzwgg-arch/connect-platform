# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/* \
  # The node:20 base image began shipping a corepack (0.31+) that requires the
  # Node 22-only `node:sqlite` builtin, so `corepack enable` crashes on Node 20.
  # Pin a known-good corepack before enabling it.
  && npm install --global corepack@0.29.4 \
  && corepack enable \
  && corepack prepare pnpm@10.30.2 --activate \
  && pnpm config set store-dir /pnpm/store

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/portal/package.json ./apps/portal/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN --mount=type=cache,id=connect-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @connect/portal...

FROM deps AS builder
ARG BUILD_COMMIT=""
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_TELEPHONY_WS_URL="wss://app.connectcomunications.com/ws/telephony"
ARG NEXT_PUBLIC_FORCE_ICE_RELAY=""
ARG NEXT_PUBLIC_CRM_EMAIL_PHASE1_ENABLED=""
COPY apps/portal ./apps/portal
COPY packages/shared ./packages/shared
RUN --mount=type=cache,id=connect-next-cache-${BUILD_COMMIT},target=/app/apps/portal/.next/cache \
  NEXT_OUTPUT_STANDALONE=1 \
  NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL}" \
  NEXT_PUBLIC_TELEPHONY_WS_URL="${NEXT_PUBLIC_TELEPHONY_WS_URL}" \
  NEXT_PUBLIC_FORCE_ICE_RELAY="${NEXT_PUBLIC_FORCE_ICE_RELAY}" \
  NEXT_PUBLIC_CRM_EMAIL_PHASE1_ENABLED="${NEXT_PUBLIC_CRM_EMAIL_PHASE1_ENABLED}" \
  pnpm --filter @connect/portal build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ARG BUILD_COMMIT
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl curl \
  && rm -rf /var/lib/apt/lists/*
LABEL org.opencontainers.image.revision=$BUILD_COMMIT
RUN printf '%s\n' "$BUILD_COMMIT" > /app/.build-commit
COPY --from=builder /app/apps/portal/.next/standalone ./
COPY --from=builder /app/apps/portal/.next/static ./apps/portal/.next/static
COPY --from=builder /app/apps/portal/public ./apps/portal/public
CMD ["node", "apps/portal/server.js"]
