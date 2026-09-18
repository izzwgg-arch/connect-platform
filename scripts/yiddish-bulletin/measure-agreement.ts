#!/usr/bin/env -S npx tsx
/**
 * Measure how well the Yiddish24 bulletin's typed articles actually agree with
 * our own ASR of the same recordings, and print the distribution.
 *
 * This exists because the whole design rests on a number the owner gave from
 * memory — "not 100% word for word, but I would say 97%" (Izzy, 2026-09-18) —
 * and a threshold picked from a remembered number is a guess wearing a
 * decimal point. Every cut-off in `bulletinAlign` / `bulletinIngest` should be
 * justified by what this prints against the items we already have ASR for.
 *
 * Read-only: it writes nothing to the database.
 *
 *   npx tsx scripts/yiddish-bulletin/measure-agreement.ts \
 *     --articles scripts/.tmp/bulletin-articles.jsonl [--limit 200]
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { loadRunnerEnv } from "../yiddish-finetune/build-dataset";
import { BULLETIN_SERIES_NAME, type BulletinArticle } from "../../apps/api/src/yiddishCorpus/bulletinText";
import { alignItem, timedWordsFrom } from "../../apps/api/src/yiddishCorpus/bulletinIngest";

const HERE = __dirname;

function argVal(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const articlesPath = argVal(argv, "--articles") ?? "scripts/.tmp/bulletin-articles.jsonl";
  const limit = Number(argVal(argv, "--limit") ?? 0) || Number.MAX_SAFE_INTEGER;

  const byExternalId = new Map<string, BulletinArticle>();
  for (const line of readFileSync(path.resolve(articlesPath), "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const a = JSON.parse(line) as BulletinArticle;
    byExternalId.set(a.externalId, a);
  }
  console.log(`[measure] ${byExternalId.size} harvested article(s) from ${articlesPath}`);

  loadRunnerEnv(HERE);
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();

  const items = await db.ycSourceItem.findMany({
    where: { seriesName: BULLETIN_SERIES_NAME, transcripts: { some: { engine: "ivrit" } } },
    select: { id: true, externalId: true, durationSec: true, title: true },
    take: limit,
  });
  console.log(`[measure] ${items.length} bulletin item(s) in the corpus already have ASR`);

  const agreements: number[] = [];
  const results: Array<{ externalId: string; agreement: number; spans: number; spanSec: number; rejected: string | null }> = [];
  let noArticle = 0;
  let totalSpanSec = 0;
  let totalAudioSec = 0;

  for (const item of items) {
    const article = byExternalId.get(item.externalId);
    if (!article) {
      noArticle += 1;
      continue;
    }
    const rows = await db.ycTranscript.findMany({
      where: { itemId: item.id, engine: "ivrit" },
      select: { startMs: true, words: true },
      orderBy: { startMs: "asc" },
    });
    const words = timedWordsFrom(rows as any);
    const a = alignItem(article, words);
    agreements.push(a.agreement);
    const spanSec = a.spans.reduce((s, x) => s + (x.endMs - x.startMs) / 1000, 0);
    totalSpanSec += spanSec;
    totalAudioSec += item.durationSec ?? 0;
    results.push({ externalId: item.externalId, agreement: a.agreement, spans: a.spans.length, spanSec: Math.round(spanSec), rejected: a.rejected });
  }

  console.log(`\n=== agreement (share of HEARD words the typed article also has, in order) ===`);
  console.log(`  items measured : ${agreements.length}   (no harvested article: ${noArticle})`);
  for (const p of [5, 10, 25, 50, 75, 90, 95]) console.log(`  p${String(p).padStart(2)} : ${pct(agreements, p).toFixed(3)}`);
  const mean = agreements.reduce((s, x) => s + x, 0) / Math.max(1, agreements.length);
  console.log(`  mean: ${mean.toFixed(3)}`);
  for (const band of [0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.3]) {
    console.log(`  >= ${band.toFixed(2)} : ${agreements.filter((x) => x >= band).length} item(s)`);
  }

  const usable = results.filter((r) => r.spans > 0);
  console.log(`\n=== what alignment actually keeps ===`);
  console.log(`  items producing at least one span : ${usable.length} / ${results.length}`);
  console.log(`  aligned audio kept : ${Math.round(totalSpanSec)}s of ${Math.round(totalAudioSec)}s (${((100 * totalSpanSec) / Math.max(1, totalAudioSec)).toFixed(1)}%)`);
  const reasons = new Map<string, number>();
  for (const r of results) if (r.rejected) reasons.set(r.rejected.replace(/[\d.]+/g, "N"), (reasons.get(r.rejected.replace(/[\d.]+/g, "N")) ?? 0) + 1);
  for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  rejected (${n}): ${why}`);

  console.log(`\n=== worst and best ===`);
  const sorted = [...results].sort((a, b) => a.agreement - b.agreement);
  for (const r of sorted.slice(0, 3)) console.log(`  LOW  ${r.externalId} agreement=${r.agreement} spans=${r.spans}`);
  for (const r of sorted.slice(-3)) console.log(`  HIGH ${r.externalId} agreement=${r.agreement} spans=${r.spans} spanSec=${r.spanSec}`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error(`[measure] ${e?.message || e}`);
  process.exit(1);
});
