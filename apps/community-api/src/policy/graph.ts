import type { Db } from "../db.js";

/**
 * Pure graph/visibility decisions. Routes call these; they never re-derive a
 * rule inline (the Direct precedent). Every function is safe to call with
 * viewer === null (anonymous).
 */

export const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);
export const canonicalPair = (a: string, b: string) => (a < b ? { aId: a, bId: b } : { aId: b, bId: a });

export type Degree = 0 | 1 | 2 | 3; // 0 = self, 3 = "3rd+/none"

export async function isBlockedEitherWay(db: Db, x: string, y: string): Promise<boolean> {
  if (x === y) return false;
  const n = await db.block.count({
    where: { OR: [{ blockerId: x, blockedId: y }, { blockerId: y, blockedId: x }] },
  });
  return n > 0;
}

export async function connectionIds(db: Db, personId: string): Promise<string[]> {
  const rows = await db.connection.findMany({
    where: { status: "ACTIVE", OR: [{ aId: personId }, { bId: personId }] },
    select: { aId: true, bId: true },
  });
  return rows.map((r) => (r.aId === personId ? r.bId : r.aId));
}

export async function degreeBetween(db: Db, viewerId: string | null, targetId: string): Promise<Degree> {
  if (!viewerId) return 3;
  if (viewerId === targetId) return 0;
  const p = canonicalPair(viewerId, targetId);
  const direct = await db.connection.findUnique({ where: { aId_bId: p }, select: { status: true } });
  if (direct?.status === "ACTIVE") return 1;
  const mine = await connectionIds(db, viewerId);
  if (mine.length === 0) return 3;
  const second = await db.connection.count({
    where: {
      status: "ACTIVE",
      OR: [
        { aId: targetId, bId: { in: mine } },
        { bId: targetId, aId: { in: mine } },
      ],
    },
  });
  return second > 0 ? 2 : 3;
}

export async function mutualConnections(db: Db, viewerId: string, targetId: string, take = 6) {
  const [mine, theirs] = await Promise.all([connectionIds(db, viewerId), connectionIds(db, targetId)]);
  const set = new Set(theirs);
  const ids = mine.filter((id) => set.has(id));
  const sample = ids.length
    ? await db.profile.findMany({ where: { personId: { in: ids.slice(0, take) } }, select: { personId: true, firstName: true, lastName: true, headline: true, avatarAssetId: true } })
    : [];
  return { count: ids.length, sample };
}

/** Defaults per profile category when the person has not chosen. */
export const DEFAULT_VISIBILITY: Record<string, "PUBLIC" | "CONNECTIONS" | "ORGANIZATION" | "PRIVATE"> = {
  headline: "PUBLIC",
  about: "PUBLIC",
  experience: "PUBLIC",
  education: "PUBLIC",
  skills: "PUBLIC",
  services: "PUBLIC",
  phone: "CONNECTIONS",
  email: "PRIVATE",
  connections: "CONNECTIONS",
  activity: "PUBLIC",
  location: "PUBLIC",
  languages: "PUBLIC",
  links: "PUBLIC",
  portfolio: "PUBLIC",
  certifications: "PUBLIC",
};

export function canSee(
  visibility: "PUBLIC" | "CONNECTIONS" | "ORGANIZATION" | "PRIVATE",
  ctx: { degree: Degree; sameOrganization: boolean },
): boolean {
  if (ctx.degree === 0) return true;
  switch (visibility) {
    case "PUBLIC":
      return true;
    case "CONNECTIONS":
      return ctx.degree === 1;
    case "ORGANIZATION":
      return ctx.sameOrganization;
    case "PRIVATE":
      return false;
  }
}

export async function sharesOrganization(db: Db, a: string | null, b: string): Promise<boolean> {
  if (!a || a === b) return false;
  const orgs = await db.membership.findMany({ where: { personId: a, affiliation: { in: ["VERIFIED_ADMIN", "VERIFIED_DOMAIN"] } }, select: { organizationId: true } });
  if (!orgs.length) return false;
  const n = await db.membership.count({ where: { personId: b, organizationId: { in: orgs.map((o) => o.organizationId) } } });
  return n > 0;
}

export type PostVisibility = "PUBLIC" | "CONNECTIONS" | "ORGANIZATION" | "PRIVATE";

/** Post reach rule: PUBLIC = everyone incl. anonymous; CONNECTIONS = author's 1st degree; ORGANIZATION = org members; PRIVATE = author only. */
export function canSeePost(vis: PostVisibility, ctx: { degree: Degree; sameOrganization: boolean; isAuthor: boolean }): boolean {
  if (ctx.isAuthor) return true;
  return canSee(vis, ctx);
}
