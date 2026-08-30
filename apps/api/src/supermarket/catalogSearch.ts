/**
 * ONE catalog-search rule, shared by the order brain and the desk's own
 * search boxes (Izzy, 2026-08-27: "a lot of items don't come up in the
 * suggestions. Every item should come up").
 *
 * ⛔ THE BUG THIS EXISTS TO KILL: the desk searched
 * `name: { contains: <the whole typed string> }` — ONE substring, NAME ONLY.
 * So "golden flow orange juice" returned NOTHING (no item's *name* contains
 * that; "Golden Flow" lives in the BRAND column), and so did "gold's pads",
 * "orange juice 64 oz", and every other phrase whose words are split across
 * name and brand or simply are not adjacent. Meanwhile the BRAIN already
 * searched name-OR-brand across stemmed tokens — so the rep's box was
 * strictly dumber than the agent's, which is exactly backwards while a human
 * is correcting the agent.
 *
 * The rule (unchanged from the brain's proven behaviour, now shared):
 *  - tokenize on non-alphanumerics, so apostrophes vanish ("Gold's" → "gold",
 *    which also dodges the ' vs ’ trap between our text and the register's)
 *  - stem plurals, so "eggs" matches "Egg Medium" and "egg" matches "Eggs L"
  *  - each token may match the NAME or the BRAND
 *  - MOST-SPECIFIC FIRST: all tokens AND-ed, then every PAIR, then singles —
 *    pairs are what rescue a phrase whose extra words pollute the pool
 *    ("Ta'am Tov cream of lox" drowning in cream-of-soup).
 */

/** Stem a single token: drop a plural "es"/"s" on words long enough to spare it. */
export function stemToken(t: string): string {
  if (t.length >= 4 && t.endsWith("es")) return t.slice(0, -2);
  if (t.length >= 4 && t.endsWith("s")) return t.slice(0, -1);
  return t;
}

/** Lowercase alphanumeric tokens of ≥3 chars, capped. */
export function catalogSearchTokens(phrase: string, max = 4): string[] {
  return String(phrase ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
    .slice(0, max);
}

/** A pure item code lookup when the whole phrase is digits. */
export function catalogCodePrefix(phrase: string): string | null {
  const m = String(phrase ?? "").match(/^\s*(\d{2,14})\s*$/);
  return m ? m[1] : null;
}

/** One token's Prisma where: the stem appearing in the name OR the brand. */
export function tokenWhere(raw: string): any {
  const t = stemToken(raw);
  return {
    OR: [
      { name: { contains: t, mode: "insensitive" } },
      { brand: { contains: t, mode: "insensitive" } },
    ],
  };
}

/**
 * The progressive where-list, most specific first. Callers run them in order
 * and stop once they have enough rows — so an exact multi-word match always
 * outranks a single-token one.
 */
export function catalogSearchWheres(phrase: string, maxTokens = 4): any[] {
  const tokens = catalogSearchTokens(phrase, maxTokens);
  if (tokens.length === 0) return [];
  const wheres: any[] = [{ AND: tokens.map(tokenWhere) }];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      wheres.push({ AND: [tokenWhere(tokens[i]), tokenWhere(tokens[j])] });
    }
  }
  for (const t of tokens) wheres.push(tokenWhere(t));
  return wheres;
}

/**
 * ⛔⛔ THE ONE STOCK RULE: only an EXACT ZERO is "out of stock".
 *
 * Register drift makes `onHand` go NEGATIVE on hundreds of live items — an
 * impossible count is a BROKEN count, not an empty shelf. Treating negative
 * as out-of-stock is precisely how the brain picked ORGANIC eggs over the
 * $3.99 "Eggs Large" sitting at onHand -75 (Izzy, 2026-08-30: "it should
 * pick the cheapest one … instead of picking the most expensive one,
 * organic" — his call closing the open question recorded 2026-08-27).
 * Negative and null are both UNKNOWN: shown normally, never labelled,
 * never demoted, never reported to the brain as inStock:false.
 */
export function isKnownOutOfStock(row: { onHand?: number | null }): boolean {
  return row.onHand === 0;
}

/**
 * In-stock first, out-of-stock last but NEVER hidden (Izzy, 2026-08-26) —
 * `null` onHand means "not yet synced" and NEGATIVE means "broken count";
 * both are shown normally, not as missing. ⛔ Stable within each group, so
 * the most-specific match still leads its group.
 */
export function inStockFirst<T extends { onHand?: number | null }>(rows: T[]): T[] {
  const ok = (r: T) => !isKnownOutOfStock(r);
  return [...rows.filter(ok), ...rows.filter((r) => !ok(r))];
}

export type ScoredRow = {
  name?: string | null;
  brand?: string | null;
  sizeText?: string | null;
  onHand?: number | null;
  unitPriceCents?: number | null;
};

/**
 * ⛔⛔ WHY RANKING IS NOT OPTIONAL: the SQL match is `contains`, i.e. a bare
 * SUBSTRING — so the token "red" also matches "Cove**red**", "Sh**red**ded"
 * and "Hund**red**", and "egg" matches "V**egg**ie" (the live "eggs" search
 * really returned veggie chips, 2026-08-30). Recall comes from the loose
 * SQL; PRECISION has to come from scoring the rows we got back.
 *
 * Three tiers per token, best first:
 *  - the WORD ITSELF, stem-for-stem ("eggs" IS a word of "Eggs Large") —
 *    this is what puts real eggs above "Eggplant" and "Veggie Chips";
 *  - a word PREFIX (`\bread` matches "Breaded") — related but weaker;
 *  - a bare substring ("egg" inside "Veggie") — barely counts at all.
 */
