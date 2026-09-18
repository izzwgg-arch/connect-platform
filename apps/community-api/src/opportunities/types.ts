import type { Db } from "../db.js";

/**
 * Opportunity types are DATA (`OpportunityType` with a JSON field schema) —
 * adding a new type is a row, never a deploy. This module seeds the starting
 * set idempotently (upsert by slug) and validates a submission's `fields`
 * against a type's stored schema.
 */

export type OpportunityFieldType = "text" | "number" | "money" | "date" | "select" | "multiselect" | "boolean";

export type OpportunityField = {
  key: string;
  label: string;
  type: OpportunityFieldType;
  required?: boolean;
  options?: string[];
};

type TypeSeed = { slug: string; name: string; description: string; fields: OpportunityField[] };

const money = (key: string, label: string, required = true): OpportunityField => ({ key, label, type: "money", required });
const text = (key: string, label: string, required = true): OpportunityField => ({ key, label, type: "text", required });
const number = (key: string, label: string, required = true): OpportunityField => ({ key, label, type: "number", required });
const date = (key: string, label: string, required = true): OpportunityField => ({ key, label, type: "date", required });
const select = (key: string, label: string, options: string[], required = true): OpportunityField => ({ key, label, type: "select", required, options });
const multiselect = (key: string, label: string, options: string[], required = true): OpportunityField => ({ key, label, type: "multiselect", required, options });

export const OPPORTUNITY_TYPE_SEED: TypeSeed[] = [
  { slug: "customers", name: "Customers", description: "Looking for customers in a specific industry or deal size.", fields: [text("industry", "Industry"), money("dealSize", "Typical deal size")] },
  { slug: "vendors", name: "Vendors", description: "Looking for a vendor to fill a specific need.", fields: [text("need", "What you need"), money("budget", "Budget"), date("deadline", "Deadline")] },
  { slug: "partnerships", name: "Partnerships", description: "Looking for a business partner.", fields: [text("kindOfPartnership", "Kind of partnership"), text("split", "Proposed split")] },
  { slug: "contractors", name: "Contractors", description: "Looking for a contractor or tradesperson.", fields: [text("trade", "Trade"), text("timeframe", "Timeframe"), money("rate", "Rate")] },
  {
    slug: "investment",
    name: "Investment",
    description: "Raising or offering investment.",
    fields: [money("amountMin", "Amount — minimum"), money("amountMax", "Amount — maximum"), select("equityOrLoan", "Equity or loan", ["Equity", "Loan"]), text("stage", "Stage")],
  },
  { slug: "acquisitions", name: "Acquisitions", description: "Buying or selling a business.", fields: [text("revenueRange", "Revenue range"), money("askingPrice", "Asking price"), text("reason", "Reason for sale", false)] },
  {
    slug: "real-estate",
    name: "Real estate",
    description: "Commercial space available or wanted.",
    fields: [
      select("propertyType", "Property type", ["Office", "Retail", "Industrial", "Land", "Mixed use"]),
      number("sqft", "Square feet"),
      money("priceOrRent", "Price or rent"),
      select("term", "Term", ["Sale", "Lease", "Sublease"]),
    ],
  },
  { slug: "referrals", name: "Referrals", description: "Asking for or offering a referral.", fields: [text("whoNeeded", "Who's needed"), money("referralFee", "Referral fee", false)] },
  { slug: "tenders", name: "Tenders", description: "An open tender or bid request.", fields: [date("dueDate", "Due date"), text("scope", "Scope"), money("budget", "Budget", false)] },
  {
    slug: "equipment",
    name: "Equipment",
    description: "Equipment for sale or wanted.",
    fields: [text("item", "Item"), select("condition", "Condition", ["New", "Used - like new", "Used - good", "Used - fair"]), money("price", "Price"), number("quantity", "Quantity")],
  },
  {
    slug: "wholesale",
    name: "Wholesale",
    description: "Wholesale supply or distribution.",
    fields: [
      text("product", "Product"),
      text("moq", "Minimum order quantity"),
      money("pricePerUnit", "Price per unit"),
      multiselect("regions", "Regions", ["Northeast", "Mid-Atlantic", "Southeast", "Midwest", "Southwest", "West", "Nationwide"]),
    ],
  },
  { slug: "collaboration", name: "Collaboration", description: "Looking to collaborate on a project or idea.", fields: [text("goal", "Goal"), text("commitment", "Time or resources you can commit")] },
];

/** Idempotent: upsert by slug. */
export async function ensureOpportunityTypes(db: Db): Promise<void> {
  let sort = 0;
  for (const t of OPPORTUNITY_TYPE_SEED) {
    await db.opportunityType.upsert({
      where: { slug: t.slug },
      create: { slug: t.slug, name: t.name, description: t.description, fieldSchema: t.fields as object, sortOrder: sort },
      update: { name: t.name, description: t.description, fieldSchema: t.fields as object },
    });
    sort += 1;
  }
}

function isPresent(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/**
 * Validates a submission's fields against a type's stored schema. Returns a
 * (possibly empty) array of human sentences — never throws, so the caller
 * can join them into one refusal message.
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
