FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY . .
RUN pnpm --filter @connect/integrations build
# Regenerate Prisma client so it always matches the schema in this image.
# This is needed when new models are added (e.g. ConnectCdr).
RUN pnpm --filter @connect/db exec prisma generate --schema prisma/schema.prisma
CMD ["sh", "-c", "pnpm --filter @connect/api dev"]
