// Probe: get WebRTC profile IDs and full device field values for ext 103
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { VitalPbxClient } from "@connect/integrations";

async function main() {
  const inst = await db.pbxInstance.findFirst({ where: { isEnabled: true } });
  if (!inst) { return; }
  const auth = decryptJson<{ token: string; secret?: string }>(inst.apiAuthEncrypted);
  const client = new VitalPbxClient({ baseUrl: inst.baseUrl, apiToken: auth.token, apiSecret: auth.secret });

  // 1. Get WebRTC device profiles
  console.log("=== WebRTC Device Profiles ===");
  try {
    const profiles = await (client as any).callEndpoint("deviceProfiles.webrtc", { tenant: "2" });
    const rows = Array.isArray(profiles.data) ? profiles.data : (profiles.data?.result ?? []);
    for (const p of rows.slice(0, 10)) {
      console.log(`  profile_id: ${p.profile_id ?? p.id} | name: ${p.name ?? p.profile_name} | ALL: ${Object.keys(p).join(", ")}`);
    }
  } catch(e: any) { console.log("  WebRTC profiles error:", e.message); }

  // Also try regular device profiles
  console.log("\n=== All Device Profiles (tenant 2) ===");
  try {
    const profiles = await (client as any).callEndpoint("deviceProfiles.list", { tenant: "2" });
    const rows = Array.isArray(profiles.data) ? profiles.data : (profiles.data?.result ?? []);
    for (const p of rows.slice(0, 20)) {
      console.log(`  id: ${p.profile_id ?? p.id} | name: ${p.name ?? p.profile_name}`);
    }
  } catch(e: any) { console.log("  Device profiles error:", e.message); }

  // 2. Show full device field values for ext 103
  console.log("\n=== Full device values for extension 103 (tenant 2) ===");
  const exts = await client.listExtensions("2");
  const ext103 = exts.find((e: any) => String(e.extension ?? "") === "103");
  if (ext103 && Array.isArray(ext103.devices)) {
    for (const dev of ext103.devices) {
      console.log(JSON.stringify(dev, null, 2));
      console.log("---");
    }
  }
}

main().catch(console.error).finally(() => db.$disconnect());
