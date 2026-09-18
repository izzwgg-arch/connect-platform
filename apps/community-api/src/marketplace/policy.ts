import type { Db } from "../db.js";

/**
 * Pure marketplace policy + category-tree shaping. Routes fetch rows and call
 * these; nothing here talks to the database (the one exception is
 * `ensureCategories`, which is a one-time idempotent seed, not a query the
 * request path depends on for its shape).
 */

export const LISTING_TYPE_VALUES = ["SERVICE", "PRODUCT", "WHOLESALE", "BUSINESS_ASSET", "PROFESSIONAL_SERVICE"] as const;
export type ListingTypeValue = (typeof LISTING_TYPE_VALUES)[number];

export const AVAILABILITY_VALUES = ["AVAILABLE", "LIMITED", "SOLD_OUT"] as const;
export type AvailabilityValue = (typeof AVAILABILITY_VALUES)[number];

export const MARKETPLACE_SORT_VALUES = ["relevance", "newest", "price_asc", "price_desc"] as const;
export type MarketplaceSort = (typeof MARKETPLACE_SORT_VALUES)[number];

/** The category tree is data — this is the one-time seed, safe to re-run (upsert by slug). */
type CategorySeed = { slug: string; name: string; children?: CategorySeed[] };

export const CATEGORY_SEED: CategorySeed[] = [
  {
    slug: "apparel-uniforms",
    name: "Apparel & uniforms",
    children: [
      { slug: "embroidery", name: "Embroidery" },
      { slug: "screen-printing", name: "Screen printing" },
      { slug: "promotional-products", name: "Promotional products" },
    ],
  },
  { slug: "printing", name: "Printing" },
  { slug: "signage", name: "Signage" },
  { slug: "packaging", name: "Packaging" },
  { slug: "logistics", name: "Logistics" },
  { slug: "security-systems", name: "Security systems" },
  { slug: "accounting", name: "Accounting" },
  { slug: "technology", name: "Technology" },
  { slug: "construction", name: "Construction" },
  { slug: "real-estate", name: "Real estate" },
  { slug: "food-catering", name: "Food & catering" },
  { slug: "marketing", name: "Marketing" },
  { slug: "insurance", name: "Insurance" },
  { slug: "legal", name: "Legal" },
  { slug: "other", name: "Other" },
];

/** Idempotent: upsert by slug. Safe to run alongside another domain's own seed of the same tree. */
export async function ensureCategories(db: Db): Promise<void> {
  let topSort = 0;
  for (const top of CATEGORY_SEED) {
    const parent = await db.category.upsert({
      where: { slug: top.slug },
      create: { slug: top.slug, name: top.name, sortOrder: topSort },
      update: { name: top.name },
    });
    topSort += 1;
    let childSort = 0;
    for (const child of top.children ?? []) {
      await db.category.upsert({
        where: { slug: child.slug },
        create: { slug: child.slug, name: child.name, parentId: parent.id, sortOrder: childSort },
        update: { name: child.name, parentId: parent.id },
      });
      childSort += 1;
    }
  }
}

export type CategoryRow = { id: string; slug: string; name: string; parentId: string | null; sortOrder: number };
export type CategoryNode = { id: string; slug: string; name: string; count: number; children: CategoryNode[] };

/** All ids in the subtree rooted at `rootId`, inclusive. Pure given the flat row list. */
export function collectDescendantIds(categories: CategoryRow[], rootId: string): string[] {
  const byParent = new Map<string, string[]>();
  for (const c of categories) {
    if (!c.parentId) continue;
    byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c.id]);
  }
  const out: string[] = [rootId];
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const child of byParent.get(id) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Builds the tree with counts rolled up from children into every ancestor. */
export function buildCategoryTree(categories: CategoryRow[], ownCounts: Map<string, number>): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const c of categories) nodes.set(c.id, { id: c.id, slug: c.slug, name: c.name, count: ownCounts.get(c.id) ?? 0, children: [] });
  const roots: CategoryNode[] = [];
  for (const c of categories.sort((a, b) => a.sortOrder - b.sortOrder)) {
    const node = nodes.get(c.id)!;
    if (c.parentId && nodes.has(c.parentId)) nodes.get(c.parentId)!.children.push(node);
    else roots.push(node);
  }
  const rollUp = (node: CategoryNode): number => {
    let total = node.count;
    for (const child of node.children) total += rollUp(child);
    node.count = total;
    return total;
  };
  for (const r of roots) rollUp(r);
  return roots;
}

/** Sorts a copy of the rows by the requested field. `relevance` is a no-op — the caller pre-orders by search rank. */
export function sortListingRows<T extends { priceMin: unknown; priceMax: unknown; createdAt: Date; id: string }>(rows: T[], sort: MarketplaceSort): T[] {
  const copy = [...rows];
  const num = (v: unknown): number | null => (v == null ? null : Number(String(v)));
  if (sort === "price_asc") {
    copy.sort((a, b) => {
      const av = num(a.priceMin);
      const bv = num(b.priceMin);
      if (av == null && bv == null) return b.createdAt.getTime() - a.createdAt.getTime();
      if (av == null) return 1;
      if (bv == null) return -1;
      return av - bv || a.id.localeCompare(b.id);
    });
  } else if (sort === "price_desc") {
    copy.sort((a, b) => {
      const av = num(a.priceMax) ?? num(a.priceMin);
      const bv = num(b.priceMax) ?? num(b.priceMin);
      if (av == null && bv == null) return b.createdAt.getTime() - a.createdAt.getTime();
      if (av == null) return 1;
      if (bv == null) return -1;
      return bv - av || a.id.localeCompare(b.id);
    });
  } else if (sort === "newest") {
    copy.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
  }
  return copy;
}

/** A seller org counts as "verified" for the buyer-facing filter only via a live BUSINESS verification. */
export function isVerifiedSellerOrg(verifiedKinds: string[]): boolean {
  return verifiedKinds.includes("BUSINESS");
}
