import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { requireCrmAccess, requireCrmAdmin } from "./guard";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  body: z.string().min(1),
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  body: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

export async function registerCrmScriptRoutes(app: FastifyInstance) {
  // ── GET /crm/scripts ────────────────────────────────────────────────────────
  // List active scripts for the tenant. Any CRM user can read.
  app.get("/crm/scripts", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const q = req.query as Record<string, string>;
    const includeInactive = q.includeInactive === "true";

    const scripts = await db.crmScript.findMany({
      where: { tenantId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, isActive: true, createdAt: true, updatedAt: true },
    });

    return { scripts };
  });

  // ── GET /crm/scripts/:id ─────────────────────────────────────────────────────
  // Single script with full body. Needed for live workspace display.
  app.get("/crm/scripts/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const script = await db.crmScript.findFirst({
      where: { id, tenantId },
    });
    if (!script) return reply.code(404).send({ error: "not_found" });
    return { script };
  });

  // ── POST /crm/scripts ────────────────────────────────────────────────────────
  // Create a new script. Requires admin.
  app.post("/crm/scripts", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.issues });

    const script = await db.crmScript.create({
      data: {
        tenantId,
        name: parsed.data.name,
        body: parsed.data.body,
        createdByUserId: userId,
      },
    });
    return reply.code(201).send({ script });
  });

  // ── PATCH /crm/scripts/:id ───────────────────────────────────────────────────
  // Update name, body, or archive. Requires admin.
  app.patch("/crm/scripts/:id", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const existing = await db.crmScript.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "not_found" });

    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.issues });

    const script = await db.crmScript.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      },
    });
    return { script };
  });

  // ── DELETE /crm/scripts/:id ──────────────────────────────────────────────────
  // Archive (soft-delete) a script. Requires admin.
  app.delete("/crm/scripts/:id", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const existing = await db.crmScript.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "not_found" });

    await db.crmScript.update({ where: { id }, data: { isActive: false } });
    return { ok: true };
  });
}
