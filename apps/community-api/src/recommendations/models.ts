import type { Db } from "../db.js";
import { Prisma } from "../db.js";
import { connectionIds } from "../policy/graph.js";
import { permissionsForMembership } from "../organizations/permissions.js";
import { ftsIds } from "../lib/search.js";
import { matchVendors } from "../rfq/matching.js";
import { MUTUAL_TAG_KINDS, VERIFIED_AFFILIATIONS, describeEvidence, type IntroEvidence } from "../intros/policy.js";

/**
 * Deterministic, explainable heuristics (brief §29: rules first, no fake ML).
 * Every model returns candidates already sorted best-first; the route layer
 * turns them into RecommendationImpression rows and hydrates cards. No model
 * ever calls an external ranking/ML service — see embeddings.ts for the seam
 * a future one would use, and why it stays declared-signal-only.
 */
export type RecoItem = { objectType: "Organization" | "Person" | "Job" | "Group" | "Event"; objectId: string; reason: string; score: number };

const NINETY_DAYS_MS = 90 * 24 * 3600 * 1000;
export const ninetyDaysAgo = () => new Date(Date.now() - NINETY_DAYS_MS);

/** Small, hardcoded adjacency: industries that commonly buy from / sell to each other. Extend as data, never infer it. */
export const INDUSTRY_ADJACENCY: Record<string, string[]> = {
  "Construction & trades": ["Real estate", "Retail", "Manufacturing"],
  "Real estate": ["Construction & trades", "Legal", "Insurance", "Home services"],
  "Printing & signage": ["Retail", "Marketing", "Apparel & uniforms", "Nonprofit"],
  "Apparel & uniforms": ["Retail", "Healthcare", "Food & catering", "Printing & signage"],
  Retail: ["Wholesale & distribution", "Printing & signage", "Marketing", "Transportation & logistics"],
  "Wholesale & distribution": ["Retail", "Manufacturing", "Transportation & logistics"],
  Healthcare: ["Apparel & uniforms", "ABA & special education", "Insurance", "Technology"],
  "ABA & special education": ["Healthcare", "Education", "Nonprofit"],
  "Technology": ["Marketing", "Telecom", "Accounting & bookkeeping", "Healthcare"],
  Telecom: ["Technology", "Retail", "Marketing"],
  "Accounting & bookkeeping": ["Technology", "Retail", "Construction & trades", "Nonprofit"],
  "Transportation & logistics": ["Retail", "Wholesale & distribution", "Manufacturing", "Food & catering"],
  "Food & catering": ["Apparel & uniforms", "Transportation & logistics", "Nonprofit"],
  Nonprofit: ["Printing & signage", "Accounting & bookkeeping", "Education"],
  Education: ["ABA & special education", "Nonprofit", "Technology"],
  Legal: ["Real estate", "Insurance", "Accounting & bookkeeping"],
  Insurance: ["Real estate", "Healthcare", "Legal"],
  Marketing: ["Retail", "Printing & signage", "Technology"],
  Manufacturing: ["Construction & trades", "Wholesale & distribution", "Transportation & logistics"],
};

function bump(map: Map<string, { score: number; reason: string }>, id: string, score: number, reason: string) {
  const existing = map.get(id);
  if (existing) existing.score += score;
  else map.set(id, { score, reason });
}

/* ─────────────────────────── organizationsYouMayNeed (byn-v1) ─────────────────────────── */

