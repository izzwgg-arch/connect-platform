import { db } from "@connect/db";
import { decryptJson } from "@connect/security";

async function main() {
  const user = await db.user.findUnique({
    where: { email: "jacobw@apluscenterinc.org" },
    include: { tenant: { include: { pbxTenantLink: true } } }
  });
  if (!user) { console.log("User not found"); return; }

  const tenant = user.tenant;
  const link = tenant.pbxTenantLink;

  console.log("=== Provisioning bundle for jacobw@apluscenterinc.org ===");
  console.log("Tenant: webrtcEnabled =", tenant.webrtcEnabled);
  console.log("        sipDomain     =", tenant.sipDomain);
  console.log("        sipWsUrl      =", tenant.sipWsUrl);
  console.log("PBX Link:", link ? "found" : "MISSING");

  const extLink = await db.pbxExtensionLink.findFirst({
    where: { tenantId: user.tenantId, extension: { ownerUserId: user.id } },
    include: { extension: true }
  });

  if (!extLink) { console.log("\nNo extension assigned!"); return; }

  const hasSipPass = !!(extLink as any).sipPasswordEncrypted;
  let decryptedPass = "(decrypt failed)";
  if (hasSipPass) {
    try {
      decryptedPass = decryptJson<string>((extLink as any).sipPasswordEncrypted);
    } catch (e: any) {
      decryptedPass = "(error: " + e.message + ")";
    }
  }

  console.log("\n=== Extension ===");
  console.log("extNumber:      ", extLink.extension.extNumber);
  console.log("displayName:    ", extLink.extension.displayName);
  console.log("sipUsername:    ", extLink.pbxSipUsername, "  ← used for SIP REGISTER");
  console.log("pbxDeviceName:  ", (extLink as any).pbxDeviceName);
  console.log("webrtcEnabled:  ", (extLink as any).webrtcEnabled, "  ← WebRTC device exists on PBX");
  console.log("pbxDeviceId:    ", extLink.pbxDeviceId);
  console.log("hasSipPass:     ", hasSipPass);
  console.log("sipPassword:    ", hasSipPass ? decryptedPass.substring(0, 5) + "***" : "NOT SET");

  console.log("\n=== Softphone will use ===");
  console.log("sipUsername:", extLink.pbxSipUsername);
  console.log("sipDomain:  ", tenant.sipDomain);
  console.log("sipWsUrl:   ", tenant.sipWsUrl);
  console.log("webrtcEnabled:", tenant.webrtcEnabled);
  console.log("\nREGISTER sip:", extLink.pbxSipUsername + "@" + tenant.sipDomain);
  console.log("via WS:     ", tenant.sipWsUrl);
  console.log("\nAll checks pass:", tenant.webrtcEnabled && !!tenant.sipDomain && !!tenant.sipWsUrl && hasSipPass ? "✓ READY" : "✗ INCOMPLETE");
}
main().catch(console.error).finally(() => db.$disconnect());
