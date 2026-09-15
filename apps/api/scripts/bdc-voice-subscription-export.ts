/**
 * Build LoopCom's FCC Broadband Data Collection (BDC) Fixed Voice Subscription
 * filing straight out of the Connect database.
 *
 * WHY: the BDC round is twice a year (data as of June 30, due Sept 1; data as of
 * Dec 31, due March 1) and it is the same clerical job every time — count the
 * seats in service on the as-of date, put each customer in a census tract, and
 * hand the FCC a tiny CSV. Done by hand on 2026-09-15 it cost most of a day,
 * mostly hunting service addresses. This script makes it one command.
 *
 * ⛔ THIS SCRIPT ONLY READS. It writes a CSV to disk and prints numbers. It never
 * touches the database, the PBX, VoIP.ms, or E911 registrations.
 *
 * WHAT IT PRODUCES
 *   1. bdc-fixed-voice-<as-of>.csv — the tract-level upload file. Columns are the
 *      FCC's four required fields, in their order:
 *          tract,service_type,total_lines_or_subscriptions,consumer_lines_or_subscriptions
 *      (help.bdc.fcc.gov "How to Format Fixed Voice Subscription Data")
 *   2. The STATE-LEVEL numbers to type on the "State-Level Data" tab, which has
 *      no upload path — it is a web form.
 *   3. A per-tenant reconciliation table, so the totals can be checked against
 *      something a human recognises before anything is filed.
 *
 * COUNTING RULE (as filed 2026-09-15, 102 subscriptions):
 *   One subscription per Extension row that existed on the as-of date, for each
 *   CUSTOMER tenant that is in the tract map. Loopcom's own workspaces, test and
 *   deleted tenants are listed in the map's "excluded" block with a reason.
 *   Every customer is a business, so consumer counts are 0 and Loopcom supplies
 *   no last-mile, so the state allocation is 100% Over-the-Top.
 *
 * ⛔ THE SAFETY THAT MATTERS: if a tenant has extensions on the as-of date but is
 * in NEITHER the map nor the exclusion list, the script REFUSES to write a CSV
 * and exits non-zero. A new customer silently missing from a federal filing is
 * the failure this guards against. Add them to docs/regulatory/bdc-tenant-tracts.json
 * (there is a --allow-unmapped escape hatch, but it prints a loud warning).
 *
 * USAGE (from apps/api, same env as the API — needs DATABASE_URL):
 *   # December round:
 *   pnpm exec tsx scripts/bdc-voice-subscription-export.ts --as-of 2026-12-31
 *
 *   # Re-create exactly what was filed for the June round:
 *   pnpm exec tsx scripts/bdc-voice-subscription-export.ts --as-of 2026-06-30
 *
 *   Options:
 *     --as-of YYYY-MM-DD   Required. The BDC "data as of" date (June 30 or Dec 31).
 *     --out <path>         CSV destination (default ./bdc-fixed-voice-<as-of>.csv).
 *     --no-header          Omit the CSV header row.
 *     --allow-unmapped     Continue despite unmapped tenants (they are EXCLUDED).
 *     --map <path>         Override the tract map location.
 */
import { readFileSync, existsSync, writeFileSync } from "fs";
import { resolve } from "path";

function loadEnv(): void {
  const dir = resolve(process.cwd());
  for (const p of [resolve(dir, ".env"), resolve(dir, "../.env"), resolve(dir, "../../.env")]) {
    if (existsSync(p)) {
      const content = readFileSync(p, "utf8");
      for (const line of content.split("\n")) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
        }
      }
      break;
    }
  }
}
loadEnv();

type TenantEntry = { name: string; tract: string; address?: string };
type TractMap = {
  serviceType: { value: number };
  consumerPolicy: { consumerCount: number };
  tenants: Record<string, TenantEntry>;
  excluded: Record<string, { name: string; reason: string }>;
};

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