export function scoreCatalogRow(row: ScoredRow, phrase: string): number {
  const name = String(row.name ?? "");
  const hay = `${name} ${row.brand ?? ""}`.toLowerCase();
  const hayStems = new Set(
    hay
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
      .map(stemToken),
  );
  const tokens = catalogSearchTokens(phrase, 6);
  if (tokens.length === 0) return 0;
  let score = 0;
  let wordHits = 0;
  for (const raw of tokens) {
    const t = stemToken(raw);
    if (hayStems.has(t)) {
      score += 15;
      wordHits++;
    } else if (new RegExp(`\\b${t}`).test(hay)) {
      // tokens are [a-z0-9] by construction, so this is regex-safe
      score += 9;
      wordHits++;
    } else if (hay.includes(t)) {
      score += 2;
    }
  }
  if (wordHits === tokens.length) score += 50;
  // the typed phrase appearing intact ("orange juice") outranks scattered words
  const joined = tokens.join(" ");
  if (hay.includes(joined)) score += 40;
  // ⛔ HEAD-NOUN over STARTS-WITH, in that order of weight. English compound
  // names put the head LAST: "Rye Bread" IS bread, "Bread Bags" are bags —
  // and on the live catalog the old starts-with-only bonus ranked twelve
  // bread BAGS and CRUMBS above every actual loaf for the search "bread"
  // (2026-08-30). Starts-with still counts (head-FIRST names like "Milk
  // Red" / "Eggs Large" are real here too), just less.
  const nameStems = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
    .map(stemToken);
  const lastStem = nameStems[nameStems.length - 1];
  if (lastStem && tokens.some((raw) => stemToken(raw) === lastStem)) score += 6;
  if (name.toLowerCase().startsWith(tokens[0])) score += 4;
  // a shorter name is the more exact product ("Milk Red" over "Milk Red Uht")
  score -= Math.min(8, Math.floor(name.length / 12));
  return score;
}

/** True when every token is a whole-word hit — a STRONG match. */
export function isStrongMatch(row: ScoredRow, phrase: string): boolean {
  const hay = `${row.name ?? ""} ${row.brand ?? ""}`.toLowerCase();
  const tokens = catalogSearchTokens(phrase, 6);
  return tokens.length > 0 && tokens.every((raw) => new RegExp(`\\b${stemToken(raw)}`).test(hay));
}

/**
 * The order a human sees: strong matches first, in-stock ahead of
 * known-out-of-stock WITHIN each relevance group, then by score, then —
 * everything else equal — CHEAPEST first (Izzy, 2026-08-30: an unqualified
 * "eggs" means the cheapest regular eggs, never the organic ones).
 *
 * ⛔ Relevance outranks stock on purpose. Izzy's in-stock-first rule
 * (2026-08-26) is about choosing between comparable products — applied
 * across relevance groups it would bury the exact item someone just typed
 * under an in-stock item that merely shares a syllable.
 */
export function rankCatalogRows<T extends ScoredRow>(rows: T[], phrase: string): T[] {
  const priceOf = (r: ScoredRow) =>
    Number.isFinite(Number(r.unitPriceCents)) && Number(r.unitPriceCents) > 0 ? Number(r.unitPriceCents) : Number.POSITIVE_INFINITY;
  const decorated = rows.map((row, i) => ({
    row,
    i,
    strong: isStrongMatch(row, phrase),
    stocked: !isKnownOutOfStock(row),
    score: scoreCatalogRow(row, phrase),
    price: priceOf(row),
  }));
  decorated.sort(
    (a, b) =>
      Number(b.strong) - Number(a.strong) ||
      Number(b.stocked) - Number(a.stocked) ||
      b.score - a.score ||
      a.price - b.price ||
      a.i - b.i,
  );
  return decorated.map((d) => d.row);
}

/**
 * ⛔⛔ THE RECALL RULE: collect a POOL far bigger than the display limit,
 * and only THEN rank and cut. The 2026-08-30 bug this kills: each tier
 * fetched `take: 12` ordered by NAME, and the collection stopped at 12 — so
 * "bread" (175 catalog matches) returned twelve bread BAGS and bread
 * CRUMBS, alphabetically first, and "Rye Bread" never left the database.
 * Ranking cannot rescue a row SQL truncated away.
 *
 * ⛔ ONE implementation for the desk route AND the brain's candidate search
 * — the recorded two-implementations hazard. `select` must include
 * posProductId (the dedupe key).
 */
export const CATALOG_POOL_LIMIT = 240;

export async function searchCatalogPool(
  db: any,
  tenantId: string,
  phrase: string,
  select: Record<string, boolean>,
  poolLimit = CATALOG_POOL_LIMIT,
): Promise<any[]> {
  const wheres = catalogSearchWheres(phrase);
  if (wheres.length === 0) return [];
  const seen = new Map<string, any>();
  for (const where of wheres) {
    if (seen.size >= poolLimit) break;
    const rows = await db.posCatalogItem.findMany({
      where: { tenantId, isActive: true, ...where },
      select,
      orderBy: { name: "asc" },
      take: poolLimit,
    });
    for (const row of rows as any[]) {
      if (!seen.has(row.posProductId)) seen.set(row.posProductId, row);
      if (seen.size >= poolLimit) break;
    }
  }
  return [...seen.values()];
}
