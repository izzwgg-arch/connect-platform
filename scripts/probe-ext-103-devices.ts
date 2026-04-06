// Probe: get the exact device.user and WebRTC profile for extension 103
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { VitalPbxClient } from "@connect/integrations";

async function main() {
  const inst = await db.pbxInstance.findFirst({ where: { isEnabled: true } });
  if (!inst) { console.log("No enabled PBX instance"); return; }
  const auth = decryptJson<{ token: string; secret?: string }>(inst.apiAuthEncrypted);
  const client = new VitalPbxClient({ baseUrl: inst.baseUrl, apiToken: auth.token, apiSecret: auth.secret });

  const tds = await db.pbxTenantDirectory.findMany({ where: { pbxInstanceId: inst.id } });
  let found = false;
  for (const td of tds) {
    let exts: any[] = [];
    try { exts = await client.listExtensions(td.vitalTenantId); } catch { continue; }
    
    const ext103 = exts.find((e: any) => String(e.extension ?? e.user ?? "") === "103");
    if (!ext103) continue;

    found = true;
    console.log(`\n=== Extension 103 in tenant ${td.vitalTenantId} (${td.displayName}) ===`);
    console.log("extension_id:", ext103.extension_id);
    console.log("extension:", ext103.extension);
    console.log("name:", ext103.name);
    console.log("email:", ext103.email);
    console.log("ALL fields:", Object.keys(ext103).join(", "));
    
    if (Array.isArray(ext103.devices)) {
      console.log(`\nDevices (${ext103.devices.length}):`);
      for (const dev of ext103.devices) {
        console.log("  device_id:", dev.device_id);
        console.log("  user (SIP username):", dev.user);
        console.log("  profile_id:", dev.profile_id);
        console.log("  description:", dev.description);
        console.log("  webrtc_client:", dev.webrtc_client);
        console.log("  ALL device fields:", Object.keys(dev).join(", "));
        console.log("  ---");
      }
    } else {
      console.log("No devices array");
    }
    break; // stop after first match
  }

  if (!found) {
    // Also check what pbxSipUsername is currently stored in DB for ext 103
    console.log("\n=== What's currently stored in DB for ext 103 ===");
    const links = await db.pbxExtensionLink.findMany({
      where: { extension: { extNumber: "103" } },
      include: { extension: { select: { extNumber: true, tenantId: true } } },
      take: 5,
    });
    for (const link of links) {
      console.log(`ext ${link.extension.extNumber} | pbxSipUsername: ${link.pbxSipUsername} | pbxExtensionId: ${link.pbxExtensionId}`);
    }
  }

  // Always show what's in the DB
  console.log("\n=== DB: all ext 103 PbxExtensionLinks ===");
  const dbLinks = await db.pbxExtensionLink.findMany({
    where: { extension: { extNumber: "103" } },
    include: { extension: { select: { extNumber: true, tenantId: true } } },
    take: 10,
  });
  for (const link of dbLinks) {
    console.log(`tenantId: ${link.extension.tenantId} | pbxSipUsername: ${link.pbxSipUsername} | pbxExtensionId: ${link.pbxExtensionId} | hasPass: ${!!link.sipPasswordEncrypted}`);
  }
}

main().catch(console.error).finally(() => db.$disconnect());