export async function organizationsYouMayNeed(db: Db, personId: string, opts: { excludeIds?: Set<string>; limit: number }): Promise<RecoItem[]> {
  const [profile, myConnections, myFollows, myMutes, myMemberships] = await Promise.all([
    db.profile.findUnique({ where: { personId }, select: { industry: true, location: true, objectives: true } }),
    connectionIds(db, personId),
    db.follow.findMany({ where: { followerId: personId, organizationId: { not: null } }, select: { organizationId: true } }),
    db.mute.findMany({ where: { personId, targetOrgId: { not: null } }, select: { targetOrgId: true } }),
    db.membership.findMany({ where: { personId }, select: { organizationId: true } }),
  ]);

  const excluded = new Set<string>(opts.excludeIds ?? []);
  for (const f of myFollows) if (f.organizationId) excluded.add(f.organizationId);
  for (const m of myMutes) if (m.targetOrgId) excluded.add(m.targetOrgId);
  for (const m of myMemberships) excluded.add(m.organizationId);

  const candidates = new Map<string, { score: number; reason: string }>();

  // 1) Same industry.
  if (profile?.industry) {
    const peers = await db.organization.findMany({ where: { industry: profile.industry, status: "ACTIVE", id: { notIn: [...excluded] } }, select: { id: true } });
    for (const o of peers) bump(candidates, o.id, 3, `In your industry (${profile.industry})`);
  }

  // 2) Orgs followed by the viewer's 1st-degree connections.
  if (myConnections.length) {
    const rows = await db.follow.findMany({ where: { followerId: { in: myConnections }, organizationId: { not: null, notIn: [...excluded] } }, select: { organizationId: true } });
    const counts = new Map<string, number>();
    for (const r of rows) if (r.organizationId) counts.set(r.organizationId, (counts.get(r.organizationId) ?? 0) + 1);
    for (const [id, n] of counts) bump(candidates, id, n, `${n} connection${n === 1 ? "" : "s"} follow${n === 1 ? "s" : ""} this company`);
  }

  // 3) Mutual RelationshipTags from connections (owner-private tags: expose only the count + kind, never who).
  if (myConnections.length) {
    const tags = await db.relationshipTag.findMany({
      where: { ownerId: { in: myConnections }, targetOrgId: { not: null, notIn: [...excluded] }, mutual: true },
      select: { targetOrgId: true, kind: true },
    });
    const byOrgKind = new Map<string, Map<string, number>>();
    for (const t of tags) {
      if (!t.targetOrgId) continue;
      const kinds = byOrgKind.get(t.targetOrgId) ?? new Map<string, number>();
      kinds.set(t.kind, (kinds.get(t.kind) ?? 0) + 1);
      byOrgKind.set(t.targetOrgId, kinds);
    }
    for (const [orgId, kinds] of byOrgKind) {
      const [kind, n] = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0];
      const label = kind === "CUSTOMER" ? "customers" : kind === "VENDOR" ? "vendors" : kind === "PARTNER" ? "partners" : "connections";
      bump(candidates, orgId, n * 2, `${n} ${label} in your network`);
    }
  }

  // 4) Declared objectives.
  const objectives = profile?.objectives ?? [];
  if (objectives.includes("Find vendors")) {
    const verified = await db.verification.findMany({ where: { kind: "BUSINESS", status: "VERIFIED", organizationId: { not: null, notIn: [...excluded] } }, select: { organizationId: true } });
    for (const v of verified) if (v.organizationId) bump(candidates, v.organizationId, 1, "Verified business — you said you're looking for vendors");
  }
  if (objectives.includes("Find customers") && profile?.industry) {
    const adjacent = INDUSTRY_ADJACENCY[profile.industry] ?? [];
    if (adjacent.length) {
      const orgs = await db.organization.findMany({ where: { industry: { in: adjacent }, status: "ACTIVE", id: { notIn: [...excluded] } }, select: { id: true, industry: true } });
      for (const o of orgs) bump(candidates, o.id, 1, `${o.industry} tends to buy from ${profile.industry}`);
    }
  }

  return [...candidates.entries()]
    .filter(([id]) => !excluded.has(id))
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, opts.limit)
    .map(([objectId, v]) => ({ objectType: "Organization" as const, objectId, reason: v.reason, score: v.score }));
}

/* ─────────────────────────── customersYouMayWant (cymw-v1) ─────────────────────────── */

