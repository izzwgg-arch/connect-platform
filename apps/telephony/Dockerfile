FROM node:20-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --filter @connect/telephony...
CMD ["sh", "-c", "pnpm --filter @connect/telephony dev"]
