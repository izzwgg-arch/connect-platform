/**
 * THE 12-EXTENSION QUESTION, answered empirically (2026-08-23).
 *
 * Izzy: "you are absolutely sure that we can create more than 12 extensions
 * outside of license, yes?" — this drives the console's REAL createExtension
 * sequence against the UNLICENSED clone (123 extensions, cap 12):
 *   1. CSV import (menu4) of a new extension            — the base row
 *   2. the extension edit-save carrying a NEW WebRTC device sub-form
 *      (saveExtension's exact postWithDevice shape)     — the device ADD
 *   3. the same save carrying the EXISTING desk device  — the EDIT (expected
 *      to hit the cap refusal; the api falls back to the mirror for this)
 *   4. panel delete of the test extension, count back to baseline
 *
 * Refuses to run against anything that is not the clone.
 */
import { PanelSession } from "./apps/api/src/onboarding/panelClient";
import { parseForm, applyOverrides, DEVICE_FIELDS, type ParsedForm } from "./apps/api/src/pbxConsole/panelForm";

const BASE = process.env.CLONE_PANEL_BASE || "";
if (!/^https:\/\/127\.0\.0\.1:8443$/.test(BASE)) throw new Error("REFUSED: clone only");
const TENANT = process.env.CLONE_TENANT_PATH || "";
const EXT = "651";

const CSV_HEADER =
  "mode,extension,ext_name,language,class_of_service,technology,profile_name,device_user,device_password,device_description,devices_emergency_cid_name,devices_emergency_cid_number,virtual_number,ring_device,codecs,max_contacts,features_password,email,did_number,cid_number,call-limit,call_waiting,vm_enabled,vm_password,saycid,sayduration,envelope,attach,delete,ask_password,skip_instructions,outgoing_rec,incoming_rec,external_cid_name,external_cid_number,emergency_cid_name,emergency_cid_number,dial_profile,accountcode,followme_numbers,initial_ringtime,fw_ringtime,ring_strategy,followme-enabled,recname,enable_callee_prompt,internal_numbers_confirmation,dynamic_queues,static_queues,mobile_number,home_number,organization,job_title,send_welcome_email,vitxi_client,mobile_client,notify_missed_calls,callback_on_busy_transfer";

