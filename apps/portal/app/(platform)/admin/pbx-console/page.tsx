"use client";
/**
 * PBX Console — the Connect-themed replacement for the VitalPBX panel.
 *
 * Izzy is dropping the VitalPBX One subscription. Once it lapses the panel only
 * shows Main plus one customer, so tenants / extensions / phone provisioning /
 * geo firewall have to be run from here. This page reads through Connect's
 * read-only PBX user and writes by replaying the panel from the server, always
 * re-baking the Connect doorway after an Apply.
 *
 * SUPER_ADMIN only (forced in navConfig + PermissionGate + the api requireOwner).
 * Extensions and tenant edits work with no licence; provisioning and geo blocks
 * are capped by the unlicensed panel and are read-only here until the direct
 * write path ships.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from "../../../../services/apiClient";
import { PermissionGate } from "../../../../components/PermissionGate";
import { PanelForm, type PanelFormData, type PanelEdit } from "./PanelForm";
import "./pbxConsole.css";

/** Which panel module each screen edits, and whether it belongs to a customer. */
type PanelTarget = { module: string; id: string | null; tenantPath?: string };

type Module = "tenants" | "extensions" | "phones" | "routing" | "teams" | "geo";
function errText(e: any, fallback: string): string {
  if (e instanceof ApiError) return (e.body as any)?.detail || (e.body as any)?.message || (e.body as any)?.error || e.message || fallback;
  return e?.message || fallback;
}

type Tenant = { tenantId: number; name: string; description: string; path: string; enabled: boolean; isMain: boolean; extensions: number; devices: number; dids: string[]; outboundProfiles: { id: number; description: string }[]; cidName: string; cidNumber: string; timezone: string };
type Device = { deviceId: number; user: string; technology: string; profileId: number | null; profileName: string | null; isWebrtc: boolean; description: string; ringDevice: boolean; mobileClient: boolean; vitxiClient: boolean; number: string | null; maxContacts: number | null; dtmf: string | null; codecs: string | null };
type Extension = { extensionId: number; extension: string; name: string; email: string; tenantId: number; tenantName: string; tenantDescription: string; tenantPath: string; classOfService: string | null; vmEnabled: boolean; outgoingRec: boolean; incomingRec: boolean; devices: Device[] };
type Phone = { id: number; mac: string; brand: string | null; model: string | null; tenantId: number; tenantDescription: string; description: string; accounts: { user: string; extension: string; extName: string }[] };
type Geo = { countries: { id: number; country: string; iso: string; blocked: boolean }[]; whitelist: { id: number; host: string; description: string; isDefault: boolean }[] };
type RTrunk = { id: number; description: string; technology: string; username: string; host: string; disabled: boolean; usedByRoutes: { id: number; description: string }[] };
type RRoute = { id: number; description: string; cidName: string; cidNumber: string; trunks: { id: number; description: string; index: number }[]; patterns: number; usedByArs: { id: number; description: string }[] };
type RArs = { id: number; description: string; members: { outboundRouteId: number; routeDescription: string; enabled: boolean; sort: number }[]; usedByTenants: string[] };
type Routing = { trunks: RTrunk[]; routes: RRoute[]; ars: RArs[] };
type TeamMemberRow = { extensionId: number; extension: string; name: string; penalty?: number | null; type?: string };
type TeamRow = { id: number; tenantId: number; tenantDescription: string; tenantPath: string; extension: string; description: string; options: Record<string, string | null>; members: TeamMemberRow[]; referencedBy: string[] };
type TeamsData = { ringGroups: TeamRow[]; queues: TeamRow[]; tenants: Array<{ tenantId: number; description: string; path: string; extensions: Array<{ id: number; number: string; name: string }> }> };

type DeviceKind = "pjsip" | "webrtc" | "virtual" | "iax";
type DeviceDraft = { deviceId: number | null; kind: DeviceKind; user: string; secret: string; description: string; number: string; ringDevice: boolean; dtmf: string; maxContacts: string };
const KIND_LABEL: Record<DeviceKind, string> = { pjsip: "Desk phone", webrtc: "Connect app", virtual: "Rings a phone number", iax: "IAX2" };
const kindOf = (d: Device): DeviceKind => d.technology === "virtual" ? "virtual" : d.isWebrtc ? "webrtc" : d.technology === "iax2" ? "iax" : "pjsip";

const digits = (s: string) => String(s ?? "").replace(/\D/g, "");
const normPhone = (s: string) => { const d = digits(s); return d.length === 11 && d[0] === "1" ? d.slice(1) : d; };

function useToasts() {
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind?: string }[]>([]);
  const idRef = useRef(0);
  const push = useCallback((msg: string, kind?: string) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  const node = <div className="pc-toast">{toasts.map((t) => <div key={t.id} className={t.kind}>{t.msg}</div>)}</div>;
  return { push, node };
}

const MODULES: Module[] = ["tenants", "extensions", "phones", "routing", "teams", "geo"];

function PbxConsole() {
  const [mod, setMod] = useState<Module>("extensions");
  // Deep links from the sidebar (?mod=routing / ?mod=teams). Read from
  // window.location, not useSearchParams — the hook forces a Suspense
  // boundary on the whole page for one read at mount.
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("mod");
    if (m && (MODULES as string[]).includes(m)) setMod(m as Module);
  }, []);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [outboundProfiles, setOutboundProfiles] = useState<Array<{ id: number; label: string; inUseBy: number }>>([]);
  const [newTenant, setNewTenant] = useState(false);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [phones, setPhones] = useState<Phone[]>([]);
  const [catalog, setCatalog] = useState<{ brands: any[]; models: any[]; templates: any[] } | null>(null);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [routing, setRouting] = useState<Routing | null>(null);
  const [teams, setTeams] = useState<TeamsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<string>(""); // tenant slug filter, "" = all
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const { push, node: toastNode } = useToasts();

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const t = await apiGet<{ available: boolean; tenants?: Tenant[]; outboundProfiles?: Array<{ id: number; label: string; inUseBy: number }>; detail?: string }>("/admin/pbx-console/tenants");
      if (!t.available) { setError(t.detail || "The phone system database is unreachable."); setLoading(false); return; }
      setTenants(t.tenants || []);
      setOutboundProfiles(t.outboundProfiles || []);
    } catch (e) { setError(errText(e, "Could not load the phone system.")); }
    setLoading(false);
  }, []);
  useEffect(() => { void loadAll(); }, [loadAll]);

  const loadModule = useCallback(async (m: Module) => {
    try {
      if (m === "extensions") { const r = await apiGet<{ extensions: Extension[] }>("/admin/pbx-console/extensions"); setExtensions(r.extensions || []); }
      else if (m === "phones") { const r = await apiGet<{ phones: Phone[]; catalog: any }>("/admin/pbx-console/phones"); setPhones(r.phones || []); setCatalog(r.catalog || null); }
      else if (m === "geo") { const r = await apiGet<Geo & { available: boolean }>("/admin/pbx-console/geo"); setGeo(r); }
      else if (m === "routing") { const r = await apiGet<Routing & { available: boolean }>("/admin/pbx-console/routing"); setRouting(r); }
      else if (m === "teams") { const r = await apiGet<TeamsData & { available: boolean }>("/admin/pbx-console/teams"); setTeams(r); }
    } catch (e) { push(errText(e, "Could not load " + m + "."), "bad"); }
  }, [push]);
  useEffect(() => { if (mod !== "tenants") void loadModule(mod); }, [mod, loadModule]);

  const tenantByName = useMemo(() => new Map(tenants.map((t) => [t.name, t])), [tenants]);
  const tenantName = (slug: string) => tenantByName.get(slug)?.description || slug;

  // ── editor state ──────────────────────────────────────────────────────────
  const [editor, setEditor] = useState<null | { kind: Module; id: number | null; draft: any; base: any }>(null);
  const [saving, setSaving] = useState(false);
  const dirty = useMemo(() => editor && JSON.stringify(editor.draft) !== JSON.stringify(editor.base), [editor]);

  const closeEditor = () => { if (dirty && !window.confirm("Leave without saving your changes?")) return; setEditor(null); };

  /* ── the phone system's own form ────────────────────────────────────────
     Every module's Edit and New open the panel's complete form — every tab,
     every field, every option — rather than a short list somebody chose. */
  const [panel, setPanel] = useState<PanelTarget | null>(null);
  const [panelData, setPanelData] = useState<PanelFormData | null>(null);
  const [panelBusy, setPanelBusy] = useState(false);
  const [panelErr, setPanelErr] = useState<string | null>(null);

  useEffect(() => {
    if (!panel) { setPanelData(null); setPanelErr(null); return; }
    let live = true;
    setPanelBusy(true); setPanelErr(null); setPanelData(null);
    const qs = new URLSearchParams();
    if (panel.id) qs.set("id", panel.id);
    if (panel.tenantPath) qs.set("tenantPath", panel.tenantPath);
    apiGet<PanelFormData>(`/admin/pbx-console/panel/${panel.module}/form?${qs.toString()}`)
      .then((d) => { if (live) setPanelData(d); })
      .catch((e) => { if (live) setPanelErr(errText(e, "The phone system did not return that form.")); })
      .finally(() => { if (live) setPanelBusy(false); });
    return () => { live = false; };
  }, [panel]);

  const savePanel = async (edit: PanelEdit) => {
    if (!panel) return;
    setPanelBusy(true); setPanelErr(null);
    try {
      await apiPost(`/admin/pbx-console/panel/${panel.module}/save`, {
        id: panel.id, tenantPath: panel.tenantPath, ...edit,
      });
      push("ok", panel.id ? "Saved to the phone system." : "Created on the phone system.");
      setPanel(null);
      await loadAll();
      await loadModule(mod);
    } catch (e) {
      setPanelErr(errText(e, "The phone system refused the change."));
    } finally {
      setPanelBusy(false);
    }
  };

  const openPanel = (module: string, id: string | number | null, tenantPath?: string) => {
    if (dirty && !window.confirm("Leave without saving?")) return;
    setEditor(null);
    setPanel({ module, id: id == null ? null : String(id), tenantPath });
  };

  // ────────────────────────────────────────────────────────────────────────
  const inScope = (slug: string) => !scope || slug === scope;
  const matches = (hay: string) => !search || hay.toLowerCase().includes(search.toLowerCase());

  const changeMod = (m: Module) => { if (dirty && !window.confirm("Leave without saving?")) return; setEditor(null); setPanel(null); setMod(m); setSearch(""); setFilter("all"); };

  return (
    <div className="pc">
      <div className="pc-head">
        <div>
          <h1>PBX Console</h1>
          <p>Run tenants, extensions, phones and the geo firewall from Connect — the same jobs the VitalPBX panel does, kept working after the licence ends.</p>
        </div>
        <span className="pc-spacer" />
        <TenantSwitcher tenants={tenants} scope={scope} onChange={(s) => { if (dirty && !window.confirm("Leave without saving?")) return; setEditor(null); setScope(s); }} />
      </div>

      <div className="pc-modnav" role="tablist">
        {(["tenants", "extensions", "phones", "routing", "teams", "geo"] as Module[]).map((m) => (
          <button key={m} role="tab" aria-selected={mod === m} onClick={() => changeMod(m)}>
            {m === "tenants" ? "Tenants" : m === "extensions" ? "Extensions" : m === "phones" ? "Phone Provisioning" : m === "routing" ? "Trunks & Routing" : m === "teams" ? "Ring Groups & Queues" : "Geo Firewall"}
            <span className="pc-cnt">{m === "tenants" ? tenants.filter((t) => inScope(t.name)).length : m === "extensions" ? extensions.filter((e) => inScope(tenantByName.get("")?.name || "") || inScope(tenantSlugOf(e, tenantByName))).length : m === "phones" ? phones.length : m === "routing" ? (routing ? routing.trunks.length : "—") : m === "teams" ? (teams ? teams.ringGroups.length + teams.queues.length : "—") : geo ? geo.countries.filter((c) => c.blocked).length : "—"}</span>
          </button>
        ))}
      </div>

      {loading ? <div className="pc-state"><span className="pc-spin" /> Loading the phone system…</div>
        : error ? <div className="pc-note warn"><span className="pc-ico">!</span><div>{error} <button className="pc-btn pc-btn-sm" onClick={() => void loadAll()}>Retry</button></div></div>
        : panel ? (
            panelData
              ? <PanelForm data={panelData} busy={panelBusy} error={panelErr} onCancel={() => setPanel(null)} onSave={savePanel} />
              : panelErr
                ? <div className="pc-note warn"><span className="pc-ico">!</span><div>{panelErr}{" "}
                    <button className="pc-btn pc-btn-sm" onClick={() => setPanel({ ...panel })}>Retry</button>{" "}
                    <button className="pc-btn pc-btn-sm pc-btn-ghost" onClick={() => setPanel(null)}>Back</button></div></div>
                : <div className="pc-state"><span className="pc-spin" /> Reading the form from the phone system…</div>
          )
        : editor ? <Editor editor={editor} setEditor={setEditor} tenants={tenants} tenantName={tenantName} saving={saving} setSaving={setSaving} dirty={!!dirty} close={closeEditor} push={push}
            afterSave={async () => { await loadAll(); await loadModule(mod); }} catalog={catalog} />
        : mod === "tenants" ? <TenantList rows={tenants.filter((t) => inScope(t.name) && matches(t.description + " " + t.name + " " + t.dids.join(" ")))} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} all={tenants} open={(t: Tenant) => openPanel("tenants", t.tenantId)} create={() => setNewTenant(true)} />
        : mod === "extensions" ? <ExtensionList rows={extensions.filter((e) => inScope(tenantSlugOf(e, tenantByName)) && matches(e.extension + " " + e.name + " " + e.tenantDescription))} all={extensions} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch}
            open={(e: Extension) => openPanel("extensions", e.extensionId, e.tenantPath)}
            create={() => setEditor({ kind: "extensions", id: null, draft: extDraft(null, scope ? tenantByName.get(scope) : tenants.find((t) => !t.isMain)), base: null })} />
        : mod === "phones" ? <PhoneList rows={phones.filter((p) => inScope(slugForTenantId(p.tenantId, tenants)) && matches(p.mac + " " + p.description + " " + (p.model || "") + " " + p.tenantDescription))} push={push} reload={() => loadModule("phones")} />
        : mod === "routing" ? <RoutingView routing={routing} push={push} reload={() => loadModule("routing")} openPanel={openPanel} />
        : mod === "teams" ? <TeamsView teams={teams} scope={scope} push={push} reload={() => loadModule("teams")} openPanel={openPanel} />
        : <GeoView geo={geo} push={push} reload={() => loadModule("geo")} />}

      {newTenant ? (
        <NewTenantDialog
          profiles={outboundProfiles}
          push={push}
          onClose={() => setNewTenant(false)}
          onCreated={async () => { await loadAll(); }}
        />
      ) : null}

      {toastNode}
    </div>
  );
}

