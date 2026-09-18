/**
 * Pure RFQ decisions and reference data — no db, no I/O. Routes and the
 * extractor/matcher import from here so a rule (a keyword table, a
 * visibility check) lives in exactly one place.
 */

/** Category tree seeded once by `ensureCategories`. kind is always MARKETPLACE — RFQs reuse the marketplace tree. */
export const CATEGORY_SEED: Array<{ slug: string; name: string; parentSlug: string | null; sortOrder: number }> = [
  { slug: "apparel-uniforms", name: "Apparel & uniforms", parentSlug: null, sortOrder: 0 },
  { slug: "embroidery", name: "Embroidery", parentSlug: "apparel-uniforms", sortOrder: 0 },
  { slug: "screen-printing", name: "Screen printing", parentSlug: "apparel-uniforms", sortOrder: 1 },
  { slug: "uniform-programs", name: "Uniform programs", parentSlug: "apparel-uniforms", sortOrder: 2 },
  { slug: "printing", name: "Printing", parentSlug: null, sortOrder: 1 },
  { slug: "signage", name: "Signage", parentSlug: null, sortOrder: 2 },
  { slug: "packaging", name: "Packaging", parentSlug: null, sortOrder: 3 },
  { slug: "logistics", name: "Logistics & delivery", parentSlug: null, sortOrder: 4 },
  { slug: "security-systems", name: "Security systems", parentSlug: null, sortOrder: 5 },
  { slug: "accounting", name: "Accounting & bookkeeping", parentSlug: null, sortOrder: 6 },
  { slug: "technology", name: "Technology", parentSlug: null, sortOrder: 7 },
  { slug: "construction", name: "Construction", parentSlug: null, sortOrder: 8 },
  { slug: "real-estate", name: "Real estate", parentSlug: null, sortOrder: 9 },
  { slug: "food-catering", name: "Food & catering", parentSlug: null, sortOrder: 10 },
  { slug: "marketing", name: "Marketing", parentSlug: null, sortOrder: 11 },
  { slug: "insurance", name: "Insurance", parentSlug: null, sortOrder: 12 },
  { slug: "legal", name: "Legal", parentSlug: null, sortOrder: 13 },
  { slug: "other", name: "Other", parentSlug: null, sortOrder: 99 },
];

/** Keyword → category slug guess. Order matters: first match wins. */
export const CATEGORY_KEYWORDS: Array<{ slug: string; keywords: string[] }> = [
  { slug: "apparel-uniforms", keywords: ["embroider", "embroidery", "uniform", "jacket", "apparel", "screen print", "screen-print", "polo", "jersey"] },
  { slug: "printing", keywords: ["print", "brochure", "flyer", "menu"] },
  { slug: "signage", keywords: ["sign", "banner", "lettering"] },
  { slug: "packaging", keywords: ["box", "packaging", "carton"] },
  { slug: "logistics", keywords: ["delivery", "freight", "ltl"] },
  { slug: "security-systems", keywords: ["camera", "cctv", "security"] },
  { slug: "accounting", keywords: ["bookkeeping", "accounting"] },
  { slug: "technology", keywords: ["web", "software", "app"] },
];

/** Gazetteer for location extraction, longest/most-specific phrases first. */
export const GAZETTEER: string[] = [
  "Boro Park",
  "Kiryas Joel",
  "Spring Valley",
  "Orange County",
  "New Jersey",
  "Williamsburg",
  "Flatbush",
  "Brooklyn",
  "Monsey",
  "Monroe",
  "Lakewood",
  "Queens",
  "Manhattan",
  "Rockland",
];

export type RfqViewCtx = {
  visibility: string;
  isBuyer: boolean;
  isInvitedOrgMember: boolean;
  isStaff: boolean;
};

/** MATCHED rfqs are visible only to the buyer and invited-org members; PUBLIC ones are open to anyone. */
export function canViewRfq(ctx: RfqViewCtx): boolean {
  if (ctx.isBuyer || ctx.isStaff) return true;
  if (ctx.visibility === "PUBLIC") return true;
  if (ctx.visibility === "MATCHED") return ctx.isInvitedOrgMember;
  return false;
}

export function isOpenForQuoting(status: string): boolean {
  return status === "OPEN" || status === "SHORTLISTING";
}

export function defaultClosesAt(deadline: Date | null | undefined, now: Date = new Date()): Date {
  if (deadline && deadline.getTime() > now.getTime()) return deadline;
  return new Date(now.getTime() + 14 * 86_400_000);
}

export function formatRfqNumber(year: number, seq: number): string {
  return `RFQ-${year}-${seq}`;
}

/** Merge explicit buyer fields over extracted ones; explicit always wins. Returns which keys came from extraction. */
export function mergeExtracted<T extends Record<string, unknown>>(explicit: Partial<T>, extracted: Partial<T>): { merged: Partial<T>; fromExtraction: string[] } {
  const merged: Partial<T> = { ...extracted, ...Object.fromEntries(Object.entries(explicit).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))) };
  const fromExtraction = Object.keys(extracted).filter((k) => (explicit as any)[k] === undefined || (explicit as any)[k] === null || (Array.isArray((explicit as any)[k]) && (explicit as any)[k].length === 0));
  return { merged, fromExtraction };
}
