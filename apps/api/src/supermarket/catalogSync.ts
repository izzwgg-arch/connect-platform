/**
 * Catalog sync sweep (supermarket plan Phase 1) — keeps PosCatalogItem a
 * faithful, cheap copy of each supermarket tenant's register catalog.
 *
 * Runs INSIDE apps/api on a timer (boot kick + interval, the
 * paymentTransactionAlerts shape) — deliberately NOT in the worker, so the
 * only process that needs CREDENTIALS_MASTER_KEY is the one proven to have it.
 *
 * Credit discipline (their api bills per call):
 * - incremental: every run passes the stored lastMod high-water mark, so an
 *   unchanged catalog costs ONE credit per run;
 * - budgeted: at most SUPERMARKET_CATALOG_PAGE_BUDGET pages per tenant per
 *   run; an unfinished sweep stores its cursor and continues next run
 *   (⛔ cursor pages must keep ALL original params — their documented rule);
 * - the estimated spend is accounted on PosCatalogSyncState.creditsSpent so
 *   the meter is visible before Gesheft's bill makes it visible.
 *
 * Response shapes are NOT in their printout (Data Models section missing), so
 * parsing is defensive: items under items/products/data/rows or a raw array;
 * cursor under cursor/nextCursor/next. An unparseable page records lastError
 * and stops — it never loops, never throws, and never wipes stored items.
 */

import { posClientForTenant } from "./integrationCredentials";
import { posAmountToCents, posUnitPriceCents } from "./posWithLogic";

export const CATALOG_SYNC_DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
export const CATALOG_SYNC_BOOT_DELAY_MS = 3 * 60 * 1000;
/**
 * ⛔ Sized against the REAL store, 2026-08-26: Gesheft's catalog measured 12,000+ ACTIVE rows across the first full walks (their total:5211 is a filtered figure that means something else; a real supermarket carries tens of thousands of SKUs)
 * items and their `take` is hard-capped at 100 ("Take must be between 1 and
 * 100" — probed), so a full walk is 120+ calls; 400 pages = 40,000 items of headroom while still bounding a runaway. The budget must let a full
 * catalog finish INSIDE ONE RUN: in-run cursor paging is proven good, while
 * the first cross-run cursor resume came back 500 — a budget smaller than the
 * catalog would restart from scratch every run, never finish, never set the
 * lastMod high-water, and spend ~21 credits per 15 minutes forever. After the
 * first FINISHED sweep, lastMod makes every later run ~1 call.
 */
export const DEFAULT_PAGE_BUDGET = 400;

export type ParsedProduct = {
  posProductId: string;
  code: string;
  name: string;
  priceCents: number;
  priceQty: number;
  unitPriceCents: number;
  isActive: boolean;
  posLastMod: string | null;
};

/**
 * Pick the price a shopper pays TODAY from their `prices[]` array.
 * Read off the REAL payload 2026-08-26 (the first live call ever made): each
 * row carries priceType Regular|Special with an optional priceFrom/priceTill
 * window — and the live data included an EXPIRED Special (priceTill in 2025)
 * sitting beside the Regular, so window filtering is not optional. An
 * in-window Special beats Regular; `qty` is the bulk quantity the price
 * covers (the divisor rule).
 */
export function pickEffectivePrice(prices: unknown, now: Date = new Date()): { price: number; qty: number } | null {
  if (!Array.isArray(prices)) return null;
  const usable = prices.filter((p: any) => {
    if (p == null || typeof p !== "object") return false;
    if (typeof p.price !== "number" || !Number.isFinite(p.price) || p.price < 0) return false;
    const from = p.priceFrom ? new Date(p.priceFrom) : null;
    const till = p.priceTill ? new Date(p.priceTill) : null;
    if (from && !Number.isNaN(from.getTime()) && from.getTime() > now.getTime()) return false;
    if (till && !Number.isNaN(till.getTime()) && till.getTime() < now.getTime()) return false;
    return true;
  });
  if (usable.length === 0) return null;
  const special = usable.find((p: any) => String(p.priceType).toLowerCase() === "special");
  const chosen: any = special ?? usable.find((p: any) => String(p.priceType).toLowerCase() === "regular") ?? usable[0];
  const qty = typeof chosen.qty === "number" && Number.isFinite(chosen.qty) && chosen.qty > 0 ? chosen.qty : 1;
  return { price: chosen.price, qty };
}