function tenantSlugOf(e: Extension, byName: Map<string, Tenant>): string {
  for (const [slug, t] of byName) if (t.tenantId === e.tenantId) return slug;
  return "";
}
function slugForTenantId(id: number, tenants: Tenant[]): string { return tenants.find((t) => t.tenantId === id)?.name || ""; }

/* ── drafts ─────────────────────────────────────────────────────────────── */
function tenantDraft(t: Tenant) {
  return { description: t.description, enabled: t.enabled, cidName: t.cidName, cidNumber: t.cidNumber, inbound: t.dids.map((d) => ({ did: d, description: "" })), _t: t };
}
function extDraft(e: Extension | null, tenant?: Tenant) {
  if (!e) return { extension: "", name: "", email: "", vmEnabled: true, outgoingRec: true, incomingRec: true, tenantId: tenant?.tenantId || 0, tenantPath: tenant?.path || "", devices: [dDraft("pjsip"), dDraft("webrtc")], _new: true };
  return { extension: e.extension, name: e.name, email: e.email, vmEnabled: e.vmEnabled, outgoingRec: e.outgoingRec, incomingRec: e.incomingRec, tenantId: e.tenantId,
    devices: e.devices.map((d) => ({ deviceId: d.deviceId, kind: kindOf(d), user: d.user, secret: "", description: d.description, number: d.number || "", ringDevice: d.ringDevice, dtmf: d.dtmf || "", maxContacts: String(d.maxContacts ?? "") })), _e: e };
}
function dDraft(kind: DeviceKind): DeviceDraft { return { deviceId: null, kind, user: "", secret: "", description: kind === "webrtc" ? "Connect app" : kind === "virtual" ? "Rings a phone number" : "Desk phone", number: "", ringDevice: true, dtmf: "", maxContacts: kind === "webrtc" ? "5" : "1" }; }

/* ── tenant switcher ────────────────────────────────────────────────────── */
function TenantSwitcher({ tenants, scope, onChange }: { tenants: Tenant[]; scope: string; onChange: (s: string) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-dim)" }}>
      Customer
      <select className="pc-ctl" value={scope} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 180 }}>
        <option value="">All customers</option>
        {tenants.filter((t) => !t.isMain).map((t) => <option key={t.tenantId} value={t.name}>{t.description}</option>)}
      </select>
    </label>
  );
}

/* ── lists ──────────────────────────────────────────────────────────────── */
function Filters({ search, setSearch, chips, filter, setFilter, placeholder }: any) {
  return (
    <div className="pc-filters">
      <div className="pc-search"><span>🔍</span><input placeholder={placeholder} value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <div className="pc-chipset">{chips.map((c: any) => <button key={c.k} className="pc-chip" aria-pressed={filter === c.k} onClick={() => setFilter(c.k)}>{c.label} {c.n}</button>)}</div>
    </div>
  );
}

/*
 * Creating a customer is the ONE job the VitalPBX panel refuses once the licence
 * lapses, so it does not go through the panel form at all - it goes through
 * Connect's own mirror, the same generator onboarding already uses. That is why
 * this is its own dialog rather than a mode of the editor: the editor is built
 * around re-posting a rendered panel form, and this write has no panel form
 * behind it. Folding them together would put the working edit flow at risk for
 * no gain.
 *
 * It deliberately asks for very little. This is the panel's "add tenant" button,
 * not onboarding: no trunk, no outbound route, no extensions, no phone numbers
 * bought. Everything else about the customer is editable straight afterwards
 * through the ordinary edit screen, which keeps working with no licence.
 */
