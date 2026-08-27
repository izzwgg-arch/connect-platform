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
 * In-stock first, out-of-stock last but NEVER hidden (Izzy, 2026-08-26) —
 * `null` onHand means "not yet synced", which is shown normally, not as
 * missing. ⛔ Stable within each group, so the most-specific match still
 * leads its group.
 */
export function inStockFirst<T extends { onHand?: number | null }>(rows: T[]): T[] {
  const ok = (r: T) => r.onHand === null || r.onHand === undefined || r.onHand > 0;
  return [...rows.filter(ok), ...rows.filter((r) => !ok(r))];
}

export type ScoredRow = { name?: string | null; brand?: string | null; sizeText?: string | null; onHand?: number | null };

/**
 * ⛔⛔ WHY RANKING IS NOT OPTIONAL: the SQL match is `contains`, i.e. a bare
 * SUBSTRING — so the token "red" also matches "Cove**red**", "Sh**red**ded"
 * and "Hund**red**". Typing "milk red" really did return chocolate-covered
 * crackers ABOVE Golden Flow's "Milk Red" (measured on the live catalog,
 * 2026-08-27). Recall comes from the loose SQL; PRECISION has to come from
 * scoring the rows we got back.
 *
 * A token scores as a WHOLE-WORD hit (`\bred`) or, far lower, as a bare
 * substring — so "Milk Red" beats "Chocolate Covered … Milk".
 */
export function scoreCatalogRow(row: ScoredRow, phrase: string): number {
  const hay = `${row.name ?? ""} ${row.brand ?? ""}`.toLowerCase();
  const tokens = catalogSearchTokens(phrase, 6);
  if (tokens.length === 0) return 0;
  let score = 0;
  let wholeWordHits = 0;
  for (const raw of tokens) {
    const t = stemToken(raw);
    // tokens are [a-z0-9] by construction, so this is regex-safe
    if (new RegExp(`\\b${t}`).test(hay)) {
      score += 10;
      wholeWordHits++;
    } else if (hay.includes(t)) {
      score += 2;
    }
  }
  if (wholeWordHits === tokens.length) score += 50;
  // the typed phrase appearing intact ("orange juice") outranks scattered words
  const joined = tokens.join(" ");
  if (hay.includes(joined)) score += 40;
  if ((row.name ?? "").toLowerCase().startsWith(tokens[0])) score += 8;
  // a shorter name is the more exact product ("Milk Red" over "Milk Red Uht")
  score -= Math.min(8, Math.floor(String(row.name ?? "").length / 12));
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
 * out-of-stock WITHIN each relevance group, then by score.
 *
 * ⛔ Relevance outranks stock on purpose. Izzy's in-stock-first rule
 * (2026-08-26) is about choosing between comparable products — applied
 * across relevance groups it would bury the exact item someone just typed
 * under an in-stock item that merely shares a syllable.
 */
export function rankCatalogRows<T extends ScoredRow>(rows: T[], phrase: string): T[] {
  const decorated = rows.map((row, i) => ({
    row,
    i,
    strong: isStrongMatch(row, phrase),
    stocked: row.onHand === null || row.onHand === undefined || row.onHand > 0,
    score: scoreCatalogRow(row, phrase),
  }));
  decorated.sort(
    (a, b) =>
      Number(b.strong) - Number(a.strong) ||
      Number(b.stocked) - Number(a.stocked) ||
      b.score - a.score ||
      a.i - b.i,
  );
  return decorated.map((d) => d.row);
}
