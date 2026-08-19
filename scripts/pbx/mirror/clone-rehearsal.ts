/* Lapse rehearsal against the VitalPBX CLONE (unlicensed) — drives Connect's REAL panel code path.
 * Run from repo root:  NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx <this file> <step>
 * Never points at the live PBX: base is the SSH tunnel to the clone.
 */
import { PanelSession, applyChanges, assertSaved, dialogErrors } from "../../../apps/api/src/onboarding/panelClient";
import { addExtensionToTenant } from "../../../apps/api/src/onboarding/pbxTenantBuild";

const BASE = process.env.CLONE_PANEL_BASE || "https://127.0.0.1:18443";
const USER = process.env.CONNECT_ROBOT_USER || "";
const PASS = process.env.CONNECT_ROBOT_PASS || "";
if (!USER || !PASS) throw new Error("set CONNECT_ROBOT_USER/PASS in env (from loopcom /etc/connect-robot/credentials.env)");

const T104_PATH = "4de9a88870cd2add"; // Matamim, over-cap tenant (1 ext)
const T107_PATH = process.env.T107_PATH || "7a580dbe87102f18";
const MAIN_PATH = "2dc3974017c1bc65"; // Main tenant

async function main() {
  const step = process.argv[2] || "add-ext-t104";
  const s = new PanelSession(BASE, { id: "robot", user: USER, pass: PASS });
  await s.login();
  console.log("logged in, home tenant", s.homeTenant);
  const log = (m: string) => console.log("  [log]", m);
  try {
    if (step === "add-ext-t104") {
      const id = await addExtensionToTenant(s, T104_PATH, { name: "Lapse Test", ext: "199", email: "" }, log);
      console.log("RESULT add-ext-t104: created id", id);
    } else if (step === "add-ext-main") {
      const id = await addExtensionToTenant(s, MAIN_PATH, { name: "Lapse Test Main", ext: "199", email: "" }, log);
      console.log("RESULT add-ext-main: created id", id);
    } else if (step === "apply") {
      s.setTenant(T104_PATH);
      await applyChanges(s, "rehearsal");
      console.log("RESULT apply: ok");
    } else if (step === "apply-main") {
      s.setTenant(MAIN_PATH);
      await applyChanges(s, "rehearsal-main");
      console.log("RESULT apply-main: ok");
    } else {
      throw new Error("unknown step " + step);
    }
  } catch (e: any) {
    console.log("RESULT " + step + ": FAILED —", e?.message || e);
    if (e?.response) console.log(JSON.stringify(e.response).slice(0, 1200));
  }
}
if (!process.argv[2]?.startsWith("raw-import") && !["create-tenant","ring-group","forward","inbound-route","main-trunk-chain","add-ext-t107","apply-t107","did-mgmt-t107","tenant-edit-t107","build-mirror"].includes(process.argv[2] || "")) main().catch((e) => { console.error(e); process.exit(1); });

