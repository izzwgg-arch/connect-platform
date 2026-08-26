/**
 * Catalog search for the voice agent — reads the SUPERMARKET module's
 * PosCatalogItem table (the one synced from the tenant's register; the Orders
 * Desk quick-add searches the same rows). ⛔ ONE catalog per tenant, on
 * purpose: a second product table would drift from the register's within a
 * week. "Item number" in the voice agent's mouth is PosCatalogItem.code.
 *
 * Ranking is pure and unit-tested: exact code beats prefix-code beats exact
 * name beats name-token matches. Results carry unitPriceCents (the register's
 * price ÷ priceQty — already computed at sync time), which is the ONLY price
 * the model is allowed to quote.
 */

export interface CatalogRowLike {
  code: string;
  name: string;
  unitPriceCents: number;
  posProductId: string;
  isActive: boolean;
}

export interface CatalogMatch {
  itemNumber: string;
  name: string;
  unitPriceCents: number;
  priceText: string;
  posProductId: string;
}

export function centsToText(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rem = Math.abs(cents % 100);
  return `$${dollars}.${String(rem).padStart(2, "0")}`;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Pure ranking over candidate rows. Exported for direct unit testing. */
export function rankCatalogRows(rows: CatalogRowLike[], query: string, limit = 6): CatalogMatch[] {
  const q = normalize(query);
  const qDigits = query.replace(/\D+/g, "");
  const qTokens = q.split(" ").filter(Boolean);
  const scored: Array<{ score: number; row: CatalogRowLike }> = [];
  for (const row of rows) {
    if (!row.isActive) continue;
    const code = String(row.code ?? "").toLowerCase();
    const name = normalize(String(row.name ?? ""));
    let score = 0;
    if (qDigits && code === qDigits) score = 1000;
    else if (code && code === q) score = 1000;
    else if (qDigits && qDigits.length >= 3 && code.startsWith(qDigits)) score = 400;
    else if (name === q && q) score = 800;
    else if (qTokens.length > 0) {
      const nameTokens = new Set(name.split(" "));
      let hits = 0;
      for (const t of qTokens) {
        if (nameTokens.has(t)) hits += 2;
        else if ([...nameTokens].some((n) => n.startsWith(t) && t.length >= 3)) hits += 1;
      }
      if (hits > 0 && hits >= qTokens.length) score = 100 + hits * 10;
      else if (hits > 0) score = 20 + hits * 10;
    }
    if (score > 0) scored.push({ score, row });
  }
  scored.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
  return scored.slice(0, limit).map(({ row }) => ({
    itemNumber: row.code,
    name: row.name,
    unitPriceCents: row.unitPriceCents,
    priceText: centsToText(row.unitPriceCents),
    posProductId: row.posProductId,
  }));
}

/** Bounded db fetch + pure ranking. Never throws into a tool call. */
export async function searchCatalog(db: any, tenantId: string, query: string): Promise<CatalogMatch[]> {
  const q = String(query ?? "").slice(0, 120);
  if (!q.trim()) return [];
  try {
    const qDigits = q.replace(/\D+/g, "");
    const tokens = q
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3)
      .slice(0, 4);
    const or: Array<Record<string, unknown>> = [];
    if (qDigits) or.push({ code: qDigits }, { code: { startsWith: qDigits } });
    or.push({ code: q.trim() });
    for (const t of tokens) or.push({ name: { contains: t, mode: "insensitive" } });
    const rows: CatalogRowLike[] = await db.posCatalogItem.findMany({
      where: { tenantId, isActive: true, OR: or },
      select: { code: true, name: true, unitPriceCents: true, posProductId: true, isActive: true },
      take: 200,
    });
    return rankCatalogRows(rows, q);
  } catch {
    return [];
  }
}

/** Exact-code lookups for finalize-time validation (server-side prices). */
export async function lookupByCodes(
  db: any,
  tenantId: string,
  codes: string[],
): Promise<Map<string, CatalogRowLike>> {
  const unique = [...new Set(codes.map((c) => String(c).trim()).filter(Boolean))].slice(0, 100);
  const out = new Map<string, CatalogRowLike>();
  if (unique.length === 0) return out;
  const rows: CatalogRowLike[] = await db.posCatalogItem.findMany({
    where: { tenantId, isActive: true, code: { in: unique } },
    select: { code: true, name: true, unitPriceCents: true, posProductId: true, isActive: true },
  });
  for (const row of rows) out.set(row.code, row);
  return out;
}
