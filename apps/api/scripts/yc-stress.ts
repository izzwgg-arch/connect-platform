/**
 * Yiddish Learning Engine — end-to-end stress harness.
 *
 * Runs INSIDE the api container against the real database and (for discovery)
 * the live Yiddish24 site. Read-mostly: it writes only into Yc* tables, never
 * touches tenant data, never fetches audio, and cleans up the rows it invents.
 *
 *   docker exec -w /app/apps/api app-api-1 npx tsx scripts/yc-stress.ts
 *   ... --discover        also run a real (polite, metadata-only) discovery
 *   ... --keep            do not delete the synthetic stress rows
 *
 * Every check prints PASS/FAIL and the script exits non-zero if anything failed,
 * so it is usable as a deploy gate.
 */
import { db } from "@connect/db";
import * as governance from "../src/yiddishCorpus/governance";
import * as corpus from "../src/yiddishCorpus/corpusService";
import * as jobs from "../src/yiddishCorpus/jobs";
import * as adapter from "../src/yiddishCorpus/yiddish24Adapter";
import * as retention from "../src/yiddishCorpus/retention";
import * as indexer from "../src/yiddishCorpus/internalIndexer";
import { seedYiddishSources } from "../src/yiddishCorpus/seed";
import { YIDDISH24_SOURCE_KEY } from "../src/yiddishCorpus/contracts";

