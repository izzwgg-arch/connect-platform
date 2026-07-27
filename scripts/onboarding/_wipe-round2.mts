// Owner-authorized wipe of the 2026-07-27 evening stress round (Ezra Store
// 1-10) PLUS leftover panel objects from earlier wipes whose deletes silently
// failed (panel returns a confirmation dialog; old script never confirmed).
// VERIFY mode unless DO_DELETE=1. Every object is identity-checked before
// deletion; panel deletes use the real two-step protocol and verify absence.
import { createRequire } from "node:module";
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { PanelSession, loadPanelConfig, applyChanges, findOptionInSelect, decodeEntities } from "./src/onboarding/panelClient";
const require2 = createRequire(import.meta.url);
const { VitalPbxClient } = require2("@connect/integrations");

const DO_DELETE = process.env.DO_DELETE === "1";
console.log(DO_DELETE ? "*** DELETE MODE ***" : "*** VERIFY-ONLY MODE ***");
let failures = 0;
const bad = (m: string) => { failures++; console.log("MISMATCH:", m); };
const ok = (m: string) => console.log("verified:", m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => decodeEntities(String(s || "")).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// ── Targets ──────────────────────────────────────────────────────────────────
// PBX tenants (round 2) — id + path + name, from REST inventory.
const PBX_TENANTS = [
  { id: "64", path: "2d7d489def237693", name: "ezra_store_2" },
  { id: "65", path: "02a07f8884cf1bd8", name: "ezra_store_3" },
  { id: "66", path: "da83599e36aafebf", name: "ezra_store_4" },
  { id: "67", path: "391238bafbb4e719", name: "ezra_store_5" },
  { id: "68", path: "26e26ff0a606649a", name: "ezra_store_6" },
  { id: "69", path: "f5366111853d3006", name: "ezra_store_7" },
  { id: "70", path: "5b1e28bbc3a60f87", name: "ezra_store_8" },
  { id: "71", path: "65cf4b10991dcd0e", name: "ezra_store_9" },
  { id: "72", path: "8f4f915ee6a5f89f", name: "ezra_store_10" },
];
// Panel trios (ars / trunk_group / trunks), by exact description. Includes
// round-1 + "Ezra Agent" leftovers. "Ezra's store" trio already deleted today
// while reverse-engineering the protocol (ars 122 / route 82 / trunk 86).
const PANEL_TRIOS: Array<{ name: string; ars: string; route: string; trunk: string }> = [
  { name: "Ezra Agent",      ars: "120", route: "81", trunk: "85" },
  { name: "Ezra's Store 2",  ars: "124", route: "83", trunk: "87" },
  { name: "Ezra store 3",    ars: "126", route: "84", trunk: "88" },
  { name: "Ezra store 5",    ars: "128", route: "85", trunk: "89" },
  { name: "Ezra store 6",    ars: "130", route: "86", trunk: "90" },
  { name: "Ezra Store 7",    ars: "132", route: "87", trunk: "91" },
  { name: "Ezra store 8",    ars: "134", route: "88", trunk: "92" },
  { name: "Ezra Sotre 9",    ars: "136", route: "89", trunk: "93" },
  { name: "Ezra Store 10",   ars: "138", route: "90", trunk: "94" },
  { name: "Ezra Store 2",    ars: "140", route: "91", trunk: "95" },
  { name: "Ezra Store 4",    ars: "143", route: "92", trunk: "96" },
  { name: "Ezra Store 9",    ars: "149", route: "93", trunk: "97" },
];
// VoIP.ms: subaccount -> DID it should currently hold ("" = orphan, no DID).
const VMS_TARGETS = [
  { sub: "344022_EzraStore11",  did: "" }, // orphan from failed Ezra Store 1
  { sub: "344022_EzraStore21",  did: "8453050012" },
  { sub: "344022_EzraStore31",  did: "8455577194" },
  { sub: "344022_EzraStore41",  did: "8452605692" },
  { sub: "344022_EzraStore51",  did: "8455577735" },
  { sub: "344022_EzraStore61",  did: "8455577820" },
  { sub: "344022_EzraStore71",  did: "8455577749" },
  { sub: "344022_EzraStore81",  did: "8455577763" },
  { sub: "344022_EzraStore91",  did: "8455577789" },
  { sub: "344022_EzraStore101", did: "8455577821" },
];
// Connect tenants (createdTenantId) + all submissions of the round.
const CONNECT_TENANTS = [
  "cms3m7eve02k5rt12lqhplna5", "cms3mbnfu02zert12dgopzlgw", "cms3mfzix046krt12ekz4sgdl",
  "cms3mjhid051mrt121as62dc1", "cms3mndjx0640rt12ao475dm8", "cms3mqjpi0738rt126vvmqdcb",
  "cms3mttl807mfrt128yybapfp", "cms3mxpo508s8rt12ffna9atj", "cms3n058t095art127itqitkv",
];
const SUBMISSIONS = [
  "cms3lrxkd006ko212pmcp5nsf", "cms3m4vg201kzrt120dl6otu3", "cms3ma4ex02n2rt12k5jfeywe",
  "cms3mdoj403pwrt12n5qihsh4", "cms3mhjx404a4rt12s9vi2gw7", "cms3mln3205rtrt12giq0blsg",
  "cms3mp05n06g8rt124ej3ihk9", "cms3msjo507brrt12wdjf1b23", "cms3mvn71081ort12s7kagsjn",
  "cms3myz8q08vmrt129wrpa4zu", // Ezra Store 1 attempt 2 (failed)
  "cms3l06i007qbp413ch8uzd85", // Ezra Store 1 attempt 1 (failed)
  "cms3l502f08gvp413dgv91679", // abandoned draft
  "cms3l9guu08y8p413t8myixz0", // abandoned draft
  "cms3n22rs09n0rt120cceitlq", // empty spawn
];

// ── Clients ──────────────────────────────────────────────────────────────────
const instance = await (db as any).pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });
const auth = decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
// Tenant deletion tears down every extension server-side and can exceed 20s.
const client = new VitalPbxClient({
  baseUrl: instance.baseUrl, apiToken: auth.token, apiSecret: auth.secret,
  timeoutMs: 120000, allowConfigMutations: DO_DELETE,
});
const cfg = loadPanelConfig()!;
const s = await new PanelSession(cfg.baseUrl, cfg.accounts[0]).login();
s.setTenant(cfg.mainTenant);

