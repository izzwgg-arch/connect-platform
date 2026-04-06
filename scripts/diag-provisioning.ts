import { db } from "@connect/db";

async function main() {
  const user = await db.user.findUnique({
    where: { email: "jacobw@apluscenterinc.org" },
    include: {
      tenant: {
        include: {
          pbxTenantLink: true,
        }
      }
    }
  });
  if (!user) { console.log("User not found"); return; }

  console.log("=== User ===");
  console.log("id:", user.id);
  console.log("email:", user.email);
  console.log("role:", user.role);
  console.log("tenantId:", user.tenantId);

  console.log("\n=== Tenant ===");
  const t = user.tenant;
  console.log("name:", t.name);
  console.log("webrtcEnabled:", (t as any).webrtcEnabled);
  console.log("sipDomain:", (t as any).sipDomain);
  console.log("sipWsUrl:", (t as any).sipWsUrl);
  console.log("turnEnabled:", (t as any).turnEnabled);
  console.log("pbxTenantLink:", t.pbxTenantLink ? {
    pbxDomain: t.pbxTenantLink.pbxDomain,
    pbxWsUrl: t.pbxTenantLink.pbxWsUrl,
    webrtcEnabled: (t.pbxTenantLink as any).webrtcEnabled,
    sipDomain: (t.pbxTenantLink as any).sipDomain,
  } : "NONE");
  console.log("ALL tenant fields:", Object.keys(t).join(", "));

  console.log("\n=== Assigned Extension ===");
  const ext = await db.extension.findFirst({
    where: { ownerUserId: user.id },
    include: {
      pbxLink: true
    }
  });
  if (!ext) { console.log("No extension assigned to this user"); return; }
  console.log("extNumber:", ext.extNumber);
  console.log("displayName:", ext.displayName);
  console.log("pbxLink.pbxSipUsername:", ext.pbxLink?.pbxSipUsername);
  console.log("pbxLink.pbxDeviceName:", (ext.pbxLink as any)?.pbxDeviceName);
  console.log("pbxLink.webrtcEnabled:", (ext.pbxLink as any)?.webrtcEnabled);
  console.log("pbxLink.hasSipPass:", !!(ext.pbxLink as any)?.sipPasswordEncrypted);
  console.log("pbxLink.pbxDeviceId:", ext.pbxLink?.pbxDeviceId);
}
main().catch(console.error).finally(() => db.$disconnect());
