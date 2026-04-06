/**
 * Create Connect tenants for PBX tenants T2 (a_plus_center) and T8 (gesheft),
 * wire up TenantPbxLink, then backfill connectTenantId on PbxTenantInboundDid
 * for 8457823064 and 8452449666.
 *
 * Usage (from apps/api):
 *   # Step 1 — diagnostic only, no writes:
 *   pnpm exec tsx scripts/fix-pbx-tenant-links.ts
 *
 *   # Step 2 — create tenants, link, and backfill:
 *   pnpm exec tsx scripts/fix-pbx-tenant-links.ts --fix
 *
 *   # Optional: supply existing tenant IDs to skip creation:
 *   pnpm exec tsx scripts/fix-pbx-tenant-links.ts --fix --t2=<connectTenantId> --t8=<connectTenantId>
 *
 * Run from apps/api with same env as API (DATABASE_URL, CREDENTIALS_MASTER_KEY).
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { db } from "@connect/db";
import { syncPbxTenantInboundDids } from "../src/pbxTenantInboundDidSync";

const VERIFY_DIDS = ["8457823064", "8452449666"];

function loadEnv(): void {
  const dir = resolve(process.cwd());
  for (const p of [resolve(dir, ".env"), resolve(dir, "../.env")]) {
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

function parseArgs(): { fix: boolean; t2Override: string | null; t8Override: string | null } {
  const args = process.argv.slice(2);
  const fix = args.includes("--fix");
  const t2Arg = args.find((a) => a.startsWith("--t2="));
  const t8Arg = args.find((a) => a.startsWith("--t8="));
  return {
    fix,
    t2Override: t2Arg ? t2Arg.split("=")[1].trim() : null,
    t8Override: t8Arg ? t8Arg.split("=")[1].trim() : null,
  };
}

/** Find an existing tenant by exact or case-insensitive name. */
async function findTenantByName(name: string) {
  return db.tenant.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true, name: true } });
}

/** Create a minimal but approved Connect tenant ready for PBX use. */
async function createTenant(name: string) {
  return db.tenant.create({
    data: {
      name,
      isApproved: true,
      smsSendMode: "TEST",
      smsBillingEnforced: false,
      smsSubscriptionRequired: false,
    },
    select: { id: true, name: true },
  });
}