export async function customersYouMayWant(db: Db, personId: string, opts: { excludeIds?: Set<string>; limit: number }): Promise<RecoItem[]> {
  const [profile, myMemberships] = await Promise.all([
    db.profile.findUnique({ where: { personId }, select: { industry: true } }),
    db.membership.findMany({ where: { personId }, select: { organizationId: true, role: true, permissions: true } }),
  ]);

  // Only meaningful for people who can actually quote for a business — check org.quote directly.
  const myQuotingOrgIds = myMemberships.filter((m) => permissionsForMembership(m).has("org.quote")).map((m) => m.organizationId);
  if (!myQuotingOrgIds.length) return [];

  const excluded = new Set<string>(opts.excludeIds ?? []);
  excluded.add(personId);
  const candidates = new Map<string, { score: number; reason: string }>();

  // 1) Buyers whose recent OPEN RFQs sit in a category the viewer's org(s) sell in (own Listings' categories).
  const listings = await db.listing.findMany({ where: { organizationId: { in: myQuotingOrgIds }, categoryId: { not: null } }, select: { categoryId: true, category: { select: { name: true } } } });
  const categoryIds = [...new Set(listings.map((l) => l.categoryId!).filter(Boolean))];
  if (categoryIds.length) {
    const rfqs = await db.rfq.findMany({
      where: { categoryId: { in: categoryIds }, status: "OPEN", createdAt: { gte: ninetyDaysAgo() } },
      select: { buyerPersonId: true, organizationId: true, category: { select: { name: true } } },
    });
    for (const r of rfqs) {
      const label = r.category?.name ?? "a category you sell in";
      if (r.organizationId && myQuotingOrgIds.includes(r.organizationId)) continue;
      if (!excluded.has(r.buyerPersonId)) bump(candidates, r.buyerPersonId, 2, `Requested a quote for ${label} in the last 90 days`);
      if (r.organizationId && !excluded.has(r.organizationId)) bump(candidates, r.organizationId, 2, `Requested a quote for ${label} in the last 90 days`);
    }
  }

  // 2) Industries that typically buy from the viewer's industry (adjacency table), as a light discovery layer.
  if (profile?.industry) {
    const buyerIndustries = Object.entries(INDUSTRY_ADJACENCY)
      .filter(([, sells]) => sells.includes(profile.industry!))
      .map(([buyer]) => buyer);
    if (buyerIndustries.length) {
      const [people, orgs] = await Promise.all([
        db.profile.findMany({ where: { industry: { in: buyerIndustries }, personId: { notIn: [...excluded] } }, select: { personId: true, industry: true }, take: 50 }),
        db.organization.findMany({ where: { industry: { in: buyerIndustries }, status: "ACTIVE", id: { notIn: [...excluded] } }, select: { id: true, industry: true }, take: 50 }),
      ]);
      for (const p of people) bump(candidates, p.personId, 1, `${p.industry} businesses often buy from ${profile.industry}`);
      for (const o of orgs) bump(candidates, o.id, 1, `${o.industry} businesses often buy from ${profile.industry}`);
    }
  }

  // Opportunities are deliberately NOT matched here: Opportunity has no categoryId (fieldSchema is
  // freeform per OpportunityType), so there is no non-fake way to tie one to "the viewer's categories"
  // without guessing at free text. Left out rather than shipping a low-confidence match.

  // Figure out which surviving ids are people vs organizations for objectType tagging.
  const ids = [...candidates.keys()].filter((id) => !excluded.has(id));
  if (!ids.length) return [];
  const [peopleRows, orgRows] = await Promise.all([
    db.person.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    db.organization.findMany({ where: { id: { in: ids } }, select: { id: true } }),
  ]);
  const personSet = new Set(peopleRows.map((p) => p.id));
  const orgSet = new Set(orgRows.map((o) => o.id));

  return ids
    .map((id) => ({ id, ...candidates.get(id)! }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit)
    .map((c) => ({ objectType: (personSet.has(c.id) ? "Person" : orgSet.has(c.id) ? "Organization" : "Person") as RecoItem["objectType"], objectId: c.id, reason: c.reason, score: c.score }));
}

/* ─────────────────────────── jobsYouMayLike (jyml-v1) ─────────────────────────── */

export async function jobsYouMayLike(db: Db, personId: string, opts: { excludeIds?: Set<string>; limit: number }): Promise<RecoItem[]> {
  const profile = await db.profile.findUnique({ where: { personId }, select: { objectives: true, skills: true, headline: true, industry: true, location: true } });
  if (!profile?.objectives.includes("Find employment")) return [];

  const excluded = opts.excludeIds ?? new Set<string>();
  const terms = [...(profile.skills ?? []), profile.headline, profile.industry].filter((s): s is string => !!s && s.trim().length > 0).join(" ");

  let jobIds: string[] = [];
  if (terms.trim()) {
    const rows = await ftsIds(db, "Job", "id", terms, opts.limit * 3, Prisma.sql`AND "status" = 'OPEN'`);
    jobIds = rows.map((r) => r.id);
  }
  if (!jobIds.length) {
    const rows = await db.job.findMany({
      where: { status: "OPEN", ...(profile.location ? { location: profile.location } : {}) },
      orderBy: { createdAt: "desc" },
      take: opts.limit * 2,
      select: { id: true },
    });
    jobIds = rows.map((r) => r.id);
  }
  jobIds = jobIds.filter((id) => !excluded.has(id));
  if (!jobIds.length) return [];

  const jobs = await db.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, requirements: true, location: true, organization: { select: { industry: true } } } });
  const bySkillMatch = new Map<string, { score: number; reason: string }>();
  const mySkills = new Set((profile.skills ?? []).map((s) => s.toLowerCase()));
  for (const j of jobs) {
    const order = jobIds.indexOf(j.id);
    const matchedSkills = j.requirements.filter((r) => [...mySkills].some((s) => r.toLowerCase().includes(s)));
    let reason = "Matches your profile";
    let score = jobIds.length - order;
    if (matchedSkills.length) {
      reason = `Matches your skills: ${matchedSkills.slice(0, 2).join(", ")}`;
      score += matchedSkills.length * 2;
    } else if (profile.location && j.location === profile.location) {
      reason = `Open role in ${profile.location}`;
      score += 1;
    } else if (profile.industry && j.organization?.industry === profile.industry) {
      reason = `Open role in ${profile.industry}`;
      score += 1;
    }
    bySkillMatch.set(j.id, { score, reason });
  }

  return [...bySkillMatch.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, opts.limit)
    .map(([objectId, v]) => ({ objectType: "Job" as const, objectId, reason: v.reason, score: v.score }));
}

