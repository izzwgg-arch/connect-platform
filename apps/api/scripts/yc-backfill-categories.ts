/**
 * Yiddish24 — repair `category` on catalogued items, and exclude music.
 *
 * WHY THIS EXISTS (two real defects, both fixed in the adapter):
 *  1. `parseListingHtml` once filed every item under a CSS colour ("darkred").
 *  2. `parseSeriesLinks` once let the LAST place a series appeared on the page
 *     decide its category. The live page carries the nav more than once, so
 *     news bulletins were filed as Torah and no series at all as news. The
 *     first version of THIS script inherited that, and wrote the wrong labels.
 *
 * The listing rows carry no category, so the only honest source is the series
 * catalog in the nav. This reads it ONCE — the same page discovery reads, one
 * polite request, no audio, no Referer to the media host — and:
 *   - writes each item's real main-category label (with --relabel, it also
 *     REPLACES a label that disagrees with the catalog — the old ones are
 *     provably wrong);
 *   - marks every item from a music series SKIPPED with the exact marker the
 *     worker reads, and skips any stage already queued for it.
 * A series name the catalog cannot place, or places under two categories, is
 * left alone. Unknown is honest; a guess is not.
 *
 *   docker exec -w /app/apps/api app-api-1 npx tsx scripts/yc-backfill-categories.ts [--relabel] [--apply]
 *
 * Without --apply it prints the plan and writes nothing.
 */
import { db } from "@connect/db";
import {
  isMusicSeries,
  parseSeriesLinks,
  YIDDISH24_ORIGIN,
  YIDDISH24_USER_AGENT,
} from "../src/yiddishCorpus/yiddish24Adapter";
import { YC_MUSIC_EXCLUDED_MESSAGE, YIDDISH24_SOURCE_KEY } from "../src/yiddishCorpus/contracts";

const APPLY = process.argv.includes("--apply");
const RELABEL = process.argv.includes("--relabel");

/** A value that is a CSS colour, not a category. */
const COLOUR_RE =
  /^(dark|light|medium)?(red|blue|green|orange|purple|violet|grey|gray|black|white|brown|pink|yellow|cyan|magenta|teal|olive|navy|maroon|gold|silver)$/i;

async function main() {
  console.log(
    `yc-backfill-categories — ${new Date().toISOString()} — ${APPLY ? "APPLY" : "dry run"}${RELABEL ? " + relabel" : ""}`,
  );

  const source = await db.ycSource.findUnique({ where: { key: YIDDISH24_SOURCE_KEY } });
  if (!source) throw new Error("yiddish24 source row missing — run the seed first");

  // 1. The catalog, from the SAME page discovery reads.
  const res = await fetch(`${YIDDISH24_ORIGIN}/mainCategory/1`, {
    headers: {
      "user-agent": YIDDISH24_USER_AGENT,
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`site answered ${res.status} — not repairing anything`);
  const series = parseSeriesLinks(await res.text());
  if (series.length < 20) throw new Error(`catalog parsed only ${series.length} series — refusing to touch any row`);

  const labelsByName = new Map<string, Set<string>>();
  const musicByName = new Map<string, boolean>();
  for (const s of series) {
    if (!s.name) continue;
    const name = s.name.trim();
    if (s.mainCategoryLabel) {
      if (!labelsByName.has(name)) labelsByName.set(name, new Set());
      labelsByName.get(name)!.add(s.mainCategoryLabel.trim());
    }
    if (isMusicSeries(s.mainCategoryId, s.catId)) musicByName.set(name, true);
  }
  const musicNames = [...musicByName.keys()];
  console.log(`catalog: ${series.length} series; music series: ${musicNames.length}`);
  console.log(`  music: ${musicNames.join(" | ")}`);

  // 2. Every item, decided from the catalog.
  const rows = await db.ycSourceItem.findMany({
    where: { sourceId: source.id },
    select: { id: true, seriesName: true, category: true, state: true, error: true },
  });

  const relabel = new Map<string, string[]>(); // label -> ids
  const music: string[] = [];
  let unplaceable = 0;
  let ambiguous = 0;
  for (const r of rows) {
    const name = String(r.seriesName ?? "").trim();
    if (name && musicByName.get(name)) {
      if (!(r.state === "SKIPPED" && r.error === YC_MUSIC_EXCLUDED_MESSAGE)) music.push(r.id);
    }
    const labels = name ? labelsByName.get(name) : undefined;
    if (!labels) {
      unplaceable += 1;
      continue;
    }
    if (labels.size !== 1) {
      ambiguous += 1;
      continue;
    }
    const label = [...labels][0];
    const wrongOrMissing = !r.category || COLOUR_RE.test(r.category);
    const disagrees = RELABEL && r.category && r.category !== label;
    if (wrongOrMissing || disagrees) {
      if (!relabel.has(label)) relabel.set(label, []);
      relabel.get(label)!.push(r.id);
    }
  }

  console.log(`items: ${rows.length}`);
  for (const [label, ids] of [...relabel.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  relabel ${String(ids.length).padStart(6)} -> ${label}`);
  }
  console.log(`  mark as music     ${String(music.length).padStart(6)}`);
  console.log(`  series not in the catalog (left alone) ${unplaceable}; name under two categories (left alone) ${ambiguous}`);

  if (!APPLY) {
    console.log("\ndry run — nothing written. Re-run with --apply.");
    return;
  }

  let placed = 0;
  for (const [label, ids] of relabel) {
    for (let i = 0; i < ids.length; i += 500) {
      const r = await db.ycSourceItem.updateMany({ where: { id: { in: ids.slice(i, i + 500) } }, data: { category: label } });
      placed += r.count;
    }
  }

  let marked = 0;
  let jobsSkipped = 0;
  for (let i = 0; i < music.length; i += 500) {
    const chunk = music.slice(i, i + 500);
    const r = await db.ycSourceItem.updateMany({
      where: { id: { in: chunk } },
      data: { state: "SKIPPED", error: YC_MUSIC_EXCLUDED_MESSAGE },
    });
    marked += r.count;
    // Anything queued for them stops here. RUNNING rows are left to the worker's
    // own guard, which refuses them on the next claim anyway.
    const j = await db.ycProcessingJob.updateMany({
      where: { itemId: { in: chunk }, state: "PENDING" },
      data: { state: "SKIPPED", error: YC_MUSIC_EXCLUDED_MESSAGE, leaseOwner: null, leaseUntil: null },
    });
    jobsSkipped += j.count;
  }
  console.log(`\nwrote ${placed} category labels; marked ${marked} music items; skipped ${jobsSkipped} queued jobs`);

  const after = await db.ycSourceItem.groupBy({ by: ["category"], where: { sourceId: source.id }, _count: { _all: true } });
  for (const g of after.sort((a: any, b: any) => b._count._all - a._count._all)) {
    console.log(`  ${String(g._count._all).padStart(6)}  ${g.category ?? "(null)"}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("backfill failed:", err?.message ?? err);
    process.exit(1);
  });
