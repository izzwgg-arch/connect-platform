import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { requireCrmAccess, requireCrmAdmin, requireCrmManager } from "./guard";
import { parseCsv } from "./importPipeline";
import {
  canSendSmsUser,
  findOrCreateConnectChatSmsThread,
  sendConnectChatSmsMessage,
  type ConnectChatRoutesDeps,
  type JwtUser,
} from "../connectChatRoutes";

// ── Constants ──────────────────────────────────────────────────────────────────

const FUNDER_IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const FUNDER_IMPORT_MAX_ROWS = 5_000;

// ── Shared include ─────────────────────────────────────────────────────────────

const FUNDER_INCLUDE = {
  tagLinks: { include: { tag: true } },
} as const;

// ── Schemas ────────────────────────────────────────────────────────────────────

const createFunderSchema = z.object({
  name: z.string().min(1).max(200),
  organization: z.string().max(200).optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(50).optional(),
  phone2: z.string().max(50).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  zip: z.string().max(20).optional(),
  notes: z.string().max(5_000).optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "PROSPECT", "PENDING"]).optional(),
  tagIds: z.array(z.string()).optional(),
});

const patchFunderSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  organization: z.string().max(200).optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal("")),
  phone: z.string().max(50).optional().nullable(),
  phone2: z.string().max(50).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  zip: z.string().max(20).optional().nullable(),
  notes: z.string().max(5_000).optional().nullable(),
  status: z.enum(["ACTIVE", "INACTIVE", "PROSPECT", "PENDING"]).optional(),
});

const funderNoteSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

const funderSmsSchema = z.object({
  message: z.string().trim().min(1).max(1600),
  phone: z.string().optional(),
  templateId: z.string().min(1).optional(),
});

// ── CSV import field mapping ──────────────────────────────────────────────────

type FunderImportField =
  | "name"
  | "organization"
  | "email"
  | "phone"
  | "phone2"
  | "city"
  | "state"
  | "zip"
  | "notes"
  | "tags";

const FUNDER_COLUMN_ALIASES: Record<string, FunderImportField> = {
  name: "name",
  "funder name": "name",
  "funder": "name",
  "full name": "name",
  fullname: "name",
  "contact name": "name",
  company: "organization",
  "company name": "organization",
  organization: "organization",
  organisation: "organization",
  org: "organization",
  "business name": "organization",
  email: "email",
  "email address": "email",
  "e-mail": "email",
  mail: "email",
  phone: "phone",
  phone1: "phone",
  "phone 1": "phone",
  "phone number": "phone",
  mobile: "phone",
  telephone: "phone",
  "primary phone": "phone",
  phone2: "phone2",
  "phone 2": "phone2",
  "secondary phone": "phone2",
  "alternate phone": "phone2",
  "alt phone": "phone2",
  "other phone": "phone2",
  city: "city",
  state: "state",
  zip: "zip",
  zipcode: "zip",
  "zip code": "zip",
  "postal code": "zip",
  notes: "notes",
  note: "notes",
  description: "notes",
  tags: "tags",
  tag: "tags",
  labels: "tags",
  label: "tags",
};

function autoMapFunderHeaders(headers: string[]): Record<number, FunderImportField> {
  const mapping: Record<number, FunderImportField> = {};
  for (let i = 0; i < headers.length; i++) {
    const key = headers[i].toLowerCase().trim();
    const mapped = FUNDER_COLUMN_ALIASES[key];
    if (mapped && !Object.values(mapping).includes(mapped)) {
      mapping[i] = mapped;
    }
  }
  return mapping;
}

// ── Formatter ──────────────────────────────────────────────────────────────────

function formatFunder(f: any) {
  return {
    id: f.id,
    tenantId: f.tenantId,
    name: f.name,
    organization: f.organization ?? null,
    email: f.email ?? null,
    phone: f.phone ?? null,
    phone2: f.phone2 ?? null,
    city: f.city ?? null,
    state: f.state ?? null,
    zip: f.zip ?? null,
    notes: f.notes ?? null,
    status: f.status,
    active: f.active,
    archivedAt: f.archivedAt ? new Date(f.archivedAt).toISOString() : null,
    tags: f.tagLinks?.map((tl: any) => tl.tag) ?? [],
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

function formatFunderTimelineEvent(row: any) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body ?? null,
    metadata: row.metadata ?? null,
    linkedId: row.linkedId ?? null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    createdBy: row.createdByUser
      ? {
          id: row.createdByUser.id,
          displayName: row.createdByUser.displayName || [row.createdByUser.firstName, row.createdByUser.lastName].filter(Boolean).join(" ") || row.createdByUser.email,
        }
      : null,
  };
}

