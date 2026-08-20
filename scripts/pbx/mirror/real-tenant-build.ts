/* Build ONE real, working tenant via the MIRROR (outside the licence) with a real
 * spare DID from our own VoIP.ms stock wired end to end. First use: "Loopcom
 * Demo 2" (Izzy, 2026-08-20: "Create me a new tenant outside the license called
 * Loopcom Demo 2 with five extensions. Attach a real in-stack phone number.").
 *
 * Unlike stress20.ts this is a KEEPER: real VoIP.ms subaccount (same recipe as
 * onboarding's ensureSubaccount — Asterisk device type, own-device CallerID),
 * real trunk registration, and the DID re-routed at the carrier from the master
 * spare pool to the new subaccount. Nothing is purchased: a spare is stock we
 * already pay for. ⛔ E911 is NOT registered here (no service address) — fine
 * for a demo tenant, but say so in the report.
 *
 * Env: TENANT_NAME, TENANT_SLUG, SUB_NAME, EXT_COUNT (default 5), DID
 * (optional — otherwise the first 845 spare, else the first spare).
 * Run in a one-off container (auto-deploys can recreate app-api-1 mid-run):
 *   docker compose -f docker-compose.app.yml run --rm --no-deps \
 *     -v /root/real-tenant-build.ts:/app/apps/api/real-tenant-build.ts \
 *     -w /app/apps/api --entrypoint npx api tsx real-tenant-build.ts */
import { PanelSession, loadPanelConfig } from "./src/onboarding/panelClient";
import { buildPbxTenant } from "./src/onboarding/pbxTenantBuild";
import { resolveMirrorTenantCreator, resolveMirrorTenantRenderer } from "./src/onboarding/setupOrchestrator";
import { loadMasterCreds, listSpareDids, vms, VOIPMS_TRUNK_SERVER } from "./src/onboarding/voipMsProvisioning";
import { openReadConn } from "./src/pbxConsole/pbxConsoleReaders";
import { db } from "@connect/db";
import crypto from "node:crypto";

const TENANT_NAME = process.env.TENANT_NAME || "Loopcom Demo 2";
const TENANT_SLUG = process.env.TENANT_SLUG || "loopcom_demo_2";
const SUB_NAME = process.env.SUB_NAME || "lcdemo2";
const EXT_COUNT = Math.max(1, parseInt(process.env.EXT_COUNT || "5", 10) || 5);

function genPassword(): string {
  // Alphanumeric-safe, like onboarding's generatePassword. ⛔ VoIP.ms REQUIRES
  // at least one digit (invalid_password_missing_number — hit live when 20
  // random draws happened to contain none), so composition is guaranteed.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const digits = "23456789";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const pick = (set: string) => set[crypto.randomBytes(1)[0] % set.length];
  const body = Array.from(crypto.randomBytes(17)).map((b) => alphabet[b % alphabet.length]).join("");
  return pick(upper) + pick(lower) + pick(digits) + body;
}