/* ─────────────────────────── candidatesForJob (cand-v1) ─────────────────────────── */

export async function candidatesForJob(db: Db, jobId: string, opts: { excludeIds?: Set<string>; limit: number }): Promise<RecoItem[]> {
  const job = await db.job.findUnique({ where: { id: jobId }, select: { title: true, requirements: true, location: true } });
  if (!job) return [];
  const excluded = opts.excludeIds ?? new Set<string>();
  const alreadyApplied = await db.jobApplication.findMany({ where: { jobId }, select: { personId: true } });
  for (const a of alreadyApplied) excluded.add(a.personId);

  const query = [job.title, ...job.requirements, job.location].filter((s): s is string => !!s && s.trim().length > 0).join(" ");
  if (!query.trim()) return [];
  const rows = await ftsIds(db, "Profile", "personId", query, opts.limit + excluded.size);
  const items: RecoItem[] = [];
  for (const r of rows) {
    if (excluded.has(r.id)) continue;
    items.push({ objectType: "Person", objectId: r.id, reason: `Profile matches "${job.title}"`, score: r.rank });
    if (items.length >= opts.limit) break;
  }
  return items;
}

/* ─────────────────────────── groupsForYou ─────────────────────────── */

export async function groupsForYou(db: Db, personId: string, opts: { excludeIds?: Set<string>; limit: number }): Promise<RecoItem[]> {
  const [profile, myConnections, joined] = await Promise.all([
    db.profile.findUnique({ where: { personId }, select: { industry: true } }),
    connectionIds(db, personId),
    db.groupMember.findMany({ where: { personId, state: "ACTIVE" }, select: { groupId: true } }),
  ]);
  const excluded = new Set<string>(opts.excludeIds ?? []);
  for (const g of joined) excluded.add(g.groupId);

  const candidates = new Map<string, { score: number; reason: string }>();
  if (profile?.industry) {
    const rows = await db.group.findMany({ where: { category: profile.industry, id: { notIn: [...excluded] } }, select: { id: true } });
    for (const g of rows) bump(candidates, g.id, 2, `In your industry (${profile.industry})`);
  }
  if (myConnections.length) {
    const rows = await db.groupMember.findMany({ where: { personId: { in: myConnections }, state: "ACTIVE", groupId: { notIn: [...excluded] } }, select: { groupId: true } });
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.groupId, (counts.get(r.groupId) ?? 0) + 1);
    for (const [id, n] of counts) bump(candidates, id, n, `${n} connection${n === 1 ? "" : "s"} in this group`);
  }
  return [...candidates.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, opts.limit)
    .map(([objectId, v]) => ({ objectType: "Group" as const, objectId, reason: v.reason, score: v.score }));
}

