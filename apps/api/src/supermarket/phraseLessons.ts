/**
 * Learning layer 2 — phrase lessons (Izzy, 2026-08-26: "we need data so the
 * system can see the mistakes or the way the transcription picks it up, so it
 * will auto-correct itself eventually").
 *
 * The Yiddish transcription garbles brand names phonetically — a real draft
 * rendered Ostreicher's cookie dough as "Schrieber's Sparkler chip" and duck
 * sauce as "Doc's Sauce". The rep then finds the real product by hand. This
 * module captures that fix — (garbled phrase → the product the rep chose,
 * proven by a SUBMITTED order) — and feeds it back into the brain as an extra
 * candidate the next time the same garble shows up.
 *
 * ⛔ A lesson is a HINT, never a forced pick: it only ADDS a candidate for
 * the resolve model to judge, so a wrongly-paired lesson costs nothing worse
 * than one extra candidate in the pool. That tolerance is what lets the
 * pairing stay simple; it must never become an auto-fill that bypasses the
 * model's constraint checking.
 */

/** Lowercase stems, apostrophes dropped — the same shape searchCandidates uses. */
export function phraseStems(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
    .map((t) => (t.length >= 4 && t.endsWith("es") ? t.slice(0, -2) : t.length >= 4 && t.endsWith("s") ? t.slice(0, -1) : t));
}

export function normalizePhrase(s: string): string {
  return phraseStems(s).join(" ").slice(0, 160);
}

function overlap(a: string[], b: string[]): number {
  const set = new Set(b);
  return a.filter((t) => set.has(t)).length;
}

export type LessonPair = { phrase: string; displayPhrase: string; posProductId: string };

/**
 * Pair the brain's SKIPPED phrases with the items the REP ADDED, at submit
 * time. Greedy best-overlap; a tie between two phrases for one item (or two
 * items for one phrase) pairs the best-scoring combination first and the
 * rest only if they still have a unique best. Zero-overlap pairs are taken
 * ONLY when there is exactly one skipped phrase and exactly one added item —
 * the unambiguous case ("the one thing I couldn't match is the one thing you
 * added").
 */