async function main(): Promise<void> {
  loadEnv();
  const { fix, t2Override, t8Override } = parseArgs();

  // ── 1. Find the active PBX instance ──────────────────────────────────────
  const instance = await db.pbxInstance.findFirst({
    where: { isEnabled: true },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, baseUrl: true },
  });
  if (!instance) {
    console.error("No enabled PbxInstance found — aborting.");
    process.exit(1);
  }
  console.log(`\n[PBX Instance]  id=${instance.id}  name=${instance.name}  url=${instance.baseUrl}\n`);

  // ── 2. PbxTenantDirectory rows for vitalTenantId 2 and 8 ─────────────────
  const dirRows = await db.pbxTenantDirectory.findMany({
    where: { pbxInstanceId: instance.id },
    orderBy: { vitalTenantId: "asc" },
  });
  console.log("=== PbxTenantDirectory (all rows) ===");
  for (const r of dirRows) {
    console.log(`  vitalTenantId=${r.vitalTenantId}  code=${r.tenantCode}  slug=${r.tenantSlug}  name=${r.displayName ?? "(none)"}`);
  }

  const dir2 = dirRows.find((r) => r.vitalTenantId.trim() === "2");
  const dir8 = dirRows.find((r) => r.vitalTenantId.trim() === "8");
  console.log(`\ndir vitalTenantId=2: ${JSON.stringify(dir2 ?? null)}`);
  console.log(`dir vitalTenantId=8: ${JSON.stringify(dir8 ?? null)}\n`);

  // ── 3. All Connect tenants ────────────────────────────────────────────────
  const allTenants = await db.tenant.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
  console.log("=== Connect Tenants ===");
  for (const t of allTenants) console.log(`  id=${t.id}  name=${t.name}`);

  // ── 4. All existing TenantPbxLink rows ───────────────────────────────────
  const allLinks = await db.tenantPbxLink.findMany({
    where: { pbxInstanceId: instance.id },
    include: { tenant: { select: { name: true } } },
  });
  console.log(`\n=== TenantPbxLink rows (BEFORE) ===`);
  if (allLinks.length === 0) {
    console.log("  (none)");
  } else {
    for (const l of allLinks) {
      console.log(
        `  id=${l.id}  tenantId=${l.tenantId}  name=${l.tenant.name}  ` +
          `status=${l.status}  pbxTenantId=${l.pbxTenantId ?? "null"}  pbxTenantCode=${l.pbxTenantCode ?? "null"}`,
      );
    }
  }

  // ── 5. Current DID rows for the two phone numbers ─────────────────────────
  console.log(`\n=== PbxTenantInboundDid rows for ${VERIFY_DIDS.join(", ")} (BEFORE) ===`);
  for (const did of VERIFY_DIDS) {
    const row = await db.pbxTenantInboundDid.findUnique({
      where: { pbxInstanceId_e164: { pbxInstanceId: instance.id, e164: did } },
    });
    if (!row) {
      console.log(`  ${did}: NOT FOUND in PbxTenantInboundDid`);
    } else {
      console.log(
        `  ${did}: vitalTenantId=${row.vitalTenantId}  pbxTenantCode=${row.pbxTenantCode ?? "null"}  connectTenantId=${row.connectTenantId ?? "null"}  active=${row.active}`,
      );
    }
  }

  if (!fix) {
    console.log(`
=== DIAGNOSTIC COMPLETE (read-only) ===
No changes made. To create tenants + link + backfill, re-run with --fix:

  pnpm exec tsx scripts/fix-pbx-tenant-links.ts --fix

Or supply existing Connect tenant IDs to skip creation:

  pnpm exec tsx scripts/fix-pbx-tenant-links.ts --fix \\
    --t2=<connectTenantId-for-a_plus_center> \\
    --t8=<connectTenantId-for-gesheft>
`);
    process.exit(0);
  }

  // ── 6. Find or create Connect tenants for T2 and T8 ──────────────────────
  const pbxName2 = dir2?.displayName ?? "A Plus Center";
  const pbxName8 = dir8?.displayName ?? "Gesheft";

  let tenantT2: { id: string; name: string };
  let tenantT8: { id: string; name: string };

  if (t2Override) {
    const found = await db.tenant.findUnique({ where: { id: t2Override }, select: { id: true, name: true } });
    if (!found) { console.error(`\nERROR: --t2=${t2Override} not found.`); process.exit(1); }
    tenantT2 = found;
    console.log(`\n[T2] Using supplied tenant: id=${tenantT2.id}  name=${tenantT2.name}`);
  } else {
    const existing = await findTenantByName(pbxName2);
    if (existing) {
      tenantT2 = existing;
      console.log(`\n[T2] Found existing Connect tenant: id=${tenantT2.id}  name=${tenantT2.name}`);
    } else {
      tenantT2 = await createTenant(pbxName2);
      console.log(`\n[T2] Created new Connect tenant: id=${tenantT2.id}  name=${tenantT2.name}`);
    }
  }

  if (t8Override) {
    const found = await db.tenant.findUnique({ where: { id: t8Override }, select: { id: true, name: true } });
    if (!found) { console.error(`\nERROR: --t8=${t8Override} not found.`); process.exit(1); }
    tenantT8 = found;
    console.log(`[T8] Using supplied tenant: id=${tenantT8.id}  name=${tenantT8.name}`);
  } else {
    const existing = await findTenantByName(pbxName8);
    if (existing) {
      tenantT8 = existing;
      console.log(`[T8] Found existing Connect tenant: id=${tenantT8.id}  name=${tenantT8.name}`);
    } else {
      tenantT8 = await createTenant(pbxName8);
      console.log(`[T8] Created new Connect tenant: id=${tenantT8.id}  name=${tenantT8.name}`);
    }
  }

  console.log(`\n[FIX] Will link:`);
  console.log(`  T2 (vitalTenantId=2, code=T2) → Connect tenant id=${tenantT2.id}  name=${tenantT2.name}`);
  console.log(`  T8 (vitalTenantId=8, code=T8) → Connect tenant id=${tenantT8.id}  name=${tenantT8.name}`);

  // ── 7. Upsert TenantPbxLink for T2 and T8 ────────────────────────────────
  const linkT2 = await db.tenantPbxLink.upsert({
    where: { tenantId: tenantT2.id },
    create: {
      tenantId: tenantT2.id,
      pbxInstanceId: instance.id,
      pbxTenantId: "2",
      pbxTenantCode: "T2",
      status: "LINKED",
    },
    update: {
      pbxInstanceId: instance.id,
      pbxTenantId: "2",
      pbxTenantCode: "T2",
      status: "LINKED",
      lastError: null,
    },
  });

  const linkT8 = await db.tenantPbxLink.upsert({
    where: { tenantId: tenantT8.id },
    create: {
      tenantId: tenantT8.id,
      pbxInstanceId: instance.id,
      pbxTenantId: "8",
      pbxTenantCode: "T8",
      status: "LINKED",
    },
    update: {
      pbxInstanceId: instance.id,
      pbxTenantId: "8",
      pbxTenantCode: "T8",
      status: "LINKED",
      lastError: null,
    },
  });

  console.log(`\n[UPSERTED] TenantPbxLink T2: ${JSON.stringify({ id: linkT2.id, tenantId: linkT2.tenantId, pbxTenantId: linkT2.pbxTenantId, pbxTenantCode: linkT2.pbxTenantCode, status: linkT2.status })}`);
  console.log(`[UPSERTED] TenantPbxLink T8: ${JSON.stringify({ id: linkT8.id, tenantId: linkT8.tenantId, pbxTenantId: linkT8.pbxTenantId, pbxTenantCode: linkT8.pbxTenantCode, status: linkT8.status })}`);

  // ── 8. TenantPbxLink rows AFTER ──────────────────────────────────────────
  const allLinksAfter = await db.tenantPbxLink.findMany({
    where: { pbxInstanceId: instance.id },
    include: { tenant: { select: { name: true } } },
  });
  console.log(`\n=== TenantPbxLink rows (AFTER) ===`);
  for (const l of allLinksAfter) {
    console.log(
      `  id=${l.id}  tenantId=${l.tenantId}  name=${l.tenant.name}  ` +
        `status=${l.status}  pbxTenantId=${l.pbxTenantId ?? "null"}  pbxTenantCode=${l.pbxTenantCode ?? "null"}`,
    );
  }

  // ── 9. Re-run DID backfill (same as POST /admin/pbx/instances/:id/sync-tenant-dids) ─
  console.log(`\n[SYNC] Running syncPbxTenantInboundDids for instance ${instance.id} ...`);
  const syncResult = await syncPbxTenantInboundDids(db, instance.id);
  console.log(`[SYNC] Result: ${JSON.stringify(syncResult, null, 2)}`);

  // ── 10. Verify DID rows AFTER ────────────────────────────────────────────
  console.log(`\n=== PbxTenantInboundDid rows for ${VERIFY_DIDS.join(", ")} (AFTER) ===`);
  for (const did of VERIFY_DIDS) {
    const row = await db.pbxTenantInboundDid.findUnique({
      where: { pbxInstanceId_e164: { pbxInstanceId: instance.id, e164: did } },
    });
    if (!row) {
      console.log(`  ${did}: NOT FOUND`);
    } else {
      const expectedTenant = did === "8457823064" ? tenantT2 : tenantT8;
      const ok = row.connectTenantId === expectedTenant.id;
      console.log(
        `  ${did}: vitalTenantId=${row.vitalTenantId}  pbxTenantCode=${row.pbxTenantCode ?? "null"}  ` +
          `connectTenantId=${row.connectTenantId ?? "null"}  active=${row.active}  ` +
          (ok ? "✓ LINKED" : `✗ MISMATCH (expected ${expectedTenant.id})`),
      );
    }
  }

  // ── 11. Summary of all unlinked active DIDs (remaining work) ────────────
  const unlinkedCount = await db.pbxTenantInboundDid.count({
    where: { pbxInstanceId: instance.id, active: true, connectTenantId: null },
  });
  const totalCount = await db.pbxTenantInboundDid.count({
    where: { pbxInstanceId: instance.id, active: true },
  });
  console.log(`\n=== Summary ===`);
  console.log(`  Total active DIDs:    ${totalCount}`);
  console.log(`  Still unlinked:       ${unlinkedCount}`);
  console.log(`  Linked:               ${totalCount - unlinkedCount}`);

  if (unlinkedCount > 0) {
    const unlinkedSample = await db.pbxTenantInboundDid.findMany({
      where: { pbxInstanceId: instance.id, active: true, connectTenantId: null },
      select: { e164: true, vitalTenantId: true, pbxTenantCode: true },
      take: 10,
      orderBy: { e164: "asc" },
    });
    console.log(`  Sample unlinked DIDs (up to 10):`);
    for (const r of unlinkedSample) {
      console.log(`    ${r.e164}  vitalTenantId=${r.vitalTenantId}  pbxTenantCode=${r.pbxTenantCode ?? "null"}`);
    }
  }

  console.log(`\n=== DONE ===\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
