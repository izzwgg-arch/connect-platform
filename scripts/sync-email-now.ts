// Run with: cd /app/apps/api && npx tsx sync-email-now.ts
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { syncExtensionsFromPbx } from "./src/pbxExtensionSync";
import { VitalPbxClient } from "@connect/integrations";

async function main() {
  const inst = await db.pbxInstance.findFirst({ where: { isEnabled: true } });
  if (!inst) { console.log("No enabled PBX instance"); return; }
  console.log("PBX:", inst.baseUrl);

  const auth = decryptJson<{ token: string; secret?: string }>(inst.apiAuthEncrypted);
  const client = new VitalPbxClient({ baseUrl: inst.baseUrl, apiToken: auth.token, apiSecret: auth.secret });

  console.log("Running full extension sync (with email + SIP password capture)...");
  const result = await syncExtensionsFromPbx(db, inst.id, client);
  console.log("Sync complete:", JSON.stringify({ total: result.totalExtensions, upserted: result.totalUpserted, errors: result.totalErrors }));

  // Check results
  const withEmail = await db.extension.count({ where: { pbxUserEmail: { not: null } } });
  const withSipPass = await db.pbxExtensionLink.count({ where: { sipPasswordEncrypted: { not: null } } });
  const totalExts = await db.extension.count();
  const totalLinks = await db.pbxExtensionLink.count();
  console.log(`Extensions with email: ${withEmail} / ${totalExts}`);
  console.log(`PbxExtensionLinks with SIP password: ${withSipPass} / ${totalLinks}`);
}

main().catch(console.error).finally(() => db.$disconnect());
