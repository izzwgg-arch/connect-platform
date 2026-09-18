import type { Db } from "../db.js";
import { slugify, shortSuffix } from "../lib/ids.js";
import { buildSearchText } from "../lib/search.js";
import { notify } from "../lib/notify.js";
import { connectionIds } from "../policy/graph.js";
import { personCards, type PersonCard } from "../profiles/cards.js";
import type { Actor } from "../auth/actor.js";
import { visibleContact } from "./policy.js";

/** Slug from the display name, de-duped with a short suffix on collision. */
export async function uniqueOrgSlug(db: Db, displayName: string): Promise<string> {
  const base = slugify(displayName);
  for (let i = 0; i < 8; i++) {
    const candidate = i === 0 ? base : `${base}-${shortSuffix()}`;
    const exists = await db.organization.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }
  return `${base}-${shortSuffix()}`;
}

export function orgSearchText(o: { displayName: string; legalName?: string | null; industry?: string | null; description?: string | null; serviceArea?: string[] | null }): string {
  return buildSearchText([o.displayName, o.legalName, o.industry, o.description, o.serviceArea ?? []]);
}

/** Notify every VERIFIED holder of one of `roles` in the org, excluding the actor. */
export async function notifyOrgHolders(
  db: Db,
  organizationId: string,
  roles: string[],
  input: { kind: string; title: string; body?: string; href?: string; actorId?: string | null; groupKey?: string | null },
) {
  const holders = await db.membership.findMany({
    where: { organizationId, role: { in: roles as any }, affiliation: { in: ["VERIFIED_ADMIN", "VERIFIED_DOMAIN"] } },
    select: { personId: true },
  });
  await Promise.all(
    holders.map((h) =>
      notify(db, {
        personId: h.personId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        href: input.href ?? null,
        actorId: input.actorId ?? null,
        objectType: "Organization",
        objectId: organizationId,
        groupKey: input.groupKey ?? null,
      }),
    ),
  );
}

/** Up to 3 of the viewer's 1st-degree connections who hold a mutual customer/purchased-from tag on this org. */
export async function inYourNetworkBlock(db: Db, viewerPersonId: string | null, organizationId: string): Promise<{ count: number; people: PersonCard[] }> {
  if (!viewerPersonId) return { count: 0, people: [] };
  const conns = await connectionIds(db, viewerPersonId);
  if (!conns.length) return { count: 0, people: [] };
  const tags = await db.relationshipTag.findMany({
    where: { ownerId: { in: conns }, targetOrgId: organizationId, mutual: true, kind: { in: ["CUSTOMER", "PURCHASED_FROM"] } },
    select: { ownerId: true },
    distinct: ["ownerId"],
  });
  const ownerIds = tags.map((t) => t.ownerId);
  const cards = await personCards(db, ownerIds.slice(0, 3));
  return { count: ownerIds.length, people: ownerIds.slice(0, 3).map((id) => cards.get(id)).filter((c): c is PersonCard => !!c) };
}

type OrgRow = {
  id: string;
  slug: string;
  displayName: string;
  legalName: string | null;
  logoAssetId: string | null;
  coverAssetId: string | null;
  description: string | null;
  industry: string | null;
  size: string | null;
  foundedYear: number | null;
  website: string | null;
  domain: string | null;
  domainVerifiedAt: Date | null;
  phone: string | null;
  smsNumber: string | null;
  whatsappNumber: string | null;
  email: string | null;
  hours: unknown;
  serviceArea: string[];
  loopcomTenantId: string | null;
  loopcomLinkedAt: Date | null;
  acceptsRfqs: boolean;
  showPhone: boolean;
  showEmail: boolean;
  showWhatsapp: boolean;
  openMessages: boolean;
  searchEngineVisible: boolean;
  followerCount: number;
  status: string;
  createdAt: Date;
};

/** The full /public/companies/:slug payload. `actor` is null for an anonymous viewer. */
export async function publicCompanyPayload(db: Db, org: OrgRow, actor: Actor | null) {
  const [locations, catalog, verifications, memberships, follow, openJobs, network] = await Promise.all([
    db.orgLocation.findMany({ where: { organizationId: org.id }, orderBy: { isHeadquarters: "desc" } }),
    db.catalogItem.findMany({ where: { organizationId: org.id }, orderBy: { sortOrder: "asc" } }),
    db.verification.findMany({ where: { organizationId: org.id, status: "VERIFIED" }, select: { id: true, kind: true, note: true, expiresAt: true, createdAt: true } }),
    db.membership.findMany({
      where: { organizationId: org.id, affiliation: { in: ["VERIFIED_ADMIN", "VERIFIED_DOMAIN"] }, showOnProfile: true },
      take: 50,
      select: { personId: true, role: true, title: true },
    }),
    actor ? db.follow.findUnique({ where: { followerId_organizationId: { followerId: actor.personId, organizationId: org.id } } }) : Promise.resolve(null),
    db.job.findMany({ where: { organizationId: org.id, status: "OPEN" }, orderBy: { createdAt: "desc" }, take: 3, select: { id: true, title: true, location: true, employmentType: true } }),
    inYourNetworkBlock(db, actor?.personId ?? null, org.id),
  ]);
  const cards = await personCards(db, memberships.map((m) => m.personId));
  const viewerMembership = actor ? await db.membership.findUnique({ where: { personId_organizationId: { personId: actor.personId, organizationId: org.id } } }) : null;
  const openJobsCount = await db.job.count({ where: { organizationId: org.id, status: "OPEN" } });
  const contact = visibleContact(org);

  return {
    id: org.id,
    slug: org.slug,
    displayName: org.displayName,
    legalName: org.legalName,
    logoAssetId: org.logoAssetId,
    coverAssetId: org.coverAssetId,
    description: org.description,
    industry: org.industry,
    size: org.size,
    foundedYear: org.foundedYear,
    website: org.website,
    serviceArea: org.serviceArea,
    hours: org.hours ?? null,
    acceptsRfqs: org.acceptsRfqs,
    followerCount: org.followerCount,
    loopcomLinked: !!org.loopcomTenantId,
    createdAt: org.createdAt,
    contact,
    locations: locations.map((l) => ({ id: l.id, label: l.label, address1: l.address1, city: l.city, region: l.region, postalCode: l.postalCode, country: l.country, phone: l.phone, isHeadquarters: l.isHeadquarters })),
    catalog: catalog.map((c) => ({ id: c.id, name: c.name, description: c.description, priceNote: c.priceNote, assetId: c.assetId, sortOrder: c.sortOrder })),
    verifications: verifications.map((v) => ({ id: v.id, kind: v.kind, note: v.note, expiresAt: v.expiresAt, since: v.createdAt })),
    people: memberships.map((m) => ({ ...cards.get(m.personId), role: m.role, title: m.title })).filter((p) => p.id),
    openJobsCount,
    openJobs,
    inYourNetwork: network,
    viewer: {
      following: !!follow,
      membership: viewerMembership ? { role: viewerMembership.role, permissions: viewerMembership.permissions, affiliation: viewerMembership.affiliation } : null,
      canRequestQuote: org.acceptsRfqs,
      canMessage: org.openMessages,
      canCall: !!(org.loopcomTenantId && actor?.loopcomTenantId),
    },
  };
}
