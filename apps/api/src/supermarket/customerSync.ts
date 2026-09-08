/**
 * Customer mirror sweep (2026-09-08) — keeps PosCustomer a cheap copy of each
 * supermarket tenant's register customer list, the way catalogSync keeps the
 * catalog. It exists for ONE reason: the desk must suggest accounts as a rep
 * types a phone number or a name, and the register offers no search — only
 * an exact 10-digit lookup and a paged list. So the list is mirrored once
 * (~140 credits for Gesheft's 13,837 customers at 100/page) and kept current
 * by lastMod for ~1 credit per sweep.
 *
 * Same rules as the catalog, because they were paid for there:
 * - ⛔ cross-run cursors are DEAD (a stored cursor 500s on the next run) — a
 *   walk must FINISH inside one run; only lastMod is persisted, and only when
 *   the walk finished;
 * - pages are PACED (their rate limiter is a rolling quota — 350 ms died at
 *   page 96, 2.5 s finished all pages) and a 429 waits Retry-After;
 * - an unparseable page records customerLastError and stops — never loops,
 *   never throws, never wipes stored rows.
 * ⛔ Cards are COUNTED, never copied. The register keeps the card records.
 */

import { posClientForTenant } from "./integrationCredentials";
import { parseCustomersPage, PosApiError, type MirrorCustomer } from "./posWithLogic";
import { laterLastMod } from "./catalogSync";

export const CUSTOMER_SYNC_DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
export const CUSTOMER_SYNC_BOOT_DELAY_MS = 5 * 60 * 1000;
/** 14k customers / 100 per page = ~140 pages; 400 leaves headroom for growth. */
export const CUSTOMER_PAGE_BUDGET = 400;
/** Proven pacing on the products walk (their quota is rolling, not per-call). */
export const CUSTOMER_PAGE_PACE_MS = 2500;
export const CUSTOMER_MAX_RATE_LIMIT_WAITS = 3;

export type CustomerSyncDeps = {
  db: any;
  log?: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void };
  clientFor?: typeof posClientForTenant;
  pageBudget?: number;
  pagePaceMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

let running = false;

export async function runCustomerSyncSweep(deps: CustomerSyncDeps): Promise<{ tenants: number; upserted: number }> {
  if (running) return { tenants: 0, upserted: 0 };
  running = true;
  try {
    return await sweepInner(deps);
  } finally {
    running = false;
  }
}

function mirrorRow(tenantId: string, c: MirrorCustomer) {
  return {
    tenantId,
    posCustomerId: c.posCustomerId,
    firstName: c.firstName,
    lastName: c.lastName,
    name: c.name,
    phonesText: c.phones.join(" "),
    primaryPhone: c.primaryPhone,
    email: c.email,
    address: c.address,
    city: c.city,
    route: c.route,
    onAccount: c.onAccount,
    cardCount: c.cardCount,
    posLastMod: c.posLastMod,
  };
}

async function sweepInner(deps: CustomerSyncDeps): Promise<{ tenants: number; upserted: number }> {
  const { db } = deps;
  const log = deps.log ?? { info: () => {}, warn: () => {} };
  const clientFor = deps.clientFor ?? posClientForTenant;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pageBudget = Math.max(1, deps.pageBudget ?? Number(process.env.SUPERMARKET_CUSTOMER_PAGE_BUDGET || CUSTOMER_PAGE_BUDGET));
  const pagePaceMs = deps.pagePaceMs ?? Number(process.env.SUPERMARKET_CUSTOMER_PAGE_PACE_MS || CUSTOMER_PAGE_PACE_MS);

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
    if (!client) continue;

    const state =
      (await db.posCatalogSyncState.findUnique({ where: { tenantId: tenant.id } })) ??
      (await db.posCatalogSyncState.create({ data: { tenantId: tenant.id } }));

    let cursor: string | null = null;
    let highWater: string | null = state.customerLastMod ?? null;
    let pages = 0;
    let upserted = 0;
    let finished = false;
    let error: string | null = null;
    let rateWaits = 0;

    while (pages < pageBudget) {
      let body: unknown;
      try {
        // ⛔ cursor pages keep ALL original params (their documented rule)
        body = await client.listCustomers({
          take: 100,
          lastMod: state.customerLastMod ?? undefined,
          cursor: cursor ?? undefined,
        });
      } catch (err: any) {
        if (err instanceof PosApiError && err.code === "pos_rate_limited" && rateWaits < CUSTOMER_MAX_RATE_LIMIT_WAITS) {
          rateWaits++;
          const waitMs = Math.min(60_000, Math.max(2_000, Number(err.retryAfterSec ?? 5) * 1000));
          await sleep(waitMs);
          continue; // same page again
        }
        error = err instanceof PosApiError ? err.code : "pos_error";
        break;
      }
      pages++;
      const page = parseCustomersPage(body);
      if (!page) {
        error = "pos_unparseable_page";
        break;
      }
      for (const c of page.items) {
        const row = mirrorRow(tenant.id, c);
        const { tenantId: _t, posCustomerId: _p, ...update } = row;
        await db.posCustomer.upsert({
          where: { tenantId_posCustomerId: { tenantId: tenant.id, posCustomerId: c.posCustomerId } },
          create: row,
          update,
        });
        upserted++;
        highWater = laterLastMod(highWater, c.posLastMod);
      }
      if (!page.cursor) {
        finished = true;
        break;
      }
      cursor = page.cursor;
      if (pagePaceMs > 0) await sleep(pagePaceMs);
    }

    const count = await db.posCustomer.count({ where: { tenantId: tenant.id } }).catch(() => state.customerCount ?? 0);
    await db.posCatalogSyncState.update({
      where: { tenantId: tenant.id },
      data: {
        // ⛔ the high-water advances ONLY on a finished walk — advancing it
        // mid-walk would skip the unfetched tail forever
        customerLastMod: finished ? highWater : state.customerLastMod,
        customerCount: count,
        customerLastSyncAt: new Date(),
        customerLastError: error,
        creditsSpent: { increment: credits },
      },
    });
    totalUpserted += upserted;
    if (error) log.warn({ tenantId: tenant.id, error, pages, upserted }, "supermarket customer sync stopped");
    else if (upserted > 0 || !finished) log.info({ tenantId: tenant.id, upserted, pages, finished, count }, "supermarket customer sync");
  }
  return { tenants: tenants.length, upserted: totalUpserted };
}

