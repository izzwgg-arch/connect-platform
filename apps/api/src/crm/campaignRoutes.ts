import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { requireCrmAccess, requireCrmAdmin, isCrmQueuePatchOwnershipForbidden, isAdminRole } from "./guard";
import {
  assertCrmCampaignAllowed,
  crmCampaignScopeForUser,
  getCrmUserCampaignRestriction,
} from "./userCampaignAccess";
import { todayBounds, startOfTomorrowFromDayStart } from "./crmAggregateBounds";
import {
  crmCallbackDueLteDayEndWhere,
  crmCallbackOverdueWhere,
  crmCallbackUpcomingOrUnsetWhere,
  crmMemberPendingOrInProgressWhere,
  crmMemberQueueNonTerminalWhere,
  crmCampaignMemberQueueLiveContactWhere,
  crmQueueFilterPendingWhere,
} from "./crmMemberQueryFragments";
import { checkAndAutoCompleteCampaign } from "./campaignAutoComplete";
import {
  CRM_IMPORT_MAX_FILE_BYTES,
  CRM_IMPORT_MAX_ROWS,
  parseCsv,
  autoMapHeaders,
  mappingHasPhoneOrEmail,
  processImportRow,
  readCrmImportMultipart,
  runCampaignImportPreview,
  crmCampaignImportBatchFilePrefix,
  displayFileNameFromCrmImportBatchStoredName,
  type CrmImportField,
  type RowData,
} from "./importPipeline";

// ── Shared campaign member include ────────────────────────────────────────────

const MEMBER_INCLUDE = {
  contact: {
    select: {
      id: true,
      displayName: true,
      company: true,
      active: true,
      archivedAt: true,
      phones: { where: { isPrimary: true }, select: { numberRaw: true }, take: 1 },
      emails: { where: { isPrimary: true }, select: { email: true }, take: 1 },
      crmMeta: { select: { stage: true, lastActivityAt: true, lastDisposition: true, lastDispositionAt: true } },
    },
  },
  assignedTo: { select: { id: true, displayName: true, email: true } },
} as const;

// ── Input schemas ─────────────────────────────────────────────────────────────

const CAMPAIGN_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"] as const;
const CAMPAIGN_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
const MEMBER_STATUSES = ["PENDING", "IN_PROGRESS", "CONTACTED", "CALLBACK", "CONVERTED", "SKIPPED", "DO_NOT_CALL"] as const;

const createCampaignSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  status: z.enum(CAMPAIGN_STATUSES).optional(),
  priority: z.enum(CAMPAIGN_PRIORITIES).optional(),
  scriptId: z.string().optional().nullable(),
  checklistId: z.string().optional().nullable(),
});

const patchCampaignSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  status: z.enum(CAMPAIGN_STATUSES).optional(),
  priority: z.enum(CAMPAIGN_PRIORITIES).optional(),
  scriptId: z.string().optional().nullable(),
  checklistId: z.string().optional().nullable(),
});

const addMembersSchema = z.object({
  contactIds: z.array(z.string().min(1)).min(1).max(500),
  assignedToUserId: z.string().optional().nullable(),
});

const patchMemberSchema = z.object({
  status: z.enum(MEMBER_STATUSES).optional(),
  assignedToUserId: z.string().optional().nullable(),
  sortOrder: z.number().int().optional(),
  attemptCount: z.number().int().min(0).optional(),
  lastAttemptAt: z.string().datetime({ offset: true }).optional().nullable(),
  callbackAt: z.string().datetime({ offset: true }).optional().nullable(),
  callbackNote: z.string().max(1000).optional().nullable(),
});

// ── Formatter ─────────────────────────────────────────────────────────────────

function formatCampaign(c: any, includeCounts = false) {
  const base: any = {
    id: c.id,
    tenantId: c.tenantId,
    name: c.name,
    description: c.description ?? null,
    status: c.status,
    priority: c.priority ?? "NORMAL",
    scriptId: c.scriptId ?? null,
    checklistId: c.checklistId ?? null,
    createdByUserId: c.createdByUserId,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    script: c.script ? { id: c.script.id, name: c.script.name } : null,
    checklist: c.checklist ? { id: c.checklist.id, name: c.checklist.name } : null,
  };
  if (includeCounts && c._count) {
    base.memberCount = c._count.members;
  }
  return base;
}