// raw CSV import to see the panel's actual answer (same bytes importExtension sends)
export async function rawImport(s: PanelSession, tenantPath: string, ext: string, name: string) {
  const CSV_HEADER = "mode,extension,ext_name,language,class_of_service,technology,profile_name,device_user,device_password,device_description,devices_emergency_cid_name,devices_emergency_cid_number,virtual_number,ring_device,codecs,max_contacts,features_password,email,did_number,cid_number,call-limit,call_waiting,vm_enabled,vm_password,saycid,sayduration,envelope,attach,delete,ask_password,skip_instructions,outgoing_rec,incoming_rec,external_cid_name,external_cid_number,emergency_cid_name,emergency_cid_number,dial_profile,accountcode,followme_numbers,initial_ringtime,fw_ringtime,ring_strategy,followme-enabled,recname,enable_callee_prompt,internal_numbers_confirmation,dynamic_queues,static_queues,mobile_number,home_number,organization,job_title,send_welcome_email,vitxi_client,mobile_client,notify_missed_calls,callback_on_busy_transfer";
  s.setTenant(tenantPath);
  const cols = CSV_HEADER.split(",");
  const o: Record<string, string> = { mode: "add", extension: ext, ext_name: name, class_of_service: "all", technology: "pjsip", profile_name: "Default PJSIP Profile", device_user: ext, incoming_rec: "yes", outgoing_rec: "yes", vm_enabled: "yes" };
  const csv = CSV_HEADER + "\n" + cols.map((c) => o[c] ?? "").join(",") + "\n";
  const csrf = await s.ensureCsrf("menu4");
  const fd = new FormData();
  fd.append("class", "menu4"); fd.append("method", "put"); fd.append("mode", "add"); fd.append("csfr_token", String(csrf ?? ""));
  fd.append("csv", new Blob([csv], { type: "text/csv" }), "import_extensions.csv");
  const r = await s.postForm(fd);
  console.log("RAW IMPORT RESPONSE:", (r.text || "").slice(0, 1500));
}
if (process.argv[2] === "raw-import-t104" || process.argv[2] === "raw-import-main") {
  (async () => {
    const s = new PanelSession(BASE, { id: "robot", user: USER, pass: PASS });
    await s.login();
    await rawImport(s, process.argv[2].endsWith("main") ? MAIN_PATH : T104_PATH, "199", "Lapse Test");
  })();
}