/** Digits-only view of what a rep typed; an 11-digit "1845…" becomes the 10 we store. */
export function customerSearchDigits(q: string): string {
  const d = String(q ?? "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

export type MirrorCustomerHit = {
  posCustomerId: string;
  name: string;
  phones: string[];
  primaryPhone: string;
  address: string;
  city: string;
  route: string;
  onAccount: boolean;
  cardCount: number;
};

/** Does the typed text read as a phone number rather than a name? */
export function customerQueryIsNumeric(raw: string): boolean {
  const digits = customerSearchDigits(raw);
  const nonSpace = String(raw ?? "").replace(/[\s()+-]/g, "");
  return digits.length >= 3 && nonSpace.length > 0 && digits.length >= nonSpace.length * 0.6;
}

/**
 * Type-ahead over the mirror. Digits → phone contains (3+ digits); letters →
 * name/email contains, case-insensitive. Never hits the register.
 */
export async function searchMirrorCustomers(db: any, tenantId: string, q: string, limit = 8): Promise<MirrorCustomerHit[]> {
  const raw = String(q ?? "").trim();
  if (!raw) return [];
  const digits = customerSearchDigits(raw);
  const looksNumeric = customerQueryIsNumeric(raw);
  let where: any;
  if (looksNumeric) {
    where = { tenantId, phonesText: { contains: digits } };
  } else {
    if (raw.length < 2) return [];
    const term = raw.slice(0, 60);
    where = {
      tenantId,
      OR: [{ name: { contains: term, mode: "insensitive" } }, { email: { contains: term, mode: "insensitive" } }],
    };
  }
  const rows = await db.posCustomer.findMany({
    where,
    orderBy: [{ name: "asc" }],
    take: Math.max(1, Math.min(20, limit)),
    select: {
      posCustomerId: true,
      name: true,
      phonesText: true,
      primaryPhone: true,
      address: true,
      city: true,
      route: true,
      onAccount: true,
      cardCount: true,
    },
  });
  const out: MirrorCustomerHit[] = rows.map((r: any) => ({
    posCustomerId: String(r.posCustomerId),
    name: String(r.name ?? ""),
    phones: String(r.phonesText ?? "").split(" ").filter(Boolean),
    primaryPhone: String(r.primaryPhone ?? ""),
    address: String(r.address ?? ""),
    city: String(r.city ?? ""),
    route: String(r.route ?? ""),
    onAccount: Boolean(r.onAccount),
    cardCount: Number(r.cardCount ?? 0),
  }));
  if (looksNumeric) {
    // a phone that STARTS with what was typed outranks one that merely contains it
    out.sort((a, b) => {
      const as = a.phones.some((p) => p.startsWith(digits)) ? 0 : 1;
      const bs = b.phones.some((p) => p.startsWith(digits)) ? 0 : 1;
      return as - bs || a.name.localeCompare(b.name);
    });
  }
  return out;
}

/** The mirror's exact-phone answer — used when the register misses or is unreachable. */
export async function mirrorCustomerByPhone(db: any, tenantId: string, phone10: string) {
  if (!/^\d{10}$/.test(phone10)) return null;
  const rows = await db.posCustomer.findMany({
    where: { tenantId, phonesText: { contains: phone10 } },
    take: 5,
    select: { posCustomerId: true, name: true, phonesText: true, primaryPhone: true, address: true, city: true, email: true },
  });
  const exact = rows.find((r: any) => String(r.phonesText ?? "").split(" ").includes(phone10)) ?? null;
  if (!exact) return null;
  return {
    posCustomerId: String(exact.posCustomerId),
    name: String(exact.name ?? ""),
    phone: phone10,
    address: [exact.address, exact.city].filter(Boolean).join(", "),
    email: String(exact.email ?? ""),
    raw: null as any,
  };
}

/** The mirror's record by register id — for a suggestion the rep picked. */
export async function mirrorCustomerById(db: any, tenantId: string, posCustomerId: string) {
  const row = await db.posCustomer.findFirst({
    where: { tenantId, posCustomerId: String(posCustomerId).slice(0, 64) },
    select: { posCustomerId: true, name: true, phonesText: true, primaryPhone: true, address: true, city: true, email: true },
  });
  if (!row) return null;
  return {
    posCustomerId: String(row.posCustomerId),
    name: String(row.name ?? ""),
    phone: String(row.primaryPhone ?? ""),
    address: [row.address, row.city].filter(Boolean).join(", "),
    email: String(row.email ?? ""),
    raw: null as any,
  };
}
