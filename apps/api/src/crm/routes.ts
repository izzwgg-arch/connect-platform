import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { isAdminRole } from "./guard";
import { registerCrmContactRoutes } from "./contactRoutes";
import { registerCrmTimelineRoutes } from "./timelineRoutes";
import { registerCrmTaskRoutes } from "./taskRoutes";
import { registerCrmImportRoutes } from "./importRoutes";
import { registerCrmScriptRoutes } from "./scriptRoutes";
import { registerCrmChecklistRoutes } from "./checklistRoutes";
import { registerCrmCampaignRoutes } from "./campaignRoutes";
import { registerCrmReportRoutes } from "./reportRoutes";
import { registerCrmCallerIdPoolRoutes } from "./callerIdPoolRoutes";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extracts the JWT user from the request. The global onRequest hook already
 * ran jwtVerify(), so req.user is populated. Returns null + 401 if missing.
 */
async function requireAuth(req: any, reply: any): Promise<{ sub: string; tenantId: string; role?: string } | null> {
  const user = req.user as { sub: string; tenantId: string; role?: string } | undefined;
  if (!user?.sub) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return user;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type CrmUser = {
  sub: string;
  tenantId: string;
  role?: string;
};

function getUser(req: any): CrmUser {
  return req.user as CrmUser;
}

/** Guards a handler to admin-only. Returns null and sends 403 if not allowed. */
async function requireAdmin(req: any, reply: any): Promise<CrmUser | null> {
  const u = getUser(req);
  if (!isAdminRole(u.role)) {
    reply.status(403).send({ error: "forbidden", detail: "CRM admin access required" });
    return null;
  }
  return u;
}

/**
 * Verifies CRM is enabled for the tenant.
 * Returns the settings row if enabled; sends 403 and returns null if not.
 * Also returns null (without error) if user is admin — admins can always read/write settings
 * regardless of enabled state (so they can enable it in the first place).
 */
async function getCrmSettings(tenantId: string) {
  return db.crmTenantSettings.findUnique({ where: { tenantId } });
}

async function requireCrmEnabled(
  tenantId: string,
  reply: any,
): Promise<{ enabled: boolean } | null> {
  const settings = await getCrmSettings(tenantId);
  if (!settings || !settings.enabled) {
    reply.status(403).send({ error: "crm_not_enabled", detail: "CRM is not enabled for this tenant" });
    return null;
  }
  return settings;
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const updateSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  localPresenceEnabled: z.boolean().optional(),
  transcriptionEnabled: z.boolean().optional(),
});

const updateUserAccessSchema = z.object({
  enabled: z.boolean().optional(),
  role: z.enum(["AGENT", "MANAGER", "ADMIN"]).optional(),
});

// ── Route registrar ───────────────────────────────────────────────────────────

