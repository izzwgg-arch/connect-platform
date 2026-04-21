FROM node:20-bookworm-slim
WORKDIR /app
ENV CI=true
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY . .
# Install workspace deps (identical to api image so tsx / prisma / mysql2 etc.
# are present inside the container instead of relying on build-host node_modules).
RUN pnpm install --frozen-lockfile
# Generate Prisma client inside the image so the worker has a valid client
# regardless of whether it was generated on the build host.
RUN pnpm --filter @connect/db exec prisma generate --schema prisma/schema.prisma
CMD ["sh", "-c", "pnpm --filter @connect/worker dev"]