/* ─────────────────────────── eventsForYou ─────────────────────────── */

export async function eventsForYou(db: Db, personId: string, opts: { excludeIds?: Set<string>; limit: number }): Promise<RecoItem[]> {
  const [profile, myConnections] = await Promise.all([
    db.profile.findUnique({ where: { personId }, select: { industry: true } }),
    connectionIds(db, personId),
  ]);
  const excluded = new Set<string>(opts.excludeIds ?? []);
  const candidates = new Map<string, { score: number; reason: string }>();

  if (profile?.industry) {
    const rows = await db.event.findMany({
      where: { startsAt: { gt: new Date() }, id: { notIn: [...excluded] }, organization: { industry: profile.industry } },
      select: { id: true },
    });
    for (const e of rows) bump(candidates, e.id, 2, `In your industry (${profile.industry})`);
  }
  if (myConnections.length) {
    const rows = await db.eventRsvp.findMany({
      where: { personId: { in: myConnections }, status: "GOING", visible: true, event: { startsAt: { gt: new Date() } }, eventId: { notIn: [...excluded] } },
      select: { eventId: true },
    });
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.eventId, (counts.get(r.eventId) ?? 0) + 1);
    for (const [id, n] of counts) bump(candidates, id, n, `${n} connection${n === 1 ? "" : "s"} going`);
  }
  return [...candidates.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, opts.limit)
    .map(([objectId, v]) => ({ objectType: "Event" as const, objectId, reason: v.reason, score: v.score }));
}

/* ─────────────────────────── vendorsForRfq ─────────────────────────── */

/** Reuses the RFQ agent's own matcher (src/rfq/matching.ts) rather than forking a second scoring pass. */
export async function vendorsForRfq(db: Db, rfqId: string, opts: { excludeIds?: Set<string>; limit: number }): Promise<RecoItem[]> {
  const rfq = await db.rfq.findUnique({
    where: { id: rfqId },
    select: { title: true, description: true, location: true, buyerPersonId: true, organizationId: true, category: { select: { slug: true } } },
  });
  if (!rfq) return [];
  const excluded = new Set<string>(opts.excludeIds ?? []);
  if (rfq.organizationId) excluded.add(rfq.organizationId);
  const invited = await db.rfqInvite.findMany({ where: { rfqId }, select: { organizationId: true } });
  for (const i of invited) excluded.add(i.organizationId);

  const matches = await matchVendors(db, {
    title: rfq.title,
    description: rfq.description,
    categorySlug: rfq.category?.slug ?? null,
    location: rfq.location,
    buyerPersonId: rfq.buyerPersonId,
  });
  return matches
    .filter((m) => !excluded.has(m.organizationId))
    .slice(0, opts.limit)
    .map((m, i, arr) => ({ objectType: "Organization" as const, objectId: m.organizationId, reason: m.reason, score: arr.length - i }));
}

/* ─────────────────────────── introsForYou ─────────────────────────── */

