/**
 * Set Ombutel MySQL URL (encrypted), run inbound DID sync, print summary.
 *
 * Env:
 *   OMBU_MYSQL_URL       — full mysql:// URL (required)
 *   DATABASE_URL         — Postgres (required)
 *   CREDENTIALS_MASTER_KEY — 64-char hex (required)
 *
 * Usage (from apps/api):
 *   pnpm exec tsx scripts/set-ombu-mysql-and-sync-dids.ts
 */
import { db } from "@connect/db";
import { VitalPbxClient } from "@connect/integrations";
import { decryptJson, encryptJson } from "@connect/security";
import { syncPbxTenantDirectoryFromRows } from "../src/pbxTenantDirectorySync";
import { syncPbxTenantInboundDids } from "../src/pbxTenantInboundDidSync";

async function main(): Promise<void> {
  const mysqlUrl = process.env.OMBU_MYSQL_URL?.trim();
  if (!mysqlUrl) {
    throw new Error("OMBU_MYSQL_URL is required");
  }

  const instance = await db.pbxInstance.findFirst({
    where: { isEnabled: true },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, baseUrl: true, apiAuthEncrypted: true },
  });
  if (!instance) {
    throw new Error("No enabled PbxInstance found");
  }

  const encrypted = encryptJson({ mysqlUrl });
  await db.pbxInstance.update({
    where: { id: instance.id },
    data: { ombuMysqlUrlEncrypted: encrypted },
  });
  console.log("Updated ombuMysqlUrlEncrypted for instance:", instance.id, instance.name);

  const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
  const client = new VitalPbxClient({
    baseUrl: instance.baseUrl,
    apiToken: auth.token,
    apiSecret: auth.secret,
    timeoutMs: Number(process.env.PBX_TIMEOUT_MS || 30000),
    simulate: (process.env.PBX_SIMULATE || "false").toLowerCase() === "true",
  });
  const tenants = await client.listTenants();
  const { upserted: directoryUpserted } = await syncPbxTenantDirectoryFromRows(db, instance.id, tenants);
  console.log("directoryUpserted (same as GET /admin/pbx/tenants):", directoryUpserted);

  const inboundDidSync = await syncPbxTenantInboundDids(db, instance.id);
  console.log("inboundDidSync:", JSON.stringify(inboundDidSync, null, 2));

  const totalActive = await db.pbxTenantInboundDid.count({
    where: { pbxInstanceId: instance.id, active: true },
  });

  const dirRows = await db.pbxTenantDirectory.findMany({
    where: { pbxInstanceId: instance.id },
    select: { vitalTenantId: true, displayName: true, tenantSlug: true },
  });
  const tenantNameByVital = new Map(
    dirRows.map((r) => [r.vitalTenantId.trim(), (r.displayName || r.tenantSlug || "").trim() || null]),
  );

  const samples = await db.pbxTenantInboundDid.findMany({
    where: { pbxInstanceId: instance.id, active: true },
    take: 8,
    orderBy: { e164: "asc" },
    select: {
      e164: true,
      vitalTenantId: true,
      pbxTenantCode: true,
      rawNumber: true,
    },
  });

  console.log("\n--- total active DIDs ---\n", totalActive);
  console.log("\n--- sample rows (did, tenant_id, tenant_name) ---");
  for (const r of samples) {
    const name = tenantNameByVital.get(r.vitalTenantId.trim()) ?? "(no directory row)";
    console.log({
      did: r.e164,
      tenant_id: r.vitalTenantId,
      tenant_name: name,
      pbxTenantCode: r.pbxTenantCode,
    });
  }

  const verifyDigits = ["8457823064", "8452449666"];
  console.log("\n--- mapping check ---");
  for (const d of verifyDigits) {
    const row = await db.pbxTenantInboundDid.findUnique({
      where: { pbxInstanceId_e164: { pbxInstanceId: instance.id, e164: d } },
      select: { e164: true, vitalTenantId: true, pbxTenantCode: true },
    });
    const code = row?.pbxTenantCode?.toUpperCase() ?? null;
    const expected = d === "8457823064" ? "T2" : d === "8452449666" ? "T8" : "?";
    const ok = code === expected;
    console.log(d, "→", code, ok ? "OK" : `expected ${expected}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