function formatMember(m: any) {
  const phone = m.contact?.phones?.[0]?.numberRaw ?? null;
  const email = m.contact?.emails?.[0]?.email ?? null;
  const queueWorkEligible = !!(m.contact && m.contact.active && m.contact.archivedAt == null);
  return {
    id: m.id,
    campaignId: m.campaignId,
    contactId: m.contactId,
    queueWorkEligible,
    contact: m.contact
      ? {
          id: m.contact.id,
          displayName: m.contact.displayName,
          company: m.contact.company ?? null,
          active: m.contact.active,
          archivedAt: m.contact.archivedAt ? new Date(m.contact.archivedAt).toISOString() : null,
          primaryPhone: phone,
          primaryEmail: email,
          crmStage: m.contact.crmMeta?.stage ?? null,
          lastActivityAt: m.contact.crmMeta?.lastActivityAt ?? null,
          lastDisposition: m.contact.crmMeta?.lastDisposition ?? null,
          lastDispositionAt: m.contact.crmMeta?.lastDispositionAt ?? null,
        }
      : null,
    assignedTo: m.assignedTo ?? null,
    assignedToUserId: m.assignedToUserId ?? null,
    status: m.status,
    attemptCount: m.attemptCount,
    lastAttemptAt: m.lastAttemptAt ?? null,
    callbackAt: m.callbackAt ?? null,
    callbackNote: m.callbackNote ?? null,
    sortOrder: m.sortOrder,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

// ── Route registrar ───────────────────────────────────────────────────────────

export async function registerCrmCampaignRoutes(app: FastifyInstance) {

  // ── GET /crm/campaigns ─────────────────────────────────────────────────────
  app.get("/crm/campaigns", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId, role } = user;
    const q = req.query as Record<string, string>;

    const campaignScope = await crmCampaignScopeForUser(tenantId, userId, role);

    const campaigns = await db.crmCampaign.findMany({
      where: {
        tenantId,
        ...campaignScope,
        ...(q.status ? { status: q.status as any } : { status: { not: "ARCHIVED" } }),
      },
      orderBy: { createdAt: "desc" },
      include: {
        script: { select: { id: true, name: true } },
        checklist: { select: { id: true, name: true } },
        _count: { select: { members: true } },
      },
    });

    return { campaigns: campaigns.map((c) => formatCampaign(c, true)) };
  });

  // ── POST /crm/campaigns ────────────────────────────────────────────────────
  app.post("/crm/campaigns", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;

    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.issues });

    const campaign = await db.crmCampaign.create({
      data: {
        tenantId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        status: parsed.data.status ?? "DRAFT",
        priority: parsed.data.priority ?? "NORMAL",
        scriptId: parsed.data.scriptId ?? null,
        checklistId: parsed.data.checklistId ?? null,
        createdByUserId: userId,
      },
      include: {
        script: { select: { id: true, name: true } },
        checklist: { select: { id: true, name: true } },
      },
    });

    return reply.code(201).send({ campaign: formatCampaign(campaign) });
  });

  // ── GET /crm/campaigns/:id ─────────────────────────────────────────────────
  app.get("/crm/campaigns/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    if (!(await assertCrmCampaignAllowed(user, id, reply))) return;

    const campaign = await db.crmCampaign.findFirst({
      where: { id, tenantId },
      include: {
        script: { select: { id: true, name: true } },
        checklist: { select: { id: true, name: true } },
        _count: { select: { members: true } },
      },
    });
    if (!campaign) return reply.code(404).send({ error: "not_found" });

    // Count members by status
    const statusCounts = await db.crmCampaignMember.groupBy({
      by: ["status"],
      where: { campaignId: id, tenantId },
      _count: { id: true },
    });
    const counts: Record<string, number> = {};
    statusCounts.forEach((r) => { counts[r.status] = r._count.id; });

    return { campaign: { ...formatCampaign(campaign, true), statusCounts: counts } };
  });

  // ── GET /crm/campaigns/:id/imports ─────────────────────────────────────────
  // Real `CrmImportBatch` rows for CSV imports into this campaign (`fileName` prefix `campaign:{id}:`).
  app.get("/crm/campaigns/:id/imports", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id: campaignId } = req.params as { id: string };

    if (!(await assertCrmCampaignAllowed(user, campaignId, reply))) return;

    const q = req.query as Record<string, string>;
    const limit = Math.min(50, Math.max(1, parseInt(q.limit ?? "20", 10)));
    const prefix = crmCampaignImportBatchFilePrefix(campaignId);

    const batches = await db.crmImportBatch.findMany({
      where: { tenantId, fileName: { startsWith: prefix } },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        createdBy: {
          select: { id: true, firstName: true, lastName: true, displayName: true, email: true },
        },
      },
    });

    return {
      imports: batches.map((b) => ({
        id: b.id,
        createdAt: b.createdAt,
        completedAt: b.completedAt,
        status: b.status,
        fileName: displayFileNameFromCrmImportBatchStoredName(b.fileName),
        totalRows: b.totalRows,
        processedRows: b.processedRows,
        createdCount: b.createdCount,
        updatedCount: b.updatedCount,
        skippedCount: b.skippedCount,
        errorCount: b.errorCount,
        createdBy: b.createdBy
          ? {
              id: b.createdBy.id,
              displayName:
                b.createdBy.displayName ||
                [b.createdBy.firstName, b.createdBy.lastName].filter(Boolean).join(" ") ||
                b.createdBy.email,
            }
          : null,
      })),
    };
  });

  // ── PATCH /crm/campaigns/:id ───────────────────────────────────────────────
  app.patch("/crm/campaigns/:id", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    if (!(await assertCrmCampaignAllowed(user, id, reply))) return;

    const parsed = patchCampaignSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.issues });

    const campaign = await db.crmCampaign.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
        ...(parsed.data.scriptId !== undefined ? { scriptId: parsed.data.scriptId } : {}),
        ...(parsed.data.checklistId !== undefined ? { checklistId: parsed.data.checklistId } : {}),
      },
      include: {
        script: { select: { id: true, name: true } },
        checklist: { select: { id: true, name: true } },
      },
    });

    return { campaign: formatCampaign(campaign) };
  });

  // ── DELETE /crm/campaigns/:id ─────────────────────────────────────────────
  app.delete("/crm/campaigns/:id", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };

    if (!(await assertCrmCampaignAllowed(user, id, reply))) return;

    await db.crmCampaign.update({ where: { id }, data: { status: "ARCHIVED" } });
    return { ok: true };
  });

  // ── POST /crm/campaigns/:id/members/add ──────────────────────────────────
  // Add contacts to a campaign. Skips contacts already in campaign.
  app.post("/crm/campaigns/:id/members/add", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id: campaignId } = req.params as { id: string };

    if (!(await assertCrmCampaignAllowed(user, campaignId, reply))) return;

    const parsed = addMembersSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.issues });

    const { contactIds, assignedToUserId } = parsed.data;

    // Verify all contacts exist in tenant and have crmMeta
    const contacts = await db.contact.findMany({
      where: { id: { in: contactIds }, tenantId, active: true },
      select: { id: true, crmMeta: { select: { id: true } } },
    });
    const validIds = contacts.filter((c) => !!c.crmMeta).map((c) => c.id);

    if (validIds.length === 0) return reply.code(400).send({ error: "no_valid_contacts" });

    // Get existing members to skip duplicates
    const existing = await db.crmCampaignMember.findMany({
      where: { campaignId, contactId: { in: validIds } },
      select: { contactId: true },
    });
    const existingSet = new Set(existing.map((m) => m.contactId));
    const newIds = validIds.filter((id) => !existingSet.has(id));

    if (newIds.length === 0) return reply.code(200).send({ added: 0, skipped: validIds.length, message: "All contacts already in campaign" });

    // Get current max sortOrder
    const maxOrder = await db.crmCampaignMember.aggregate({
      where: { campaignId },
      _max: { sortOrder: true },
    });
    const baseOrder = (maxOrder._max.sortOrder ?? -1) + 1;

    await db.crmCampaignMember.createMany({
      data: newIds.map((contactId, i) => ({
        tenantId,
        campaignId,
        contactId,
        assignedToUserId: assignedToUserId ?? null,
        status: "PENDING" as const,
        attemptCount: 0,
        sortOrder: baseOrder + i,
      })),
    });

    return reply.code(201).send({ added: newIds.length, skipped: validIds.length - newIds.length });
  });

  // ── POST /crm/campaigns/:id/import/preview ───────────────────────────────
  // Dry-run: same parse/map/dedup/resolution as real import; no DB writes (no batch, contacts, members).
  app.post("/crm/campaigns/:id/import/preview", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;
    const { id: campaignId } = req.params as { id: string };

    if (!(await assertCrmCampaignAllowed(user, campaignId, reply))) return;

    if (!(req as any).isMultipart?.()) {
      return reply.status(400).send({ error: "multipart_required" });
    }

    let fileBuf: Buffer;
    let fileName: string;
    let fields: Record<string, string>;
    try {
      const read = await readCrmImportMultipart(req);
      fileBuf = read.fileBuf;
      fileName = read.fileName;
      fields = read.fields;
    } catch (err: any) {
      if (err?.code === "file_required") {
        return reply.status(400).send({ error: "file_required" });
      }
      return reply.status(400).send({ error: "multipart_parse_failed", detail: err?.message });
    }

    if (fileBuf.length > CRM_IMPORT_MAX_FILE_BYTES) {
      return reply.status(413).send({ error: "file_too_large", limitMb: 5 });
    }

    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    if (ext !== "csv") {
      return reply.status(400).send({ error: "invalid_file_type", detail: "Only CSV files are supported." });
    }

    const assignRaw = (fields.assignedToUserId ?? "").trim();
    let assigneeUserId: string | null = assignRaw || null;
    if (assigneeUserId) {
      const access = await db.crmUserAccess.findFirst({
        where: { tenantId, userId: assigneeUserId, enabled: true },
        select: { id: true },
      });
      if (!access) {
        return reply.status(400).send({ error: "invalid_assignee", detail: "User must belong to tenant and have CRM access enabled." });
      }
    }

    let rows: string[][];
    try {
      rows = parseCsv(fileBuf.toString("utf-8"));
    } catch (err: any) {
      return reply.status(400).send({ error: "csv_parse_failed", detail: err?.message });
    }

    if (rows.length < 2) {
      return reply.status(400).send({ error: "csv_empty", detail: "File must have a header row and at least one data row." });
    }

    const headers = rows[0];
    const dataRows = rows.slice(1).slice(0, CRM_IMPORT_MAX_ROWS);
    if (dataRows.length === 0) {
      return reply.status(400).send({ error: "csv_no_data_rows" });
    }

    const colMapping = autoMapHeaders(headers);
    if (!mappingHasPhoneOrEmail(colMapping)) {
      return reply.status(400).send({
        error: "no_usable_columns",
        detail: "CSV must have at least a 'phone' or 'email' column. Check column headers.",
        detectedHeaders: headers,
        expectedHeaders: ["first name", "last name", "company", "phone", "email", "notes", "tags"],
      });
    }

    const preview = await runCampaignImportPreview(tenantId, campaignId, userId, dataRows, colMapping);
    return reply.send({
      ...preview,
      campaignId,
      fileName,
      detectedHeaders: headers,
      mapping: colMapping,
      assignedToUserId: assigneeUserId,
    });
  });

  // ── POST /crm/campaigns/:id/import ───────────────────────────────────────
  // Multipart CSV (field "file") — reuses CRM import parse/dedup pipeline,
  // then enrolls contacts into this campaign. Optional field assignedToUserId.
  app.post("/crm/campaigns/:id/import", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;
    const { id: campaignId } = req.params as { id: string };

    if (!(await assertCrmCampaignAllowed(user, campaignId, reply))) return;

    if (!(req as any).isMultipart?.()) {
      return reply.status(400).send({ error: "multipart_required" });
    }

    let fileBuf: Buffer;
    let fileName: string;
    let fields: Record<string, string>;
    try {
      const read = await readCrmImportMultipart(req);
      fileBuf = read.fileBuf;
      fileName = read.fileName;
      fields = read.fields;
    } catch (err: any) {
      if (err?.code === "file_required") {
        return reply.status(400).send({ error: "file_required" });
      }
      return reply.status(400).send({ error: "multipart_parse_failed", detail: err?.message });
    }

    if (fileBuf.length > CRM_IMPORT_MAX_FILE_BYTES) {
      return reply.status(413).send({ error: "file_too_large", limitMb: 5 });
    }

    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    if (ext !== "csv") {
      return reply.status(400).send({ error: "invalid_file_type", detail: "Only CSV files are supported." });
    }

    const assignRaw = (fields.assignedToUserId ?? "").trim();
    let assigneeUserId: string | null = assignRaw || null;
    if (assigneeUserId) {
      const access = await db.crmUserAccess.findFirst({
        where: { tenantId, userId: assigneeUserId, enabled: true },
        select: { id: true },
      });
      if (!access) {
        return reply.status(400).send({ error: "invalid_assignee", detail: "User must belong to tenant and have CRM access enabled." });
      }
    }

    let rows: string[][];
    try {
      rows = parseCsv(fileBuf.toString("utf-8"));
    } catch (err: any) {
      return reply.status(400).send({ error: "csv_parse_failed", detail: err?.message });
    }

    if (rows.length < 2) {
      return reply.status(400).send({ error: "csv_empty", detail: "File must have a header row and at least one data row." });
    }

    const headers = rows[0];
    const dataRows = rows.slice(1).slice(0, CRM_IMPORT_MAX_ROWS);
    if (dataRows.length === 0) {
      return reply.status(400).send({ error: "csv_no_data_rows" });
    }

    const colMapping = autoMapHeaders(headers);
    if (!mappingHasPhoneOrEmail(colMapping)) {
      return reply.status(400).send({
        error: "no_usable_columns",
        detail: "CSV must have at least a 'phone' or 'email' column. Check column headers.",
        detectedHeaders: headers,
        expectedHeaders: ["first name", "last name", "company", "phone", "email", "notes", "tags"],
      });
    }

    const batch = await db.crmImportBatch.create({
      data: {
        tenantId,
        fileName: `${crmCampaignImportBatchFilePrefix(campaignId)}${fileName}`,
        status: "PROCESSING",
        totalRows: dataRows.length,
        mapping: colMapping as any,
        createdByUserId: userId,
      },
    });

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let addedMembers = 0;
    let skippedExistingMembers = 0;
    const errors: { row: number; reason: string }[] = [];
    const contactIdsToEnroll: string[] = [];

    for (let i = 0; i < dataRows.length; i++) {
      const rawRow = dataRows[i];
      const rowData: RowData = {};
      for (const [colIdx, fieldKey] of Object.entries(colMapping) as [string, CrmImportField][]) {
        const val = rawRow[parseInt(colIdx, 10)]?.trim() ?? "";
        if (val) rowData[fieldKey] = val;
      }

      try {
        const result = await processImportRow(tenantId, userId, rowData);
        if (result.action === "created") {
          createdCount++;
          if (result.contactId) contactIdsToEnroll.push(result.contactId);
        } else if (result.action === "updated") {
          updatedCount++;
          if (result.contactId) contactIdsToEnroll.push(result.contactId);
        } else {
          skippedCount++;
          errors.push({ row: i + 2, reason: result.reason ?? "skipped" });
        }
      } catch (err: any) {
        errorCount++;
        errors.push({ row: i + 2, reason: err?.message ?? "unknown_error" });
      }
    }

    // Dedupe contact IDs within this import batch (same row twice / phone+email dup)
    const uniqueContactIds = [...new Set(contactIdsToEnroll)];

    if (uniqueContactIds.length > 0) {
      const contacts = await db.contact.findMany({
        where: { id: { in: uniqueContactIds }, tenantId, active: true },
        select: { id: true, crmMeta: { select: { id: true } } },
      });
      const validIds = contacts.filter((c) => !!c.crmMeta).map((c) => c.id);

      const existingMembers = await db.crmCampaignMember.findMany({
        where: { campaignId, contactId: { in: validIds } },
        select: { contactId: true },
      });
      const existingSet = new Set(existingMembers.map((m) => m.contactId));
      const newIds = validIds.filter((id) => !existingSet.has(id));
      skippedExistingMembers = validIds.length - newIds.length;

      if (newIds.length > 0) {
        const maxOrder = await db.crmCampaignMember.aggregate({
          where: { campaignId },
          _max: { sortOrder: true },
        });
        const baseOrder = (maxOrder._max.sortOrder ?? -1) + 1;

        await db.crmCampaignMember.createMany({
          data: newIds.map((contactId, idx) => ({
            tenantId,
            campaignId,
            contactId,
            assignedToUserId: assigneeUserId,
            status: "PENDING" as const,
            attemptCount: 0,
            sortOrder: baseOrder + idx,
          })),
        });
        addedMembers = newIds.length;
      }
    }

    const finalStatus =
      errorCount > 0 && createdCount + updatedCount === 0 && addedMembers === 0
        ? "FAILED"
        : errorCount > 0 || skippedCount > 0 || skippedExistingMembers > 0
          ? "PARTIAL"
          : "DONE";

    const completed = await db.crmImportBatch.update({
      where: { id: batch.id },
      data: {
        status: finalStatus,
        processedRows: dataRows.length,
        createdCount,
        updatedCount,
        skippedCount,
        errorCount,
        errors: errors as any,
        completedAt: new Date(),
      },
    });

    return {
      batchId: completed.id,
      campaignId,
      fileName,
      status: completed.status,
      totalRows: completed.totalRows,
      createdContacts: createdCount,
      updatedContacts: updatedCount,
      skippedRows: skippedCount,
      addedMembers,
      skippedExistingMembers,
      errorCount,
      errors: errors.slice(0, 50),
      detectedHeaders: headers,
      mapping: colMapping,
      assignedToUserId: assigneeUserId,
    };
  });

  // ── GET /crm/campaigns/:id/members ──────────────────────────────────────
  app.get("/crm/campaigns/:id/members", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id: campaignId } = req.params as { id: string };
    const q = req.query as Record<string, string>;

    if (!(await assertCrmCampaignAllowed(user, campaignId, reply))) return;

    const page = Math.max(1, parseInt(q.page ?? "1"));
    const limit = Math.min(200, Math.max(1, parseInt(q.limit ?? "50")));

    const statusFilter = q.status ? (q.status.split(",") as any[]) : undefined;
    // ?unassigned=true → only members with no assignee
    // ?assignedToUserId=<id> → only members assigned to that user (validated to tenant below)
    // ?assignedToMe=true → shorthand for current user (existing behaviour preserved)
    const unassignedFilter = q.unassigned === "true";
    const assignedToUserIdFilter = q.assignedToUserId ?? null;

    const assigneeWhere: Record<string, unknown> = {};
    if (unassignedFilter) {
      assigneeWhere.assignedToUserId = null;
    } else if (assignedToUserIdFilter) {
      // Validate the userId belongs to this tenant before using it in the query
      const validUser = await db.user.findFirst({
        where: { id: assignedToUserIdFilter, tenantId },
        select: { id: true },
      });
      if (!validUser) return reply.code(404).send({ error: "user_not_found" });
      assigneeWhere.assignedToUserId = assignedToUserIdFilter;
    } else if (q.assignedToMe === "true") {
      assigneeWhere.assignedToUserId = user.sub;
    }

    const baseWhere = {
      campaignId,
      tenantId,
      ...(statusFilter ? { status: { in: statusFilter } } : {}),
      ...assigneeWhere,
    };

    const [members, total] = await Promise.all([
      db.crmCampaignMember.findMany({
        where: baseWhere,
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
        include: MEMBER_INCLUDE,
      }),
      db.crmCampaignMember.count({ where: baseWhere }),
    ]);

    return { members: members.map(formatMember), total, page, limit };
  });

  // ── PATCH /crm/campaigns/:id/members/:memberId ────────────────────────────
  app.patch("/crm/campaigns/:id/members/:memberId", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id: campaignId, memberId } = req.params as { id: string; memberId: string };

    if (!(await assertCrmCampaignAllowed(user, campaignId, reply))) return;

    const existing = await db.crmCampaignMember.findFirst({
      where: { id: memberId, campaignId, tenantId },
      select: {
        id: true,
        contact: { select: { active: true, archivedAt: true } },
      },
    });
    if (!existing) return reply.code(404).send({ error: "not_found" });

    const parsed = patchMemberSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.issues });

    const contactLive =
      !!existing.contact?.active && existing.contact.archivedAt == null;
    if (!contactLive && !isAdminRole(user.role)) {
      return reply.code(403).send({
        error: "crm_member_contact_not_live",
        detail: "This lead's contact is archived or inactive and cannot be updated by agents.",
      });
    }

    const member = await db.crmCampaignMember.update({
      where: { id: memberId },
      data: {
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.assignedToUserId !== undefined ? { assignedToUserId: parsed.data.assignedToUserId } : {}),
        ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
        ...(parsed.data.attemptCount !== undefined ? { attemptCount: parsed.data.attemptCount } : {}),
        ...(parsed.data.lastAttemptAt !== undefined
          ? { lastAttemptAt: parsed.data.lastAttemptAt ? new Date(parsed.data.lastAttemptAt) : null }
          : {}),
        ...(parsed.data.callbackAt !== undefined
          ? { callbackAt: parsed.data.callbackAt ? new Date(parsed.data.callbackAt) : null }
          : {}),
        ...(parsed.data.callbackNote !== undefined ? { callbackNote: parsed.data.callbackNote } : {}),
      },
      include: MEMBER_INCLUDE,
    });

    // Non-blocking auto-complete check when status changes to a terminal value
    if (parsed.data.status && ["CONTACTED", "CONVERTED", "SKIPPED", "DO_NOT_CALL"].includes(parsed.data.status)) {
      checkAndAutoCompleteCampaign(campaignId, tenantId).catch(() => {});
    }

    return { member: formatMember(member) };
  });

  // ── GET /crm/campaigns/:id/contacts/available ─────────────────────────────
  // Server-side search for contacts NOT already in this campaign.
  // Supports ?q= (name/phone/email search), ?limit=, ?page=
  app.get("/crm/campaigns/:id/contacts/available", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id: campaignId } = req.params as { id: string };
    const q = req.query as Record<string, string>;

    if (!(await assertCrmCampaignAllowed(user, campaignId, reply))) return;

    const search = (q.q ?? "").trim();
    const limit = Math.min(50, Math.max(1, parseInt(q.limit ?? "20")));
    const page = Math.max(1, parseInt(q.page ?? "1"));

    // Get contact IDs already in campaign
    const existingMembers = await db.crmCampaignMember.findMany({
      where: { campaignId, tenantId },
      select: { contactId: true },
    });
    const excludedIds = existingMembers.map((m) => m.contactId);

    const whereClause: any = {
      tenantId,
      active: true,
      archivedAt: null,
      crmMeta: { isNot: null },
      ...(excludedIds.length > 0 ? { id: { notIn: excludedIds } } : {}),
    };

    if (search) {
      whereClause.OR = [
        { displayName: { contains: search, mode: "insensitive" } },
        { phones: { some: { numberRaw: { contains: search } } } },
        { emails: { some: { email: { contains: search, mode: "insensitive" } } } },
      ];
    }

    const [contacts, total] = await Promise.all([
      db.contact.findMany({
        where: whereClause,
        orderBy: { displayName: "asc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          displayName: true,
          company: true,
          phones: { where: { isPrimary: true }, select: { numberRaw: true }, take: 1 },
          emails: { where: { isPrimary: true }, select: { email: true }, take: 1 },
          crmMeta: { select: { stage: true } },
        },
      }),
      db.contact.count({ where: whereClause }),
    ]);

    return {
      contacts: contacts.map((c) => ({
        id: c.id,
        displayName: c.displayName,
        company: c.company ?? null,
        primaryPhone: c.phones[0]?.numberRaw ?? null,
        primaryEmail: c.emails[0]?.email ?? null,
        crmStage: c.crmMeta?.stage ?? null,
      })),
      total,
      page,
      limit,
    };
  });

  // ── POST /crm/campaigns/:id/members/bulk-assign ───────────────────────────
  // Bulk-assign (or clear) members to a user.
  app.post("/crm/campaigns/:id/members/bulk-assign", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id: campaignId } = req.params as { id: string };

    if (!(await assertCrmCampaignAllowed(user, campaignId, reply))) return;

    const bulkAssignSchema = z.object({
      memberIds: z.array(z.string().min(1)).min(1).max(500),
      assignedToUserId: z.string().nullable(), // null to clear assignment
    });

    const parsed = bulkAssignSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.issues });

    const { memberIds, assignedToUserId } = parsed.data;

    const updated = await db.crmCampaignMember.updateMany({
      where: {
        id: { in: memberIds },
        campaignId,
        tenantId,
      },
      data: { assignedToUserId },
    });

    return { updated: updated.count };
  });

  // ── GET /crm/campaigns/:id/workload ──────────────────────────────────────
  // Per-agent assignment summary for a campaign. Admin/manager only.
  // Returns a row for each user who has at least one member, plus an "Unassigned" row.
  app.get("/crm/campaigns/:id/workload", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id: campaignId } = req.params as { id: string };

    if (!(await assertCrmCampaignAllowed(user, campaignId, reply))) return;

    // Aggregate member counts per (assignedToUserId, status)
    const rows = await db.crmCampaignMember.groupBy({
      by: ["assignedToUserId", "status"],
      where: { campaignId, tenantId, ...crmCampaignMemberQueueLiveContactWhere },
      _count: { id: true },
    });

    // Collect unique user IDs (excluding null)
    const userIds = [...new Set(rows.map((r) => r.assignedToUserId).filter((id): id is string => id !== null))];

    const users = userIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: userIds }, tenantId },
          select: { id: true, displayName: true, email: true, firstName: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u.displayName || u.firstName || u.email]));

    // Build summary map keyed by userId (null = unassigned)
    const summaryMap = new Map<string | null, {
      userId: string | null; displayName: string;
      pending: number; inProgress: number; callbacks: number;
      contacted: number; converted: number; skipped: number; dnc: number; total: number;
    }>();

    for (const row of rows) {
      const uid = row.assignedToUserId;
      const key = uid ?? "__unassigned__";
      if (!summaryMap.has(key)) {
        summaryMap.set(key, {
          userId: uid,
          displayName: uid ? (userMap.get(uid) ?? "Unknown") : "Unassigned",
          pending: 0, inProgress: 0, callbacks: 0,
          contacted: 0, converted: 0, skipped: 0, dnc: 0, total: 0,
        });
      }
      const entry = summaryMap.get(key)!;
      const count = row._count.id;
      entry.total += count;
      if (row.status === "PENDING") entry.pending += count;
      else if (row.status === "IN_PROGRESS") entry.inProgress += count;
      else if (row.status === "CALLBACK") entry.callbacks += count;
      else if (row.status === "CONTACTED") entry.contacted += count;
      else if (row.status === "CONVERTED") entry.converted += count;
      else if (row.status === "SKIPPED") entry.skipped += count;
      else if (row.status === "DO_NOT_CALL") entry.dnc += count;
    }

    // Sort: named agents first (alphabetical), unassigned last
    const workload = [...summaryMap.values()].sort((a, b) => {
      if (a.userId === null) return 1;
      if (b.userId === null) return -1;
      return a.displayName.localeCompare(b.displayName);
    });

    return { workload };
  });

  // ── POST /crm/campaigns/:id/members/distribute ────────────────────────────
  // Round-robin distribute all unassigned PENDING/IN_PROGRESS members across
  // the provided user list. Explicit manager action — never automatic.
  app.post("/crm/campaigns/:id/members/distribute", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id: campaignId } = req.params as { id: string };

    const distributeSchema = z.object({
      userIds: z.array(z.string().min(1)).min(1).max(50),
    });
    const parsed = distributeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.issues });

    if (!(await assertCrmCampaignAllowed(user, campaignId, reply))) return;

    const { userIds } = parsed.data;

    // Validate all userIds belong to this tenant
    const validUsers = await db.user.findMany({
      where: { id: { in: userIds }, tenantId },
      select: { id: true },
    });
    if (validUsers.length !== userIds.length) {
      return reply.code(400).send({ error: "invalid_user_ids", detail: "One or more userIds are not valid for this tenant" });
    }

    // Fetch all unassigned PENDING or IN_PROGRESS members ordered by sort position
    const unassigned = await db.crmCampaignMember.findMany({
      where: {
        campaignId,
        tenantId,
        assignedToUserId: null,
        status: { in: ["PENDING", "IN_PROGRESS"] },
        ...crmCampaignMemberQueueLiveContactWhere,
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });

    if (unassigned.length === 0) {
      return { distributed: 0, assignments: [], message: "No unassigned leads to distribute" };
    }

    // Round-robin assignment
    const assignments: { userId: string; memberIds: string[] }[] = userIds.map((uid) => ({ userId: uid, memberIds: [] }));
    unassigned.forEach((m, i) => {
      assignments[i % userIds.length].memberIds.push(m.id);
    });

    // Bulk update each user's batch
    await Promise.all(
      assignments
        .filter((a) => a.memberIds.length > 0)
        .map((a) =>
          db.crmCampaignMember.updateMany({
            where: { id: { in: a.memberIds }, campaignId, tenantId },
            data: { assignedToUserId: a.userId },
          }),
        ),
    );

    return {
      distributed: unassigned.length,
      assignments: assignments.map((a) => ({ userId: a.userId, count: a.memberIds.length })),
    };
  });

  // ── GET /crm/campaigns/:id/export.csv ─────────────────────────────────────
  // Export campaign members as CSV.
  app.get("/crm/campaigns/:id/export.csv", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id: campaignId } = req.params as { id: string };

    if (!(await assertCrmCampaignAllowed(user, campaignId, reply))) return;

    const campaign = await db.crmCampaign.findFirst({
      where: { id: campaignId, tenantId },
      select: { id: true, name: true },
    });
    if (!campaign) return reply.code(404).send({ error: "not_found" });

    const members = await db.crmCampaignMember.findMany({
      where: { campaignId, tenantId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: {
        contact: {
          select: {
            displayName: true,
            company: true,
            phones: { where: { isPrimary: true }, select: { numberRaw: true }, take: 1 },
            emails: { where: { isPrimary: true }, select: { email: true }, take: 1 },
            crmMeta: { select: { stage: true, lastDisposition: true } },
          },
        },
        assignedTo: { select: { displayName: true, email: true } },
      },
    });

    const escape = (v: string | null | undefined): string => {
      if (v == null) return "";
      const s = String(v);
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const rows: string[] = [
      ["Name", "Phone", "Email", "Company", "Stage", "Status", "Assigned To", "Attempts", "Last Attempt", "Last Disposition"].map(escape).join(","),
      ...members.map((m) =>
        [
          m.contact?.displayName,
          m.contact?.phones?.[0]?.numberRaw,
          m.contact?.emails?.[0]?.email,
          m.contact?.company,
          m.contact?.crmMeta?.stage,
          m.status,
          m.assignedTo?.displayName ?? m.assignedTo?.email,
          String(m.attemptCount),
          m.lastAttemptAt ? m.lastAttemptAt.toISOString() : "",
          m.contact?.crmMeta?.lastDisposition,
        ].map(escape).join(",")
      ),
    ];

    const safeName = campaign.name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${safeName}-members.csv"`);
    return reply.send(rows.join("\r\n"));
  });

  // ── GET /crm/queue ─────────────────────────────────────────────────────────
  // My Queue with filter + sort support.
  // ?filter=pending (default) — PENDING/IN_PROGRESS in ACTIVE campaigns
  // ?filter=due     — CALLBACK, callbackAt <= end of today
  // ?filter=overdue — CALLBACK, callbackAt < start of today
  // ?filter=upcoming — CALLBACK, callbackAt >= start of tomorrow OR null
  // ?filter=all     — all non-terminal statuses
  //
  // ?sort=smart   — priority-ranked order (overdue callbacks → due today → upcoming
  //                 soon → fresh leads → low-attempt leads → older leads).
  //                 On filter=pending, smart sort also pulls in CALLBACK members
  //                 so overdue/due callbacks surface above zero-attempt leads.
  //                 Candidate cap: 500 rows fetched, ranked in-process, then sliced
  //                 to the requested limit.  Safe for per-user tenant-scoped queues.
  // ?sort=original — stable DB order (existing behaviour, default for manual mode)
  app.get("/crm/queue", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId, role } = user;
    const q = req.query as Record<string, string>;

    const limit = Math.min(200, Math.max(1, parseInt(q.limit ?? "50")));
    const filter = q.filter ?? "pending";
    const sortMode = q.sort === "smart" ? "smart" : "original";

  const userCampaignRestriction = isAdminRole(role)
      ? null
      : await getCrmUserCampaignRestriction(tenantId, userId);

    // ── Campaign filter ────────────────────────────────────────────────────────
    // If ?campaignId= is supplied, validate it belongs to this tenant.
    // Cross-tenant access returns 404 (never 403, to avoid ID enumeration).
    const campaignIdParam = q.campaignId ?? null;
    let campaignFilter: Record<string, unknown> = { status: "ACTIVE" };
    if (campaignIdParam) {
      const exists = await db.crmCampaign.findFirst({
        where: { id: campaignIdParam, tenantId },
        select: { id: true },
      });
      if (!exists) return reply.code(404).send({ error: "campaign_not_found" });
      if (userCampaignRestriction && !userCampaignRestriction.includes(campaignIdParam)) {
        return reply.code(403).send({ error: "forbidden", detail: "Campaign not assigned to this user." });
      }
      campaignFilter = { id: campaignIdParam, status: "ACTIVE" };
    } else if (userCampaignRestriction) {
      campaignFilter = { id: { in: userCampaignRestriction }, status: "ACTIVE" };
    }

    const { now, start: startOfToday, end: endOfToday } = todayBounds();
    const startOfTomorrow = startOfTomorrowFromDayStart(startOfToday);
    const day7 = new Date(now); day7.setDate(day7.getDate() + 7);

    let whereClause: Record<string, unknown>;

    if (filter === "due") {
      whereClause = {
        tenantId,
        assignedToUserId: userId,
        ...crmCampaignMemberQueueLiveContactWhere,
        ...crmCallbackDueLteDayEndWhere(endOfToday, campaignFilter),
      };
    } else if (filter === "overdue") {
      whereClause = {
        tenantId,
        assignedToUserId: userId,
        ...crmCampaignMemberQueueLiveContactWhere,
        ...crmCallbackOverdueWhere(startOfToday, campaignFilter),
      };
    } else if (filter === "upcoming") {
      whereClause = {
        tenantId,
        assignedToUserId: userId,
        ...crmCampaignMemberQueueLiveContactWhere,
        ...crmCallbackUpcomingOrUnsetWhere(startOfTomorrow, campaignFilter),
      };
    } else if (filter === "all") {
      whereClause = {
        tenantId,
        assignedToUserId: userId,
        ...crmCampaignMemberQueueLiveContactWhere,
        ...crmMemberQueueNonTerminalWhere(campaignFilter),
      };
    } else {
      // default: pending
      // smart sort expands to include CALLBACK so overdue/due callbacks appear first
      whereClause = {
        tenantId,
        assignedToUserId: userId,
        ...crmCampaignMemberQueueLiveContactWhere,
        ...crmQueueFilterPendingWhere(campaignFilter, sortMode === "smart"),
      };
    }

    // ── Smart in-process ranking ──────────────────────────────────────────────
    // Composite score (lower = higher priority):
    //   Callback tiers (never overridden by campaign priority):
    //     0  overdue callback  (callbackAt < now)
    //    10  due today         (callbackAt <= endOfToday)
    //    20  upcoming callback (callbackAt in next 7 days)
    //   Lead tiers (campaign priority is a tie-breaker within each):
    //     Tier 30–33  fresh lead (attemptCount === 0), URGENT→LOW
    //     Tier 40–43  low-attempt lead (1–3 attempts), URGENT→LOW
    //     Tier 50–53  stale lead (>3 attempts), URGENT→LOW
    //   Campaign priority offset: URGENT=0, HIGH=1, NORMAL=2, LOW=3
    // Guarantees: overdue callbacks always beat any lead, due-today always beat upcoming,
    // urgent fresh leads beat normal fresh leads, but never beat any callback tier.
    const PRIORITY_OFFSET: Record<string, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

    function smartTier(m: { status: string; callbackAt: Date | null; attemptCount: number; campaign?: { priority?: string } | null }): number {
      if (m.status === "CALLBACK" && m.callbackAt) {
        if (m.callbackAt < now) return 0;
        if (m.callbackAt <= endOfToday) return 10;
        return 20;
      }
      const pOffset = PRIORITY_OFFSET[m.campaign?.priority ?? "NORMAL"] ?? 2;
      if (m.attemptCount === 0) return 30 + pOffset;
      if (m.attemptCount <= 3) return 40 + pOffset;
      return 50 + pOffset;
    }

    const SMART_CANDIDATE_CAP = 500;

    if (sortMode === "smart") {
      // Fetch candidates up to the cap, then rank in-process, then slice.
      const candidates = await db.crmCampaignMember.findMany({
        where: whereClause,
        orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }],
        take: SMART_CANDIDATE_CAP,
        include: {
          ...MEMBER_INCLUDE,
          campaign: { select: { id: true, name: true, priority: true, scriptId: true, checklistId: true } },
        },
      });

      candidates.sort((a, b) => {
        const ta = smartTier(a);
        const tb = smartTier(b);
        if (ta !== tb) return ta - tb;
        // Within tier: callbacks by callbackAt ASC (most overdue first); leads by sortOrder/createdAt
        if (ta <= 20 && a.callbackAt && b.callbackAt) {
          return a.callbackAt.getTime() - b.callbackAt.getTime();
        }
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

      const total = candidates.length;
      const page = candidates.slice(0, limit);
      const formatted = page.map((m) => ({
        ...formatMember(m),
        campaign: m.campaign ? {
          id: m.campaign.id,
          name: m.campaign.name,
          priority: m.campaign.priority ?? "NORMAL",
          scriptId: m.campaign.scriptId,
          checklistId: m.campaign.checklistId,
        } : null,
      }));

      const [pendingCount, dueCount, overdueCount, upcomingCount] = await Promise.all([
        db.crmCampaignMember.count({
          where: {
            tenantId,
            assignedToUserId: userId,
            ...crmCampaignMemberQueueLiveContactWhere,
            ...crmMemberPendingOrInProgressWhere(campaignFilter),
          },
        }),
        db.crmCampaignMember.count({
          where: {
            tenantId,
            assignedToUserId: userId,
            ...crmCampaignMemberQueueLiveContactWhere,
            ...crmCallbackDueLteDayEndWhere(endOfToday, campaignFilter),
          },
        }),
        db.crmCampaignMember.count({
          where: {
            tenantId,
            assignedToUserId: userId,
            ...crmCampaignMemberQueueLiveContactWhere,
            ...crmCallbackOverdueWhere(startOfToday, campaignFilter),
          },
        }),
        db.crmCampaignMember.count({
          where: {
            tenantId,
            assignedToUserId: userId,
            ...crmCampaignMemberQueueLiveContactWhere,
            ...crmCallbackUpcomingOrUnsetWhere(startOfTomorrow, campaignFilter),
          },
        }),
      ]);

      return {
        queue: formatted,
        total,
        sort: "smart",
        campaignId: campaignIdParam ?? null,
        counts: { pending: pendingCount, due: dueCount, overdue: overdueCount, upcoming: upcomingCount },
      };
    }

    // ── Original (stable DB) ordering ─────────────────────────────────────────
    const orderBy =
      (filter === "due" || filter === "overdue" || filter === "upcoming")
        ? [{ callbackAt: "asc" as const }, { sortOrder: "asc" as const }]
        : [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }];

    const [members, total] = await Promise.all([
      db.crmCampaignMember.findMany({
        where: whereClause,
        orderBy,
        take: limit,
        include: {
          ...MEMBER_INCLUDE,
          campaign: { select: { id: true, name: true, priority: true, scriptId: true, checklistId: true } },
        },
      }),
      db.crmCampaignMember.count({ where: whereClause }),
    ]);

    const formatted = members.map((m) => ({
      ...formatMember(m),
      campaign: m.campaign ? {
        id: m.campaign.id,
        name: m.campaign.name,
        priority: m.campaign.priority ?? "NORMAL",
        scriptId: m.campaign.scriptId,
        checklistId: m.campaign.checklistId,
      } : null,
    }));

    // Per-tab counts respect the campaign filter so badge counts are scoped correctly
    const [pendingCount, dueCount, overdueCount, upcomingCount] = await Promise.all([
      db.crmCampaignMember.count({
        where: {
          tenantId,
          assignedToUserId: userId,
          ...crmCampaignMemberQueueLiveContactWhere,
          ...crmMemberPendingOrInProgressWhere(campaignFilter),
        },
      }),
      db.crmCampaignMember.count({
        where: {
          tenantId,
          assignedToUserId: userId,
          ...crmCampaignMemberQueueLiveContactWhere,
          ...crmCallbackDueLteDayEndWhere(endOfToday, campaignFilter),
        },
      }),
      db.crmCampaignMember.count({
        where: {
          tenantId,
          assignedToUserId: userId,
          ...crmCampaignMemberQueueLiveContactWhere,
          ...crmCallbackOverdueWhere(startOfToday, campaignFilter),
        },
      }),
      db.crmCampaignMember.count({
        where: {
          tenantId,
          assignedToUserId: userId,
          ...crmCampaignMemberQueueLiveContactWhere,
          ...crmCallbackUpcomingOrUnsetWhere(startOfTomorrow, campaignFilter),
        },
      }),
    ]);

    return {
      queue: formatted,
      total,
      sort: "original",
      campaignId: campaignIdParam ?? null,
      counts: { pending: pendingCount, due: dueCount, overdue: overdueCount, upcoming: upcomingCount },
    };
  });

  // ── POST /crm/queue/next ──────────────────────────────────────────────────
  // Returns the next PENDING queue item for the current user; sets it to IN_PROGRESS.
  app.post("/crm/queue/next", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId, role } = user;

    const campaignScope = await crmCampaignScopeForUser(tenantId, userId, role);

    const next = await db.crmCampaignMember.findFirst({
      where: {
        tenantId,
        assignedToUserId: userId,
        status: "PENDING",
        ...crmCampaignMemberQueueLiveContactWhere,
        campaign: { status: "ACTIVE", ...campaignScope },
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: {
        ...MEMBER_INCLUDE,
        campaign: { select: { id: true, name: true, scriptId: true, checklistId: true } },
      },
    });

    if (!next) return { member: null, message: "Queue is empty" };

    const updated = await db.crmCampaignMember.update({
      where: { id: next.id },
      data: { status: "IN_PROGRESS" },
      include: {
        ...MEMBER_INCLUDE,
        campaign: { select: { id: true, name: true, scriptId: true, checklistId: true } },
      },
    });

    return {
      member: {
        ...formatMember(updated),
        campaign: updated.campaign ? { id: updated.campaign.id, name: updated.campaign.name, scriptId: updated.campaign.scriptId, checklistId: updated.campaign.checklistId } : null,
      },
    };
  });

  // ── PATCH /crm/queue/:memberId ────────────────────────────────────────────
  // Quick update for queue actions: skip, defer, mark DNC, increment attempt.
  // Also accepts outcome-based status mappings from live workspace.
  app.patch("/crm/queue/:memberId", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;
    const { memberId } = req.params as { memberId: string };

    // Tenant scope + ownership: non-admins may only PATCH members assigned to them
    // (except assign-to-me on unassigned rows). See isCrmQueuePatchOwnershipForbidden.
    const existing = await db.crmCampaignMember.findFirst({
      where: { id: memberId, tenantId },
      select: {
        id: true,
        assignedToUserId: true,
        sortOrder: true,
        attemptCount: true,
        campaignId: true,
        contact: { select: { active: true, archivedAt: true } },
      },
    });
    if (!existing) return reply.code(404).send({ error: "not_found" });

    if (!(await assertCrmCampaignAllowed(user, existing.campaignId, reply))) return;

    const queueActionSchema = z.object({
      action: z.enum(["skip", "defer", "dnc", "outcome", "assign-to-me", "set-callback", "clear-callback"]).optional(),
      status: z.enum(MEMBER_STATUSES).optional(),
      disposition: z.string().optional(), // from outcome save — mapped to status
      callbackAt: z.string().datetime({ offset: true }).optional().nullable(),
      callbackNote: z.string().max(1000).optional().nullable(),
    });

    const parsed = queueActionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.issues });

    if (
      isCrmQueuePatchOwnershipForbidden(user.role, userId, existing.assignedToUserId, {
        action: parsed.data.action,
        status: parsed.data.status,
      })
    ) {
      return reply.code(403).send({
        error: "crm_queue_member_forbidden",
        detail: "You may only update queue members assigned to you",
      });
    }

    const contactLive = !!(existing.contact?.active && existing.contact.archivedAt == null);
    if (!contactLive && !isAdminRole(user.role)) {
      return reply.code(409).send({
        error: "crm_queue_contact_not_live",
        detail: "This contact is archived or inactive and is not live queue work.",
      });
    }

    const now = new Date();
    let updateData: Record<string, any> = {};

    if (parsed.data.action === "skip") {
      updateData = { status: "SKIPPED" };
    } else if (parsed.data.action === "defer") {
      // Move to end of queue — find max sortOrder and add 1
      const maxOrder = await db.crmCampaignMember.aggregate({
        where: { campaignId: existing.campaignId, tenantId },
        _max: { sortOrder: true },
      });
      updateData = { status: "PENDING", sortOrder: (maxOrder._max.sortOrder ?? 0) + 1 };
    } else if (parsed.data.action === "dnc") {
      updateData = { status: "DO_NOT_CALL" };
    } else if (parsed.data.action === "assign-to-me") {
      updateData = { assignedToUserId: userId };
    } else if (parsed.data.action === "set-callback") {
      updateData = {
        status: "CALLBACK",
        callbackAt: parsed.data.callbackAt ? new Date(parsed.data.callbackAt) : null,
        callbackNote: parsed.data.callbackNote ?? null,
      };
    } else if (parsed.data.action === "clear-callback") {
      updateData = { callbackAt: null, callbackNote: null, status: "PENDING" };
    } else if (parsed.data.action === "outcome" && parsed.data.disposition) {
      // Map disposition string to member status
      const d = parsed.data.disposition.toLowerCase();
      let memberStatus: string = "CONTACTED";
      if (d.includes("convert") || d.includes("closed") || d === "closed") memberStatus = "CONVERTED";
      else if (d.includes("callback")) memberStatus = "CALLBACK";
      else if (d.includes("not interest") || d.includes("dnc")) memberStatus = "DO_NOT_CALL";
      updateData = {
        status: memberStatus,
        attemptCount: existing.attemptCount + 1,
        lastAttemptAt: now,
      };
    } else if (parsed.data.status) {
      updateData = { status: parsed.data.status };
      // Increment attempt when updating status to a worked state
      if (["CONTACTED", "CALLBACK", "CONVERTED"].includes(parsed.data.status)) {
        updateData.attemptCount = existing.attemptCount + 1;
        updateData.lastAttemptAt = now;
      }
      // Support callbackAt/callbackNote alongside explicit status update
      if (parsed.data.callbackAt !== undefined) {
        updateData.callbackAt = parsed.data.callbackAt ? new Date(parsed.data.callbackAt) : null;
      }
      if (parsed.data.callbackNote !== undefined) {
        updateData.callbackNote = parsed.data.callbackNote;
      }
    }

    if (Object.keys(updateData).length === 0) {
      return reply.code(400).send({ error: "no_update_data" });
    }

    const member = await db.crmCampaignMember.update({
      where: { id: memberId },
      data: updateData,
      include: MEMBER_INCLUDE,
    });

    // Non-blocking auto-complete check when a terminal status is applied
    const newStatus = (updateData.status as string | undefined) ?? "";
    if (["CONTACTED", "CONVERTED", "SKIPPED", "DO_NOT_CALL"].includes(newStatus)) {
      checkAndAutoCompleteCampaign(existing.campaignId, tenantId).catch(() => {});
    }

    return { member: formatMember(member) };
  });
}
