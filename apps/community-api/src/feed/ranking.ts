import type { Db } from "../db.js";
import { canSeePost, connectionIds, degreeBetween, isBlockedEitherWay, sharesOrganization, type Degree } from "../policy/graph.js";
import { membershipOf } from "../organizations/permissions.js";
import { POST_INCLUDE, type PostRow } from "../posts/service.js";

/**
 * The feed pipeline, as separate, independently-testable stages:
 * candidates(mode) → eligibility → safety → score → diversity → preferences → page.
 * `following` and `latest` are plain chronological generators (candidates() already
 * orders them); every other mode is scored and diversified.
 */
export type FeedMode = "for_you" | "following" | "latest" | "industry" | "local" | "opportunities" | "jobs";
export const FEED_MODES: FeedMode[] = ["for_you", "following", "latest", "industry", "local", "opportunities", "jobs"];

export type ViewerCtx = {
  personId: string;
  industry: string | null;
  location: string | null;
  objectives: string[];
  connectionIds: string[];
  followedOrgIds: string[];
  followedPersonIds: string[];
  mutedPersonIds: string[];
  mutedOrgIds: string[];
  hiddenPostIds: string[];
};

export async function loadViewerCtx(db: Db, personId: string): Promise<ViewerCtx> {
  const [profile, mine, follows, mutes, hides] = await Promise.all([
    db.profile.findUnique({ where: { personId }, select: { industry: true, location: true, objectives: true } }),
    connectionIds(db, personId),
    db.follow.findMany({ where: { followerId: personId }, select: { personId: true, organizationId: true } }),
    db.mute.findMany({ where: { personId }, select: { targetPersonId: true, targetOrgId: true } }),
    db.hide.findMany({ where: { personId }, select: { postId: true } }),
  ]);
  return {
    personId,
    industry: profile?.industry ?? null,
    location: profile?.location ?? null,
    objectives: profile?.objectives ?? [],
    connectionIds: mine,
    followedPersonIds: follows.filter((f) => f.personId).map((f) => f.personId as string),
    followedOrgIds: follows.filter((f) => f.organizationId).map((f) => f.organizationId as string),
    mutedPersonIds: mutes.filter((m) => m.targetPersonId).map((m) => m.targetPersonId as string),
    mutedOrgIds: mutes.filter((m) => m.targetOrgId).map((m) => m.targetOrgId as string),
    hiddenPostIds: hides.map((h) => h.postId),
  };
}

const BASE_WHERE = { deletedAt: null, publishedAt: { not: null } } as const;

/** Candidate generation. Each mode is its own generator, not a filter on one shared list. */
export async function candidates(db: Db, mode: FeedMode, ctx: ViewerCtx, take = 300): Promise<PostRow[]> {
  const followedAuthorIds = [...new Set([...ctx.connectionIds, ...ctx.followedPersonIds, ctx.personId])];
  switch (mode) {
    case "following":
      return db.post.findMany({
        where: { ...BASE_WHERE, OR: [{ authorId: { in: followedAuthorIds } }, { organizationId: { in: ctx.followedOrgIds.length ? ctx.followedOrgIds : ["__none__"] } }] },
        orderBy: { publishedAt: "desc" },
        take,
        include: POST_INCLUDE,
      }) as unknown as Promise<PostRow[]>;
    case "latest":
      return db.post.findMany({ where: { ...BASE_WHERE, visibility: "PUBLIC" }, orderBy: { publishedAt: "desc" }, take, include: POST_INCLUDE }) as unknown as Promise<PostRow[]>;
    case "industry":
      if (!ctx.industry) return [];
      return db.post.findMany({ where: { ...BASE_WHERE, industry: ctx.industry }, orderBy: { publishedAt: "desc" }, take, include: POST_INCLUDE }) as unknown as Promise<PostRow[]>;
    case "local":
      if (!ctx.location) return [];
      return db.post.findMany({ where: { ...BASE_WHERE, location: ctx.location }, orderBy: { publishedAt: "desc" }, take, include: POST_INCLUDE }) as unknown as Promise<PostRow[]>;
    case "opportunities":
      return db.post.findMany({ where: { ...BASE_WHERE, kind: { in: ["OPPORTUNITY", "RFQ", "LISTING"] } }, orderBy: { publishedAt: "desc" }, take, include: POST_INCLUDE }) as unknown as Promise<PostRow[]>;
    case "jobs":
      return db.post.findMany({ where: { ...BASE_WHERE, kind: "JOB" }, orderBy: { publishedAt: "desc" }, take, include: POST_INCLUDE }) as unknown as Promise<PostRow[]>;
    case "for_you":
    default:
      return db.post.findMany({
        where: { ...BASE_WHERE, OR: [{ authorId: { in: followedAuthorIds } }, { organizationId: { in: ctx.followedOrgIds.length ? ctx.followedOrgIds : ["__none__"] } }, { visibility: "PUBLIC" }] },
        orderBy: { publishedAt: "desc" },
        take,
        include: POST_INCLUDE,
      }) as unknown as Promise<PostRow[]>;
  }
}

