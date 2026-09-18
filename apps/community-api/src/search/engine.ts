import type { Db } from "../db.js";
import { Prisma } from "../db.js";
import { ftsIds, type FtsRow } from "../lib/search.js";
import { personCards, type PersonCard } from "../profiles/cards.js";
import { orgCards, type OrgCard } from "../organizations/cards.js";
import { membershipOf } from "../organizations/permissions.js";
import { blockedIdSet, canSeePost, connectionIds, sharesOrgSet, type Degree } from "../policy/graph.js";
import { canSeeGroupDetail } from "../groups/policy.js";

export type SearchType = "people" | "organizations" | "posts" | "jobs" | "listings" | "groups" | "events" | "rfqs" | "opportunities";

export type SearchHit<T = unknown> = { type: SearchType; id: string; rank: number; why: string; item: T };

export type SearchCtx = {
  /** null for an anonymous viewer. */
  viewerId: string | null;
  q: string;
  limit: number;
  /** Facets that narrow a type's own search (not every type honours every facet). */
  location?: string | null;
  industry?: string | null;
  verified?: string[];
  size?: string | null;
  language?: string | null;
  /** Distance facet for people: 1 = "in my network", 2 = "2nd degree", undefined = anyone. Ignored when anonymous. */
  maxDegree?: 1 | 2;
};

function joinWhy(parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => !!p).join(" · ");
}

/**
 * Semantic seam. `Profile.embedding` / `Organization.embedding` (pgvector)
 * only exist when the `vector` extension was present when the search-indexes
 * migration ran (see prisma/migrations/20260918124200_search_indexes —
 * it wraps the column adds in `IF EXISTS (... pg_available_extensions ...)`).
 * Nothing here computes or stores an embedding yet, so this returns an empty
 * result rather than a made-up ranking — a real semantic pass plugs in here
 * once there is an embedding model wired up.
 */
export async function semanticIds(_db: Db, _q: string, _limit = 20): Promise<FtsRow[]> {
  return [];
}

/** Degree 0/1/2/3 for many targets at once (2–3 queries total, never N). */
async function bulkDegrees(db: Db, viewerId: string | null, targetIds: string[]): Promise<Map<string, Degree>> {
  const map = new Map<string, Degree>();
  if (!viewerId) {
    for (const id of targetIds) map.set(id, 3);
    return map;
  }
  const mine = await connectionIds(db, viewerId);
  const mineSet = new Set(mine);
  const remaining: string[] = [];
  for (const id of targetIds) {
    if (id === viewerId) map.set(id, 0);
    else if (mineSet.has(id)) map.set(id, 1);
    else {
      map.set(id, 3);
      remaining.push(id);
    }
  }
  if (remaining.length && mine.length) {
    const rows = await db.connection.findMany({
      where: { status: "ACTIVE", OR: [{ aId: { in: remaining }, bId: { in: mine } }, { bId: { in: remaining }, aId: { in: mine } }] },
      select: { aId: true, bId: true },
    });
    const remainingSet = new Set(remaining);
    for (const row of rows) {
      const other = remainingSet.has(row.aId) ? row.aId : row.bId;
      map.set(other, 2);
    }
  }
  return map;
}

/** Mutual (both-sides-agree) CUSTOMER/PURCHASED_FROM tags the viewer's 1st-degree hold on each target org. */
async function mutualCustomerCounts(db: Db, viewerId: string | null, orgIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!viewerId || !orgIds.length) return out;
  const mine = await connectionIds(db, viewerId);
  if (!mine.length) return out;
  const rows = await db.relationshipTag.groupBy({
    by: ["targetOrgId"],
    where: { ownerId: { in: mine }, targetOrgId: { in: orgIds }, kind: { in: ["CUSTOMER", "PURCHASED_FROM"] }, mutual: true },
    _count: { _all: true },
  });
  for (const r of rows) if (r.targetOrgId) out.set(r.targetOrgId, r._count._all);
  return out;
}

async function verifiedKinds(db: Db, orgIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!orgIds.length) return out;
  const rows = await db.verification.findMany({ where: { organizationId: { in: orgIds }, status: "VERIFIED" }, select: { organizationId: true, kind: true } });
  for (const r of rows) {
    if (!r.organizationId) continue;
    const arr = out.get(r.organizationId) ?? [];
    arr.push(r.kind);
    out.set(r.organizationId, arr);
  }
  return out;
}