function findMapPath(): string {
  const override = arg("--map");
  if (override) return resolve(override);
  const candidates = [
    resolve(process.cwd(), "../../docs/regulatory/bdc-tenant-tracts.json"),
    resolve(process.cwd(), "../docs/regulatory/bdc-tenant-tracts.json"),
    resolve(process.cwd(), "docs/regulatory/bdc-tenant-tracts.json"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`Could not find bdc-tenant-tracts.json. Looked in:\n  ${candidates.join("\n  ")}`);
}

/**
 * The as-of date is an inclusive END of day: an extension created ON June 30 was
 * in service on June 30. Compared in UTC against the stored createdAt.
 */
function asOfBoundary(ymd: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error(`--as-of must be YYYY-MM-DD, got "${ymd}"`);
  const d = new Date(`${ymd}T23:59:59.999Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`"${ymd}" is not a real date`);
  return d;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main() {
  const asOf = arg("--as-of");
  if (!asOf) {
    console.error("Missing --as-of YYYY-MM-DD (the BDC 'data as of' date, e.g. 2026-12-31).");
    process.exit(2);
  }
  const boundary = asOfBoundary(asOf);
  const mapPath = findMapPath();
  const map: TractMap = JSON.parse(readFileSync(mapPath, "utf8"));
  const serviceType = map.serviceType?.value ?? 1;
  const consumerCount = map.consumerPolicy?.consumerCount ?? 0;

  const { db } = await import("@connect/db");

  // Every CUSTOMER tenant that had at least one extension on the as-of date.
  const tenants: Array<{ id: string; name: string; kind: string }> = await db.tenant.findMany({
    where: { kind: "CUSTOMER" },
    select: { id: true, name: true, kind: true },
    orderBy: { name: "asc" },
  });

  const rows: Array<{ id: string; name: string; count: number }> = [];
  for (const t of tenants) {
    const count = await db.extension.count({ where: { tenantId: t.id, createdAt: { lte: boundary } } });
    if (count > 0) rows.push({ id: t.id, name: t.name, count });
  }

  const included: Array<{ id: string; name: string; count: number; tract: string }> = [];
  const excluded: Array<{ name: string; count: number; reason: string }> = [];
  const unmapped: Array<{ id: string; name: string; count: number }> = [];

  for (const r of rows) {
    const mapped = map.tenants[r.id];
    if (mapped) {
      if (!/^\d{11}$/.test(mapped.tract)) {
        console.error(`\n⛔ Tenant "${r.name}" has tract "${mapped.tract}" — a tract must be exactly 11 digits.`);
        process.exit(3);
      }
      included.push({ ...r, tract: mapped.tract });
      continue;
    }
    const ex = map.excluded[r.id];
    if (ex) {
      excluded.push({ name: r.name, count: r.count, reason: ex.reason });
      continue;
    }
    unmapped.push(r);
  }

  console.log(`\nBDC Fixed Voice Subscription — data as of ${asOf}`);
  console.log(`Tract map: ${mapPath}\n`);

  console.log("REPORTED (counts as one VoIP subscription per extension in service):");
  console.log(`  ${pad("Tenant", 30)} ${pad("Subs", 5)} Tract`);
  for (const i of included.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${pad(i.name, 30)} ${pad(String(i.count), 5)} ${i.tract}`);
  }

  if (excluded.length) {
    console.log("\nEXCLUDED ON PURPOSE (not reported):");
    for (const e of excluded.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`  ${pad(e.name, 30)} ${pad(String(e.count), 5)} ${e.reason}`);
    }
  }

  if (unmapped.length) {
    console.error("\n⛔ TENANTS WITH EXTENSIONS BUT NO ENTRY IN THE TRACT MAP:");
    for (const u of unmapped) console.error(`  ${pad(u.name, 30)} ${pad(String(u.count), 5)} id=${u.id}`);
    console.error(
      `\nAdd each one to ${mapPath} — either under "tenants" with its service address and\n` +
        `11-digit census tract, or under "excluded" with the reason it is not reported.\n` +
        `Get the tract from the Census geocoder:\n` +
        `  https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=<ADDRESS>&benchmark=Public_AR_Current&vintage=Current_Current&format=json\n` +
        `(if it returns NO MATCH, geocode to lat/lon elsewhere and use /geographies/coordinates).`,
    );
    if (!has("--allow-unmapped")) {
      console.error(`\nRefusing to write a CSV that would silently under-report to the FCC. Re-run with --allow-unmapped to override.`);
      process.exit(4);
    }
    console.error(`\n⚠️  --allow-unmapped given: the tenants above are NOT in the filing.\n`);
  }

  // ── Aggregate to the tract level ───────────────────────────────────────────
  // Rows must be unique by tract + service type, and a zero-total row must not
  // be included at all (both are explicit FCC rules).
  const byTract = new Map<string, number>();
  for (const i of included) byTract.set(i.tract, (byTract.get(i.tract) || 0) + i.count);

  const csvRows = [...byTract.entries()]
    .filter(([, total]) => total > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tract, total]) => `${tract},${serviceType},${total},${consumerCount}`);

  const header = "tract,service_type,total_lines_or_subscriptions,consumer_lines_or_subscriptions";
  const csv = (has("--no-header") ? csvRows : [header, ...csvRows]).join("\n") + "\n";

  const outPath = resolve(arg("--out") || `bdc-fixed-voice-${asOf}.csv`);
  writeFileSync(outPath, csv, "utf8");

  // Consumer counts are per ROW, so the state-level consumer figure is the sum
  // across the rows actually written (0 under the current all-business policy).
  const grandTotal = [...byTract.values()].reduce((a, b) => a + b, 0);
  const consumerTotal = csvRows.length * consumerCount;
  const businessTotal = grandTotal - consumerTotal;

  console.log(`\nTRACT FILE: ${outPath}`);
  console.log(`  ${byTract.size} tract row(s), ${grandTotal} subscription(s)\n`);
  for (const line of csvRows) console.log(`  ${line}`);

  console.log(`\nSTATE-LEVEL DATA — type these on the "State-Level Data" tab (it has no upload):`);
  console.log(`  New York`);
  console.log(`    Grand Total Subscriptions ....... ${grandTotal}  = consumer ${consumerTotal} + business/govt ${businessTotal}`);
  console.log(`    Over-the-Top Subscriptions ...... ${grandTotal}  = consumer ${consumerTotal} + business/govt ${businessTotal}`);
  console.log(`    All Other Subscriptions ......... 0 across End-User Type, Services Sold and Last-Mile Medium`);
  console.log(`\n  (Loopcom supplies no last-mile facilities, so every subscription is Over-the-Top.)`);

  console.log(`\nNEXT STEPS IN THE BDC:`);
  console.log(`  1. Subscription -> Fixed Voice Subscription (Non-ILEC) -> Upload Files -> pick the CSV above.`);
  console.log(`  2. State-Level Data -> New York -> type the numbers above -> Save State.`);
  console.log(`  3. Run Final Data Checks, answer the all-business ratio warning, then certify.`);
  console.log(`  ⛔ Certification is a signed legal attestation — Izzy signs it, not an agent.\n`);

  await db.$disconnect?.().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
