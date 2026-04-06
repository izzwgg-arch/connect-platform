// Verify the stored SIP credentials exactly match what VitalPBX has for device T2_103_1
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { VitalPbxClient } from "@connect/integrations";

async function main() {
  const inst = await db.pbxInstance.findFirst({ where: { isEnabled: true } });
  if (!inst) return;
  const auth = decryptJson<{ token: string; secret?: string }>(inst.apiAuthEncrypted);
  const client = new VitalPbxClient({ baseUrl: inst.baseUrl, apiToken: auth.token, apiSecret: auth.secret });

  // Get what's stored in Connect DB
  const extLink = await db.pbxExtensionLink.findFirst({
    where: { extension: { extNumber: "103", tenantId: "cmnlgnumi0000p9g6l7t1t0z7" } },
    include: { extension: true }
  });
  if (!extLink) { console.log("No link found"); return; }

  const storedPass = (extLink as any).sipPasswordEncrypted
    ? decryptJson<string>((extLink as any).sipPasswordEncrypted)
    : null;

  console.log("=== Stored in Connect DB ===");
  console.log("pbxSipUsername:", extLink.pbxSipUsername);
  console.log("pbxDeviceName: ", (extLink as any).pbxDeviceName);
  console.log("pbxDeviceId:   ", extLink.pbxDeviceId);
  console.log("storedPassword:", storedPass ? storedPass.substring(0, 6) + "..." : "NOT SET");

  // Re-fetch from VitalPBX
  const exts = await client.listExtensions("2");
  const ext103 = exts.find((e: any) => String(e.extension) === "103");
  if (!ext103) { console.log("Ext 103 not found in VitalPBX"); return; }

  const dev173 = ext103.devices?.find((d: any) => d.device_id === 173);
  if (!dev173) { console.log("Device 173 not found"); return; }

  console.log("\n=== Current VitalPBX values for device 173 (T2_103_1) ===");
  console.log("device_id:  ", dev173.device_id);
  console.log("user:       ", dev173.user, "  ← SIP auth username");
  console.log("device_name:", dev173.device_name);
  console.log("profile_id: ", dev173.profile_id);
  console.log("secret:     ", dev173.secret ? dev173.secret.substring(0, 6) + "..." : "empty");

  console.log("\n=== Match? ===");
  const passMatch = storedPass === dev173.secret;
  const userMatch = extLink.pbxSipUsername === dev173.user;
  console.log("password match:", passMatch ? "✓" : `✗ MISMATCH (stored: ${storedPass?.substring(0,6)}... vs pbx: ${dev173.secret?.substring(0,6)}...)`);
  console.log("sip username match:", userMatch ? "✓" : `✗ MISMATCH (stored: ${extLink.pbxSipUsername} vs pbx: ${dev173.user})`);

  // Also check: what does JsSIP send as authorization_user?
  // JsSIP uses the URI username by default: sip:103_1@domain → auth user = 103_1
  console.log("\n=== JsSIP will REGISTER as ===");
  console.log("uri:               sip:103_1@m.connectcomunications.com");
  console.log("authorization_user: 103_1  (extracted from URI, no override set)");
  console.log("password:          ", storedPass ? storedPass.substring(0,6) + "..." : "NOT SET");
}
main().catch(console.error).finally(() => db.$disconnect());
