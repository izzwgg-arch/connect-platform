import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import { requireCrmAccess } from "./guard";
import {
  CRM_IMPORT_MAX_FILE_BYTES,
  CRM_IMPORT_MAX_ROWS,
  parseCsv,
  autoMapHeaders,
  mappingHasPhoneOrEmail,
  processImportRow,
  readCrmImportMultipart,
  type CrmImportField,
  type RowData,
} from "./importPipeline";

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
    try {
      const read = await readCrmImportMultipart(req);
      fileBuf = read.fileBuf;
      fileName = read.fileName;
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
    const errors: { row: number; reason: string }[] = [];

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
      } catch (err: any) {
        errorCount++;
        errors.push({ row: i + 2, reason: err?.message ?? "unknown_error" });
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
  app.get("/crm/import/batches/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const batch = await db.crmImportBatch.findFirst({
      where: { id, tenantId },
      include: {
        createdBy: {
          select: { id: true, firstName: true, lastName: true, displayName: true, email: true },
        },
      },
    });

    if (!batch) return reply.status(404).send({ error: "not_found" });

    return formatBatch(batch);
  });
}

function formatBatch(b: any) {
  return {
    id: b.id,
    fileName: b.fileName,
    status: b.status as string,
    totalRows: b.totalRows,
    processedRows: b.processedRows,
    createdCount: b.createdCount,
    updatedCount: b.updatedCount,
    skippedCount: b.skippedCount,
    errorCount: b.errorCount,
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
