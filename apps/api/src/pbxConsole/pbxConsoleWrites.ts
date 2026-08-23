/**
 * PBX Console — WRITES to the phone system.
 *
 * Every write here replays the VitalPBX panel's own request for that action,
 * from a robot session, in the right tenant context — the same road
 * onboarding has driven in production since July (`pbxTenantBuild.ts`). The
 * panel does its own bookkeeping (destination rows, numbers table, queued
 * changes) and its own validation, and answers with the same error dialogs a
 * person would see, which `assertSaved` turns into a thrown message.
 *
 * ⛔ Save ≠ live. Like the panel, a save writes the database; "Apply" renders
 * it into Asterisk. `applyAndRebake()` is the ONLY apply here, and it always
 * re-bakes the Connect doorway on every Connect-routed number afterwards —
 * VitalPBX's regenerator cannot render the doorway, and a forward save once
 * left a customer's every number on dead air for six minutes (2026-08-13).
 *
 * ⛔ Nothing here touches a tenant it was not asked about: every panel write is
 * preceded by `setTenant(<that tenant's path>)`, and every delete verifies by
 * re-reading before it reports success.
 */
import {
  applyChanges,
  assertSaved,
  PanelStepError,
  type PanelSession,
} from "../onboarding/panelClient";
import { extensionId as lookupExtensionIdByNumber } from "../onboarding/pbxTenantBuild";
import { rebakeConnectRoutesAfterRegen } from "../pbx/applyRegenRebake";
import { applyOverrides, loadParsedForm, parseForm, type FormOverrides, type ParsedForm } from "./panelForm";

export const MAIN_TENANT_PATH_DEFAULT = "2dc3974017c1bc65";

/* ── generic two-step delete (the panel's confirmation modal) ─────────────── */

/**
 * The panel deletes in two steps: `method=delete` returns a confirmation modal
 * whose hidden inputs carry the real request (`mode=deleteConfirmed`); posting
 * those verbatim is the delete. A single step returns "success" and deletes
 * NOTHING (two 2026-07-27 wipes proved it). Same shape as teamBuilder.deleteTeam.
 */
