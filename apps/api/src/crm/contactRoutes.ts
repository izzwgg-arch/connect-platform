import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { requireCrmAccess, requireCrmAdmin, isAdminRole } from "./guard";
import { writeTimelineEvent } from "./timelineHelper";

// ── Shared include for contact queries ────────────────────────────────────────

const CONTACT_WITH_CRM_INCLUDE = {
  phones: { orderBy: { isPrimary: "desc" as const } },
  emails: { orderBy: { isPrimary: "desc" as const } },
  addresses: true,
  tagLinks: { include: { tag: true } },
  crmMeta: {
    include: {
      assignedTo: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          displayName: true,
          email: true,
        },
      },
    },
  },
} as const;

// ── Input schemas ─────────────────────────────────────────────────────────────

const phoneSchema = z.object({
  type: z.enum(["MOBILE", "OFFICE", "HOME", "OTHER"]).default("MOBILE"),
  numberRaw: z.string().min(1),
  isPrimary: z.boolean().default(false),
});

const emailSchema = z.object({
  type: z.enum(["WORK", "PERSONAL", "OTHER"]).default("WORK"),
  email: z.string().email(),
  isPrimary: z.boolean().default(false),
});

const createContactSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  displayName: z.string().min(1),
  company: z.string().optional(),
  title: z.string().optional(),
  notes: z.string().optional(),
  phones: z.array(phoneSchema).default([]),
  emails: z.array(emailSchema).default([]),
  // CRM overlay
  stage: z.enum(["LEAD", "CONTACTED", "QUALIFIED", "CUSTOMER", "CLOSED_LOST"]).default("LEAD"),
  assignedToUserId: z.string().optional(),
  doNotCall: z.boolean().default(false),
  doNotSms: z.boolean().default(false),
});

const patchContactSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  displayName: z.string().min(1).optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  notes: z.string().optional(),
  // CRM overlay
  stage: z.enum(["LEAD", "CONTACTED", "QUALIFIED", "CUSTOMER", "CLOSED_LOST"]).optional(),
  assignedToUserId: z.string().nullable().optional(),
  doNotCall: z.boolean().optional(),
  doNotSms: z.boolean().optional(),
});

// ── Normalise phone helper ─────────────────────────────────────────────────────

function normalisePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

// ── Route registrar ───────────────────────────────────────────────────────────

