/**
 * pbxTenantBuild.ts — TypeScript port of tools/connect-robot/provision-tenant.js.
 *
 * Builds a complete customer on the VitalPBX panel, replicating Izzy's recorded
 * flow EXACTLY (2026-07-26 recording), nothing more, nothing less:
 *   1. Trunk (VoIP.ms, codecs ulaw,alaw,g726,g729)          → Apply
 *   2. Outbound route (5 patterns, prepend 845 on 7-digit)  → Apply
 *   3. Route selection (ARS)                                → Apply
 *   4. Tenant (outbound profile + DID in the form)          → Apply
 *   5. Per person: extension via CSV (PJSIP, rec+VM on)
 *      + WebRTC device via edit (always)
 *      + cell-phone ("virtual") device (only if cellNumber) → Apply per person
 *   6. Inbound route "Main" (DID → first extension)         → Apply
 *
 * Cell-phone ring modes (wizard: "also rings their cell" / "straight to cell"):
 *   also → desk (PJSIP) + app (WebRTC) + cell device all ring together
 *   only → the cell device rings; desk/app devices are created but don't ring
 *
 * Every save is checked: panel "success" that carries a hidden error dialog is
 * treated as FAILURE and the real error text is reported. Every object is
 * verified to exist (via the panel itself) before the flow continues.
 */

import {
  PanelSession,
  PanelStepError,
  applyChanges,
  assertSaved,
  decodeEntities,
  dropPairs,
  findOption,
  findOptionInSelect,
  parseFormPairs,
  upsertPair,
} from "./panelClient";

const CODECS = ["ulaw", "alaw", "g726", "g729"]; // recorded order
const PH = "{{row-count-placeholder}}";
const CSV_HEADER =
  "mode,extension,ext_name,language,class_of_service,technology,profile_name,device_user,device_password,device_description,devices_emergency_cid_name,devices_emergency_cid_number,virtual_number,ring_device,codecs,max_contacts,features_password,email,did_number,cid_number,call-limit,call_waiting,vm_enabled,vm_password,saycid,sayduration,envelope,attach,delete,ask_password,skip_instructions,outgoing_rec,incoming_rec,external_cid_name,external_cid_number,emergency_cid_name,emergency_cid_number,dial_profile,accountcode,followme_numbers,initial_ringtime,fw_ringtime,ring_strategy,followme-enabled,recname,enable_callee_prompt,internal_numbers_confirmation,dynamic_queues,static_queues,mobile_number,home_number,organization,job_title,send_welcome_email,vitxi_client,mobile_client,notify_missed_calls,callback_on_busy_transfer";

export type PbxPerson = {
  name: string;
  ext: string;
  email?: string;
  vmPassword?: string;
  /** null/undefined = desk & app only; "also" = cell rings too; "only" = straight to cell */
  cellMode?: "also" | "only" | null;
  cellNumber?: string | null;
};

export type PbxBuildJob = {
  company: string;
  voipms: { user: string; pass: string; server: string };
  did: string;
  people: PbxPerson[];
};

export type PbxBuildResult = {
  company: string;
  slug: string;
  tenantPath: string;
  trunkId: string;
  routeId: string;
  arsId: string;
  firstExtId: string;
};

export const slugify = (c: string): string =>
  c.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

type Pairs = Array<[string, string | number | null | undefined]>;

// ── Flow steps (field sets are the recorded ones, verbatim) ──────────────────

// Where each object's id is looked up after create (and for idempotent reuse).
// SCOPED to the one select that lists that object type — these forms contain
// several company-named option lists and an unscoped scan grabs the wrong one.
const TRUNK_SELECT = "trklist[]"; // in trunk_group (outbound route) add form
const ROUTE_SELECT = /^members\[\d+\]\[outbound_route_id\]$/; // in ars add form
const ARS_SELECT = "outbound_profiles[]"; // in tenants add form

