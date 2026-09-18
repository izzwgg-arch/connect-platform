import { PrismaClient, Prisma } from "../node_modules/.prisma/community-client/index.js";

export type Db = PrismaClient;
export { Prisma };

let client: PrismaClient | null = null;
export function db(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      log: process.env.COMMUNITY_SQL_LOG === "1" ? ["query", "warn", "error"] : ["warn", "error"],
    });
  }
  return client;
}

export async function disconnectDb() {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}
