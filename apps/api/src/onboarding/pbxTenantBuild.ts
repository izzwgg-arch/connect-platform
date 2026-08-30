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

import { provisionTenantEmergency } from "../billing/serviceInterruption/emergencyProvisioning";
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
  /**
   * Unique per-submission tenant name (stored on the submission — see
   * provisioningIdentity.ts). Falls back to slugify(company) for legacy
   * resumes only.
   */
  slug?: string;
  /**
   * Unique per-submission description used on the trunk / outbound route /
   * route selection / tenant. Falls back to the bare company name for legacy
   * resumes only. Two customers can share a company name — matching panel
   * objects by that name alone made the second sign-up ADOPT the first
   * customer's PBX (and the panel rejects duplicate trunk names anyway, so a
   * same-named second build could never even create its own).
   */
  label?: string;
  /**
   * Which carrier this sign-up's number lives on. "voipms" (default, legacy)
   * builds a per-tenant trunk from `voipms{}`; "signalwire" uses the ONE
   * shared "SignalWire loopcom-pbx" trunk in Main (id 132 — inbound arrives
   * there via [trk-132-in]'s exten-s lift into default-trunk, which routes by
   * the tenant's DID list, so no per-customer trunk or subaccount exists).
   */
  numberProvider?: "voipms" | "signalwire";
  /** Required for numberProvider "voipms" (the default); unused for SignalWire. */
  voipms?: { user: string; pass: string; server: string };
  did: string;
  /**
   * Set when the sign-up is porting a number in: the customer's REAL number,
   * which lands on the account only when the carrier releases it. The build
   * prepares the tenant for it from day one — it goes into the tenant's
   * number list, gets its own inbound route ("Main ported"), and is used as
   * the outbound caller ID (callers should see the number the customer is
   * known by, not the temporary one). Port day then needs zero panel work.
   */
  portedDid?: string | null;
  /**
   * The customer's service address, for VitalPBX's native emergency calling.
   *
   * ⛔ Optional ONLY so a legacy resume without one can still finish the build.
   * A tenant with no emergency location cannot be interrupted for non-payment
   * at all — `serviceInterruptionPlan` refuses — so a missing address is a
   * loudly-logged gap, never a silent one.
   * ⛔ `stateId` is `ombutel.states.id` (New York is 3956), resolved by the
   * CALLER: this module talks to the panel only and has no database.
   */
  emergency?: {
    street: string;
    city: string;
    stateId: string;
    zip: string;
    /** Notified alongside the owner when someone dials an emergency number. */
    customerEmail?: string | null;
  } | null;
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

/** Notified when a customer dials an emergency number, alongside the customer
 *  (Izzy, 2026-08-17: "both"). Read from the database, not assumed — the one
 *  SUPER_ADMIN is izzywgg@gmail.com, one letter off the address that appears
 *  in some tooling. */
export const EMERGENCY_NOTIFY_OWNER = process.env.EMERGENCY_NOTIFY_EMAIL || "izzywgg@gmail.com";

export const slugify = (c: string): string =>
  c.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** A porting number as bare 10 digits, or null when absent/garbled. */
