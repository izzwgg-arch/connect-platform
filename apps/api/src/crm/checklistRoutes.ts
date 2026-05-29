import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { requireCrmAccess } from "./guard";
import { writeTimelineEvent } from "./timelineHelper";

const itemSchema = z.object({
  label: z.string().min(1).max(300),
  required: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  items: z.array(itemSchema).default([]),
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  // Replace items entirely when provided
  items: z.array(itemSchema).optional(),
});

const respondSchema = z.object({
  contactId: z.string().min(1),
  linkedId: z.string().optional(),
  answers: z.record(z.string(), z.boolean()),
});

export async function registerCrmChecklistRoutes(app: FastifyInstance) {
  // ── GET /crm/checklists ──────────────────────────────────────────────────────
  // List active checklists with their items. Any CRM user can read.
  app.get("/crm/checklists", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const q = req.query as Record<string, string>;
    const includeInactive = q.includeInactive === "true";

    const checklists = await db.crmChecklist.findMany({
      where: { tenantId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: { createdAt: "desc" },
      include: {
        items: { orderBy: { sortOrder: "asc" } },
      },
    });

    return { checklists };
  });

  // ── GET /crm/checklists/:id ──────────────────────────────────────────────────
  app.get("/crm/checklists/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const checklist = await db.crmChecklist.findFirst({
      where: { id, tenantId },
      include: { items: { orderBy: { sortOrder: "asc" } } },
    });
    if (!checklist) return reply.code(404).send({ error: "not_found" });
    return { checklist };
  });

  // ── POST /crm/checklists ─────────────────────────────────────────────────────
  // Create checklist with items. Any CRM-enabled user in the tenant.
  app.post("/crm/checklists", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.issues });

    const checklist = await db.crmChecklist.create({
      data: {
        tenantId,
        name: parsed.data.name,
        createdByUserId: userId,
        items: {
          create: parsed.data.items.map((item, i) => ({
            label: item.label,
            required: item.required,
            sortOrder: item.sortOrder !== 0 ? item.sortOrder : i,
          })),
        },
      },
      include: { items: { orderBy: { sortOrder: "asc" } } },
    });
    return reply.code(201).send({ checklist });
  });

  // ── PATCH /crm/checklists/:id ────────────────────────────────────────────────
  // Update checklist name/active status, optionally replace all items.
  app.patch("/crm/checklists/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const existing = await db.crmChecklist.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "not_found" });

    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.issues });

    // If items provided, replace all items atomically
    if (parsed.data.items !== undefined) {
      await db.crmChecklistItem.deleteMany({ where: { checklistId: id } });
      if (parsed.data.items.length > 0) {
        await db.crmChecklistItem.createMany({
          data: parsed.data.items.map((item, i) => ({
            checklistId: id,
            label: item.label,
            required: item.required,
            sortOrder: item.sortOrder !== 0 ? item.sortOrder : i,
          })),
        });
      }
    }

    const checklist = await db.crmChecklist.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      },
      include: { items: { orderBy: { sortOrder: "asc" } } },
    });
    return { checklist };
  });

  // ── DELETE /crm/checklists/:id ───────────────────────────────────────────────
  // Archive (soft-delete). Any CRM-enabled user in the tenant.
  app.delete("/crm/checklists/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const existing = await db.crmChecklist.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "not_found" });

    await db.crmChecklist.update({ where: { id }, data: { isActive: false } });
    return { ok: true };
  });

  // ── POST /crm/checklists/:id/respond ────────────────────────────────────────
  // Save a checklist response for a contact (during or after a call).
  // Writes CHECKLIST_COMPLETED timeline event — non-throwing.
  app.post("/crm/checklists/:id/respond", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;
    const { id: checklistId } = req.params as { id: string };

    const parsed = respondSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.issues });

    const { contactId, linkedId, answers } = parsed.data;

    // Verify checklist belongs to tenant
    const checklist = await db.crmChecklist.findFirst({
      where: { id: checklistId, tenantId },
      include: { items: { orderBy: { sortOrder: "asc" } } },
    });
    if (!checklist) return reply.code(404).send({ error: "checklist_not_found" });

    // Verify contact belongs to tenant
    const contact = await db.contact.findFirst({
      where: { id: contactId, tenantId },
      select: { id: true, displayName: true },
    });
    if (!contact) return reply.code(404).send({ error: "contact_not_found" });

    const response = await db.crmChecklistResponse.create({
      data: {
        tenantId,
        checklistId,
        contactId,
        linkedId: linkedId ?? null,
        completedByUserId: userId,
        answers,
      },
    });

    // Build metadata for timeline
    const total = checklist.items.length;
    const checked = Object.values(answers).filter(Boolean).length;
    const requiredItems = checklist.items.filter((i) => i.required);
    const allRequiredDone = requiredItems.every((i) => answers[i.id]);

    const metadata = {
      checklistName: checklist.name,
      checklistId,
      responseId: response.id,
      itemsTotal: total,
      itemsChecked: checked,
      allRequiredDone,
      linkedId: linkedId ?? null,
    };

    writeTimelineEvent({
      tenantId,
      contactId,
      type: "CHECKLIST_COMPLETED",
      title: `Checklist completed: ${checklist.name}`,
      body: `${checked}/${total} items checked${allRequiredDone ? "" : " (some required items unchecked)"}`,
      metadata,
      linkedId: response.id,
      createdByUserId: userId,
    }); // non-awaited — non-blocking

    return reply.code(201).send({ response, metadata });
  });
}
