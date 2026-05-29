/**
 * CRM AI Settings Routes — Phase 7B
 *
 * GET /crm/ai-settings          — any authenticated CRM user
 * PUT /crm/ai-settings          — CRM admin only
 *
 * Strict tenant isolation: each tenant manages only its own settings.
 * Hard server caps on all numeric fields (enforced in the service layer).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireCrmAccess } from "./guard";
import { isAdminRole } from "./guard";
import { getTenantAiSettings, upsertTenantAiSettings } from "./leadIntelligenceService";

const updateSchema = z.object({
  aiEnabled: z.boolean().optional(),
  maxDocumentsPerReport: z.number().int().min(1).max(10).optional(),
  maxCharsPerDocument: z.number().int().min(100).max(5000).optional(),
  maxTotalCharsPerReport: z.number().int().min(500).max(25000).optional(),
  allowBatchGeneration: z.boolean().optional(),
  maxBatchReportsPerRun: z.number().int().min(1).max(25).optional(),
  regenerationCooldownMinutes: z.number().int().min(0).optional(),
});

export async function registerCrmAiSettingsRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /crm/ai-settings ─────────────────────────────────────────────────
  // Returns current AI settings (or defaults if no row exists).
  // Accessible to any authenticated CRM user — read-only visibility.
  app.get("/crm/ai-settings", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const settings = await getTenantAiSettings(tenantId);
    return reply.status(200).send(settings);
  });

  // ── PUT /crm/ai-settings ─────────────────────────────────────────────────
  // Upserts AI settings for the tenant. CRM admin role required.
  app.put("/crm/ai-settings", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, role } = user as { tenantId: string; role?: string; sub: string };

    if (!isAdminRole(role)) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "CRM admin access required to update AI settings.",
      });
    }

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const settings = await upsertTenantAiSettings(tenantId, parsed.data);
    return reply.status(200).send(settings);
  });
}
