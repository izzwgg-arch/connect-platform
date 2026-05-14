import type { FastifyRequest } from "fastify";
import { db } from "@connect/db";

// ── Constants (shared with standalone + campaign import) ─────────────────────

export const CRM_IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
export const CRM_IMPORT_MAX_ROWS = 5_000;

// ── CSV parser ───────────────────────────────────────────────────────────────

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let pos = 0;
  const len = lines.length;

  while (pos < len) {
    const row: string[] = [];
    while (pos < len) {
      if (lines[pos] === '"') {
        pos++;
        let field = "";
        while (pos < len) {
          if (lines[pos] === '"') {
            if (lines[pos + 1] === '"') {
              field += '"';
              pos += 2;
            } else {
              pos++;
              break;
            }
          } else {
            field += lines[pos++];
          }
        }
        row.push(field);
        if (pos < len && lines[pos] === ",") pos++;
      } else {
        let start = pos;
        while (pos < len && lines[pos] !== "," && lines[pos] !== "\n") {
          pos++;
        }
        row.push(lines.slice(start, pos).trim());
        if (pos < len && lines[pos] === ",") pos++;
      }
      if (pos < len && lines[pos] === "\n") {
        pos++;
        break;
      }
    }
    if (row.length > 0 && !(row.length === 1 && row[0] === "")) {
      rows.push(row);
    }
  }

  return rows;
}

// ── Field mapping ───────────────────────────────────────────────────────────

export type CrmImportField =
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
  "first name": "firstName",
  firstname: "firstName",
  first_name: "firstName",
  fname: "firstName",
  "last name": "lastName",
  lastname: "lastName",
  last_name: "lastName",
  lname: "lastName",
  surname: "lastName",
  name: "displayName",
  "full name": "displayName",
  fullname: "displayName",
  full_name: "displayName",
  "contact name": "displayName",
  contact: "displayName",
  "customer name": "displayName",
  "lead name": "displayName",
  company: "company",
  organization: "company",
  organisation: "company",
  org: "company",
  "business name": "company",
  business: "company",
  account: "company",
  "account name": "company",
  title: "title",
  "job title": "title",
  position: "title",
  role: "title",
  phone: "phone",
  "phone number": "phone",
  mobile: "phone",
  "mobile number": "phone",
  cell: "phone",
  "cell phone": "phone",
  telephone: "phone",
  number: "phone",
  "phone 1": "phone",
  "primary phone": "phone",
  direct: "phone",
  email: "email",
  "email address": "email",
  "e-mail": "email",
  mail: "email",
  notes: "notes",
  note: "notes",
  description: "notes",
  memo: "notes",
  comments: "notes",
  tags: "tags",
  tag: "tags",
  labels: "tags",
  label: "tags",
  category: "tags",
};

export function autoMapHeaders(headers: string[]): Record<number, CrmImportField> {
  const mapping: Record<number, CrmImportField> = {};
  for (let i = 0; i < headers.length; i++) {
    const key = headers[i].toLowerCase().trim();
    const mapped = COLUMN_ALIASES[key];
    if (mapped && !Object.values(mapping).includes(mapped)) {
      mapping[i] = mapped;
    }
  }
  return mapping;
}

export function mappingHasPhoneOrEmail(colMapping: Record<number, CrmImportField>): boolean {
  const mappedFields = Object.values(colMapping);
  return mappedFields.includes("phone") || mappedFields.includes("email");
}

export type RowData = Partial<Record<CrmImportField, string>>;

export interface ProcessRowResult {
  action: "created" | "updated" | "skipped";
  reason?: string;
  contactId?: string | null;
}

function normalisePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Create or update a CRM contact from one import row. Dedupes by normalized phone
 * or email within the tenant (same rules as standalone CRM import).
 */
