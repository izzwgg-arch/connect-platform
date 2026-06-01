import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import { requireCrmAccess } from "./guard";
import { assertCrmCampaignAllowed } from "./userCampaignAccess";
import {
  CRM_IMPORT_MAX_FILE_BYTES,
  CRM_IMPORT_MAX_ROWS,
  parseCsv,
  autoMapHeaders,
  mappingHasPhoneOrEmail,
  processImportRow,
  readCrmImportMultipart,
  displayFileNameFromCrmImportBatchStoredName,
  parseCrmImportBatchCampaignId,
  type CrmImportField,
  type RowData,
} from "./importPipeline";
import { normalizeForMatch } from "./driveMatchService";

// ── Route registrar ────────────────────────────────────────────────────────────

export async function registerCrmImportRoutes(app: FastifyInstance) {
  // ── POST /crm/import/upload ──────────────────────────────────────────────
  // Accepts a CSV file (multipart/form-data, field name: "file").
  // Parses, auto-maps columns, processes rows, returns completed batch.
  app.post("/crm/import/upload", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;

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
      return reply.status(400).send({ error: "invalid_file_type", detail: "Only CSV files are supported. XLSX coming soon." });
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

    const campaignId = (fields.campaignId ?? "").trim();
    const assignToMe = (fields.assignToMe ?? fields.assignImportedToMe ?? "").trim() === "true";

    if (assignToMe && !campaignId) {
      return reply.status(400).send({
        error: "campaign_required",
        detail: "Choose a destination campaign to add imported leads to My Queue.",
      });
    }

    if (campaignId) {
      if (!(await assertCrmCampaignAllowed(user, campaignId, reply))) return;
      const campaign = await db.crmCampaign.findFirst({
        where: { id: campaignId, tenantId },
        select: { id: true, status: true },
      });
      if (!campaign) return reply.status(404).send({ error: "not_found" });
      if (campaign.status !== "ACTIVE") {
        return reply.status(400).send({
          error: "campaign_not_active",
          detail: "My Queue only shows leads from active campaigns.",
        });
      }
    }

    const batch = await db.crmImportBatch.create({
      data: {
        tenantId,
        fileName,
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
    let auditErrorCount = 0;
    let addedMembers = 0;
    let assignedMembers = 0;
    let contactAssignments = 0;
    let skippedAssigned = 0;
    const errors: { row: number; reason: string }[] = [];
    const importedContactIds: string[] = [];

    for (let i = 0; i < dataRows.length; i++) {
      const rawRow = dataRows[i];
      const rowData: RowData = {};
      for (const [colIdx, fieldKey] of Object.entries(colMapping) as [string, CrmImportField][]) {
        const val = rawRow[parseInt(colIdx, 10)]?.trim() ?? "";
        if (val) rowData[fieldKey] = val;
      }

      try {
        const result = await processImportRow(tenantId, userId, rowData);
        if (result.action === "created") createdCount++;
        else if (result.action === "updated") updatedCount++;
        else {
          skippedCount++;
          errors.push({ row: i + 2, reason: result.reason ?? "skipped" });
        }
        if (result.contactId) importedContactIds.push(result.contactId);

        // Write per-row audit record for Drive matching. Awaited — Drive matching
        // depends on these rows. Failure is counted and surfaced in batch response.
        const companyName = rowData.company?.trim() || null;
        try {
          await db.crmImportBatchRow.create({
            data: {
              tenantId,
              batchId: batch.id,
              rowNumber: i + 2,
              contactId: result.contactId ?? null,
              companyName,
              companyNameNormalized: companyName ? normalizeForMatch(companyName) || null : null,
              action: result.action,
            },
          });
        } catch (auditErr: any) {
          auditErrorCount++;
          app.log.error(
            { batchId: batch.id, rowNumber: i + 2, err: auditErr?.message },
            "crm_import_audit_row_write_failed",
          );
        }
      } catch (err: any) {
        errorCount++;
        errors.push({ row: i + 2, reason: err?.message ?? "unknown_error" });
      }
    }

    if (assignToMe && campaignId) {
      const uniqueContactIds = [...new Set(importedContactIds)];
      if (uniqueContactIds.length > 0) {
        const contacts = await db.contact.findMany({
          where: {
            id: { in: uniqueContactIds },
            tenantId,
            active: true,
            archivedAt: null,
            crmMeta: { isNot: null },
          },
          select: { id: true, crmMeta: { select: { assignedToUserId: true } } },
        });
        const ownedByOther = new Set(
          contacts
            .filter((contact) => contact.crmMeta?.assignedToUserId && contact.crmMeta.assignedToUserId !== userId)
            .map((contact) => contact.id),
        );
        const eligibleContactIds = contacts.map((contact) => contact.id).filter((id) => !ownedByOther.has(id));
        skippedAssigned += ownedByOther.size;

        if (eligibleContactIds.length > 0) {
          const existingMembers = await db.crmCampaignMember.findMany({
            where: { tenantId, campaignId, contactId: { in: eligibleContactIds } },
            select: { id: true, contactId: true, assignedToUserId: true },
          });
          const existingByContactId = new Map(existingMembers.map((member) => [member.contactId, member]));
          const memberIdsToAssign = existingMembers
            .filter((member) => member.assignedToUserId === null || member.assignedToUserId === userId)
            .map((member) => member.id);
          skippedAssigned += existingMembers.filter(
            (member) => member.assignedToUserId && member.assignedToUserId !== userId,
          ).length;
          const contactIdsToCreate = eligibleContactIds.filter((id) => !existingByContactId.has(id));

          await db.$transaction(async (tx) => {
            if (memberIdsToAssign.length > 0) {
              const assigned = await tx.crmCampaignMember.updateMany({
                where: {
                  id: { in: memberIdsToAssign },
                  tenantId,
                  OR: [{ assignedToUserId: null }, { assignedToUserId: userId }],
                },
                data: { assignedToUserId: userId },
              });
              assignedMembers = assigned.count;
            }

            if (contactIdsToCreate.length > 0) {
              const maxOrder = await tx.crmCampaignMember.aggregate({
                where: { tenantId, campaignId },
                _max: { sortOrder: true },
              });
              const baseOrder = (maxOrder._max.sortOrder ?? -1) + 1;
              const created = await tx.crmCampaignMember.createMany({
                data: contactIdsToCreate.map((contactId, idx) => ({
                  tenantId,
                  campaignId,
                  contactId,
                  assignedToUserId: userId,
                  status: "PENDING" as const,
                  attemptCount: 0,
                  sortOrder: baseOrder + idx,
                })),
                skipDuplicates: true,
              });
              addedMembers = created.count;
            }

            const meta = await tx.crmContactMeta.updateMany({
              where: {
                tenantId,
                contactId: { in: eligibleContactIds },
                OR: [{ assignedToUserId: null }, { assignedToUserId: userId }],
              },
              data: { assignedToUserId: userId },
            });
            contactAssignments = meta.count;
          });
        }
      }
    }

    const finalStatus =
      errorCount > 0 && createdCount + updatedCount === 0
        ? "FAILED"
        : errorCount > 0 || skippedCount > 0
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
        auditErrorCount,
        errors: errors as any,
        completedAt: new Date(),
      },
    });

    return {
      batchId: completed.id,
      fileName,
      status: completed.status,
      totalRows: completed.totalRows,
      createdCount,
      updatedCount,
      skippedCount,
      errorCount,
      auditErrorCount,
      campaignId: campaignId || null,
      assignedToUserId: assignToMe ? userId : null,
      addedMembers,
      assignedMembers,
      contactAssignments,
      skippedAssigned,
      errors: errors.slice(0, 50),
      detectedHeaders: headers,
      mapping: colMapping,
    };
  });

  // ── GET /crm/import/batches ──────────────────────────────────────────────
  app.get("/crm/import/batches", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const q = req.query as Record<string, string>;
    const page = Math.max(0, parseInt(q.page ?? "0", 10));
    const limit = Math.min(50, Math.max(1, parseInt(q.limit ?? "20", 10)));

    const [batches, total] = await Promise.all([
      db.crmImportBatch.findMany({
        where: { tenantId },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: page * limit,
        include: {
          createdBy: {
            select: { id: true, firstName: true, lastName: true, displayName: true, email: true },
          },
        },
      }),
      db.crmImportBatch.count({ where: { tenantId } }),
    ]);

    return {
      batches: batches.map(formatBatch),
      total,
      page,
      limit,
    };
  });

  // ── GET /crm/import/batches/:id ──────────────────────────────────────────
  // Includes auditRowCount: how many CrmImportBatchRow rows exist for this batch.
  // Non-zero auditErrorCount with auditRowCount < processedRows means some rows
  // were not captured — Drive matching will be incomplete for those rows.
  app.get("/crm/import/batches/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const [batch, auditRowCount] = await Promise.all([
      db.crmImportBatch.findFirst({
        where: { id, tenantId },
        include: {
          createdBy: {
            select: { id: true, firstName: true, lastName: true, displayName: true, email: true },
          },
        },
      }),
      db.crmImportBatchRow.count({ where: { batchId: id, tenantId } }),
    ]);

    if (!batch) return reply.status(404).send({ error: "not_found" });

    return { ...formatBatch(batch), auditRowCount };
  });
}

function formatBatch(b: any) {
  const campaignId = parseCrmImportBatchCampaignId(b.fileName);
  return {
    id: b.id,
    fileName: displayFileNameFromCrmImportBatchStoredName(b.fileName),
    importSource: campaignId ? "campaign" : ("standalone" as const),
    campaignId,
    status: b.status as string,
    totalRows: b.totalRows,
    processedRows: b.processedRows,
    createdCount: b.createdCount,
    updatedCount: b.updatedCount,
    skippedCount: b.skippedCount,
    errorCount: b.errorCount,
    /// Non-zero means some CrmImportBatchRow writes failed; Drive matching may miss those rows.
    auditErrorCount: b.auditErrorCount ?? 0,
    errors: b.errors ?? [],
    mapping: b.mapping ?? null,
    createdAt: b.createdAt,
    completedAt: b.completedAt ?? null,
    createdBy: b.createdBy
      ? {
          id: b.createdBy.id,
          displayName:
            b.createdBy.displayName ||
            [b.createdBy.firstName, b.createdBy.lastName].filter(Boolean).join(" ") ||
            b.createdBy.email,
        }
      : null,
  };
}