async function createTrunk(s: PanelSession, co: string, vm: PbxBuildJob["voipms"]): Promise<string> {
  // Idempotent resume: if a previous (interrupted) run already created this
  // trunk, reuse it instead of failing on the panel's duplicate-name error.
  const pre = findOptionInSelect(await s.loadForm("trunk_group", "add"), TRUNK_SELECT, (t) => t.toLowerCase() === co.toLowerCase());
  if (pre) return pre;
  const csrf = await s.ensureCsrf("trunks");
  const p: Pairs = [
    ["trunk_mode", "visual"], ["class", "trunks"], ["method", "put"], ["mode", "add"], ["csfr_token", csrf],
    ["technology", "pjsip"], ["description", co], ["tenant_trunk_id", "2"], ["class_of_service_id", ""], ["cos_id_current", ""],
    ["ringtimer", "90"], ["dial_profile_id", "1"], ["profile_id", "1"], ["music_group_id", ""],
  ];
  for (const c of CODECS) p.push(["codecs[]", c]);
  p.push(
    ["dtmfmode", "rfc4733"], ["simultaneous_calls", ""], ["nat", ""], ["get_did_from", ""], ["get_cid_from", ""],
    ["trunk_cid_name", ""], ["trunk_cid_number", ""], ["overwrite_cid", "no"], ["dial_prefix", ""],
    ["outgoing[username]", vm.user], ["outgoing_settings", ""], ["outgoing[host]", vm.server], ["outgoing[port]", ""], ["outgoing[secret]", ""],
    ["outgoing[insecure]", ""], ["outgoing[type]", "1"], ["outgoing[transport]", "1"], ["outgoing[contacts]", ""],
    ["outgoing[match]", vm.server], ["outgoing[qualify_frequency]", "30"], ["outgoing[qualify_timeout]", "3"], ["outgoing[max_contacts]", "2"],
    ["outgoing[defaultuser]", vm.user], ["outgoing[remotesecret]", vm.pass], ["outgoing[fromuser]", vm.user], ["outgoing[fromdomain]", vm.server],
    ["outgoing[trunk]", "1"], ["outgoing[qualify]", "1"], ["outgoing[outbound_proxy]", ""], ["outgoing[contact_header]", vm.user], ["outgoing[match_header]", ""],
    ["incoming[username]", ""], ["incoming_settings", ""], ["incoming[host]", ""], ["incoming[secret]", ""], ["incoming[remotesecret]", ""],
    ["incoming[insecure]", ""], ["incoming[trunk]", "1"], ["incoming[qualify]", "1"],
    ["register", ""], ["custom_sip_register", ""], ["custom_iax_register", ""],
    ["outgoing[outbound_registration]", ""], ["outgoing[client_uri]", `sip:${vm.user}@${vm.server}`], ["outgoing[server_uri]", "sip:" + vm.server],
    ["outgoing[contact_user]", ""], ["outgoing[max_retries]", "10"], ["outgoing[expiration]", "3600"], ["outgoing[retry_interval]", "60"], ["outgoing[forbidden_retry_interval]", "10"],
    ["dial_string", ""],
    [`trkcustom[${PH}][type]`, "friend"], [`trkcustom[${PH}][param]`, ""], [`trkcustom[${PH}][value]`, ""], [`trkcustom[${PH}][enabled]`, "1"],
    ["trkcustom[0][type]", "friend"], ["trkcustom[0][param]", ""], ["trkcustom[0][value]", ""], ["trkcustom[0][enabled]", "1"],
    [`trk-headers[${PH}][param]`, ""], [`trk-headers[${PH}][value]`, ""], ["trk-headers[0][param]", ""], ["trk-headers[0][value]", ""],
    [`rules[${PH}][prepend]`, ""], [`rules[${PH}][prefix]`, ""], [`rules[${PH}][pattern]`, ""], [`rules[${PH}][enabled]`, "1"],
    ["rules[0][prepend]", ""], ["rules[0][prefix]", ""], ["rules[0][pattern]", ""], ["rules[0][enabled]", "1"],
  );
  assertSaved("trunk", await s.post(p));
  await applyChanges(s, "trunk");
  const h = await s.loadForm("trunk_group", "add");
  const id = findOptionInSelect(h, TRUNK_SELECT, (t) => t.toLowerCase() === co.toLowerCase());
  if (!id) throw new PanelStepError("trunk", `trunk "${co}" not found in outbound-route form after create`);
  return id;
}

