import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { requireActor } from "../auth/actor.js";
import { badRequest } from "../lib/errors.js";
import { clampLimit } from "../lib/pagination.js";
import { track } from "../lib/analytics.js";
import { orgCards } from "../organizations/cards.js";
import { hydratePosts, type PostRow } from "../posts/service.js";
import { candidates, diversity, eligibility, FEED_MODES, loadViewerCtx, page, preferences, resolveWhy, safety, score, type FeedMode, type Scored } from "./ranking.js";

export function registerFeedRoutes(app: FastifyInstance, db: Db) {
  app.get("/feed", async (req) => {
    const actor = requireActor(req);
    const query = req.query as Record<string, string | undefined>;
    const mode = (query.mode ?? "for_you") as FeedMode;
    if (!FEED_MODES.includes(mode)) throw badRequest("invalid_mode", "That feed mode doesn't exist.");
    const limit = clampLimit(query.limit, 20, 50);

    const ctx = await loadViewerCtx(db, actor.personId);
    const raw = await candidates(db, mode, ctx);
    const eligible = await eligibility(db, actor.personId, ctx, raw);
    const safe = await safety(db, eligible);

    const person = await db.person.findUnique({ where: { id: actor.personId }, select: { preferences: true } });
    const mutedKinds = ((person?.preferences as any)?.mutedPostKinds as string[] | undefined) ?? [];

    const isChronological = mode === "following" || mode === "latest";
    const scored: Scored[] = isChronological
      ? safe.map((r) => ({ post: r, score: 0, why: mode === "following" ? chronologicalWhy(r, ctx) : null }))
      : diversity(score(safe, ctx));
    const filtered = preferences(scored, mutedKinds);
    const { items: pageItems, nextCursor } = page(filtered, query.cursor, limit);

    const dtos = await hydratePosts(db, pageItems.map((p) => p.post), actor.personId);
    const results: Array<{ post: (typeof dtos)[number]; recommendationId: string; why: string | null }> = [];
    for (let i = 0; i < pageItems.length; i++) {
      const dto = dtos[i];
      const why = resolveWhy(pageItems[i].why, dto.author, dto.organization);
      const impression = await db.recommendationImpression.create({
        data: { personId: actor.personId, surface: "feed", model: "feed-v1", objectType: "Post", objectId: dto.id, reason: why, position: i },
      });
      results.push({ post: dto, recommendationId: impression.id, why });
    }
    await track(db, { personId: actor.personId, event: "feed_view", surface: "feed", props: { mode } });
    return { items: results, nextCursor };
  });

  app.get("/feed/rail", async (req) => {
    const actor = requireActor(req);
    const [businesses, rfqs, events] = await Promise.all([
      railBusinesses(db, actor.personId),
      db.rfq.findMany({ where: { status: "OPEN" }, orderBy: { createdAt: "desc" }, take: 3, select: { id: true, title: true, location: true, quoteCount: true } }).catch(() => []),
      db.event.findMany({ where: { startsAt: { gt: new Date() } }, orderBy: { startsAt: "asc" }, take: 2, select: { id: true, slug: true, title: true, startsAt: true, venue: true } }).catch(() => []),
    ]);
    return {
      businesses,
      rfqs: rfqs.map((r) => ({ id: r.id, title: r.title, location: r.location, quoteCount: r.quoteCount, href: `/rfq/${r.id}` })),
      events: events.map((e) => ({ id: e.id, title: e.title, startsAt: e.startsAt.toISOString(), venue: e.venue, href: `/events/${e.slug}` })),
    };
  });
}

/** Chronological `following` still says why an item is there — it just doesn't reorder for it. */
function chronologicalWhy(r: PostRow, ctx: Awaited<ReturnType<typeof loadViewerCtx>>): string | null {
  if (r.authorId !== ctx.personId && ctx.connectionIds.includes(r.authorId)) return "CONNECTION";
  if (r.organizationId && ctx.followedOrgIds.includes(r.organizationId)) return "FOLLOWED_ORG";
  if (ctx.followedPersonIds.includes(r.authorId)) return "FOLLOWED_PERSON";
  return null;
}

/** Businesses you may need: same industry/location as the viewer, or followed by their connections. Tolerant of empty. */
async function railBusinesses(db: Db, personId: string) {
  const profile = await db.profile.findUnique({ where: { personId }, select: { industry: true, location: true } });
  const orgs = await db.organization
    .findMany({
      where: profile?.industry ? { industry: profile.industry } : {},
      orderBy: { followerCount: "desc" },
      take: 3,
      select: { id: true, industry: true },
    })
    .catch(() => []);
  if (!orgs.length) return [];
  const cards = await orgCards(db, orgs.map((o) => o.id));
  return orgs
    .map((o) => {
      const card = cards.get(o.id);
      if (!card) return null;
      return { ...card, reason: profile?.industry && o.industry === profile.industry ? "Same industry as you" : "In your area" };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}
