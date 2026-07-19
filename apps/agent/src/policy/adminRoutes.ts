/**
 * Owner-only policy administration (PLAN.md §6a). Read + write per-tenant
 * AgentPolicy with versioning and a full diff written to the audit log on every
 * change. Owner JWT required. This is the API behind the portal Permissions page
 * and the natural-language policy editing flow.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyPortalJwt } from "../auth";
import type { AuditLog } from "../audit/audit";

function owner(req: any): { id: string } | null {
  const auth = req.headers.authorization;
  const id = auth?.startsWith("Bearer ") ? verifyPortalJwt(auth.slice(7)) : null;
  return id?.role === "owner" ? { id: id.clientUserId ?? "owner" } : null;
}

const GrantSchema = z.object({
  mode: z.enum(["allowed", "ask_owner", "blocked"]),
  limits: z.record(z.string(), z.number()).optional(),
  businessHoursOnly: z.boolean().optional(),
  protectedExtensions: z.array(z.string()).optional(),
});

const PolicyPatch = z.object({
  tenantId: z.string().min(1),
  historyVisible: z.boolean().optional(),
  channels: z.array(z.enum(["chat", "email", "whatsapp", "sms", "phone"])).optional(),
  grants: z.record(z.string(), GrantSchema).optional(),
});

export function registerPolicyAdminRoutes(app: FastifyInstance, prisma: any, audit: AuditLog) {
  app.get("/agent/admin/policies", async (req, reply) => {
    if (!owner(req)) return reply.code(403).send({ error: "forbidden" });
    const policies = await prisma.agentPolicy.findMany({ orderBy: { updatedAt: "desc" }, take: 200 });
    return { policies };
  });

  app.get<{ Params: { tenantId: string } }>("/agent/admin/policies/:tenantId", async (req, reply) => {
    if (!owner(req)) return reply.code(403).send({ error: "forbidden" });
    const p = await prisma.agentPolicy.findUnique({ where: { tenantId: req.params.tenantId } });
    return { policy: p };
  });

  app.post("/agent/admin/policies", async (req, reply) => {
    const o = owner(req);
    if (!o) return reply.code(403).send({ error: "forbidden" });
    const body = PolicyPatch.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request", detail: body.error.issues });
    const { tenantId, ...patch } = body.data;

    const before = await prisma.agentPolicy.findUnique({ where: { tenantId } });
    const nextVersion = (before?.version ?? 0) + 1;
    const data = {
      historyVisible: patch.historyVisible ?? before?.historyVisible ?? false,
      channels: patch.channels ?? before?.channels ?? ["chat"],
      grants: (patch.grants ?? before?.grants ?? {}) as any,
      updatedBy: `owner:${o.id}`,
      version: nextVersion,
    };
    const after = await prisma.agentPolicy.upsert({
      where: { tenantId },
      update: data,
      create: { tenantId, ...data },
    });

    // Full diff to the audit log — every policy change is traceable.
    await audit.record({
      actor: "owner",
      event: "policy.updated",
      tenantId,
      payload: {
        version: nextVersion,
        before: before ? { historyVisible: before.historyVisible, channels: before.channels, grants: before.grants } : null,
        after: { historyVisible: after.historyVisible, channels: after.channels, grants: after.grants },
      },
    });
    return { policy: after };
  });
}