function verificationWhy(kinds: string[] | undefined): string | null {
  if (!kinds?.length) return null;
  if (kinds.includes("BUSINESS")) return "Verified business";
  if (kinds.includes("LICENSE")) return "License verified";
  if (kinds.includes("INSURANCE")) return "Insurance on file";
  return null;
}

// ── People ───────────────────────────────────────────────────────────────

export async function searchPeople(db: Db, ctx: SearchCtx): Promise<SearchHit<PersonCard>[]> {
  const rows = await ftsIds(db, "Profile", "personId", ctx.q, ctx.limit * 3);
  if (!rows.length) return [];
  const people = await db.person.findMany({ where: { id: { in: rows.map((r) => r.id) }, status: "ACTIVE" }, select: { id: true, profile: { select: { languages: true } } } });
  const alive = new Set(
    people.filter((p) => !ctx.language || p.profile?.languages.some((l) => l.toLowerCase() === ctx.language!.toLowerCase())).map((p) => p.id),
  );
  const candidates = rows.filter((r) => alive.has(r.id));
  const blocked = await blockedIdSet(db, ctx.viewerId);
  const kept: FtsRow[] = candidates.filter((r) => !(ctx.viewerId && ctx.viewerId !== r.id && blocked.has(r.id)));
  const degrees = await bulkDegrees(db, ctx.viewerId, kept.map((r) => r.id));
  const cards = await personCards(db, kept.map((r) => r.id));
  const out: SearchHit<PersonCard>[] = [];
  for (const r of kept) {
    const card = cards.get(r.id);
    if (!card) continue;
    const degree = degrees.get(r.id) ?? 3;
    if (ctx.viewerId && ctx.maxDegree && degree > ctx.maxDegree) continue;
    const why = joinWhy([
      degree === 1 ? "1st-degree connection" : degree === 2 ? "2nd degree" : null,
      ctx.industry && card.industry === ctx.industry ? "Same industry" : null,
      `Matches "${ctx.q}" in profile`,
    ]);
    out.push({ type: "people", id: r.id, rank: r.rank, why, item: card });
  }
  return out.sort((a, b) => b.rank - a.rank).slice(0, ctx.limit);
}

// ── Organizations ────────────────────────────────────────────────────────

export async function searchOrganizations(db: Db, ctx: SearchCtx): Promise<SearchHit<OrgCard>[]> {
  const rows = await ftsIds(db, "Organization", "id", ctx.q, ctx.limit * 3, Prisma.sql`AND status = 'ACTIVE' AND "searchEngineVisible" = true`);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [cards, orgs, verified, mutual] = await Promise.all([
    orgCards(db, ids),
    db.organization.findMany({ where: { id: { in: ids } }, select: { id: true, serviceArea: true, industry: true, size: true } }),
    verifiedKinds(db, ids),
    mutualCustomerCounts(db, ctx.viewerId, ids),
  ]);
  const orgById = new Map(orgs.map((o) => [o.id, o]));
  const out: SearchHit<OrgCard>[] = [];
  for (const r of rows) {
    const card = cards.get(r.id);
    const org = orgById.get(r.id);
    if (!card || !org) continue;
    if (ctx.size && card.size !== ctx.size) continue;
    if (ctx.industry && card.industry !== ctx.industry) continue;
    if (ctx.verified?.length && !ctx.verified.every((k) => card.verified.includes(k))) continue;
    const servesLocation = ctx.location && org.serviceArea.some((a) => a.toLowerCase().includes(ctx.location!.toLowerCase()));
    const mutualCount = mutual.get(r.id) ?? 0;
    const why = joinWhy([
      verificationWhy(card.verified),
      mutualCount > 0 ? `${mutualCount} ${mutualCount === 1 ? "person" : "people"} you know ${mutualCount === 1 ? "is a customer" : "are customers"}` : null,
      ctx.industry && org.industry === ctx.industry ? "Same industry" : null,
      servesLocation ? `Serves ${ctx.location}` : null,
      `Matches "${ctx.q}" in services`,
    ]);
    out.push({ type: "organizations", id: r.id, rank: r.rank + mutualCount * 0.05, why, item: card });
  }
  return out.sort((a, b) => b.rank - a.rank).slice(0, ctx.limit);
}

// ── Posts ────────────────────────────────────────────────────────────────

export type PostHitItem = { id: string; body: string | null; kind: string; authorId: string; organizationId: string | null; createdAt: Date; author: PersonCard | null };

