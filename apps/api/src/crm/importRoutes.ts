import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import { requireCrmAccess } from "./guard";

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_ROWS = 5_000;

// ── Lightweight CSV parser ─────────────────────────────────────────────────────
// Handles: quoted fields, commas inside quotes, "" escape sequences, CRLF/LF.
// Returns an array of rows, each row is an array of string values.

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let pos = 0;
  const len = lines.length;

  while (pos < len) {
    const row: string[] = [];
    // Parse one row
    while (pos < len) {
      if (lines[pos] === '"') {
        // Quoted field
        pos++; // skip opening "
        let field = "";
        while (pos < len) {
          if (lines[pos] === '"') {
            if (lines[pos + 1] === '"') {
              field += '"';
              pos += 2;
            } else {
              pos++; // skip closing "
              break;
            }
          } else {
            field += lines[pos++];
          }
        }
        row.push(field);
        // Skip comma or newline after closing quote
        if (pos < len && lines[pos] === ",") pos++;
      } else {
        // Unquoted field — read until comma or newline
        let start = pos;
        while (pos < len && lines[pos] !== "," && lines[pos] !== "\n") {
          pos++;
        }
        row.push(lines.slice(start, pos).trim());
        if (pos < len && lines[pos] === ",") pos++;
      }
      // End of row at newline
      if (pos < len && lines[pos] === "\n") {
        pos++;
        break;
      }
    }
    // Skip empty rows
    if (row.length > 0 && !(row.length === 1 && row[0] === "")) {
      rows.push(row);
    }
  }

  return rows;
}

// ── Field auto-mapping ─────────────────────────────────────────────────────────
// Maps CSV header strings (lowercased, trimmed) to canonical field names.

type CrmImportField =
  | "firstName"
  | "lastName"
  | "displayName"
  | "company"
  | "title"
  | "phone"
  | "email"
  | "notes"
  | "tags";

const COLUMN_ALIASES: Record<string, CrmImportField> = {
  "first name": "firstName", "firstname": "firstName", "first_name": "firstName", "fname": "firstName",
  "last name": "lastName", "lastname": "lastName", "last_name": "lastName", "lname": "lastName", "surname": "lastName",
  "name": "displayName", "full name": "displayName", "fullname": "displayName", "full_name": "displayName",
  "contact name": "displayName", "contact": "displayName", "customer name": "displayName", "lead name": "displayName",
  "company": "company", "organization": "company", "organisation": "company", "org": "company",
  "business name": "company", "business": "company", "account": "company", "account name": "company",
  "title": "title", "job title": "title", "position": "title", "role": "title",
  "phone": "phone", "phone number": "phone", "mobile": "phone", "mobile number": "phone",
  "cell": "phone", "cell phone": "phone", "telephone": "phone", "number": "phone",
  "phone 1": "phone", "primary phone": "phone", "direct": "phone",
  "email": "email", "email address": "email", "e-mail": "email", "mail": "email",
  "notes": "notes", "note": "notes", "description": "notes", "memo": "notes", "comments": "notes",
  "tags": "tags", "tag": "tags", "labels": "tags", "label": "tags", "category": "tags",
};

function autoMapHeaders(headers: string[]): Record<number, CrmImportField> {
  const mapping: Record<number, CrmImportField> = {};
  for (let i = 0; i < headers.length; i++) {
    const key = headers[i].toLowerCase().trim();
    const mapped = COLUMN_ALIASES[key];
    if (mapped && !(Object.values(mapping).includes(mapped))) {
      // Take first column that maps to each field (avoid duplicates)
      mapping[i] = mapped;
    }
  }
  return mapping;
}

// ── Phone normaliser (digits only) ────────────────────────────────────────────

function normalisePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

// ── Row processor ─────────────────────────────────────────────────────────────

type RowData = Partial<Record<CrmImportField, string>>;

interface ProcessResult {
  action: "created" | "updated" | "skipped";
  reason?: string;
}

