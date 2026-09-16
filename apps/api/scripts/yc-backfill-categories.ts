/**
 * Yiddish24 — repair the `category` column on already-catalogued items.
 *
 * WHY THIS EXISTS: `parseListingHtml` used to fall back to the row's
 * `data-cat-color` attribute, which is a CSS swatch, so every item ever
 * discovered was filed under "darkred". The parser is fixed; this repairs the
 * rows that were written before the fix.
 *
 * The listing markup does not carry a category at all. The only honest source
 * is the series catalog in the site nav, which groups every series under a
 * main category. So this reads the catalog ONCE (one polite request, no audio,
 * no Referer to the media host), maps seriesName -> main category label, and
 * writes that label onto items that have no real category yet.
 *
 * ⛔ It never overwrites a category that is already a real label, and a series
 * it cannot place is left NULL — unknown is honest, a colour is not.
 *
 *   docker exec -w /app/apps/api app-api-1 npx tsx scripts/yc-backfill-categories.ts [--apply]
 *
 * Without --apply it prints the plan and writes nothing.
 */
import { db } from "@connect/db";
import {
  parseSeriesLinks,
  YIDDISH24_ORIGIN,
  YIDDISH24_USER_AGENT,
} from "../src/yiddishCorpus/yiddish24Adapter";
import { YIDDISH24_SOURCE_KEY } from "../src/yiddishCorpus/contracts";

const APPLY = process.argv.includes("--apply");

/** A value that is a CSS colour, not a category. These are the bad rows. */
const COLOUR_RE = /^(dark|light|medium)?(red|blue|green|orange|purple|violet|grey|gray|black|white|brown|pink|yellow|cyan|magenta|teal|olive|navy|maroon|gold|silver)$/i;

async function main() {
  console.log(`yc-backfill-categories — ${new Date().toISOString()} — ${APPLY ? "APPLY" : "dry run"}`);

  const source = await db.ycSource.findUnique({ where: { key: YIDDISH24_SOURCE_KEY } });
  if (!source) throw new Error("yiddish24 source row missing — run the seed first");

  // 1. the catalog, from one page. Every page carries the whole nav.
  const res = await fetch(`${YIDDISH24_ORIGIN}/`, {
    headers: {
      "user-agent": YIDDISH24_USER_AGENT,
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`site answered ${res.status} — not repairing anything`);
  const series = parseSeriesLinks(await res.text());
  const byName = new Map<string, string>();
  for (const s of series) {
    if (s.name && s.mainCategoryLabel) byName.set(s.name.trim(), s.mainCategoryLabel.trim());
  }
  console.log(`catalog: ${series.length} series, ${byName.size} of them placed under a main category`);
  if (byName.size === 0) throw new Error("catalog parsed no placed series — refusing to touch any row");

  // 2. the rows that are wrong or unknown.
  const rows = await db.ycSourceItem.findMany({
    where: { sourceId: source.id },
    select: { id: true, seriesName: true, category: true },
  });
  const needsRepair = rows.filter((r: any) => !r.category || COLOUR_RE.test(r.category));
  console.log(`items: ${rows.length} total, ${needsRepair.length} with no real category`);

  const plan = new Map<string, string[]>(); // label -> ids
  // Rows we cannot place AND that currently hold a colour. Collected HERE, in
  // the same pass, so the clear step below can never touch a row this run just
  // gave a real label to.
  const toClear: string[] = [];
  let unplaceable = 0;
  for (const r of needsRepair) {
    const label = r.seriesName ? byName.get(r.seriesName.trim()) : undefined;
    if (!label) {
      unplaceable += 1;
      if (r.category && COLOUR_RE.test(r.category)) toClear.push(r.id);
      continue;
    }
    if (!plan.has(label)) plan.set(label, []);
    plan.get(label)!.push(r.id);
  }

  for (const [label, ids] of [...plan.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(ids.length).padStart(5)}  ${label}`);
  }
  console.log(`  ${String(unplaceable).padStart(5)}  (series not in the catalog — cleared to NULL)`);

  if (!APPLY) {
    console.log("\ndry run — nothing written. Re-run with --apply.");
    return;
  }

  let placed = 0;
  for (const [label, ids] of plan) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const r = await db.ycSourceItem.updateMany({ where: { id: { in: chunk } }, data: { category: label } });
      placed += r.count;
    }
  }
  // A colour on a series the catalog does not list: NULL is the honest value.
  let cleared = 0;
  for (let i = 0; i < toClear.length; i += 500) {
    const r = await db.ycSourceItem.updateMany({
      where: { id: { in: toClear.slice(i, i + 500) } },
      data: { category: null },
    });
    cleared += r.count;
  }
  console.log(`wrote ${placed} real categories; cleared ${cleared} unplaceable colour values to NULL`);

  const after = await db.ycSourceItem.groupBy({ by: ["category"], where: { sourceId: source.id }, _count: { _all: true } });
  for (const g of after.sort((a: any, b: any) => b._count._all - a._count._all)) {
    console.log(`  ${String(g._count._all).padStart(5)}  ${g.category ?? "(null)"}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("backfill failed:", err?.message ?? err);
    process.exit(1);
  });