export async function searchPosts(db: Db, ctx: SearchCtx): Promise<SearchHit<PostHitItem>[]> {
  const rows = await ftsIds(db, "Post", "id", ctx.q, ctx.limit * 3, Prisma.sql`AND "deletedAt" IS NULL AND "publishedAt" IS NOT NULL`);
  if (!rows.length) return [];
  const posts = await db.post.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, body: true, kind: true, authorId: true, organizationId: true, visibility: true, createdAt: true } });
  const authorIds = [...new Set(posts.map((p) => p.authorId))];
  const [degrees, cards, myOrgs] = await Promise.all([
    bulkDegrees(db, ctx.viewerId, authorIds),
    personCards(db, authorIds),
    ctx.viewerId ? db.membership.findMany({ where: { personId: ctx.viewerId, affiliation: { in: ["VERIFIED_ADMIN", "VERIFIED_DOMAIN"] } }, select: { organizationId: true } }) : Promise.resolve([]),
  ]);
  const myOrgIds = new Set(myOrgs.map((m) => m.organizationId));
  const sharedAuthors = await sharesOrgSet(db, myOrgIds, authorIds);
  const out: SearchHit<PostHitItem>[] = [];
  for (const r of rows) {
    const post = posts.find((p) => p.id === r.id);
    if (!post) continue;
    const isAuthor = ctx.viewerId === post.authorId;
    const degree = degrees.get(post.authorId) ?? 3;
    let sameOrganization = false;
    if (ctx.viewerId && !isAuthor) {
      sameOrganization = post.organizationId ? myOrgIds.has(post.organizationId) : sharedAuthors.has(post.authorId);
    }
    if (!canSeePost(post.visibility as any, { degree, sameOrganization, isAuthor })) continue;
    out.push({
      type: "posts",
      id: post.id,
      rank: r.rank,
      why: `Matches "${ctx.q}" in a post`,
      item: { id: post.id, body: post.body, kind: post.kind, authorId: post.authorId, organizationId: post.organizationId, createdAt: post.createdAt, author: cards.get(post.authorId) ?? null },
    });
  }
  return out.sort((a, b) => b.rank - a.rank).slice(0, ctx.limit);
}

// ── Jobs ─────────────────────────────────────────────────────────────────

export type JobHitItem = { id: string; title: string; location: string | null; employmentType: string; workMode: string; salaryMin: string | null; salaryMax: string | null; organizationId: string; orgName: string | null; orgLogoAssetId: string | null };

export async function searchJobs(db: Db, ctx: SearchCtx): Promise<SearchHit<JobHitItem>[]> {
  const rows = await ftsIds(db, "Job", "id", ctx.q, ctx.limit * 2, Prisma.sql`AND status = 'OPEN'`);
  if (!rows.length) return [];
  const jobs = await db.job.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, title: true, location: true, employmentType: true, workMode: true, salaryMin: true, salaryMax: true, organizationId: true } });
  const orgCardsMap = await orgCards(db, jobs.map((j) => j.organizationId));
  const out: SearchHit<JobHitItem>[] = [];
  for (const r of rows) {
    const job = jobs.find((j) => j.id === r.id);
    if (!job) continue;
    const org = orgCardsMap.get(job.organizationId);
    if (ctx.location && job.location && !job.location.toLowerCase().includes(ctx.location.toLowerCase())) continue;
    out.push({
      type: "jobs",
      id: job.id,
      rank: r.rank,
      why: joinWhy([org && verificationWhy(org.verified), `Matches "${ctx.q}" in the job posting`]),
      item: { id: job.id, title: job.title, location: job.location, employmentType: job.employmentType, workMode: job.workMode, salaryMin: job.salaryMin?.toString() ?? null, salaryMax: job.salaryMax?.toString() ?? null, organizationId: job.organizationId, orgName: org?.displayName ?? null, orgLogoAssetId: org?.logoAssetId ?? null },
    });
  }
  return out.sort((a, b) => b.rank - a.rank).slice(0, ctx.limit);
}

// ── Listings (marketplace) ───────────────────────────────────────────────

export type ListingHitItem = { id: string; title: string; type: string; priceMin: string | null; priceMax: string | null; priceUnit: string | null; serviceArea: string[]; sellerPersonId: string | null; organizationId: string | null; sellerName: string | null };