async function sameOrgForCandidate(db: Db, viewerId: string, r: PostRow): Promise<boolean> {
  if (r.organizationId) return !!(await membershipOf(db, viewerId, r.organizationId));
  return sharesOrganization(db, viewerId, r.authorId);
}

/** canSeePost + not hidden + not muted (author or org) + not blocked either way + published. */
export async function eligibility(db: Db, viewerId: string, ctx: ViewerCtx, rows: PostRow[]): Promise<PostRow[]> {
  const hiddenSet = new Set(ctx.hiddenPostIds);
  const out: PostRow[] = [];
  for (const r of rows) {
    if (!r.publishedAt) continue;
    if (hiddenSet.has(r.id)) continue;
    if (ctx.mutedPersonIds.includes(r.authorId)) continue;
    if (r.organizationId && ctx.mutedOrgIds.includes(r.organizationId)) continue;
    if (await isBlockedEitherWay(db, viewerId, r.authorId)) continue;
    const isAuthor = r.authorId === viewerId;
    const [degree, sameOrganization] = await Promise.all([degreeBetween(db, viewerId, r.authorId), sameOrgForCandidate(db, viewerId, r)]);
    if (!canSeePost(r.visibility as any, { degree, sameOrganization, isAuthor })) continue;
    out.push(r);
  }
  return out;
}