export async function processImportRow(
  tenantId: string,
  userId: string,
  data: RowData,
): Promise<ProcessRowResult> {
  const phoneRaw = data.phone?.trim() ?? "";
  const emailRaw = data.email?.trim().toLowerCase() ?? "";
  const phoneNorm = normalisePhone(phoneRaw);

  if (!phoneNorm && !emailRaw) {
    return { action: "skipped", reason: "no_contact_info", contactId: null };
  }

  const firstName = data.firstName?.trim() ?? "";
  const lastName = data.lastName?.trim() ?? "";
  const displayName =
    data.displayName?.trim() ||
    [firstName, lastName].filter(Boolean).join(" ") ||
    phoneRaw ||
    emailRaw;

  let existingContactId: string | null = null;

  if (phoneNorm) {
    const phoneMatch = await db.contactPhone.findFirst({
      where: {
        numberNormalized: phoneNorm,
        contact: { tenantId, active: true },
      },
      select: { contactId: true },
    });
    if (phoneMatch) existingContactId = phoneMatch.contactId;
  }

  if (!existingContactId && emailRaw) {
    const emailMatch = await db.contactEmail.findFirst({
      where: {
        email: emailRaw,
        contact: { tenantId, active: true },
      },
      select: { contactId: true },
    });
    if (emailMatch) existingContactId = emailMatch.contactId;
  }

  if (existingContactId) {
    const existing = await db.contact.findUnique({
      where: { id: existingContactId },
      select: { firstName: true, lastName: true, company: true, title: true, notes: true },
    });
    if (!existing) {
      return { action: "skipped", reason: "contact_missing", contactId: null };
    }

    const contactPatch: Record<string, unknown> = {};
    if (!existing.firstName && firstName) contactPatch.firstName = firstName;
    if (!existing.lastName && lastName) contactPatch.lastName = lastName;
    if (!existing.company && data.company?.trim()) contactPatch.company = data.company.trim();
    if (!existing.title && data.title?.trim()) contactPatch.title = data.title.trim();
    if (!existing.notes && data.notes?.trim()) contactPatch.notes = data.notes.trim();

    if (Object.keys(contactPatch).length > 0) {
      await db.contact.update({
        where: { id: existingContactId },
        data: contactPatch,
      });
    }

    await db.crmContactMeta.upsert({
      where: { contactId: existingContactId },
      create: { contactId: existingContactId, tenantId, stage: "LEAD" },
      update: {},
    });

    if (phoneNorm && phoneRaw) {
      const phoneExists = await db.contactPhone.findFirst({
        where: { contactId: existingContactId, numberNormalized: phoneNorm },
        select: { id: true },
      });
      if (!phoneExists) {
        await db.contactPhone.create({
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

    if (emailRaw) {
      const emailExists = await db.contactEmail.findFirst({
        where: { contactId: existingContactId, email: emailRaw },
        select: { id: true },
      });
      if (!emailExists) {
        await db.contactEmail.create({
          data: {
            contactId: existingContactId,
            type: "WORK",
            email: emailRaw,
            isPrimary: false,
          },
        });
      }
    }

    return { action: "updated", contactId: existingContactId };
  }

  const contact = await db.contact.create({
    data: {
      tenantId,
      type: "EXTERNAL",
      source: "IMPORTED",
      displayName,
      firstName: firstName || null,
      lastName: lastName || null,
      company: data.company?.trim() || null,
      title: data.title?.trim() || null,
      notes: data.notes?.trim() || null,
      createdBy: userId,
      phones: phoneNorm
        ? {
            create: [
              {
                type: "MOBILE",
                numberRaw: phoneRaw,
                numberNormalized: phoneNorm,
                isPrimary: true,
              },
            ],
          }
        : undefined,
      emails: emailRaw
        ? {
            create: [
              {
                type: "WORK",
                email: emailRaw,
                isPrimary: true,
              },
            ],
          }
        : undefined,
      crmMeta: {
        create: { tenantId, stage: "LEAD" },
      },
    },
    select: { id: true },
  });

  return { action: "created", contactId: contact.id };
}

/** Read multipart form: file field "file" + optional text fields. */
export async function readCrmImportMultipart(req: FastifyRequest): Promise<{
  fileBuf: Buffer;
  fileName: string;
  fields: Record<string, string>;
}> {
  let fileBuf: Buffer | null = null;
  let fileName = "import.csv";
  const fields: Record<string, string> = {};

  const parts = (req as any).parts();
  for await (const part of parts as AsyncIterable<any>) {
    if (part.type === "file" && part.fieldname === "file") {
      fileName = String(part.filename || fileName);
      fileBuf = await part.toBuffer();
    } else if (part.type === "field") {
      const fn = String(part.fieldname || "");
      if (fn) fields[fn] = String((part as { value?: string }).value ?? "").trim();
    }
  }

  if (!fileBuf || fileBuf.length === 0) {
    throw Object.assign(new Error("file_required"), { code: "file_required" });
  }

  return { fileBuf, fileName, fields };
}
