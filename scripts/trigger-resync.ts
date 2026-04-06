// Trigger extension sync for all tenants to populate new WebRTC device fields
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { VitalPbxClient } from "@connect/integrations";
import { syncExtensionsFromPbx } from "./src/pbxExtensionSync";

async function main() {
  const inst = await db.pbxInstance.findFirst({ where: { isEnabled: true } });
  if (!inst) { console.log("No enabled PBX instance"); return; }
  const auth = decryptJson<{ token: string; secret?: string }>(inst.apiAuthEncrypted);
  const client = new VitalPbxClient({ baseUrl: inst.baseUrl, apiToken: auth.token, apiSecret: auth.secret });
  
  console.log("Starting sync...");
  const result = await syncExtensionsFromPbx(db, inst.id, client);
  console.log("Sync complete:");
  console.log(`  Total extensions: ${result.totalExtensions}`);
  console.log(`  Upserted: ${result.totalUpserted}`);
  console.log(`  Errors: ${result.totalErrors}`);
  
  for (const tr of result.tenantResults) {
    if (tr.skipped) continue;
    console.log(`  Tenant ${tr.vitalTenantId} (${tr.displayName}): ${tr.extensionsUpserted}/${tr.extensionsFound}`);
    if (tr.errors.length) console.log(`    ERRORS: ${tr.errors.join("; ")}`);
  }
  
  // Verify ext 103 in A plus center
  console.log("\n=== Verification: ext 103 (A plus center) ===");
  const link = await db.pbxExtensionLink.findFirst({
    where: { extension: { extNumber: "103", tenant: { name: { contains: "plus" } } } },
    include: { extension: { select: { extNumber: true, tenantId: true } } },
  });
  if (link) {
    console.log(`pbxSipUsername: ${link.pbxSipUsername}`);
    console.log(`pbxDeviceName:  ${(link as any).pbxDeviceName}`);
    console.log(`webrtcEnabled:  ${(link as any).webrtcEnabled}`);
    console.log(`pbxDeviceId:    ${link.pbxDeviceId}`);
    console.log(`hasPass:        ${!!link.sipPasswordEncrypted}`);
  } else {
    console.log("Not found");
  }
}

main().catch(console.error).finally(() => db.$disconnect());