async function createOutboundRoute(s: PanelSession, co: string, did: string, trunkId: string): Promise<string> {
  const pre = findOptionInSelect(await s.loadForm("ars", "add"), ROUTE_SELECT, (t) => t.toLowerCase() === co.toLowerCase());
  if (pre) return pre;
  const csrf = await s.ensureCsrf("trunk_group");
  const p: Pairs = [
    ["class", "trunk_group"], ["method", "put"], ["mode", "add"], ["csfr_token", csrf],
    ["description", co], ["trklist[]", trunkId], ["pin_list_id", ""], ["csv", ""],
    ["cid_name", co], ["cid_number", did], ["overwrite_cid", "if_not_provided"],
    [`trkpattern[${PH}][prepend]`, ""], [`trkpattern[${PH}][prefix]`, ""], [`trkpattern[${PH}][pattern]`, ""], [`trkpattern[${PH}][cid_pattern]`, ""],
    ["trkpattern[0][prepend]", "845"], ["trkpattern[0][prefix]", ""], ["trkpattern[0][pattern]", "nxxxxxx"], ["trkpattern[0][cid_pattern]", ""],
    ["trkpattern[1][prepend]", ""], ["trkpattern[1][prefix]", ""], ["trkpattern[1][pattern]", "nxxnxxxxxx"], ["trkpattern[1][cid_pattern]", ""],
    ["trkpattern[2][prepend]", ""], ["trkpattern[2][prefix]", ""], ["trkpattern[2][pattern]", "1nxxnxxxxxx"], ["trkpattern[2][cid_pattern]", ""],
    ["trkpattern[3][prepend]", ""], ["trkpattern[3][prefix]", ""], ["trkpattern[3][pattern]", "+1nxxnxxxxxx"], ["trkpattern[3][cid_pattern]", ""],
    ["trkpattern[4][prepend]", ""], ["trkpattern[4][prefix]", ""], ["trkpattern[4][pattern]", "011."], ["trkpattern[4][cid_pattern]", ""],
    ["mod_dest", ""], ["destination", ""], ["destination_custom", ""],
  ];
  assertSaved("outbound-route", await s.post(p));
  await applyChanges(s, "outbound-route");
  const h = await s.loadForm("ars", "add");
  const id = findOptionInSelect(h, ROUTE_SELECT, (t) => t.toLowerCase() === co.toLowerCase());
  if (!id) throw new PanelStepError("outbound-route", `route "${co}" not found in route-selection form after create`);
  return id;
}

async function createRouteSelection(s: PanelSession, co: string, routeId: string): Promise<string> {
  const pre = findOptionInSelect(await s.loadForm("tenants", "add"), ARS_SELECT, (t) => t.toLowerCase() === co.toLowerCase());
  if (pre) return pre;
  const csrf = await s.ensureCsrf("ars");
  assertSaved(
    "route-selection",
    await s.post([
      ["class", "ars"], ["method", "put"], ["mode", "add"], ["csfr_token", csrf], ["description", co],
      [`members[${PH}][outbound_route_id]`, ""], [`members[${PH}][time_group_id]`, ""], [`members[${PH}][enabled]`, "1"],
      ["members[0][outbound_route_id]", routeId], ["members[0][time_group_id]", ""], ["members[0][enabled]", "1"],
    ]),
  );
  await applyChanges(s, "route-selection");
  const h = await s.loadForm("tenants", "add");
  const id = findOptionInSelect(h, ARS_SELECT, (t) => t.toLowerCase() === co.toLowerCase());
  if (!id) throw new PanelStepError("route-selection", `selection "${co}" not found in tenant form after create`);
  return id;
}

/**
 * Resolve a tenant's 16-hex path hash outside the panel (the VitalPBX REST
 * API's read-only tenants list carries a "path" field). The panel's own
 * tenants form does NOT render path hashes, so a resolver is the reliable
 * source; the HTML scrape below stays only as a last-ditch fallback.
 */
export type TenantPathResolver = (slug: string, company: string) => Promise<string | null>;

