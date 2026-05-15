import type { FastifyRequest } from "fastify";
import { db } from "@connect/db";

// ── Constants (shared with standalone + campaign import) ─────────────────────

export const CRM_IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
export const CRM_IMPORT_MAX_ROWS = 5_000;

/** Prefix stored on `CrmImportBatch.fileName` for `POST /crm/campaigns/:id/import` runs (tenant + id scoped in query). */
export function crmCampaignImportBatchFilePrefix(campaignId: string) {
  return `campaign:${campaignId}:`;
}

/** Human-readable CSV name for API/UI. Strips `campaign:{id}:` when present; standalone uploads unchanged. */
export function displayFileNameFromCrmImportBatchStoredName(storedFileName: string) {
  const m = /^campaign:([^:]+):([\s\S]*)$/.exec(storedFileName);
  return m ? m[2]! : storedFileName;
}

/** Campaign id when `storedFileName` was written by `POST /crm/campaigns/:id/import`; otherwise null. */
export function parseCrmImportBatchCampaignId(storedFileName: string): string | null {
  const m = /^campaign:([^:]+):[\s\S]*$/.exec(storedFileName);
  return m ? m[1]! : null;
}

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
 * Find an active CRM contact in the tenant by normalized phone, then email
 * (same precedence as import processing).
 */
export async function findLiveContactIdByPhoneOrEmail(
  tenantId: string,
  phoneNorm: string,
  emailRaw: string,
): Promise<string | null> {
  if (phoneNorm) {
    const phoneMatch = await db.contactPhone.findFirst({
      where: {
        numberNormalized: phoneNorm,
        contact: { tenantId, active: true },
      },
      select: { contactId: true },
    });
    if (phoneMatch) return phoneMatch.contactId;
  }
  if (emailRaw) {
    const emailMatch = await db.contactEmail.findFirst({
      where: {
        email: emailRaw,
        contact: { tenantId, active: true },
      },
      select: { contactId: true },
    });
    if (emailMatch) return emailMatch.contactId;
  }
  return null;
}

/** In-memory contacts “created” earlier in the same preview batch (mirrors sequential import). */
export class CampaignImportPreviewRegistry {
  private phoneToId = new Map<string, string>();
  private emailToId = new Map<string, string>();
  private seq = 0;

  lookup(phoneNorm: string, emailRaw: string): string | null {
    if (phoneNorm && this.phoneToId.has(phoneNorm)) return this.phoneToId.get(phoneNorm)!;
    if (emailRaw && this.emailToId.has(emailRaw)) return this.emailToId.get(emailRaw)!;
    return null;
  }

  /**
   * Register a synthetic contact for a row that would CREATE in the real pipeline.
   */
  createSyntheticFromRow(params: {
    phoneNorm: string;
    emailRaw: string;
  }): string {
    const id = `__preview_contact_${++this.seq}`;
    if (params.phoneNorm) this.phoneToId.set(params.phoneNorm, id);
    if (params.emailRaw) this.emailToId.set(params.emailRaw, id);
    return id;
  }

  /**
   * Second row with same phone/email hits the same synthetic id; register new aliases
   * if this row adds email to phone-only synthetic (or vice versa).
   */
  registerAliasesForExisting(contactId: string, phoneNorm: string, emailRaw: string) {
    if (phoneNorm && !this.phoneToId.has(phoneNorm)) this.phoneToId.set(phoneNorm, contactId);
    if (emailRaw && !this.emailToId.has(emailRaw)) this.emailToId.set(emailRaw, contactId);
  }
}

export type CampaignImportPreviewSampleRow = {
  row: number;
  phone?: string;
  email?: string;
  outcome: "create" | "update" | "skip";
  reason?: string;
  member: "would_add" | "skip_already_in_campaign" | "skip_duplicate_in_file" | "n_a";
};

export type CampaignImportPreviewResult = {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  wouldCreateContacts: number;
  wouldUpdateContacts: number;
  wouldAddMembers: number;
  wouldSkipExistingMembers: number;
  sampleRows: CampaignImportPreviewSampleRow[];
  errors: { row: number; reason: string }[];
};

/**
 * Simulate one import row for campaign preview: same resolution order as `processImportRow`,
 * plus in-batch synthetic creates. Does not write to the database.
 */