export async function registerCrmRoutes(app: FastifyInstance) {
  // ── GET /crm/settings ──────────────────────────────────────────────────────
  // Returns the tenant's CRM settings. Accessible to any authenticated user so
  // the portal can check `enabled` to decide whether to show the CRM section.
  app.get("/crm/settings", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const tenantId = user.tenantId;
    if (!tenantId) return reply.status(400).send({ error: "no_tenant" });

    const settings = await getCrmSettings(tenantId);
    // Return a default-shape even when no row exists so the portal always gets a clean object
    return {
      enabled: settings?.enabled ?? false,
      localPresenceEnabled: settings?.localPresenceEnabled ?? false,
      transcriptionEnabled: settings?.transcriptionEnabled ?? false,
    };
  });

  // ── PUT /crm/settings ──────────────────────────────────────────────────────
  // Upserts CRM settings for the tenant. Admin-only.
  app.put("/crm/settings", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;

    const tenantId = user.tenantId;
    if (!tenantId) return reply.status(400).send({ error: "no_tenant" });

    const parsed = updateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const data = parsed.data;
    const settings = await db.crmTenantSettings.upsert({
      where: { tenantId },
      create: {
        tenantId,
        enabled: data.enabled ?? false,
        localPresenceEnabled: data.localPresenceEnabled ?? false,
        transcriptionEnabled: data.transcriptionEnabled ?? false,
      },
      update: {
        ...(data.enabled !== undefined && { enabled: data.enabled }),
        ...(data.localPresenceEnabled !== undefined && { localPresenceEnabled: data.localPresenceEnabled }),
        ...(data.transcriptionEnabled !== undefined && { transcriptionEnabled: data.transcriptionEnabled }),
      },
    });

    return {
      enabled: settings.enabled,
      localPresenceEnabled: settings.localPresenceEnabled,
      transcriptionEnabled: settings.transcriptionEnabled,
    };
  });

  // ── GET /crm/users ─────────────────────────────────────────────────────────
  // Lists CRM user access rows for the tenant. Admin-only.
  // Returns all users in the tenant with their CRM access status (row or null → not granted).
  app.get("/crm/users", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;

    const tenantId = user.tenantId;
    if (!tenantId) return reply.status(400).send({ error: "no_tenant" });

    // Ensure CRM is enabled (admins can still list users to see who has access, even if disabled)
    // Admins bypass crm_not_enabled for management routes.

    const [tenantUsers, crmAccess] = await Promise.all([
      db.user.findMany({
        where: { tenantId, status: { not: "DELETED" as any } },
        select: { id: true, email: true, firstName: true, lastName: true, displayName: true, role: true },
        orderBy: { email: "asc" },
      }),
      db.crmUserAccess.findMany({
        where: { tenantId },
        select: { userId: true, enabled: true, role: true },
      }),
    ]);

    const accessMap = new Map(crmAccess.map((a) => [a.userId, a]));

    return {
      users: tenantUsers.map((u) => {
        const access = accessMap.get(u.id);
        return {
          userId: u.id,
          email: u.email,
          displayName: u.displayName || u.firstName || u.email,
          systemRole: u.role,
          crmEnabled: access?.enabled ?? false,
          crmRole: access?.role ?? null,
          hasAccess: !!access,
        };
      }),
    };
  });

  // ── PUT /crm/users/:userId ─────────────────────────────────────────────────
  // Upserts CRM access for a specific user. Admin-only.
  // Use enabled:false to revoke access without deleting the row.
  app.put("/crm/users/:userId", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;

    const tenantId = user.tenantId;
    if (!tenantId) return reply.status(400).send({ error: "no_tenant" });

    const { userId } = req.params as { userId: string };

    const parsed = updateUserAccessSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    // Verify the target user belongs to this tenant
    const targetUser = await db.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true },
    });
    if (!targetUser) {
      return reply.status(404).send({ error: "user_not_found" });
    }

    const data = parsed.data;
    const access = await db.crmUserAccess.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      create: {
        tenantId,
        userId,
        enabled: data.enabled ?? true,
        role: data.role ?? "AGENT",
      },
      update: {
        ...(data.enabled !== undefined && { enabled: data.enabled }),
        ...(data.role !== undefined && { role: data.role }),
      },
    });

    return {
      userId: access.userId,
      enabled: access.enabled,
      role: access.role,
    };
  });

  // Register CRM contact routes (Phase 1B)
  await registerCrmContactRoutes(app);

  // Register CRM timeline + notes routes (Phase 1C)
  await registerCrmTimelineRoutes(app);

  // Register CRM task routes (Phase 1D)
  await registerCrmTaskRoutes(app);

  // Register CRM import routes (Phase 1E)
  await registerCrmImportRoutes(app);

  // Register CRM script routes (Phase 2C)
  await registerCrmScriptRoutes(app);

  // Register CRM checklist routes (Phase 2C)
  await registerCrmChecklistRoutes(app);

  // Register CRM campaign + queue routes (Phase 3A)
  await registerCrmCampaignRoutes(app);

  // Register CRM report routes (Phase 4A)
  await registerCrmReportRoutes(app);

  // Register CRM caller ID pool routes (Phase 4B — Local Presence)
  await registerCrmCallerIdPoolRoutes(app);
}
