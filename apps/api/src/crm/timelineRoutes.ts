import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { requireCrmAccess, isAdminRole } from "./guard";
import { writeTimelineEvent, updateLinkedTimelineBody } from "./timelineHelper";

// ── Schemas ────────────────────────────────────────────────────────────────────

const createNoteSchema = z.object({
  body: z.string().min(1).max(10_000),
  pinned: z.boolean().default(false),
});

const patchNoteSchema = z.object({
  body: z.string().min(1).max(10_000).optional(),
  pinned: z.boolean().optional(),
});

// ── Helper: resolve contact with tenant guard ──────────────────────────────────

async function resolveContact(
  contactId: string,
  tenantId: string,
  mode: "read" | "mutate",
  role: string | undefined,
) {
  const allowInactive = mode === "read" && isAdminRole(role);
  return (db as any).contact.findFirst({
    where: allowInactive
      ? { id: contactId, tenantId }
      : { id: contactId, tenantId, active: true },
    select: { id: true, displayName: true },
  });
}

// ── Route registrar ────────────────────────────────────────────────────────────

export async function registerCrmTimelineRoutes(app: FastifyInstance) {
  // ── GET /crm/timeline ───────────────────────────────────────────────────────
  // Minimal unified timeline read for this pass (email-only from portal caller).
  // Query:
  //   - contactId: string (required in this slice)
  //   - types: string | string[] (optional; e.g., EMAIL_SENT, EMAIL_RECEIVED)
  //   - limit: number (default 50, max 200)
  //   - cursor: base64(JSON { createdAt: ISO, id: string }) for DESC pagination
  app.get("/crm/timeline", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, role } = user;

    const qSchema = z.object({
      contactId: z.string().min(1),
      types: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .transform((v) => (v == null ? [] : Array.isArray(v) ? v : [v])),
      limit: z
        .string()
        .optional()
        .transform((v) => (v ? parseInt(v, 10) : 50))
        .pipe(z.number().int().min(1).max(200)),
      cursor: z.string().optional(),
    });

    const parsed = qSchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_query" });

    const contactId = parsed.data.contactId;
    const types = (parsed.data.types || []).filter((t) =>
      [
        "EMAIL_SENT",
        "EMAIL_RECEIVED",
        // future types can be added without changing API shape
      ].includes(String(t))
    ) as string[];
    const limit = parsed.data.limit as number;

    const contact = await resolveContact(contactId, tenantId, "read", role);
    if (!contact) return reply.status(404).send({ error: "not_found" });

    let cursorWhere: any = undefined;
    if (parsed.data.cursor) {
      try {
        const raw = Buffer.from(parsed.data.cursor, "base64").toString("utf8");
        const c = JSON.parse(raw) as { createdAt: string; id: string };
        const cAt = new Date(c.createdAt);
        cursorWhere = {
          OR: [
            { createdAt: { lt: cAt } },
            { AND: [{ createdAt: cAt }, { id: { lt: c.id } }] },
          ],
        };
      } catch {
        // ignore bad cursor: treat as first page
      }
    }

    const where: any = {
      tenantId,
      contactId,
      ...(types.length ? { type: { in: types as any } } : {}),
      ...(cursorWhere || {}),
    };

    const rows = await (db as any).crmTimelineEvent.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      include: {
        createdByUser: {
          select: { id: true, firstName: true, lastName: true, displayName: true, email: true },
        },
      },
    });

    const last = rows[rows.length - 1];
    const nextCursor = last
      ? Buffer.from(
          JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
          "utf8",
        ).toString("base64")
      : null;

    return {
      contactId,
      events: rows.map(formatTimelineEvent),
      nextCursor,
    };
  });

  // ── GET /crm/contacts/:id/timeline ─────────────────────────────────────────
  // Replaces the Phase 1B placeholder. Returns all timeline events for the contact,
  // newest-first, with linked note body for NOTE_* events.
  app.get("/crm/contacts/:id/timeline", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, role } = user;
    const { id } = req.params as { id: string };

    const contact = await resolveContact(id, tenantId, "read", role);
    if (!contact) return reply.status(404).send({ error: "not_found" });

    const events = await (db as any).crmTimelineEvent.findMany({
      where: { contactId: id, tenantId },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        createdByUser: {
          select: { id: true, firstName: true, lastName: true, displayName: true, email: true },
        },
      },
    });

    return {
      contactId: id,
      events: events.map(formatTimelineEvent),
    };
  });

  // ── POST /crm/contacts/:id/notes ───────────────────────────────────────────
  app.post("/crm/contacts/:id/notes", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;
    const { id: contactId } = req.params as { id: string };

    const contact = await resolveContact(contactId, tenantId, "mutate", user.role);
    if (!contact) return reply.status(404).send({ error: "not_found" });

    const parsed = createNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const note = await (db as any).crmContactNote.create({
      data: {
        tenantId,
        contactId,
        body: parsed.data.body,
        pinned: parsed.data.pinned,
        createdByUserId: userId,
      },
      include: {
        createdByUser: {
          select: { id: true, firstName: true, lastName: true, displayName: true, email: true },
        },
      },
    });

    // Write timeline event — non-throwing via helper
    await writeTimelineEvent({
      tenantId,
      contactId,
      type: "NOTE_ADDED",
      title: "Note added",
      body: note.body,
      linkedId: note.id,
      createdByUserId: userId,
    });

    reply.status(201).send(formatNote(note));
  });

  // ── GET /crm/contacts/:id/notes ────────────────────────────────────────────
  app.get("/crm/contacts/:id/notes", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, role } = user;
    const { id: contactId } = req.params as { id: string };

    const contact = await resolveContact(contactId, tenantId, "read", role);
    if (!contact) return reply.status(404).send({ error: "not_found" });

    const notes = await (db as any).crmContactNote.findMany({
      where: { contactId, tenantId },
      orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
      include: {
        createdByUser: {
          select: { id: true, firstName: true, lastName: true, displayName: true, email: true },
        },
      },
    });

    return { contactId, notes: notes.map(formatNote) };
  });

  // ── PATCH /crm/contacts/:id/notes/:noteId ─────────────────────────────────
  app.patch("/crm/contacts/:id/notes/:noteId", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;
    const { id: contactId, noteId } = req.params as { id: string; noteId: string };

    const contact = await resolveContact(contactId, tenantId, "mutate", user.role);
    if (!contact) return reply.status(404).send({ error: "not_found" });

    const existing = await (db as any).crmContactNote.findFirst({
      where: { id: noteId, contactId, tenantId },
      select: { id: true, createdByUserId: true, body: true },
    });
    if (!existing) return reply.status(404).send({ error: "note_not_found" });

    const parsed = patchNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const updateData: Record<string, unknown> = {};
    if (parsed.data.body !== undefined) updateData.body = parsed.data.body;
    if (parsed.data.pinned !== undefined) updateData.pinned = parsed.data.pinned;

    const updated = await (db as any).crmContactNote.update({
      where: { id: noteId },
      data: updateData,
      include: {
        createdByUser: {
          select: { id: true, firstName: true, lastName: true, displayName: true, email: true },
        },
      },
    });

    // If body changed: update linked NOTE_ADDED event body + write NOTE_EDITED event
    if (parsed.data.body !== undefined && parsed.data.body !== existing.body) {
      await Promise.all([
        updateLinkedTimelineBody(noteId, "NOTE_ADDED", parsed.data.body),
        writeTimelineEvent({
          tenantId,
          contactId,
          type: "NOTE_EDITED",
          title: "Note edited",
          body: parsed.data.body,
          linkedId: noteId,
          createdByUserId: userId,
        }),
      ]);
    }

    return formatNote(updated);
  });

  // ── DELETE /crm/contacts/:id/notes/:noteId ─────────────────────────────────
  app.delete("/crm/contacts/:id/notes/:noteId", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id: contactId, noteId } = req.params as { id: string; noteId: string };

    const contact = await resolveContact(contactId, tenantId, "mutate", user.role);
    if (!contact) return reply.status(404).send({ error: "not_found" });

    const existing = await (db as any).crmContactNote.findFirst({
      where: { id: noteId, contactId, tenantId },
      select: { id: true },
    });
    if (!existing) return reply.status(404).send({ error: "note_not_found" });

    await (db as any).crmContactNote.delete({ where: { id: noteId } });

    // Timeline event body becomes "(deleted)" for the original NOTE_ADDED entry
    await updateLinkedTimelineBody(noteId, "NOTE_ADDED", "(deleted)");

    return reply.status(204).send();
  });
}

// ── Formatters ─────────────────────────────────────────────────────────────────

function formatTimelineEvent(e: any) {
  return {
    id: e.id,
    type: e.type as string,
    title: e.title,
    body: e.body ?? null,
    metadata: e.metadata ?? null,
    linkedId: e.linkedId ?? null,
    createdAt: e.createdAt,
    createdBy: e.createdByUser
      ? {
          id: e.createdByUser.id,
          displayName:
            e.createdByUser.displayName ||
            [e.createdByUser.firstName, e.createdByUser.lastName].filter(Boolean).join(" ") ||
            e.createdByUser.email,
        }
      : null,
  };
}

function formatNote(n: any) {
  return {
    id: n.id,
    contactId: n.contactId,
    body: n.body,
    pinned: n.pinned,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    createdBy: n.createdByUser
      ? {
          id: n.createdByUser.id,
          displayName:
            n.createdByUser.displayName ||
            [n.createdByUser.firstName, n.createdByUser.lastName].filter(Boolean).join(" ") ||
            n.createdByUser.email,
        }
      : null,
  };
}
