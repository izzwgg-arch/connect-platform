import { db } from "@connect/db";

async function main() {
  // Check PBX instance config for SIP domain / WS URL
  const inst = await db.pbxInstance.findFirst({ where: { isEnabled: true } });
  console.log("=== PBX Instance ===");
  console.log("baseUrl:", inst?.baseUrl);
  console.log("ALL fields:", inst ? Object.keys(inst).join(", ") : "none");

  // Check TenantPbxLink for A plus center
  const link = await db.tenantPbxLink.findFirst({
    where: { tenant: { name: { contains: "plus" } } },
    include: { tenant: { select: { name: true, sipDomain: true, sipWsUrl: true, webrtcEnabled: true } } }
  });
  console.log("\n=== TenantPbxLink for A plus center ===");
  console.log(JSON.stringify(link, null, 2));

  // Check any tenant that HAS webrtcEnabled=true to see what sipDomain/sipWsUrl looks like
  const webrtcTenant = await db.tenant.findFirst({
    where: { webrtcEnabled: true, sipDomain: { not: null } }
  });
  console.log("\n=== Example tenant with WebRTC enabled ===");
  if (webrtcTenant) {
    console.log("name:", webrtcTenant.name);
    console.log("sipDomain:", webrtcTenant.sipDomain);
    console.log("sipWsUrl:", webrtcTenant.sipWsUrl);
    console.log("webrtcRouteViaSbc:", webrtcTenant.webrtcRouteViaSbc);
    console.log("outboundProxy:", webrtcTenant.outboundProxy);
  } else {
    console.log("None found");
  }

  // Show all real PBX tenants and their webrtc state
  const allPbxLinks = await db.tenantPbxLink.findMany({
    include: { tenant: { select: { name: true, webrtcEnabled: true, sipDomain: true, sipWsUrl: true } } },
    orderBy: { tenant: { name: "asc" } }
  });
  console.log("\n=== All PBX-linked tenants webrtc config ===");
  for (const l of allPbxLinks) {
    console.log(`${l.tenant.name}: webrtcEnabled=${l.tenant.webrtcEnabled} sipDomain=${l.tenant.sipDomain} sipWsUrl=${l.tenant.sipWsUrl}`);
  }
}
main().catch(console.error).finally(() => db.$disconnect());
