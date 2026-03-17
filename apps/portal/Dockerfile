FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
CMD ["sh", "-c", "pnpm --filter @connect/portal build && pnpm --filter @connect/portal start"]
