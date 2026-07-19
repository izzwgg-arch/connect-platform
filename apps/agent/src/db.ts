/**
 * Lazy Prisma access. The agent must boot cleanly with no DB (degraded mode:
 * file audit only, chat disabled). Import of @connect/db is dynamic so a
 * missing generated client or unreachable DB never crashes startup.
 */
export type PrismaLike = any;

let prisma: PrismaLike | null = null;
let attempted = false;

export async function getPrisma(): Promise<PrismaLike | null> {
  if (prisma || attempted) return prisma;
  attempted = true;
  try {
    const mod: any = await import("@connect/db");
    const client = mod.db ?? mod.prisma ?? null; // @connect/db exports `db` (PrismaClient singleton)
    if (!client) throw new Error("@connect/db exposes no client");
    await client.$queryRaw`SELECT 1`;
    prisma = client;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[db] Prisma unavailable — running in degraded (no-DB) mode:", String(err));
    prisma = null;
  }
  return prisma;
}
