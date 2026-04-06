// Probe: does GET /api/v2/extensions/:id return the SIP password and email_addresses?
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { VitalPbxClient } from "@connect/integrations";

async function main() {
  const inst = await db.pbxInstance.findFirst({ where: { isEnabled: true } });
  if (!inst) { console.log("No enabled PBX instance"); return; }
  const auth = decryptJson<{ token: string; secret?: string }>(inst.apiAuthEncrypted);
  const client = new VitalPbxClient({ baseUrl: inst.baseUrl, apiToken: auth.token, apiSecret: auth.secret });

  // Find a tenant that has extensions
  const tds = await db.pbxTenantDirectory.findMany({ where: { pbxInstanceId: inst.id } });
  for (const td of tds) {
    let exts: any[] = [];
    try { exts = await client.listExtensions(td.vitalTenantId); } catch { continue; }
    if (!exts.length) continue;
    
    console.log(`\nTenant: ${td.vitalTenantId} (${td.displayName}) — ${exts.length} extensions`);
    console.log("First extension ALL fields:", Object.keys(exts[0]).join(", "));
    const first = exts[0];
    console.log("email:", first.email ?? "(none)");
    console.log("email_addresses:", first.email_addresses ?? "(none)");
    console.log("emailAddresses:", first.emailAddresses ?? "(none)");
    console.log("voicemail_email:", first.voicemail_email ?? "(none)");
    
    // Now get a single extension with getExtension to see if it returns more fields
    if (first.extension_id || first.id) {
      const extId = first.extension_id ?? first.id;
      try {
        const detail = await client.getExtension(String(extId), td.vitalTenantId);
        console.log("\ngetExtension detail ALL fields:", Object.keys(detail).join(", "));
        console.log("email:", detail.email ?? "(none)");
        console.log("email_addresses:", detail.email_addresses ?? "(none)");
        console.log("password field:", detail.password ?? detail.sip_password ?? detail.secret ?? detail.auth_password ?? "(NONE — not in response)");
        // Check for devices sub-objects which might contain password
        if (detail.devices) console.log("devices:", JSON.stringify(detail.devices).slice(0, 200));
      } catch(e: any) {
        console.log("getExtension error:", e.message);
      }
    }
    break; // Only need first tenant with extensions
  }
}

main().catch(console.error).finally(() => db.$disconnect());
