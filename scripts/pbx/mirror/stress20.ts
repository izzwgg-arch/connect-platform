/* MIRROR STRESS TEST 2026-08-19 round 2 (Izzy: "Create 20 tenants, each of them with 10
 * extensions, then delete any trace of them. Do all that outside the license.").
 * 20 tenants x 10 extensions, all via the mirror — the script ABORTS if any tenant comes
 * back "via panel", which is what "outside the license" means here: the panel's licensed
 * create is never consulted. Fake DIDs 8455550321-8455550340 (rows only; nothing bought,
 * nothing routed at any carrier — a REAL customer's DID on a test tenant collides with the
 * real tenant's routing). Emits a MANIFEST line per tenant for the precise teardown
 * (stress-teardown.sh guards on the mirror_stress_ slug prefix, so the naming is
 * load-bearing). Sequential on purpose (live PBX). Twin of stress10.ts (§14). */
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
  for (let i = 21; i <= 40; i++) {
    const n = String(i); // 21..40 — round 1 used 01..10, keep the ranges disjoint forever
    const slug = `mirror_stress_${n}`;
    const label = `MIRROR STRESS ${n} delete me`;
    const did = `84555503${n}`;
    const people = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((e) => ({ name: `Stress ${n} Ext ${100 + e}`, ext: String(100 + e), email: "" }));
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
