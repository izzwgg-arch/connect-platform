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
import { openReadConn } from "./src/pbxConsole/pbxConsoleReaders";
import { db } from "@connect/db";

async function main() {
  const cfg = loadPanelConfig(); if (!cfg) throw new Error("no cfg");
  const inst = await (db as any).pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
  const iid = String(inst.id);
  // ⛔ Resolve tenant paths from the DATABASE, never REST listTenants: the REST
  // tenants list is CAPPED (31 rows on prod, 2026-08-19 — likely licence-tied),
  // so any tenant past the cap is invisible to it. stress10 used REST here and
  // got away with it only because nothing ever needed to resume; the resumed
  // 20x10 run failed at tenant 28 exactly because the resolver could not see
  // rows past the cap and buildPbxTenant then tried to create a duplicate.
  const resolveTenantPath = async (slug: string, label: string) => {
    try {
      const c = await openReadConn(inst.ombuMysqlUrlEncrypted);
      if (!c.ok) return null;
      try {
        const [rows]: any = await (c.conn as any).query(
          "SELECT path FROM ombutel.ombu_tenants WHERE name = ? OR description = ? LIMIT 1", [slug, label]);
        return rows?.[0]?.path ? String(rows[0].path) : null;
      } finally { await (c.conn as any).end().catch(() => {}); }
    } catch { return null; }
  };
  const creator = resolveMirrorTenantCreator(iid);
  const renderer = resolveMirrorTenantRenderer(iid);
  if (!creator || !renderer) throw new Error("mirror creator/renderer not configured — aborting (would use panel form)");
  const results: any[] = [];
  // STRESS_START resumes an interrupted run — every build step adopts what an
  // earlier pass already created (trunk/route/ARS/tenant by unique label,
  // extensions by number, inbound route by DID), so re-walking a half-built
  // tenant is safe. Needed for real on 2026-08-19: an auto-deploy recreated
  // app-api-1 mid-run and killed the in-container exec at tenant 28.
  const START = Math.max(21, parseInt(process.env.STRESS_START || "21", 10) || 21);
  for (let i = START; i <= 40; i++) {
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
