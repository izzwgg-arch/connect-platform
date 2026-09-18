import type { Db } from "../db.js";

/** The one shape every list of people renders. Extend, never fork. */
export type PersonCard = {
  id: string;
  username: string;
  name: string;
  firstName: string;
  lastName: string;
  headline: string | null;
  avatarAssetId: string | null;
  location: string | null;
  industry: string | null;
  verified: string[];
  primaryOrg: { id: string; slug: string; displayName: string } | null;
};

export async function personCards(db: Db, personIds: string[]): Promise<Map<string, PersonCard>> {
  const ids = [...new Set(personIds)];
  if (!ids.length) return new Map();
  const [people, verifications, memberships] = await Promise.all([
    db.person.findMany({
      where: { id: { in: ids } },
      select: { id: true, username: true, profile: { select: { firstName: true, lastName: true, headline: true, avatarAssetId: true, location: true, industry: true } } },
    }),
    db.verification.findMany({ where: { personId: { in: ids }, status: "VERIFIED" }, select: { personId: true, kind: true } }),
    db.membership.findMany({
      where: { personId: { in: ids }, showOnProfile: true, affiliation: { in: ["VERIFIED_ADMIN", "VERIFIED_DOMAIN"] } },
      orderBy: { isPrimary: "desc" },
      select: { personId: true, isPrimary: true, organization: { select: { id: true, slug: true, displayName: true } } },
    }),
  ]);
  const out = new Map<string, PersonCard>();
  for (const p of people) {
    const prof = p.profile;
    const name = prof ? `${prof.firstName} ${prof.lastName}`.trim() : p.username;
    const m = memberships.find((x) => x.personId === p.id);
    out.set(p.id, {
      id: p.id,
      username: p.username,
      name,
      firstName: prof?.firstName ?? "",
      lastName: prof?.lastName ?? "",
      headline: prof?.headline ?? null,
      avatarAssetId: prof?.avatarAssetId ?? null,
      location: prof?.location ?? null,
      industry: prof?.industry ?? null,
      verified: verifications.filter((v) => v.personId === p.id).map((v) => v.kind),
      primaryOrg: m?.organization ?? null,
    });
  }
  return out;
}

export async function personCard(db: Db, personId: string): Promise<PersonCard | null> {
  return (await personCards(db, [personId])).get(personId) ?? null;
}
