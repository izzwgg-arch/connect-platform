import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { requireCrmAccess, isAdminRole } from "./guard";
import { assertCrmContactAllowed } from "./crmContactAccess";
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

  // ── GET /crm/contacts/:id/timeline ─────────────────────────────────────────
  // Replaces the Phase 1B placeholder. Returns all timeline events for the contact,
  // newest-first, with linked note body for NOTE_* events.
  app.get("/crm/contacts/:id/timeline", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, role } = user;
    const { id } = req.params as { id: string };

    if (!(await assertCrmContactAllowed(user, id, reply))) return;

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
    const emailReplyByEventId = await loadEmailReplySnippetsForTimelineEvents({
      tenantId,
      contactId: id,
      events,
    });

    return {
      contactId: id,
      events: events.map((event: any) => formatTimelineEvent(event, emailReplyByEventId.get(event.id))),
    };
  });

  // ── POST /crm/contacts/:id/notes ───────────────────────────────────────────
  app.post("/crm/contacts/:id/notes", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;
    const { id: contactId } = req.params as { id: string };

    if (!(await assertCrmContactAllowed(user, contactId, reply))) return;

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

    if (!(await assertCrmContactAllowed(user, contactId, reply))) return;

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

    if (!(await assertCrmContactAllowed(user, contactId, reply))) return;

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

    if (!(await assertCrmContactAllowed(user, contactId, reply))) return;

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

type EmailReplyTimelineSnippet = {
  id: string;
  subject: string | null;
  fromEmail: string | null;
  toEmail: string | null;
  previewSnippet: string | null;
};

async function loadEmailReplySnippetsForTimelineEvents({
  tenantId,
  contactId,
  events,
}: {
  tenantId: string;
  contactId: string;
  events: any[];
}): Promise<Map<string, EmailReplyTimelineSnippet>> {
  const emailEvents = events.filter((event) => event.type === "EMAIL_RECEIVED" || event.type === "EMAIL_REPLY");
  if (emailEvents.length === 0) return new Map();

  const linkedIds = emailEvents
    .map((event) => (typeof event.linkedId === "string" ? event.linkedId : null))
    .filter(Boolean) as string[];
  const threadIds = emailEvents
    .map((event) => {
      const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : null;
      const threadId = metadata && "threadId" in metadata ? (metadata as Record<string, unknown>).threadId : null;
      return typeof threadId === "string" ? threadId : null;
    })
    .filter(Boolean) as string[];

  if (linkedIds.length === 0 && threadIds.length === 0) return new Map();

  const messages = await (db as any).crmEmailMessage.findMany({
    where: {
      tenantId,
      contactId,
      direction: "INBOUND",
      OR: [
        ...(linkedIds.length ? [{ id: { in: linkedIds } }] : []),
        ...(threadIds.length ? [{ thread: { gmailThreadId: { in: threadIds } } }] : []),
      ],
    },
    select: {
      id: true,
      subject: true,
      fromEmail: true,
      toEmail: true,
      previewSnippet: true,
      createdAt: true,
      thread: { select: { gmailThreadId: true } },
    },
  });
  const messagesById = new Map(messages.map((message: any) => [message.id, message]));
  const messagesByThreadId = new Map<string, any[]>();
  for (const message of messages) {
    const threadId = message.thread?.gmailThreadId;
    if (!threadId) continue;
    const group = messagesByThreadId.get(threadId) ?? [];
    group.push(message);
    messagesByThreadId.set(threadId, group);
  }

  const byEventId = new Map<string, EmailReplyTimelineSnippet>();
  for (const event of emailEvents) {
    const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : null;
    const threadId = metadata && "threadId" in metadata ? (metadata as Record<string, unknown>).threadId : null;
    const candidates =
      (typeof event.linkedId === "string" && messagesById.get(event.linkedId)
        ? [messagesById.get(event.linkedId)]
        : null) ||
      (typeof threadId === "string" ? messagesByThreadId.get(threadId) : null);
    if (!candidates?.length) continue;
    const eventTime = new Date(event.createdAt).getTime();
    const match = candidates.reduce((best, candidate) => {
      const bestDelta = Math.abs(new Date(best.createdAt).getTime() - eventTime);
      const candidateDelta = Math.abs(new Date(candidate.createdAt).getTime() - eventTime);
      return candidateDelta < bestDelta ? candidate : best;
    }, candidates[0]);
    byEventId.set(event.id, {
      id: match.id,
      subject: match.subject ?? null,
      fromEmail: match.fromEmail ?? null,
      toEmail: match.toEmail ?? null,
      previewSnippet: match.previewSnippet ?? null,
    });
  }
  return byEventId;
}

function formatTimelineEvent(e: any, emailReply?: EmailReplyTimelineSnippet) {
  const metadata =
    emailReply && (e.type === "EMAIL_RECEIVED" || e.type === "EMAIL_REPLY")
      ? {
          ...(e.metadata ?? {}),
          from: emailReply.fromEmail ?? (e.metadata as any)?.from ?? null,
          to: emailReply.toEmail ?? (e.metadata as any)?.to ?? null,
          subject: emailReply.subject ?? (e.metadata as any)?.subject ?? e.body ?? null,
          previewSnippet: emailReply.previewSnippet ?? (e.metadata as any)?.previewSnippet ?? null,
          replyText: emailReply.previewSnippet ?? (e.metadata as any)?.replyText ?? null,
        }
      : e.metadata ?? null;
  return {
    id: e.id,
    type: e.type as string,
    title: e.title,
    body:
      emailReply?.previewSnippet && (e.type === "EMAIL_RECEIVED" || e.type === "EMAIL_REPLY")
        ? emailReply.previewSnippet
        : e.body ?? null,
    metadata,
    linkedId: e.linkedId ?? emailReply?.id ?? null,
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
