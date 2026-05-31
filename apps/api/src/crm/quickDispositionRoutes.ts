import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { requireCrmAccess, loadCrmUserAccessRole, isAdminRole } from "./guard";
import {
  mergeQuickDispositionItems,
  normalizeCustomQuickDispositionInput,
  parseStoredCustomQuickDispositions,
  canManageQuickDispositions,
} from "./quickDispositions";

const customRowSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(100),
  sortOrder: z.number().int().min(0).max(999),
  enabled: z.boolean().optional(),
});

const putSchema = z.object({
  custom: z.array(customRowSchema).max(50),
});

async function requireCrmManagerOrAdmin(req: any, reply: any) {
  const user = await requireCrmAccess(req, reply);
  if (!user) return null;
  if (isAdminRole(user.role)) return user;
  const crmRole = await loadCrmUserAccessRole(user.tenantId, user.sub);
  if (canManageQuickDispositions(user.role, crmRole)) return user;
  reply.status(403).send({
    error: "crm_permission_denied",
    detail: "CRM manager or admin access required to manage quick dispositions.",
  });
  return null;
}

export async function registerCrmQuickDispositionRoutes(app: FastifyInstance) {
  app.get("/crm/quick-dispositions", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId, role } = user;

    const settings = await db.crmTenantSettings.findUnique({
      where: { tenantId },
      select: { quickDispositions: true },
    });
    const custom = parseStoredCustomQuickDispositions(settings?.quickDispositions);
    const crmRole = isAdminRole(role) ? "ADMIN" : await loadCrmUserAccessRole(tenantId, userId);

    return {
      items: mergeQuickDispositionItems(custom),
      canManage: canManageQuickDispositions(role, crmRole),
    };
  });

  app.put("/crm/quick-dispositions", async (req, reply) => {
    const user = await requireCrmManagerOrAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", issues: parsed.error.issues });
    }

    const custom = normalizeCustomQuickDispositionInput(parsed.data.custom);
    await db.crmTenantSettings.upsert({
      where: { tenantId },
      create: {
        tenantId,
        enabled: true,
        quickDispositions: custom,
      },
      update: {
        quickDispositions: custom,
      },
    });

    return {
      items: mergeQuickDispositionItems(custom),
      canManage: true,
    };
  });
}