async function findActiveFunder(tenantId: string, id: string) {
  return db.funder.findFirst({
    where: { id, tenantId, active: true, archivedAt: null },
    include: FUNDER_INCLUDE,
  });
}

// ── Route registrar ────────────────────────────────────────────────────────────

export async function registerCrmFunderRoutes(app: FastifyInstance, deps?: Pick<ConnectChatRoutesDeps, "smsQueue">) {
  // ── GET /crm/funders/stats ─────────────────────────────────────────────────
  app.get("/crm/funders/stats", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const activeOnly = { active: true, archivedAt: null };

    const [total, active, prospects, recentlyAdded] = await Promise.all([
      db.funder.count({ where: { tenantId, ...activeOnly } }),
      db.funder.count({ where: { tenantId, status: "ACTIVE", ...activeOnly } }),
      db.funder.count({ where: { tenantId, status: "PROSPECT", ...activeOnly } }),
      db.funder.count({ where: { tenantId, createdAt: { gte: sevenDaysAgo }, ...activeOnly } }),
    ]);

    return { total, active, prospects, recentlyAdded };
  });

  // ── GET /crm/funders ───────────────────────────────────────────────────────
  app.get("/crm/funders", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const query = z
      .object({
        q: z.string().optional(),
        status: z.enum(["ACTIVE", "INACTIVE", "PROSPECT", "PENDING", "all"]).optional(),
        tagId: z.string().optional(),
        page: z.string().transform(Number).pipe(z.number().int().min(0)).optional(),
        limit: z.string().transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
        includeArchived: z.string().optional().transform((v) => v === "true"),
      })
      .parse(req.query || {});

    const page = query.page ?? 0;
    const limit = query.limit ?? 50;
    const search = (query.q || "").trim().toLowerCase();
    const includeArchived = query.includeArchived === true;

    const archiveClause = includeArchived ? {} : { active: true, archivedAt: null };

    const searchWhere = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { organization: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
            { phone: { contains: search, mode: "insensitive" as const } },
            { city: { contains: search, mode: "insensitive" as const } },
            { state: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {};

    const statusClause =
      query.status && query.status !== "all" ? { status: query.status as any } : {};

    const tagClause = query.tagId
      ? { tagLinks: { some: { tagId: query.tagId } } }
      : {};

    const listWhere = {
      tenantId,
      ...archiveClause,
      ...statusClause,
      ...tagClause,
      ...searchWhere,
    };

    const [rows, total] = await Promise.all([
      db.funder.findMany({
        where: listWhere,
        include: FUNDER_INCLUDE,
        orderBy: { updatedAt: "desc" },
        take: limit,
        skip: page * limit,
      }),
      db.funder.count({ where: listWhere }),
    ]);

    return { rows: rows.map(formatFunder), total, page, limit };
  });

  // ── POST /crm/funders ──────────────────────────────────────────────────────
  app.post("/crm/funders", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: createdBy } = user;

    const parsed = createFunderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const data = parsed.data;
    const tagIds = data.tagIds ?? [];

    // Validate tags belong to this tenant
    if (tagIds.length > 0) {
      const validTags = await db.funderTag.findMany({
        where: { id: { in: tagIds }, tenantId },
        select: { id: true },
      });
      if (validTags.length !== tagIds.length) {
        return reply.status(400).send({ error: "invalid_tags", detail: "One or more tags not found" });
      }
    }

    const funder = await db.funder.create({
      data: {
        tenantId,
        name: data.name,
        organization: data.organization ?? null,
        email: data.email || null,
        phone: data.phone ?? null,
        phone2: data.phone2 ?? null,
        city: data.city ?? null,
        state: data.state ?? null,
        zip: data.zip ?? null,
        notes: data.notes ?? null,
        status: data.status ?? "ACTIVE",
        createdBy,
        tagLinks: tagIds.length
          ? { create: tagIds.map((tagId) => ({ tagId })) }
          : undefined,
      },
      include: FUNDER_INCLUDE,
    });

    reply.status(201).send(formatFunder(funder));
  });

  // ── GET /crm/funders/:id ───────────────────────────────────────────────────
  app.get("/crm/funders/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const funder = await db.funder.findFirst({
      where: { id, tenantId, active: true, archivedAt: null },
      include: FUNDER_INCLUDE,
    });

    if (!funder) return reply.status(404).send({ error: "not_found" });
    return formatFunder(funder);
  });

  app.get("/crm/funders/:id/timeline", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const funder = await findActiveFunder(tenantId, id);
    if (!funder) return reply.status(404).send({ error: "not_found" });

    const explicitEvents = await (db as any).funderTimelineEvent.findMany({
      where: { tenantId, funderId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        createdByUser: { select: { id: true, displayName: true, firstName: true, lastName: true, email: true } },
      },
    });

    const email = String(funder.email || "").trim().toLowerCase();
    const [sendLogs, messages] = email
      ? await Promise.all([
          db.crmEmailSendLog.findMany({
            where: { tenantId, toEmail: { equals: email, mode: "insensitive" } },
            orderBy: { sentAt: "desc" },
            take: 50,
            select: { id: true, subject: true, status: true, errorMessage: true, sentAt: true, gmailMessageId: true },
          }),
          db.crmEmailMessage.findMany({
            where: {
              tenantId,
              OR: [
                { fromEmail: { equals: email, mode: "insensitive" } },
                { toEmail: { contains: email, mode: "insensitive" } },
              ],
            },
            orderBy: { createdAt: "desc" },
            take: 50,
            select: { id: true, direction: true, subject: true, fromEmail: true, toEmail: true, previewSnippet: true, sentAt: true, receivedAt: true, createdAt: true },
          }),
        ])
      : [[], []];

    const emailEvents = [
      ...sendLogs.map((log) => ({
        id: `email-log:${log.id}`,
        type: log.status === "FAILED" ? "EMAIL_FAILED" : "EMAIL_SENT",
        title: log.status === "FAILED" ? "Email failed" : "Email sent",
        body: log.subject || log.errorMessage || null,
        metadata: { toEmail: email, gmailMessageId: log.gmailMessageId, status: log.status },
        linkedId: log.id,
        createdAt: log.sentAt.toISOString(),
        createdBy: null,
      })),
      ...messages.map((message) => ({
        id: `email-message:${message.id}`,
        type: message.direction === "INBOUND" ? "EMAIL_RECEIVED" : "EMAIL_SENT",
        title: message.direction === "INBOUND" ? "Email received" : "Email sent",
        body: message.previewSnippet || message.subject || null,
        metadata: { fromEmail: message.fromEmail, toEmail: message.toEmail, subject: message.subject },
        linkedId: message.id,
        createdAt: (message.receivedAt || message.sentAt || message.createdAt).toISOString(),
        createdBy: null,
      })),
    ];

    const events = [
      ...explicitEvents.map(formatFunderTimelineEvent),
      ...emailEvents,
    ].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()).slice(0, 150);

    return { funderId: id, events };
  });

  app.post("/crm/funders/:id/notes", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };
    const parsed = funderNoteSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });

    const funder = await findActiveFunder(tenantId, id);
    if (!funder) return reply.status(404).send({ error: "not_found" });

    const event = await (db as any).funderTimelineEvent.create({
      data: {
        tenantId,
        funderId: id,
        type: "NOTE_ADDED",
        title: "Note added",
        body: parsed.data.body,
        createdByUserId: user.sub,
      },
      include: {
        createdByUser: { select: { id: true, displayName: true, firstName: true, lastName: true, email: true } },
      },
    });
    return { event: formatFunderTimelineEvent(event) };
  });

  app.post("/crm/funders/:id/sms", async (req, reply) => {
    if (!deps?.smsQueue) return reply.code(503).send({ error: "sms_queue_unavailable" });
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const chatUser = user as JwtUser;
    if (!(await canSendSmsUser(chatUser))) return reply.code(403).send({ error: "FORBIDDEN" });

    const { tenantId } = user;
    const { id } = req.params as { id: string };
    const parsed = funderSmsSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });

    const funder = await findActiveFunder(tenantId, id);
    if (!funder) return reply.status(404).send({ error: "not_found" });
    const targetPhone = (parsed.data.phone || funder.phone || "").trim();
    if (!targetPhone) return reply.status(400).send({ error: "no_phone", detail: "Funder has no phone number" });

    const selectedTemplate = parsed.data.templateId
      ? await (db as any).crmSmsTemplate.findFirst({
          where: {
            id: parsed.data.templateId,
            tenantId,
            isArchived: false,
            OR: [{ visibility: "SHARED" }, { visibility: "PRIVATE", createdByUserId: user.sub }],
          },
          select: { id: true },
        })
      : null;
    if (parsed.data.templateId && !selectedTemplate) {
      return reply.code(404).send({ error: "template_not_found", detail: "Selected SMS template is no longer available" });
    }

    const threadResult = await findOrCreateConnectChatSmsThread({
      tenantId,
      userId: user.sub,
      externalPhone: targetPhone,
      title: `Funder SMS ${funder.name}`,
    });
    if (!threadResult.ok) return reply.code(threadResult.status).send({ error: threadResult.error, detail: threadResult.message });

    const sendResult = await sendConnectChatSmsMessage({
      deps,
      user: chatUser,
      tenantId,
      threadId: threadResult.threadId,
      body: parsed.data.message,
      type: "TEXT",
    });
    if (!sendResult.ok) return reply.code(sendResult.status).send({ error: sendResult.error, detail: sendResult.message });

    await (db as any).funderTimelineEvent.create({
      data: {
        tenantId,
        funderId: id,
        type: "SMS_SENT",
        title: "SMS sent",
        body: parsed.data.message.substring(0, 500),
        metadata: {
          to: targetPhone,
          from: threadResult.fromNumber,
          threadId: threadResult.threadId,
          connectChatMessageId: sendResult.messageId,
          ...(selectedTemplate ? { smsTemplateId: selectedTemplate.id } : {}),
        },
        linkedId: sendResult.messageId,
        createdByUserId: user.sub,
      },
    });

    if (selectedTemplate) {
      await (db as any).crmSmsTemplate.update({
        where: { id: selectedTemplate.id },
        data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
      }).catch(() => undefined);
    }

    return {
      ok: true,
      threadId: threadResult.threadId,
      messageId: sendResult.messageId,
      to: targetPhone,
      from: threadResult.fromNumber,
      deliveryStatus: sendResult.deliveryStatus,
    };
  });

  // ── PATCH /crm/funders/:id ─────────────────────────────────────────────────
  app.patch("/crm/funders/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const parsed = patchFunderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const existing = await db.funder.findFirst({
      where: { id, tenantId, active: true },
      select: { id: true },
    });
    if (!existing) return reply.status(404).send({ error: "not_found" });

    const data = parsed.data;
    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if ("organization" in data) updateData.organization = data.organization ?? null;
    if ("email" in data) updateData.email = data.email || null;
    if ("phone" in data) updateData.phone = data.phone ?? null;
    if ("phone2" in data) updateData.phone2 = data.phone2 ?? null;
    if ("city" in data) updateData.city = data.city ?? null;
    if ("state" in data) updateData.state = data.state ?? null;
    if ("zip" in data) updateData.zip = data.zip ?? null;
    if ("notes" in data) updateData.notes = data.notes ?? null;
    if (data.status !== undefined) updateData.status = data.status;

    await db.funder.update({ where: { id }, data: updateData });

    const updated = await db.funder.findFirst({
      where: { id, tenantId },
      include: FUNDER_INCLUDE,
    });
    return formatFunder(updated);
  });

  // ── DELETE /crm/funders/:id — soft-delete (CRM access) ───────────────────────
  app.delete("/crm/funders/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const row = await db.funder.findFirst({
      where: { id, tenantId },
      select: { id: true, active: true, archivedAt: true },
    });
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (!row.active || row.archivedAt) return { ok: true, funderId: id };

    await db.funder.update({
      where: { id },
      data: { active: false, archivedAt: new Date() },
    });
    return { ok: true, funderId: id };
  });

  // ── POST /crm/funders/:id/restore (CRM manager+) ───────────────────────────
  app.post("/crm/funders/:id/restore", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const row = await db.funder.findFirst({
      where: { id, tenantId },
      select: { id: true, active: true, archivedAt: true },
    });
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (row.active && !row.archivedAt) return { ok: true, funderId: id };

    await db.funder.update({ where: { id }, data: { active: true, archivedAt: null } });
    return { ok: true, funderId: id };
  });

  // ── GET /crm/funder-tags ───────────────────────────────────────────────────
  app.get("/crm/funder-tags", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const tags = await db.funderTag.findMany({
      where: { tenantId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true, createdAt: true },
    });
    return { tags };
  });

  // ── POST /crm/funder-tags ──────────────────────────────────────────────────
  app.post("/crm/funder-tags", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const schema = z.object({
      name: z.string().min(1).max(80).trim(),
      color: z.string().max(20).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const existing = await db.funderTag.findUnique({
      where: { tenantId_name: { tenantId, name: parsed.data.name } },
      select: { id: true },
    });
    if (existing) return reply.status(409).send({ error: "tag_exists", tagId: existing.id });

    const tag = await db.funderTag.create({
      data: { tenantId, name: parsed.data.name, color: parsed.data.color ?? null },
    });
    reply.status(201).send(tag);
  });

  // ── DELETE /crm/funder-tags/:tagId ────────────────────────────────────────
  app.delete("/crm/funder-tags/:tagId", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { tagId } = req.params as { tagId: string };

    const tag = await db.funderTag.findFirst({ where: { id: tagId, tenantId }, select: { id: true } });
    if (!tag) return reply.status(404).send({ error: "not_found" });

    await db.funderTag.delete({ where: { id: tagId } });
    return { ok: true };
  });

  // ── POST /crm/funders/:id/tags ─────────────────────────────────────────────
  app.post("/crm/funders/:id/tags", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const schema = z.object({ tagId: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const funder = await db.funder.findFirst({ where: { id, tenantId, active: true }, select: { id: true } });
    if (!funder) return reply.status(404).send({ error: "not_found" });

    const tag = await db.funderTag.findFirst({ where: { id: parsed.data.tagId, tenantId }, select: { id: true } });
    if (!tag) return reply.status(404).send({ error: "tag_not_found" });

    await db.funderTagAssignment.upsert({
      where: { funderId_tagId: { funderId: id, tagId: parsed.data.tagId } },
      create: { funderId: id, tagId: parsed.data.tagId },
      update: {},
    });

    const updated = await db.funder.findFirst({ where: { id, tenantId }, include: FUNDER_INCLUDE });
    return formatFunder(updated);
  });

  // ── DELETE /crm/funders/:id/tags/:tagId ───────────────────────────────────
  app.delete("/crm/funders/:id/tags/:tagId", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id, tagId } = req.params as { id: string; tagId: string };

    const funder = await db.funder.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!funder) return reply.status(404).send({ error: "not_found" });

    await db.funderTagAssignment.deleteMany({ where: { funderId: id, tagId } });
    return { ok: true };
  });

  // ── POST /crm/funders/bulk-tag ─────────────────────────────────────────────
  // Admin-only. Assign or remove a tag from multiple funders at once.
  app.post("/crm/funders/bulk-tag", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const schema = z.object({
      funderIds: z.array(z.string().min(1)).min(1).max(500),
      tagId: z.string().min(1),
      action: z.enum(["assign", "remove"]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const { funderIds, tagId, action } = parsed.data;

    const tag = await db.funderTag.findFirst({ where: { id: tagId, tenantId }, select: { id: true } });
    if (!tag) return reply.status(404).send({ error: "tag_not_found" });

    // Verify all funders belong to tenant
    const validFunders = await db.funder.findMany({
      where: { id: { in: funderIds }, tenantId },
      select: { id: true },
    });
    const validIds = validFunders.map((f) => f.id);

    if (action === "assign") {
      await db.funderTagAssignment.createMany({
        data: validIds.map((funderId) => ({ funderId, tagId })),
        skipDuplicates: true,
      });
    } else {
      await db.funderTagAssignment.deleteMany({
        where: { funderId: { in: validIds }, tagId },
      });
    }

    return { ok: true, affected: validIds.length };
  });

  // ── GET /crm/funders/export ────────────────────────────────────────────────
  // Export funders as CSV. Respects same filters as list endpoint.
  app.get("/crm/funders/export", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const query = z
      .object({
        q: z.string().optional(),
        status: z.enum(["ACTIVE", "INACTIVE", "PROSPECT", "PENDING", "all"]).optional(),
        tagId: z.string().optional(),
        ids: z.string().optional(), // comma-separated list of ids for selected export
      })
      .parse(req.query || {});

    const search = (query.q || "").trim().toLowerCase();

    const searchWhere = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { organization: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {};

    const statusClause =
      query.status && query.status !== "all" ? { status: query.status as any } : {};

    const tagClause = query.tagId ? { tagLinks: { some: { tagId: query.tagId } } } : {};
    const idClause = query.ids ? { id: { in: query.ids.split(",").map((s) => s.trim()) } } : {};

    const rows = await db.funder.findMany({
      where: {
        tenantId,
        active: true,
        archivedAt: null,
        ...statusClause,
        ...tagClause,
        ...idClause,
        ...searchWhere,
      },
      include: FUNDER_INCLUDE,
      orderBy: { name: "asc" },
      take: 10_000,
    });

    const header = ["name", "organization", "email", "phone", "phone2", "city", "state", "zip", "tags", "status", "notes"];
    const csvRows = [
      header.join(","),
      ...rows.map((f) => {
        const tags = f.tagLinks?.map((tl: any) => tl.tag.name).join("|") ?? "";
        return [
          csvField(f.name),
          csvField(f.organization ?? ""),
          csvField(f.email ?? ""),
          csvField(f.phone ?? ""),
          csvField(f.phone2 ?? ""),
          csvField(f.city ?? ""),
          csvField(f.state ?? ""),
          csvField(f.zip ?? ""),
          csvField(tags),
          csvField(f.status),
          csvField(f.notes ?? ""),
        ].join(",");
      }),
    ];

    reply
      .header("Content-Type", "text/csv")
      .header("Content-Disposition", `attachment; filename="funders-${Date.now()}.csv"`)
      .send(csvRows.join("\n"));
  });

  // ── POST /crm/funders/import/preview ──────────────────────────────────────
  app.post("/crm/funders/import/preview", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;

    const body = req.body as { csvText?: string };
    if (!body?.csvText || typeof body.csvText !== "string") {
      return reply.status(400).send({ error: "csv_required" });
    }
    if (Buffer.byteLength(body.csvText, "utf8") > FUNDER_IMPORT_MAX_FILE_BYTES) {
      return reply.status(400).send({ error: "file_too_large" });
    }

    const rows = parseCsv(body.csvText);
    if (rows.length < 2) {
      return reply.status(400).send({ error: "empty_file" });
    }

    const [headerRow, ...dataRows] = rows;
    const mapping = autoMapFunderHeaders(headerRow);
    const fieldNames: string[] = headerRow.map((h, i) => mapping[i] ?? null as any);
    const preview = dataRows.slice(0, 5).map((row) => {
      const obj: Record<string, string> = {};
      for (const [colStr, field] of Object.entries(mapping)) {
        const col = Number(colStr);
        obj[field] = row[col] ?? "";
      }
      return obj;
    });

    return {
      headers: headerRow,
      mapping,
      fieldNames,
      totalDataRows: dataRows.length,
      preview,
    };
  });

  // ── POST /crm/funders/import/execute ──────────────────────────────────────
  app.post("/crm/funders/import/execute", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: createdBy } = user;

    const schema = z.object({
      csvText: z.string().min(1),
      fileName: z.string().max(200).default("import.csv"),
      mapping: z.record(z.string(), z.string()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const { csvText, fileName } = parsed.data;

    if (Buffer.byteLength(csvText, "utf8") > FUNDER_IMPORT_MAX_FILE_BYTES) {
      return reply.status(400).send({ error: "file_too_large" });
    }

    const rows = parseCsv(csvText);
    if (rows.length < 2) {
      return reply.status(400).send({ error: "empty_file" });
    }

    const [headerRow, ...dataRows] = rows;

    let colMapping: Record<number, FunderImportField>;
    if (parsed.data.mapping && Object.keys(parsed.data.mapping).length > 0) {
      colMapping = {};
      for (const [k, v] of Object.entries(parsed.data.mapping)) {
        colMapping[Number(k)] = v as FunderImportField;
      }
    } else {
      colMapping = autoMapFunderHeaders(headerRow);
    }

    if (dataRows.length > FUNDER_IMPORT_MAX_ROWS) {
      return reply.status(400).send({ error: "too_many_rows", max: FUNDER_IMPORT_MAX_ROWS });
    }

    // Create import batch record
    const batch = await db.funderImportBatch.create({
      data: {
        tenantId,
        fileName,
        status: "PROCESSING",
        totalRows: dataRows.length,
        mapping: colMapping as any,
        createdBy,
      },
    });

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors: Array<{ row: number; reason: string }> = [];

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      try {
        const rowData: Record<string, string> = {};
        for (const [colStr, field] of Object.entries(colMapping)) {
          const col = Number(colStr);
          rowData[field] = (row[col] ?? "").trim();
        }

        const name = rowData.name || "";
        if (!name) {
          skippedCount++;
          errors.push({ row: i + 2, reason: "Missing name" });
          continue;
        }

        const email = rowData.email || null;
        const phone = rowData.phone || null;

        // Deduplicate: check by email first, then by phone
        let existing: { id: string } | null = null;
        if (email) {
          existing = await db.funder.findFirst({
            where: { tenantId, email: { equals: email, mode: "insensitive" } },
            select: { id: true },
          });
        }
        if (!existing && phone) {
          const normalizedPhone = phone.replace(/\D/g, "");
          existing = await db.funder.findFirst({
            where: { tenantId, phone: { contains: normalizedPhone.slice(-10) } },
            select: { id: true },
          });
        }

        // Handle tags from CSV — find or create tag by name
        const tagNames = (rowData.tags ?? "")
          .split("|")
          .map((t) => t.trim())
          .filter(Boolean);

        const tagIds: string[] = [];
        for (const tagName of tagNames) {
          const tag = await db.funderTag.upsert({
            where: { tenantId_name: { tenantId, name: tagName } },
            create: { tenantId, name: tagName },
            update: {},
          });
          tagIds.push(tag.id);
        }

        if (existing) {
          // Update existing funder — preserve existing tags, add new ones
          await db.funder.update({
            where: { id: existing.id },
            data: {
              organization: rowData.organization || undefined,
              phone: phone ?? undefined,
              phone2: rowData.phone2 || undefined,
              city: rowData.city || undefined,
              state: rowData.state || undefined,
              zip: rowData.zip || undefined,
              notes: rowData.notes || undefined,
            },
          });
          if (tagIds.length > 0) {
            await db.funderTagAssignment.createMany({
              data: tagIds.map((tagId) => ({ funderId: existing!.id, tagId })),
              skipDuplicates: true,
            });
          }
          updatedCount++;
        } else {
          const funder = await db.funder.create({
            data: {
              tenantId,
              name,
              organization: rowData.organization || null,
              email,
              phone,
              phone2: rowData.phone2 || null,
              city: rowData.city || null,
              state: rowData.state || null,
              zip: rowData.zip || null,
              notes: rowData.notes || null,
              createdBy,
            },
          });
          if (tagIds.length > 0) {
            await db.funderTagAssignment.createMany({
              data: tagIds.map((tagId) => ({ funderId: funder.id, tagId })),
              skipDuplicates: true,
            });
          }
          createdCount++;
        }
      } catch (err: any) {
        errorCount++;
        if (errors.length < 50) {
          errors.push({ row: i + 2, reason: err?.message ?? "Unknown error" });
        }
      }
    }

    const finalStatus =
      errorCount === dataRows.length
        ? "FAILED"
        : errorCount > 0 || skippedCount > 0
          ? "PARTIAL"
          : "DONE";

    await db.funderImportBatch.update({
      where: { id: batch.id },
      data: {
        status: finalStatus,
        createdCount,
        updatedCount,
        skippedCount,
        errorCount,
        errors: errors as any,
      },
    });

    return reply.status(201).send({
      batchId: batch.id,
      status: finalStatus,
      totalRows: dataRows.length,
      createdCount,
      updatedCount,
      skippedCount,
      errorCount,
      errors: errors.slice(0, 50),
    });
  });

  // ── GET /crm/funders/import/batches ───────────────────────────────────────
  app.get("/crm/funders/import/batches", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const batches = await db.funderImportBatch.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        fileName: true,
        status: true,
        totalRows: true,
        createdCount: true,
        updatedCount: true,
        skippedCount: true,
        errorCount: true,
        createdAt: true,
      },
    });
    return { batches };
  });
}

// ── CSV helper ────────────────────────────────────────────────────────────────

function csvField(value: string): string {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
