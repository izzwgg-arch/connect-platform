import type { Db } from "../db.js";

export type OrgCard = {
  id: string;
  slug: string;
  displayName: string;
  logoAssetId: string | null;
  industry: string | null;
  size: string | null;
  location: string | null;
  followerCount: number;
  verified: string[];
  loopcomLinked: boolean;
};

export async function orgCards(db: Db, orgIds: string[]): Promise<Map<string, OrgCard>> {
  const ids = [...new Set(orgIds)];
  if (!ids.length) return new Map();
  const [orgs, verifications, hqs] = await Promise.all([
    db.organization.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true, displayName: true, logoAssetId: true, industry: true, size: true, followerCount: true, loopcomTenantId: true } }),
    db.verification.findMany({ where: { organizationId: { in: ids }, status: "VERIFIED" }, select: { organizationId: true, kind: true } }),
    db.orgLocation.findMany({ where: { organizationId: { in: ids } }, orderBy: { isHeadquarters: "desc" }, select: { organizationId: true, city: true, region: true } }),
  ]);
  const out = new Map<string, OrgCard>();
  for (const o of orgs) {
    const hq = hqs.find((h) => h.organizationId === o.id);
    out.set(o.id, {
      id: o.id,
      slug: o.slug,
      displayName: o.displayName,
      logoAssetId: o.logoAssetId,
      industry: o.industry,
      size: o.size,
      location: hq ? [hq.city, hq.region].filter(Boolean).join(", ") || null : null,
      followerCount: o.followerCount,
      verified: verifications.filter((v) => v.organizationId === o.id).map((v) => v.kind),
      loopcomLinked: !!o.loopcomTenantId,
    });
  }
  return out;
}

export async function orgCard(db: Db, orgId: string): Promise<OrgCard | null> {
  return (await orgCards(db, [orgId])).get(orgId) ?? null;
}