/**
 * People 2 hops away at organizations that match the viewer's objectives,
 * surfaced only when a 1st-degree connection ("the middle") already holds
 * DISCOVERABLE evidence toward that org (src/intros/policy.ts's rule — a
 * verified membership or a mutual, two-sided RelationshipTag). No evidence,
 * no suggestion: this never invents a path the intros domain wouldn't honor.
 * Not wired to an HTTP route — the intros domain (src/intros/routes.ts) owns
 * that surface (`GET /intros/paths` finds paths TO a chosen target); this is
 * the opposite direction (proactively surfacing worthwhile targets) and is
 * exported for whoever wires a "suggested intros" rail into that domain.
 */
export async function introsForYou(db: Db, personId: string, opts: { excludeIds?: Set<string>; limit: number }): Promise<RecoItem[]> {
  const [profile, myConnections] = await Promise.all([
    db.profile.findUnique({ where: { personId }, select: { industry: true, objectives: true } }),
    connectionIds(db, personId),
  ]);
  if (!myConnections.length) return [];

  const excluded = new Set<string>(opts.excludeIds ?? []);
  excluded.add(personId);
  for (const c of myConnections) excluded.add(c);

  const objectives = profile?.objectives ?? [];
  const industryFilters: string[] = [];
  if (profile?.industry && objectives.includes("Find partners")) industryFilters.push(profile.industry);
  if (profile?.industry && objectives.includes("Find customers")) industryFilters.push(...(INDUSTRY_ADJACENCY[profile.industry] ?? []));
  const wantVerifiedBusiness = objectives.includes("Find vendors");
  if (!industryFilters.length && !wantVerifiedBusiness) return [];

  const targetOrgIds = new Set<string>();
  if (industryFilters.length) {
    const orgs = await db.organization.findMany({ where: { industry: { in: industryFilters }, status: "ACTIVE" }, select: { id: true } });
    for (const o of orgs) targetOrgIds.add(o.id);
  }
  if (wantVerifiedBusiness) {
    const verified = await db.verification.findMany({ where: { kind: "BUSINESS", status: "VERIFIED", organizationId: { not: null } }, select: { organizationId: true } });
    for (const v of verified) if (v.organizationId) targetOrgIds.add(v.organizationId);
  }
  if (!targetOrgIds.size) return [];

  const targets = await db.membership.findMany({
    where: { organizationId: { in: [...targetOrgIds] }, affiliation: { in: [...VERIFIED_AFFILIATIONS] }, personId: { notIn: [...excluded] } },
    select: { personId: true, organizationId: true, role: true, organization: { select: { displayName: true } } },
  });
  if (!targets.length) return [];

  const [middleMemberships, middleTags] = await Promise.all([
    db.membership.findMany({ where: { personId: { in: myConnections }, organizationId: { in: [...targetOrgIds] }, affiliation: { in: [...VERIFIED_AFFILIATIONS] } }, select: { organizationId: true, role: true } }),
    db.relationshipTag.findMany({ where: { ownerId: { in: myConnections }, targetOrgId: { in: [...targetOrgIds] }, mutual: true, kind: { in: MUTUAL_TAG_KINDS } }, select: { targetOrgId: true, kind: true } }),
  ]);

  const evidenceByOrg = new Map<string, IntroEvidence>();
  for (const m of middleMemberships) if (!evidenceByOrg.has(m.organizationId)) evidenceByOrg.set(m.organizationId, { kind: "verified_membership", role: m.role });
  for (const t of middleTags) if (t.targetOrgId && !evidenceByOrg.has(t.targetOrgId)) evidenceByOrg.set(t.targetOrgId, { kind: "mutual_org_tag", tagKind: t.kind });

  const items: RecoItem[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.personId) || excluded.has(t.personId)) continue;
    const evidence = evidenceByOrg.get(t.organizationId);
    if (!evidence) continue; // no discoverable path — never fabricate a connection
    const { how, strength } = describeEvidence(evidence);
    items.push({ objectType: "Person", objectId: t.personId, reason: `A connection ${how} ${t.organization.displayName}`, score: strength });
    seen.add(t.personId);
    if (items.length >= opts.limit) break;
  }
  return items;
}

/*
 * postsForYou is not built here — it is the feed agent's ranking pipeline
 * (src/feed/ranking.ts + GET /feed) and duplicating it would fork the ranking
 * logic.
 */
