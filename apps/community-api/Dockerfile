FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/community-api/package.json apps/community-api/package.json
RUN pnpm install --frozen-lockfile --filter @loopcom/community-api... --config.node-linker=hoisted --ignore-scripts || pnpm install --filter @loopcom/community-api... --config.node-linker=hoisted --ignore-scripts
COPY apps/community-api apps/community-api
RUN cd apps/community-api && pnpm rebuild sharp @node-rs/argon2 && pnpm prisma:generate && pnpm build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /repo/apps/community-api
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/community-api /repo/apps/community-api
EXPOSE 3101
CMD ["sh", "-c", "npx prisma migrate deploy --schema prisma/schema.prisma && node dist/server.js"]
