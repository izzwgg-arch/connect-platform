#!/usr/bin/env -S npx tsx
/**
 * Harvest every Yiddish24 bulletin article to a JSONL file.
 *
 * Read-only against the site and the database: it writes one local file and
 * nothing else. Persisting the articles as transcript rows is a separate,
 * deliberate step (see `bulletinIngest.ts`), because the typed text is only
 * ~97% of what was said and must never become a label on its own.
 *
 *   npx tsx scripts/yiddish-bulletin/harvest.ts [--out scripts/.tmp/bulletin-articles.jsonl] [--max-pages 5]
 *
 * ⛔ Uses the Yiddish24 adapter's own rate-limited fetcher (2 s floor, 30 rpm
 * ceiling). A full walk is ~324 pages, about 11 minutes. Do not run two.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { harvestBulletinArticles } from "../../apps/api/src/yiddishCorpus/bulletinText";

function argVal(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const out = path.resolve(argVal(argv, "--out") ?? "scripts/.tmp/bulletin-articles.jsonl");
  const maxPagesRaw = Number(argVal(argv, "--max-pages") ?? 0);
  writeFileSync(out, "");

  const res = await harvestBulletinArticles({
    ...(maxPagesRaw > 0 ? { maxPages: maxPagesRaw } : {}),
    onPage: (page, total, articles) => {
      for (const a of articles) appendFileSync(out, JSON.stringify(a) + "\n");
      if (page === 1 || page % 20 === 0 || articles.length === 0) {
        console.log(`[harvest] page ${page}/${total} (+${articles.length})`);
      }
    },
  });
  console.log(`[harvest] DONE pages=${res.pagesRead}/${res.totalPages} articles=${res.articles.length} emptyPages=${res.emptyPages.length}`);
  // ⛔ A run of empty pages has ALWAYS meant a parser miss, never a short
  // archive — the first version reported 2,300 real articles that way.
  if (res.emptyPages.length) {
    console.log(`[harvest] ⛔ ${res.emptyPages.length} page(s) parsed to nothing: ${res.emptyPages.slice(0, 20).join(",")}`);
    console.log(`[harvest]    Check the markup before believing the archive ends there.`);
  }
}

main().catch((e) => {
  console.error(`[harvest] ${e?.message || e}`);
  process.exit(1);
});
