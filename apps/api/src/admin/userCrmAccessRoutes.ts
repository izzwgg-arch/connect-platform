import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";

type RouteDeps = {
  requirePermission: (req: any, reply: any, checker: (user: any) => boolean) => Promise<any | null>;
  canManageUsers: (user: any) => boolean;
  resolveAdminTargetUser: (admin: any, userId: string) => Promise<any | null>;
  audit: (params: {
    tenantId: string;
    action: string;
    entityType: string;
    entityId: string;
    actorUserId?: string;
    targetUserId?: string | null;
    metadata?: Record<string, unknown> | null;
  }) => Promise<void>;
};

const updateCrmAccessSchema = z.object({
  enabled: z.boolean(),
  role: z.enum(["AGENT", "MANAGER", "ADMIN"]).optional(),
  campaignIds: z.array(z.string().min(1)).max(100).optional(),
});

export async function registerAdminUserCrmAccessRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { requirePermission, canManageUsers, resolveAdminTargetUser, audit } = deps;

  app.get("/admin/users/:id/crm-access", async (req, reply) => {
    const admin = await requirePermission(req, reply, canManageUsers);
    if (!admin) return;

    const { id } = req.params as { id: string };
    const target = await resolveAdminTargetUser(admin, id);
    if (!target) return reply.status(404).send({ error: "user_not_found", detail: "User not found or not in your tenant." });

    if (admin.role !== "SUPER_ADMIN" && target.tenantId !== admin.tenantId) {
      return reply.status(403).send({ error: "forbidden", detail: "Cannot manage CRM access for users in another tenant." });
    }

    const [userRow, tenantRow, crmSettings, crmAccess, campaigns, assignments] = await Promise.all([
      db.user.findFirst({
        where: { id: target.id, tenantId: target.tenantId },
        select: { id: true, email: true, firstName: true, lastName: true, displayName: true },
      }),
      db.tenant.findUnique({ where: { id: target.tenantId }, select: { id: true, name: true } }),
      db.crmTenantSettings.findUnique({ where: { tenantId: target.tenantId }, select: { enabled: true } }),
      db.crmUserAccess.findUnique({
        where: { tenantId_userId: { tenantId: target.tenantId, userId: target.id } },
        select: { enabled: true, role: true },
      }),
      db.crmCampaign.findMany({
        where: { tenantId: target.tenantId, status: { not: "ARCHIVED" } },
        orderBy: { name: "asc" },
        select: { id: true, name: true, status: true },
      }),
      db.crmUserCampaignAssignment.findMany({
        where: { tenantId: target.tenantId, userId: target.id },
        select: { campaignId: true },
      }),
    ]);

    if (!userRow) return reply.status(404).send({ error: "user_not_found" });

    const assignedIds = new Set(assignments.map((a) => a.campaignId));

    return {
      tenantId: target.tenantId,
      tenantName: tenantRow?.name ?? null,
      userId: target.id,
      email: userRow.email,
      displayName: userRow.displayName || userRow.firstName || userRow.email,
      crmTenantEnabled: crmSettings?.enabled ?? false,
      crmEnabled: crmAccess?.enabled ?? false,
      crmRole: crmAccess?.role ?? null,
      assignedCampaignIds: [...assignedIds],
      campaigns: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        assigned: assignedIds.has(c.id),
      })),
    };
  });

  app.put("/admin/users/:id/crm-access", async (req, reply) => {
    const admin = await requirePermission(req, reply, canManageUsers);
    if (!admin) return;

    const { id } = req.params as { id: string };
    const parsed = updateCrmAccessSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const target = await resolveAdminTargetUser(admin, id);
    if (!target) return reply.status(404).send({ error: "user_not_found", detail: "User not found or not in your tenant." });

    if (admin.role !== "SUPER_ADMIN" && target.tenantId !== admin.tenantId) {
      return reply.status(403).send({ error: "forbidden", detail: "Cannot manage CRM access for users in another tenant." });
    }

    const data = parsed.data;
    const campaignIds = Array.from(new Set(data.campaignIds ?? []));

    if (campaignIds.length) {
      const valid = await db.crmCampaign.findMany({
        where: { id: { in: campaignIds }, tenantId: target.tenantId },
        select: { id: true },
      });
      const validIds = new Set(valid.map((c) => c.id));
      const invalidIds = campaignIds.filter((cid) => !validIds.has(cid));
      if (invalidIds.length) {
        return reply.status(400).send({
          error: "invalid_campaign",
          detail: "One or more campaigns do not belong to this tenant.",
          campaignIds: invalidIds,
        });
      }
    }

    const access = await db.$transaction(async (tx) => {
      const row = await tx.crmUserAccess.upsert({
        where: { tenantId_userId: { tenantId: target.tenantId, userId: target.id } },
        create: {
          tenantId: target.tenantId,
          userId: target.id,
          enabled: data.enabled,
          role: data.role ?? "AGENT",
        },
        update: {
          enabled: data.enabled,
          ...(data.role !== undefined ? { role: data.role } : {}),
        },
      });

      await tx.crmUserCampaignAssignment.deleteMany({
        where: { tenantId: target.tenantId, userId: target.id },
      });

      if (data.enabled && campaignIds.length) {
        await tx.crmUserCampaignAssignment.createMany({
          data: campaignIds.map((campaignId) => ({
            tenantId: target.tenantId,
            userId: target.id,
            campaignId,
          })),
        });
      }

      return row;
    });

    await audit({
      tenantId: target.tenantId,
      actorUserId: admin.sub,
      targetUserId: target.id,
      action: "USER_CRM_ACCESS_UPDATED",
      entityType: "User",
      entityId: target.id,
      metadata: { enabled: data.enabled, role: access.role, campaignIds: data.enabled ? campaignIds : [] },
    });

    return {
      ok: true,
      userId: target.id,
      tenantId: target.tenantId,
      enabled: access.enabled,
      role: access.role,
      assignedCampaignIds: data.enabled ? campaignIds : [],
    };
  });
}