function NewTenantDialog({ profiles, onClose, onCreated, push }: {
  profiles: Array<{ id: number; label: string; inUseBy: number }>;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
  push: (m: string, k?: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [slug, setSlug] = useState("");
  const [dids, setDids] = useState("");
  const [profileId, setProfileId] = useState("");
  const [busy, setBusy] = useState(false);

  // the same rule the server uses, so what is previewed is what gets created
  const toSlug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const effectiveSlug = slugTouched ? toSlug(slug) : toSlug(label);
  const didList = dids.split(/[^0-9]+/).filter(Boolean);
  const ready = !!label.trim() && !!effectiveSlug && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await apiPost<{ createdTenantId: number; name: string }>("/admin/pbx-console/tenants", {
        label: label.trim(),
        slug: effectiveSlug,
        dids: didList,
        outboundProfileIds: profileId ? [Number(profileId)] : [],
      });
      push("Created " + label.trim() + " on the phone system.");
      onClose();
      await onCreated();
    } catch (e) {
      // the server sends a sentence for every refusal it recognises
      push(errText(e, "The customer was not created."), "bad");
    }
    setBusy(false);
  };

  return (
    <div className="pc-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="pc-modal" role="dialog" aria-modal="true" aria-label="New customer">
        <h3>New customer on the phone system</h3>
        <div className="pc-mbody">
          <div className="pc-f">
            <label htmlFor="nt-label">Customer name</label>
            <input id="nt-label" className="pc-ctl" value={label} autoFocus placeholder="Acme Bakery"
              onChange={(e) => setLabel(e.target.value)} />
            <div className="pc-help">What you and the customer call them. This is what shows in every list.</div>
          </div>
          <div className="pc-f">
            <label htmlFor="nt-slug">Name on the PBX</label>
            <input id="nt-slug" className="pc-ctl pc-mono" value={effectiveSlug} placeholder="acme_bakery"
              onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} />
            <div className="pc-help">
              Filled in from the name above. Letters, digits and underscores only &mdash; it is what the phone system
              files everything under, so it cannot be changed afterwards.
            </div>
          </div>
          <div className="pc-f">
            <label htmlFor="nt-dids">Phone numbers <span className="pc-rowsub">(optional)</span></label>
            <input id="nt-dids" className="pc-ctl pc-mono" value={dids} placeholder="8455577768, 8457231213"
              onChange={(e) => setDids(e.target.value)} />
            <div className="pc-help">
              {didList.length
                ? didList.length + (didList.length === 1 ? " number: " : " numbers: ") + didList.join(", ")
                : "Numbers this customer answers. You can add them later instead."}
            </div>
          </div>
          <div className="pc-f">
            <label htmlFor="nt-prof">Outbound profile <span className="pc-rowsub">(optional)</span></label>
            <select id="nt-prof" className="pc-ctl" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">None &mdash; set this up later</option>
              {profiles.map((p) => (
                <option key={p.id} value={String(p.id)}>{p.label}{p.inUseBy ? " - used by " + p.inUseBy : ""}</option>
              ))}
            </select>
            <div className="pc-help">How their outgoing calls leave the building. Leave this alone unless you know which one they should share.</div>
          </div>
          <div className="pc-note">
            <span className="pc-ico">i</span>
            <div>
              This creates the customer on the phone system and nothing else &mdash; no extensions, no trunk, no numbers
              bought. Add their extensions next.
            </div>
          </div>
        </div>
        <div className="pc-mfoot">
          <button className="pc-btn pc-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="pc-btn pc-btn-primary" onClick={() => void submit()} disabled={!ready}>
            {busy ? "Creating..." : "Create customer"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TenantList({ rows, all, filter, setFilter, search, setSearch, open, create }: any) {
  let r = rows as Tenant[];
  if (filter === "enabled") r = r.filter((t) => t.enabled);
  return (
    <>
      <div className="pc-filters">
        <div className="pc-search"><span>&#128269;</span><input placeholder="Search customers, names or numbers" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="pc-chipset">
          <button className="pc-chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All {(all as Tenant[]).length}</button>
          <button className="pc-chip" aria-pressed={filter === "enabled"} onClick={() => setFilter("enabled")}>Enabled {(all as Tenant[]).filter((t) => t.enabled).length}</button>
        </div>
        <span className="pc-spacer" />
        <button className="pc-btn pc-btn-primary pc-btn-sm" onClick={create}>New customer</button>
      </div>
      <div className="pc-tablewrap"><div className="pc-tscroll"><table className="pc-table">
        <thead><tr><th>Customer</th><th>Name on the PBX</th><th className="pc-num">Extensions</th><th className="pc-num">Numbers</th><th>Outbound profile</th><th>Status</th><th /></tr></thead>
        <tbody>{r.length ? r.map((t) => (
          <tr key={t.tenantId} className="pc-clickable" onClick={() => open(t)}>
            <td><div className="pc-rowmain">{t.description}{t.isMain ? <span className="pc-pill off" style={{ marginLeft: 8 }}>Main</span> : null}</div></td>
            <td className="pc-mono pc-rowsub">{t.name}</td>
            <td className="pc-num">{t.extensions}</td><td className="pc-num">{t.dids.length}</td>
            <td>{t.outboundProfiles[0]?.description || <span className="pc-rowsub">—</span>}</td>
            <td>{t.enabled ? <span className="pc-pill ok">Enabled</span> : <span className="pc-pill off">Disabled</span>}</td>
            <td className="pc-rowsub">Edit ›</td>
          </tr>
        )) : <tr><td colSpan={7} className="pc-empty">No customers match.</td></tr>}</tbody>
      </table></div></div>
      <div className="pc-legend">Editing a customer replays the PBX&apos;s own form, which keeps working with no licence. Creating one is the single job the panel refuses, so it goes through Connect&apos;s own generator instead.</div>
    </>
  );
}

function ExtensionList({ rows, all, filter, setFilter, search, setSearch, open, create }: any) {
  let r = rows as Extension[];
  if (filter === "cell") r = r.filter((e) => e.devices.some((d) => d.technology === "virtual"));
  if (filter === "nomail") r = r.filter((e) => !e.email);
  const cls = (e: Extension) => e.devices.some((d) => d.technology === "virtual") && e.devices.length === 1 ? "warn" : "ok";
  return (
    <>
      <div className="pc-filters">
        <div className="pc-search"><span>🔍</span><input placeholder="Search by number, name or customer" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="pc-chipset">
          <button className="pc-chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All {(all as Extension[]).length}</button>
          <button className="pc-chip" aria-pressed={filter === "cell"} onClick={() => setFilter("cell")}>Rings a cell {(all as Extension[]).filter((e) => e.devices.some((d) => d.technology === "virtual")).length}</button>
          <button className="pc-chip" aria-pressed={filter === "nomail"} onClick={() => setFilter("nomail")}>No email {(all as Extension[]).filter((e) => !e.email).length}</button>
        </div>
        <span className="pc-spacer" />
        <button className="pc-btn pc-btn-primary" onClick={create}>New extension</button>
      </div>
      <div className="pc-tablewrap"><div className="pc-tscroll"><table className="pc-table">
        <thead><tr><th className="pc-num">Ext</th><th>Name</th><th>Customer</th><th className="pc-num">Devices</th><th>Type</th><th /></tr></thead>
        <tbody>{r.length ? r.map((e) => (
          <tr key={e.extensionId} className="pc-clickable" onClick={() => open(e)}>
            <td className="pc-num pc-mono">{e.extension}</td>
            <td><div className="pc-rowmain">{e.name}</div></td>
            <td className="pc-rowsub">{e.tenantDescription}</td>
            <td className="pc-num">{e.devices.length}</td>
            <td><span className={"pc-pill " + cls(e)}>{e.devices.map((d) => KIND_LABEL[kindOf(d)]).join(" + ") || "—"}</span></td>
            <td className="pc-rowsub">Edit ›</td>
          </tr>
        )) : <tr><td colSpan={6} className="pc-empty">No extensions match.</td></tr>}</tbody>
      </table></div></div>
      <div className="pc-legend"><b>The one Connect couldn&apos;t do from a screen before:</b> add an extension for an existing customer. Create, edit and delete all work with no licence.</div>
    </>
  );
}

function PhoneList({ rows, push, reload }: any) {
  const [busy, setBusy] = useState<number | null>(null);
  const resync = async (p: Phone) => {
    setBusy(p.id);
    try { await apiPost(`/admin/pbx-console/phones/${p.id}/resync`, {}); push(`Resync sent to ${p.mac} — it will fetch within a few seconds.`); }
    catch (e) { push(errText(e, "Resync failed."), "bad"); }
    setBusy(null);
  };
  const rebuild = async (p: Phone) => {
    setBusy(p.id);
    try { const r: any = await apiPost(`/admin/pbx-console/phones/${p.id}/render`, {}); push(`Settings rebuilt for ${p.mac} (${Math.round((r?.rendered?.bytes || 0) / 1024)} KB). Resync to push them now.`); }
    catch (e) { push(errText(e, "Rebuild failed."), "bad"); }
    setBusy(null);
  };
  const remove = async (p: Phone) => {
    if (!window.confirm(`Delete ${p.mac}? The handset keeps its current settings until it next asks for new ones. This can't be undone.`)) return;
    setBusy(p.id);
    try { await apiDelete(`/admin/pbx-console/phones/${p.id}`); push("Phone deleted."); await reload(); }
    catch (e) { push(errText(e, "Delete failed."), "bad"); }
    setBusy(null);
  };
  return (
    <>
      <div className="pc-note"><span className="pc-ico">✓</span><div><b>Phones can be changed from here, licence or not.</b> Connect writes the record and then has the phone system build the config file itself, so the file a handset downloads is exactly what the panel would have produced. <b>Rebuild settings</b> regenerates the file; <b>Resync</b> tells the handset to fetch it now — a reboot is not the same thing.</div></div>
      <div className="pc-tablewrap"><div className="pc-tscroll"><table className="pc-table">
        <thead><tr><th>MAC address</th><th>Phone</th><th>Customer</th><th>Description</th><th>Extension</th><th /></tr></thead>
        <tbody>{(rows as Phone[]).length ? (rows as Phone[]).map((p) => (
          <tr key={p.id}>
            <td className="pc-mono">{p.mac}</td><td>{[p.brand, p.model].filter(Boolean).join(" ") || "—"}</td>
            <td className="pc-rowsub">{p.tenantDescription}</td><td>{p.description}</td>
            <td>{p.accounts.find((a) => a.extension) ? `${p.accounts.find((a) => a.extension)!.extension} — ${p.accounts.find((a) => a.extension)!.extName}` : <span className="pc-pill off">none</span>}</td>
            <td style={{ whiteSpace: "nowrap" }}>
              <button className="pc-btn pc-btn-sm" disabled={busy === p.id} onClick={() => rebuild(p)}>Rebuild</button>{" "}
              <button className="pc-btn pc-btn-sm" disabled={busy === p.id} onClick={() => resync(p)}>Resync</button>{" "}
              <button className="pc-btn pc-btn-sm pc-btn-ghost pc-btn-danger" disabled={busy === p.id} onClick={() => remove(p)}>Delete</button>
            </td>
          </tr>
        )) : <tr><td colSpan={6} className="pc-empty">No phones.</td></tr>}</tbody>
      </table></div></div>
    </>
  );
}

/*
 * Trunks & Routing (2026-08-20, Izzy: "bring over controlling the outbound
 * routes and trunks from inside Connect's UI... keep the robot"). Everything a
 * tenant's outbound side needs, run from Connect; the server reuses
 * onboarding's own proven builders under the hood. Deletes are refused by the
 * server while anything still references the object - the buttons here just
 * surface that sentence. There is deliberately NO trunk edit (the panel's
 * trunk edit form silently unticks its JS-driven checkboxes on re-post and
 * breaks registration); replace a trunk to change its credentials.
 */
function RoutingView({ routing, push, reload, openPanel }: { routing: Routing | null; push: any; reload: any; openPanel: (m: string, id: string | number | null, tenantPath?: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | { kind: "trunk" } | { kind: "route"; edit?: RRoute } | { kind: "ars" }>(null);
  if (!routing) return <div className="pc-state"><span className="pc-spin" /></div>;
  const del = async (what: "trunks" | "outbound-routes" | "route-selections", id: number, label: string) => {
    if (!window.confirm(`Delete ${label}? This can't be undone.`)) return;
    setBusy(true);
    try { await apiDelete(`/admin/pbx-console/${what}/${id}`); push(`Deleted ${label}.`); await reload(); }
    catch (e) { push(errText(e, "Nothing was deleted."), "bad"); }
    setBusy(false);
  };
  const toggleMember = async (ars: RArs, m: RArs["members"][number]) => {
    setBusy(true);
    try {
      await apiPatch(`/admin/pbx-console/route-selections/${ars.id}/members`, { outboundRouteIds: [m.outboundRouteId], enabled: !m.enabled });
      push(`${m.routeDescription} ${m.enabled ? "disabled" : "enabled"} in ${ars.description || `profile #${ars.id}`}.`);
      await reload();
    } catch (e) { push(errText(e, "The route selection was not changed."), "bad"); }
    setBusy(false);
  };
  return (
    <>
      <div className="pc-note"><span className="pc-ico">✓</span><div><b>The outbound side, run from Connect.</b> A call leaves through a <b>route selection</b> → <b>outbound route</b> → <b>trunk</b>. Deleting anything that is still used somewhere is refused with the list of places using it. Trunk order inside a route is the dial order — the shared primary trunk first, the customer&apos;s own VoIP.ms trunk as backup.</div></div>

      <div className="pc-tablewrap"><div className="pc-tscroll"><table className="pc-table">
        <thead><tr><th>Trunk</th><th>Account</th><th>Server</th><th>Used by</th><th style={{ textAlign: "right" }}><button className="pc-btn pc-btn-sm" onClick={() => openPanel("trunks", null)}>New trunk</button></th></tr></thead>
        <tbody>{routing.trunks.length ? routing.trunks.map((t) => (
          <tr key={t.id}>
            <td><div className="pc-rowmain">{t.description || `#${t.id}`}{t.disabled ? <span className="pc-pill off" style={{ marginLeft: 8 }}>disabled</span> : null}</div><div className="pc-rowsub pc-mono">#{t.id} · {t.technology}</div></td>
            <td className="pc-mono pc-rowsub">{t.username || "—"}</td>
            <td className="pc-mono pc-rowsub">{t.host || "—"}</td>
            <td className="pc-rowsub">{t.usedByRoutes.length ? t.usedByRoutes.map((r) => r.description).join(", ") : "—"}</td>
            <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
              <button className="pc-btn pc-btn-sm" disabled={busy} onClick={() => openPanel("trunks", t.id)}>Edit</button>{" "}
              <button className="pc-btn pc-btn-sm pc-btn-ghost pc-btn-danger" disabled={busy || t.usedByRoutes.length > 0} title={t.usedByRoutes.length ? "Still inside an outbound route" : ""} onClick={() => del("trunks", t.id, `trunk ${t.description}`)}>Delete</button>
            </td>
          </tr>
        )) : <tr><td colSpan={5} className="pc-empty">No trunks.</td></tr>}</tbody>
      </table></div></div>

      <div style={{ height: 18 }} />
      <div className="pc-tablewrap"><div className="pc-tscroll"><table className="pc-table">
        <thead><tr><th>Outbound route</th><th>Caller ID</th><th>Trunks (dial order)</th><th>Used by</th><th style={{ textAlign: "right" }}><button className="pc-btn pc-btn-sm" onClick={() => openPanel("outbound-routes", null)}>New route</button></th></tr></thead>
        <tbody>{routing.routes.length ? routing.routes.map((r) => (
          <tr key={r.id}>
            <td><div className="pc-rowmain">{r.description || `#${r.id}`}</div><div className="pc-rowsub pc-mono">#{r.id} · {r.patterns} patterns</div></td>
            <td className="pc-rowsub">{r.cidName ? `"${r.cidName}" ` : ""}<span className="pc-mono">{r.cidNumber || "—"}</span></td>
            <td className="pc-rowsub">{[...r.trunks].sort((a, b) => a.index - b.index).map((t) => t.description).join(" → ") || "—"}</td>
            <td className="pc-rowsub">{r.usedByArs.length ? r.usedByArs.map((a) => a.description).join(", ") : "—"}</td>
            <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
              <button className="pc-btn pc-btn-sm" disabled={busy} onClick={() => openPanel("outbound-routes", r.id)}>Edit</button>{" "}
              <button className="pc-btn pc-btn-sm pc-btn-ghost pc-btn-danger" disabled={busy || r.usedByArs.length > 0} title={r.usedByArs.length ? "Still inside a route selection" : ""} onClick={() => del("outbound-routes", r.id, `outbound route ${r.description}`)}>Delete</button>
            </td>
          </tr>
        )) : <tr><td colSpan={5} className="pc-empty">No outbound routes.</td></tr>}</tbody>
      </table></div></div>

      <div style={{ height: 18 }} />
      <div className="pc-tablewrap"><div className="pc-tscroll"><table className="pc-table">
        <thead><tr><th>Route selection</th><th>Routes (top wins)</th><th>Used by</th><th style={{ textAlign: "right" }}><button className="pc-btn pc-btn-sm" onClick={() => setDialog({ kind: "ars" })}>New selection</button></th></tr></thead>
        <tbody>{routing.ars.length ? routing.ars.map((a) => (
          <tr key={a.id}>
            <td><div className="pc-rowmain">{a.description || `Profile #${a.id}`}</div><div className="pc-rowsub pc-mono">#{a.id}</div></td>
            <td>{a.members.length ? a.members.map((m) => (
              <div key={m.outboundRouteId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
                {m.enabled ? <span className="pc-pill ok">on</span> : <span className="pc-pill off">off</span>}
                <span className={m.enabled ? "" : "pc-rowsub"}>{m.routeDescription}</span>
                <button className="pc-btn pc-btn-sm pc-btn-ghost" disabled={busy} onClick={() => toggleMember(a, m)}>{m.enabled ? "Disable" : "Enable"}</button>
              </div>
            )) : <span className="pc-rowsub">—</span>}</td>
            <td className="pc-rowsub">{a.usedByTenants.length ? a.usedByTenants.join(", ") : "—"}</td>
            <td style={{ textAlign: "right" }}><button className="pc-btn pc-btn-sm pc-btn-ghost pc-btn-danger" disabled={busy || a.usedByTenants.length > 0} title={a.usedByTenants.length ? "A customer still points at this selection" : ""} onClick={() => del("route-selections", a.id, `route selection ${a.description || `#${a.id}`}`)}>Delete</button></td>
          </tr>
        )) : <tr><td colSpan={4} className="pc-empty">No route selections.</td></tr>}</tbody>
      </table></div></div>

      {dialog?.kind === "trunk" ? <NewTrunkDialog push={push} onClose={() => setDialog(null)} onDone={reload} /> : null}
      {dialog?.kind === "route" ? <RouteDialog push={push} onClose={() => setDialog(null)} onDone={reload} trunks={routing.trunks} edit={dialog.edit} /> : null}
      {dialog?.kind === "ars" ? <NewArsDialog push={push} onClose={() => setDialog(null)} onDone={reload} routes={routing.routes} /> : null}
    </>
  );
}

function NewTrunkDialog({ push, onClose, onDone }: any) {
  const [description, setDescription] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState("newyork1.voip.ms");
  const [busy, setBusy] = useState(false);
  const ready = description.trim() && username.trim() && password && server.trim() && !busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const r: any = await apiPost("/admin/pbx-console/trunks", { description: description.trim(), username: username.trim(), password, server: server.trim() });
      push(`Trunk "${description.trim()}" created (#${r.trunkId}).`);
      onClose(); await onDone();
    } catch (e) { push(errText(e, "The trunk was not created."), "bad"); }
    setBusy(false);
  };
  return (
    <div className="pc-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="pc-modal" role="dialog" aria-modal="true" aria-label="New trunk">
        <h3>New trunk</h3>
        <div className="pc-mbody">
          <div className="pc-f"><label>Name</label><input className="pc-ctl" value={description} autoFocus onChange={(e) => setDescription(e.target.value)} placeholder="Acme Bakery" /><div className="pc-help">Shown in every route list. One trunk per carrier account.</div></div>
          <div className="pc-f"><label>Username</label><input className="pc-ctl pc-mono" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="344022_acme" /></div>
          <div className="pc-f"><label>Password</label><input className="pc-ctl pc-mono" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          <div className="pc-f"><label>Server</label><input className="pc-ctl pc-mono" value={server} onChange={(e) => setServer(e.target.value)} /><div className="pc-help">The registration shape onboarding uses (VoIP.ms subaccounts). SignalWire trunks need their SIP-profile domain here instead.</div></div>
        </div>
        <div className="pc-mfoot">
          <button className="pc-btn pc-btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="pc-btn" disabled={!ready} onClick={submit}>{busy ? "Creating…" : "Create trunk"}</button>
        </div>
      </div>
    </div>
  );
}

function RouteDialog({ push, onClose, onDone, trunks, edit }: { push: any; onClose: any; onDone: any; trunks: RTrunk[]; edit?: RRoute }) {
  const ordered = edit ? [...edit.trunks].sort((a, b) => a.index - b.index) : [];
  const [description, setDescription] = useState(edit?.description || "");
  const [cidName, setCidName] = useState(edit?.cidName || "");
  const [cidNumber, setCidNumber] = useState(edit?.cidNumber || "");
  const [primary, setPrimary] = useState(String(ordered[0]?.id || ""));
  const [backup, setBackup] = useState(String(ordered[1]?.id || ""));
  const [busy, setBusy] = useState(false);
  const trunkIds = [primary, backup].filter(Boolean);
  const ready = description.trim() && trunkIds.length > 0 && primary !== backup && !busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      if (edit) {
        await apiPatch(`/admin/pbx-console/outbound-routes/${edit.id}`, { description: description.trim(), cidName, cidNumber, trunkIds });
        push(`Outbound route "${description.trim()}" saved.`);
      } else {
        const r: any = await apiPost("/admin/pbx-console/outbound-routes", { description: description.trim(), cidName, cidNumber, trunkIds });
        push(`Outbound route "${description.trim()}" created (#${r.routeId}).`);
      }
      onClose(); await onDone();
    } catch (e) { push(errText(e, "The route was not saved."), "bad"); }
    setBusy(false);
  };
  return (
    <div className="pc-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="pc-modal" role="dialog" aria-modal="true" aria-label={edit ? "Edit outbound route" : "New outbound route"}>
        <h3>{edit ? `Edit "${edit.description}"` : "New outbound route"}</h3>
        <div className="pc-mbody">
          <div className="pc-f"><label>Name</label><input className="pc-ctl" value={description} autoFocus onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="pc-f"><label>Caller ID name</label><input className="pc-ctl" value={cidName} onChange={(e) => setCidName(e.target.value)} placeholder="Acme Bakery" /></div>
          <div className="pc-f"><label>Caller ID number</label><input className="pc-ctl pc-mono" value={cidNumber} onChange={(e) => setCidNumber(e.target.value)} placeholder="8455551234" /></div>
          <div className="pc-f"><label>Primary trunk</label>
            <select className="pc-ctl" value={primary} onChange={(e) => setPrimary(e.target.value)}>
              <option value="">— pick —</option>
              {trunks.map((t) => <option key={t.id} value={String(t.id)}>{t.description || `#${t.id}`}</option>)}
            </select>
            <div className="pc-help">Dialed first. Platform rule: the shared primary trunk (&quot;0001&quot;) first, the customer&apos;s own VoIP.ms trunk as backup — carriers filter VoIP.ms-originated calls.</div>
          </div>
          <div className="pc-f"><label>Backup trunk</label>
            <select className="pc-ctl" value={backup} onChange={(e) => setBackup(e.target.value)}>
              <option value="">— none —</option>
              {trunks.map((t) => <option key={t.id} value={String(t.id)}>{t.description || `#${t.id}`}</option>)}
            </select>
          </div>
        </div>
        <div className="pc-mfoot">
          <button className="pc-btn pc-btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="pc-btn" disabled={!ready} onClick={submit}>{busy ? "Saving…" : edit ? "Save route" : "Create route"}</button>
        </div>
      </div>
    </div>
  );
}

function NewArsDialog({ push, onClose, onDone, routes }: { push: any; onClose: any; onDone: any; routes: RRoute[] }) {
  const [description, setDescription] = useState("");
  const [routeId, setRouteId] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = description.trim() && routeId && !busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const r: any = await apiPost("/admin/pbx-console/route-selections", { description: description.trim(), outboundRouteId: routeId });
      push(`Route selection "${description.trim()}" created (#${r.arsId}).`);
      onClose(); await onDone();
    } catch (e) { push(errText(e, "The route selection was not created."), "bad"); }
    setBusy(false);
  };
  return (
    <div className="pc-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="pc-modal" role="dialog" aria-modal="true" aria-label="New route selection">
        <h3>New route selection</h3>
        <div className="pc-mbody">
          <div className="pc-f"><label>Name</label><input className="pc-ctl" value={description} autoFocus onChange={(e) => setDescription(e.target.value)} /><div className="pc-help">This is what a tenant&apos;s outbound profile points at.</div></div>
          <div className="pc-f"><label>Outbound route</label>
            <select className="pc-ctl" value={routeId} onChange={(e) => setRouteId(e.target.value)}>
              <option value="">— pick —</option>
              {routes.map((r) => <option key={r.id} value={String(r.id)}>{r.description || `#${r.id}`}</option>)}
            </select>
          </div>
        </div>
        <div className="pc-mfoot">
          <button className="pc-btn pc-btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="pc-btn" disabled={!ready} onClick={submit}>{busy ? "Creating…" : "Create selection"}</button>
        </div>
      </div>
    </div>
  );
}

/*
 * Ring Groups & Queues (2026-08-20, Izzy: "a copy of how we set it up in the
 * PBX: every option, everything that's in the PBX... completely wired").
 * Creates drive teamBuilder's browser-captured replay; edits re-post the
 * panel's OWN form with overrides, so any option this UI doesn't surface is
 * preserved untouched, never dropped. Deletes are refused by the server while
 * an IVR key or inbound route still points at the team.
 */
type TeamField = { k: string; label: string; type: "text" | "num" | "sel"; opts?: Array<[string, string]>; help?: string };
const YESNO: Array<[string, string]> = [["yes", "Yes"], ["no", "No"]];
const RG_FIELDS: TeamField[] = [
  { k: "description", label: "Name", type: "text" },
  { k: "strategy", label: "Ring strategy", type: "sel", opts: [["ringall", "Ring everyone at once"], ["one_by_one", "One by one, in order"]] },
  { k: "ringtime", label: "Ring time (seconds, 0 = default)", type: "num" },
  { k: "prefix", label: "Caller ID prefix", type: "text", help: "Prepended to caller ID so staff see which line rang." },
  { k: "external_numbers", label: "Also ring these outside numbers", type: "text", help: "Comma-separated phone numbers rung alongside the members." },
];
const RG_CHECKS: Array<{ k: string; label: string }> = [
  { k: "answerchannel", label: "Answer the channel before ringing" },
  { k: "no_release", label: "Keep ringing when a member declines" },
  { k: "skip_busy", label: "Skip members already on a call" },
  { k: "allow_diversions", label: "Follow members' forwarding rules" },
];
const QUEUE_FIELDS: TeamField[] = [
  { k: "description", label: "Name", type: "text" },
  { k: "strategy", label: "Strategy", type: "sel", opts: [["ringall", "Ring everyone"], ["linear", "In order"], ["leastrecent", "Least recently called"], ["fewestcalls", "Fewest calls"], ["random", "Random"], ["rrmemory", "Round robin (remembers)"], ["rrordered", "Round robin (in order)"], ["wrandom", "Weighted random"]] },
  { k: "timeout", label: "Ring each agent for (seconds)", type: "num" },
  { k: "retry", label: "Wait between rounds (seconds)", type: "num" },
  { k: "queue_timeout", label: "Longest total wait (seconds, 0 = unlimited)", type: "num" },
  { k: "maxlen", label: "Most callers allowed to wait (0 = unlimited)", type: "num" },
  { k: "prefix", label: "Caller ID prefix", type: "text" },
  { k: "servicelevel", label: "Service level target (seconds)", type: "num", help: "The answered-within-N-seconds target reports judge this queue against." },
  { k: "wrapuptime", label: "Wrap-up time (seconds)", type: "num", help: "How long an agent is left alone after a call." },
  { k: "joinempty", label: "Let callers in when no agent is on", type: "sel", opts: YESNO },
  { k: "leavewhenempty", label: "Throw callers out if all agents leave", type: "sel", opts: YESNO },
  { k: "memberdelay", label: "Member delay (seconds)", type: "num" },
  { k: "weight", label: "Queue weight", type: "num" },
  { k: "penaltymemberslimit", label: "Penalty members limit", type: "num" },
  { k: "announce_position", label: "Announce position", type: "sel", opts: YESNO },
  { k: "announce_frequency", label: "Announce every (seconds)", type: "num" },
  { k: "min_announce_frequency", label: "Never announce more often than (seconds)", type: "num" },
  { k: "announce_position_limit", label: "Stop announcing past position", type: "num" },
  { k: "announce_round_seconds", label: "Round hold time to (seconds)", type: "num" },
  { k: "periodic_announce_frequency", label: "Periodic announcement every (seconds)", type: "num" },
  { k: "relative_periodic_announce", label: "Restart timer after message finishes", type: "sel", opts: YESNO },
  { k: "announce_holdtime", label: "Announce hold time", type: "sel", opts: YESNO },
  { k: "ringinuse", label: "Ring agents already on a call", type: "sel", opts: YESNO },
  { k: "timeoutrestart", label: "Restart timer on decline", type: "sel", opts: YESNO },
  { k: "record", label: "Record calls", type: "sel", opts: YESNO },
  { k: "alertinfo", label: "SIP Alert-Info", type: "text", help: "Lets handsets ring differently for this queue." },
];
const QUEUE_CHECKS: Array<{ k: string; label: string }> = [
  { k: "autofill", label: "Feed callers to agents as they free up" },
  { k: "autopause", label: "Auto-pause an agent who doesn't answer" },
  { k: "answerchannel", label: "Answer the channel before queueing" },
];

function TeamsView({ teams, scope, push, reload, openPanel }: { teams: TeamsData | null; scope: string; push: any; reload: any; openPanel: (m: string, id: string | number | null, tenantPath?: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | { kind: "rg" | "queue"; edit?: TeamRow }>(null);
  if (!teams) return <div className="pc-state"><span className="pc-spin" /></div>;
  const del = async (what: "ring-groups" | "queues", row: TeamRow) => {
    if (!window.confirm(`Delete ${row.description || row.extension} (${row.extension})? This can't be undone.`)) return;
    setBusy(true);
    try { await apiDelete(`/admin/pbx-console/${what}/${row.id}`); push(`Deleted ${row.description || row.extension}.`); await reload(); }
    catch (e) { push(errText(e, "Nothing was deleted."), "bad"); }
    setBusy(false);
  };
  /* A new ring group or queue belongs to a customer, so one must be picked.
     The tenant switcher decides which; with no scope chosen we fall back to the
     first customer that already has teams, and the form refuses if neither. */
  const scopeTenantPath = (() => {
    const list = teams?.tenants || [];
    if (scope) {
      const hit = list.find((t) => t.description.toLowerCase().replace(/[^a-z0-9]+/g, "_") === scope);
      if (hit) return hit.path;
    }
    return list[0]?.path;
  })();
  const table = (kind: "rg" | "queue", rows: TeamRow[]) => (
    <div className="pc-tablewrap"><div className="pc-tscroll"><table className="pc-table">
      <thead><tr><th>{kind === "rg" ? "Ring group" : "Queue"}</th><th>Customer</th><th>Members</th><th>Strategy</th><th style={{ textAlign: "right" }}><button className="pc-btn pc-btn-sm" onClick={() => openPanel(kind === "rg" ? "ring-groups" : "queues", null, scopeTenantPath)}>{kind === "rg" ? "New ring group" : "New queue"}</button></th></tr></thead>
      <tbody>{rows.length ? rows.map((r) => (
        <tr key={r.id}>
          <td><div className="pc-rowmain">{r.description || `#${r.id}`}</div><div className="pc-rowsub pc-mono">{r.extension}</div></td>
          <td className="pc-rowsub">{r.tenantDescription}</td>
          <td className="pc-rowsub">{r.members.length ? r.members.map((m) => m.extension + (m.penalty != null && kind === "queue" ? ` (p${m.penalty})` : "")).join(", ") : "—"}</td>
          <td className="pc-rowsub pc-mono">{r.options.strategy || "—"}</td>
          <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
            <button className="pc-btn pc-btn-sm" disabled={busy} onClick={() => openPanel(kind === "rg" ? "ring-groups" : "queues", r.id, r.tenantPath)}>Edit</button>{" "}
            <button className="pc-btn pc-btn-sm pc-btn-ghost pc-btn-danger" disabled={busy || r.referencedBy.length > 0} title={r.referencedBy.join("; ")} onClick={() => del(kind === "rg" ? "ring-groups" : "queues", r)}>Delete</button>
          </td>
        </tr>
      )) : <tr><td colSpan={5} className="pc-empty">{kind === "rg" ? "No ring groups." : "No queues."}</td></tr>}</tbody>
    </table></div></div>
  );
  return (
    <>
      <div className="pc-note"><span className="pc-ico">✓</span><div><b>The panel&apos;s ring group and queue screens, from Connect.</b> Every option is here or preserved: what this screen doesn&apos;t show is carried through a save untouched, never dropped. Deleting a team an IVR key or inbound route still points at is refused with the reason.</div></div>
      {table("rg", teams.ringGroups)}
      <div style={{ height: 18 }} />
      {table("queue", teams.queues)}
      {dialog ? <TeamDialog kind={dialog.kind} edit={dialog.edit} tenants={teams.tenants} push={push} onClose={() => setDialog(null)} onDone={reload} /> : null}
    </>
  );
}

function TeamDialog({ kind, edit, tenants, push, onClose, onDone }: { kind: "rg" | "queue"; edit?: TeamRow; tenants: TeamsData["tenants"]; push: any; onClose: any; onDone: any }) {
  const FIELDS = kind === "rg" ? RG_FIELDS : QUEUE_FIELDS;
  const CHECKS = kind === "rg" ? RG_CHECKS : QUEUE_CHECKS;
  const [tenantId, setTenantId] = useState<string>(edit ? String(edit.tenantId) : "");
  const tenant = tenants.find((t) => String(t.tenantId) === tenantId);
  const initialVals: Record<string, string> = {};
  const initialChecks: Record<string, boolean> = {};
  if (edit) {
    initialVals["description"] = edit.description;
    for (const f of FIELDS) if (f.k !== "description") initialVals[f.k] = edit.options[f.k] ?? "";
    // ⛔ The panel stores a ticked box as EITHER "yes" or "1" (measured live
    // 2026-08-20: autofill = "yes", autopause = "1" on the same queue). Reading
    // only "yes" renders an ON box as unticked — and the next save would then
    // silently switch the option off.
    for (const c of CHECKS) initialChecks[c.k] = ["yes", "1"].includes(String(edit.options[c.k] ?? ""));
  } else {
    initialVals["description"] = "";
    for (const f of FIELDS) if (f.k !== "description") initialVals[f.k] = "";
    // the create defaults teamBuilder ships: everyone-at-once, sane checkboxes
    initialVals["strategy"] = "ringall";
    initialChecks["answerchannel"] = true;
    if (kind === "rg") initialChecks["no_release"] = true;
    if (kind === "queue") { initialChecks["autofill"] = true; initialVals["joinempty"] = "yes"; initialVals["leavewhenempty"] = "no"; initialVals["timeout"] = "15"; initialVals["retry"] = "5"; }
  }
  const [vals, setVals] = useState<Record<string, string>>(initialVals);
  const [checks, setChecks] = useState<Record<string, boolean>>(initialChecks);
  const [members, setMembers] = useState<Array<{ extensionId: string; penalty: string }>>(
    edit ? edit.members.map((m) => ({ extensionId: String(m.extensionId), penalty: m.penalty == null ? "" : String(m.penalty) })) : [{ extensionId: "", penalty: "" }],
  );
  const [destExt, setDestExt] = useState("");
  const [destKind, setDestKind] = useState<"extension" | "voicemail">("extension");
  const [busy, setBusy] = useState(false);
  const memberOpts = (edit ? tenants.find((t) => t.tenantId === edit.tenantId) : tenant)?.extensions || [];
  const chosen = members.filter((m) => m.extensionId);
  const ready = !busy && vals["description"].trim() && chosen.length > 0 && (edit || tenantId) && (edit || kind === "rg" || destExt);
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      if (edit) {
        const setBody: Record<string, string> = {};
        for (const f of FIELDS) setBody[f.k] = vals[f.k] ?? "";
        const checksBody: Record<string, boolean> = {};
        for (const c of CHECKS) checksBody[c.k] = !!checks[c.k];
        const bodyOut: any = { set: setBody, checks: checksBody };
        if (kind === "rg") bodyOut.rgMembers = chosen.map((m) => m.extensionId);
        else bodyOut.queueMembers = chosen.map((m) => ({ extensionId: m.extensionId, penalty: m.penalty === "" ? null : Number(m.penalty) }));
        await apiPatch(`/admin/pbx-console/${kind === "rg" ? "ring-groups" : "queues"}/${edit.id}`, bodyOut);
        push(`${vals["description"].trim()} saved.`);
      } else {
        const spec: any = { name: vals["description"].trim(), strategy: vals["strategy"] || "ringall", members: chosen.map((m) => ({ extensionId: m.extensionId, penalty: m.penalty === "" ? undefined : Number(m.penalty) })) };
        if (kind === "rg") {
          if (vals["ringtime"]) spec.ringTime = Number(vals["ringtime"]);
          if (vals["prefix"]) spec.prefix = vals["prefix"];
          if (destExt) spec.lastDestination = { categoryId: destKind === "voicemail" ? "25" : "1", targetId: destExt };
          await apiPost("/admin/pbx-console/ring-groups", { pbxTenantId: Number(tenantId), spec });
        } else {
          if (vals["timeout"]) spec.ringTime = Number(vals["timeout"]);
          if (vals["retry"]) spec.retry = Number(vals["retry"]);
          if (vals["queue_timeout"]) spec.maxWaitSeconds = Number(vals["queue_timeout"]);
          if (vals["maxlen"]) spec.maxCallers = Number(vals["maxlen"]);
          if (vals["servicelevel"]) spec.serviceLevelSeconds = Number(vals["servicelevel"]);
          if (vals["wrapuptime"]) spec.wrapUpSeconds = Number(vals["wrapuptime"]);
          if (vals["prefix"]) spec.prefix = vals["prefix"];
          spec.joinWhenEmpty = vals["joinempty"] !== "no";
          spec.leaveWhenEmpty = vals["leavewhenempty"] === "yes";
          spec.autofill = !!checks["autofill"];
          spec.autoPause = !!checks["autopause"];
          spec.lastDestination = { categoryId: destKind === "voicemail" ? "25" : "1", targetId: destExt };
          await apiPost("/admin/pbx-console/queues", { pbxTenantId: Number(tenantId), spec });
        }
        push(`${vals["description"].trim()} created — it is live now (the console applies for you).`);
      }
      onClose(); await onDone();
    } catch (e) { push(errText(e, "Nothing was saved."), "bad"); }
    setBusy(false);
  };
  const setVal = (k: string, v: string) => setVals((s) => ({ ...s, [k]: v }));
  return (
    <div className="pc-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="pc-modal" role="dialog" aria-modal="true" style={{ maxWidth: 720 }}>
        <h3>{edit ? `Edit ${edit.description || edit.extension}` : kind === "rg" ? "New ring group" : "New queue"}</h3>
        <div className="pc-mbody" style={{ maxHeight: "62vh", overflowY: "auto" }}>
          {!edit ? (
            <div className="pc-f"><label>Customer</label>
              <select className="pc-ctl" value={tenantId} onChange={(e) => { setTenantId(e.target.value); setMembers([{ extensionId: "", penalty: "" }]); setDestExt(""); }}>
                <option value="">— pick —</option>
                {tenants.filter((t) => t.extensions.length).map((t) => <option key={t.tenantId} value={String(t.tenantId)}>{t.description}</option>)}
              </select>
            </div>
          ) : null}
          {FIELDS.slice(0, edit ? FIELDS.length : kind === "rg" ? 4 : 8).map((f) => (
            <div className="pc-f" key={f.k}>
              <label>{f.label}</label>
              {f.type === "sel" ? (
                <select className="pc-ctl" value={vals[f.k] ?? ""} onChange={(e) => setVal(f.k, e.target.value)}>
                  {(vals[f.k] ?? "") === "" ? <option value="">—</option> : null}
                  {(f.opts || []).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                </select>
              ) : (
                <input className="pc-ctl" value={vals[f.k] ?? ""} onChange={(e) => setVal(f.k, e.target.value)} inputMode={f.type === "num" ? "numeric" : undefined} />
              )}
              {f.help ? <div className="pc-help">{f.help}</div> : null}
            </div>
          ))}
          {edit ? CHECKS.map((c) => (
            <div className="pc-f" key={c.k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" id={`tc-${c.k}`} checked={!!checks[c.k]} onChange={(e) => setChecks((s) => ({ ...s, [c.k]: e.target.checked }))} />
              <label htmlFor={`tc-${c.k}`} style={{ margin: 0 }}>{c.label}</label>
            </div>
          )) : null}
          <div className="pc-f"><label>{kind === "rg" ? "Members (ring order)" : "Agents"}</label>
            {members.map((m, i) => (
              <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                <select className="pc-ctl" style={{ flex: 1 }} value={m.extensionId} onChange={(e) => setMembers((s) => s.map((x, j) => j === i ? { ...x, extensionId: e.target.value } : x))}>
                  <option value="">— pick an extension —</option>
                  {memberOpts.map((x) => <option key={x.id} value={String(x.id)}>{x.number} — {x.name}</option>)}
                </select>
                {kind === "queue" ? <input className="pc-ctl" style={{ width: 110 }} placeholder="penalty" value={m.penalty} onChange={(e) => setMembers((s) => s.map((x, j) => j === i ? { ...x, penalty: e.target.value } : x))} /> : null}
                <button className="pc-btn pc-btn-sm pc-btn-ghost" onClick={() => setMembers((s) => s.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <button className="pc-btn pc-btn-sm" onClick={() => setMembers((s) => [...s, { extensionId: "", penalty: "" }])}>Add member</button>
            {kind === "queue" ? <div className="pc-help">Lower penalty rings first; equal penalties share a tier.</div> : null}
          </div>
          {!edit ? (
            <div className="pc-f"><label>{kind === "rg" ? "If nobody answers" : "Last destination (required)"}</label>
              <div style={{ display: "flex", gap: 8 }}>
                <select className="pc-ctl" value={destKind} onChange={(e) => setDestKind(e.target.value as any)}>
                  <option value="extension">Ring an extension</option>
                  <option value="voicemail">Voicemail of</option>
                </select>
                <select className="pc-ctl" style={{ flex: 1 }} value={destExt} onChange={(e) => setDestExt(e.target.value)}>
                  <option value="">— pick —</option>
                  {memberOpts.map((x) => <option key={x.id} value={String(x.id)}>{x.number} — {x.name}</option>)}
                </select>
              </div>
            </div>
          ) : null}
        </div>
        <div className="pc-mfoot">
          <button className="pc-btn pc-btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="pc-btn" disabled={!ready} onClick={submit}>{busy ? "Saving…" : edit ? "Save" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

function GeoView({ geo, push, reload }: { geo: (Geo & { enforcement?: any }) | null; push: any; reload: any }) {
  const [busy, setBusy] = useState(false);
  if (!geo) return <div className="pc-state"><span className="pc-spin" /></div>;
  const blocked = geo.countries.filter((c) => c.blocked);
  const toggle = async (iso: string, nowBlocked: boolean) => {
    const verb = nowBlocked ? "Unblock" : "Block";
    if (!window.confirm(`${verb} ${iso}? This changes the live firewall for every customer.`)) return;
    setBusy(true);
    try {
      await apiPost("/admin/pbx-console/geo", nowBlocked ? { unblock: [iso] } : { block: [iso] });
      push(`${iso} ${nowBlocked ? "unblocked" : "blocked"} and the firewall was rebuilt.`);
      await reload();
    } catch (e) { push(errText(e, "The firewall was not changed."), "bad"); }
    setBusy(false);
  };
  return (
    <>
      <div className="pc-note"><span className="pc-ico">!</span><div><b>This is the live firewall for every customer.</b> The allow list below is checked first, which is how our own server and a blocked-country employee still get through. If the phone system can&apos;t rebuild the rules, a change is refused rather than left saying &ldquo;blocked&rdquo; while the traffic still arrives.</div></div>
      <div className="pc-tablewrap"><div className="pc-tscroll"><table className="pc-table">
        <thead><tr><th>Country</th><th>Code</th><th>Phone traffic</th><th /></tr></thead>
        <tbody>{geo.countries.map((c) => (
          <tr key={c.id}>
            <td>{c.country}</td><td className="pc-mono">{c.iso}</td>
            <td>{c.blocked ? <span className="pc-pill bad">Blocked</span> : <span className="pc-pill ok">Allowed</span>}</td>
            <td><button className="pc-btn pc-btn-sm" disabled={busy} onClick={() => toggle(c.iso, c.blocked)}>{c.blocked ? "Unblock" : "Block"}</button></td>
          </tr>))}</tbody>
      </table></div></div>
      <div style={{ height: 18 }} />
      <div className="pc-tablewrap"><div className="pc-tscroll"><table className="pc-table">
        <thead><tr><th>Always-allow ({geo.whitelist.length})</th><th>What it is</th><th>Built in</th></tr></thead>
        <tbody>{geo.whitelist.map((w) => <tr key={w.id}><td className="pc-mono">{w.host}</td><td>{w.description}</td><td>{w.isDefault ? <span className="pc-pill off">system</span> : <span className="pc-pill ok">added</span>}</td></tr>)}</tbody>
      </table></div></div>
    </>
  );
}

/* ── editor ─────────────────────────────────────────────────────────────── */
function validate(kind: Module, d: any): Record<string, string> {
  const e: Record<string, string> = {};
  if (kind === "tenants") {
    if (!d.description) e.description = "Required.";
    if (d.cidNumber && normPhone(d.cidNumber).length !== 10) e.cidNumber = "A caller ID number is 10 digits.";
  }
  if (kind === "extensions") {
    if (!d.extension) e.extension = "Required.";
    else if (!/^\d{3,}$/.test(d.extension)) e.extension = "Three digits or more — shorter numbers break the phone system.";
    else if (/^8\d\d$/.test(d.extension)) e.extension = "800s are reserved for ring groups.";
    else if (/^9\d\d$/.test(d.extension)) e.extension = "900s are reserved for queues.";
    if (!d.name) e.name = "Required.";
    if (d.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) e.email = "That doesn't look like an email address.";
    if (d._new && !d.tenantId) e.tenantId = "Pick a customer.";
    (d.devices || []).forEach((dev: DeviceDraft, i: number) => {
      if (dev.kind === "virtual" && normPhone(dev.number).length !== 10) e["dev" + i] = "Enter the full 10-digit phone number this should ring.";
      if (dev.kind !== "virtual" && d._new && !dev.secret && !dev.deviceId) { /* server generates on import */ }
    });
    if (!d.devices?.length) e.devices = "An extension needs at least one device.";
  }
  return e;
}

function Editor({ editor, setEditor, tenants, tenantName, saving, setSaving, dirty, close, afterSave, push, catalog }: any) {
  const { kind, id, draft } = editor;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: any) => setEditor((ed: any) => ({ ...ed, draft: { ...ed.draft, ...patch } }));

  const save = async (apply = true) => {
    const errs = validate(kind, draft);
    setErrors(errs);
    if (Object.keys(errs).length) { push("Fix " + Object.keys(errs).length + " problem" + (Object.keys(errs).length === 1 ? "" : "s") + " before saving.", "bad"); return; }
    setSaving(true);
    try {
      if (kind === "tenants") {
        await apiPatch(`/admin/pbx-console/tenants/${id}`, { set: { description: draft.description, cid_name: draft.cidName, cid_number: normPhone(draft.cidNumber) }, checks: { enabled: draft.enabled }, inboundNumbers: draft.inbound.map((n: any) => ({ did: normPhone(n.did), description: n.description })) });
      } else if (kind === "extensions") {
        const devices = draft.devices.map((dev: DeviceDraft) => ({ id: dev.deviceId, kind: dev.kind, user: dev.user || undefined, secret: dev.secret || undefined, description: dev.description || undefined, number: dev.number || undefined, dtmf: dev.dtmf || undefined, ringDevice: dev.ringDevice, maxContacts: dev.maxContacts || undefined }));
        const generalSet = { name: draft.name, email: draft.email };
        const checks = { vm_enabled: draft.vmEnabled, outgoing_rec: draft.outgoingRec, incoming_rec: draft.incomingRec };
        if (id) await apiPatch(`/admin/pbx-console/extensions/${id}`, { set: generalSet, checks, devices });
        else await apiPost(`/admin/pbx-console/extensions`, { pbxTenantId: draft.tenantId, extension: draft.extension, name: draft.name, email: draft.email, set: generalSet, checks, devices });
      }
      push(apply ? (kind === "tenants" ? "Customer" : "Extension") + " saved and applied to the phone system." : "Saved.");
      setEditor(null);
      await afterSave();
    } catch (e) { push(errText(e, "The phone system rejected the change."), "bad"); }
    setSaving(false);
  };

  const del = async () => {
    if (!window.confirm(kind === "tenants" ? "Delete this customer and everything under it? This can't be undone." : "Delete this extension? This can't be undone.")) return;
    setSaving(true);
    try {
      if (kind === "tenants") await apiDelete(`/admin/pbx-console/tenants/${id}`);
      else await apiDelete(`/admin/pbx-console/extensions/${id}`);
      push("Deleted."); setEditor(null); await afterSave();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as any) : null;
      if (body?.error === "extension_in_use") {
        if (window.confirm(body.detail + "\n\nDelete anyway?")) { try { await apiPost(`/admin/pbx-console/extensions/${id}/force-delete`, {}); push("Deleted."); setEditor(null); await afterSave(); } catch (e2) { push(errText(e2, "Delete failed."), "bad"); } }
      } else push(errText(e, "Delete failed."), "bad");
    }
    setSaving(false);
  };

  const title = kind === "tenants" ? draft.description || "Customer" : (draft.extension ? draft.extension + " · " : "") + (draft.name || "New extension");
  const sub = kind === "tenants" ? draft._t?.name : id ? tenantName(slugForTenantId(draft.tenantId, tenants)) : draft.tenantId ? tenantName(slugForTenantId(draft.tenantId, tenants)) : "new";

  return (
    <div className="pc-editor">
      <div className="pc-ehead"><h2>{id ? "Edit" : "Create"} {kind === "tenants" ? "customer" : "extension"}</h2><span className="pc-sub">{title} · {sub}</span><span className="pc-spacer" />
        {id ? <button className="pc-btn pc-btn-sm pc-btn-danger" onClick={del} disabled={saving}>Delete</button> : null}
        <button className="pc-btn pc-btn-sm" onClick={close}>← Back</button></div>
      <div className="pc-body">
        {kind === "tenants" ? <TenantForm draft={draft} set={set} errors={errors} /> : <ExtensionForm draft={draft} set={set} errors={errors} tenants={tenants} isNew={!id} />}
      </div>
      <div className="pc-savebar">
        <button className="pc-btn pc-btn-primary" onClick={() => save(true)} disabled={saving}>{saving ? "Saving…" : "Save & apply"}</button>
        <button className="pc-btn pc-btn-ghost" onClick={close} disabled={saving}>Cancel</button>
        <span className="pc-spacer" />
        <span className={dirty ? "pc-dirty" : "pc-clean"}>{Object.keys(errors).length ? `${Object.keys(errors).length} to fix` : dirty ? "Unsaved changes" : "No changes"}</span>
      </div>
    </div>
  );
}

function Field({ label, req, err, help, children }: any) {
  return <div className="pc-f"><label>{label}{req ? <span className="pc-req"> *</span> : null}</label>{children}{err ? <div className="pc-err-msg">{err}</div> : help ? <div className="pc-help">{help}</div> : null}</div>;
}

function TenantForm({ draft, set, errors }: any) {
  return (
    <>
      <div className="pc-sect"><h3>Identity</h3><div className="pc-grid">
        <Field label="Name" req err={errors.description}><input className={"pc-ctl " + (errors.description ? "bad" : "")} value={draft.description} onChange={(e) => set({ description: e.target.value })} /></Field>
        <div className="pc-f"><label className="pc-check"><input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /><span className="pc-t"><b>Enabled</b><span>Turning this off stops every call for this customer</span></span></label></div>
      </div></div>
      <div className="pc-sect"><h3>Outbound caller ID</h3><div className="pc-grid">
        <Field label="Default external CID name"><input className="pc-ctl" value={draft.cidName} onChange={(e) => set({ cidName: e.target.value })} /></Field>
        <Field label="Default external CID number" err={errors.cidNumber}><input className={"pc-ctl " + (errors.cidNumber ? "bad" : "")} value={draft.cidNumber} onChange={(e) => set({ cidNumber: e.target.value })} inputMode="tel" /></Field>
      </div></div>
      <div className="pc-sect"><h3>Numbers</h3><div className="pc-hint">The numbers that belong to this customer.</div>
        <div className="pc-repeat">
          {draft.inbound.map((n: any, i: number) => (
            <div key={i} className="pc-repeat-row c2">
              <input className="pc-ctl pc-mono" value={n.did} inputMode="tel" placeholder="10 digits" onChange={(e) => set({ inbound: draft.inbound.map((x: any, j: number) => j === i ? { ...x, did: e.target.value } : x) })} />
              <input className="pc-ctl" value={n.description} placeholder="Description" onChange={(e) => set({ inbound: draft.inbound.map((x: any, j: number) => j === i ? { ...x, description: e.target.value } : x) })} />
              <button className="pc-btn pc-btn-sm pc-btn-ghost" onClick={() => set({ inbound: draft.inbound.filter((_: any, j: number) => j !== i) })}>Remove</button>
            </div>
          ))}
        </div>
        <button className="pc-btn pc-btn-sm" onClick={() => set({ inbound: [...draft.inbound, { did: "", description: "" }] })}>+ Add number</button>
      </div>
    </>
  );
}

function ExtensionForm({ draft, set, errors, tenants, isNew }: any) {
  const setDev = (i: number, patch: any) => set({ devices: draft.devices.map((d: DeviceDraft, j: number) => j === i ? { ...d, ...patch } : d) });
  return (
    <>
      <div className="pc-sect"><h3>Identity</h3><div className="pc-grid">
        {isNew && <Field label="Customer" req err={errors.tenantId}><select className={"pc-ctl " + (errors.tenantId ? "bad" : "")} value={draft.tenantId} onChange={(e) => { const t = tenants.find((x: Tenant) => x.tenantId === Number(e.target.value)); set({ tenantId: Number(e.target.value), tenantPath: t?.path }); }}><option value={0}>Pick a customer…</option>{tenants.filter((t: Tenant) => !t.isMain).map((t: Tenant) => <option key={t.tenantId} value={t.tenantId}>{t.description}</option>)}</select></Field>}
        <Field label="Extension" req err={errors.extension} help={isNew ? "Three digits or more. 800s ring groups, 900s queues, 2000s forwards." : "The phone system can't renumber an extension."}>
          <input className={"pc-ctl pc-mono " + (errors.extension ? "bad" : "")} value={draft.extension} disabled={!isNew} onChange={(e) => set({ extension: e.target.value })} /></Field>
        <Field label="Name" req err={errors.name} help="The name Connect shows everywhere, and on emails."><input className={"pc-ctl " + (errors.name ? "bad" : "")} value={draft.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Email address" err={errors.email}><input className={"pc-ctl " + (errors.email ? "bad" : "")} value={draft.email} onChange={(e) => set({ email: e.target.value })} /></Field>
      </div></div>
      <div className="pc-sect"><h3>Recording &amp; voicemail</h3><div className="pc-grid">
        <div className="pc-f"><label className="pc-check"><input type="checkbox" checked={draft.vmEnabled} onChange={(e) => set({ vmEnabled: e.target.checked })} /><span className="pc-t"><b>Voicemail</b></span></label></div>
        <div className="pc-f"><label className="pc-check"><input type="checkbox" checked={draft.incomingRec} onChange={(e) => set({ incomingRec: e.target.checked })} /><span className="pc-t"><b>Record incoming</b></span></label></div>
        <div className="pc-f"><label className="pc-check"><input type="checkbox" checked={draft.outgoingRec} onChange={(e) => set({ outgoingRec: e.target.checked })} /><span className="pc-t"><b>Record outgoing</b></span></label></div>
      </div></div>
      <div className="pc-sect"><h3>Devices</h3><div className="pc-hint">A desk phone and the Connect app are the usual pair. Add &ldquo;Rings a phone number&rdquo; to also ring a cell.</div>
        {draft.devices.map((d: DeviceDraft, i: number) => (
          <div key={i} className="pc-card">
            <div className="pc-chead"><b>{d.description || KIND_LABEL[d.kind]}</b><span className={"pc-pill " + (d.kind === "virtual" ? "warn" : "ok")}>{KIND_LABEL[d.kind]}</span><span className="pc-spacer" />
              {draft.devices.length > 1 ? <button className="pc-btn pc-btn-sm pc-btn-ghost pc-btn-danger" onClick={() => set({ devices: draft.devices.filter((_: any, j: number) => j !== i) })}>Remove</button> : null}</div>
            {!d.deviceId && <div className="pc-f" style={{ marginBottom: 10 }}><label>Type</label><div className="pc-radios">
              {(["pjsip", "webrtc", "virtual", "iax"] as DeviceKind[]).map((k) => <label key={k} className={d.kind === k ? "on" : ""}><input type="radio" name={"k" + i} checked={d.kind === k} onChange={() => setDev(i, { kind: k, description: KIND_LABEL[k], maxContacts: k === "webrtc" ? "5" : "1", number: k === "virtual" ? d.number : "" })} />{KIND_LABEL[k]}</label>)}
            </div></div>}
            {d.deviceId ? <div className="pc-help" style={{ marginBottom: 8 }}>A device&apos;s type can&apos;t be changed after it&apos;s created — remove it and add a new one instead.</div> : null}
            {d.kind === "virtual" ? <div className="pc-grid">
              <Field label="Phone number to ring" req err={errors["dev" + i]} help="The outside number this rings — usually somebody's cell."><input className={"pc-ctl " + (errors["dev" + i] ? "bad" : "")} value={d.number} inputMode="tel" onChange={(e) => setDev(i, { number: e.target.value })} /></Field>
              <div className="pc-f"><label className="pc-check"><input type="checkbox" checked={d.ringDevice} onChange={(e) => setDev(i, { ringDevice: e.target.checked })} /><span className="pc-t"><b>Ring this number</b></span></label></div>
            </div> : <div className="pc-grid">
              <Field label="Device name" help={d.deviceId ? "" : "Named by the phone system from the customer and extension."}><input className="pc-ctl pc-mono" value={d.user} placeholder={d.deviceId ? "" : "auto"} onChange={(e) => setDev(i, { user: e.target.value })} /></Field>
              <Field label="Password" help={d.deviceId ? "Leave blank to keep the current password." : "Leave blank and the phone system generates one."}><input className="pc-ctl" type="password" value={d.secret} onChange={(e) => setDev(i, { secret: e.target.value })} /></Field>
              <Field label="Description"><input className="pc-ctl" value={d.description} onChange={(e) => setDev(i, { description: e.target.value })} /></Field>
              <div className="pc-f"><label className="pc-check"><input type="checkbox" checked={d.ringDevice} onChange={(e) => setDev(i, { ringDevice: e.target.checked })} /><span className="pc-t"><b>Ring this device</b></span></label></div>
            </div>}
          </div>
        ))}
        {errors.devices ? <div className="pc-err-msg" style={{ marginBottom: 8 }}>{errors.devices}</div> : null}
        {draft.devices.length < 8 ? <button className="pc-btn pc-btn-sm" onClick={() => set({ devices: [...draft.devices, dDraft("pjsip")] })}>+ Add device</button> : null}
      </div>
    </>
  );
}

export default function PbxConsolePage() {
  // ⛔ can_manage_global_settings, NOT can_view_admin_pbx_instances — the live
  // snapshot gives that second key to TENANT_ADMIN (10 active customer admins),
  // so this gate was passing for customers and the header's "SUPER_ADMIN only
  // (forced in navConfig + PermissionGate + the api requireOwner)" was true of
  // only two of those three. Nothing leaked (every api call 403s and the
  // /admin/pbx-console prefix rule demands this same key), but a customer could
  // render the console's frame. Found in the 2026-08-20 tenant-leak sweep.
  return <PermissionGate permission={"can_manage_global_settings" as never} fallback={<div className="pc-state">This page is for the platform owner.</div>}><PbxConsole /></PermissionGate>;
}