export async function searchListings(db: Db, ctx: SearchCtx): Promise<SearchHit<ListingHitItem>[]> {
  const rows = await ftsIds(db, "Listing", "id", ctx.q, ctx.limit * 2, Prisma.sql`AND status = 'ACTIVE'`);
  if (!rows.length) return [];
  const listings = await db.listing.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, title: true, type: true, priceMin: true, priceMax: true, priceUnit: true, serviceArea: true, sellerPersonId: true, organizationId: true } });
  const [orgCardsMap, personCardsMap] = await Promise.all([
    orgCards(db, listings.map((l) => l.organizationId).filter((x): x is string => !!x)),
    personCards(db, listings.map((l) => l.sellerPersonId).filter((x): x is string => !!x)),
  ]);
  const out: SearchHit<ListingHitItem>[] = [];
  for (const r of rows) {
    const listing = listings.find((l) => l.id === r.id);
    if (!listing) continue;
    if (ctx.location && listing.serviceArea.length && !listing.serviceArea.some((a) => a.toLowerCase().includes(ctx.location!.toLowerCase()))) continue;
    const sellerName = listing.organizationId ? orgCardsMap.get(listing.organizationId)?.displayName ?? null : listing.sellerPersonId ? personCardsMap.get(listing.sellerPersonId)?.name ?? null : null;
    out.push({
      type: "listings",
      id: listing.id,
      rank: r.rank,
      why: `Matches "${ctx.q}" in the listing`,
      item: { id: listing.id, title: listing.title, type: listing.type, priceMin: listing.priceMin?.toString() ?? null, priceMax: listing.priceMax?.toString() ?? null, priceUnit: listing.priceUnit, serviceArea: listing.serviceArea, sellerPersonId: listing.sellerPersonId, organizationId: listing.organizationId, sellerName },
    });
  }
  return out.sort((a, b) => b.rank - a.rank).slice(0, ctx.limit);
}

// ── Groups ───────────────────────────────────────────────────────────────

export type GroupHitItem = { id: string; slug: string; name: string; isPrivate: boolean; description?: string | null; memberCount?: number; category?: string | null };

export async function searchGroups(db: Db, ctx: SearchCtx): Promise<SearchHit<GroupHitItem>[]> {
  const rows = await ftsIds(db, "Group", "id", ctx.q, ctx.limit * 2);
  if (!rows.length) return [];
  const groups = await db.group.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, slug: true, name: true, description: true, isPrivate: true, memberCount: true, category: true } });
  let myMemberships = new Map<string, { role: any; state: any }>();
  if (ctx.viewerId) {
    const m = await db.groupMember.findMany({ where: { personId: ctx.viewerId, groupId: { in: groups.map((g) => g.id) } }, select: { groupId: true, role: true, state: true } });
    myMemberships = new Map(m.map((x) => [x.groupId, { role: x.role, state: x.state }]));
  }
  const out: SearchHit<GroupHitItem>[] = [];
  for (const r of rows) {
    const g = groups.find((x) => x.id === r.id);
    if (!g) continue;
    const visibility = canSeeGroupDetail({ isPrivate: g.isPrivate, requiresApproval: false }, myMemberships.get(g.id) ?? null);
    const item: GroupHitItem =
      visibility === "preview"
        ? { id: g.id, slug: g.slug, name: g.name, isPrivate: true, description: g.description }
        : { id: g.id, slug: g.slug, name: g.name, isPrivate: g.isPrivate, description: g.description, memberCount: g.memberCount, category: g.category };
    out.push({ type: "groups", id: g.id, rank: r.rank, why: g.isPrivate ? "Private group" : `Matches "${ctx.q}"`, item });
  }
  return out.sort((a, b) => b.rank - a.rank).slice(0, ctx.limit);
}

// ── Events ───────────────────────────────────────────────────────────────

export type EventHitItem = { id: string; slug: string; title: string; startsAt: Date; endsAt: Date; mode: string; venue: string | null; organizationId: string | null; orgName: string | null };