export async function previewCampaignImportRow(
  tenantId: string,
  campaignId: string,
  data: RowData,
  reg: CampaignImportPreviewRegistry,
): Promise<{
  process: ProcessRowResult;
  wouldAddMemberIfNotYetEnrolled: boolean;
  alreadyInCampaign: boolean;
}> {
  const phoneRaw = data.phone?.trim() ?? "";
  const emailRaw = data.email?.trim().toLowerCase() ?? "";
  const phoneNorm = normalisePhone(phoneRaw);

  if (!phoneNorm && !emailRaw) {
    return {
      process: { action: "skipped", reason: "no_contact_info", contactId: null },
      wouldAddMemberIfNotYetEnrolled: false,
      alreadyInCampaign: false,
    };
  }

  let existingContactId: string | null = await findLiveContactIdByPhoneOrEmail(tenantId, phoneNorm, emailRaw);
  let synthetic = false;
  if (!existingContactId) {
    const syn = reg.lookup(phoneNorm, emailRaw);
    if (syn) {
      existingContactId = syn;
      synthetic = true;
    }
  }

  const memberOutcomeForContactId = async (contactId: string) => {
    const mem = await db.crmCampaignMember.findFirst({
      where: { campaignId, contactId },
      select: { id: true },
    });
    if (mem) {
      return { wouldAddMemberIfNotYetEnrolled: false, alreadyInCampaign: true };
    }
    return { wouldAddMemberIfNotYetEnrolled: true, alreadyInCampaign: false };
  };

  if (existingContactId) {
    if (synthetic) {
      reg.registerAliasesForExisting(existingContactId, phoneNorm, emailRaw);
      const mo = await memberOutcomeForContactId(existingContactId);
      return {
        process: { action: "updated", contactId: existingContactId },
        wouldAddMemberIfNotYetEnrolled: mo.wouldAddMemberIfNotYetEnrolled,
        alreadyInCampaign: mo.alreadyInCampaign,
      };
    }

    const existing = await db.contact.findUnique({
      where: { id: existingContactId },
      select: { firstName: true, lastName: true, company: true, title: true, notes: true },
    });
    if (!existing) {
      return {
        process: { action: "skipped", reason: "contact_missing", contactId: null },
        wouldAddMemberIfNotYetEnrolled: false,
        alreadyInCampaign: false,
      };
    }

    const mo = await memberOutcomeForContactId(existingContactId);
    return {
      process: { action: "updated", contactId: existingContactId },
      wouldAddMemberIfNotYetEnrolled: mo.wouldAddMemberIfNotYetEnrolled,
      alreadyInCampaign: mo.alreadyInCampaign,
    };
  }

  const newId = reg.createSyntheticFromRow({ phoneNorm, emailRaw });
  return {
    process: { action: "created", contactId: newId },
    wouldAddMemberIfNotYetEnrolled: true,
    alreadyInCampaign: false,
  };
}

/**
 * Full campaign CSV preview: parse rows already extracted; mirrors enroll dedupe (`Set` of contact ids).
 */
export async function runCampaignImportPreview(
  tenantId: string,
  campaignId: string,
  _userId: string,
  dataRows: string[][],
  colMapping: Record<number, CrmImportField>,
): Promise<CampaignImportPreviewResult> {
  const reg = new CampaignImportPreviewRegistry();
  let wouldCreateContacts = 0;
  let wouldUpdateContacts = 0;
  let invalidRows = 0;
  const errors: { row: number; reason: string }[] = [];
  const sampleRows: CampaignImportPreviewSampleRow[] = [];
  let wouldAddMembers = 0;
  let wouldSkipExistingMembers = 0;
  const enrolledContactIds = new Set<string>();

  for (let i = 0; i < dataRows.length; i++) {
    const rawRow = dataRows[i];
    const rowData: RowData = {};
    for (const [colIdx, fieldKey] of Object.entries(colMapping) as [string, CrmImportField][]) {
      const val = rawRow[parseInt(colIdx, 10)]?.trim() ?? "";
      if (val) rowData[fieldKey] = val;
    }

    const rowNum = i + 2;
    try {
      const pr = await previewCampaignImportRow(tenantId, campaignId, rowData, reg);
      const cid = pr.process.contactId ?? null;
      const duplicateMemberInFile =
        !!cid &&
        enrolledContactIds.has(cid) &&
        !pr.alreadyInCampaign &&
        (pr.process.action === "created" || pr.process.action === "updated") &&
        pr.wouldAddMemberIfNotYetEnrolled;

      if (pr.process.action === "created") wouldCreateContacts++;
      else if (pr.process.action === "updated") wouldUpdateContacts++;
      else invalidRows++;

      if (pr.alreadyInCampaign) {
        wouldSkipExistingMembers++;
      } else if (
        (pr.process.action === "created" || pr.process.action === "updated") &&
        pr.process.contactId &&
        pr.wouldAddMemberIfNotYetEnrolled
      ) {
        if (!enrolledContactIds.has(pr.process.contactId)) {
          enrolledContactIds.add(pr.process.contactId);
          wouldAddMembers++;
        }
      }

      if (sampleRows.length < 25) {
        const phoneT = rowData.phone?.trim();
        const emailT = rowData.email?.trim();
        let member: CampaignImportPreviewSampleRow["member"] = "n_a";
        if (pr.process.action === "skipped") member = "n_a";
        else if (pr.alreadyInCampaign) member = "skip_already_in_campaign";
        else if (duplicateMemberInFile) member = "skip_duplicate_in_file";
        else if (pr.wouldAddMemberIfNotYetEnrolled && pr.process.contactId) member = "would_add";
        sampleRows.push({
          row: rowNum,
          ...(phoneT ? { phone: phoneT } : {}),
          ...(emailT ? { email: emailT } : {}),
          outcome: pr.process.action === "skipped" ? "skip" : pr.process.action === "created" ? "create" : "update",
          reason: pr.process.reason,
          member,
        });
      }
    } catch (err: unknown) {
      invalidRows++;
      const msg = err instanceof Error ? err.message : "unknown_error";
      if (errors.length < 25) errors.push({ row: rowNum, reason: msg });
    }
  }

  return {
    totalRows: dataRows.length,
    validRows: dataRows.length - invalidRows,
    invalidRows,
    wouldCreateContacts,
    wouldUpdateContacts,
    wouldAddMembers,
    wouldSkipExistingMembers,
    sampleRows,
    errors,
  };
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

  const existingContactId = await findLiveContactIdByPhoneOrEmail(tenantId, phoneNorm, emailRaw);

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
