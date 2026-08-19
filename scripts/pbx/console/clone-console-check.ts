/* PBX Console — proves every write primitive against the VitalPBX CLONE (unlicensed, prod data copy).
 * Run from repo root through the ssh tunnel to loopcom's clone (127.0.0.1:8443 → local 18443):
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 CREDS=<path to credentials.env> npx tsx scripts/pbx/console/clone-console-check.ts <step>
 * Never points at the live PBX: BASE defaults to the tunnel. Steps: parse | device-forms | ext-general | ext-devices | ext-create | ext-delete | tenant | phones | all
 */
import { readFileSync } from "node:fs";
import { PanelSession } from "../../../apps/api/src/onboarding/panelClient";
import { loadParsedForm, parseForm } from "../../../apps/api/src/pbxConsole/panelForm";
import {
  addPhone, createExtension, deleteExtension, deletePhone, deviceOptionsOf, loadPhoneForm, rebootPhone, savePhone,
  saveExtension, saveTenant, unlinkDevice,
} from "../../../apps/api/src/pbxConsole/pbxConsoleWrites";

const BASE = process.env.CLONE_PANEL_BASE || "https://127.0.0.1:18443";
const env: Record<string, string> = {};
for (const line of readFileSync(process.env.CREDS || "", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const USER = env.CONNECT_ROBOT_USER || "", PASS = env.CONNECT_ROBOT_PASS || "";
if (!USER || !PASS) throw new Error("credentials.env not readable");
const MAIN = "2dc3974017c1bc65";
const T104 = "4de9a88870cd2add"; // Matamim on the clone (ext 400 = "101 Joel", ext 408 = "199 Lapse Test")
const T8 = process.env.T8_PATH || ""; // Gesheft — read from DB by the shell wrapper if needed
const step = process.argv[2] || "parse";
/** ext 400's desk + app devices as specs (ids move on the clone as tests add/remove them). */
function baseSpecs(form: import("../../../apps/api/src/pbxConsole/panelForm").ParsedForm) {
  return deviceOptionsOf(form).flatMap((d) =>
    /^T104_101 - /.test(d.label) ? [{ id: Number(d.id), kind: "pjsip" as const, dtmf: "rfc4733" }]
    : /^T104_101_1 - /.test(d.label) ? [{ id: Number(d.id), kind: "webrtc" as const, dtmf: "rfc2833" }] : []);
}
const say = (...a: any[]) => console.log("  ", ...a);

async function main() {
  const s = new PanelSession(BASE, { id: "robot", user: USER, pass: PASS });
  await s.login();
  console.log("logged in, home", s.homeTenant);
  const run = async (name: string, fn: () => Promise<void>) => {
    if (step !== "all" && step !== name) return;
    console.log(`\n=== ${name}`);
    try { await fn(); console.log(`RESULT ${name}: OK`); } catch (e: any) { console.log(`RESULT ${name}: FAILED — ${e?.message || e}`); }
  };

  await run("parse", async () => {
    s.setTenant(T104);
    const { form } = await loadParsedForm(s, "extensions", "edit", 400);
    say("fields:", Object.keys(form.values).length, "multi:", Object.keys(form.multi).length, "checks:", Object.keys(form.checks).length, "selects:", Object.keys(form.options).length);
    say("name/extension/cos:", form.values.name, form.values.extension, form.values.class_of_service_id, "| device_id:", form.values.device_id, "user:", form.values.user);
    say("devices:", deviceOptionsOf(form));
    say("checks on:", Object.entries(form.checks).filter(([, c]) => c.checked).map(([k]) => k).join(","));
    say("pairs:", form.pairs.length, "sample:", form.pairs.slice(0, 6));
    say("profile options:", form.options.profile_id, "| technology:", form.values.technology);
    s.setTenant(MAIN);
    const t = await loadParsedForm(s, "tenants", "edit", 104);
    say("tenant fields:", Object.keys(t.form.values).length, "description:", t.form.values.description, "inbound rows:", t.form.pairs.filter(([k]) => k.startsWith("inbound_numbers[")).length, "outbound_profiles:", t.form.multi["outbound_profiles[]"]);
  });

  await run("device-forms", async () => {
    s.setTenant(T104);
    for (const dev of ["new", "725", "726"]) {
      const r = await s.post([["class", "extensions"], ["method", "getDevice"], ["mode", dev === "new" ? "add" : "edit"], ["data[device_id]", dev], ["data[extension_id]", "400"]]);
      const f = parseForm(String(r.json?.html ?? ""));
      say(`getDevice ${dev}: state=${r.json?.state} action=${r.json?.action} bytes=${String(r.json?.html ?? "").length}`);
      say("   values:", JSON.stringify(Object.fromEntries(Object.entries(f.values).filter(([k]) => !/csfr/.test(k)))).slice(0, 700));
      say("   checks:", JSON.stringify(f.checks));
      say("   multi:", JSON.stringify(f.multi), "profile opts:", JSON.stringify(f.options.profile_id || []).slice(0, 300));
      say("   technology radios?", JSON.stringify((f.options as any).technology), "raw technology inputs:", (String(r.json?.html ?? "").match(/name=["']technology["'][^>]*/g) || []).slice(0, 4));
    }
  });

  await run("ext-general", async () => {
    // rename ext 400 → "Joel (console)" and back, verify via the reloaded form
    const before = (await loadParsedForm(s, "extensions", "edit", 400)).form.values.name;
    s.setTenant(T104);
    const DEVS = baseSpecs((await loadParsedForm(s, "extensions", "edit", 400)).form);
    await saveExtension(s, T104, 400, { set: { name: before + " (console)" }, devices: DEVS });
    const mid = (await loadParsedForm(s, "extensions", "edit", 400)).form;
    say("after save name:", mid.values.name, "device still:", deviceOptionsOf(mid).length, "vm_enabled:", mid.checks.vm_enabled?.checked, "call_waiting:", mid.checks.call_waiting?.checked);
    // toggle a checkbox off and on
    await saveExtension(s, T104, 400, { checks: { call_waiting: false }, devices: DEVS });
    const off = (await loadParsedForm(s, "extensions", "edit", 400)).form.checks.call_waiting?.checked;
    await saveExtension(s, T104, 400, { set: { name: before }, checks: { call_waiting: true }, devices: DEVS });
    const restored = (await loadParsedForm(s, "extensions", "edit", 400)).form;
    say("call_waiting off→", off, "restored name:", restored.values.name, "call_waiting:", restored.checks.call_waiting?.checked);
    if (restored.values.name !== before || off !== false || restored.checks.call_waiting?.checked !== true) throw new Error("round trip mismatch");
  });

  await run("ext-devices", async () => {
    // add a virtual device to ext 400, change its number, then unlink it
    s.setTenant(T104);
    const f0 = deviceOptionsOf((await loadParsedForm(s, "extensions", "edit", 400)).form);
    say("devices before:", f0.map((d) => d.label));
    const DEVS = baseSpecs((await loadParsedForm(s, "extensions", "edit", 400)).form);
    await saveExtension(s, T104, 400, { devices: [...DEVS, { id: null, kind: "virtual", number: "8455550101", description: "Console cell test", user: "101_2" }] });
    const f1 = deviceOptionsOf((await loadParsedForm(s, "extensions", "edit", 400)).form);
    say("devices after add:", f1.map((d) => d.label));
    const added = f1.find((d) => !f0.some((x) => x.id === d.id));
    if (!added) throw new Error("virtual device not added");
    const r = await s.post([["class", "extensions"], ["method", "getDevice"], ["mode", "edit"], ["data[device_id]", added.id], ["data[extension_id]", "400"]]);
    say("added device form values:", JSON.stringify(Object.fromEntries(Object.entries(parseForm(String(r.json?.html ?? "")).values).filter(([k]) => /technology|number|user|dev_description|profile|max_contacts|dtmf/.test(k)))));
    await saveExtension(s, T104, 400, { devices: [...DEVS, { id: Number(added.id), kind: "virtual", number: "8455550102" }] });
    const r2 = await s.post([["class", "extensions"], ["method", "getDevice"], ["mode", "edit"], ["data[device_id]", added.id], ["data[extension_id]", "400"]]);
    say("after number edit:", parseForm(String(r2.json?.html ?? "")).values.number);
    await unlinkDevice(s, 400, Number(added.id));
    const f2 = deviceOptionsOf((await loadParsedForm(s, "extensions", "edit", 400)).form);
    say("devices after unlink:", f2.map((d) => d.label));
    if (f2.length !== f0.length) throw new Error("unlink did not restore the device count");
  });

  await run("repair-725", async () => {
    // put the desk device the earlier harness bug unlinked back on ext 400 (clone only)
    s.setTenant(T104);
    const f = (await loadParsedForm(s, "extensions", "edit", 400)).form;
    say("devices now:", deviceOptionsOf(f).map((d) => d.label));
    await saveExtension(s, T104, 400, { devices: [{ id: 726, kind: "webrtc", dtmf: "rfc2833" }, { id: null, kind: "pjsip", user: "101", secret: "Wppfh9p28ExJAU22rxGV2BY5q", description: "Device 101", maxContacts: "1", dtmf: "rfc4733" }] });
    const f2 = (await loadParsedForm(s, "extensions", "edit", 400)).form;
    say("devices after repair:", deviceOptionsOf(f2).map((d) => d.label));
  });

  if (step.startsWith("unlink:")) {
    s.setTenant(T104);
    await unlinkDevice(s, 400, Number(step.split(":")[1]));
    console.log("unlinked", step.split(":")[1], "devices now:", deviceOptionsOf((await loadParsedForm(s, "extensions", "edit", 400)).form).map((d) => d.label));
  }

  await run("ext-create", async () => {
    const made = await createExtension(s, T104, {
      extension: "451", name: "Console Create Test", email: "", vmPassword: "4510",
      set: { accountcode: "console" }, checks: { call_waiting: false },
      devices: [{ kind: "pjsip", secret: "ConsoleTestPw451xyz" }, { kind: "webrtc" }, { kind: "virtual", number: "8455550451", description: "cell" }],
    }, undefined, say);
    say("created:", made);
    const f = (await loadParsedForm(s, "extensions", "edit", made.extensionId)).form;
    say("devices:", deviceOptionsOf(f).map((d) => d.label), "accountcode:", f.values.accountcode, "call_waiting:", f.checks.call_waiting?.checked, "vm_password:", f.values.vm_password);
    // virtual-first extension
    const made2 = await createExtension(s, T104, { extension: "452", name: "Console Virtual First", devices: [{ kind: "virtual", number: "8455550452" }] }, undefined, say);
    say("created virtual-first:", made2);
    const f2 = (await loadParsedForm(s, "extensions", "edit", made2.extensionId)).form;
    say("devices:", deviceOptionsOf(f2).map((d) => d.label), "technology:", f2.values.technology, "number:", f2.values.number);
    // webrtc-first extension
    const made3 = await createExtension(s, T104, { extension: "453", name: "Console App Only", devices: [{ kind: "webrtc" }] }, undefined, say);
    const f3 = (await loadParsedForm(s, "extensions", "edit", made3.extensionId)).form;
    say("created app-only:", made3, "devices:", deviceOptionsOf(f3).map((d) => d.label), "profile:", f3.values.profile_id, "max_contacts:", f3.values.max_contacts);
  });

  await run("ext-delete", async () => {
    s.setTenant(T104);
    for (const ext of ["451", "452", "453"]) {
      const { extensionId } = await import("../../../apps/api/src/onboarding/pbxTenantBuild");
      let id: string | null = null;
      try { id = await extensionId(s, ext); } catch { id = null; }
      if (!id) { say(ext, "not present"); continue; }
      await deleteExtension(s, T104, id, ext);
      say("deleted", ext, "(id", id + ")");
    }
  });

  await run("tenant", async () => {
    s.setTenant(MAIN);
    const before = (await loadParsedForm(s, "tenants", "edit", 104)).form;
    say("before: description", before.values.description, "inbound", before.pairs.filter(([k]) => /\[did\]$/.test(k)).map(([, v]) => v), "cid_name", before.values.cid_name);
    await saveTenant(s, MAIN, 104, { set: { cid_name: "Matamim (console)" }, inboundNumbers: [{ did: "7244198226", description: "" }, { did: "9293598299", description: "" }, { did: "8455550199", description: "console test" }] });
    const mid = (await loadParsedForm(s, "tenants", "edit", 104)).form;
    say("after: cid_name", mid.values.cid_name, "inbound", mid.pairs.filter(([k]) => /\[did\]$/.test(k)).map(([, v]) => v));
    await saveTenant(s, MAIN, 104, { set: { cid_name: before.values.cid_name }, inboundNumbers: [{ did: "7244198226", description: "" }, { did: "9293598299", description: "" }] });
    const after = (await loadParsedForm(s, "tenants", "edit", 104)).form;
    say("restored: cid_name", JSON.stringify(after.values.cid_name), "inbound", after.pairs.filter(([k]) => /\[did\]$/.test(k)).map(([, v]) => v), "outbound_profiles", after.multi["outbound_profiles[]"], "enabled", after.checks.enabled?.checked);
    if (after.values.cid_name !== before.values.cid_name) throw new Error("cid_name did not restore");
  });

  await run("phones", async () => {
    if (!T8) throw new Error("T8_PATH env missing");
    const f = await loadPhoneForm(s, T8, 30);
    say("phone 30:", f.values.mac, f.values.description, "brand", f.values.brand_id, "model", f.values.model_id, "template", f.values.template_id, "line1", f.values["devices[1][device_id]"], "pairs", f.pairs.length);
    await savePhone(s, T8, 30, { description: f.values.description + " (console)" });
    const f2 = await loadPhoneForm(s, T8, 30);
    say("after:", f2.values.description, "brand", f2.values.brand_id, "model", f2.values.model_id, "template", f2.values.template_id, "line1", f2.values["devices[1][device_id]"], "key1 type", f2.values["keys[dss_keys][1][type]"]);
    await savePhone(s, T8, 30, { description: f.values.description });
    const f3 = await loadPhoneForm(s, T8, 30);
    say("restored:", f3.values.description, "model", f3.values.model_id, "template", f3.values.template_id, "line1", f3.values["devices[1][device_id]"]);
    if (f3.values.model_id !== f.values.model_id || f3.values.template_id !== f.values.template_id || f3.values["devices[1][device_id]"] !== f.values["devices[1][device_id]"]) throw new Error("phone re-post changed model/template/line — STOP");
    // add + delete a throwaway phone
    await addPhone(s, T8, 8, { mac: "00:11:22:33:44:55", description: "Console add test", brandId: "6", modelId: f.values.model_id, templateId: f.values.template_id });
    say("added phone");
    await rebootPhone(s, T8, 30).then(() => say("reboot ok")).catch((e) => say("reboot:", e.message));
  });
  await run("reboot", async () => {
    if (!T8) throw new Error("T8_PATH missing");
    await rebootPhone(s, T8, 30); say("reboot sent");
  });
  await run("geo", async () => {
    s.setTenant(MAIN);
    const r = await s.post([["class","geo_firewall"],["method","getContent"],["mode","read"]]);
    const f = parseForm(String(r.json?.html ?? ""));
    const cur = (f.values["countries"] || "").split(",").filter(Boolean);
    say("current blocked count:", cur.length, "sample:", cur.slice(0,8));
    const withTest = cur.includes("BR") ? cur : [...cur, "BR"];
    const save = await s.post([["class","geo_firewall"],["method","put"],["mode","read"],["csfr_token", f.values["csfr_token"] || ""],["countries", withTest.join(",")]]);
    say("save state:", save.json?.state, "note:", JSON.stringify(save.json?.notification||{}).slice(0,200));
    const r2 = await s.post([["class","geo_firewall"],["method","getContent"],["mode","read"]]);
    const f2 = parseForm(String(r2.json?.html ?? ""));
    say("after save blocked BR?", (f2.values["countries"]||"").split(",").includes("BR"), "count:", (f2.values["countries"]||"").split(",").filter(Boolean).length);
    // restore
    await s.post([["class","geo_firewall"],["method","put"],["mode","read"],["csfr_token", f2.values["csfr_token"] || ""],["countries", cur.join(",")]]);
    say("restored to", cur.length);
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
