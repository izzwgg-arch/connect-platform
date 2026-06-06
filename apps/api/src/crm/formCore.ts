import * as crypto from "node:crypto";

export type CrmFormFieldInput = {
  id?: string;
  fieldType: "TEXT" | "DATE" | "CHECKBOX" | "SIGNATURE" | "INITIALS";
  label: string;
  /** Token key from CRM_FORM_MERGE_FIELDS, e.g. "contact.fullName", "business.dba" */
  autoFillToken?: string | null;
  required?: boolean;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export function hashFormToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateFormToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashFormToken(token) };
}

export function normalizeFieldInputs(fields: CrmFormFieldInput[]): CrmFormFieldInput[] {
  if (!Array.isArray(fields) || fields.length > 200) {
    throw Object.assign(new Error("invalid_fields"), { code: "invalid_fields" });
  }
  return fields.map((field, index) => {
    const label = String(field.label || "").trim();
    const fieldType = String(field.fieldType || "").toUpperCase();
    const numeric = [field.pageNumber, field.x, field.y, field.width, field.height].map(Number);
    if (!["TEXT", "DATE", "CHECKBOX", "SIGNATURE", "INITIALS"].includes(fieldType)) throw new Error("invalid_field_type");
    if (!label || label.length > 160) throw new Error("invalid_field_label");
    if (!numeric.every(Number.isFinite)) throw new Error("invalid_field_position");
    if (numeric[0]! < 1 || numeric[3]! <= 0 || numeric[4]! <= 0) throw new Error("invalid_field_position");
    const rawToken = typeof field.autoFillToken === "string" ? field.autoFillToken.trim() : null;
    return {
      fieldType: fieldType as CrmFormFieldInput["fieldType"],
      label,
      autoFillToken: rawToken || null,
      required: Boolean(field.required),
      pageNumber: Math.trunc(numeric[0]!),
      x: numeric[1]!,
      y: numeric[2]!,
      width: numeric[3]!,
      height: numeric[4]!,
      id: field.id,
      sortOrder: index,
    } as CrmFormFieldInput & { sortOrder: number };
  });
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

export function formatFormField(row: any) {
  return {
    id: row.id,
    fieldType: row.fieldType,
    label: row.label,
    autoFillToken: row.autoFillToken ?? null,
    required: Boolean(row.required),
    pageNumber: Number(row.pageNumber),
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    sortOrder: Number(row.sortOrder || 0),
  };
}

// ─── Token resolution ─────────────────────────────────────────────────────────

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function fmtDateInput(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return "";
  return dt.toISOString().slice(0, 10);
}

/** Pick a value from a JSON blob by trying multiple candidate keys (case-insensitive). */
function pickJson(blob: unknown, ...keys: string[]): string {
  if (!blob || typeof blob !== "object") return "";
  const obj = blob as Record<string, unknown>;
  for (const key of keys) {
    const found = obj[key] ?? obj[key.toLowerCase()] ?? obj[key.toUpperCase()];
    if (found !== undefined && found !== null && found !== "") return String(found);
  }
  return "";
}

/**
 * Build a flat map of token → resolved string for a specific form request + contact.
 * `contact` should include `firstName`, `lastName`, `displayName`, `company`, `title`,
 * `phones`, `emails`, `addresses`, `intelligenceReport`, and `crmMeta.assignedTo`.
 * `request` is the CrmFormRequest row (for sentAt, expiresAt).
 */
export function resolveFormTokenVars(
  contact: any,
  request?: any,
): Record<string, string> {
  const phones: any[] = contact?.phones ?? [];
  const emails: any[] = contact?.emails ?? [];
  const addrs: any[] = contact?.addresses ?? [];
  const report: any = contact?.intelligenceReport ?? null;
  const entities: any = report?.discoveredEntities ?? null;
  const crmMeta: any = contact?.crmMeta ?? null;

  const primaryPhone = phones.find((p: any) => p.isPrimary)?.numberRaw ?? phones[0]?.numberRaw ?? "";
  const mobilePhone = phones.find((p: any) => p.type === "MOBILE")?.numberRaw
    ?? phones.find((p: any) => !p.isPrimary)?.numberRaw ?? primaryPhone;
  const primaryEmail = emails.find((e: any) => e.isPrimary)?.email ?? emails[0]?.email ?? "";
  const addr = addrs[0] ?? null;
  const fullAddress = addr
    ? [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(", ")
    : "";

  const today = new Date();

  return {
    // ── Contact ───────────────────────────────────────────────────────────────
    "contact.fullName":    contact?.displayName ?? "",
    "contact.firstName":   contact?.firstName ?? (contact?.displayName ?? "").split(" ")[0] ?? "",
    "contact.lastName":    contact?.lastName ?? (contact?.displayName ?? "").split(" ").slice(1).join(" ") ?? "",
    "contact.email":       primaryEmail,
    "contact.phone":       primaryPhone,
    "contact.mobile":      mobilePhone,
    "contact.title":       contact?.title ?? "",
    "contact.company":     contact?.company ?? "",
    "contact.address":     addr?.street ?? "",
    "contact.city":        addr?.city ?? "",
    "contact.state":       addr?.state ?? "",
    "contact.zip":         addr?.zip ?? "",
    "contact.fullAddress": fullAddress,
    "contact.dob":         "", // DOB not stored on Contact — left blank for manual entry
    "contact.ssn":         "", // Never auto-fill SSN for security
    // ── Business / Entity (from intelligence report or contact.company) ────────
    "business.legalName":     pickJson(entities, "business_name", "legal_name", "legalName", "businessName") || contact?.company || "",
    "business.dba":           pickJson(entities, "dba", "doing_business_as", "doingBusinessAs"),
    "business.entityType":    pickJson(entities, "entity_type", "entityType", "business_type", "businessType"),
    "business.stateOfIncorp": pickJson(entities, "state_of_incorp", "stateOfIncorp", "state_of_incorporation", "incorporationState"),
    "business.yearsInBiz":    pickJson(entities, "years_in_business", "yearsInBusiness", "years"),
    "business.industry":      pickJson(entities, "industry", "industryType"),
    "business.ownerName":     pickJson(entities, "owner_name", "ownerName", "owner") || contact?.displayName || "",
    "business.ownerTitle":    pickJson(entities, "owner_title", "ownerTitle") || contact?.title || "",
    "business.ein":           pickJson(entities, "ein", "tax_id", "taxId", "employer_identification_number"),
    "business.bankName":      pickJson(entities, "bank_name", "bankName"),
    "business.accountType":   pickJson(entities, "account_type", "accountType"),
    // ── CRM ──────────────────────────────────────────────────────────────────
    "crm.stage":         crmMeta?.stage ?? "",
    "crm.assignedAgent": crmMeta?.assignedTo?.displayName ?? [crmMeta?.assignedTo?.firstName, crmMeta?.assignedTo?.lastName].filter(Boolean).join(" ") ?? "",
    // ── Agent (populated later server-side; blank at public signing time) ─────
    "agent.name":    "",
    "agent.email":   "",
    "agent.phone":   "",
    "agent.company": "",
    // ── Form / Date ──────────────────────────────────────────────────────────
    "form.date":       fmtDate(today),
    "form.sentDate":   fmtDate(request?.sentAt),
    "form.expiryDate": fmtDate(request?.expiresAt),
    "form.year":       String(today.getFullYear()),
  };
}

export function publicFormDto(request: any) {
  const isCompleted = request.status === "COMPLETED" || Boolean(request.submission);
  const tokenVars = isCompleted ? {} : resolveFormTokenVars(request.contact, request);

  const contact = request.contact;
  const phones: any[] = contact?.phones ?? [];
  const emails: any[] = contact?.emails ?? [];

  return {
    request: {
      id: request.id,
      status: request.status,
      expiresAt: toIso(request.expiresAt),
      completedAt: toIso(request.completedAt),
    },
    contact: {
      displayName: contact?.displayName ?? null,
      company: contact?.company ?? null,
      primaryPhone: phones.find((p: any) => p.isPrimary)?.numberRaw ?? phones[0]?.numberRaw ?? null,
      primaryEmail: emails.find((e: any) => e.isPrimary)?.email ?? emails[0]?.email ?? null,
    },
    tenantName: request.formTemplate.tenant?.name ?? null,
    template: {
      id: request.formTemplate.id,
      name: request.formTemplate.name,
      description: request.formTemplate.description,
      category: request.formTemplate.category,
      pageCount: request.formTemplate.pageCount,
    },
    fields: isCompleted
      ? []
      : (request.formTemplate.fields || []).map((f: any) => {
          const base = formatFormField(f);
          // Resolve autoFillToken → defaultValue for non-signature fields only
          const canAutoFill = base.fieldType !== "SIGNATURE" && base.fieldType !== "INITIALS";
          const rawDefaultValue =
            canAutoFill && base.autoFillToken ? (tokenVars[base.autoFillToken] ?? "") : "";
          const defaultValue =
            base.fieldType === "DATE" && rawDefaultValue ? fmtDateInput(rawDefaultValue) : rawDefaultValue;
          return { ...base, defaultValue };
        }),
    submission: request.submission ? { submittedAt: toIso(request.submission.submittedAt) } : null,
    /** Flat token map — returned so the signing page can render a preview of what was resolved. */
    tokenVars,
  };
}

export function validateSubmission(fields: any[], submittedData: Record<string, unknown>) {
  const errors: Record<string, string> = {};
  const sanitized: Record<string, unknown> = {};
  for (const field of fields) {
    const value = submittedData?.[field.id];
    if (field.fieldType === "CHECKBOX") {
      sanitized[field.id] = Boolean(value);
      if (field.required && sanitized[field.id] !== true) errors[field.id] = "required";
      continue;
    }
    const text = String(value ?? "").trim();
    sanitized[field.id] = text.slice(0, field.fieldType === "SIGNATURE" || field.fieldType === "INITIALS" ? 200_000 : 2000);
    if (field.required && !text) errors[field.id] = "required";
  }
  return { ok: Object.keys(errors).length === 0, errors, sanitized };
}
