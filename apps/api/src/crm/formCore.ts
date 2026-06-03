import * as crypto from "node:crypto";

export type CrmFormFieldInput = {
  id?: string;
  fieldType: "TEXT" | "DATE" | "CHECKBOX" | "SIGNATURE" | "INITIALS";
  label: string;
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
    return {
      fieldType: fieldType as CrmFormFieldInput["fieldType"],
      label,
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
    required: Boolean(row.required),
    pageNumber: Number(row.pageNumber),
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    sortOrder: Number(row.sortOrder || 0),
  };
}

export function publicFormDto(request: any) {
  const isCompleted = request.status === "COMPLETED" || Boolean(request.submission);
  return {
    request: {
      id: request.id,
      status: request.status,
      expiresAt: toIso(request.expiresAt),
      completedAt: toIso(request.completedAt),
    },
    contact: {
      displayName: request.contact?.displayName ?? null,
      company: request.contact?.company ?? null,
    },
    template: {
      id: request.formTemplate.id,
      name: request.formTemplate.name,
      description: request.formTemplate.description,
      category: request.formTemplate.category,
      pageCount: request.formTemplate.pageCount,
    },
    fields: isCompleted ? [] : (request.formTemplate.fields || []).map(formatFormField),
    submission: request.submission ? { submittedAt: toIso(request.submission.submittedAt) } : null,
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
    sanitized[field.id] = text.slice(0, field.fieldType === "SIGNATURE" || field.fieldType === "INITIALS" ? 5000 : 2000);
    if (field.required && !text) errors[field.id] = "required";
  }
  return { ok: Object.keys(errors).length === 0, errors, sanitized };
}