/** Scan the tenants page for the slug/company and return its 16-hex path. */
async function findTenantPath(
  s: PanelSession,
  co: string,
  slug: string,
  resolve?: TenantPathResolver,
): Promise<string | null> {
  if (resolve) {
    const viaApi = await resolve(slug, co).catch(() => null);
    if (viaApi && /^[a-f0-9]{16}$/i.test(viaApi)) return viaApi;
  }
  const h = await s.loadForm("tenants", "read");
  for (const m of h.matchAll(/value=["']([a-f0-9]{16})["'][^>]*>([\s\S]{0,120}?)</gi)) {
    const t = decodeEntities(m[2]).trim().toLowerCase();
    if (t === slug || t === co.toLowerCase()) return m[1];
  }
  const m =
    h.match(new RegExp("([a-f0-9]{16})[^a-f0-9]{0,200}?" + slug, "i")) ||
    h.match(new RegExp(slug + "[^a-f0-9]{0,200}?([a-f0-9]{16})", "i"));
  return m ? m[1] : null;
}

async function createTenant(
  s: PanelSession,
  co: string,
  slug: string,
  did: string,
  arsId: string,
  resolve?: TenantPathResolver,
): Promise<string> {
  const pre = await findTenantPath(s, co, slug, resolve);
  if (pre) return pre;
  const csrf = await s.ensureCsrf("tenants");
  assertSaved(
    "tenant",
    await s.post([
      ["class", "tenants"], ["method", "put"], ["mode", "add"], ["csfr_token", csrf],
      ["name", slug], ["description", co], ["prefix", ""], ["enabled", "1"],
      ["assign_to_existing_user", ""], ["user_id", "45"], ["user_email", ""], ["user_password", ""], ["full_name", ""], ["role", "4"],
      ["startapp", "dashboard"], ["startapp_custom", ""], ["send_welcome_email", "1"],
      ["settings[extensions]", ""], ["settings[trunks]", ""], ["settings[queues]", ""], ["settings[ivrs]", ""],
      ["settings[conferences]", ""], ["settings[parking_lots]", ""], ["settings[vpbx_devices]", ""], ["settings[allow_recordings]", ""],
      ["recordings_preservation", "60"], ["voicemail_preservation", "30"], ["cdr_preservation", "60"],
      ["outbound_profiles[]", arsId], ["restricted_cid", "disabled"], ["calls_limit", ""], ["inbound_calls_limit", ""],
      ["cid_name", ""], ["cid_number", ""],
      [`inbound_numbers[${PH}][did]`, ""], [`inbound_numbers[${PH}][description]`, ""],
      ["inbound_numbers[0][did]", did], ["inbound_numbers[0][description]", ""],
      ["settings[timezone]", "system"],
    ]),
  );
  await applyChanges(s, "tenant");
  // The REST tenants list can lag a beat behind Apply Changes — retry briefly.
  for (let attempt = 1; attempt <= 6; attempt++) {
    const tenantPath = await findTenantPath(s, co, slug, resolve);
    if (tenantPath) return tenantPath;
    await new Promise((r) => setTimeout(r, Number(process.env.ONBOARDING_RETRY_BASE_MS || 3000)));
  }
  throw new PanelStepError("tenant", `tenant "${slug}" created but its path was not found — cannot switch into it`);
}

async function importExtension(s: PanelSession, person: PbxPerson): Promise<void> {
  const cols = CSV_HEADER.split(",");
  const rowOf = (o: Record<string, string>) => cols.map((c) => (o[c] != null ? String(o[c]) : "")).join(",");
  const straightToCell = person.cellMode === "only";
  const csv =
    CSV_HEADER +
    "\n" +
    rowOf({
      mode: "add",
      extension: person.ext,
      ext_name: person.name,
      class_of_service: "all",
      technology: "pjsip",
      profile_name: "Default PJSIP Profile",
      device_user: person.ext,
      // "straight to cell": desk device exists but doesn't ring
      ring_device: straightToCell ? "no" : "",
      email: person.email || "",
      outgoing_rec: "yes",
      incoming_rec: "yes",
      vm_enabled: "yes",
      vm_password: person.vmPassword || "",
    }) +
    "\n";
  const csrf = await s.ensureCsrf("menu4");
  const fd = new FormData();
  fd.append("class", "menu4");
  fd.append("method", "put");
  fd.append("mode", "add");
  fd.append("csfr_token", String(csrf ?? ""));
  fd.append("csv", new Blob([csv], { type: "text/csv" }), "import_extensions.csv");
  const r = await s.postForm(fd);
  const note = (r.json && r.json.notification && r.json.notification.text) || "";
  if (!/completed successfully/i.test(note)) {
    throw new PanelStepError("extension-import", `ext ${person.ext}: ${note || "import failed"}`);
  }
}

/** Same lookup the panel makes for inbound-route destinations. */
async function extensionId(s: PanelSession, ext: string): Promise<string> {
  const { text } = await s.post([
    ["class", "inbound_route"], ["method", "getDestinationChildOptions"], ["mode", "view"],
    ["data[selected]", "1"], ["data[parent]", "inbound_route-mod_dest"], ["data[child]", "inbound_route-destination"],
  ]);
  const matcher = new RegExp("(^|\\D)" + ext + "(\\D|$)");
  let h = text;
  try {
    const j = JSON.parse(text);
    // Production shape (verified live): {"state":"success","html":"","action":
    // "dependentCombo","options":[{"content":"101 - machela","value":201},…]}.
    if (Array.isArray(j?.options)) {
      for (const o of j.options) {
        if (o && o.value !== "" && matcher.test(String(o.content ?? ""))) return String(o.value);
      }
    }
    h = typeof (j.html || j.options) === "string" ? j.html || j.options : JSON.stringify(j);
  } catch {
    /* raw HTML */
  }
  // Fallback: scrape <option> markup if the panel ever answers with HTML.
  h = h.replace(/\\"/g, '"').replace(/\\\//g, "/");
  for (const m of h.matchAll(/value=["'](\d+)["'][^>]*>([^<]*)/gi)) {
    if (matcher.test(m[2])) return m[1];
  }
  throw new PanelStepError("extension-import", `extension ${ext} not visible in destination list after import`);
}

/** Device options in the extension edit form's device_id dropdown. */
function deviceOptions(html: string): Array<{ id: string; label: string }> {
  const sel = html.match(/<select[^>]*name=["']device_id["'][\s\S]*?<\/select>/i);
  if (!sel) return [];
  const out: Array<{ id: string; label: string }> = [];
  for (const m of sel[0].matchAll(/<option[^>]*value=["'](\d+)["'][^>]*>([\s\S]*?)<\/option>/gi)) {
    out.push({ id: m[1], label: decodeEntities(m[2]).trim() });
  }
  return out;
}

/**
 * Is a cell ("virtual") device with this number already on the extension?
 * The panel labels virtual devices by DESCRIPTION ONLY — the cell number never
 * appears in the edit-form HTML (live incident 2026-07-26: the device saved
 * fine but the old marker check declared failure and killed the pipeline).
 * The number is only visible through the panel's own getDevice call.
 */
async function hasCellDevice(s: PanelSession, extId: string, editHtml: string, cellNumber: string): Promise<boolean> {
  if (!cellNumber) return false;
  for (const dev of deviceOptions(editHtml)) {
    const r = await s.post([
      ["class", "extensions"], ["method", "getDevice"], ["mode", "edit"],
      ["data[device_id]", dev.id], ["data[extension_id]", extId],
    ]);
    if (r.text.includes(cellNumber)) return true;
  }
  return false;
}

async function addDevice(s: PanelSession, extId: string, person: PbxPerson, kind: "webrtc" | "cell"): Promise<void> {
  const h = await s.loadForm("extensions", "edit", extId);
  // Resume guard: skip if the device is already on the extension.
  if (kind === "webrtc") {
    if (h.includes(person.ext + "_1")) return; // device label carries the SIP user
  } else if (await hasCellDevice(s, extId, h, String(person.cellNumber || ""))) {
    return;
  }
  let pairs = parseFormPairs(h);
  pairs = dropPairs(pairs, "dynamic_queues[]", "static_queues[]");
  upsertPair(pairs, "class", "extensions");
  upsertPair(pairs, "method", "put");
  upsertPair(pairs, "mode", "edit");
  upsertPair(pairs, "device_id", "new");
  upsertPair(pairs, "dev_description", person.name);
  if (kind === "webrtc") {
    const webrtcProfile = findOption(h, (t) => /webrtc/i.test(t)) || "12";
    // "straight to cell": app device exists but doesn't ring
    upsertPair(pairs, "ring_device", person.cellMode === "only" ? "no" : "yes");
    upsertPair(pairs, "technology", "pjsip");
    upsertPair(pairs, "profile_id", webrtcProfile);
    upsertPair(pairs, "user", person.ext + "_1");
    upsertPair(pairs, "max_contacts", "5");
    upsertPair(pairs, "vitxi_client", "1");
  } else {
    // cell phone — recorded "virtual" device: no profile/vitxi/max_contacts, dtmf rfc2833
    pairs = dropPairs(pairs, "profile_id", "vitxi_client", "max_contacts");
    upsertPair(pairs, "ring_device", "yes");
    upsertPair(pairs, "technology", "virtual");
    upsertPair(pairs, "number", String(person.cellNumber || ""));
    upsertPair(pairs, "user", person.ext + "_2");
    upsertPair(pairs, "dtmfmode", "rfc2833");
  }
  assertSaved(`device-${kind}`, await s.post(pairs));
  // verify the device is now on the extension
  const h2 = await s.loadForm("extensions", "edit", extId);
  const ok =
    kind === "webrtc"
      ? h2.includes(person.ext + "_1")
      : await hasCellDevice(s, extId, h2, String(person.cellNumber || ""));
  if (!ok) {
    throw new PanelStepError(`device-${kind}`, `device not found on extension ${person.ext} after save`);
  }
}

async function createInboundRoute(s: PanelSession, did: string, destExtId: string): Promise<void> {
  // Resume guard: if the DID already shows on the inbound-routes page, a
  // previous run created the route — don't create a duplicate.
  try {
    const existing = await s.loadForm("inbound_route", "read");
    if (existing.includes(did)) return;
  } catch {
    /* page not scannable — fall through and create */
  }
  const csrf = await s.ensureCsrf("menu29");
  try {
    assertSaved(
      "inbound-route",
      await s.post([
        ["class", "inbound_route"], ["method", "put"], ["mode", "add"], ["csfr_token", csrf],
        ["routing_method", "default"], ["description", "Main"], ["did", did], ["cid_number", ""],
        ["cid_management_id", ""], ["cid_lookup_id", ""], ["language", "en"], ["music_group_id", ""], ["alertinfo", ""],
        ["pmmaxretries", "3"], ["pmminlength", "10"], ["detectiontime", "5"],
        ["fax_mod_dest", ""], ["fax_destination", ""], ["fax_destination_custom", ""],
        ["mod_dest", "1"], ["destination", destExtId], ["digits_to_take", "1"], ["cos_id", ""], ["prepend", ""], ["append", ""],
      ]),
    );
  } catch (e: any) {
    // The read-page guard above cannot see existing routes (the panel loads
    // that list via a separate request), so a resumed build reaches this
    // create with the route already in place and the panel rejects it as a
    // duplicate ("description is already in use" / "inbound route <did>/Any
    // CID already exist" — live 2026-07-28/29). That rejection IS the
    // desired end state: the route exists. Adopt it instead of failing.
    if (/already (in use|exists?)/i.test(String(e?.message || ""))) return;
    throw e;
  }
  await applyChanges(s, "inbound-route");
}

// ── One whole build ───────────────────────────────────────────────────────────

export async function buildPbxTenant(
  s: PanelSession,
  mainTenant: string,
  job: PbxBuildJob,
  log: (msg: string) => void = () => {},
  resolveTenantPath?: TenantPathResolver,
): Promise<PbxBuildResult> {
  const co = job.company;
  const slug = slugify(co);
  if (!co || !job.did || !job.voipms || !job.voipms.user || !job.voipms.pass || !job.voipms.server) {
    throw new PanelStepError("input", "job needs company, did, voipms{user,pass,server}");
  }
  if (!Array.isArray(job.people) || !job.people.length) {
    throw new PanelStepError("input", "job needs at least one person");
  }

  s.setTenant(mainTenant);
  const trunkId = await createTrunk(s, co, job.voipms);
  log(`trunk ok (id ${trunkId})`);
  const routeId = await createOutboundRoute(s, co, job.did, trunkId);
  log(`outbound route ok (id ${routeId})`);
  const arsId = await createRouteSelection(s, co, routeId);
  log(`route selection ok (id ${arsId})`);
  const tenantPath = await createTenant(s, co, slug, job.did, arsId, resolveTenantPath);
  log(`tenant ok (path ${tenantPath})`);

  s.setTenant(tenantPath);
  let firstExtId: string | null = null;
  for (const person of job.people) {
    // Resume guard: skip the CSV import when the extension already resolves
    // (the panel rejects duplicate imports).
    let extId: string;
    try {
      extId = await extensionId(s, person.ext);
    } catch {
      await importExtension(s, person);
      extId = await extensionId(s, person.ext);
    }
    if (!firstExtId) firstExtId = extId;
    await addDevice(s, extId, person, "webrtc"); // always: PJSIP + WebRTC
    if (person.cellNumber && person.cellMode) await addDevice(s, extId, person, "cell");
    await applyChanges(s, "extensions");
    log(`extension ${person.ext} ${person.name} ok (id ${extId}${person.cellNumber ? `, cell ${person.cellMode}` : ""})`);
  }
  await createInboundRoute(s, job.did, firstExtId as string);
  log(`inbound route ok`);
  return { company: co, slug, tenantPath, trunkId, routeId, arsId, firstExtId: firstExtId as string };
}