export async function searchEvents(db: Db, ctx: SearchCtx): Promise<SearchHit<EventHitItem>[]> {
  const rows = await ftsIds(db, "Event", "id", ctx.q, ctx.limit * 2);
  if (!rows.length) return [];
  const events = await db.event.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, slug: true, title: true, startsAt: true, endsAt: true, mode: true, venue: true, organizationId: true } });
  const orgCardsMap = await orgCards(db, events.map((e) => e.organizationId).filter((x): x is string => !!x));
  const out: SearchHit<EventHitItem>[] = [];
  for (const r of rows) {
    const ev = events.find((e) => e.id === r.id);
    if (!ev) continue;
    out.push({
      type: "events",
      id: ev.id,
      rank: r.rank,
      why: `Matches "${ctx.q}"`,
      item: { id: ev.id, slug: ev.slug, title: ev.title, startsAt: ev.startsAt, endsAt: ev.endsAt, mode: ev.mode, venue: ev.venue, organizationId: ev.organizationId, orgName: ev.organizationId ? orgCardsMap.get(ev.organizationId)?.displayName ?? null : null },
    });
  }
  return out.sort((a, b) => b.rank - a.rank).slice(0, ctx.limit);
}

// ── RFQs ─────────────────────────────────────────────────────────────────

export type RfqHitItem = { id: string; number: string; title: string; description: string; status: string; budgetMin: string | null; budgetMax: string | null; deadline: Date | null; location: string | null; quoteCount: number };

export async function searchRfqs(db: Db, ctx: SearchCtx): Promise<SearchHit<RfqHitItem>[]> {
  const rows = await ftsIds(db, "Rfq", "id", ctx.q, ctx.limit * 2);
  if (!rows.length) return [];
  const rfqs = await db.rfq.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, number: true, title: true, description: true, status: true, budgetMin: true, budgetMax: true, deadline: true, location: true, quoteCount: true, buyerPersonId: true } });
  const out: SearchHit<RfqHitItem>[] = [];
  for (const r of rows) {
    const rfq = rfqs.find((x) => x.id === r.id);
    if (!rfq) continue;
    const isBuyer = ctx.viewerId === rfq.buyerPersonId;
    if (rfq.status !== "OPEN" && !isBuyer) continue;
    out.push({
      type: "rfqs",
      id: rfq.id,
      rank: r.rank,
      why: `Matches "${ctx.q}" · ${rfq.quoteCount} ${rfq.quoteCount === 1 ? "quote" : "quotes"} so far`,
      item: { id: rfq.id, number: rfq.number, title: rfq.title, description: rfq.description, status: rfq.status, budgetMin: rfq.budgetMin?.toString() ?? null, budgetMax: rfq.budgetMax?.toString() ?? null, deadline: rfq.deadline, location: rfq.location, quoteCount: rfq.quoteCount },
    });
  }
  return out.sort((a, b) => b.rank - a.rank).slice(0, ctx.limit);
}

// ── Opportunities ────────────────────────────────────────────────────────

export type OpportunityHitItem = { id: string; title: string; description: string; location: string | null; status: string; typeId: string; typeName: string | null; posterId: string; organizationId: string | null };

export async function searchOpportunities(db: Db, ctx: SearchCtx): Promise<SearchHit<OpportunityHitItem>[]> {
  const rows = await ftsIds(db, "Opportunity", "id", ctx.q, ctx.limit * 2, Prisma.sql`AND status = 'OPEN'`);
  if (!rows.length) return [];
  const opps = await db.opportunity.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, title: true, description: true, location: true, status: true, typeId: true, posterId: true, organizationId: true } });
  const types = await db.opportunityType.findMany({ where: { id: { in: [...new Set(opps.map((o) => o.typeId))] } }, select: { id: true, name: true } });
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  const out: SearchHit<OpportunityHitItem>[] = [];
  for (const r of rows) {
    const o = opps.find((x) => x.id === r.id);
    if (!o) continue;
    out.push({
      type: "opportunities",
      id: o.id,
      rank: r.rank,
      why: `Matches "${ctx.q}"`,
      item: { id: o.id, title: o.title, description: o.description, location: o.location, status: o.status, typeId: o.typeId, typeName: typeName.get(o.typeId) ?? null, posterId: o.posterId, organizationId: o.organizationId },
    });
  }
  return out.sort((a, b) => b.rank - a.rank).slice(0, ctx.limit);
}

export const SEARCHERS: Record<SearchType, (db: Db, ctx: SearchCtx) => Promise<SearchHit[]>> = {
  people: searchPeople as any,
  organizations: searchOrganizations as any,
  posts: searchPosts as any,
  jobs: searchJobs as any,
  listings: searchListings as any,
  groups: searchGroups as any,
  events: searchEvents as any,
  rfqs: searchRfqs as any,
  opportunities: searchOpportunities as any,
};

export const ALL_TYPES: SearchType[] = ["people", "organizations", "posts", "jobs", "listings", "groups", "events", "rfqs", "opportunities"];