async function main() {
  const s = new PanelSession(BASE, { user: process.env.CONNECT_ROBOT_USER!, pass: process.env.CONNECT_ROBOT_PASS! } as any);
  await s.login();
  s.setTenant(TENANT);

  // 1. CSV import — createExtension's base row, byte-for-byte shape
  const csrf = await s.ensureCsrf("menu4");
  const cols = CSV_HEADER.split(",");
  const base: Record<string, string> = {
    mode: "add", extension: EXT, ext_name: "Cap Proof 651", class_of_service: "all",
    technology: "pjsip", profile_name: "Default PJSIP Profile", device_user: EXT,
    email: "", outgoing_rec: "yes", incoming_rec: "yes", vm_enabled: "yes",
  };
  const csv = CSV_HEADER + "\n" + cols.map((c) => base[c] ?? "").join(",") + "\n";
  const fd = new FormData();
  fd.append("class", "menu4"); fd.append("method", "put"); fd.append("mode", "add"); fd.append("csfr_token", String(csrf ?? ""));
  fd.append("csv", new Blob([csv], { type: "text/csv" }), "import_extensions.csv");
  const r1 = await s.postForm(fd);
  const note = String((r1.json as any)?.notification?.text || "");
  console.log("STEP1 csv-import:", /completed successfully/i.test(note) ? "OK" : "REFUSED", "|", note.replace(/<[^>]+>/g, " ").trim().slice(0, 160));
  if (!/completed successfully/i.test(note)) { console.log("VERDICT: creation itself is REFUSED over the cap"); return; }

  // find the new extension id from the edit form list (the panel's own config select)
  const cfg = await s.post([["class", "extensions"], ["method", "getConfig"], ["mode", "edit"]]);
  const m = String((cfg.json as any)?.html ?? cfg.text ?? "").match(new RegExp('value="(\\d+)"[^>]*>\\s*' + EXT + '\\b'));
  if (!m) throw new Error("imported extension not found in the config list");
  const extId = m[1];
  console.log("STEP1b extension id:", extId);

  const form = parseForm(await s.loadForm("extensions", "edit", extId));
  const basePairs = applyOverrides(form, {}).filter(([k]) => !DEVICE_FIELDS.has(k))
    .filter(([k]) => k !== "dynamic_queues[]" && k !== "static_queues[]");

  const postWithDevice = async (devForm: ParsedForm, ov: any, step: string) => {
    const devicePairs = applyOverrides(devForm, ov).filter(([k]) => DEVICE_FIELDS.has(k));
    for (const [k, v] of Object.entries((ov.set || {}) as Record<string, string>)) {
      if (v != null && !devicePairs.some(([n]) => n === k)) devicePairs.push([k, String(v)]);
    }
    const pairs: Array<[string, string]> = [...basePairs, ...devicePairs];
    for (const [k, v] of [["class", "extensions"], ["method", "put"], ["mode", "edit"]] as Array<[string, string]>) {
      const i = pairs.findIndex(([n]) => n === k); if (i >= 0) pairs[i] = [k, v]; else pairs.push([k, v]);
    }
    const r = await s.post(pairs);
    const j: any = r.json || {};
    const errs = ((String(j?.html || "").match(/<li[^>]*>([\s\S]*?)<\/li>/gi)) || []).map((x) => x.replace(/<[^>]+>/g, " ").trim());
    const ok = j?.notification?.type === "success" || j?.state === "success";
    console.log(step + ":", ok ? "OK" : "REFUSED", "|", (j?.notification?.text || errs.join(" | ") || r.text.slice(0, 120)).toString().replace(/<[^>]+>/g, " ").trim().slice(0, 160));
    return ok;
  };

  // 2. the device ADD — a brand-new WebRTC device on the new extension
  const devFormNewR = await s.post([["class", "extensions"], ["method", "getDevice"], ["mode", "add"], ["data[device_id]", "new"], ["data[extension_id]", String(extId)]]);
  const devFormNew = parseForm(String((devFormNewR.json as any)?.html ?? devFormNewR.text ?? ""));
  const addOk = await postWithDevice(devFormNew, {
    set: { device_id: "new", technology: "pjsip", profile_id: "12", user: EXT + "_1", dtmfmode: "rfc2833", max_contacts: "5", vitxi_client: "1", number: "" },
    checks: { ring_device: true },
  }, "STEP2 webrtc-device-ADD");

  // 3. the EDIT — re-save the EXISTING desk device (the §4 refused shape)
  const devSel = await s.post([["class", "extensions"], ["method", "getDevice"], ["mode", "edit"], ["data[device_id]", String((form.options["device_id"] || []).filter((o: any) => /^\d+$/.test(o.v))[0]?.v)], ["data[extension_id]", String(extId)]]);
  const devFormExisting = parseForm(String((devSel.json as any)?.html ?? devSel.text ?? ""));
  const editOk = await postWithDevice(devFormExisting, { set: { dtmfmode: "rfc4733" } }, "STEP3 existing-device-EDIT");

  // 4. delete + count
  const del = await s.post([["class", "extensions"], ["method", "delete"], ["mode", "delete"], ["data", String(extId)]]);
  let delOk = (del.json as any)?.state === "success" || (del.json as any)?.notification?.type === "success";
  const html = String((del.json as any)?.html || "");
  if (/confirmation-modal/i.test(html)) {
    const pairs: Array<[string, string]> = [];
    for (const mm of html.matchAll(/<input\b[^>]*type=["']hidden["'][^>]*>/gi)) {
      const n = (mm[0].match(/name=["']([^"']+)["']/i) || [])[1];
      const v = (mm[0].match(/value=["']([^"']*)["']/i) || [])[1] || "";
      if (n) pairs.push([n, v]);
    }
    const r2 = await s.post(pairs);
    delOk = (r2.json as any)?.state === "success" || (r2.json as any)?.notification?.type === "success";
  }
  console.log("STEP4 delete:", delOk ? "OK" : "FAILED");
  console.log("VERDICT: create=" + true + " deviceAdd=" + addOk + " existingDeviceEdit=" + editOk);
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