/** Author must be ACTIVE and have no active CONTENT restriction. */
export async function safety(db: Db, rows: PostRow[]): Promise<PostRow[]> {
  if (!rows.length) return [];
  const authorIds = [...new Set(rows.map((r) => r.authorId))];
  const [people, restricted] = await Promise.all([
    db.person.findMany({ where: { id: { in: authorIds } }, select: { id: true, status: true } }),
    db.restriction.findMany({ where: { personId: { in: authorIds }, kind: "CONTENT", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { personId: true } }),
  ]);
  const statusOf = new Map(people.map((p) => [p.id, p.status]));
  const restrictedSet = new Set(restricted.map((r) => r.personId));
  return rows.filter((r) => statusOf.get(r.authorId) === "ACTIVE" && !restrictedSet.has(r.authorId));
}

/** Objectives declared at onboarding map to the post kinds that serve them (brief: "Because you said you want to…"). */
const OBJECTIVE_KIND_MAP: Record<string, string[]> = {
  "Find employment": ["JOB"],
  "Hire employees": ["JOB"],
  "Find customers": ["RFQ"],
  "Sell services": ["RFQ", "LISTING"],
  "Find vendors": ["RFQ", "LISTING"],
  "Find partners": ["OPPORTUNITY"],
  "Find referrals": ["OPPORTUNITY"],
  "Grow my business": ["RFQ", "OPPORTUNITY"],
};
function objectiveWhy(objectives: string[], kind: string): string | null {
  const hit = objectives.find((o) => (OBJECTIVE_KIND_MAP[o] ?? []).includes(kind));
  return hit ? `Because you said you want to ${hit.charAt(0).toLowerCase()}${hit.slice(1)}` : null;
}

export type Scored = { post: PostRow; score: number; why: string | null };

/**
 * `why` may come back as a token — "CONNECTION" / "FOLLOWED_ORG" / "FOLLOWED_PERSON" —
 * when it needs a name the ranker doesn't have; the caller (feed/routes.ts) resolves
 * the token against the hydrated author/org card. Everything else is final text.
 */
export function score(rows: PostRow[], ctx: ViewerCtx): Scored[] {
  const now = Date.now();
  return rows
    .map((r) => {
      const ageHours = Math.max(0, (now - new Date(r.publishedAt!).getTime()) / 3_600_000);
      const recency = Math.max(0.1, 10 - Math.log2(ageHours + 2));
      const engagement = Math.log10(1 + r.reactionCount + 2 * r.commentCount + 3 * r.repostCount);
      let s = recency + engagement;
      let why: string | null = null;

      const isConnection = ctx.connectionIds.includes(r.authorId) && r.authorId !== ctx.personId;
      const isFollowedOrg = !!(r.organizationId && ctx.followedOrgIds.includes(r.organizationId));
      const isFollowedPerson = ctx.followedPersonIds.includes(r.authorId);
      if (isConnection) {
        s *= 2;
        why = "CONNECTION";
      } else if (isFollowedOrg) {
        s *= 1.5;
        why = "FOLLOWED_ORG";
      } else if (isFollowedPerson) {
        s *= 1.3;
        why = "FOLLOWED_PERSON";
      }
      if (ctx.industry && r.industry === ctx.industry) {
        s *= 1.3;
        why = why ?? `Popular in ${ctx.industry}`;
      }
      const objWhy = objectiveWhy(ctx.objectives, r.kind);
      if (objWhy) {
        s *= 1.4;
        why = objWhy;
      }
      return { post: r, score: s, why };
    })
    .sort((a, b) => b.score - a.score || new Date(b.post.publishedAt!).getTime() - new Date(a.post.publishedAt!).getTime());
}

/** No more than `maxConsecutive` posts in a row by the same author. */
export function diversity(scored: Scored[], maxConsecutive = 2): Scored[] {
  const pending = [...scored];
  const out: Scored[] = [];
  while (pending.length) {
    let idx = 0;
    while (idx < pending.length) {
      const authorId = pending[idx].post.authorId;
      const tail = out.slice(-maxConsecutive);
      const blocked = tail.length === maxConsecutive && tail.every((x) => x.post.authorId === authorId);
      if (!blocked) break;
      idx++;
    }
    if (idx >= pending.length) idx = 0; // every remaining candidate would repeat — take one anyway rather than drop it
    out.push(pending[idx]);
    pending.splice(idx, 1);
  }
  return out;
}

/** Muted post kinds (from Person.preferences.mutedPostKinds) are skipped, never scored down. */
export function preferences(scored: Scored[], mutedKinds: string[]): Scored[] {
  if (!mutedKinds.length) return scored;
  const muted = new Set(mutedKinds);
  return scored.filter((s) => !muted.has(s.post.kind));
}

function encodeOffset(n: number): string {
  return Buffer.from(String(n)).toString("base64url");
}
function decodeOffset(cursor: string | undefined | null): number {
  if (!cursor) return 0;
  try {
    const n = parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function page<T>(items: T[], cursor: string | undefined, limit: number): { items: T[]; nextCursor: string | null } {
  const start = decodeOffset(cursor);
  const slice = items.slice(start, start + limit);
  const nextCursor = start + limit < items.length ? encodeOffset(start + limit) : null;
  return { items: slice, nextCursor };
}

/** Resolves a ranker "why" token into copy that names the actual person/company (feed/routes.ts calls this after hydration). */
export function resolveWhy(raw: string | null, author: { name: string } | null, organization: { displayName: string } | null): string | null {
  if (!raw) return null;
  if (raw === "CONNECTION") return `From ${author?.name ?? "a connection"}, a connection`;
  if (raw === "FOLLOWED_ORG") return `Because you follow ${organization?.displayName ?? "this company"}`;
  if (raw === "FOLLOWED_PERSON") return `Because you follow ${author?.name ?? "them"}`;
  return raw;
}