/**
 * Defensive page parse — pure, stress-tested against hostile shapes.
 * ⛔ The REAL envelope (proven live 2026-08-26, first call with Gesheft's key)
 * is { results: [...], hasMore, cursor, total } and items carry
 * itemCode/description/prices[]/active/lastModified — NOT the flat
 * code/name/price/lastMod the printout implied. Both shapes are read; the
 * real one is pinned by a verbatim fixture in supermarketCore.test.ts.
 */
export function parseProductsPage(body: unknown): { items: ParsedProduct[]; cursor: string | null } | null {
  if (body == null || typeof body !== "object") {
    if (!Array.isArray(body)) return null;
  }
  const b: any = body;
  const rawList: unknown = Array.isArray(b) ? b : b.results ?? b.items ?? b.products ?? b.data ?? b.rows ?? null;
  if (!Array.isArray(rawList)) return null;
  const items: ParsedProduct[] = [];
  for (const raw of rawList.slice(0, 500)) {
    if (raw == null || typeof raw !== "object") continue;
    const r: any = raw;
    const id = r.id ?? r.productId ?? r.posProductId;
    if (id === undefined || id === null || String(id).length === 0) continue;
    const effective = pickEffectivePrice(r.prices);
    const priceValue = effective ? effective.price : r.price;
    const priceQty = effective
      ? effective.qty
      : typeof r.priceQty === "number" && Number.isFinite(r.priceQty) && r.priceQty > 0
        ? r.priceQty
        : 1;
    const priceCents = posAmountToCents(priceValue) ?? 0;
    items.push({
      posProductId: String(id).slice(0, 64),
      code: String(r.itemCode ?? r.primaryCode ?? r.code ?? r.productCode ?? "").slice(0, 32),
      name: String(r.description ?? r.name ?? "").slice(0, 200),
      priceCents,
      priceQty,
      unitPriceCents: posUnitPriceCents(priceValue, priceQty) ?? 0,
      isActive: r.active === false || r.isActive === false || r.inactive === true ? false : true,
      posLastMod:
        r.lastModified !== undefined && r.lastModified !== null
          ? String(r.lastModified).slice(0, 64)
          : r.lastMod !== undefined && r.lastMod !== null
            ? String(r.lastMod).slice(0, 64)
            : null,
    });
  }
  // ⛔ hasMore is authoritative when present: if their API were to keep a
  // `cursor` value on the LAST page, trusting cursor alone would loop forever
  // — hasMore === false always terminates the walk.
  const hasMore: unknown = Array.isArray(b) ? undefined : b.hasMore;
  const cursorRaw = Array.isArray(b) || hasMore === false ? null : b.cursor ?? b.nextCursor ?? b.next ?? null;
  const cursor = typeof cursorRaw === "string" && cursorRaw.length > 0 && cursorRaw.length < 512 ? cursorRaw : null;
  return { items, cursor };
}

/** Lexicographic max is only safe when formats agree; compare defensively. */
export function laterLastMod(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return b > a ? b : a;
}