async function main() {
  const cfg = loadPanelConfig(); if (!cfg) throw new Error("no panel cfg");
  const inst = await (db as any).pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
  const creds = await loadMasterCreds(); if (!creds) throw new Error("no VoIP.ms master creds");
  const creator = resolveMirrorTenantCreator(String(inst.id));
  const renderer = resolveMirrorTenantRenderer(String(inst.id));
  if (!creator || !renderer) throw new Error("mirror creator/renderer not configured — aborting (would use panel form)");

  // 1) the DID: a real spare from the master pool (never a customer's number).
  // ⛔ "Spare at the carrier" is NOT enough: retired port temp numbers go back
  // to the master pool while the PBX still carries their leftovers — inii
  // mini's 8452605692 still has an inbound route on T105 (sharing a
  // destinations row with their LIVE number), and Matamim's 7244198226 is
  // still in T104's ombu_tenant_dids. Handing either to a new tenant is the
  // routing collision the stress docs warn about. A spare is usable only when
  // the PBX has ZERO references to it.
  const spares = await listSpareDids(creds);
  console.log("spares:", JSON.stringify(spares));
  const pbxRefs = async (candidate: string): Promise<number> => {
    const c = await openReadConn(inst.ombuMysqlUrlEncrypted);
    if (!c.ok) throw new Error("cannot check PBX references: " + c.reason);
    try {
      const [rows]: any = await (c.conn as any).query(
        "SELECT (SELECT COUNT(*) FROM ombutel.ombu_inbound_routes WHERE did = ?) + (SELECT COUNT(*) FROM ombutel.ombu_tenant_dids WHERE did = ?) AS n",
        [candidate, candidate]);
      return Number(rows?.[0]?.n || 0);
    } finally { await (c.conn as any).end().catch(() => {}); }
  };
  let did = (process.env.DID || "").replace(/\D/g, "");
  if (did) {
    if (!spares.some((s) => s.did === did)) throw new Error(`DID ${did} is not a spare — refusing (routing collision risk)`);
    const n = await pbxRefs(did);
    if (n > 0) throw new Error(`DID ${did} still has ${n} PBX reference(s) — refusing`);
  } else {
    for (const s of spares.filter((x) => x.did.startsWith("845")).concat(spares)) {
      const n = await pbxRefs(s.did);
      console.log(`spare ${s.did}: pbx references = ${n}${n ? " — SKIPPED" : ""}`);
      if (n === 0) { did = s.did; break; }
    }
  }
  if (!did) throw new Error("no clean spare DID available");
  console.log("using spare DID:", did);

  // 2) the subaccount — onboarding's exact recipe (idempotent on used_username).
  const password = genPassword();
  let account = "";
  try {
    const r = await vms(creds, "createSubAccount", {
      username: SUB_NAME, password, protocol: "1", auth_type: "1", device_type: "1",
      lock_international: "1", international_route: "1", music_on_hold: "default",
      allowed_codecs: "ulaw;g729", dtmf_mode: "auto", nat: "yes",
    }, 120_000);
    account = String(r?.account || "");
  } catch (e: any) {
    if (String(e?.message || "").includes("used_username")) {
      const existing = await vms(creds, "getSubAccounts");
      const hit = (existing?.accounts || []).find((a: any) => String(a?.account || "").toLowerCase().endsWith(`_${SUB_NAME.toLowerCase()}`));
      if (!hit) throw e;
      account = String(hit.account);
      // ⛔ full-update trap: setSubAccount must resend the whole record; instead
      // of rotating the password here, refuse — a half-known subaccount needs a person.
      throw new Error(`subaccount ${account} already exists — set DID/SUB_NAME explicitly or clean it up first`);
    } else { throw e; }
  }
  if (!account) throw new Error("createSubAccount returned no account name");
  console.log("subaccount:", account, "server:", VOIPMS_TRUNK_SERVER);

  // 3) the tenant, via the mirror. Path resolver reads MySQL — NEVER REST
  //    (the REST tenant list is a stale cache; see pbxOrphanTenantSweep.ts).
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
  const people = Array.from({ length: EXT_COUNT }, (_, i) => ({ name: `Demo ${101 + i}`, ext: String(101 + i), email: "" }));
  const s = await new PanelSession(cfg.baseUrl, cfg.accounts[0]).login();
  let createdVia = "";
  const r = await buildPbxTenant(s, cfg.mainTenant, {
    company: TENANT_NAME, slug: TENANT_SLUG, label: TENANT_NAME,
    voipms: { user: account, pass: password, server: VOIPMS_TRUNK_SERVER }, did,
    people,
  } as any, (m) => { if (/via (mirror|panel)/.test(m)) createdVia = m.includes("via mirror") ? "mirror" : "panel"; console.log(" ", m); }, resolveTenantPath,
    { tenantCreator: creator, tenantRenderer: renderer });
  if (createdVia !== "mirror") { console.error(`ABORT-CHECK: tenant was created via ${createdVia || "unknown"}, not the mirror`); process.exit(2); }

  // 4) point the DID at the new subaccount at the carrier, and verify by re-read.
  await vms(creds, "setDIDRouting", { did, routing: `account:${account}` });
  const check = await vms(creds, "getDIDsInfo", { did });
  const row = (check?.dids || [])[0] || {};
  console.log("carrier routing now:", JSON.stringify({ did: row.did, routing: row.routing, sms: row.sms }));

  console.log("RESULT", JSON.stringify({ ...r, did, subaccount: account, server: VOIPMS_TRUNK_SERVER, createdVia }));
  console.log("SUBACCOUNT_PASSWORD_SHOWN_ONCE", password);
}
main().then(() => process.exit(0)).catch((e) => { console.error("FATAL", e?.message || e); process.exit(1); });
