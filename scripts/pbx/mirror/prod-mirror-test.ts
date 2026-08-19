/* PRODUCTION acceptance for the mirror: one throwaway tenant through the REAL build path.
 * Runs INSIDE app-api-1 (docker cp → /app/apps/api/prod-mirror-test.ts → npx tsx).
 * Safety: trunk host mirror-test.invalid (never registers anywhere), fake 845-555 DID (PBX rows only).
 * Cleanup afterwards: prod-mirror-cleanup (same folder).
 */
import { PanelSession, loadPanelConfig } from "./src/onboarding/panelClient";
import { buildPbxTenant } from "./src/onboarding/pbxTenantBuild";
import { resolveMirrorTenantCreator } from "./src/onboarding/setupOrchestrator";
import { resolvePbxRouteHelperConfig } from "./src/pbxInboundRouteHelperClient";
import { VitalPbxClient } from "@connect/integrations";
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";

async function main() {
  const panelCfg = loadPanelConfig();
  if (!panelCfg) throw new Error("no panel config in env");
  const helper = resolvePbxRouteHelperConfig(null);
  console.log("helper configured:", !!helper, helper?.baseUrl);
  const instance = await (db as any).pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
  const creator = resolveMirrorTenantCreator(instance ? String(instance.id) : null);
  console.log("mirror creator:", creator ? "YES" : "NO (would use panel form)");
  const s = await new PanelSession(panelCfg.baseUrl, panelCfg.accounts[0]).login();
  const suffix = process.env.MT_SUFFIX || "0819";
  const label = `MIRROR TEST delete me ${suffix}`;
  const slug = `mirror_test_deleteme_${suffix}`;
  const resolveTenantPath = async (slugArg: string, labelArg: string) => {
    try {
      const instance = await (db as any).pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
      const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
      const client = new VitalPbxClient({ baseUrl: instance.baseUrl, apiToken: auth.token, apiSecret: auth.secret, timeoutMs: 20000 } as any);
      const list: any[] = await client.listTenants();
      const hit = list.find((t: any) => String(t.name || "") === slugArg || String(t.description || "") === labelArg);
      return hit?.path ? String(hit.path) : null;
    } catch (e: any) { console.log("  [resolver] error", e?.message); return null; }
  };
  const t0 = Date.now();
  const r = await buildPbxTenant(s, panelCfg.mainTenant, {
    company: "MIRROR TEST delete me", slug, label,
    voipms: { user: `344022_mirrortest${suffix}`, pass: "not-a-real-password", server: "mirror-test.invalid" },
    did: "8455550" + String(100 + Number(suffix.replace(/\D/g, "").slice(-2) || 19)).slice(-3),
    people: [{ name: "Mirror Test", ext: "101", email: "" }],
  } as any, (m) => console.log("  [log]", m), resolveTenantPath, { tenantCreator: creator });
  console.log("RESULT:", JSON.stringify(r), "in", Math.round((Date.now() - t0) / 1000), "s");
}
main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
