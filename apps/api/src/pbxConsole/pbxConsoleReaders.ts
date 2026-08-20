/**
 * PBX Console — READS. Everything here is a SELECT against the PBX's own
 * database through the read-only `connect_read` user (SELECT on `ombutel`,
 * `provisioning` and `asterisk.queues_log`, nothing else). Nothing in this file
 * can write to the phone system.
 *
 * Lists come from SQL (fast, every row on the box). Record DETAIL comes from
 * the panel FORM (see panelForm.ts) so what the console shows is exactly what
 * the panel would show — option lists included.
 */
import { connectOmbutelMysql } from "../pbxQueueDirectory";

type Conn = import("mysql2/promise").Connection;
type Row = Record<string, any>;

export type ConsoleTenantRow = {
  tenantId: number;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  isMain: boolean;
  extensions: number;
  devices: number;
  dids: string[];
  outboundProfiles: Array<{ id: number; description: string }>;
  cidName: string;
  cidNumber: string;
  timezone: string;
};

export type ConsoleDeviceRow = {
  deviceId: number;
  user: string;
  technology: string;         // pjsip | virtual | iax2 | sip
  profileId: number | null;
  profileName: string | null;
  isWebrtc: boolean;
  description: string;
  ringDevice: boolean;
  mobileClient: boolean;
  vitxiClient: boolean;
  number: string | null;      // virtual devices: the outside number
  maxContacts: number | null;
  dtmf: string | null;
  codecs: string | null;
};

export type ConsoleExtensionRow = {
  extensionId: number;
  extension: string;
  name: string;
  email: string;
  tenantId: number;
  tenantName: string;
  tenantDescription: string;
  tenantPath: string;
  classOfService: string | null;
  vmEnabled: boolean;
  outgoingRec: boolean;
  incomingRec: boolean;
  devices: ConsoleDeviceRow[];
};

export type ConsolePhoneRow = {
  id: number;
  mac: string;
  brand: string | null;
  model: string | null;
  modelId: number | null;
  template: string | null;
  templateId: number | null;
  tenantId: number;
  tenantDescription: string;
  tenantPath: string;
  description: string;
  /** Extension devices registered on this phone's line keys (ombu_devices.user). */
  accounts: Array<{ deviceId: number; user: string; extension: string; extName: string }>;
  keys: string | null;
};

export type ConsoleGeo = {
  countries: Array<{ id: number; country: string; iso: string; blocked: boolean }>;
  whitelist: Array<{ id: number; host: string; description: string; isDefault: boolean }>;
};

const yes = (v: unknown) => String(v ?? "").toLowerCase() === "yes";
const n = (v: unknown): number | null => { if (v == null || v === "") return null; const x = Number(v); return Number.isFinite(x) ? x : null; };

async function q<T = Row>(conn: Conn, sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = (await conn.query(sql, params)) as [T[], unknown];
  return rows;
}

/** Open the read-only connection or explain why not. Caller must `end()` it. */
export async function openReadConn(ombuMysqlUrlEncrypted: string | null | undefined): Promise<{ ok: true; conn: Conn } | { ok: false; reason: string }> {
  const c = await connectOmbutelMysql(ombuMysqlUrlEncrypted);
  if (!c.ok) return { ok: false, reason: c.skipReason };
  return { ok: true, conn: c.conn };
}

