/* MIRROR STRESS TEST 2026-08-19: 10 tenants x 5 extensions, all via the mirror (no licence path).
 * Fake DIDs 8455550201-210 (rows only; nothing bought, nothing routed at any carrier).
 * Emits a MANIFEST line per tenant for the precise teardown. Sequential on purpose (live PBX). */
import { PanelSession, loadPanelConfig } from "./src/onboarding/panelClient";
import { buildPbxTenant } from "./src/onboarding/pbxTenantBuild";
import { resolveMirrorTenantCreator, resolveMirrorTenantRenderer } from "./src/onboarding/setupOrchestrator";
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { VitalPbxClient } from "@connect/integrations";

async function main() {
  const cfg = loadPanelConfig(); if (!cfg) throw new Error("no cfg");
  const inst = await (db as any).pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
  const iid = String(inst.id);
  const auth = decryptJson<{ token: string; secret?: string }>(inst.apiAuthEncrypted);
  const resolveTenantPath = async (slug: string, label: string) => {
    try {
      const c = new VitalPbxClient({ baseUrl: inst.baseUrl, apiToken: auth.token, apiSecret: auth.secret, timeoutMs: 20000 } as any);
      const l: any[] = await c.listTenants();
      const h = l.find((t: any) => String(t.name) === slug || String(t.description) === label);
      return h?.path ? String(h.path) : null;
    } catch { return null; }
  };
  const creator = resolveMirrorTenantCreator(iid);
  const renderer = resolveMirrorTenantRenderer(iid);
  if (!creator || !renderer) throw new Error("mirror creator/renderer not configured — aborting (would use panel form)");
  const results: any[] = [];
  for (let i = 1; i <= 10; i++) {
    const n = String(i).padStart(2, "0");
    const slug = `mirror_stress_${n}`;
    const label = `MIRROR STRESS ${n} delete me`;
    const did = `84555502${n}`;
    const people = [1, 2, 3, 4, 5].map((e) => ({ name: `Stress ${n} Ext ${100 + e}`, ext: String(100 + e), email: "" }));
    const s = await new PanelSession(cfg.baseUrl, cfg.accounts[0]).login();
    const t0 = Date.now();
    let createdVia = "";
    try {
      const r = await buildPbxTenant(s, cfg.mainTenant, {
        company: `MIRROR STRESS ${n}`, slug, label,
        voipms: { user: `344022_ms${n}`, pass: "not-real", server: "mirror-test.invalid" }, did,
        people,
      } as any, (m) => { if (/via (mirror|panel)/.test(m)) createdVia = m.includes("via mirror") ? "mirror" : "panel"; console.log(`  [${slug}]`, m); }, resolveTenantPath,
        { tenantCreator: creator, tenantRenderer: renderer });
      const secs = Math.round((Date.now() - t0) / 1000);
      results.push({ ...r, did, secs, createdVia });
      console.log(`MANIFEST ${JSON.stringify({ slug, label, did, tenantPath: r.tenantPath, trunkId: r.trunkId, routeId: r.routeId, arsId: r.arsId, secs, createdVia })}`);
      if (createdVia !== "mirror") { console.error(`ABORT: tenant ${slug} was created via ${createdVia || "unknown"}, not the mirror`); process.exit(2); }
    } catch (e: any) {
      console.error(`BUILD ${slug} FAILED: ${e?.message || e}`);
      console.log(`MANIFEST ${JSON.stringify({ slug, label, did, failed: true })}`);
      process.exit(3);
    }
  }
  console.log("ALL DONE", JSON.stringify(results.map((r) => ({ slug: r.slug, path: r.tenantPath, secs: r.secs }))));
}
main().catch((e) => { console.error("FATAL", e?.message || e); process.exit(1); });
