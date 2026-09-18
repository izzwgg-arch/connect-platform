/**
 * Opportunity types are DATA — each type (e.g. "customers", "vendors",
 * "real-estate") carries its own JSON field schema, and the post form
 * renders whatever fields that type defines instead of a fixed layout (see
 * GET /opportunities/types and apps/community-api/src/opportunities/types.ts,
 * whose `validateFields` this module mirrors sentence-for-sentence so a
 * submission the app accepts as valid never bounces off the api's refusal).
 *
 * Pure — no imports — so it's testable under plain Node
 * (src/domain/dynamicFields.test.ts).
 */
export type OpportunityFieldType = "text" | "number" | "money" | "date" | "select" | "multiselect" | "boolean";

export type OpportunityField = {
  key: string;
  label: string;
  type: OpportunityFieldType;
  required?: boolean;
  options?: string[];
};

function isPresent(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/**
 * Mirrors apps/community-api/src/opportunities/types.ts's `validateFields`
 * exactly — same checks, same sentences — so the app can validate a form
 * client-side and show the buyer the identical refusal the api would give,
 * before ever making the request.
 */
export function validateFields(schema: OpportunityField[], fields: Record<string, unknown> | null | undefined): string[] {
  const errors: string[] = [];
  const values = fields ?? {};
  for (const f of schema) {
    const v = values[f.key];
    const present = isPresent(v);
    if (f.required && !present) {
      errors.push(`${f.label} is required.`);
      continue;
    }
    if (!present) continue;
    switch (f.type) {
      case "text":
        if (typeof v !== "string") errors.push(`${f.label} must be text.`);
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${f.label} must be a number.`);
        break;
      case "money":
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) errors.push(`${f.label} must be a positive amount.`);
        break;
      case "date": {
        const d = new Date(String(v));
        if (Number.isNaN(d.getTime())) errors.push(`${f.label} must be a valid date.`);
        break;
      }
      case "boolean":
        if (typeof v !== "boolean") errors.push(`${f.label} must be yes or no.`);
        break;
      case "select":
        if (typeof v !== "string" || !(f.options ?? []).includes(v)) errors.push(`${f.label} must be one of: ${(f.options ?? []).join(", ")}.`);
        break;
      case "multiselect":
        if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || !(f.options ?? []).includes(x))) {
          errors.push(`${f.label} must be chosen from: ${(f.options ?? []).join(", ")}.`);
        }
        break;
    }
  }
  return errors;
}

/** A schema's empty form model — one entry per field, typed per its kind, so a controlled input always has a defined starting value. */
export function initialFieldValues(schema: OpportunityField[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const f of schema) {
    if (f.type === "boolean") values[f.key] = false;
    else if (f.type === "multiselect") values[f.key] = [];
    else values[f.key] = "";
  }
  return values;
}

/**
 * Coerces one raw form value (always a string or array from a text input /
 * chip picker) into the type `validateFields` and the api expect — numeric
 * text becomes a number, "" becomes `undefined` (omitted, so an optional
 * field left blank doesn't fail as "must be a number").
 */
export function coerceFieldValue(field: OpportunityField, raw: unknown): unknown {
  if (field.type === "number" || field.type === "money") {
    if (raw === "" || raw == null) return undefined;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (field.type === "boolean") return !!raw;
  if (field.type === "multiselect") return Array.isArray(raw) ? raw : [];
  if (raw === "") return undefined;
  return raw;
}

/** Coerces a whole form model in one pass, ready to pass to validateFields or the api. */
export function coerceFields(schema: OpportunityField[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of schema) {
    const v = coerceFieldValue(f, raw[f.key]);
    if (v !== undefined) out[f.key] = v;
  }
  return out;
}
