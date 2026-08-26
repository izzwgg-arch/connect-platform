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
export const DEFAULT_PAGE_BUDGET = 20;

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

/** Defensive page parse — pure, stress-tested against hostile shapes. */
export function parseProductsPage(body: unknown): { items: ParsedProduct[]; cursor: string | null } | null {
  if (body == null || typeof body !== "object") {
    if (!Array.isArray(body)) return null;
  }
  const b: any = body;
  const rawList: unknown = Array.isArray(b) ? b : b.items ?? b.products ?? b.data ?? b.rows ?? null;
  if (!Array.isArray(rawList)) return null;
  const items: ParsedProduct[] = [];
  for (const raw of rawList.slice(0, 500)) {
    if (raw == null || typeof raw !== "object") continue;
    const r: any = raw;
    const id = r.id ?? r.productId ?? r.posProductId;
    if (id === undefined || id === null || String(id).length === 0) continue;
    const priceCents = posAmountToCents(r.price) ?? 0;
    const priceQty = typeof r.priceQty === "number" && Number.isFinite(r.priceQty) && r.priceQty > 0 ? r.priceQty : 1;
    items.push({
      posProductId: String(id).slice(0, 64),
      code: String(r.code ?? r.productCode ?? "").slice(0, 32),
      name: String(r.name ?? r.description ?? "").slice(0, 200),
      priceCents,
      priceQty,
      unitPriceCents: posUnitPriceCents(r.price, r.priceQty) ?? 0,
      isActive: r.isActive === false || r.inactive === true ? false : true,
      posLastMod: r.lastMod !== undefined && r.lastMod !== null ? String(r.lastMod).slice(0, 64) : null,
    });
  }
  const cursorRaw = Array.isArray(b) ? null : b.cursor ?? b.nextCursor ?? b.next ?? null;
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
};

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

    let cursor: string | null = state.cursor ?? null;
    let highWater: string | null = state.lastMod ?? null;
    let pages = 0;
    let upserted = 0;
    let error: string | null = null;
    let finished = false;

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
          includeInactive: true,
        });
      } catch (err: any) {
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
    }

    const itemCount = await db.posCatalogItem.count({ where: { tenantId: tenant.id } });
    await db.posCatalogSyncState.update({
      where: { tenantId: tenant.id },
      data: {
        // ⛔ The high-water mark only advances on a FINISHED sweep — advancing
        // it mid-cursor would silently skip the unfetched tail forever.
        lastMod: finished ? highWater : state.lastMod,
        cursor: error ? null : cursor,
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