const cfgRow = await (db as any).globalVoipMsConfig.findUnique({ where: { id: "default" } });
const master = decryptJson<any>(cfgRow.credentialsEncrypted);
async function vms(method: string, params: Record<string, string> = {}): Promise<any> {
  const u = new URL("https://voip.ms/api/v1/rest.php");
  u.searchParams.set("api_username", master.username);
  u.searchParams.set("api_password", master.password);
  u.searchParams.set("method", method);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let attempt = 1; ; attempt++) {
    try {
      const t = await (await fetch(u.toString())).text();
      if (t.trimStart().startsWith("<")) throw new Error("html_response");
      return JSON.parse(t);
    } catch (e: any) {
      if (attempt >= 5) throw e;
      console.log(`  ${method} attempt ${attempt} failed (${e?.message}) — retrying in ${attempt * 15}s`);
      await sleep(attempt * 15000);
    }
  }
}

// Panel helpers
const SELECTS: Record<string, { form: [string, string]; sel: string | RegExp }> = {
  ars: { form: ["tenants", "add"], sel: "outbound_profiles[]" },
  trunk_group: { form: ["ars", "add"], sel: /^members\[\d+\]\[outbound_route_id\]$/ },
  trunks: { form: ["trunk_group", "add"], sel: "trklist[]" },
};
async function panelFind(cls: string, name: string): Promise<string | null> {
  const { form, sel } = SELECTS[cls];
  return findOptionInSelect(await s.loadForm(form[0], form[1]), sel, (t) => t.toLowerCase() === name.toLowerCase());
}
async function panelDelete(cls: string, id: string, label: string): Promise<void> {
  const r = await s.post([["class", cls], ["method", "delete"], ["mode", "delete"], ["data", id]]);
  const html = String(r.json?.html || "");
  if (/module-error-list/i.test(html)) {
    const items = (html.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || []).map((x) => x.replace(/<[^>]+>/g, " ").trim());
    throw new Error(`${label}: panel refused: ${items.join(" | ")}`);
  }
  if (!/confirmation-modal/i.test(html)) throw new Error(`${label}: unexpected delete response: ${r.text.slice(0, 200)}`);
  const pairs: Array<[string, string]> = [];
  for (const m of html.matchAll(/<input\b[^>]*type=["']hidden["'][^>]*>/gi)) {
    const n = (m[0].match(/name=["']([^"']+)["']/i) || [])[1];
    const v = (m[0].match(/value=["']([^"']*)["']/i) || [])[1] || "";
    if (n) pairs.push([n, v]);
  }
  const r2 = await s.post(pairs);
  if (r2.json?.notification?.type !== "success") throw new Error(`${label}: confirm failed: ${r2.text.slice(0, 200)}`);
  console.log(`deleted ${label} (${cls}#${id})`);
}

// ── VERIFY ───────────────────────────────────────────────────────────────────
const allTenants = (await client.listTenants()) as any[];
for (const t of PBX_TENANTS) {
  const hit = allTenants.find((x) => String(x.tenant_id) === t.id);
  if (!hit) { console.log(`note: PBX tenant ${t.id} (${t.name}) already gone`); continue; }
  if (hit.default === true || String(hit.path) !== t.path || norm(hit.name) !== t.name) {
    bad(`PBX tenant ${t.id}: ${hit.name}/${hit.path} != expected ${t.name}/${t.path}`); continue;
  }
  ok(`PBX tenant ${t.id} ${hit.name}`);
}
for (const trio of PANEL_TRIOS) {
  for (const [cls, id] of [["ars", trio.ars], ["trunk_group", trio.route], ["trunks", trio.trunk]] as const) {
    const found = await panelFind(cls, trio.name);
    if (found == null) { console.log(`note: ${cls} "${trio.name}" already gone`); continue; }
    if (found !== id) { bad(`${cls} "${trio.name}" resolved to #${found}, expected #${id}`); continue; }
    ok(`${cls}#${id} "${trio.name}"`);
  }
}
const subIds: Record<string, string> = {};
{
  const j = await vms("getSubAccounts");
  const list: any[] = j.accounts || [];
  for (const t of VMS_TARGETS) {
    const hit = list.find((a) => String(a.account) === t.sub);
    if (!hit) { console.log(`note: subaccount ${t.sub} already gone`); continue; }
    subIds[t.sub] = String(hit.id);
    ok(`VoIP.ms subaccount ${t.sub} (id ${hit.id})`);
  }
  for (const t of VMS_TARGETS) {
    if (!t.did) continue;
    const dj = await vms("getDIDsInfo", { did: t.did });
    const routing = String(dj?.dids?.[0]?.routing || "");
    if (routing === "account:344022") console.log(`note: DID ${t.did} already on master`);
    else if (routing.includes(t.sub)) ok(`DID ${t.did} → ${routing}`);
    else bad(`DID ${t.did} routing ${JSON.stringify(routing)} unexpected`);
    await sleep(800);
  }
}
for (const id of CONNECT_TENANTS) {
  const ct = await (db as any).tenant.findUnique({ where: { id }, include: { _count: { select: { users: true, extensions: true } } } });
  if (!ct) { console.log(`note: Connect tenant ${id} already gone`); continue; }
  if (!/^ezra store \d+$/i.test(String(ct.name).trim())) { bad(`Connect tenant ${id} name ${JSON.stringify(ct.name)} not an Ezra Store`); continue; }
  ok(`Connect tenant ${id} (${ct.name}) users=${ct._count.users} exts=${ct._count.extensions}`);
}
for (const id of SUBMISSIONS) {
  const sm = await (db as any).onboardingSubmission.findUnique({ where: { id } });
  if (!sm) { console.log(`note: submission ${id} already gone`); continue; }
  const nm = String(sm.companyName || "");
  if (nm && !/^\s*ezra store \d+\s*$/i.test(nm)) { bad(`submission ${id} company ${JSON.stringify(nm)} not an Ezra Store`); continue; }
  ok(`submission ${id} (${nm || "empty/draft"})`);
}

if (failures) { console.log(`\n${failures} MISMATCH(ES) — aborting.`); process.exit(1); }
if (!DO_DELETE) { console.log("\nAll verified. Re-run with DO_DELETE=1."); process.exit(0); }

// ── DELETE ───────────────────────────────────────────────────────────────────
console.log("\n— PBX tenants (REST) —");
for (const t of PBX_TENANTS) {
  const hit = allTenants.find((x) => String(x.tenant_id) === t.id);
  if (!hit) continue;
  try {
    await client.deleteTenant(t.id);
    console.log(`deleted PBX tenant ${t.id} (${t.name})`);
  } catch (e: any) {
    // A timeout doesn't mean failure — the PBX keeps working. Poll for absence.
    console.log(`deleteTenant ${t.id} threw (${e?.code || e?.message}) — polling for absence…`);
    let gone = false;
    for (let i = 0; i < 12 && !gone; i++) {
      await sleep(10000);
      const now = (await client.listTenants()) as any[];
      gone = !now.find((x) => String(x.tenant_id) === t.id);
    }
    if (!gone) throw new Error(`PBX tenant ${t.id} still present after delete + wait`);
    console.log(`deleted PBX tenant ${t.id} (${t.name}) — confirmed by poll`);
  }
}
// verify tenants gone
{
  const after = (await client.listTenants()) as any[];
  for (const t of PBX_TENANTS) {
    if (after.find((x) => String(x.tenant_id) === t.id)) throw new Error(`PBX tenant ${t.id} still present after delete`);
  }
  console.log("all 9 PBX tenants verified gone");
}
console.log("\n— panel objects (two-step delete + verify) —");
for (const trio of PANEL_TRIOS) {
  for (const [cls, id] of [["ars", trio.ars], ["trunk_group", trio.route], ["trunks", trio.trunk]] as const) {
    const found = await panelFind(cls, trio.name);
    if (found == null) { console.log(`skip ${cls} "${trio.name}" — already gone`); continue; }
    await panelDelete(cls, id, `${cls} "${trio.name}"`);
    const still = await panelFind(cls, trio.name);
    if (still != null) throw new Error(`${cls} "${trio.name}" still present after confirmed delete`);
  }
}
await applyChanges(s, "wipe-round2");
console.log("panel Apply Changes done");

console.log("\n— VoIP.ms —");
for (const t of VMS_TARGETS) {
  if (t.did) {
    const dj = await vms("getDIDsInfo", { did: t.did });
    const routing = String(dj?.dids?.[0]?.routing || "");
    if (routing.includes(t.sub)) {
      const r = await vms("setDIDRouting", { did: t.did, routing: "account:344022" });
      console.log(`setDIDRouting ${t.did} → master: ${r.status}`);
    } else console.log(`DID ${t.did} not on ${t.sub} (${routing}) — leaving`);
    await sleep(1500);
  }
  if (subIds[t.sub]) {
    const r = await vms("delSubAccount", { id: subIds[t.sub] });
    console.log(`delSubAccount ${t.sub}: ${r.status}`);
    await sleep(1500);
  } else console.log(`subaccount ${t.sub} already gone`);
}

console.log("\n— Connect —");
for (const id of CONNECT_TENANTS) {
  const ct = await (db as any).tenant.findUnique({ where: { id } });
  if (!ct) continue;
  await (db as any).tenant.delete({ where: { id } });
  console.log(`deleted Connect tenant ${id} (${ct.name})`);
}
for (const id of SUBMISSIONS) {
  const sm = await (db as any).onboardingSubmission.findUnique({ where: { id } });
  if (!sm) continue;
  await (db as any).onboardingSubmission.delete({ where: { id } });
  console.log(`deleted submission ${id} (${sm.companyName || "empty/draft"})`);
}

console.log("\n— final DID check —");
for (const t of VMS_TARGETS) {
  if (!t.did) continue;
  const dj = await vms("getDIDsInfo", { did: t.did });
  console.log(`DID ${t.did}: ${dj?.dids?.[0]?.routing}`);
  await sleep(800);
}
console.log("\nWIPE COMPLETE");
process.exit(0);