async function processRow(
  tenantId: string,
  userId: string,
  data: RowData,
): Promise<ProcessResult> {
  // Require at minimum a phone or email to identify the contact
  const phoneRaw = data.phone?.trim() ?? "";
  const emailRaw = data.email?.trim().toLowerCase() ?? "";
  const phoneNorm = normalisePhone(phoneRaw);

  if (!phoneNorm && !emailRaw) {
    return { action: "skipped", reason: "no_contact_info" };
  }

  // Build display name from available fields
  const firstName = data.firstName?.trim() ?? "";
  const lastName = data.lastName?.trim() ?? "";
  const displayName = (
    data.displayName?.trim() ||
    [firstName, lastName].filter(Boolean).join(" ") ||
    phoneRaw ||
    emailRaw
  );

  // Attempt to find existing contact by phone or email (within tenant only)
  let existingContactId: string | null = null;

  if (phoneNorm) {
    const phoneMatch = await (db as any).contactPhone.findFirst({
      where: {
        numberNormalized: phoneNorm,
        contact: { tenantId, active: true },
      },
      select: { contactId: true },
    });
    if (phoneMatch) existingContactId = phoneMatch.contactId;
  }

  if (!existingContactId && emailRaw) {
    const emailMatch = await (db as any).contactEmail.findFirst({
      where: {
        email: emailRaw,
        contact: { tenantId, active: true },
      },
      select: { contactId: true },
    });
    if (emailMatch) existingContactId = emailMatch.contactId;
  }

  if (existingContactId) {
    // ── Update / enroll existing contact ──────────────────────────────────────
    const existing = await (db as any).contact.findUnique({
      where: { id: existingContactId },
      select: { firstName: true, lastName: true, company: true, title: true, notes: true },
    });

    // Non-destructive update: only fill blank fields
    const contactPatch: Record<string, unknown> = {};
    if (!existing.firstName && firstName) contactPatch.firstName = firstName;
    if (!existing.lastName && lastName) contactPatch.lastName = lastName;
    if (!existing.company && data.company?.trim()) contactPatch.company = data.company.trim();
    if (!existing.title && data.title?.trim()) contactPatch.title = data.title.trim();
    if (!existing.notes && data.notes?.trim()) contactPatch.notes = data.notes.trim();

    if (Object.keys(contactPatch).length > 0) {
      await (db as any).contact.update({
        where: { id: existingContactId },
        data: contactPatch,
      });
    }

    // Upsert CrmContactMeta — enroll in CRM if not already enrolled
    await (db as any).crmContactMeta.upsert({
      where: { contactId: existingContactId },
      create: { contactId: existingContactId, tenantId, stage: "LEAD" },
      update: {}, // Never downgrade an existing stage
    });

    // Add phone if not already present
    if (phoneNorm && phoneRaw) {
      const phoneExists = await (db as any).contactPhone.findFirst({
        where: { contactId: existingContactId, numberNormalized: phoneNorm },
        select: { id: true },
      });
      if (!phoneExists) {
        await (db as any).contactPhone.create({
          data: {
            contactId: existingContactId,
            type: "MOBILE",
            numberRaw: phoneRaw,
            numberNormalized: phoneNorm,
            isPrimary: false,
          },
        });
      }
    }

    // Add email if not already present
    if (emailRaw) {
      const emailExists = await (db as any).contactEmail.findFirst({
        where: { contactId: existingContactId, email: emailRaw },
        select: { id: true },
      });
      if (!emailExists) {
        await (db as any).contactEmail.create({
          data: {
            contactId: existingContactId,
            type: "WORK",
            email: emailRaw,
            isPrimary: false,
          },
        });
      }
    }

    return { action: "updated" };
  }

  // ── Create new contact ─────────────────────────────────────────────────────
  await (db as any).contact.create({
    data: {
      tenantId,
      type: "EXTERNAL",
      source: "IMPORT",
      displayName,
      firstName: firstName || null,
      lastName: lastName || null,
      company: data.company?.trim() || null,
      title: data.title?.trim() || null,
      notes: data.notes?.trim() || null,
      createdBy: userId,
      phones: phoneNorm
        ? {
            create: [{
              type: "MOBILE",
              numberRaw: phoneRaw,
              numberNormalized: phoneNorm,
              isPrimary: true,
            }],
          }
        : undefined,
      emails: emailRaw
        ? {
            create: [{
              type: "WORK",
              email: emailRaw,
              isPrimary: true,
            }],
          }
        : undefined,
      crmMeta: {
        create: { tenantId, stage: "LEAD" },
      },
    },
  });

  return { action: "created" };
}

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

    // Read the uploaded file
    let fileBuf: Buffer | null = null;
    let fileName = "import.csv";
    try {
      const parts = (req as any).parts();
      for await (const part of (parts as AsyncIterable<any>)) {
        if (part.type === "file" && part.fieldname === "file") {
          fileName = String(part.filename || fileName);
          fileBuf = await part.toBuffer();
        }
      }
    } catch (err: any) {
      return reply.status(400).send({ error: "multipart_parse_failed", detail: err?.message });
    }

    if (!fileBuf || fileBuf.length === 0) {
      return reply.status(400).send({ error: "file_required" });
    }
    if (fileBuf.length > MAX_FILE_BYTES) {
      return reply.status(413).send({ error: "file_too_large", limitMb: 5 });
    }

    // Validate CSV extension
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    if (ext !== "csv") {
      return reply.status(400).send({ error: "invalid_file_type", detail: "Only CSV files are supported. XLSX coming soon." });
    }

    // Parse CSV
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
    const dataRows = rows.slice(1).slice(0, MAX_ROWS);

    if (dataRows.length === 0) {
      return reply.status(400).send({ error: "csv_no_data_rows" });
    }

    // Auto-map headers
    const colMapping = autoMapHeaders(headers);

    // Validate at least one usable column
    const mappedFields = Object.values(colMapping);
    if (!mappedFields.includes("phone") && !mappedFields.includes("email")) {
      return reply.status(400).send({
        error: "no_usable_columns",
        detail: "CSV must have at least a 'phone' or 'email' column. Check column headers.",
        detectedHeaders: headers,
        expectedHeaders: ["first name", "last name", "company", "phone", "email", "notes", "tags"],
      });
    }

    // Create the batch record
    const batch = await (db as any).crmImportBatch.create({
      data: {
        tenantId,
        fileName,
        status: "PROCESSING",
        totalRows: dataRows.length,
        mapping: colMapping as any,
        createdByUserId: userId,
      },
    });

    // Process rows synchronously
    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors: { row: number; reason: string }[] = [];

    for (let i = 0; i < dataRows.length; i++) {
      const rawRow = dataRows[i];
      // Build field map from column mapping
      const rowData: RowData = {};
      for (const [colIdx, fieldKey] of Object.entries(colMapping) as [string, CrmImportField][]) {
        const val = rawRow[parseInt(colIdx, 10)]?.trim() ?? "";
        if (val) rowData[fieldKey] = val;
      }

      try {
        const result = await processRow(tenantId, userId, rowData);
        if (result.action === "created") createdCount++;
        else if (result.action === "updated") updatedCount++;
        else {
          skippedCount++;
          errors.push({ row: i + 2, reason: result.reason ?? "skipped" }); // +2: 1 for header, 1 for 1-index
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

    // Update batch with results
    const completed = await (db as any).crmImportBatch.update({
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
      errors: errors.slice(0, 50), // Return first 50 errors to keep response size sane
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
      (db as any).crmImportBatch.findMany({
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
      (db as any).crmImportBatch.count({ where: { tenantId } }),
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

    const batch = await (db as any).crmImportBatch.findFirst({
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

// ── Formatter ─────────────────────────────────────────────────────────────────

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