export function pairLessons(
  skippedPhrases: string[],
  addedItems: Array<{ posProductId: string; name?: string; brand?: string }>,
): LessonPair[] {
  const phrases = skippedPhrases
    .map((p) => ({ raw: String(p ?? "").slice(0, 160), stems: phraseStems(p) }))
    .filter((p) => p.raw.trim().length > 0);
  const items = addedItems.filter((i) => i && i.posProductId);
  if (phrases.length === 0 || items.length === 0) return [];

  if (phrases.length === 1 && items.length === 1) {
    return [{ phrase: normalizePhrase(phrases[0].raw), displayPhrase: phrases[0].raw, posProductId: items[0].posProductId }];
  }

  const scored: Array<{ pi: number; ii: number; score: number }> = [];
  for (let pi = 0; pi < phrases.length; pi++) {
    for (let ii = 0; ii < items.length; ii++) {
      const itemStems = phraseStems(`${items[ii].name ?? ""} ${items[ii].brand ?? ""}`);
      const score = overlap(phrases[pi].stems, itemStems);
      if (score >= 1) scored.push({ pi, ii, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const usedP = new Set<number>();
  const usedI = new Set<number>();
  const out: LessonPair[] = [];
  for (const s of scored) {
    if (usedP.has(s.pi) || usedI.has(s.ii)) continue;
    // ambiguity: another unused item ties this phrase at the same score → skip
    const tie = scored.some((o) => o !== s && o.score === s.score && o.pi === s.pi && !usedI.has(o.ii));
    if (tie) { usedP.add(s.pi); continue; }
    usedP.add(s.pi);
    usedI.add(s.ii);
    out.push({ phrase: normalizePhrase(phrases[s.pi].raw), displayPhrase: phrases[s.pi].raw, posProductId: items[s.ii].posProductId });
  }
  return out;
}

/**
 * Harvest lessons from a draft the rep just SUBMITTED. Best-effort by
 * contract — a lesson failure must never fail an order that already landed
 * on the register.
 */
export async function harvestPhraseLessons(
  db: any,
  tenantId: string,
  draft: { agentItems?: unknown; agentLines?: unknown },
  approvedItems: Array<{ posProductId: string; name?: string }>,
): Promise<number> {
  try {
    const agentIds = new Set(
      (Array.isArray(draft.agentItems) ? (draft.agentItems as any[]) : []).map((i: any) => String(i?.posProductId ?? "")),
    );
    const added = approvedItems.filter((i) => i.posProductId && !agentIds.has(i.posProductId));
    const skipped = (Array.isArray(draft.agentLines) ? (draft.agentLines as any[]) : [])
      .filter((l: any) => l?.outcome === "skipped" && l?.phrase)
      .map((l: any) => String(l.phrase));
    const pairs = pairLessons(skipped, added);
    for (const p of pairs) {
      if (!p.phrase) continue;
      await db.supermarketPhraseLesson.upsert({
        where: { tenantId_phrase_posProductId: { tenantId, phrase: p.phrase, posProductId: p.posProductId } },
        create: { tenantId, phrase: p.phrase, displayPhrase: p.displayPhrase.slice(0, 160), posProductId: p.posProductId, source: "rep" },
        update: { timesConfirmed: { increment: 1 }, lastConfirmedAt: new Date() },
      });
    }
    return pairs.length;
  } catch {
    return 0;
  }
}

/**
 * Match stored lessons against the brain's extracted lines. A lesson matches
 * a line when they share ≥2 stems, or the lesson has exactly 2 stems and
 * BOTH appear in the line.
 *
 * ⛔ A SINGLE-stem lesson matches only a single-stem LINE, exactly. This is
 * what makes teaching a bare word safe at all ("bread" → the rye-bread
 * loaf, Izzy 2026-08-30): under the old subset rule a "bread" lesson would
 * have injected the loaf as a learned (strongly-preferred!) candidate into
 * every "bread crumbs" and "breadsticks" line — the exact pollution that
 * kept a bare "milk" lesson from being seeded on 2026-08-27. A qualified
 * request ("whole wheat bread") deliberately does NOT take the bare-word
 * lesson — its own words already say what it is.
 *
 * Returns lineIdx → posProductIds (deduped).
 */
export function matchLessonsToLines(
  lessons: Array<{ phrase: string; posProductId: string }>,
  linePhrases: string[],
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const lineStems = linePhrases.map((p) => phraseStems(p));
  for (const lesson of lessons) {
    const ls = phraseStems(lesson.phrase);
    if (ls.length === 0) continue;
    for (let i = 0; i < lineStems.length; i++) {
      const shared = overlap(ls, lineStems[i]);
      const hit =
        ls.length === 1
          ? lineStems[i].length === 1 && shared === 1
          : shared >= 2 || (ls.length === 2 && shared === ls.length);
      if (!hit) continue;
      const arr = out.get(i) ?? [];
      if (!arr.includes(lesson.posProductId)) arr.push(lesson.posProductId);
      out.set(i, arr);
    }
  }
  return out;
}

/**
 * Newest lessons for a tenant, bounded — the brain's read path.
 * ⛔ Retired lessons (superseded by a newer correction) never reach the
 * brain — that is the whole point of retiring instead of leaving both hints
 * in the pool: a correction must CHANGE the answer, not add a rival.
 */
export async function loadLessons(db: any, tenantId: string): Promise<Array<{ phrase: string; posProductId: string }>> {
  try {
    const rows = await db.supermarketPhraseLesson.findMany({
      where: { tenantId, retiredAt: null },
      orderBy: { lastConfirmedAt: "desc" },
      take: 400,
      select: { phrase: true, posProductId: true },
    });
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
