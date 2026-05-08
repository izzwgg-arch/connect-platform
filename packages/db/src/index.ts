import { PrismaClient } from "@prisma/client";

export const db = new PrismaClient();

export type { PrismaClient, Prisma } from "@prisma/client";

export * from "./voicemailIngestIncidentService";