export async function registerCrmContactRoutes(app: FastifyInstance) {
  // ── GET /crm/contacts/stats ────────────────────────────────────────────────
  // Dashboard counts. Registered BEFORE /:id to avoid param capture.
  app.get("/crm/contacts/stats", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const activeContactOnly = { contact: { is: { active: true, archivedAt: null } } };

    const [total, leads, mine, recentlyAdded] = await Promise.all([
      db.crmContactMeta.count({ where: { tenantId, ...activeContactOnly } }),
      db.crmContactMeta.count({ where: { tenantId, stage: "LEAD", ...activeContactOnly } }),
      db.crmContactMeta.count({
        where: { tenantId, assignedToUserId: userId, ...activeContactOnly },
      }),
      db.crmContactMeta.count({
        where: { tenantId, createdAt: { gte: sevenDaysAgo }, ...activeContactOnly },
      }),
    ]);

    return { total, leads, mine, recentlyAdded };
  });

  // ── GET /crm/contacts/lookup?phone= ───────────────────────────────────────
  // Phone-number lookup for screen pop. Searches all contacts in tenant (not
  // just CRM-enrolled ones) so the caller can be identified even without a CRM row.
  app.get("/crm/contacts/lookup", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const q = z.object({ phone: z.string().min(4) }).safeParse(req.query);
    if (!q.success) return reply.status(400).send({ error: "phone_required" });

    const normalized = normalisePhone(q.data.phone);
    const partial = normalized.slice(-10); // match on last 10 digits

    const phones = await db.contactPhone.findMany({
      where: {
        contact: { tenantId, active: true, archivedAt: null },
        OR: [
          { numberNormalized: { endsWith: partial } },
          { numberNormalized: { contains: partial } },
        ],
      },
      include: {
        contact: {
          include: CONTACT_WITH_CRM_INCLUDE,
        },
      },
      take: 5,
    });

    // Enrich each result with task stats (open count + nearest due task).
    // At most 5 results × 2 small queries each — acceptable for screen-pop frequency.
    const enriched = await Promise.all(
      phones.map(async (p) => {
        const contactId = p.contact.id;
        const [openTasksCount, nextTask] = await Promise.all([
          db.crmContactTask.count({
            where: { contactId, tenantId, status: { in: ["OPEN", "IN_PROGRESS"] } },
          }),
          db.crmContactTask.findFirst({
            where: { contactId, tenantId, status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { not: null } },
            orderBy: { dueAt: "asc" },
            select: { title: true, dueAt: true },
          }),
        ]);
        return {
          matchedPhone: p.numberRaw,
          contact: formatContact(p.contact as any),
          openTasksCount,
          nextDueTask: nextTask
            ? { title: nextTask.title, dueAt: nextTask.dueAt?.toISOString() ?? null }
            : null,
        };
      }),
    );

    return { results: enriched };
  });

  // ── GET /crm/contacts ──────────────────────────────────────────────────────
  app.get("/crm/contacts", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;

    const query = z
      .object({
        q: z.string().optional(),
        stage: z
          .enum(["LEAD", "CONTACTED", "QUALIFIED", "CUSTOMER", "CLOSED_LOST", "all"])
          .optional(),
        assignedToMe: z
          .string()
          .transform((v) => v === "true")
          .optional(),
        page: z
          .string()
          .transform(Number)
          .pipe(z.number().int().min(0))
          .optional(),
        limit: z
          .string()
          .transform(Number)
          .pipe(z.number().int().min(1).max(100))
          .optional(),
        includeArchived: z
          .string()
          .optional()
          .transform((v) => v === "true"),
      })
      .parse(req.query || {});

    const page = query.page ?? 0;
    const limit = query.limit ?? 50;
    const search = (query.q || "").trim().toLowerCase();
    const includeArchived = query.includeArchived === true;

    if (includeArchived && !isAdminRole(user.role)) {
      return reply.status(403).send({
        error: "crm_permission_denied",
        detail: "includeArchived requires CRM admin",
      });
    }

    // Resolve combined stage+assignment filter on crmMeta without conflicting keys
    const baseCrmMetaFilter = {
      tenantId,
      ...(query.stage && query.stage !== "all" ? { stage: query.stage as any } : {}),
      ...(query.assignedToMe ? { assignedToUserId: userId } : {}),
    };

    const archiveClause = includeArchived ? {} : { active: true, archivedAt: null };

    const searchWhere = search
      ? {
          OR: [
            { displayName: { contains: search, mode: "insensitive" } },
            { firstName: { contains: search, mode: "insensitive" } },
            { lastName: { contains: search, mode: "insensitive" } },
            { company: { contains: search, mode: "insensitive" } },
            {
              phones: {
                some: {
                  OR: [
                    { numberRaw: { contains: search, mode: "insensitive" } },
                    { numberNormalized: { contains: search, mode: "insensitive" } },
                  ],
                },
              },
            },
            {
              emails: {
                some: { email: { contains: search, mode: "insensitive" } },
              },
            },
          ],
        }
      : {};

    const listWhere = {
      tenantId,
      ...archiveClause,
      crmMeta: { is: baseCrmMetaFilter },
      ...searchWhere,
    };

    const [rows, total] = await Promise.all([
      (db as any).contact.findMany({
        where: listWhere,
        include: CONTACT_WITH_CRM_INCLUDE,
        orderBy: { updatedAt: "desc" },
        take: limit,
        skip: page * limit,
      }),
      (db as any).contact.count({ where: listWhere }),
    ]);

    return {
      rows: rows.map(formatContact),
      total,
      page,
      limit,
    };
  });

  // ── POST /crm/contacts ────────────────────────────────────────────────────
  app.post("/crm/contacts", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: createdBy } = user;

    const parsed = createContactSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const data = parsed.data;

    // Validate assignedToUserId belongs to same tenant
    if (data.assignedToUserId) {
      const target = await db.user.findFirst({
        where: { id: data.assignedToUserId, tenantId },
        select: { id: true },
      });
      if (!target) {
        return reply
          .status(400)
          .send({ error: "invalid_assigned_user", detail: "User not found in tenant" });
      }
    }

    // Create Contact + CrmContactMeta atomically via Prisma nested write
    const contact = await (db as any).contact.create({
      data: {
        tenantId,
        type: "EXTERNAL",
        source: "MANUAL",
        displayName: data.displayName,
        firstName: data.firstName ?? null,
        lastName: data.lastName ?? null,
        company: data.company ?? null,
        title: data.title ?? null,
        notes: data.notes ?? null,
        createdBy,
        phones: {
          create: data.phones.map((p, i) => ({
            type: p.type,
            numberRaw: p.numberRaw,
            numberNormalized: normalisePhone(p.numberRaw),
            isPrimary: p.isPrimary || i === 0,
          })),
        },
        emails: {
          create: data.emails.map((e, i) => ({
            type: e.type,
            email: e.email.toLowerCase(),
            isPrimary: e.isPrimary || i === 0,
          })),
        },
        crmMeta: {
          create: {
            tenantId,
            stage: data.stage,
            assignedToUserId: data.assignedToUserId ?? null,
            doNotCall: data.doNotCall,
            doNotSms: data.doNotSms,
          },
        },
      },
      include: CONTACT_WITH_CRM_INCLUDE,
    });

    // Write CONTACT_CREATED timeline event — non-throwing
    await writeTimelineEvent({
      tenantId,
      contactId: contact.id,
      type: "CONTACT_CREATED",
      title: "Contact created",
      createdByUserId: createdBy,
    });

    reply.status(201).send(formatContact(contact));
  });

  // ── GET /crm/contacts/:id ─────────────────────────────────────────────────
  app.get("/crm/contacts/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, role } = user;
    const { id } = req.params as { id: string };

    const where = isAdminRole(role)
      ? { id, tenantId }
      : { id, tenantId, active: true, archivedAt: null };

    const contact = await (db as any).contact.findFirst({
      where,
      include: CONTACT_WITH_CRM_INCLUDE,
    });

    if (!contact) return reply.status(404).send({ error: "not_found" });
    return formatContact(contact);
  });

  // ── DELETE /crm/contacts/:id — soft-archive (CRM admin) ────────────────────
  app.delete("/crm/contacts/:id", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const row = await (db as any).contact.findFirst({
      where: { id, tenantId },
      select: { id: true, active: true, archivedAt: true },
    });
    if (!row) return reply.status(404).send({ error: "not_found" });

    if (!row.active || row.archivedAt) {
      return { ok: true, contactId: id };
    }

    await (db as any).contact.update({
      where: { id },
      data: { active: false, archivedAt: new Date() },
    });
    return { ok: true, contactId: id };
  });

  // ── POST /crm/contacts/:id/restore — undo soft-archive (CRM admin) ──────────
  app.post("/crm/contacts/:id/restore", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const row = await (db as any).contact.findFirst({
      where: { id, tenantId },
      select: { id: true, active: true, archivedAt: true },
    });
    if (!row) return reply.status(404).send({ error: "not_found" });

    if (row.active && !row.archivedAt) {
      return { ok: true, contactId: id };
    }

    await (db as any).contact.update({
      where: { id },
      data: { active: true, archivedAt: null },
    });
    return { ok: true, contactId: id };
  });

  // ── PATCH /crm/contacts/:id ───────────────────────────────────────────────
  app.patch("/crm/contacts/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const parsed = patchContactSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    // Ensure contact exists and belongs to tenant; load current stage + assignedToUserId for timeline diff
    const existing = await (db as any).contact.findFirst({
      where: { id, tenantId, active: true },
      select: { id: true, crmMeta: { select: { stage: true, assignedToUserId: true } } },
    });
    if (!existing) return reply.status(404).send({ error: "not_found" });

    const data = parsed.data;

    // Validate assignedToUserId
    if (data.assignedToUserId) {
      const target = await db.user.findFirst({
        where: { id: data.assignedToUserId, tenantId },
        select: { id: true },
      });
      if (!target) {
        return reply
          .status(400)
          .send({ error: "invalid_assigned_user", detail: "User not found in tenant" });
      }
    }

    // Split fields: core Contact vs CRM overlay
    const contactUpdate: Record<string, unknown> = {};
    if (data.firstName !== undefined) contactUpdate.firstName = data.firstName;
    if (data.lastName !== undefined) contactUpdate.lastName = data.lastName;
    if (data.displayName !== undefined) contactUpdate.displayName = data.displayName;
    if (data.company !== undefined) contactUpdate.company = data.company;
    if (data.title !== undefined) contactUpdate.title = data.title;
    if (data.notes !== undefined) contactUpdate.notes = data.notes;

    const metaUpdate: Record<string, unknown> = {};
    if (data.stage !== undefined) metaUpdate.stage = data.stage;
    if ("assignedToUserId" in data) metaUpdate.assignedToUserId = data.assignedToUserId ?? null;
    if (data.doNotCall !== undefined) metaUpdate.doNotCall = data.doNotCall;
    if (data.doNotSms !== undefined) metaUpdate.doNotSms = data.doNotSms;

    // Determine if stage or assignedToUserId is actually changing
    const currentStage: string | null = existing.crmMeta?.stage ?? null;
    const stageChanged =
      data.stage !== undefined && data.stage !== currentStage;

    const currentAssignedUserId: string | null = existing.crmMeta?.assignedToUserId ?? null;
    const assignedChanged =
      "assignedToUserId" in data &&
      (data.assignedToUserId ?? null) !== currentAssignedUserId;

    // Run both updates; upsert crmMeta in case it doesn't exist yet
    await Promise.all([
      Object.keys(contactUpdate).length > 0
        ? (db as any).contact.update({ where: { id }, data: contactUpdate })
        : Promise.resolve(),
      Object.keys(metaUpdate).length > 0
        ? (db as any).crmContactMeta.upsert({
            where: { contactId: id },
            create: { contactId: id, tenantId, ...metaUpdate },
            update: metaUpdate,
          })
        : Promise.resolve(),
    ]);

    // Write STAGE_CHANGED timeline event — only when stage actually changed
    if (stageChanged) {
      const { sub: changedByUserId } = user;
      await writeTimelineEvent({
        tenantId,
        contactId: id,
        type: "STAGE_CHANGED",
        title: `Stage changed: ${currentStage ?? "—"} → ${data.stage}`,
        metadata: { from: currentStage, to: data.stage },
        createdByUserId: changedByUserId,
      });
    }

    // Write ASSIGNED_TO_USER timeline event — only for individual assignment changes (not bulk)
    if (assignedChanged) {
      const { sub: changedByUserId } = user;
      const newAssigneeId = data.assignedToUserId ?? null;
      // Resolve display names for metadata — non-blocking; errors won't surface to caller
      Promise.all([
        currentAssignedUserId
          ? db.user.findFirst({
              where: { id: currentAssignedUserId },
              select: { displayName: true, firstName: true, lastName: true, email: true },
            })
          : Promise.resolve(null),
        newAssigneeId
          ? db.user.findFirst({
              where: { id: newAssigneeId },
              select: { displayName: true, firstName: true, lastName: true, email: true },
            })
          : Promise.resolve(null),
      ])
        .then(([oldUser, newUser]) => {
          const nameOf = (u: { displayName?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null } | null): string =>
            u
              ? u.displayName ||
                [u.firstName, u.lastName].filter(Boolean).join(" ") ||
                u.email ||
                "?"
              : "—";
          return writeTimelineEvent({
            tenantId,
            contactId: id,
            type: "ASSIGNED_TO_USER",
            title: newAssigneeId ? `Assigned to ${nameOf(newUser)}` : "Assignment cleared",
            metadata: {
              fromUserId: currentAssignedUserId,
              toUserId: newAssigneeId,
              fromName: nameOf(oldUser),
              toName: nameOf(newUser),
            },
            createdByUserId: changedByUserId,
          });
        })
        .catch(() => {});
    }

    const updated = await (db as any).contact.findFirst({
      where: { id, tenantId },
      include: CONTACT_WITH_CRM_INCLUDE,
    });
    return formatContact(updated);
  });

  // ── POST /crm/contacts/:id/disposition ────────────────────────────────────
  // Save call outcome: updates CrmContactMeta, optionally creates note + task,
  // optionally advances stage. Writes DISPOSITION_SET timeline event.
  // Non-blocking timeline writes so this never throws on event write failures.
  app.post("/crm/contacts/:id/disposition", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;
    const { id: contactId } = req.params as { id: string };

    const dispositionSchema = z.object({
      disposition: z.string().min(1).max(100),
      note: z.string().max(5_000).optional(),
      linkedId: z.string().optional(),
      followUpAt: z.string().datetime({ offset: true }).optional().nullable(),
      nextStage: z.enum(["LEAD", "CONTACTED", "QUALIFIED", "CUSTOMER", "CLOSED_LOST"]).optional().nullable(),
      // Campaign queue integration — if provided and disposition maps to CALLBACK + followUpAt,
      // also sets callbackAt on the campaign member (non-blocking)
      memberId: z.string().optional(),
    });

    const parsed = dispositionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", issues: parsed.error.issues });
    }

    const { disposition, note, linkedId, followUpAt, nextStage, memberId } = parsed.data;
    const now = new Date();

    // Load contact + current stage — verify tenant ownership
    const contact = await (db as any).contact.findFirst({
      where: { id: contactId, tenantId, active: true },
      select: { id: true, displayName: true, crmMeta: { select: { id: true, stage: true } } },
    });
    if (!contact) return reply.status(404).send({ error: "not_found" });
    if (!contact.crmMeta) return reply.status(400).send({ error: "contact_not_in_crm" });

    const currentStage: string = contact.crmMeta.stage;
    const stageChanging = nextStage && nextStage !== currentStage;

    // ── Transactional mutations ──────────────────────────────────────────────
    // Update CrmContactMeta + optionally create CrmContactNote + CrmContactTask,
    // all inside a single async transaction. Uses the callback form so the note
    // and task operations are conditional without passing nulls in the array form.
    const { noteRow, taskRow } = await (db as any).$transaction(async (tx: any) => {
      await tx.crmContactMeta.update({
        where: { contactId },
        data: {
          lastDisposition: disposition,
          lastDispositionAt: now,
          lastActivityAt: now,
          ...(stageChanging ? { stage: nextStage } : {}),
        },
      });

      let noteResult: any = null;
      if (note?.trim()) {
        noteResult = await tx.crmContactNote.create({
          data: {
            tenantId,
            contactId,
            body: note.trim(),
            createdByUserId: userId,
          },
        });
      }

      let taskResult: any = null;
      if (followUpAt) {
        taskResult = await tx.crmContactTask.create({
          data: {
            tenantId,
            contactId,
            title: `Follow up — ${disposition}`,
            body: note?.trim() ?? null,
            dueAt: new Date(followUpAt),
            assignedToUserId: userId,
            priority: "MEDIUM",
            status: "OPEN",
            createdByUserId: userId,
          },
        });
      }

      return { noteRow: noteResult, taskRow: taskResult };
    });

    // ── Non-blocking timeline writes ─────────────────────────────────────────
    // STAGE_CHANGED (only if stage actually changed)
    if (stageChanging) {
      writeTimelineEvent({
        tenantId,
        contactId,
        type: "STAGE_CHANGED",
        title: `Stage changed: ${currentStage} → ${nextStage}`,
        body: `Disposition: ${disposition}`,
        metadata: { from: currentStage, to: nextStage, triggeredBy: "disposition" },
        createdByUserId: userId,
      });
    }

    // DISPOSITION_SET
    writeTimelineEvent({
      tenantId,
      contactId,
      type: "DISPOSITION_SET",
      title: `Disposition: ${disposition}`,
      body: note?.trim() ?? null,
      metadata: {
        disposition,
        linkedId: linkedId ?? null,
        previousStage: stageChanging ? currentStage : null,
        newStage: stageChanging ? nextStage : null,
        hasNote: !!(note?.trim()),
        hasFollowUp: !!followUpAt,
      },
      linkedId: linkedId ?? null,
      createdByUserId: userId,
    });

    // NOTE_ADDED (if note was saved)
    if (noteRow) {
      writeTimelineEvent({
        tenantId,
        contactId,
        type: "NOTE_ADDED",
        title: "Call note added",
        body: noteRow.body,
        linkedId: noteRow.id,
        createdByUserId: userId,
      });
    }

    // TASK_CREATED (if follow-up was created)
    if (taskRow) {
      const duePart = taskRow.dueAt ? ` · due ${new Date(taskRow.dueAt).toLocaleDateString()}` : "";
      writeTimelineEvent({
        tenantId,
        contactId,
        type: "TASK_CREATED",
        title: `Follow-up task created: ${taskRow.title}`,
        body: `${taskRow.title}${duePart}`,
        linkedId: taskRow.id,
        metadata: { priority: taskRow.priority },
        createdByUserId: userId,
      });
    }

    // ── Non-blocking campaign member callbackAt update ───────────────────────
    // If memberId is provided and the disposition maps to a callback + followUpAt,
    // set callbackAt/callbackNote on the campaign member so the queue callback tab
    // shows the right time. Does NOT update member status (handled separately by
    // PATCH /crm/queue/:memberId { action: "outcome" } from the UI).
    if (memberId && followUpAt) {
      const d = disposition.toLowerCase();
      const isCallback = d.includes("callback");
      if (isCallback) {
        (db as any).crmCampaignMember.updateMany({
          where: { id: memberId, tenantId },
          data: {
            callbackAt: new Date(followUpAt),
            callbackNote: note?.trim() ?? null,
          },
        }).catch(() => {});
      }
    }

    return reply.status(201).send({
      ok: true,
      disposition,
      stageChanged: !!stageChanging,
      noteCreated: !!noteRow,
      taskCreated: !!taskRow,
    });
  });

  // ── POST /crm/contacts/:id/phones ────────────────────────────────────────
  // Add a phone number to a contact. Deduplicates by normalised number.
  app.post("/crm/contacts/:id/phones", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const schema = z.object({
      numberRaw: z.string().min(1).max(50),
      type: z.enum(["MOBILE", "OFFICE", "HOME", "OTHER"]).default("MOBILE"),
      isPrimary: z.boolean().default(false),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const contact = await (db as any).contact.findFirst({
      where: { id, tenantId, active: true },
      select: { id: true },
    });
    if (!contact) return reply.status(404).send({ error: "not_found" });

    const numberNormalized = normalisePhone(parsed.data.numberRaw);
    if (!numberNormalized) {
      return reply.status(400).send({ error: "invalid_phone", detail: "Phone number must contain digits" });
    }

    // Dedup: reject if same normalised number already on this contact
    const existing = await db.contactPhone.findUnique({
      where: { contactId_numberNormalized: { contactId: id, numberNormalized } },
      select: { id: true },
    });
    if (existing) {
      return reply.status(409).send({ error: "duplicate_phone", detail: "This number is already on the contact" });
    }

    // If marking as primary, clear existing primary first
    if (parsed.data.isPrimary) {
      await db.contactPhone.updateMany({ where: { contactId: id }, data: { isPrimary: false } });
    }

    await db.contactPhone.create({
      data: {
        contactId: id,
        type: parsed.data.type,
        numberRaw: parsed.data.numberRaw.trim(),
        numberNormalized,
        isPrimary: parsed.data.isPrimary,
      },
    });

    const updated = await (db as any).contact.findFirst({
      where: { id, tenantId },
      include: CONTACT_WITH_CRM_INCLUDE,
    });
    return formatContact(updated);
  });

  // ── DELETE /crm/contacts/:id/phones/:phoneId ──────────────────────────────
  app.delete("/crm/contacts/:id/phones/:phoneId", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id, phoneId } = req.params as { id: string; phoneId: string };

    const contact = await (db as any).contact.findFirst({
      where: { id, tenantId, active: true },
      select: { id: true },
    });
    if (!contact) return reply.status(404).send({ error: "not_found" });

    const phone = await db.contactPhone.findFirst({
      where: { id: phoneId, contactId: id },
      select: { id: true },
    });
    if (!phone) return reply.status(404).send({ error: "phone_not_found" });

    await db.contactPhone.delete({ where: { id: phoneId } });
    return reply.status(200).send({ ok: true });
  });

  // ── POST /crm/contacts/:id/emails ─────────────────────────────────────────
  // Add an email address to a contact. Deduplicates by lowercased email.
  app.post("/crm/contacts/:id/emails", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const schema = z.object({
      email: z.string().email(),
      type: z.enum(["WORK", "PERSONAL", "OTHER"]).default("WORK"),
      isPrimary: z.boolean().default(false),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    const contact = await (db as any).contact.findFirst({
      where: { id, tenantId, active: true },
      select: { id: true },
    });
    if (!contact) return reply.status(404).send({ error: "not_found" });

    const emailNorm = parsed.data.email.toLowerCase().trim();

    const existing = await db.contactEmail.findUnique({
      where: { contactId_email: { contactId: id, email: emailNorm } },
      select: { id: true },
    });
    if (existing) {
      return reply.status(409).send({ error: "duplicate_email", detail: "This email is already on the contact" });
    }

    if (parsed.data.isPrimary) {
      await db.contactEmail.updateMany({ where: { contactId: id }, data: { isPrimary: false } });
    }

    await db.contactEmail.create({
      data: {
        contactId: id,
        type: parsed.data.type,
        email: emailNorm,
        isPrimary: parsed.data.isPrimary,
      },
    });

    const updated = await (db as any).contact.findFirst({
      where: { id, tenantId },
      include: CONTACT_WITH_CRM_INCLUDE,
    });
    return formatContact(updated);
  });

  // ── DELETE /crm/contacts/:id/emails/:emailId ──────────────────────────────
  app.delete("/crm/contacts/:id/emails/:emailId", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id, emailId } = req.params as { id: string; emailId: string };

    const contact = await (db as any).contact.findFirst({
      where: { id, tenantId, active: true },
      select: { id: true },
    });
    if (!contact) return reply.status(404).send({ error: "not_found" });

    const email = await db.contactEmail.findFirst({
      where: { id: emailId, contactId: id },
      select: { id: true },
    });
    if (!email) return reply.status(404).send({ error: "email_not_found" });

    await db.contactEmail.delete({ where: { id: emailId } });
    return reply.status(200).send({ ok: true });
  });

  // ── POST /crm/contacts/bulk-reassign ─────────────────────────────────────
  // Admin-only. Updates CrmContactMeta.assignedToUserId for a batch of contacts.
  // Skips contacts that don't belong to the tenant (silently). Capped at 500.
  app.post("/crm/contacts/bulk-reassign", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const schema = z.object({
      contactIds: z.array(z.string().min(1)).min(1).max(500),
      assignedToUserId: z.string().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }
    const { contactIds, assignedToUserId } = parsed.data;

    // Validate assignee belongs to tenant (skip validation when clearing)
    if (assignedToUserId) {
      const assignee = await db.user.findFirst({
        where: { id: assignedToUserId, tenantId },
        select: { id: true },
      });
      if (!assignee) {
        return reply.status(400).send({ error: "invalid_assigned_user", detail: "User not found in tenant" });
      }
    }

    // Update crmContactMeta for contacts that belong to this tenant
    // Using updateMany with tenantId in the where clause enforces tenant isolation
    const result = await (db as any).crmContactMeta.updateMany({
      where: {
        tenantId,
        contactId: { in: contactIds },
        contact: { active: true, archivedAt: null },
      },
      data: { assignedToUserId: assignedToUserId ?? null },
    });

    return { ok: true, updated: result.count };
  });

  // ── GET /crm/contacts/:id/duplicates ─────────────────────────────────────
  // Suggests possible duplicate contacts for the given CRM contact.
  // Matches on: shared normalised phone, shared email, or exact (case-insensitive)
  // displayName. Returns up to 5 suggestions. Admin and agents can view — merging
  // is admin-only.
  app.get("/crm/contacts/:id/duplicates", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, role } = user;
    const { id } = req.params as { id: string };

    const anchorWhere = isAdminRole(role)
      ? { id, tenantId }
      : { id, tenantId, active: true };

    // Load the current contact's phones + emails + name
    const contact = await (db as any).contact.findFirst({
      where: anchorWhere,
      select: {
        id: true,
        displayName: true,
        company: true,
        phones: { select: { numberNormalized: true } },
        emails: { select: { email: true } },
      },
    });
    if (!contact) return reply.status(404).send({ error: "not_found" });

    const normalizedPhones: string[] = contact.phones.map((p: any) => p.numberNormalized).filter(Boolean);
    const emails: string[] = contact.emails.map((e: any) => e.email.toLowerCase()).filter(Boolean);
    const nameLower = contact.displayName.toLowerCase();

    // Build OR conditions for matching
    const orClauses: object[] = [];
    if (normalizedPhones.length > 0) {
      orClauses.push({
        phones: { some: { numberNormalized: { in: normalizedPhones } } },
      });
    }
    if (emails.length > 0) {
      orClauses.push({
        emails: { some: { email: { in: emails } } },
      });
    }
    // Same display name (case-insensitive via Prisma mode)
    orClauses.push({
      displayName: { equals: contact.displayName, mode: "insensitive" },
    });

    if (orClauses.length === 0) return { duplicates: [] };

    const candidates = await (db as any).contact.findMany({
      where: {
        tenantId,
        active: true,
        archivedAt: null,
        id: { not: id },
        crmMeta: { isNot: null }, // only CRM-enrolled contacts
        OR: orClauses,
      },
      include: {
        phones: { where: { isPrimary: true }, take: 1 },
        emails: { where: { isPrimary: true }, take: 1 },
        crmMeta: { select: { stage: true } },
      },
      take: 5,
    });

    const duplicates = candidates.map((c: any) => {
      // Compute match reason(s)
      const reasons: string[] = [];
      const cNorms = c.phones.map((p: any) => p.numberNormalized);
      if (normalizedPhones.some((n) => cNorms.includes(n))) reasons.push("phone");
      const cEmails = c.emails.map((e: any) => e.email.toLowerCase());
      if (emails.some((e) => cEmails.includes(e))) reasons.push("email");
      if (c.displayName.toLowerCase() === nameLower) reasons.push("name");

      return {
        id: c.id,
        displayName: c.displayName,
        company: c.company ?? null,
        crmStage: c.crmMeta?.stage ?? null,
        primaryPhone: c.phones[0]?.numberRaw ?? null,
        primaryEmail: c.emails[0]?.email ?? null,
        matchReasons: reasons,
      };
    });

    return { duplicates };
  });

  // ── POST /crm/contacts/merge ──────────────────────────────────────────────
  // Admin-only. Merges mergeContactId into keepContactId:
  //   - Moves CRM timeline events, notes, tasks, checklist responses
  //   - Moves campaign memberships (skips conflicts where keepContact is
  //     already a member of the same campaign)
  //   - Copies unique phones/emails to keepContact
  //   - Enrolls keepContact in CRM (LEAD) if it has no crmMeta and mergeContact does
  //   - Archives mergeContact (active=false, archivedAt=now)
  //   - Writes CONTACT_MERGED timeline event on keepContact
  // Registered BEFORE /:id routes to avoid param capture.
  app.post("/crm/contacts/merge", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId, sub: adminUserId } = user;

    const schema = z.object({
      keepContactId: z.string().min(1),
      mergeContactId: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }
    const { keepContactId, mergeContactId } = parsed.data;

    if (keepContactId === mergeContactId) {
      return reply.status(400).send({ error: "same_contact", detail: "keepContactId and mergeContactId must differ" });
    }

    // Load both contacts with phones + emails + crmMeta
    const [keepContact, mergeContact] = await Promise.all([
      (db as any).contact.findFirst({
        where: { id: keepContactId, tenantId, active: true },
        include: {
          phones: { select: { id: true, numberNormalized: true, numberRaw: true, type: true, isPrimary: true } },
          emails: { select: { id: true, email: true, type: true, isPrimary: true } },
          crmMeta: { select: { id: true, stage: true } },
        },
      }),
      (db as any).contact.findFirst({
        where: { id: mergeContactId, tenantId, active: true },
        include: {
          phones: { select: { id: true, numberNormalized: true, numberRaw: true, type: true, isPrimary: true } },
          emails: { select: { id: true, email: true, type: true, isPrimary: true } },
          crmMeta: { select: { id: true, stage: true } },
          crmCampaignMembers: {
            select: {
              id: true,
              campaignId: true,
              assignedToUserId: true,
              status: true,
              attemptCount: true,
              sortOrder: true,
              callbackAt: true,
              callbackNote: true,
            },
          },
        },
      }),
    ]);

    if (!keepContact) return reply.status(404).send({ error: "keep_contact_not_found" });
    if (!mergeContact) return reply.status(404).send({ error: "merge_contact_not_found" });

    // Determine which phones/emails to copy over (exclude duplicates)
    const keepNorms = new Set<string>(keepContact.phones.map((p: any) => p.numberNormalized));
    const keepEmails = new Set<string>(keepContact.emails.map((e: any) => e.email.toLowerCase()));

    const phonesToAdd = mergeContact.phones.filter(
      (p: any) => p.numberNormalized && !keepNorms.has(p.numberNormalized),
    );
    const emailsToAdd = mergeContact.emails.filter(
      (e: any) => e.email && !keepEmails.has(e.email.toLowerCase()),
    );

    // Determine campaign members to move (skip campaigns where keepContact is already enrolled)
    const keepCampaignIds = new Set<string>(
      (
        await (db as any).crmCampaignMember.findMany({
          where: { contactId: keepContactId, tenantId },
          select: { campaignId: true },
        })
      ).map((m: any) => m.campaignId),
    );
    const membersToMove = mergeContact.crmCampaignMembers.filter(
      (m: any) => !keepCampaignIds.has(m.campaignId),
    );
    const membersConflictCount = mergeContact.crmCampaignMembers.length - membersToMove.length;

    // ── Atomic transaction ────────────────────────────────────────────────────
    await (db as any).$transaction(async (tx: any) => {
      // 1. Enroll keepContact in CRM if not already enrolled and mergeContact was
      if (!keepContact.crmMeta && mergeContact.crmMeta) {
        await tx.crmContactMeta.create({
          data: {
            tenantId,
            contactId: keepContactId,
            stage: mergeContact.crmMeta.stage,
          },
        });
      }

      // 2. Move timeline events
      await tx.crmTimelineEvent.updateMany({
        where: { contactId: mergeContactId, tenantId },
        data: { contactId: keepContactId },
      });

      // 3. Move notes
      await tx.crmContactNote.updateMany({
        where: { contactId: mergeContactId, tenantId },
        data: { contactId: keepContactId },
      });

      // 4. Move tasks
      await tx.crmContactTask.updateMany({
        where: { contactId: mergeContactId, tenantId },
        data: { contactId: keepContactId },
      });

      // 5. Move checklist responses
      await tx.crmChecklistResponse.updateMany({
        where: { contactId: mergeContactId, tenantId },
        data: { contactId: keepContactId },
      });

      // 6. Move campaign memberships that don't conflict
      for (const m of membersToMove) {
        await tx.crmCampaignMember.update({
          where: { id: m.id },
          data: { contactId: keepContactId },
        });
      }

      // 7. Add unique phones to keepContact
      if (phonesToAdd.length > 0) {
        await tx.contactPhone.createMany({
          data: phonesToAdd.map((p: any) => ({
            contactId: keepContactId,
            type: p.type,
            numberRaw: p.numberRaw,
            numberNormalized: p.numberNormalized,
            isPrimary: false, // never override the existing primary
          })),
          skipDuplicates: true,
        });
      }

      // 8. Add unique emails to keepContact
      if (emailsToAdd.length > 0) {
        await tx.contactEmail.createMany({
          data: emailsToAdd.map((e: any) => ({
            contactId: keepContactId,
            type: e.type,
            email: e.email.toLowerCase(),
            isPrimary: false,
          })),
          skipDuplicates: true,
        });
      }

      // 9. Archive the merged contact
      await tx.contact.update({
        where: { id: mergeContactId },
        data: { active: false, archivedAt: new Date() },
      });
    });

    // ── Non-blocking timeline event on keepContact ───────────────────────────
    await writeTimelineEvent({
      tenantId,
      contactId: keepContactId,
      type: "CONTACT_MERGED",
      title: `Contact merged: ${mergeContact.displayName} merged into this contact`,
      body: `Phones moved: ${phonesToAdd.length}. Emails moved: ${emailsToAdd.length}. Campaign memberships moved: ${membersToMove.length}${membersConflictCount > 0 ? ` (${membersConflictCount} skipped — already in campaign)` : ""}.`,
      metadata: {
        mergedContactId: mergeContactId,
        mergedContactName: mergeContact.displayName,
        phonesAdded: phonesToAdd.length,
        emailsAdded: emailsToAdd.length,
        campaignMembersMoved: membersToMove.length,
        campaignMembersSkipped: membersConflictCount,
      },
      createdByUserId: adminUserId,
    });

    return {
      ok: true,
      keepContactId,
      mergedContactId: mergeContactId,
      phonesAdded: phonesToAdd.length,
      emailsAdded: emailsToAdd.length,
      campaignMembersMoved: membersToMove.length,
      campaignMembersSkipped: membersConflictCount,
    };
  });
}

