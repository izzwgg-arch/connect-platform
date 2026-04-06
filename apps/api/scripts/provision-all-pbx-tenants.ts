/**
 * For every PbxTenantDirectory row that lacks a TenantPbxLink with pbxTenantId set,
 * find-or-create a Connect tenant and upsert the link. Then backfill
 * connectTenantId on all PbxTenantInboundDid rows.
 *
 * Usage (from apps/api):
 *   # Dry-run — show what would be created, no writes:
 *   pnpm exec tsx scripts/provision-all-pbx-tenants.ts
 *
 *   # Apply:
 *   pnpm exec tsx scripts/provision-all-pbx-tenants.ts --fix
 *
 *   # Skip specific vitalTenantIds (comma-separated):
 *   pnpm exec tsx scripts/provision-all-pbx-tenants.ts --fix --skip=1,21
 *
 * Run from apps/api with same env as API (DATABASE_URL, CREDENTIALS_MASTER_KEY).
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { db } from "@connect/db";
import { syncPbxTenantInboundDids } from "../src/pbxTenantInboundDidSync";

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

function parseArgs(): { fix: boolean; skip: Set<string> } {
  const args = process.argv.slice(2);
  const fix = args.includes("--fix");
  const skipArg = args.find((a) => a.startsWith("--skip="));
  const skip = new Set<string>(
    skipArg ? skipArg.split("=")[1].split(",").map((s) => s.trim()).filter(Boolean) : []
  );
  // Always skip vitalTenantId=1 (the VitalPBX admin tenant itself — not a client)
  skip.add("1");
  return { fix, skip };
}

async function main(): Promise<void> {
  loadEnv();
  const { fix, skip } = parseArgs();

  // ── 1. Active PBX instance ────────────────────────────────────────────────
  const instance = await db.pbxInstance.findFirst({
    where: { isEnabled: true },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, baseUrl: true },
  });
  if (!instance) { console.error("No enabled PbxInstance found."); process.exit(1); }
  console.log(`\n[PBX Instance]  id=${instance.id}  name=${instance.name}\n`);

  // ── 2. All directory rows ─────────────────────────────────────────────────
  const dirRows = await db.pbxTenantDirectory.findMany({
    where: { pbxInstanceId: instance.id },
    orderBy: { vitalTenantId: "asc" },
  });

  // ── 3. Existing links (by pbxTenantId) ───────────────────────────────────
  const existingLinks = await db.tenantPbxLink.findMany({
    where: { pbxInstanceId: instance.id },
    select: { pbxTenantId: true, pbxTenantCode: true, tenantId: true, status: true },
  });
  const linkedByVitalId = new Map(
    existingLinks
      .filter((l) => l.pbxTenantId)
      .map((l) => [l.pbxTenantId!.trim(), l])
  );
  const linkedByCode = new Map(
    existingLinks
      .filter((l) => l.pbxTenantCode)
      .map((l) => [l.pbxTenantCode!.trim().toUpperCase(), l])
  );

  // ── 4. Plan ───────────────────────────────────────────────────────────────
  type Plan = {
    vitalTenantId: string;
    tenantCode: string;
    displayName: string;
    action: "already_linked" | "skip" | "find_or_create";
    existingConnectTenantId?: string;
  };

  const plan: Plan[] = [];
  for (const row of dirRows) {
    const vid = row.vitalTenantId.trim();
    const code = row.tenantCode.trim().toUpperCase();
    const name = (row.displayName || row.tenantSlug || vid).trim();

    if (skip.has(vid)) {
      plan.push({ vitalTenantId: vid, tenantCode: code, displayName: name, action: "skip" });
      continue;
    }

    const byId = linkedByVitalId.get(vid);
    const byCode = linkedByCode.get(code);
    const existing = byId ?? byCode;
    if (existing) {
      plan.push({ vitalTenantId: vid, tenantCode: code, displayName: name, action: "already_linked", existingConnectTenantId: existing.tenantId });
    } else {
      plan.push({ vitalTenantId: vid, tenantCode: code, displayName: name, action: "find_or_create" });
    }
  }

  console.log("=== Plan ===");
  for (const p of plan) {
    if (p.action === "already_linked") {
      console.log(`  ${p.tenantCode.padEnd(4)} ${p.displayName.padEnd(36)} → ALREADY LINKED (connectTenantId=${p.existingConnectTenantId})`);
    } else if (p.action === "skip") {
      console.log(`  ${p.tenantCode.padEnd(4)} ${p.displayName.padEnd(36)} → SKIP`);
    } else {
      console.log(`  ${p.tenantCode.padEnd(4)} ${p.displayName.padEnd(36)} → will find-or-create Connect tenant`);
    }
  }

  const toProvision = plan.filter((p) => p.action === "find_or_create");
  console.log(`\n${toProvision.length} PBX tenant(s) need provisioning.\n`);

  if (!fix) {
    console.log("Dry-run complete. No changes made. Re-run with --fix to apply.\n");
    process.exit(0);
  }

  if (toProvision.length === 0) {
    console.log("Nothing to do — all PBX tenants already have a linked Connect tenant.\n");
  }

  // ── 5. Find-or-create + link ──────────────────────────────────────────────
  const results: Array<{ vitalTenantId: string; tenantCode: string; displayName: string; connectTenantId: string; action: "created" | "found" }> = [];

  for (const p of toProvision) {
    // Try exact name match first
    const existing = await db.tenant.findFirst({
      where: { name: { equals: p.displayName, mode: "insensitive" } },
      select: { id: true, name: true },
    });

    let connectTenant: { id: string; name: string };
    let action: "created" | "found";

    if (existing) {
      connectTenant = existing;
      action = "found";
    } else {
      connectTenant = await db.tenant.create({
        data: {
          name: p.displayName,
          isApproved: true,
          smsSendMode: "TEST",
          smsBillingEnforced: false,
          smsSubscriptionRequired: false,
        },
        select: { id: true, name: true },
      });
      action = "created";
    }

    await db.tenantPbxLink.upsert({
      where: { tenantId: connectTenant.id },
      create: {
        tenantId: connectTenant.id,
        pbxInstanceId: instance.id,
        pbxTenantId: p.vitalTenantId,
        pbxTenantCode: p.tenantCode,
        status: "LINKED",
      },
      update: {
        pbxInstanceId: instance.id,
        pbxTenantId: p.vitalTenantId,
        pbxTenantCode: p.tenantCode,
        status: "LINKED",
        lastError: null,
      },
    });

    results.push({ vitalTenantId: p.vitalTenantId, tenantCode: p.tenantCode, displayName: p.displayName, connectTenantId: connectTenant.id, action });
    console.log(`  [${action.toUpperCase()}] ${p.tenantCode.padEnd(4)} "${p.displayName}" → connectTenantId=${connectTenant.id}`);
  }

  // ── 6. DID sync backfill ──────────────────────────────────────────────────
  console.log(`\n[SYNC] Running syncPbxTenantInboundDids ...`);
  const syncResult = await syncPbxTenantInboundDids(db, instance.id);
  console.log(`[SYNC] ${JSON.stringify(syncResult)}`);

  // ── 7. Summary ────────────────────────────────────────────────────────────
  const totalActive = await db.pbxTenantInboundDid.count({ where: { pbxInstanceId: instance.id, active: true } });
  const unlinked = await db.pbxTenantInboundDid.count({ where: { pbxInstanceId: instance.id, active: true, connectTenantId: null } });
  const linked = totalActive - unlinked;

  console.log(`\n=== Final DID state ===`);
  console.log(`  Total active DIDs:  ${totalActive}`);
  console.log(`  Linked:             ${linked}`);
  console.log(`  Still unlinked:     ${unlinked}`);

  if (unlinked > 0) {
    const remaining = await db.pbxTenantInboundDid.findMany({
      where: { pbxInstanceId: instance.id, active: true, connectTenantId: null },
      select: { e164: true, vitalTenantId: true, pbxTenantCode: true },
      orderBy: { e164: "asc" },
    });
    console.log(`  Unlinked rows (vitalTenantId not in directory or skipped):`);
    for (const r of remaining) {
      console.log(`    ${r.e164}  vitalTenantId=${r.vitalTenantId}  pbxTenantCode=${r.pbxTenantCode ?? "null"}`);
    }
  }

  console.log(`\n=== TenantPbxLink rows created/updated this run ===`);
  for (const r of results) {
    console.log(`  ${r.tenantCode.padEnd(4)} "${r.displayName}"  connectTenantId=${r.connectTenantId}  (${r.action})`);
  }

  console.log(`\n=== DONE ===\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