export type CatalogSyncDeps = {
  db: any;
  log?: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
  /** Injected for tests; production uses the real client factory. */
  clientFor?: typeof posClientForTenant;
  pageBudget?: number;
  /** ms between catalog pages. ⛔ Their rate limiter 429'd a full-speed walk at
   *  page 73 (measured live 2026-08-26) — pacing is what lets a whole catalog
   *  finish in one run. Tests pass 0. */
  pagePaceMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const DEFAULT_PAGE_PACE_MS = 350;
/** How many 429 waits one run will honour before giving up. */
export const MAX_RATE_LIMIT_WAITS = 3;

let running = false;

/** One full sweep over every supermarket tenant that holds a POS key. */
export async function runCatalogSyncSweep(deps: CatalogSyncDeps): Promise<{ tenants: number; upserted: number }> {
  if (running) return { tenants: 0, upserted: 0 };
  running = true;
  try {
    return await sweepInner(deps);
  } finally {
    running = false;
  }
}

async function sweepInner(deps: CatalogSyncDeps): Promise<{ tenants: number; upserted: number }> {
  const { db } = deps;
  const log = deps.log ?? { info: () => {}, warn: () => {}, error: () => {} };
  const clientFor = deps.clientFor ?? posClientForTenant;
  const pageBudget = Math.max(1, deps.pageBudget ?? Number(process.env.SUPERMARKET_CATALOG_PAGE_BUDGET || DEFAULT_PAGE_BUDGET));
  const pagePaceMs = deps.pagePaceMs ?? Number(process.env.SUPERMARKET_CATALOG_PAGE_PACE_MS || DEFAULT_PAGE_PACE_MS);

  const tenants = await db.tenant.findMany({
    where: { crmMode: "supermarket", pbxRemovedAt: null },
    select: { id: true, name: true },
    take: 50,
  });
  let totalUpserted = 0;
  for (const tenant of tenants) {
    let credits = 0;
    const client = await clientFor(db, tenant.id, {
      onCredits: (info) => {
        credits += info.credits;
      },
    });
    if (!client) continue; // no key = no register connection; not an error

    const state =
      (await db.posCatalogSyncState.findUnique({ where: { tenantId: tenant.id } })) ??
      (await db.posCatalogSyncState.create({ data: { tenantId: tenant.id } }));

    // ⛔ Cross-run cursors are DEAD — proven twice live (2026-08-26): a cursor
    // stored from a finished run 500s on the next run's first request, both at
    // 11 minutes and at 8 minutes of age. Every run starts fresh; a walk must
    // FINISH inside its own run or its progress beyond upserts is lost.
    let cursor: string | null = null;
    let highWater: string | null = state.lastMod ?? null;
    let pages = 0;
    let upserted = 0;
    let error: string | null = null;
    let finished = false;

    let rateLimitWaits = 0;
    while (pages < pageBudget) {
      pages++;
      let body: unknown;
      try {
        // ⛔ cursor pages keep ALL original params (their documented rule):
        // lastMod always travels, whether or not a cursor does.
        body = await client.listProducts({
          take: 100,
          lastMod: state.lastMod ?? undefined,
          cursor: cursor ?? undefined,
          // ⛔ The FULL walk is active-only: with inactive included the real
          // catalog exceeded 12,000 rows and outran any one-run budget, and a
          // walk that cannot finish in one run never finishes at all (dead
          // cursors above). Once the high-water is set, the INCREMENTAL walk
          // includes inactive so a deactivation (which bumps lastModified)
          // still reaches us.
          includeInactive: state.lastMod ? true : false,
        });
      } catch (err: any) {
        // ⛔ A 429 is "slow down", not "give up" — honour Retry-After (capped)
        // and retry the SAME page, a bounded number of times per run. Aborting
        // on 429 is what left the walk restarting from scratch forever.
        if (err?.code === "pos_rate_limited" && rateLimitWaits < MAX_RATE_LIMIT_WAITS) {
          rateLimitWaits++;
          pages--; // the failed request spent no page of the budget's progress
          const waitSec = Math.min(Math.max(Number(err.retryAfterSec ?? 15), 1), 60);
          log.warn({ tenantId: tenant.id, waitSec, rateLimitWaits }, "supermarket catalog sync rate-limited; waiting");
          await sleep(waitSec * 1000);
          continue;
        }
        error = String(err?.code ?? err?.message ?? "pos_error").slice(0, 200);
        break;
      }
      const page = parseProductsPage(body);
      if (!page) {
        error = "pos_unparseable_page";
        break;
      }
      for (const item of page.items) {
        await db.posCatalogItem.upsert({
          where: { tenantId_posProductId: { tenantId: tenant.id, posProductId: item.posProductId } },
          update: {
            code: item.code,
            name: item.name,
            priceCents: item.priceCents,
            priceQty: item.priceQty,
            unitPriceCents: item.unitPriceCents,
            isActive: item.isActive,
            posLastMod: item.posLastMod,
          },
          create: { tenantId: tenant.id, ...item },
        });
        upserted++;
        highWater = laterLastMod(highWater, item.posLastMod);
      }
      if (!page.cursor) {
        finished = true;
        cursor = null;
        break;
      }
      cursor = page.cursor;
      if (pagePaceMs > 0) await sleep(pagePaceMs);
    }

    const itemCount = await db.posCatalogItem.count({ where: { tenantId: tenant.id } });
    await db.posCatalogSyncState.update({
      where: { tenantId: tenant.id },
      data: {
        // ⛔ The high-water mark only advances on a FINISHED sweep — advancing
        // it mid-cursor would silently skip the unfetched tail forever.
        lastMod: finished ? highWater : state.lastMod,
        cursor: null, // never persisted — cross-run cursors are dead (see above)
        lastSyncAt: new Date(),
        lastError: error,
        creditsSpent: { increment: credits },
        itemCount,
      },
    });
    totalUpserted += upserted;
    if (error) log.warn({ tenantId: tenant.id, error, pages }, "supermarket catalog sync error");
    else if (upserted > 0) log.info({ tenantId: tenant.id, upserted, pages, finished }, "supermarket catalog sync");
  }
  return { tenants: tenants.length, upserted: totalUpserted };
}