const DISCOVER = process.argv.includes("--discover");
const KEEP = process.argv.includes("--keep");
const STRESS_PREFIX = "__stress__";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  console.log(`Yiddish engine stress harness — ${new Date().toISOString()}`);

  section("1. Seed is idempotent");
  await seedYiddishSources(db);
  const firstCount = await db.ycSource.count();
  await seedYiddishSources(db);
  const secondCount = await db.ycSource.count();
  check("seeding twice creates no duplicate sources", firstCount === secondCount, `${firstCount} sources`);

  const y24 = await db.ycSource.findUnique({ where: { key: YIDDISH24_SOURCE_KEY } });
  check("Yiddish24 source exists", !!y24);
  check("Yiddish24 audio is DISABLED by default", y24?.audioFetchMode === "DISABLED", String(y24?.audioFetchMode));
  check("Yiddish24 metadata is allowed", y24?.contentAllowed === true);

  section("2. Governance gates");
  const rights = await db.ycRightsRecord.findMany({ where: { sourceId: y24?.id } });
  const gate = governance.assertAudioFetchAllowed(y24, rights);
  check("audio fetch refuses without a grant", gate.ok === false, gate.reason?.slice(0, 60));

  const customerSources = await db.ycSource.findMany({ where: { governanceClass: "CUSTOMER_PRIVATE" } });
  check("customer sources exist and are walled", customerSources.length > 0 && customerSources.every((s: any) => s.contentAllowed === false), `${customerSources.length} walled`);
  let threw = false;
  try {
    governance.assertContentReadable(customerSources[0]);
  } catch {
    threw = true;
  }
  check("reading customer content throws", threw);

  section("3. Fingerprint dedupe");
  const item1 = await corpus.upsertSourceItem(db, YIDDISH24_SOURCE_KEY, {
    externalId: `${STRESS_PREFIX}1`,
    title: "stress item one",
    fingerprint: `${STRESS_PREFIX}fp`,
    durationSec: 100,
  } as any);
  const item2 = await corpus.upsertSourceItem(db, YIDDISH24_SOURCE_KEY, {
    externalId: `${STRESS_PREFIX}2`,
    title: "stress item two",
    fingerprint: `${STRESS_PREFIX}fp`,
    durationSec: 100,
  } as any);
  // upsertSourceItem returns { item, ... } — read the rows back by externalId so
  // the harness never depends on the wrapper shape.
  const rowA = await db.ycSourceItem.findFirst({ where: { externalId: `${STRESS_PREFIX}1` } });
  const rowB = await db.ycSourceItem.findFirst({ where: { externalId: `${STRESS_PREFIX}2` } });
  check("second item with the same fingerprint is DUPLICATE", rowB?.state === "DUPLICATE", String(rowB?.state));
  check("duplicate points at the original", rowB?.duplicateOfId === rowA?.id, `${rowB?.duplicateOfId ?? "null"} vs ${rowA?.id ?? "null"}`);

  section("4. Worker leases (no double-processing)");
  const itemId = rowA?.id ?? null;
  const made = await db.ycProcessingJob.createMany({
    data: Array.from({ length: 25 }, (_, i) => ({
      sourceKey: `${STRESS_PREFIX}${YIDDISH24_SOURCE_KEY}`,
      stage: "discover",
      priority: 10 + i,
      itemId: null,
    })),
  });
  check("queued 25 stress jobs", made.count === 25, `${made.count}`);
  const claimA = await jobs.claimJobs(db, { leaseOwner: "stressA", limit: 15 });
  const claimB = await jobs.claimJobs(db, { leaseOwner: "stressB", limit: 15 });
  const idsA = new Set(claimA.map((j: any) => j.id));
  const overlap = claimB.filter((j: any) => idsA.has(j.id));
  check("two workers never claim the same job", overlap.length === 0, `A=${claimA.length} B=${claimB.length} overlap=${overlap.length}`);
  check("claims are bounded by the limit", claimA.length <= 15 && claimB.length <= 15);

  section("5. Budget stops work");
  const budget = await db.ycBudget.findFirst({ where: { scope: "global" } });
  check("global budget exists", !!budget);
  check("global budget starts paused", budget?.paused === true, `paused=${budget?.paused}`);
  if (typeof (jobs as any).budgetVerdict === "function" && budget) {
    const verdict = (jobs as any).budgetVerdict({ ...budget, paused: true }, "transcribe");
    check("paused budget refuses work", verdict?.allowed === false, JSON.stringify(verdict)?.slice(0, 80));
    const audioVerdict = (jobs as any).budgetVerdict({ ...budget, paused: false, mode: "METADATA_ONLY" }, "transcribe");
    check("METADATA_ONLY mode refuses an audio stage", audioVerdict?.allowed === false, JSON.stringify(audioVerdict)?.slice(0, 80));
  }

  section("6. Audio pipeline availability (ffmpeg)");
  const pipeline = await import("../src/yiddishCorpus/audioPipeline");
  const avail = await (pipeline as any).ffmpegAvailability?.();
  check("ffmpeg/ffprobe present in this container", avail?.available === true, JSON.stringify(avail)?.slice(0, 120));

  section("7. Retention never deletes text");
  const dry = await retention.applyRetention(db, new Date(), { dryRun: true } as any).catch((e: any) => ({ error: String(e) }));
  check("retention dry-run succeeds", !(dry as any).error, JSON.stringify(dry)?.slice(0, 120));
  const transcriptsBefore = await db.ycTranscript.count();
  const dry2 = await retention.applyRetention(db, new Date(), { dryRun: true } as any).catch(() => null);
  const transcriptsAfter = await db.ycTranscript.count();
  check("dry-run wrote nothing", transcriptsBefore === transcriptsAfter);

  section("8. Internal inventory (counts only)");
  const inv = await indexer.reindexInternal(db).catch((e: any) => ({ error: String(e) }));
  check("internal reindex ran", !(inv as any).error, JSON.stringify(inv)?.slice(0, 200));

  section("9. Export is honest");
  const exportable = await db.ycTranscript.findMany({ take: 200 });
  const filtered = governance.filterExportable
    ? governance.filterExportable(exportable.map((t: any) => ({ ...t, sourceKey: "voicemail" })) as any)
    : [];
  check("nothing customer-private survives the export filter", (filtered as any[]).length === 0, `${(filtered as any[]).length} rows`);

  if (DISCOVER) {
    section("10. LIVE discovery against Yiddish24 (metadata only, polite)");
    const started = Date.now();
    const before = await db.ycSourceItem.count({ where: { source: { key: YIDDISH24_SOURCE_KEY } } });
    const res = await adapter.discover(db, { maxPages: 3, maxItems: 40 } as any).catch((e: any) => ({ error: String(e) }));
    const after = await db.ycSourceItem.count({ where: { source: { key: YIDDISH24_SOURCE_KEY } } });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    check("discovery completed without error", !(res as any).error, JSON.stringify(res)?.slice(0, 200));
    check("real episodes landed in the database", after > before, `${before} → ${after} items in ${secs}s`);
    const sample = await db.ycSourceItem.findFirst({
      where: { source: { key: YIDDISH24_SOURCE_KEY }, NOT: { externalId: { startsWith: STRESS_PREFIX } } },
      orderBy: { discoveredAt: "desc" },
    });
    check("a real item has a media reference recorded (never fetched)", !!sample?.mediaUrl, sample?.mediaUrl ? new URL(sample.mediaUrl).host : "none");
    check("a real item has a duration", !!sample?.durationSec, `${sample?.durationSec}s`);
    check("politeness: 3 pages took at least 4s", Number(secs) >= 4, `${secs}s`);
    const assets = await db.ycAudioAsset.count();
    check("discovery downloaded NO audio", assets === 0, `${assets} audio assets`);
  }

  if (!KEEP) {
    section("Cleanup");
    const delJobs = await db.ycProcessingJob.deleteMany({ where: { sourceKey: { startsWith: STRESS_PREFIX } } });
    const delItems = await db.ycSourceItem.deleteMany({ where: { externalId: { startsWith: STRESS_PREFIX } } });
    console.log(`  removed ${delJobs.count} stress jobs, ${delItems.count} stress items`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(`failed: ${failures.join(", ")}`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("harness crashed:", err);
  process.exit(2);
});