// tenant create on the unlicensed clone — the "maximum number of free tenants" gate
if (process.argv[2] === "create-tenant") {
  (async () => {
    const s = new PanelSession(BASE, { id: "robot", user: USER, pass: PASS });
    await s.login();
    s.setTenant(MAIN_PATH);
    const csrf = await s.ensureCsrf("tenants");
    const PH = "{{row-count-placeholder}}";
    const r = await s.post([
      ["class", "tenants"], ["method", "put"], ["mode", "add"], ["csfr_token", String(csrf ?? "")],
      ["name", "lapse_rehearsal"], ["description", "Lapse Rehearsal"], ["prefix", ""], ["enabled", "1"],
      ["assign_to_existing_user", ""], ["user_id", "45"], ["user_email", ""], ["user_password", ""], ["full_name", ""], ["role", "4"],
      ["startapp", "dashboard"], ["startapp_custom", ""], ["send_welcome_email", "1"],
      ["settings[extensions]", ""], ["settings[trunks]", ""], ["settings[queues]", ""], ["settings[ivrs]", ""],
      ["settings[conferences]", ""], ["settings[parking_lots]", ""], ["settings[vpbx_devices]", ""], ["settings[allow_recordings]", ""],
      ["recordings_preservation", "60"], ["voicemail_preservation", "30"], ["cdr_preservation", "60"],
      ["outbound_profiles[]", "214"], ["restricted_cid", "disabled"], ["calls_limit", ""], ["inbound_calls_limit", ""],
      ["cid_name", ""], ["cid_number", ""],
      [`inbound_numbers[${PH}][did]`, ""], [`inbound_numbers[${PH}][description]`, ""],
      ["settings[timezone]", "system"],
    ]);
    const j: any = r.json || {};
    const txt = (r.text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    console.log("CREATE TENANT state=", j.state, "action=", j.action, "notification=", JSON.stringify(j.notification || null));
    const m = txt.match(/(maximum number[^.]{0,120}|Activate this add-on[^.]{0,120}|exception[^.]{0,200}|error[^.]{0,160})/i);
    console.log("TEXT:", m ? m[0] : txt.slice(0, 300));
  })();
}

// ring group + forward + inbound route on the over-cap tenant; trunk/outbound route/ARS in Main
if (["ring-group", "forward", "inbound-route", "main-trunk-chain"].includes(process.argv[2] || "")) {
  (async () => {
    const s = new PanelSession(BASE, { id: "robot", user: USER, pass: PASS });
    await s.login();
    const step = process.argv[2];
    try {
      if (step === "ring-group") {
        const { createRingGroup, LAST_DESTINATION_CATEGORIES } = await import("../../../apps/api/src/pbx/teamBuilder");
        s.setTenant(T104_PATH);
        const r = await createRingGroup(s, { name: "Lapse RG", strategy: "ringall", members: [{ extensionId: "400" }, { extensionId: "408" }], ringTime: 20, lastDestination: { categoryId: LAST_DESTINATION_CATEGORIES.extension, targetId: "400" } }, { extensions: ["101", "199"], ringGroups: [], queues: [] });
        console.log("RESULT ring-group:", JSON.stringify(r));
      } else if (step === "forward") {
        const { createForward } = await import("../../../apps/api/src/pbx/forwardBuilder");
        s.setTenant(T104_PATH);
        const r = await createForward(s, { description: "Lapse forward", phoneNumber: "8457231213" }, { extensions: ["101", "199"], ringGroups: [], queues: [] }, []);
        console.log("RESULT forward:", JSON.stringify(r));
      } else if (step === "inbound-route") {
        const { createInboundRoute } = await import("../../../apps/api/src/onboarding/pbxTenantBuild");
        s.setTenant(T104_PATH);
        await createInboundRoute(s, "8455550199", "408", "Lapse route");
        console.log("RESULT inbound-route: ok");
      } else if (step === "main-trunk-chain") {
        // buildPbxTenant would run trunk → outbound route → ARS → tenant(refused). Drive just the chain via its exported wrapper if any; else replay.
        const mod: any = await import("../../../apps/api/src/onboarding/pbxTenantBuild");
        const fn = mod.buildPbxTenant;
        const log = (m: string) => console.log("  [log]", m);
        await fn(s, MAIN_PATH, { company: "Lapse Rehearsal Co", slug: "lapse_rehearsal", label: "Lapse Rehearsal Co lapse1", voipms: { user: "344022_lapse", pass: "x", server: "newyork1.voip.ms" }, did: "8455550199", people: [{ name: "Owner", ext: "101" }] }, log);
        console.log("RESULT main-trunk-chain: buildPbxTenant returned (unexpected)");
      }
    } catch (e: any) {
      console.log("RESULT " + step + ": FAILED —", (e?.message || String(e)).slice(0, 600));
    }
  })();
}
if (process.argv[2] === "add-ext-t107") {
  (async () => {
    const s = new PanelSession(BASE, { id: "robot", user: USER, pass: PASS });
    await s.login();
    try {
      const id = await addExtensionToTenant(s, T107_PATH, { name: "Mirror One", ext: "101", email: "" }, (m) => console.log("  [log]", m));
      console.log("RESULT add-ext-t107: created id", id);
    } catch (e: any) { console.log("RESULT add-ext-t107: FAILED —", (e?.message || String(e)).slice(0, 600)); }
  })();
}
if (process.argv[2] === "apply-t107") {
  (async () => {
    const s = new PanelSession(BASE, { id: "robot", user: USER, pass: PASS });
    await s.login(); s.setTenant(T107_PATH);
    try { await applyChanges(s, "t107"); console.log("RESULT apply-t107: ok"); } catch (e: any) { console.log("RESULT apply-t107: FAILED —", (e?.message || String(e)).slice(0, 400)); }
  })();
}
if (process.argv[2] === "did-mgmt-t107" || process.argv[2] === "tenant-edit-t107") {
  (async () => {
    const s = new PanelSession(BASE, { id: "robot", user: USER, pass: PASS });
    await s.login(); s.setTenant(MAIN_PATH);
    if (process.argv[2] === "did-mgmt-t107") {
      const csrf = await s.ensureCsrf("did_management");
      const r = await s.post([["class", "did_management"], ["method", "put"], ["mode", "add"], ["csfr_token", String(csrf ?? "")], ["did", "8455550107"], ["description", "Lapse Mirror DID"], ["tenant", "107"]]);
      const j: any = r.json || {}; console.log("RESULT did-mgmt-t107:", j.state, j.action, JSON.stringify(j.notification || null), (r.text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").match(/(maximum[^.]{0,120}|Activate[^.]{0,120}|exception[^.]{0,200}|error[^.]{0,120})/i)?.[0] || "");
    } else {
      // tenant EDIT: load the edit form for tenant 107 and resubmit it with one more inbound number
      const { parseFormPairs } = await import("../../../apps/api/src/onboarding/panelClient");
      const h = await s.loadForm("tenants", "edit", 107);
      const pairs = parseFormPairs(h);
      const csrf = await s.ensureCsrf("tenants");
      const filtered = pairs.filter(([k]) => !/^inbound_numbers\[\{\{/.test(k));
      const n = filtered.filter(([k]) => /^inbound_numbers\[\d+\]\[did\]$/.test(k)).length;
      const body: [string, string][] = [["class", "tenants"], ["method", "put"], ["mode", "edit"], ["csfr_token", String(csrf ?? "")], ...filtered.filter(([k]) => !["class", "method", "mode", "csfr_token"].includes(k)), [`inbound_numbers[${n}][did]`, "8455550117"], [`inbound_numbers[${n}][description]`, "edit test"]];
      const r = await s.post(body);
      const j: any = r.json || {}; console.log("RESULT tenant-edit-t107:", j.state, j.action, JSON.stringify(j.notification || null), (r.text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").match(/(maximum[^.]{0,120}|Activate[^.]{0,120}|exception[^.]{0,200}|<li[^<]*)/i)?.[0] || "", "form pairs:", pairs.length);
    }
  })();
}

// END-TO-END on the clone: buildPbxTenant with the MIRROR tenant creator (mirror_writes.py inside the clone container)
if (process.argv[2] === "build-mirror") {
  (async () => {
    const { execFileSync } = await import("node:child_process");
    const { buildPbxTenant } = await import("../../../apps/api/src/onboarding/pbxTenantBuild");
    const s = new PanelSession(BASE, { id: "robot", user: USER, pass: PASS });
    await s.login();
    const suffix = process.env.E2E_SUFFIX || "e2e1";
    const creator = async (args: { slug: string; label: string; dids: string[]; arsId: string }) => {
      const cmd = ["docker", "exec", "vpbx-clone", "python3", "/clone/mirror/mirror_writes.py", "--socket", "/run/mysqld/mysqld.sock", "--user", "root", "--password", "", "--apply", "create-tenant",
        "--description", args.label, "--name", args.slug, "--dids", args.dids.join(","), "--outbound-profiles", String(args.arsId), "--json", "--fs"].map((x) => JSON.stringify(x)).join(" ");
      const out = execFileSync("ssh", ["-i", ".connect-ssh/connect2_ed25519", "-o", "IdentitiesOnly=yes", "root@45.14.194.179", cmd], { encoding: "utf8" });
      const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop() || "{}";
      const j = JSON.parse(line);
      console.log("  [mirror] created tenant", j.tenantId, j.path, "rows", JSON.stringify(j.rows), "fs", JSON.stringify(j.fs));
      return { tenantId: Number(j.tenantId), path: String(j.path) };
    };
    try {
      const r = await buildPbxTenant(s, MAIN_PATH, {
        company: "Mirror E2E Co", slug: "mirror_e2e_" + suffix, label: "Mirror E2E Co " + suffix,
        voipms: { user: "344022_mirror" + suffix, pass: "x", server: "newyork1.voip.ms" }, did: "8455550" + String(100 + (suffix.length % 900)).slice(-3),
        people: [{ name: "Owner One", ext: "101", email: "" }, { name: "Second Two", ext: "102", email: "" }],
      } as any, (m) => console.log("  [log]", m), undefined, { tenantCreator: creator });
      console.log("RESULT build-mirror:", JSON.stringify(r));
    } catch (e: any) { console.log("RESULT build-mirror: FAILED —", (e?.message || String(e)).slice(0, 800)); }
  })();
}
