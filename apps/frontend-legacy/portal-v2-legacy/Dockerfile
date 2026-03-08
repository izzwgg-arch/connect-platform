FROM node:20-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY . .
CMD ["sh", "-c", "pnpm --filter @connect/portal dev"]
