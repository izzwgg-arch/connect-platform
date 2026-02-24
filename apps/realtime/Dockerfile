FROM node:20-alpine
WORKDIR /app
RUN corepack enable
COPY . .
CMD ["sh", "-c", "pnpm --filter @connect/realtime dev"]