export async function listConsoleTenants(conn: Conn): Promise<ConsoleTenantRow[]> {
  const tenants = await q(conn, `SELECT tenant_id, name, description, path, enabled, \`default\` FROM ombutel.ombu_tenants ORDER BY tenant_id`);
  const settings = await q(conn, `SELECT tenant_id, name, value FROM ombutel.ombu_tenant_settings WHERE name IN ('outbound_profiles','cid_name','cid_number','timezone')`);
  const extCounts = await q(conn, `SELECT tenant_id, COUNT(*) AS c FROM ombutel.ombu_extensions GROUP BY tenant_id`);
  const devCounts = await q(conn, `SELECT tenant_id, COUNT(*) AS c FROM ombutel.ombu_devices GROUP BY tenant_id`);
  const dids = await q(conn, `SELECT tenant_id, did FROM ombutel.ombu_tenant_dids ORDER BY did`);
  const ars = await q(conn, `SELECT ars_id, description FROM ombutel.ombu_ars`);
  const arsById = new Map<number, string>(ars.map((r) => [Number(r.ars_id), String(r.description ?? "")]));
  const settingsBy = new Map<number, Record<string, string>>();
  for (const s of settings) {
    const t = Number(s.tenant_id);
    if (!settingsBy.has(t)) settingsBy.set(t, {});
    settingsBy.get(t)![String(s.name)] = String(s.value ?? "");
  }
  const cnt = (rows: Row[]) => new Map<number, number>(rows.map((r) => [Number(r.tenant_id), Number(r.c)]));
  const ec = cnt(extCounts), dc = cnt(devCounts);
  const didsBy = new Map<number, string[]>();
  for (const d of dids) { const t = Number(d.tenant_id); if (!didsBy.has(t)) didsBy.set(t, []); didsBy.get(t)!.push(String(d.did)); }
  return tenants.map((t) => {
    const s = settingsBy.get(Number(t.tenant_id)) || {};
    const profileIds = String(s.outbound_profiles || "").split(",").map((x) => x.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
    return {
      tenantId: Number(t.tenant_id),
      name: String(t.name ?? ""),
      description: String(t.description ?? ""),
      path: String(t.path ?? ""),
      enabled: yes(t.enabled),
      isMain: yes(t.default) || Number(t.tenant_id) === 1,
      extensions: ec.get(Number(t.tenant_id)) || 0,
      devices: dc.get(Number(t.tenant_id)) || 0,
      dids: didsBy.get(Number(t.tenant_id)) || [],
      outboundProfiles: profileIds.map((id) => ({ id, description: arsById.get(id) ?? `#${id}` })),
      cidName: s.cid_name || "",
      cidNumber: s.cid_number || "",
      timezone: s.timezone || "system",
    };
  });
}

export async function listConsoleExtensions(conn: Conn, opts: { tenantId?: number | null } = {}): Promise<ConsoleExtensionRow[]> {
  const where = opts.tenantId ? "WHERE e.tenant_id = ?" : "";
  const params = opts.tenantId ? [opts.tenantId] : [];
  const exts = await q(conn, `
    SELECT e.extension_id, e.extension, e.name, e.email, e.tenant_id, e.outgoing_rec, e.incoming_rec,
           t.name AS tenant_name, t.description AS tenant_description, t.path AS tenant_path,
           c.description AS cos, vm.enabled AS vm_enabled
      FROM ombutel.ombu_extensions e
      JOIN ombutel.ombu_tenants t ON t.tenant_id = e.tenant_id
      LEFT JOIN ombutel.ombu_classes_of_service c ON c.class_of_service_id = e.class_of_service_id
      LEFT JOIN ombutel.ombu_extensions_vm vm ON vm.extension_id = e.extension_id
      ${where}
     ORDER BY e.tenant_id, CAST(e.extension AS UNSIGNED), e.extension`, params);
  const ids = exts.map((e) => Number(e.extension_id));
  const devs = ids.length ? await q(conn, `
    SELECT d.device_id, d.extension_id, d.user, d.technology, d.profile_id, d.description, d.ring_device, d.mobile_client, d.vitxi_client,
           p.name AS profile_name, p.technology AS profile_tech, v.number AS virtual_number, pj.max_contacts, pj.dtmfmode, pj.codecs
      FROM ombutel.ombu_devices d
      LEFT JOIN ombutel.ombu_device_profiles p ON p.profile_id = d.profile_id
      LEFT JOIN ombutel.ombu_virtual_devices v ON v.device_id = d.device_id
      LEFT JOIN ombutel.ombu_pjsip_devices pj ON pj.device_id = d.device_id
     WHERE d.extension_id IN (${ids.map(() => "?").join(",")})
     ORDER BY d.extension_id, d.device_id`, ids) : [];
  const devsBy = new Map<number, ConsoleDeviceRow[]>();
  for (const d of devs) {
    const eid = Number(d.extension_id);
    if (!devsBy.has(eid)) devsBy.set(eid, []);
    devsBy.get(eid)!.push({
      deviceId: Number(d.device_id),
      user: String(d.user ?? ""),
      technology: String(d.technology ?? ""),
      profileId: n(d.profile_id),
      profileName: d.profile_name == null ? null : String(d.profile_name),
      isWebrtc: /webrtc/i.test(String(d.profile_name ?? "")) || yes(d.vitxi_client),
      description: String(d.description ?? ""),
      ringDevice: yes(d.ring_device),
      mobileClient: yes(d.mobile_client),
      vitxiClient: yes(d.vitxi_client),
      number: d.virtual_number == null ? null : String(d.virtual_number),
      maxContacts: n(d.max_contacts),
      dtmf: d.dtmfmode == null ? null : String(d.dtmfmode),
      codecs: d.codecs == null ? null : String(d.codecs),
    });
  }
  return exts.map((e) => ({
    extensionId: Number(e.extension_id),
    extension: String(e.extension ?? ""),
    name: String(e.name ?? ""),
    email: String(e.email ?? ""),
    tenantId: Number(e.tenant_id),
    tenantName: String(e.tenant_name ?? ""),
    tenantDescription: String(e.tenant_description ?? ""),
    tenantPath: String(e.tenant_path ?? ""),
    classOfService: e.cos == null ? null : String(e.cos),
    vmEnabled: yes(e.vm_enabled),
    outgoingRec: yes(e.outgoing_rec),
    incomingRec: yes(e.incoming_rec),
    devices: devsBy.get(Number(e.extension_id)) || [],
  }));
}

/** One extension's identity — used to resolve which tenant context a write runs in. */
export async function findConsoleExtension(conn: Conn, extensionId: number): Promise<ConsoleExtensionRow | null> {
  const rows = await listConsoleExtensions(conn);
  return rows.find((r) => r.extensionId === extensionId) || null;
}

export async function findConsoleTenant(conn: Conn, tenantId: number): Promise<ConsoleTenantRow | null> {
  const rows = await listConsoleTenants(conn);
  return rows.find((r) => r.tenantId === tenantId) || null;
}

/**
 * Something else on the PBX still points at this extension. The panel refuses
 * such a delete with a dialog; we say it in plain words first.
 */
export async function extensionReferences(conn: Conn, extensionId: number): Promise<string[]> {
  const out: string[] = [];
  const dest = await q(conn, `SELECT id FROM ombutel.ombu_destinations WHERE module_id = 1 AND \`index\` = ?`, [String(extensionId)]);
  const destIds = dest.map((r) => Number(r.id));
  if (destIds.length) {
    const ph = destIds.map(() => "?").join(",");
    for (const r of await q(conn, `SELECT description, did FROM ombutel.ombu_inbound_routes WHERE destination_id IN (${ph})`, destIds))
      out.push(`inbound route "${r.description || r.did || "?"}" rings it`);
    for (const r of await q(conn, `SELECT extension, description FROM ombutel.ombu_ring_groups WHERE destination_id IN (${ph})`, destIds))
      out.push(`ring group ${r.extension} (${r.description}) falls back to it`);
    for (const r of await q(conn, `SELECT extension, description FROM ombutel.ombu_queues WHERE destination_id IN (${ph}) OR hangup_destination_id IN (${ph})`, [...destIds, ...destIds]))
      out.push(`queue ${r.extension} (${r.description}) falls back to it`);
    for (const r of await q(conn, `SELECT ie.ivr_id, i.description, ie.\`option\` AS number FROM ombutel.ombu_ivr_entries ie JOIN ombutel.ombu_ivrs i ON i.ivr_id = ie.ivr_id WHERE ie.destination_id IN (${ph})`, destIds))
      out.push(`phone menu "${r.description}" key ${r.number} goes to it`);
  }
  for (const r of await q(conn, `SELECT rg.extension, rg.description FROM ombutel.ombu_ring_group_members m JOIN ombutel.ombu_ring_groups rg ON rg.ring_group_id = m.ring_group_id WHERE m.extension_id = ?`, [extensionId]).catch(() => [] as Row[]))
    out.push(`member of ring group ${r.extension} (${r.description})`);
  for (const r of await q(conn, `SELECT qu.extension, qu.description FROM ombutel.ombu_queue_members m JOIN ombutel.ombu_queues qu ON qu.queue_id = m.queue_id WHERE m.extension_id = ?`, [extensionId]).catch(() => [] as Row[]))
    out.push(`member of queue ${r.extension} (${r.description})`);
  return out;
}

/**
 * The orphan-mobile-flag trap (2026-08-13): a device with mobile_client='yes'
 * and NO ombu_mobile_devices row makes the panel's delete FATAL
 * ("delete() on null"), naming no extension. Detect it before trying.
 */
export async function orphanMobileFlagDevices(conn: Conn, extensionId: number): Promise<Array<{ deviceId: number; user: string }>> {
  const rows = await q(conn, `
    SELECT d.device_id, d.user FROM ombutel.ombu_devices d
    LEFT JOIN ombutel.ombu_mobile_devices m ON m.device_id = d.device_id
    WHERE d.extension_id = ? AND d.mobile_client = 'yes' AND m.id IS NULL`, [extensionId]);
  return rows.map((r) => ({ deviceId: Number(r.device_id), user: String(r.user ?? "") }));
}

export async function listConsolePhones(conn: Conn, opts: { tenantId?: number | null } = {}): Promise<ConsolePhoneRow[]> {
  const where = opts.tenantId ? "WHERE d.tenant = ?" : "";
  const params = opts.tenantId ? [opts.tenantId] : [];
  const phones = await q(conn, `
    SELECT d.id, d.mac, d.model_id, d.template_id, d.tenant, d.description, d.keys,
           pm.model, b.name AS brand, tp.name AS template, t.description AS tenant_description, t.path AS tenant_path
      FROM provisioning.devices d
      LEFT JOIN provisioning.phone_models pm ON pm.id = d.model_id
      LEFT JOIN provisioning.brands b ON b.id = pm.brand_id
      LEFT JOIN provisioning.templates tp ON tp.id = d.template_id
      LEFT JOIN ombutel.ombu_tenants t ON t.tenant_id = d.tenant
      ${where}
     ORDER BY d.tenant, d.description, d.mac`, params);
  const ids = phones.map((p) => Number(p.id));
  const accts = ids.length ? await q(conn, `
    SELECT a.device_id AS phone_id, a.phone_device_id, od.user, e.extension, e.name
      FROM provisioning.accounts a
      LEFT JOIN ombutel.ombu_devices od ON od.device_id = a.phone_device_id
      LEFT JOIN ombutel.ombu_extensions e ON e.extension_id = od.extension_id
     WHERE a.device_id IN (${ids.map(() => "?").join(",")})
     ORDER BY a.id`, ids) : [];
  const by = new Map<number, ConsolePhoneRow["accounts"]>();
  for (const a of accts) {
    const pid = Number(a.phone_id);
    if (!by.has(pid)) by.set(pid, []);
    by.get(pid)!.push({ deviceId: Number(a.phone_device_id), user: String(a.user ?? ""), extension: String(a.extension ?? ""), extName: String(a.name ?? "") });
  }
  return phones.map((p) => ({
    id: Number(p.id),
    mac: String(p.mac ?? ""),
    brand: p.brand == null ? null : String(p.brand),
    model: p.model == null ? null : String(p.model),
    modelId: n(p.model_id),
    template: p.template == null ? null : String(p.template),
    templateId: n(p.template_id),
    tenantId: Number(p.tenant),
    tenantDescription: String(p.tenant_description ?? ""),
    tenantPath: String(p.tenant_path ?? ""),
    description: String(p.description ?? ""),
    accounts: by.get(Number(p.id)) || [],
    keys: p.keys == null ? null : String(p.keys),
  }));
}

export async function listProvisioningCatalog(conn: Conn): Promise<{ brands: Array<{ id: number; name: string }>; models: Array<{ id: number; brandId: number; model: string }>; templates: Array<{ id: number; name: string; modelId: number | null; tenant: number | null; shared: boolean }> }> {
  const brands = await q(conn, `SELECT id, name FROM provisioning.brands ORDER BY name`);
  const models = await q(conn, `SELECT id, brand_id, model FROM provisioning.phone_models ORDER BY model`);
  const templates = await q(conn, `SELECT id, name, model_id, tenant, shared FROM provisioning.templates ORDER BY name`);
  return {
    brands: brands.map((b) => ({ id: Number(b.id), name: String(b.name ?? "") })),
    models: models.map((m) => ({ id: Number(m.id), brandId: Number(m.brand_id), model: String(m.model ?? "") })),
    templates: templates.map((t) => ({ id: Number(t.id), name: String(t.name ?? ""), modelId: n(t.model_id), tenant: n(t.tenant), shared: yes(t.shared) })),
  };
}

export async function readConsoleGeo(conn: Conn): Promise<ConsoleGeo> {
  const countries = await q(conn, `SELECT id, country, iso, blocked FROM ombutel.ombu_geo_firewall ORDER BY country`);
  const wl = await q(conn, `SELECT firewall_whitelist_id, host, description, \`default\` FROM ombutel.ombu_firewall_whitelist ORDER BY firewall_whitelist_id`);
  return {
    countries: countries.map((c) => ({ id: Number(c.id), country: String(c.country ?? ""), iso: String(c.iso ?? "").toUpperCase(), blocked: yes(c.blocked) })),
    whitelist: wl.map((w) => ({ id: Number(w.firewall_whitelist_id), host: String(w.host ?? ""), description: String(w.description ?? ""), isDefault: yes(w.default) })),
  };
}

/**
 * The outbound profiles (route selections) a new tenant can be pointed at.
 *
 * ⛔ THE JOIN THAT LOOKS WRONG AND IS RIGHT: a tenant's profiles live in
 * `ombu_tenant_settings(name='outbound_profiles')` as a comma list of
 * `ombu_ars.ars_id`, and **every real ARS row sits under tenant_id 1 (Main)**.
 * Joining `ombu_ars` on a tenant_id concludes that almost no customer has
 * outbound routing at all — a wrong answer this repo has already produced once.
 *
 * `inUseBy` is how many tenants already point at each profile, so a person
 * picking one for a new tenant can see whether it is a shared profile or a
 * customer's own. Most onboarding-created rows are literally described "none",
 * which is existing data, not a bug — hence `label`, which never renders empty.
 */
export async function listOutboundProfiles(conn: Conn): Promise<Array<{ id: number; description: string; label: string; inUseBy: number }>> {
  const ars = await q(conn, `SELECT ars_id, description FROM ombutel.ombu_ars ORDER BY ars_id`);
  const settings = await q(conn, `SELECT value FROM ombutel.ombu_tenant_settings WHERE name = 'outbound_profiles'`);
  const uses = new Map<number, number>();
  for (const s of settings) {
    for (const raw of String(s.value ?? "").split(",")) {
      const id = Number(raw.trim());
      if (Number.isFinite(id) && id > 0) uses.set(id, (uses.get(id) || 0) + 1);
    }
  }
  return ars.map((r) => {
    const id = Number(r.ars_id);
    const description = String(r.description ?? "").trim();
    const named = description && description.toLowerCase() !== "none";
    return { id, description, label: named ? `${description} (#${id})` : `Profile #${id}`, inUseBy: uses.get(id) || 0 };
  });
}

/* ── trunks / outbound routes / route selection (2026-08-20) ───────────────
   The routing layer, read for the console's Trunks & Routing module. All Main-
   tenant objects (every trunk/route/ARS on this PBX lives under tenant_id 1 —
   the emergency-calling investigation proved joining ombu_ars on a customer's
   tenant_id concludes the whole fleet is broken). The "usedBy" fields exist so
   the console can REFUSE deletes that would strand something: a trunk inside a
   route, a route inside a selection, a selection some tenant points at. */

export type ConsoleTrunkRow = {
  id: number;
  description: string;
  technology: string;
  /** The registration username (how you tell whose carrier account this is). */
  username: string;
  host: string;
  disabled: boolean;
  /** Outbound routes that list this trunk as a member. */
  usedByRoutes: Array<{ id: number; description: string }>;
};

export type ConsoleOutboundRouteRow = {
  id: number;
  description: string;
  cidName: string;
  cidNumber: string;
  /** Member trunks in DIAL ORDER (index asc — primary first). */
  trunks: Array<{ id: number; description: string; index: number }>;
  patterns: number;
  /** Route selections that include this route. */
  usedByArs: Array<{ id: number; description: string }>;
};

export type ConsoleArsRow = {
  id: number;
  description: string;
  members: Array<{ outboundRouteId: number; routeDescription: string; enabled: boolean; sort: number }>;
  /** Tenants whose outbound_profiles setting points at this selection. */
  usedByTenants: string[];
};

export type ConsoleRouting = { trunks: ConsoleTrunkRow[]; routes: ConsoleOutboundRouteRow[]; ars: ConsoleArsRow[] };

export async function listConsoleRouting(conn: Conn): Promise<ConsoleRouting> {
  const [trunkRows, routeRows, memberRows, patternRows, arsRows, arsMemberRows, settings, tenants] = await Promise.all([
    q(conn, `SELECT trunk_id, description, technology, outgoing_username, disable FROM ombutel.ombu_trunks ORDER BY trunk_id`),
    q(conn, `SELECT outbound_route_id, description, cid_name, cid_number FROM ombutel.ombu_outbound_routes ORDER BY outbound_route_id`),
    q(conn, "SELECT outbound_route_id, trunk_id, `index` FROM ombutel.ombu_outbound_route_members ORDER BY outbound_route_id, `index`"),
    q(conn, `SELECT outbound_route_id, COUNT(*) AS c FROM ombutel.ombu_outbound_route_patterns GROUP BY outbound_route_id`),
    q(conn, `SELECT ars_id, description FROM ombutel.ombu_ars ORDER BY ars_id`),
    q(conn, `SELECT ars_id, outbound_route_id, enabled, sort FROM ombutel.ombu_ars_members ORDER BY ars_id, sort`),
    q(conn, `SELECT tenant_id, value FROM ombutel.ombu_tenant_settings WHERE name = 'outbound_profiles'`),
    q(conn, `SELECT tenant_id, description FROM ombutel.ombu_tenants`),
  ]);
  /* The trunk host lives in ombu_trunk_parameters for pjsip trunks; keep the
     read cheap and take it from there only for the rows that have one. */
  const hostRows = await q(conn, `SELECT trunk_id, value FROM ombutel.ombu_trunk_parameters WHERE param = 'host' AND type = 'outgoing'`).catch(() => [] as any[]);
  const hostBy = new Map<number, string>(hostRows.map((r: any) => [Number(r.trunk_id), String(r.value ?? "")]));
  const trunkDesc = new Map<number, string>(trunkRows.map((r) => [Number(r.trunk_id), String(r.description ?? "")]));
  const routeDesc = new Map<number, string>(routeRows.map((r) => [Number(r.outbound_route_id), String(r.description ?? "")]));
  const tenantDesc = new Map<number, string>(tenants.map((r) => [Number(r.tenant_id), String(r.description ?? "")]));

  const routesByTrunk = new Map<number, Array<{ id: number; description: string }>>();
  const trunksByRoute = new Map<number, Array<{ id: number; description: string; index: number }>>();
  for (const m of memberRows) {
    const rid = Number(m.outbound_route_id); const tid = Number(m.trunk_id); const idx = Number((m as any)["index"] ?? 0);
    if (!routesByTrunk.has(tid)) routesByTrunk.set(tid, []);
    routesByTrunk.get(tid)!.push({ id: rid, description: routeDesc.get(rid) || `route #${rid}` });
    if (!trunksByRoute.has(rid)) trunksByRoute.set(rid, []);
    trunksByRoute.get(rid)!.push({ id: tid, description: trunkDesc.get(tid) || `trunk #${tid}`, index: idx });
  }
  const patternsBy = new Map<number, number>(patternRows.map((r: any) => [Number(r.outbound_route_id), Number(r.c)]));
  const arsByRoute = new Map<number, Array<{ id: number; description: string }>>();
  const membersByArs = new Map<number, ConsoleArsRow["members"]>();
  for (const m of arsMemberRows) {
    const aid = Number(m.ars_id); const rid = Number(m.outbound_route_id);
    if (!membersByArs.has(aid)) membersByArs.set(aid, []);
    membersByArs.get(aid)!.push({ outboundRouteId: rid, routeDescription: routeDesc.get(rid) || `route #${rid}`, enabled: yes(m.enabled) || String(m.enabled) === "1", sort: Number(m.sort ?? 0) });
    if (!arsByRoute.has(rid)) arsByRoute.set(rid, []);
    arsByRoute.get(rid)!.push({ id: aid, description: "" });
  }
  const tenantsByArs = new Map<number, string[]>();
  for (const s of settings) {
    for (const raw of String(s.value ?? "").split(",")) {
      const id = Number(raw.trim());
      if (!Number.isFinite(id) || id <= 0) continue;
      if (!tenantsByArs.has(id)) tenantsByArs.set(id, []);
      tenantsByArs.get(id)!.push(tenantDesc.get(Number(s.tenant_id)) || `tenant #${s.tenant_id}`);
    }
  }
  const ars: ConsoleArsRow[] = arsRows.map((r) => ({
    id: Number(r.ars_id),
    description: String(r.description ?? "").trim(),
    members: membersByArs.get(Number(r.ars_id)) || [],
    usedByTenants: tenantsByArs.get(Number(r.ars_id)) || [],
  }));
  const arsDesc = new Map<number, string>(ars.map((a) => [a.id, a.description || `Profile #${a.id}`]));
  for (const list of arsByRoute.values()) for (const e of list) e.description = arsDesc.get(e.id) || `Profile #${e.id}`;

  return {
    trunks: trunkRows.map((r) => ({
      id: Number(r.trunk_id),
      description: String(r.description ?? "").trim(),
      technology: String(r.technology ?? ""),
      username: String(r.outgoing_username ?? ""),
      host: hostBy.get(Number(r.trunk_id)) || "",
      disabled: yes(r.disable),
      usedByRoutes: routesByTrunk.get(Number(r.trunk_id)) || [],
    })),
    routes: routeRows.map((r) => ({
      id: Number(r.outbound_route_id),
      description: String(r.description ?? "").trim(),
      cidName: String(r.cid_name ?? ""),
      cidNumber: String(r.cid_number ?? ""),
      trunks: trunksByRoute.get(Number(r.outbound_route_id)) || [],
      patterns: patternsBy.get(Number(r.outbound_route_id)) || 0,
      usedByArs: arsByRoute.get(Number(r.outbound_route_id)) || [],
    })),
    ars,
  };
}
