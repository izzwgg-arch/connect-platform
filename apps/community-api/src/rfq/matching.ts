import type { Db } from "../db.js";
import { Prisma } from "../db.js";
import { ftsIds } from "../lib/search.js";
import { degreeBetween } from "../policy/graph.js";
import { CATEGORY_KEYWORDS } from "./policy.js";

export type MatchInput = {
  title: string;
  description: string;
  categorySlug: string | null;
  location: string | null;
  buyerPersonId: string;
};

export type MatchedVendor = { organizationId: string; reason: string };

const MATCH_CAP = 25;

/**
 * Finds candidate vendor organizations for an RFQ: text match on org/listing
 * content, must accept RFQs, service-area overlap when both sides have one,
 * ranked verified-business first, then buyer's network, then followers.
 */
export async function matchVendors(db: Db, input: MatchInput): Promise<MatchedVendor[]> {
  const keywords = input.categorySlug ? (CATEGORY_KEYWORDS.find((c) => c.slug === input.categorySlug)?.keywords ?? []) : [];
  const q = [input.title, keywords.join(" ")].filter(Boolean).join(" ").trim();
  const reasonByOrg = new Map<string, string>();

  if (q) {
    const orgHits = await ftsIds(db, "Organization", "id", q, 60, Prisma.sql`AND status = 'ACTIVE' AND "acceptsRfqs" = true`);
    for (const r of orgHits) reasonByOrg.set(r.id, "matches your request");
    const listingHits = await ftsIds(db, "Listing", "organizationId", q, 60, Prisma.sql`AND "organizationId" IS NOT NULL AND status = 'ACTIVE'`);
    for (const r of listingHits) if (!reasonByOrg.has(r.id)) reasonByOrg.set(r.id, "offers a matching service");
  }
  if (!reasonByOrg.size) return [];

  let orgIds = [...reasonByOrg.keys()];
  const orgs = await db.organization.findMany({
    where: { id: { in: orgIds }, status: "ACTIVE", acceptsRfqs: true },
    select: { id: true, serviceArea: true, followerCount: true, memberships: { where: { role: { in: ["OWNER", "ADMIN"] } }, select: { personId: true } } },
  });
  const orgById = new Map(orgs.map((o) => [o.id, o]));
  orgIds = orgIds.filter((id) => orgById.has(id));
  if (!orgIds.length) return [];

  if (input.location) {
    const loc = input.location.toLowerCase();
    const withArea = orgIds.filter((id) => {
      const org = orgById.get(id)!;
      return !org.serviceArea.length || org.serviceArea.some((a) => a.toLowerCase().includes(loc) || loc.includes(a.toLowerCase()));
    });
    if (withArea.length) orgIds = withArea; // no org in-area is a signal, not a filter — keep everyone else
  }

  const verified = await db.verification.findMany({ where: { organizationId: { in: orgIds }, kind: "BUSINESS", status: "VERIFIED" }, select: { organizationId: true } });
  const verifiedSet = new Set(verified.map((v) => v.organizationId));

  const networkSet = new Set<string>();
  for (const id of orgIds) {
    const org = orgById.get(id)!;
    for (const m of org.memberships) {
      // eslint-disable-next-line no-await-in-loop
      if ((await degreeBetween(db, input.buyerPersonId, m.personId)) === 1) {
        networkSet.add(id);
        break;
      }
    }
  }

  orgIds.sort((a, b) => {
    const va = verifiedSet.has(a) ? 1 : 0;
    const vb = verifiedSet.has(b) ? 1 : 0;
    if (va !== vb) return vb - va;
    const na = networkSet.has(a) ? 1 : 0;
    const nb = networkSet.has(b) ? 1 : 0;
    if (na !== nb) return nb - na;
    return orgById.get(b)!.followerCount - orgById.get(a)!.followerCount;
  });

  return orgIds.slice(0, MATCH_CAP).map((id) => ({
    organizationId: id,
    reason: verifiedSet.has(id) ? "verified business match" : networkSet.has(id) ? "in your network" : (reasonByOrg.get(id) ?? "matches your request"),
  }));
}
