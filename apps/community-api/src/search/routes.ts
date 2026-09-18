import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { requireActor } from "../auth/actor.js";
import { badRequest, notFound } from "../lib/errors.js";
import { track } from "../lib/analytics.js";
import { notify } from "../lib/notify.js";
import { prefixIds, ftsIds } from "../lib/search.js";
import { addJob } from "../core/schedulers.js";
import { personCards } from "../profiles/cards.js";
import { orgCards } from "../organizations/cards.js";
import { interpretQuery } from "./nlq.js";
import { ALL_TYPES, SEARCHERS, type SearchCtx, type SearchHit, type SearchType } from "./engine.js";

const TypeIn = z.enum(["all", ...ALL_TYPES]);
const DistanceIn = z.enum(["network", "second", "anyone"]);

const SearchQuery = z.object({
  q: z.string().trim().max(300).optional().default(""),
  type: TypeIn.optional().default("all"),
  distance: DistanceIn.optional(),
  location: z.string().trim().max(120).optional(),
  industry: z.string().trim().max(120).optional(),
  verified: z.string().trim().max(200).optional(),
  size: z.string().trim().max(40).optional(),
  language: z.string().trim().max(60).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/** Fixed-size internal fetch per type — big enough for facet counts + a few pages, never unbounded. */
const PER_TYPE_FETCH = 100;

function offsetOf(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function encodeOffset(n: number): string {
  return Buffer.from(String(n)).toString("base64url");
}

async function runAllTypes(db: Db, base: Omit<SearchCtx, "limit">): Promise<Record<SearchType, SearchHit[]>> {
  const entries = await Promise.all(
    ALL_TYPES.map(async (t) => {
      const hits = await SEARCHERS[t](db, { ...base, limit: PER_TYPE_FETCH });
      return [t, hits] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<SearchType, SearchHit[]>;
}

/** "All" tab: guarantee the top 3 organizations and top 3 people, then rank-order the rest. */
function mergeAll(byType: Record<SearchType, SearchHit[]>): SearchHit[] {
  const seen = new Set<string>();
  const key = (h: SearchHit) => `${h.type}:${h.id}`;
  const out: SearchHit[] = [];
  for (const t of ["organizations", "people"] as SearchType[]) {
    for (const h of byType[t].slice(0, 3)) {
      if (seen.has(key(h))) continue;
      seen.add(key(h));
      out.push(h);
    }
  }
  const pool = ALL_TYPES.flatMap((t) => byType[t]).filter((h) => !seen.has(key(h)));
  pool.sort((a, b) => b.rank - a.rank);
  for (const h of pool) {
    if (seen.has(key(h))) continue;
    seen.add(key(h));
    out.push(h);
  }
  return out;
}

export function registerSearchRoutes(app: FastifyInstance, db: Db) {
  app.get("/search", async (req) => {
    const viewer = req.actor;
    const query = SearchQuery.parse(req.query);
    const take = query.limit ?? 20;
    const nlq = interpretQuery(query.q);
    const verified = query.verified ? query.verified.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const maxDegree = viewer && query.distance === "network" ? 1 : viewer && query.distance === "second" ? 2 : undefined;

    const base: Omit<SearchCtx, "limit"> = {
      viewerId: viewer?.personId ?? null,
      q: query.q,
      location: query.location ?? nlq.location ?? undefined,
      industry: query.industry,
      verified,
      size: query.size,
      language: query.language,
      maxDegree,
    } as Omit<SearchCtx, "limit">;

    const byType = query.q ? await runAllTypes(db, base) : (Object.fromEntries(ALL_TYPES.map((t) => [t, [] as SearchHit[]])) as Record<SearchType, SearchHit[]>);
    const counts = Object.fromEntries(ALL_TYPES.map((t) => [t, byType[t].length])) as Record<SearchType, number>;

    const ordered = query.type === "all" ? mergeAll(byType) : byType[query.type];
    const offset = offsetOf(query.cursor);
    const page = ordered.slice(offset, offset + take);
    const nextCursor = offset + take < ordered.length ? encodeOffset(offset + take) : null;

    if (viewer && query.q) {
      await db.recentSearch.deleteMany({ where: { personId: viewer.personId, query: query.q } });
      await db.recentSearch.create({ data: { personId: viewer.personId, query: query.q } });
      const extra = await db.recentSearch.findMany({ where: { personId: viewer.personId }, orderBy: { createdAt: "desc" }, skip: 20, select: { id: true } });
      if (extra.length) await db.recentSearch.deleteMany({ where: { id: { in: extra.map((e) => e.id) } } });
    }
    if (query.q) {
      await track(db, { personId: viewer?.personId ?? null, event: "search", props: { q: query.q, type: query.type, count: ordered.length } });
    }

    return {
      interpretation: nlq,
      counts,
      results: page,
      nextCursor,
    };
  });

  app.get("/search/suggest", async (req) => {
    const viewer = req.actor;
    const { q } = z.object({ q: z.string().trim().max(200).optional().default("") }).parse(req.query);
    if (!q) return { people: [], organizations: [], queries: [] };

    const [firstIds, lastIds] = await Promise.all([
      prefixIds(db, "Profile", "personId", "firstName", q, 8),
      prefixIds(db, "Profile", "personId", "lastName", q, 8),
    ]);
    let personIds = [...new Set([...firstIds, ...lastIds])];
    if (!personIds.length) personIds = (await ftsIds(db, "Profile", "personId", q, 5)).map((r) => r.id);
    const personCardMap = await personCards(db, personIds.slice(0, 5));
    const people = personIds.slice(0, 5).map((id) => personCardMap.get(id)).filter(Boolean);

    let orgIds = await prefixIds(db, "Organization", "id", "displayName", q, 8);
    if (!orgIds.length) orgIds = (await ftsIds(db, "Organization", "id", q, 5)).map((r) => r.id);
    const orgCardMap = await orgCards(db, orgIds.slice(0, 5));
    const organizations = orgIds.slice(0, 5).map((id) => orgCardMap.get(id)).filter(Boolean);

    let queries: string[] = [];
    if (viewer) {
      const [saved, recent] = await Promise.all([
        db.savedSearch.findMany({ where: { personId: viewer.personId, query: { contains: q, mode: "insensitive" } }, take: 5, orderBy: { createdAt: "desc" }, select: { query: true } }),
        db.recentSearch.findMany({ where: { personId: viewer.personId, query: { contains: q, mode: "insensitive" } }, take: 5, orderBy: { createdAt: "desc" }, select: { query: true } }),
      ]);
      queries = [...new Set([...saved.map((s) => s.query), ...recent.map((r) => r.query)])].slice(0, 5);
    }

    return { people, organizations, queries };
  });

  app.post("/search/click", async (req) => {
    const viewer = req.actor;
    const body = z.object({ type: z.enum(ALL_TYPES as [SearchType, ...SearchType[]]), id: z.string(), position: z.number().int().min(0), q: z.string().max(300) }).parse(req.body);
    await track(db, { personId: viewer?.personId ?? null, event: "search_result_click", objectType: body.type, objectId: body.id, position: body.position, props: { q: body.q } });
    return { ok: true };
  });

  // ── Saved searches ───────────────────────────────────────────────────────
  app.get("/search/saved", async (req) => {
    const actor = requireActor(req);
    const items = await db.savedSearch.findMany({ where: { personId: actor.personId }, orderBy: { createdAt: "desc" } });
    return { items };
  });

  app.post("/search/saved", async (req) => {
    const actor = requireActor(req);
    const body = z.object({ query: z.string().trim().min(1).max(300), filters: z.record(z.any()).optional(), alerts: z.boolean().optional() }).parse(req.body);
    const row = await db.savedSearch.create({ data: { personId: actor.personId, query: body.query, filters: body.filters ?? undefined, alerts: body.alerts ?? false } });
    return row;
  });

  app.patch("/search/saved/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ alerts: z.boolean() }).parse(req.body);
    const existing = await db.savedSearch.findUnique({ where: { id } });
    if (!existing || existing.personId !== actor.personId) throw notFound("That saved search");
    const row = await db.savedSearch.update({ where: { id }, data: { alerts: body.alerts } });
    return row;
  });

  app.delete("/search/saved/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const existing = await db.savedSearch.findUnique({ where: { id } });
    if (!existing || existing.personId !== actor.personId) throw notFound("That saved search");
    await db.savedSearch.delete({ where: { id } });
    return { ok: true };
  });

  // ── Recent searches ──────────────────────────────────────────────────────
  app.get("/search/recent", async (req) => {
    const actor = requireActor(req);
    const rows = await db.recentSearch.findMany({ where: { personId: actor.personId }, orderBy: { createdAt: "desc" }, take: 20 });
    return { items: rows };
  });

  app.delete("/search/recent", async (req) => {
    const actor = requireActor(req);
    await db.recentSearch.deleteMany({ where: { personId: actor.personId } });
    return { ok: true };
  });

  addJob({ name: "search.alerts", everyMs: 30 * 60_000, run: runSearchAlerts });
}

/** Content types with a createdAt that can meaningfully be "new since last check", mapped to their Prisma model accessor. */
const ALERT_TABLES: Partial<Record<SearchType, string>> = { jobs: "job", listings: "listing", rfqs: "rfq", opportunities: "opportunity", posts: "post", events: "event", groups: "group" };

export async function runSearchAlerts(db: Db) {
  const saved = await db.savedSearch.findMany({ where: { alerts: true } });
  for (const s of saved) {
    const since = s.lastRunAt ?? new Date(Date.now() - 24 * 3600_000);
    let count = 0;
    for (const [t, table] of Object.entries(ALERT_TABLES) as Array<[SearchType, string]>) {
      const hits = await SEARCHERS[t](db, { viewerId: s.personId, q: s.query, limit: 50 });
      const ids = hits.map((h) => h.id);
      if (!ids.length) continue;
      const n = await (db as any)[table].count({ where: { id: { in: ids }, createdAt: { gt: since } } });
      count += n;
    }
    if (count > 0) {
      await notify(db, {
        personId: s.personId,
        kind: "search.alert",
        title: `${count} new ${count === 1 ? "result" : "results"} for "${s.query}"`,
        href: `/search?q=${encodeURIComponent(s.query)}`,
        groupKey: `search:${s.id}`,
      });
    }
    await db.savedSearch.update({ where: { id: s.id }, data: { lastRunAt: new Date() } });
  }
}
