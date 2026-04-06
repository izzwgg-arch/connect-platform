// Enable WebRTC for all real PBX business tenants using the known-good PBX connection values.
// Safe to run multiple times (idempotent — only updates tenants that need it).
import { db } from "@connect/db";

const SIP_DOMAIN = "m.connectcomunications.com";
const SIP_WS_URL = "wss://209.145.60.79:8089/ws";

async function main() {
  // Get all tenants linked to the PBX (via pbxTenantDirectory — these are real business tenants)
  const pbxTenantDirs = await db.pbxTenantDirectory.findMany({
    include: {
      pbxInstance: { select: { id: true, baseUrl: true } }
    }
  });

  // Map vitalTenantId → Connect tenantId via TenantPbxLink
  const pbxLinks = await db.tenantPbxLink.findMany({
    where: { pbxInstanceId: pbxTenantDirs[0]?.pbxInstanceId }
  });
  const connectTenantIds = new Set(pbxLinks.map(l => l.tenantId));

  console.log(`Found ${connectTenantIds.size} PBX-linked tenants`);

  let updated = 0;
  let alreadyOk = 0;

  for (const tenantId of connectTenantIds) {
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, webrtcEnabled: true, sipDomain: true, sipWsUrl: true }
    });
    if (!tenant) continue;

    if (tenant.webrtcEnabled && tenant.sipDomain && tenant.sipWsUrl) {
      alreadyOk++;
      console.log(`  SKIP (already configured): ${tenant.name}`);
      continue;
    }

    await db.tenant.update({
      where: { id: tenantId },
      data: {
        webrtcEnabled: true,
        sipDomain: SIP_DOMAIN,
        sipWsUrl: SIP_WS_URL,
      }
    });
    updated++;
    console.log(`  ENABLED: ${tenant.name}`);
  }

  console.log(`\nDone. Updated: ${updated}, Already configured: ${alreadyOk}`);

  // Verify A plus center
  const aplus = await db.tenant.findFirst({ where: { name: { contains: "plus" } } });
  console.log("\nA plus center after update:");
  console.log("  webrtcEnabled:", aplus?.webrtcEnabled);
  console.log("  sipDomain:", aplus?.sipDomain);
  console.log("  sipWsUrl:", aplus?.sipWsUrl);
}
main().catch(console.error).finally(() => db.$disconnect());
