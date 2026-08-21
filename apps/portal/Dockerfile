# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/* \
  # Install pnpm directly via npm instead of corepack: the node:20 base image's
  # bundled corepack (0.31+) requires the Node 22-only `node:sqlite` builtin and
  # crashes, while older corepack can't verify pnpm 10.30.2's signature. npm avoids
  # both problems.
  && npm install --global pnpm@10.30.2 \
  && pnpm config set store-dir /pnpm/store

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# pnpm.patchedDependencies (react-native-callkeep) lives in root package.json —
# pnpm install hashes the patch file, so the build context must include it.
COPY patches ./patches
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
# Cloudflare Turnstile site key for the sign-in widget. PUBLIC by design.
# Kept as a real default (not "") so a bare `docker build` cannot silently ship an
# UNKEYED portal, which would drop the sign-in check with nothing failing loudly.
# On rotation this and docker-compose.app.yml must move together — turnstileWiring.test.ts fails if they drift.
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY="0x4AAAAAAEXikCDGv1Pl_SuX"
COPY apps/portal ./apps/portal
COPY packages/shared ./packages/shared
# ⛔⛔ THE CACHE ID MUST NOT CONTAIN ${BUILD_COMMIT}.
# It did until 2026-08-19, which meant every deploy allocated a BRAND NEW,
# EMPTY .next/cache and Next.js did a fully cold build every single time —
# measured at 1099s (18 min) inside a 20-min portal deploy. A stable id lets
# the webpack/SWC module cache survive between deploys, which is the entire
# point of the mount. Next invalidates its own entries by content hash, so a
# warm cache cannot serve stale code.
# sharing=locked because deploy-portal.sh builds `portal` and then
# `portal_candidate` from this same Dockerfile. They are sequential today; the
# lock keeps them from corrupting the shared cache if that ever changes.
RUN --mount=type=cache,id=connect-next-cache,sharing=locked,target=/app/apps/portal/.next/cache \
  NEXT_OUTPUT_STANDALONE=1 \
  NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL}" \
  NEXT_PUBLIC_TELEPHONY_WS_URL="${NEXT_PUBLIC_TELEPHONY_WS_URL}" \
  NEXT_PUBLIC_FORCE_ICE_RELAY="${NEXT_PUBLIC_FORCE_ICE_RELAY}" \
  NEXT_PUBLIC_TURNSTILE_SITE_KEY="${NEXT_PUBLIC_TURNSTILE_SITE_KEY}" \
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