export async function panelDelete(s: PanelSession, cls: string, id: string | number, label: string): Promise<void> {
  const r = await s.post([["class", cls], ["method", "delete"], ["mode", "delete"], ["data", String(id)]]);
  const html = String(r.json?.html || "");
  if (/module-error-list/i.test(html)) {
    const items = (html.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || []).map((x) => x.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
    throw new PanelStepError(`delete-${cls}`, `${label}: the phone system refused: ${items.join(" | ") || "unknown reason"}`);
  }
  if (r.json?.notification?.type === "error") {
    throw new PanelStepError(`delete-${cls}`, `${label}: ${String(r.json.notification.text || "error").replace(/<[^>]+>/g, " ")}`);
  }
  if (!/confirmation-modal/i.test(html)) {
    throw new PanelStepError(`delete-${cls}`, `${label}: unexpected delete response: ${r.text.slice(0, 200)}`);
  }
  const pairs: Array<[string, string]> = [];
  for (const m of html.matchAll(/<input\b[^>]*type=["']hidden["'][^>]*>/gi)) {
    const n = (m[0].match(/name=["']([^"']+)["']/i) || [])[1];
    const v = (m[0].match(/value=["']([^"']*)["']/i) || [])[1] || "";
    if (n) pairs.push([n, v]);
  }
  const r2 = await s.post(pairs);
  if (r2.json?.notification?.type !== "success") {
    throw new PanelStepError(`delete-${cls}`, `${label}: confirm failed: ${r2.text.slice(0, 200)}`);
  }
}

/* ── apply + doorway re-bake ─────────────────────────────────────────────── */

export type ApplyDeps = {
  db: any;
  log: { info: (o: any, m: string) => void; warn: (o: any, m: string) => void; error: (o: any, m: string) => void };
  pbxInstanceId: string | null;
};

export type ApplyResult = { applied: true; rebake: { tenants: number; attempted: number; rebaked: number; linesChanged: number; failed: number } };

/**
 * Apply Changes in the given tenant context, then re-bake the doorway for
 * EVERY Connect-routed number on the platform — Apply is whole-PBX (it flushes
 * other tenants' pending changes too), so limiting the re-bake to one tenant
 * would leave another's numbers on dead air.
 */
export async function applyAndRebake(s: PanelSession, tenantPath: string, deps: ApplyDeps, step = "console-apply"): Promise<ApplyResult> {
  s.setTenant(tenantPath);
  await applyChanges(s, step);
  const rebake = { tenants: 0, attempted: 0, rebaked: 0, linesChanged: 0, failed: 0 };
  try {
    const mappings: Array<{ tenantId: string }> = await deps.db.didRouteMapping.findMany({
      where: { enabled: true, routingMode: "connect" },
      select: { tenantId: true },
      distinct: ["tenantId"],
    });
    for (const m of mappings) {
      const link = await deps.db.tenantPbxLink.findUnique({ where: { tenantId: m.tenantId }, select: { pbxTenantId: true, pbxInstanceId: true } }).catch(() => null);
      if (!link?.pbxTenantId) continue;
      rebake.tenants += 1;
      const r = await rebakeConnectRoutesAfterRegen(m.tenantId, {
        db: deps.db, log: deps.log, pbxTenantId: String(link.pbxTenantId), pbxInstanceId: link.pbxInstanceId ?? deps.pbxInstanceId,
      });
      rebake.attempted += r.attempted; rebake.rebaked += r.rebaked; rebake.linesChanged += r.linesChanged; rebake.failed += r.failed.length;
    }
  } catch (e: any) {
    deps.log.error({ err: e?.message }, "[PBX_CONSOLE] re-bake sweep failed — reconciler will cover");
  }
  deps.log.info({ tenantPath, ...rebake }, "[PBX_CONSOLE] apply + doorway re-bake complete");
  return { applied: true, rebake };
}

/* ── extensions ──────────────────────────────────────────────────────────── */

export type DeviceKind = "pjsip" | "webrtc" | "virtual" | "iax";

export type DeviceSpec = {
  /** Existing device id, or null for a new device. */
  id?: number | null;
  kind: DeviceKind;
  user?: string;
  secret?: string;
  description?: string;
  profileId?: string;
  maxContacts?: string;
  dtmf?: string;
  nat?: string;
  codecs?: string[];
  ringDevice?: boolean;
  mobileClient?: boolean;
  /** Virtual devices: the outside number this rings. */
  number?: string;
  ecidName?: string;
  ecidNumber?: string;
  dispatchableLocationId?: string;
};

export type ExtensionSaveInput = {
  /** General scalar fields, by PANEL name (name, class_of_service_id, …). */
  set?: Record<string, string>;
  /** Multi-selects by panel name (dynamic_queues[], followme_numbers[] …). */
  multi?: Record<string, string[]>;
  /** Checkboxes by panel name → on/off. */
  checks?: Record<string, boolean>;
  /** EVERY device of the extension (existing = has id, new = no id), each with its DB dtmf. Required — see saveExtension. */
  devices?: DeviceSpec[];
  /** Existing device ids to remove from the extension. */
  removeDeviceIds?: number[];
};

/** The device sub-form's field names (everything else on the form is general). */
/** Re-exported from panelForm.ts, which is where the rule now lives. */
import { DEVICE_FIELDS } from "./panelForm";
export { DEVICE_FIELDS };

/** Device options as the edit form lists them. */
export function deviceOptionsOf(form: ParsedForm): Array<{ id: string; label: string }> {
  return (form.options["device_id"] || []).filter((o) => /^\d+$/.test(o.v)).map((o) => ({ id: o.v, label: o.t }));
}

/** Panel names for the profile of each device kind, from the profile select. */
export function pickProfileId(form: ParsedForm, kind: DeviceKind, fallback: { pjsip: string; webrtc: string; iax: string }): string {
  const opts = form.options["profile_id"] || [];
  const find = (re: RegExp) => opts.find((o) => re.test(o.t))?.v;
  if (kind === "webrtc") return find(/webrtc/i) || fallback.webrtc;
  if (kind === "iax") return find(/iax/i) || fallback.iax;
  return find(/pjsip/i) || fallback.pjsip;
}

/** The overrides that turn a device sub-form into the requested device. */
export function deviceOverrides(spec: DeviceSpec, form: ParsedForm, profiles: { pjsip: string; webrtc: string; iax: string }): FormOverrides {
  const set: Record<string, string> = {};
  const checks: Record<string, boolean> = {};
  const drop: string[] = [];
  const multi: Record<string, string[]> = {};
  set["device_id"] = spec.id ? String(spec.id) : "new";
  if (spec.kind === "virtual") {
    set["technology"] = "virtual";
    if (spec.number != null) set["number"] = spec.number.replace(/\D/g, "");
    if (spec.user != null) set["user"] = spec.user;
    if (spec.description != null) set["dev_description"] = spec.description;
    set["dtmfmode"] = spec.dtmf || "rfc2833";
    // recorded contract: no profile / vitxi / max_contacts on a virtual device; secret is kept
    drop.push("profile_id", "vitxi_client", "max_contacts", "mobile_client");
    if (spec.secret) set["secret"] = spec.secret;
    checks["ring_device"] = spec.ringDevice !== false;
    return { set, checks, drop, multi };
  }
  set["technology"] = spec.kind === "iax" ? "iax2" : "pjsip";
  set["profile_id"] = spec.profileId || pickProfileId(form, spec.kind, profiles);
  if (spec.user != null) set["user"] = spec.user;
  if (spec.secret) set["secret"] = spec.secret;
  if (spec.description != null) set["dev_description"] = spec.description;
  if (spec.maxContacts != null) set["max_contacts"] = spec.maxContacts;
  else if (spec.kind === "webrtc" && !spec.id) set["max_contacts"] = "5";
  /* ⛔ The rendered form has no "rfc4733" option — the panel's JS renames rfc2833
     to rfc4733 for pjsip devices after load, so a browser save of a desk phone
     always posts rfc4733. Re-posting the raw form value would silently flip
     every desk phone from rfc4733 to rfc2833. Callers pass the DB value for an
     existing device; a new pjsip device defaults to rfc4733 like the panel. */
  set["dtmfmode"] = spec.dtmf != null && spec.dtmf !== "" ? spec.dtmf
    : spec.kind === "webrtc" ? "rfc2833"                       // the WebRTC app device — matches onboarding + the live rows
    : spec.kind === "iax" ? (form.values["dtmfmode"] || "rfc2833")
    : "rfc4733";                                                // a desk phone — the panel's own pjsip default
  if (spec.nat != null) set["nat"] = spec.nat;
  if (spec.codecs) multi["codecs[]"] = spec.codecs;
  if (spec.ecidName != null) set["devices_emergency_cid_name"] = spec.ecidName;
  if (spec.ecidNumber != null) set["devices_emergency_cid_number"] = spec.ecidNumber;
  if (spec.dispatchableLocationId != null) set["dispatchable_location_id"] = spec.dispatchableLocationId;
  set["number"] = "";
  checks["ring_device"] = spec.ringDevice !== false;
  if (spec.mobileClient != null) checks["mobile_client"] = spec.mobileClient;
  if (spec.kind === "webrtc") set["vitxi_client"] = "1"; else drop.push("vitxi_client");
  return { set, checks, drop, multi };
}

async function loadDeviceForm(s: PanelSession, extId: string | number, deviceId: string | number | "new"): Promise<ParsedForm> {
  const r = await s.post([
    ["class", "extensions"], ["method", "getDevice"], ["mode", deviceId === "new" ? "add" : "edit"],
    ["data[device_id]", String(deviceId)], ["data[extension_id]", String(extId)],
  ]);
  const html = String(r.json?.html ?? r.text ?? "");
  return parseForm(html);
}

/**
 * Save an existing extension: general fields plus any listed devices. Every
 * post is the full edit form (general + ONE device sub-form), which is what the
 * panel posts when a person edits a device from the dropdown and presses Save.
 */
export async function saveExtension(
  s: PanelSession,
  tenantPath: string,
  extId: number | string,
  input: ExtensionSaveInput,
  profiles: { pjsip: string; webrtc: string; iax: string } = { pjsip: "1", webrtc: "12", iax: "1" },
): Promise<{ posts: number; devicesSaved: number; devicesRemoved: number }> {
  s.setTenant(tenantPath);
  const { form } = await loadParsedForm(s, "extensions", "edit", extId);
  if (!form.values["extension_id"]) throw new PanelStepError("extension-load", `the phone system did not return the edit form for extension #${extId}`);
  const generalOv: FormOverrides = { set: input.set, multi: input.multi, checks: input.checks };
  const basePairs = applyOverrides(form, generalOv).filter(([k]) => !DEVICE_FIELDS.has(k));
  const postWithDevice = async (devicePairs: Array<[string, string]>, step: string) => {
    const pairs: Array<[string, string]> = [...basePairs, ...devicePairs.filter(([k]) => DEVICE_FIELDS.has(k))];
    // never resend the queue multi-selects unless the caller set them — the panel
    // answers "dynamic and static agent" errors for stale pairs
    const finalPairs = input.multi && ("dynamic_queues[]" in input.multi || "static_queues[]" in input.multi)
      ? pairs : pairs.filter(([k]) => k !== "dynamic_queues[]" && k !== "static_queues[]");
    for (const [k, v] of [["class", "extensions"], ["method", "put"], ["mode", "edit"]] as Array<[string, string]>) {
      const i = finalPairs.findIndex(([n]) => n === k); if (i >= 0) finalPairs[i] = [k, v]; else finalPairs.push([k, v]);
    }
    assertSaved(step, await s.post(finalPairs));
  };
  let posts = 0, devicesSaved = 0, devicesRemoved = 0;
  const specs = input.devices || [];
  const kindOfForm = (f: ParsedForm): DeviceKind => {
    const tech = String(f.values["technology"] || "").toLowerCase();
    if (tech === "virtual") return "virtual";
    if (tech.startsWith("iax")) return "iax";
    return String(f.values["profile_id"] || "") === profiles.webrtc || (f.checks["vitxi_client"]?.checked) ? "webrtc" : "pjsip";
  };
  for (let spec of specs) {
    const devForm = await loadDeviceForm(s, extId, spec.id ? spec.id : "new");
    if (spec.id) {
      if (String(devForm.values["device_id"] || "") !== String(spec.id)) {
        throw new PanelStepError("device-load", `device #${spec.id} is not on extension #${extId}`);
      }
      /* ⛔ The phone system cannot change an existing device's type. A spec that
         says "virtual" for a desk phone must be refused, not applied — applying it
         rewrites the desk phone's fields as a cell forward (seen on the clone). */
      const current = kindOfForm(devForm);
      const wanted = spec.kind === "webrtc" && current === "pjsip" ? "pjsip" : spec.kind; // webrtc is a pjsip profile; allow the label
      if ((current === "virtual") !== (wanted === "virtual") || (current === "iax") !== (wanted === "iax")) {
        throw new PanelStepError("device-kind", `device #${spec.id} is a ${current === "virtual" ? "phone-number" : current} device — its type can't be changed. Remove it and add a new one instead.`);
      }
      if (current === "webrtc" && spec.kind === "pjsip") spec = { ...spec, kind: "webrtc" };
      if (current === "pjsip" && spec.kind === "webrtc" && !spec.profileId) spec = { ...spec, profileId: String(devForm.values["profile_id"] || profiles.pjsip) };
    }
    const ov = deviceOverrides(spec, Object.keys(devForm.options).length ? devForm : form, profiles);
    const devicePairs = applyOverrides(devForm, ov);
    // fields the device sub-form does not carry but the save needs
    for (const [k, v] of Object.entries(ov.set || {})) if (v != null && !devicePairs.some(([n]) => n === k)) devicePairs.push([k, String(v)]);
    await postWithDevice(devicePairs, spec.id ? `device-${spec.id}` : "device-new");
    posts += 1; devicesSaved += 1;
  }
  if (!specs.length) {
    /* ⛔ There is no "general-only" post: the panel's save ALWAYS carries a device
       sub-form, and the raw rendered one lies about DTMF (see deviceOverrides).
       Proven on the clone 2026-08-19: a name-only save re-posting the raw device
       fields flipped a desk phone from rfc4733 to rfc2833. Callers pass every
       device with its database values (kind + dtmf) — the route does. */
    throw new PanelStepError("extension-save", "internal: an extension save must carry its devices");
  }
  for (const id of input.removeDeviceIds || []) {
    await unlinkDevice(s, extId, id);
    devicesRemoved += 1;
  }
  return { posts, devicesSaved, devicesRemoved };
}

/* ── the mirror fallback for the 12-extension cap ─────────────────────────────
 *
 * ⛔ Over the free tier's cap the panel refuses an extension edit-SAVE outright
 * (proven on the Community-edition clone 2026-08-21, both request shapes), so
 * when `saveExtension` comes back with that refusal the routes hand the SAME
 * save to the PBX helper's /mirror/extension-edit instead. This function is
 * the translation: panel-named fields → the mirror's whitelisted columns.
 *
 * ⛔ A field the mirror cannot honour is REFUSED BY NAME, never dropped — a
 * save that silently loses a field reads as "the console is broken" weeks
 * later. Fields that are merely UNCHANGED (the console re-sends every device
 * with its current values) are dropped as no-ops instead of refused, which is
 * what makes the ordinary Extensions-screen save work through the fallback.
 */

/** panel `set` names the mirror edits as the same-named ombu_extensions column */
const MIRROR_GENERAL_SET = new Set([
  "name", "email", "language", "ringtime", "features_password",
  "internal_cid", "external_cid", "emergency_cid",
]);
/** panel check names that are yes/no ombu_extensions columns */
const MIRROR_GENERAL_CHECKS = new Set([
  "outgoing_rec", "incoming_rec", "internal_rec", "rec_on_demand",
  "call_waiting", "pinless", "lock", "nospy",
]);

export type MirrorEditDeviceContext = {
  deviceId: number;
  user: string;
  technology: string;
  ringDevice: boolean;
  description: string;
  number: string | null;
  dtmf: string | null;
  maxContacts: number | null;
};

export type MirrorEditPayload = {
  set: Record<string, string>;
  vm: Record<string, string>;
  devices: Array<{ device_id: number; secret?: string; description?: string; dtmf?: string; max_contacts?: number }>;
};

const mirrorRefuse = (what: string): never => {
  throw new PanelStepError(
    "mirror-edit-unsupported",
    `The phone system's free edition is refusing this save (its own 12-extension limit), and Connect's fallback can change most extension fields itself — but not ${what}. Nothing was changed.`,
  );
};

export function mapExtensionSaveToMirrorEdit(
  input: ExtensionSaveInput,
  currentDevices: MirrorEditDeviceContext[],
): MirrorEditPayload {
  const set: Record<string, string> = {};
  const vm: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.set || {})) {
    if (v == null) continue;
    if (MIRROR_GENERAL_SET.has(k)) set[k] = String(v);
    else if (k === "vm_password" || k === "voicemail_password") vm["password"] = String(v);
    else mirrorRefuse(`the "${k}" field`);
  }
  for (const [k, v] of Object.entries(input.checks || {})) {
    if (v == null) continue;
    if (k === "vm_enabled") vm["enabled"] = v ? "yes" : "no";
    else if (MIRROR_GENERAL_CHECKS.has(k)) set[k] = v ? "yes" : "no";
    else mirrorRefuse(`the "${k}" option`);
  }
  if (Object.keys(input.multi || {}).length) mirrorRefuse("waiting-line membership");
  if ((input.removeDeviceIds || []).length) mirrorRefuse("removing a device");
  const devices: MirrorEditPayload["devices"] = [];
  for (const spec of input.devices || []) {
    if (!spec.id) mirrorRefuse("adding a device (that is exactly what the free edition caps)");
    const cur = currentDevices.find((d) => d.deviceId === Number(spec.id));
    if (!cur) mirrorRefuse(`device #${spec.id}, which is not on this extension`);
    const c = cur as MirrorEditDeviceContext;
    if (spec.user != null && spec.user !== c.user) mirrorRefuse("renaming a device");
    if (spec.ringDevice != null && spec.ringDevice !== c.ringDevice) mirrorRefuse('the "rings this device" switch');
    if (spec.number != null && String(spec.number).replace(/\D/g, "") !== String(c.number || "").replace(/\D/g, "")) {
      mirrorRefuse("changing a phone-number device's outside number");
    }
    const d: MirrorEditPayload["devices"][number] = { device_id: Number(spec.id) };
    if (spec.secret) d.secret = spec.secret;
    if (spec.description != null && spec.description !== c.description) d.description = spec.description;
    if (c.technology === "pjsip") {
      if (spec.dtmf != null && spec.dtmf !== "" && spec.dtmf !== (c.dtmf || "")) d.dtmf = spec.dtmf;
      if (spec.maxContacts != null && String(spec.maxContacts) !== String(c.maxContacts ?? "")) d.max_contacts = Number(spec.maxContacts);
    } else if ((spec.dtmf != null && spec.dtmf !== (c.dtmf || "")) || spec.maxContacts != null && String(spec.maxContacts) !== String(c.maxContacts ?? "")) {
      mirrorRefuse(`technical settings on a ${c.technology === "virtual" ? "phone-number" : c.technology} device`);
    }
    if (Object.keys(d).length > 1) devices.push(d);
  }
  if (!Object.keys(set).length && !Object.keys(vm).length && !devices.length) {
    // nothing actually changed — tell the caller honestly instead of posting a no-op
    throw new PanelStepError("mirror-edit-noop", "Nothing in this save differs from what the phone system already has.");
  }
  return { set, vm, devices };
}

/** The panel's own over-cap refusal — the ONE failure the mirror fallback answers. */
export function isExtensionCapRefusal(e: unknown): boolean {
  return String((e as any)?.message || "").includes("maximum number of al");
}

/** Remove one device from an extension (the panel's "unlink device" button). */
export async function unlinkDevice(s: PanelSession, extId: number | string, deviceId: number): Promise<void> {
  const r = await s.post([["class", "extensions"], ["method", "unlink"], ["mode", "unlink"], ["data", String(deviceId)]]);
  const html = String(r.json?.html || "");
  if (/module-error-list/i.test(html) || r.json?.notification?.type === "error") {
    const items = (html.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || []).map((x) => x.replace(/<[^>]+>/g, " ").trim()).filter(Boolean);
    throw new PanelStepError("device-unlink", `device #${deviceId}: ${items.join(" | ") || String(r.json?.notification?.text || "refused")}`);
  }
  if (/confirmation-modal/i.test(html)) {
    const pairs: Array<[string, string]> = [];
    for (const m of html.matchAll(/<input\b[^>]*type=["']hidden["'][^>]*>/gi)) {
      const n = (m[0].match(/name=["']([^"']+)["']/i) || [])[1];
      const v = (m[0].match(/value=["']([^"']*)["']/i) || [])[1] || "";
      if (n) pairs.push([n, v]);
    }
    const r2 = await s.post(pairs);
    if (r2.json?.notification?.type !== "success" && r2.json?.state !== "success") {
      throw new PanelStepError("device-unlink", `device #${deviceId}: confirm failed: ${r2.text.slice(0, 200)}`);
    }
  } else if (r.json?.state !== "success") {
    throw new PanelStepError("device-unlink", `device #${deviceId}: unexpected response: ${r.text.slice(0, 200)}`);
  }
  // verify: the device must be gone from the edit form
  const { form } = await loadParsedForm(s, "extensions", "edit", extId);
  if (deviceOptionsOf(form).some((d) => d.id === String(deviceId))) {
    throw new PanelStepError("device-unlink", `device #${deviceId} is still on the extension after unlink`);
  }
}

export type ExtensionCreateInput = ExtensionSaveInput & {
  extension: string;
  name: string;
  email?: string;
  vmPassword?: string;
  classOfService?: string;
};

/**
 * Create an extension: the proven CSV-import base row (one pjsip device),
 * then everything else through the edit form. The first requested device
 * becomes the base device; any further devices are added; the base device is
 * then reshaped to the requested kind's fields.
 *
 * ⛔ The base row's technology must match the FIRST device: the panel cannot
 * change an existing device's technology afterwards.
 */
export async function createExtension(
  s: PanelSession,
  tenantPath: string,
  input: ExtensionCreateInput,
  profiles: { pjsip: string; webrtc: string; iax: string } = { pjsip: "1", webrtc: "12", iax: "1" },
  log: (m: string) => void = () => {},
): Promise<{ extensionId: string; posts: number }> {
  s.setTenant(tenantPath);
  const ext = String(input.extension || "").trim();
  if (!/^\d{3,}$/.test(ext)) throw new PanelStepError("extension-create", "an extension is three or more digits");
  // refuse to create on top of an existing number in this tenant
  let existing: string | null = null;
  try { existing = await lookupExtensionIdByNumber(s, ext); } catch { existing = null; }
  if (existing) throw new PanelStepError("extension-create", `extension ${ext} already exists here (id ${existing})`);
  const devices = (input.devices && input.devices.length ? input.devices : [{ kind: "pjsip" as DeviceKind }, { kind: "webrtc" as DeviceKind }]).map((d) => ({ ...d, id: null }));
  /* ⛔ ONE proven road for every shape (clone, 2026-08-19): the CSV import with a
     virtual base row answers "Import failed" and leaves a bare extension behind,
     so the base row is ALWAYS the desk (pjsip) device. If the person asked for
     a desk phone, the base becomes it; otherwise the requested devices are added
     and the base desk device is unlinked at the end. */
  const deskIdx = devices.findIndex((d) => d.kind === "pjsip");
  const first = deskIdx >= 0 ? devices[deskIdx] : null;
  const csrf = await s.ensureCsrf("menu4");
  const cols = CSV_HEADER.split(",");
  const rowOf = (o: Record<string, string>) => cols.map((c) => (o[c] != null ? String(o[c]) : "")).join(",");
  const base: Record<string, string> = {
    mode: "add", extension: ext, ext_name: input.name, class_of_service: input.classOfService || "all",
    technology: "pjsip", profile_name: "Default PJSIP Profile", device_user: (first && first.user) || ext,
    device_description: (first && first.description) || "",
    email: input.email || "", outgoing_rec: "yes", incoming_rec: "yes", vm_enabled: "yes", vm_password: input.vmPassword || "",
    ring_device: first && first.ringDevice === false ? "no" : "",
  };
  if (first && first.secret) base.device_password = first.secret;
  const csv = CSV_HEADER + "\n" + rowOf(base) + "\n";
  const fd = new FormData();
  fd.append("class", "menu4"); fd.append("method", "put"); fd.append("mode", "add"); fd.append("csfr_token", String(csrf ?? ""));
  fd.append("csv", new Blob([csv], { type: "text/csv" }), "import_extensions.csv");
  const r = await s.postForm(fd);
  const note = String(r.json?.notification?.text || "");
  if (!/completed successfully/i.test(note)) {
    throw new PanelStepError("extension-import", `ext ${ext}: ${note.replace(/<[^>]+>/g, " ").trim() || "import failed: " + r.text.slice(0, 200)}`);
  }
  const extId = await lookupExtensionIdByNumber(s, ext);
  /* ⛔ THE SILENT CAP (clone-proven 2026-08-23, boundary-exact): the free
     tier's 12-extension limit is PER TENANT, and at the cap this import
     answers "Import Completed Successfully" while creating NOTHING — no row,
     no device, no error anywhere. A success note is therefore not proof;
     the extension existing is. The distinct step lets the route fall back
     to the mirror add instead of reporting a success that never happened. */
  if (!extId) {
    throw new PanelStepError(
      "extension-import-capped",
      `the phone system reported the import of extension ${ext} as successful but created nothing — its free edition's 12-extension per-customer limit refuses silently`,
    );
  }
  log(`extension ${ext} imported (id ${extId})`);
  const { form } = await loadParsedForm(s, "extensions", "edit", extId);
  const baseDev = deviceOptionsOf(form)[0];
  if (!baseDev) throw new PanelStepError("extension-import", `ext ${ext}: imported but no device is on it`);
  const specs: DeviceSpec[] = [];
  if (first) specs.push({ ...first, id: Number(baseDev.id) });
  else specs.push({ id: Number(baseDev.id), kind: "pjsip", dtmf: "rfc4733" }); // carried once, unlinked below
  for (const [i, d] of devices.entries()) if (i !== deskIdx) specs.push({ ...d, id: null });
  const saved = await saveExtension(s, tenantPath, extId, { set: input.set, multi: input.multi, checks: input.checks, devices: specs }, profiles);
  let posts = 1 + saved.posts;
  if (!first) {
    await unlinkDevice(s, extId, Number(baseDev.id));
    posts += 1;
    log(`extension ${ext}: base desk device removed (none was asked for)`);
  }
  return { extensionId: extId, posts };
}

/** Delete an extension (two-step), then verify it is gone from the tenant. */
export async function deleteExtension(s: PanelSession, tenantPath: string, extId: number | string, extNumber: string): Promise<void> {
  s.setTenant(tenantPath);
  await panelDelete(s, "extensions", extId, `extension ${extNumber}`);
  let still: string | null = null;
  try { still = await lookupExtensionIdByNumber(s, extNumber); } catch { still = null; }
  if (still && String(still) === String(extId)) throw new PanelStepError("delete-extensions", `extension ${extNumber} is still on the phone system after delete`);
}

/* ── tenants ─────────────────────────────────────────────────────────────── */

export type TenantSaveInput = {
  set?: Record<string, string>;
  multi?: Record<string, string[]>;
  checks?: Record<string, boolean>;
  /** Full inbound-number list (did, description). Replaces the form's rows when given. */
  inboundNumbers?: Array<{ did: string; description: string }>;
};

/** Save the tenant edit form (loaded from the Main context, like the panel does). */
export async function saveTenant(s: PanelSession, mainPath: string, tenantId: number | string, input: TenantSaveInput): Promise<void> {
  s.setTenant(mainPath);
  const { form } = await loadParsedForm(s, "tenants", "edit", tenantId);
  if (String(form.values["tenant_id"] || "") !== String(tenantId)) {
    throw new PanelStepError("tenant-load", `the phone system did not return the edit form for tenant #${tenantId}`);
  }
  let pairs = applyOverrides(form, { set: input.set, multi: input.multi, checks: input.checks });
  if (input.inboundNumbers) {
    pairs = pairs.filter(([k]) => !/^inbound_numbers\[/.test(k));
    input.inboundNumbers.forEach((n, i) => {
      pairs.push([`inbound_numbers[${i}][did]`, String(n.did || "").replace(/\D/g, "")]);
      pairs.push([`inbound_numbers[${i}][description]`, String(n.description || "")]);
    });
  }
  for (const [k, v] of [["class", "tenants"], ["method", "put"], ["mode", "edit"]] as Array<[string, string]>) {
    const i = pairs.findIndex(([n]) => n === k); if (i >= 0) pairs[i] = [k, v]; else pairs.push([k, v]);
  }
  assertSaved("tenant-save", await s.post(pairs));
}

/** Delete a tenant through the panel (two-step). The caller verifies against the DB. */
export async function deleteTenant(s: PanelSession, mainPath: string, tenantId: number | string, label: string): Promise<void> {
  s.setTenant(mainPath);
  await panelDelete(s, "tenants", tenantId, `tenant ${label}`);
}

/* ── phone provisioning ──────────────────────────────────────────────────── */

export type PhoneSaveInput = {
  mac?: string;
  description?: string;
  brandId?: string;
  modelId?: string;
  templateId?: string;
  /** Line accounts: index (1-based, as the form numbers them) → ombu device id ("" = none). */
  lines?: Record<string, string>;
  /** Raw panel-named fields (keys[dss_keys][N][…], expansion_module[…], phonebook[…]). */
  set?: Record<string, string>;
  checks?: Record<string, boolean>;
};

const normMac = (m: string) => {
  const hex = String(m || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return hex.length === 12 ? hex.match(/../g)!.join(":") : String(m || "");
};

/** Load the phone edit modal in its tenant's context. */
export async function loadPhoneForm(s: PanelSession, tenantPath: string, phoneId: number | string): Promise<ParsedForm> {
  s.setTenant(tenantPath);
  const r = await s.post([["class", "provisioning"], ["method", "editDevice"], ["mode", "edit"], ["data[device_id]", String(phoneId)]]);
  return parseForm(String(r.json?.html ?? ""));
}

export async function savePhone(s: PanelSession, tenantPath: string, phoneId: number | string, input: PhoneSaveInput): Promise<void> {
  const form = await loadPhoneForm(s, tenantPath, phoneId);
  if (String(form.values["id"] || "") !== String(phoneId)) throw new PanelStepError("phone-load", `the phone system did not return the edit form for phone #${phoneId}`);
  const set: Record<string, string> = { ...(input.set || {}) };
  if (input.mac != null) set["mac"] = normMac(input.mac);
  if (input.description != null) set["description"] = input.description;
  if (input.brandId != null) set["brand_id"] = input.brandId;
  if (input.modelId != null) set["model_id"] = input.modelId;
  if (input.templateId != null) set["template_id"] = input.templateId;
  for (const [idx, dev] of Object.entries(input.lines || {})) set[`devices[${idx}][device_id]`] = dev;
  const pairs = applyOverrides(form, { set, checks: input.checks });
  for (const [k, v] of [["class", "provisioning"], ["method", "put"], ["mode", "edit"]] as Array<[string, string]>) {
    const i = pairs.findIndex(([n]) => n === k); if (i >= 0) pairs[i] = [k, v]; else pairs.push([k, v]);
  }
  assertSaved("phone-save", await s.post(pairs));
}

/**
 * Add a phone: the panel's add modal, plus the model's own line/key section
 * (which the panel loads with getDevicesView once a model is chosen).
 */
export async function addPhone(s: PanelSession, tenantPath: string, tenantId: number, input: PhoneSaveInput): Promise<{ id: string | null }> {
  s.setTenant(tenantPath);
  const r = await s.post([["class", "provisioning"], ["method", "addDevice"], ["mode", "add"], ["data", String(tenantId)]]);
  const form = parseForm(String(r.json?.html ?? ""));
  if (!("mac" in form.values)) throw new PanelStepError("phone-add", `the phone system did not return the add-phone form (${r.text.slice(0, 160)})`);
  if (!input.modelId) throw new PanelStepError("phone-add", "pick a model");
  const view = await s.post([["class", "provisioning"], ["method", "getDevicesView"], ["mode", "view"], ["model", String(input.modelId)], ["tenant", String(tenantId)], ["device", ""]]);
  const viewForm = parseForm(String(view.json?.html ?? ""));
  const set: Record<string, string> = { ...(input.set || {}) };
  set["mac"] = normMac(String(input.mac || ""));
  set["description"] = input.description || "";
  if (input.brandId) set["brand_id"] = input.brandId;
  set["model_id"] = String(input.modelId);
  if (input.templateId != null) set["template_id"] = input.templateId;
  for (const [idx, dev] of Object.entries(input.lines || {})) set[`devices[${idx}][device_id]`] = dev;
  const merged: ParsedForm = {
    values: { ...viewForm.values, ...form.values }, multi: { ...viewForm.multi, ...form.multi }, checks: { ...viewForm.checks, ...form.checks },
    options: { ...viewForm.options, ...form.options }, order: [...form.order, ...viewForm.order.filter((n) => !form.order.includes(n))],
    pairs: [...form.pairs, ...viewForm.pairs.filter(([n]) => !form.pairs.some(([m]) => m === n))],
  };
  const pairs = applyOverrides(merged, { set, checks: input.checks });
  for (const [k, v] of [["class", "provisioning"], ["method", "put"], ["mode", "add"]] as Array<[string, string]>) {
    const i = pairs.findIndex(([n]) => n === k); if (i >= 0) pairs[i] = [k, v]; else pairs.push([k, v]);
  }
  const saved = await s.post(pairs);
  assertSaved("phone-add", saved);
  return { id: null };
}

export async function deletePhone(s: PanelSession, tenantPath: string, phoneId: number | string, label: string): Promise<void> {
  s.setTenant(tenantPath);
  const r = await s.post([["class", "provisioning"], ["method", "delete"], ["mode", "delete"], ["data", String(phoneId)]]);
  const html = String(r.json?.html || "");
  if (/confirmation-modal/i.test(html)) {
    const pairs: Array<[string, string]> = [];
    for (const m of html.matchAll(/<input\b[^>]*type=["']hidden["'][^>]*>/gi)) {
      const n = (m[0].match(/name=["']([^"']+)["']/i) || [])[1];
      const v = (m[0].match(/value=["']([^"']*)["']/i) || [])[1] || "";
      if (n) pairs.push([n, v]);
    }
    const r2 = await s.post(pairs);
    if (r2.json?.notification?.type !== "success" && r2.json?.state !== "success") throw new PanelStepError("phone-delete", `${label}: confirm failed: ${r2.text.slice(0, 200)}`);
    return;
  }
  if (r.json?.notification?.type === "error" || /module-error-list/i.test(html)) {
    throw new PanelStepError("phone-delete", `${label}: ${String(r.json?.notification?.text || html.replace(/<[^>]+>/g, " ")).slice(0, 200)}`);
  }
  if (r.json?.state !== "success") throw new PanelStepError("phone-delete", `${label}: unexpected response: ${r.text.slice(0, 200)}`);
}

/** The panel's "reboot / resync" button for one phone (check-sync;reboot=true). */
export async function rebootPhone(s: PanelSession, tenantPath: string, phoneId: number | string): Promise<void> {
  s.setTenant(tenantPath);
  const r = await s.post([["class", "provisioning"], ["method", "rebootDevice"], ["mode", "put"], ["data", String(phoneId)]]);
  if (r.json?.notification?.type === "error") throw new PanelStepError("phone-reboot", String(r.json.notification.text || "refused"));
  if (r.json?.state !== "success") throw new PanelStepError("phone-reboot", `unexpected response: ${r.text.slice(0, 200)}`);
}

/* the CSV header VitalPBX's import expects — identical to pbxTenantBuild's */
export const CSV_HEADER =
  "mode,extension,ext_name,language,class_of_service,technology,profile_name,device_user,device_password,device_description,devices_emergency_cid_name,devices_emergency_cid_number,virtual_number,ring_device,codecs,max_contacts,features_password,email,did_number,cid_number,call-limit,call_waiting,vm_enabled,vm_password,saycid,sayduration,envelope,attach,delete,ask_password,skip_instructions,outgoing_rec,incoming_rec,external_cid_name,external_cid_number,emergency_cid_name,emergency_cid_number,dial_profile,accountcode,followme_numbers,initial_ringtime,fw_ringtime,ring_strategy,followme-enabled,recname,enable_callee_prompt,internal_numbers_confirmation,dynamic_queues,static_queues,mobile_number,home_number,organization,job_title,send_welcome_email,vitxi_client,mobile_client,notify_missed_calls,callback_on_busy_transfer";

/* ── outbound routes / route selection (2026-08-20) ────────────────────────
   Izzy: "bring over controlling the outbound routes and trunks from inside
   Connect's UI… keep the robot." Creates reuse onboarding's own proven
   builders (ONE implementation — createTrunk / createOutboundRoute /
   createRouteSelection in pbxTenantBuild.ts); deletes reuse panelDelete; the
   ONLY new panel write is the outbound-route EDIT below, whose exact shape
   (full-form re-post with trklist[] replaced) was proven live on 2026-08-19
   when route 123 moved from trunk 127 to 132 with the CID line byte-identical.
   ⛔ There is deliberately NO trunk edit. The trunk edit form is the
   documented checkbox minefield: parseFormPairs reads the JS-ticked
   outgoing[type]/[trunk]/[qualify] boxes as ABSENT, so a full re-post silently
   unticks them and breaks registration. Rotate credentials by replacing the
   trunk until that form is conquered on the clone. */

export type OutboundRouteEditInput = {
  /** Full member list in DIAL ORDER (primary first). Replaces trklist[]. */
  trunkIds?: string[];
  cidName?: string;
  cidNumber?: string;
  description?: string;
};

export async function editOutboundRoute(s: PanelSession, mainPath: string, routeId: number | string, input: OutboundRouteEditInput): Promise<void> {
  s.setTenant(mainPath);
  const { form } = await loadParsedForm(s, "trunk_group", "edit", routeId);
  // ⛔ Refuse a form that did not load the row — this post is a full replace,
  // and a blank add-form posted back would erase the route's every setting.
  if (String(form.values["outbound_route_id"] || "") !== String(routeId)) {
    throw new PanelStepError("route-load", `the phone system did not return the edit form for outbound route #${routeId}`);
  }
  if (input.trunkIds && input.trunkIds.length === 0) {
    throw new PanelStepError("route-save", "an outbound route needs at least one trunk — refusing to save an empty trunk list");
  }
  const set: Record<string, string> = {};
  if (input.cidName != null) set["cid_name"] = input.cidName;
  if (input.cidNumber != null) set["cid_number"] = input.cidNumber.replace(/\D/g, "");
  if (input.description != null) set["description"] = input.description;
  const pairs = applyOverrides(form, {
    set,
    // applyOverrides preserves the given array order, and ORDER IS THE
    // FEATURE: the panel assigns member `index` from posted order and
    // Asterisk dials in that order (shared primary first, VoIP.ms backup
    // second — Izzy's carrier-filtering rule, pbxTenantBuild.ts).
    multi: input.trunkIds ? { "trklist[]": input.trunkIds.map(String) } : undefined,
  });
  for (const [k, v] of [["class", "trunk_group"], ["method", "put"], ["mode", "edit"]] as Array<[string, string]>) {
    const i = pairs.findIndex(([n]) => n === k); if (i >= 0) pairs[i] = [k, v]; else pairs.push([k, v]);
  }
  assertSaved("route-save", await s.post(pairs));
}

/* ── ring groups & queues (2026-08-20) ─────────────────────────────────────
   Izzy: "a copy of how we set it up in the PBX: every option… completely
   wired." Creates reuse teamBuilder's captured-from-the-browser replay (ONE
   implementation); these two edits are the console pattern — load the panel's
   own edit form and re-post it with overrides, so EVERY option the form
   carries rides along whether or not the console names it. ⛔ The queue
   checkbox rule from the live create applies here too: autofill/autopause/
   answerchannel are CHECKBOXES (present = ticked, whatever the value), while
   joinempty/leavewhenempty are selects carrying literal yes/no — the caller
   expresses checkboxes through `checks` and selects through `set`, and
   applyOverrides enforces the omit-to-untick rule. */

export type TeamEditInput = {
  set?: Record<string, string>;
  checks?: Record<string, boolean>;
  /** Ring group: full ordered member list (ombu extension ids). Replaces list[]. */
  rgMembers?: Array<number | string>;
  /** Queue: full member list. Replaces the queue_members rows. */
  queueMembers?: Array<{ extensionId: number | string; penalty?: number | null }>;
};

export async function editRingGroup(s: PanelSession, tenantPath: string, ringGroupId: number | string, input: TeamEditInput): Promise<void> {
  s.setTenant(tenantPath);
  const { form } = await loadParsedForm(s, "ring_group", "edit", ringGroupId);
  if (String(form.values["ring_group_id"] || "") !== String(ringGroupId)) {
    throw new PanelStepError("ring-group-load", `the phone system did not return the edit form for ring group #${ringGroupId}`);
  }
  if (input.rgMembers && input.rgMembers.length === 0) {
    throw new PanelStepError("ring-group-save", "a ring group needs at least one member — refusing to save an empty list");
  }
  let pairs = applyOverrides(form, { set: input.set, checks: input.checks });
  if (input.rgMembers) {
    // ORDER MATTERS: the posted order IS the ring order for one_by_one.
    pairs = pairs.filter(([k]) => k !== "list[]");
    for (const id of input.rgMembers) pairs.push(["list[]", String(id)]);
  }
  for (const [k, v] of [["class", "ring_group"], ["method", "put"], ["mode", "edit"]] as Array<[string, string]>) {
    const i = pairs.findIndex(([n]) => n === k); if (i >= 0) pairs[i] = [k, v]; else pairs.push([k, v]);
  }
  assertSaved("ring-group-save", await s.post(pairs));
}

export async function editQueue(s: PanelSession, tenantPath: string, queueId: number | string, input: TeamEditInput): Promise<void> {
  s.setTenant(tenantPath);
  const { form } = await loadParsedForm(s, "queues", "edit", queueId);
  if (String(form.values["queue_id"] || "") !== String(queueId)) {
    throw new PanelStepError("queue-load", `the phone system did not return the edit form for queue #${queueId}`);
  }
  if (input.queueMembers && input.queueMembers.length === 0) {
    throw new PanelStepError("queue-save", "a queue needs at least one agent — refusing to save an empty list");
  }
  let pairs = applyOverrides(form, { set: input.set, checks: input.checks });
  if (input.queueMembers) {
    // Preserve each existing row's member_id when the same extension stays —
    // the panel reads member_id "" as "new row", and re-inserting every member
    // on every save would churn queue_member_id for agents that never moved.
    const existing = new Map<string, string>();
    for (let i = 0; ; i++) {
      const ext = pairs.find(([k]) => k === `queue_members_${i}_extension_id`)?.[1];
      if (ext == null) break;
      const mid = pairs.find(([k]) => k === `queue_members[${i}][member_id]`)?.[1] || "";
      if (ext) existing.set(String(ext), mid);
    }
    pairs = pairs.filter(([k]) => !/^queue_members\[/.test(k) && !/^queue_members_/.test(k));
    // The browser sends a placeholder row alongside the real ones; the form
    // expects it. The extension_id key uses UNDERSCORES while its siblings use
    // brackets — the same real asymmetry the create replays.
    const ph = "{{row-count-placeholder}}";
    const first = input.queueMembers[0];
    pairs.push([`queue_members[${ph}][member_id]`, ""]);
    pairs.push([`queue_members_${ph}_extension_id`, String(first.extensionId)]);
    pairs.push([`queue_members[${ph}][penalty]`, ""]);
    pairs.push([`queue_members[${ph}][type]`, "dynamic"]);
    input.queueMembers.forEach((m, i) => {
      pairs.push([`queue_members[${i}][member_id]`, existing.get(String(m.extensionId)) || ""]);
      pairs.push([`queue_members_${i}_extension_id`, String(m.extensionId)]);
      pairs.push([`queue_members[${i}][penalty]`, m.penalty == null ? "" : String(m.penalty)]);
      pairs.push([`queue_members[${i}][type]`, "static"]);
    });
  }
  for (const [k, v] of [["class", "queues"], ["method", "put"], ["mode", "edit"]] as Array<[string, string]>) {
    const i = pairs.findIndex(([n]) => n === k); if (i >= 0) pairs[i] = [k, v]; else pairs.push([k, v]);
  }
  assertSaved("queue-save", await s.post(pairs));
}