// ── Response formatter ────────────────────────────────────────────────────────

function formatContact(c: any) {
  const primaryPhone = c.phones?.find((p: any) => p.isPrimary) ?? c.phones?.[0] ?? null;
  const primaryEmail = c.emails?.find((e: any) => e.isPrimary) ?? c.emails?.[0] ?? null;
  return {
    id: c.id,
    tenantId: c.tenantId,
    displayName: c.displayName,
    firstName: c.firstName,
    lastName: c.lastName,
    company: c.company,
    title: c.title,
    avatarUrl: c.avatarUrl,
    notes: c.notes,
    phones: c.phones ?? [],
    emails: c.emails ?? [],
    addresses: c.addresses ?? [],
    tags: c.tagLinks?.map((tl: any) => tl.tag) ?? [],
    primaryPhone: primaryPhone ?? null,
    primaryEmail: primaryEmail ?? null,
    // CRM overlay
    crmStage: c.crmMeta?.stage ?? null,
    assignedTo: c.crmMeta?.assignedTo ?? null,
    doNotCall: c.crmMeta?.doNotCall ?? false,
    doNotSms: c.crmMeta?.doNotSms ?? false,
    lastActivityAt: c.crmMeta?.lastActivityAt ?? null,
    lastDisposition: c.crmMeta?.lastDisposition ?? null,
    lastDispositionAt: c.crmMeta?.lastDispositionAt ?? null,
    active: c.active ?? true,
    archivedAt: c.archivedAt ? new Date(c.archivedAt).toISOString() : null,
    isInCrm: !!c.crmMeta,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}
