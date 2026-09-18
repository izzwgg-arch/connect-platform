FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
ARG NEXT_PUBLIC_COMMUNITY_API_URL
ARG NEXT_PUBLIC_LOOPCOM_PORTAL_URL
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID
ARG NEXT_PUBLIC_APPLE_CLIENT_ID
ENV NEXT_PUBLIC_COMMUNITY_API_URL=$NEXT_PUBLIC_COMMUNITY_API_URL NEXT_PUBLIC_LOOPCOM_PORTAL_URL=$NEXT_PUBLIC_LOOPCOM_PORTAL_URL NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID NEXT_PUBLIC_APPLE_CLIENT_ID=$NEXT_PUBLIC_APPLE_CLIENT_ID
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/community-web/package.json apps/community-web/package.json
RUN pnpm install --frozen-lockfile --filter @loopcom/community-web... --config.node-linker=hoisted --ignore-scripts || pnpm install --filter @loopcom/community-web... --config.node-linker=hoisted --ignore-scripts
COPY apps/community-web apps/community-web
RUN cd apps/community-web && pnpm build

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3100
WORKDIR /app
COPY --from=build /repo/apps/community-web/.next/standalone ./
COPY --from=build /repo/apps/community-web/.next/static ./apps/community-web/.next/static
COPY --from=build /repo/apps/community-web/public ./apps/community-web/public
EXPOSE 3100
CMD ["node", "apps/community-web/server.js"]
