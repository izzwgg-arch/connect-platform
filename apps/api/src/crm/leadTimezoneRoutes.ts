import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireCrmAdmin } from "./guard";
import { backfillLeadTimezonesForTenant } from "./leadTimezoneService";

export async function registerCrmLeadTimezoneRoutes(app: FastifyInstance) {
  /**
   * POST /crm/admin/lead-timezone/backfill
   * Idempotent tenant-scoped backfill for existing CRM leads.
   * Query: dryRun=true|false, limit=1..500, cursor=<crmContactMetaId>
   */
  app.post("/crm/admin/lead-timezone/backfill", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;

    const parsed = z
      .object({
        dryRun: z
          .string()
          .optional()
          .transform((v) => v === "true"),
        limit: z
          .string()
          .optional()
          .transform((v) => (v ? Number(v) : undefined))
          .pipe(z.number().int().min(1).max(500).optional()),
        cursor: z.string().optional(),
      })
      .safeParse(req.query ?? {});

    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_query", detail: parsed.error.format() });
    }

    const result = await backfillLeadTimezonesForTenant(user.tenantId, {
      dryRun: parsed.data.dryRun === true,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });

    return result;
  });
}