function tenDigitsOrNull(v: string | null | undefined): string | null {
  const d = String(v ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? d : null;
}

type Pairs = Array<[string, string | number | null | undefined]>;

// ── Flow steps (field sets are the recorded ones, verbatim) ──────────────────

// Where each object's id is looked up after create (and for idempotent reuse).
// SCOPED to the one select that lists that object type — these forms contain
// several company-named option lists and an unscoped scan grabs the wrong one.
const TRUNK_SELECT = "trklist[]"; // in trunk_group (outbound route) add form
const ROUTE_SELECT = /^members\[\d+\]\[outbound_route_id\]$/; // in ars add form
const ARS_SELECT = "outbound_profiles[]"; // in tenants add form

export async function createTrunk(s: PanelSession, label: string, vm: NonNullable<PbxBuildJob["voipms"]>): Promise<string> {
  // Idempotent resume: if a previous (interrupted) run already created this
  // trunk, reuse it instead of failing on the panel's duplicate-name error.
  // Safe only because the label is unique per submission — matching on the
  // bare company name here made a same-named second customer adopt this one.
  const pre = findOptionInSelect(await s.loadForm("trunk_group", "add"), TRUNK_SELECT, (t) => t.toLowerCase() === label.toLowerCase());
  if (pre) return pre;
  const csrf = await s.ensureCsrf("trunks");
  const p: Pairs = [
    ["trunk_mode", "visual"], ["class", "trunks"], ["method", "put"], ["mode", "add"], ["csfr_token", csrf],
    ["technology", "pjsip"], ["description", label], ["tenant_trunk_id", "2"], ["class_of_service_id", ""], ["cos_id_current", ""],
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
  const id = findOptionInSelect(h, TRUNK_SELECT, (t) => t.toLowerCase() === label.toLowerCase());
  if (!id) throw new PanelStepError("trunk", `trunk "${label}" not found in outbound-route form after create`);
  return id;
}

/**
 * The shared PRIMARY outbound trunk. ⛔ Izzy's rule (2026-08-20): every
 * tenant's outbound route lists this trunk FIRST and the tenant's own VoIP.ms
 * trunk SECOND — carriers are filtering VoIP.ms-originated calls (they were
 * not reaching cell phones), so VoIP.ms is the BACKUP carrier, never the
 * primary. Matched by exact trimmed NAME in the outbound-route form's trunk
 * list, never by a pinned id (ids are per-PBX; the doorway taught us pinned
 * ids go stale silently).
 * ⛔ Emergency calling stays on the tenant's OWN VoIP.ms trunk — that is the
 * account carrying the number's E911 registration; never add this trunk to
 * `provisionTenantEmergency`'s trunkIds.
 */
export const SHARED_PRIMARY_TRUNK_NAME = "0001";

async function findSharedPrimaryTrunkId(s: PanelSession): Promise<string | null> {
  const h = await s.loadForm("trunk_group", "add");
  return findOptionInSelect(h, TRUNK_SELECT, (t) => t.trim() === SHARED_PRIMARY_TRUNK_NAME);
}

/**
 * The ONE shared SignalWire trunk every SignalWire-provisioned tenant dials
 * out through (and whose [trk-132-in] custom block delivers their inbound).
 * Description verified against the live PBX 2026-08-30: trunk 132,
 * "SignalWire loopcom-pbx", tenant 1 (Main). Matched by NAME because panel ids
 * are not stable across PBX rebuilds — the exact trap the doorway's pinned-id
 * env taught (connect_destination_not_found, 2026-08-05).
 */
export const SIGNALWIRE_SHARED_TRUNK_NAME = "SignalWire loopcom-pbx";

async function findSignalWireSharedTrunkId(s: PanelSession): Promise<string | null> {
  const h = await s.loadForm("trunk_group", "add");
  return findOptionInSelect(h, TRUNK_SELECT, (t) => t.trim() === SIGNALWIRE_SHARED_TRUNK_NAME);
}

export async function createOutboundRoute(s: PanelSession, label: string, cidName: string, did: string, trunkIds: string[]): Promise<string> {
  const pre = findOptionInSelect(await s.loadForm("ars", "add"), ROUTE_SELECT, (t) => t.toLowerCase() === label.toLowerCase());
  if (pre) return pre;
  const csrf = await s.ensureCsrf("trunk_group");
  const p: Pairs = [
    ["class", "trunk_group"], ["method", "put"], ["mode", "add"], ["csfr_token", csrf],
    ["description", label],
    // ⛔ ORDER IS THE FEATURE: the panel assigns member `index` from posted
    // order, and Asterisk dials trunks in that order — primary first, backup
    // second. One pair per trunk, exactly as the browser posts a multi-select.
    ...trunkIds.map((id): [string, string] => ["trklist[]", id]),
    ["pin_list_id", ""], ["csv", ""],
    // cid_name is what callees SEE on outbound calls — keep it the clean
    // company name; only the description carries the submission tag.
    ["cid_name", cidName], ["cid_number", did], ["overwrite_cid", "if_not_provided"],
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
  const id = findOptionInSelect(h, ROUTE_SELECT, (t) => t.toLowerCase() === label.toLowerCase());
  if (!id) throw new PanelStepError("outbound-route", `route "${label}" not found in route-selection form after create`);
  return id;
}

export async function createRouteSelection(s: PanelSession, label: string, routeId: string): Promise<string> {
  const pre = findOptionInSelect(await s.loadForm("tenants", "add"), ARS_SELECT, (t) => t.toLowerCase() === label.toLowerCase());
  if (pre) return pre;
  const csrf = await s.ensureCsrf("ars");
  assertSaved(
    "route-selection",
    await s.post([
      ["class", "ars"], ["method", "put"], ["mode", "add"], ["csfr_token", csrf], ["description", label],
      [`members[${PH}][outbound_route_id]`, ""], [`members[${PH}][time_group_id]`, ""], [`members[${PH}][enabled]`, "1"],
      ["members[0][outbound_route_id]", routeId], ["members[0][time_group_id]", ""], ["members[0][enabled]", "1"],
    ]),
  );
  await applyChanges(s, "route-selection");
  const h = await s.loadForm("tenants", "add");
  const id = findOptionInSelect(h, ARS_SELECT, (t) => t.toLowerCase() === label.toLowerCase());
  if (!id) throw new PanelStepError("route-selection", `selection "${label}" not found in tenant form after create`);
  return id;
}

/**
 * Resolve a tenant's 16-hex path hash outside the panel (the VitalPBX REST
 * API's read-only tenants list carries a "path" field). The panel's own
 * tenants form does NOT render path hashes, so a resolver is the reliable
 * source; the HTML scrape below stays only as a last-ditch fallback.
 */
export type TenantPathResolver = (slug: string, label: string) => Promise<string | null>;

/** Scan the tenants page for the slug/label and return its 16-hex path. */
async function findTenantPath(
  s: PanelSession,
  label: string,
  slug: string,
  resolve?: TenantPathResolver,
): Promise<string | null> {
  if (resolve) {
    const viaApi = await resolve(slug, label).catch(() => null);
    if (viaApi && /^[a-f0-9]{16}$/i.test(viaApi)) return viaApi;
  }
  const h = await s.loadForm("tenants", "read");
  for (const m of h.matchAll(/value=["']([a-f0-9]{16})["'][^>]*>([\s\S]{0,120}?)</gi)) {
    const t = decodeEntities(m[2]).trim().toLowerCase();
    if (t === slug || t === label.toLowerCase()) return m[1];
  }
  const m =
    h.match(new RegExp("([a-f0-9]{16})[^a-f0-9]{0,200}?" + slug, "i")) ||
    h.match(new RegExp(slug + "[^a-f0-9]{0,200}?([a-f0-9]{16})", "i"));
  return m ? m[1] : null;
}

/**
 * The mirror: writes the SAME `ombutel` rows the panel writes for a new tenant
 * (see scripts/pbx/mirror/mirror_writes.py::create_tenant, run by the PBX helper's
 * `/mirror/tenant-create`) so the licence-gated panel save never has to run.
 * The unlicensed (Community) panel refuses ONLY "create tenant" — proven on the
 * clone 2026-08-19 (AGENT_HANDOFF_VITALPBX_LICENSE_EXIT_ASSESSMENT §11); every
 * other step of this build (Apply, CSV import, devices, inbound routes, trunks)
 * keeps working, so this is the one step that gets its own code.
 */
export type MirrorTenantCreateArgs = { slug: string; label: string; dids: string[]; arsId: string };
export type MirrorTenantCreator = (args: MirrorTenantCreateArgs) => Promise<{ tenantId: number; path: string }>;
export type MirrorTenantRenderer = (tenantId: number) => Promise<void>;
export type PbxBuildOptions = { tenantCreator?: MirrorTenantCreator | null; tenantRenderer?: MirrorTenantRenderer | null };

async function createTenant(
  s: PanelSession,
  label: string,
  slug: string,
  dids: string[],
  arsId: string,
  resolve?: TenantPathResolver,
  tenantCreator?: MirrorTenantCreator | null,
  log?: (msg: string) => void,
  onCreatedId?: (id: number) => void,
): Promise<string> {
  let createdTenantNumericId = 0;
  const pre = await findTenantPath(s, label, slug, resolve);
  if (pre) return pre;
  if (tenantCreator) {
    // Rows first (one transaction on the PBX), then the panel's own regenerator
    // renders the tenant's files from those rows — same Apply Changes as before,
    // in the NEW tenant's context so its queued base modules are what it renders.
    let made: { tenantId: number; path: string } | null = null;
    try {
      made = await tenantCreator({ slug, label, dids, arsId });
    } catch (e: any) {
      // ⛔ FALLBACK, deliberately loud: while the licence is still active the
      // panel form works, so a helper that is down / not yet upgraded must not
      // stall a paid sign-up. After the licence lapses the panel form refuses
      // ("maximum number of free tenants") and this branch fails the build
      // with THAT message — which is the correct, visible outcome.
      log?.(`⛔ mirror tenant-create failed (${e?.message || e}) — falling back to the panel form`);
      made = null;
    }
    if (made) {
      if (!/^[0-9a-f]{16}$/.test(String(made.path || ""))) {
        throw new PanelStepError("tenant", `mirror tenant-create returned no usable path (${JSON.stringify(made)})`);
      }
      s.setTenant(made.path);
      await applyChanges(s, "tenant");
      for (let attempt = 1; attempt <= 6; attempt++) {
        const tenantPath = await findTenantPath(s, label, slug, resolve);
        if (tenantPath) return tenantPath;
        await new Promise((r) => setTimeout(r, Number(process.env.ONBOARDING_RETRY_BASE_MS || 3000)));
      }
      // The rows are in and Apply ran; the directory lookup is the only thing that
      // lagged — the path we were handed is authoritative.
      if (createdTenantNumericId) onCreatedId?.(createdTenantNumericId);
      return made.path;
    }
  }
  const csrf = await s.ensureCsrf("tenants");
  assertSaved(
    "tenant",
    await s.post([
      ["class", "tenants"], ["method", "put"], ["mode", "add"], ["csfr_token", csrf],
      ["name", slug], ["description", label], ["prefix", ""], ["enabled", "1"],
      ["assign_to_existing_user", ""], ["user_id", "45"], ["user_email", ""], ["user_password", ""], ["full_name", ""], ["role", "4"],
      ["startapp", "dashboard"], ["startapp_custom", ""], ["send_welcome_email", "1"],
      ["settings[extensions]", ""], ["settings[trunks]", ""], ["settings[queues]", ""], ["settings[ivrs]", ""],
      ["settings[conferences]", ""], ["settings[parking_lots]", ""], ["settings[vpbx_devices]", ""], ["settings[allow_recordings]", ""],
      ["recordings_preservation", "60"], ["voicemail_preservation", "30"], ["cdr_preservation", "60"],
      ["outbound_profiles[]", arsId], ["restricted_cid", "disabled"], ["calls_limit", ""], ["inbound_calls_limit", ""],
      ["cid_name", ""], ["cid_number", ""],
      [`inbound_numbers[${PH}][did]`, ""], [`inbound_numbers[${PH}][description]`, ""],
      ...dids.map((d, i): [string, string][] => [
        [`inbound_numbers[${i}][did]`, d],
        [`inbound_numbers[${i}][description]`, ""],
      ]).flat(),
      ["settings[timezone]", "system"],
    ]),
  );
  await applyChanges(s, "tenant");
  // The REST tenants list can lag a beat behind Apply Changes — retry briefly.
  for (let attempt = 1; attempt <= 6; attempt++) {
    const tenantPath = await findTenantPath(s, label, slug, resolve);
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
      // Izzy's rule (2026-08-30): every extension gets 5 contacts on the desk
      // device AND 5 on the WebRTC device. Leaving this column empty takes the
      // ombu_pjsip_devices column default, which is 1 — the whole fleet was
      // backfilled 1→5 the same day.
      max_contacts: "5",
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
export async function extensionId(s: PanelSession, ext: string): Promise<string> {
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

/**
 * Is the WebRTC app device (SIP user "<ext>_1") already on the extension?
 * NEVER substring-scan the edit form for "<ext>_1": device names embed the
 * tenant code, so the base desk device can contain the needle by coincidence
 * ("T101_101" for ext 101 on tenant 101 contains "101_1") and the app device
 * silently never gets created (live 2026-07-29: "Ezra stress test 1" —
 * sip_not_synced). The SIP user is only authoritative in the panel's own
 * getDevice sub-form; look for it there as an exact quoted value.
 */
async function hasWebrtcDevice(s: PanelSession, extId: string, editHtml: string, ext: string): Promise<boolean> {
  const userValue = new RegExp(`value=\\\\?["']${ext}_1\\\\?["']`);
  for (const dev of deviceOptions(editHtml)) {
    const r = await s.post([
      ["class", "extensions"], ["method", "getDevice"], ["mode", "edit"],
      ["data[device_id]", dev.id], ["data[extension_id]", extId],
    ]);
    if (userValue.test(r.text)) return true;
  }
  return false;
}

async function addDevice(s: PanelSession, extId: string, person: PbxPerson, kind: "webrtc" | "cell"): Promise<void> {
  const h = await s.loadForm("extensions", "edit", extId);
  // Resume guard: skip if the device is already on the extension.
  if (kind === "webrtc") {
    if (await hasWebrtcDevice(s, extId, h, person.ext)) return;
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
  // verify the device is now on the extension (same authoritative getDevice
  // check as the resume guard — the edit-form substring lies, see above)
  const h2 = await s.loadForm("extensions", "edit", extId);
  const ok =
    kind === "webrtc"
      ? await hasWebrtcDevice(s, extId, h2, person.ext)
      : await hasCellDevice(s, extId, h2, String(person.cellNumber || ""));
  if (!ok) {
    throw new PanelStepError(`device-${kind}`, `device not found on extension ${person.ext} after save`);
  }
}

export async function createInboundRoute(s: PanelSession, did: string, destExtId: string, description = "Main"): Promise<void> {
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
        ["routing_method", "default"], ["description", description], ["did", did], ["cid_number", ""],
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

// ── One extension on a tenant that already exists ─────────────────────────────

/**
 * Add ONE extension to an ALREADY-BUILT tenant — the everyday "a new person
 * joined" case, which until now had no code path at all.
 *
 * ⛔ This is the ONLY working way to create an extension on this PBX.
 * `POST /pbx/extensions` (server.ts) drives the VitalPBX REST API, which has no
 * extension-create endpoint — our own VitalPbxClient throws NOT_SUPPORTED for
 * it, and the audit log holds zero successful creates in the platform's whole
 * history. Worse, that route writes the Connect Extension row BEFORE calling
 * the PBX, so its failure leaves a billable row for a line that does not exist.
 * Extensions are created HERE, in the panel, and reach Connect afterwards via
 * `POST /pbx/extensions/sync`.
 *
 * ⛔ Extracted from `buildPbxTenant`'s per-person loop, which now calls it — so
 * there is exactly ONE implementation. Do not fork a second one: two
 * near-duplicate publish paths is the recurring defect of this codebase (the
 * two IVR publish paths, the two SMS ingest paths), and a fix applied to one
 * silently skips the other.
 *
 * Idempotent by design, like the loop it came from: an extension that already
 * resolves is adopted rather than re-imported (the panel rejects duplicate
 * imports), and `addDevice` returns early when the device is already present.
 * Safe to re-run after a failure part-way through.
 *
 * Every extension gets PJSIP (from the CSV import) **+ WebRTC**. ⛔ The WebRTC
 * device is not optional: it is what the mobile app and the desktop/portal
 * softphone register as, so an extension without one is a desk-phone-only line
 * however the customer was sold it.
 *
 * ⛔ Fires Apply Changes (whole-PBX regen), exactly as the build loop does.
 * Callers that have database access should follow it with
 * `rebakeConnectRoutesAfterRegen` for every tenant holding Connect-routed
 * numbers — VitalPBX's regenerator cannot render the Connect doorway, and the
 * regen flushes pending changes for OTHER tenants too.
 *
 * @returns the panel's internal extension id (not the extension number).
 */
export async function addExtensionToTenant(
  s: PanelSession,
  tenantPath: string,
  person: PbxPerson,
  log: (msg: string) => void = () => {},
  o: {
    /**
     * Skip THIS extension's Apply Changes, because the caller will run ONE
     * apply for the whole batch. ⛔ Only for batch builds that follow with
     * their own apply: every extension's rows are already in the database, so
     * one apply renders them all — but a caller that skips and never applies
     * leaves lines that exist in the panel and NOT in Asterisk. Added
     * 2026-08-20 (Izzy: onboarding "taking a little long"): a 10-extension
     * build was paying 10 whole-PBX applies at ~15-20 s each where one covers
     * everything, and every extra apply is another chance to flush someone
     * else's pending changes.
     */
    skipApply?: boolean;
  } = {},
): Promise<string> {
  s.setTenant(tenantPath);
  // Resume guard: skip the CSV import when the extension already resolves.
  let extId: string;
  try {
    extId = await extensionId(s, person.ext);
    log(`extension ${person.ext} already existed (id ${extId}) — adopting`);
  } catch {
    await importExtension(s, person);
    extId = await extensionId(s, person.ext);
  }
  await addDevice(s, extId, person, "webrtc"); // always: PJSIP + WebRTC
  if (person.cellNumber && person.cellMode) await addDevice(s, extId, person, "cell");
  if (!o.skipApply) await applyChanges(s, "extensions");
  log(`extension ${person.ext} ${person.name} ok (id ${extId}${person.cellNumber ? `, cell ${person.cellMode}` : ""})`);
  return extId;
}

// ── One whole build ───────────────────────────────────────────────────────────

export async function buildPbxTenant(
  s: PanelSession,
  mainTenant: string,
  job: PbxBuildJob,
  log: (msg: string) => void = () => {},
  resolveTenantPath?: TenantPathResolver,
  opts: PbxBuildOptions = {},
): Promise<PbxBuildResult> {
  const co = job.company;
  // Unique-per-submission identities (legacy resumes fall back to the old
  // company-derived names so they keep matching their existing objects).
  const slug = job.slug || slugify(co);
  const label = String(job.label || co).trim();
  const numberProvider = job.numberProvider === "signalwire" ? "signalwire" : "voipms";
  if (!co || !job.did) {
    throw new PanelStepError("input", "job needs company and did");
  }
  if (numberProvider === "voipms" && (!job.voipms || !job.voipms.user || !job.voipms.pass || !job.voipms.server)) {
    throw new PanelStepError("input", "job needs voipms{user,pass,server} for a VoIP.ms build");
  }
  if (!Array.isArray(job.people) || !job.people.length) {
    throw new PanelStepError("input", "job needs at least one person");
  }

  // A porting sign-up carries the customer's REAL number alongside the
  // temporary one. Callers must see the real number from day one, and both
  // numbers are prepared in the tenant so port day needs zero panel work.
  const portedDid = tenDigitsOrNull(job.portedDid);
  const outboundCid = portedDid || job.did;
  const tenantDids = portedDid ? [job.did, portedDid] : [job.did];

  s.setTenant(mainTenant);
  let trunkId: string;
  let routeTrunkIds: string[];
  if (numberProvider === "signalwire") {
    // ⛔ NO per-tenant trunk on SignalWire — every tenant shares trunk 132.
    // Outbound dials SignalWire FIRST (the customer's number lives there, so
    // their caller ID passes and — once the account's attestation-A grant
    // lands — their calls sign A); the shared "0001" trunk is the backup.
    const swTrunkId = await findSignalWireSharedTrunkId(s);
    if (!swTrunkId) {
      throw new PanelStepError("trunk", `shared SignalWire trunk "${SIGNALWIRE_SHARED_TRUNK_NAME}" not found on the PBX`);
    }
    trunkId = swTrunkId;
    const backupId = await findSharedPrimaryTrunkId(s);
    routeTrunkIds = backupId && backupId !== trunkId ? [trunkId, backupId] : [trunkId];
    log(`using shared SignalWire trunk (id ${trunkId})${backupId ? ` with "${SHARED_PRIMARY_TRUNK_NAME}" backup` : ""} — no per-tenant trunk`);
  } else {
    trunkId = await createTrunk(s, label, job.voipms!);
    log(`trunk ok (id ${trunkId})`);
    // ⛔ The shared "0001" trunk goes FIRST on every outbound route; the
    // tenant's VoIP.ms trunk is the backup (carriers filter VoIP.ms calls).
    // Missing "0001" is NOT fatal — a build that dies here leaves a paid
    // customer with no phone system at all, which is worse than backup-only
    // outbound — but it is loud, and lands on the sign-up timeline.
    const primaryTrunkId = await findSharedPrimaryTrunkId(s);
    if (!primaryTrunkId) {
      log(`⛔ shared primary trunk "${SHARED_PRIMARY_TRUNK_NAME}" not found on the PBX — outbound route carries ONLY the VoIP.ms trunk (carrier-filtered); add "${SHARED_PRIMARY_TRUNK_NAME}" to this route in the panel`);
    }
    routeTrunkIds = primaryTrunkId && primaryTrunkId !== trunkId ? [primaryTrunkId, trunkId] : [trunkId];
  }
  const routeId = await createOutboundRoute(s, label, co, outboundCid, routeTrunkIds);
  log(`outbound route ok (id ${routeId}, caller ID ${outboundCid}${portedDid ? " — the ported number" : ""}, trunks [${routeTrunkIds.join(", ")}])`);
  const arsId = await createRouteSelection(s, label, routeId);
  log(`route selection ok (id ${arsId})`);
  let mirrorTenantId = 0;
  const tenantPath = await createTenant(s, label, slug, tenantDids, arsId, resolveTenantPath, opts.tenantCreator, log, (id) => { mirrorTenantId = id; });
  log(`tenant ok (path ${tenantPath}${opts.tenantCreator ? ", via mirror" : ", via panel"})`);

  // Native emergency calling, so 911 works from day one AND survives the
  // overdue-account cutoff (the dialplan checks T<n>_emergency-calls before it
  // reads the outbound profile, so it needs no carve-out).
  // ⛔ NON-FATAL: a phone system that works is worth more than a build that
  // aborts over a missing zip code. The gap is logged so it can be filled.
  if (job.emergency?.street && job.emergency?.city && job.emergency?.stateId && job.emergency?.zip) {
    try {
      await provisionTenantEmergency(
        s,
        {
          tenantPath,
          companyName: co,
          address: {
            street: job.emergency.street,
            city: job.emergency.city,
            stateId: job.emergency.stateId,
            zip: job.emergency.zip,
          },
          cidNumber: outboundCid,
          trunkIds: [trunkId],
          emailAddresses: [EMERGENCY_NOTIFY_OWNER, job.emergency.customerEmail || ""].filter(Boolean),
        },
        log,
      );
    } catch (e: any) {
      log(`⛔ emergency calling NOT set up: ${e?.message || e} — 911 still works via the carrier, but this tenant cannot be interrupted for non-payment until it is fixed`);
    }
    s.setTenant(tenantPath);
  } else {
    log("⛔ emergency calling skipped — no service address on the sign-up; this tenant cannot be interrupted for non-payment until one is added");
  }

  s.setTenant(tenantPath);
  let firstExtId: string | null = null;
  for (const person of job.people) {
    // ⛔ ONE implementation, shared with the "a new person joined" path. Do not
    // re-inline this loop body — see addExtensionToTenant.
    // ⛔ skipApply is the batch optimisation (2026-08-20): each extension's
    // rows land in the database here, and the ONE apply below renders them
    // all — N extensions used to cost N whole-PBX applies (~15-20 s each,
    // each one a fresh chance to flush another tenant's pending changes).
    const extId = await addExtensionToTenant(s, tenantPath, person, log, { skipApply: true });
    if (!firstExtId) firstExtId = extId;
  }
  // The one apply the loop above deferred. ⛔ MUST stay between the extension
  // loop and the inbound route: without it, a build whose later steps fail
  // would leave every extension unrendered — the per-extension applies used to
  // guarantee incremental progress, and this single apply is that guarantee now.
  await applyChanges(s, "extensions-batch");
  await createInboundRoute(s, job.did, firstExtId as string);
  log(`inbound route ok`);
  if (portedDid) {
    // The ported number's route exists BEFORE the port lands, so completion
    // is only a VoIP.ms repoint — no panel work, nothing to forget.
    await createInboundRoute(s, portedDid, firstExtId as string, "Main ported");
    log(`inbound route for ported number ${portedDid} ok`);
  }
  // ⛔ FINAL RENDER (prod / VitalPBX 4.5.3-1): the mirror rendered the baseline at tenant-create so
  // the panel's incremental Apply could add extensions/routes above; now re-render the tenant's files
  // from the COMPLETE row set so the on-disk config is byte-identical to a panel-made tenant. Skipped
  // for panel-created tenants (VitalPBX rendered them fully) and never fatal — a failed re-render
  // leaves the (working) incrementally-applied files in place and is logged.
  if (opts.tenantRenderer && mirrorTenantId) {
    try {
      await opts.tenantRenderer(mirrorTenantId);
      log(`tenant files re-rendered from final rows (mirror)`);
    } catch (e: any) {
      log(`⚠️ final mirror re-render failed (${e?.message || e}) — the panel-applied files remain in place`);
    }
  }
  return { company: co, slug, tenantPath, trunkId, routeId, arsId, firstExtId: firstExtId as string };
}
