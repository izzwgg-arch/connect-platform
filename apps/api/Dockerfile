FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY . .
RUN pnpm --filter @connect/integrations build
CMD ["sh", "-c", "pnpm --filter @connect/api dev"]
