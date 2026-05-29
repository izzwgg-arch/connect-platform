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
import { registerCrmSmsRoutes } from "./smsRoutes";
import { registerCrmDiagnosticsRoutes } from "./diagnosticsRoutes";
import { registerCrmPilotReadinessRoutes } from "./pilotReadinessRoutes";
import { registerCrmEmailRoutes } from "./emailRoutes";
import { registerCrmBulkEmailRoutes } from "./bulkEmailRoutes";
import { registerCrmFunderRoutes } from "./funderRoutes";
import { registerCrmVoicemailDropRoutes } from "./voicemailDropRoutes";
import { registerCrmDriveRoutes } from "./driveRoutes";

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

const QUEUE_SORT_VALUES = ["SMART", "ORIGINAL"] as const;
const QUEUE_FILTER_VALUES = ["PENDING", "DUE", "OVERDUE", "UPCOMING"] as const;

const updateSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  localPresenceEnabled: z.boolean().optional(),
  transcriptionEnabled: z.boolean().optional(),
  defaultQueueSort: z.enum(QUEUE_SORT_VALUES).optional(),
  defaultQueueFilter: z.enum(QUEUE_FILTER_VALUES).optional(),
});

const updateUserAccessSchema = z.object({
  enabled: z.boolean().optional(),
  role: z.enum(["AGENT", "MANAGER", "ADMIN"]).optional(),
  campaignIds: z.array(z.string().min(1)).max(100).optional(),
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
      defaultQueueSort: settings?.defaultQueueSort ?? "SMART",
      defaultQueueFilter: settings?.defaultQueueFilter ?? "PENDING",
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
        defaultQueueSort: data.defaultQueueSort ?? "SMART",
        defaultQueueFilter: data.defaultQueueFilter ?? "PENDING",
      },
      update: {
        ...(data.enabled !== undefined && { enabled: data.enabled }),
        ...(data.localPresenceEnabled !== undefined && { localPresenceEnabled: data.localPresenceEnabled }),
        ...(data.transcriptionEnabled !== undefined && { transcriptionEnabled: data.transcriptionEnabled }),
        ...(data.defaultQueueSort !== undefined && { defaultQueueSort: data.defaultQueueSort }),
        ...(data.defaultQueueFilter !== undefined && { defaultQueueFilter: data.defaultQueueFilter }),
      },
    });

    return {
      enabled: settings.enabled,
      localPresenceEnabled: settings.localPresenceEnabled,
      transcriptionEnabled: settings.transcriptionEnabled,
      defaultQueueSort: settings.defaultQueueSort,
      defaultQueueFilter: settings.defaultQueueFilter,
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
        where: { tenantId, status: { not: "DISABLED" as any } },
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

  // ── GET /crm/users/:userId ─────────────────────────────────────────────────
  // Returns CRM access + campaign assignments for one tenant user. Admin-only.
  app.get("/crm/users/:userId", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;

    const tenantId = user.tenantId;
    if (!tenantId) return reply.status(400).send({ error: "no_tenant" });

    const { userId } = req.params as { userId: string };

    const targetUser = await db.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, email: true, firstName: true, lastName: true, displayName: true, role: true },
    });
    if (!targetUser) {
      return reply.status(404).send({ error: "user_not_found" });
    }

    const [access, assignments, campaigns] = await Promise.all([
      db.crmUserAccess.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        select: { enabled: true, role: true },
      }),
      db.crmUserCampaignAssignment.findMany({
        where: { tenantId, userId },
        select: { campaignId: true },
      }),
      db.crmCampaign.findMany({
        where: { tenantId, status: { not: "ARCHIVED" } },
        orderBy: { name: "asc" },
        select: { id: true, name: true, status: true },
      }),
    ]);

    const assignedIds = new Set(assignments.map((a) => a.campaignId));

    return {
      userId: targetUser.id,
      email: targetUser.email,
      displayName: targetUser.displayName || targetUser.firstName || targetUser.email,
      systemRole: targetUser.role,
      crmEnabled: access?.enabled ?? false,
      crmRole: access?.role ?? null,
      hasAccess: !!access,
      assignedCampaignIds: [...assignedIds],
      campaigns: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        assigned: assignedIds.has(c.id),
      })),
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
    const campaignIds = Array.from(new Set(data.campaignIds ?? []));

    if (campaignIds.length) {
      const valid = await db.crmCampaign.findMany({
        where: { id: { in: campaignIds }, tenantId },
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

      if (data.campaignIds !== undefined) {
        await tx.crmUserCampaignAssignment.deleteMany({ where: { tenantId, userId } });
        const enabled = data.enabled !== undefined ? data.enabled : row.enabled;
        if (enabled && campaignIds.length) {
          await tx.crmUserCampaignAssignment.createMany({
            data: campaignIds.map((campaignId) => ({ tenantId, userId, campaignId })),
          });
        }
      } else if (data.enabled === false) {
        await tx.crmUserCampaignAssignment.deleteMany({ where: { tenantId, userId } });
      }

      return row;
    });

    const assignments = await db.crmUserCampaignAssignment.findMany({
      where: { tenantId, userId },
      select: { campaignId: true },
    });

    return {
      userId: access.userId,
      enabled: access.enabled,
      role: access.role,
      assignedCampaignIds: assignments.map((a) => a.campaignId),
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

  // CRM Voicemail Drops — tenant-scoped pre-recorded PBX-safe audio
  await registerCrmVoicemailDropRoutes(app);

  // Register CRM checklist routes (Phase 2C)
  await registerCrmChecklistRoutes(app);

  // Register CRM campaign + queue routes (Phase 3A)
  await registerCrmCampaignRoutes(app);

  // Register CRM report routes (Phase 4A)
  await registerCrmReportRoutes(app);

  // Register CRM caller ID pool routes (Phase 4B — Local Presence)
  await registerCrmCallerIdPoolRoutes(app);

  // Register CRM SMS routes (Phase 11A — SMS from contact)
  await registerCrmSmsRoutes(app);

  await registerCrmDiagnosticsRoutes(app);
  await registerCrmPilotReadinessRoutes(app);

  // CRM Email (Phase 1 — send-only, feature-flagged)
  await registerCrmEmailRoutes(app);

  // CRM Bulk Email — admin-only bulk send from Contacts, Campaigns, or Funders
  await registerCrmBulkEmailRoutes(app);

  // CRM Funders — separate entity workspace for funding/referral/insurance/provider records
  await registerCrmFunderRoutes(app);

  // CRM Drive (Phase 1 — Google Drive folder connection + lead document foundation)
  await registerCrmDriveRoutes(app);
}
