/**
 * Connect-STAFF admin read APIs for the portal (Approvals queue, Activity feed,
 * Incidents). Platform-wide aggregations over the agent tables — they show every
 * tenant's data, so they are gated to SUPER_ADMIN (Connect staff) only.
 *
 * ⛔ NOT `requireOwner` (which admits TENANT_ADMIN): these feeds are cross-tenant
 * by construction (no per-tenant filter, and AgentIncident has no tenantId to
 * filter by), so admitting a customer's own admin leaked every other tenant's
 * agent activity, pending approvals ("Give <email> permission…"), and incidents.
 * `resolveStaffCaller` narrows to SUPER_ADMIN. A tenant admin gets 403.
 */
import type { FastifyInstance } from "fastify";
import { resolveStaffCaller } from "../adminAuth";

export function registerAdminRoutes(app: FastifyInstance, prisma: any) {
  app.get("/agent/admin/approvals", async (req, reply) => {
    if (!resolveStaffCaller(req)) return reply.code(403).send({ error: "forbidden" });
    const pending = await prisma.agentAction.findMany({ where: { status: "PENDING_APPROVAL" }, orderBy: { createdAt: "desc" }, take: 100 });
    const recent = await prisma.agentAction.findMany({ where: { status: { in: ["EXECUTED", "REVERTED", "DENIED", "FAILED", "EXPIRED"] } }, orderBy: { updatedAt: "desc" }, take: 50 });
    return { pending, recent };
  });

  app.get("/agent/admin/activity", async (req, reply) => {
    if (!resolveStaffCaller(req)) return reply.code(403).send({ error: "forbidden" });
    const events = await prisma.agentAuditLog.findMany({ orderBy: { ts: "desc" }, take: 100 });
    const counts = {
      conversationsToday: await prisma.agentConversation.count({ where: { startedAt: { gte: startOfDay() } } }),
      actionsExecuted: await prisma.agentAction.count({ where: { status: "EXECUTED" } }),
      pendingApprovals: await prisma.agentAction.count({ where: { status: "PENDING_APPROVAL" } }),
      openIncidents: await prisma.agentIncident.count({ where: { status: "open" } }),
      diagReports: await prisma.agentDiagReport.count({ where: { createdAt: { gte: startOfDay() } } }),
    };
    return { counts, events };
  });

  app.get("/agent/admin/incidents", async (req, reply) => {
    if (!resolveStaffCaller(req)) return reply.code(403).send({ error: "forbidden" });
    const incidents = await prisma.agentIncident.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    return { incidents };
  });
}

function startOfDay(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
