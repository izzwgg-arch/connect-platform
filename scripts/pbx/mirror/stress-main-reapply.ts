/* STRESS TEARDOWN, final step — ONE Apply in Main + platform-wide doorway re-bake.
 *
 * ⛔ WHY THIS EXISTS (§14, proven twice): a direct DB delete is NOT a "pending
 * change" — after deleting the stress tenants' Main-tenant trunk/route/ARS rows
 * by SQL, Main's RENDERED files still carry every fake trunk and stale ARS-*
 * context, and a plain Apply regenerates NOTHING. The PBX-side teardown wrapper
 * must first queue the modules the way the panel would have
 * (`insert ombu_queued_changes (1,26),(1,99),(1,42),(1,43),(1,110)` +
 * `tenant_settings reload_dialplan='yes'`), and THEN this runs ONE Apply in the
 * Main context through the console's own applyAndRebake — which re-bakes the
 * Connect doorway on every connect-routed number afterwards, because Apply is
 * whole-PBX and flushes other tenants' pending changes too.
 * Run inside app-api-1: `docker exec -w /app/apps/api app-api-1 npx tsx stress-main-reapply.ts` */
import { PanelSession, loadPanelConfig } from "./src/onboarding/panelClient";
import { applyAndRebake } from "./src/pbxConsole/pbxConsoleWrites";
import { db } from "@connect/db";

async function main() {
  const cfg = loadPanelConfig(); if (!cfg) throw new Error("no panel cfg");
  const inst = await (db as any).pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
  const log = {
    info: (o: any, m: string) => console.log(m, JSON.stringify(o)),
    warn: (o: any, m: string) => console.warn(m, JSON.stringify(o)),
    error: (o: any, m: string) => console.error(m, JSON.stringify(o)),
  };
  const s = await new PanelSession(cfg.baseUrl, cfg.accounts[0]).login();
  const r = await applyAndRebake(s, cfg.mainTenant, { db, log, pbxInstanceId: inst ? String(inst.id) : null }, "stress-teardown-main");
  console.log("MAIN REAPPLY DONE", JSON.stringify(r));
}
main().then(() => process.exit(0)).catch((e) => { console.error("FATAL", e?.message || e); process.exit(1); });
