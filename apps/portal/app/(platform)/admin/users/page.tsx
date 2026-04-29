"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Mail, Plus, Search, Shield, UserCog, XCircle } from "lucide-react";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPatch, apiPost } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";

type TenantOption = { id: string; name: string; status: string; kind?: string };
type ExtensionOption = {
  id: string;
  extNumber: string;
  displayName: string;
  pbxUserEmail?: string | null;
  ownerUserId?: string | null;
  status?: string;
  webrtcEnabled?: boolean;
  pbxDeviceName?: string | null;
  provisionStatus?: string | null;
  isUserFacing?: boolean;
};
type RoleOption = { id: string; label: string };
type CatalogResponse = {
  tenantId: string | null;
  tenants: TenantOption[];
  roles: RoleOption[];
  extensions: ExtensionOption[];
  userFacingOnly: boolean;
  totalExtensions: number;
  filteredOut: number;
};
type AdminUser = {
  id: string;
  tenantId: string;
  tenantName: string | null;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  phone: string;
  title: string;
  department: string;
  notes: string;
  role: string;
  roleLabel: string;
  status: "INVITED" | "ACTIVE" | "DISABLED";
  lastLoginAt: string | null;
  createdAt: string;
  extension: null | { id: string; extNumber: string; displayName: string; status: string };
  invite: null | { expiresAt: string; usedAt: string | null; createdAt: string };
};
type UsersResponse = { users: AdminUser[]; tenants: TenantOption[]; extensions: ExtensionOption[]; roles: string[]; tenantId: string };

// Portal-bucket labels are the source of truth now (the API's /admin/users/catalog
// returns { id, label } for each bucket). We keep this map around so legacy rows
// still display a friendly name when the API returns DB enum values.
const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: "Platform Admin",
  TENANT_ADMIN: "Tenant Admin",
  END_USER: "End User",
  ADMIN: "Tenant Admin",
  MANAGER: "Tenant Admin",
  BILLING_ADMIN: "Tenant Admin",
  BILLING: "Tenant Admin",
  READ_ONLY: "End User",
  EXTENSION_USER: "End User",
  USER: "End User",
};

const DEFAULT_PORTAL_ROLES: RoleOption[] = [
  { id: "END_USER", label: "End User" },
  { id: "TENANT_ADMIN", label: "Tenant Admin" },
  { id: "SUPER_ADMIN", label: "Platform Admin" },
];

const emptyForm = {
  tenantId: "",
  extensionId: "",
  role: "END_USER",
  email: "",
  firstName: "",
  lastName: "",
  displayName: "",
  phone: "",
  title: "",
  department: "",
  notes: "",
  active: true,
  sendInvite: true,
};

function statusTone(status: AdminUser["status"]) {
  if (status === "ACTIVE") return "success";
  if (status === "INVITED") return "warning";
  return "danger";
}

// The API still stores DB UserRole values (USER, TENANT_ADMIN, SUPER_ADMIN, ADMIN,
// BILLING, …). The Users UI only speaks in the 3 portal buckets, so we collapse
// anything richer than that for the role dropdown.
function portalBucketForRole(role: string): string {
  const r = String(role || "").toUpperCase();
  if (r === "SUPER_ADMIN") return "SUPER_ADMIN";
  if (r === "TENANT_ADMIN" || r === "ADMIN" || r === "BILLING" || r === "BILLING_ADMIN" || r === "MESSAGING" || r === "SUPPORT" || r === "MANAGER") return "TENANT_ADMIN";
  return "END_USER";
}

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function AdminUsersPage() {
  const { tenantId: contextTenantId, role } = useAppContext();
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedTenantId, setSelectedTenantId] = useState(contextTenantId);
  const [data, setData] = useState<UsersResponse | null>(null);
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [message, setMessage] = useState("");

  const isSuper = role === "SUPER_ADMIN";
  const effectiveTenantId = isSuper ? selectedTenantId : contextTenantId;

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (effectiveTenantId) params.set("tenantId", effectiveTenantId);
    if (query.trim()) params.set("search", query.trim());
    if (roleFilter !== "all") params.set("role", roleFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    const result = await apiGet<UsersResponse>(`/admin/users?${params.toString()}`);
    setData(result);
    if (result.tenantId && (!selectedTenantId || !result.tenants.some((t) => t.id === selectedTenantId))) {
      setSelectedTenantId(result.tenantId);
    }
  }, [effectiveTenantId, query, roleFilter, selectedTenantId, statusFilter]);

  useEffect(() => { load().catch((e: any) => setMessage(e?.message || "Failed to load users")); }, [load]);

  const stats = useMemo(() => {
    const rows = data?.users || [];
    return {
      total: rows.length,
      active: rows.filter((u) => u.status === "ACTIVE").length,
      invited: rows.filter((u) => u.status === "INVITED").length,
      disabled: rows.filter((u) => u.status === "DISABLED").length,
    };
  }, [data]);

  async function action(path: string, success: string) {
    setMessage("");
    try {
      await apiPost(path, {});
      setMessage(success);
      await load();
    } catch (e: any) {
      setMessage(e?.message || "Action failed");
    }
  }

  return (
    <PermissionGate permission="can_view_admin" fallback={<div className="state-box">You do not have user admin access.</div>}>
      <div className="stack" style={{ gap: 18 }}>
        <PageHeader title="Users" subtitle="Create users, assign tenant extensions, manage roles, and send password setup emails." />

        <section className="grid four">
          <Stat label="Total Users" value={stats.total} />
          <Stat label="Active" value={stats.active} tone="success" />
          <Stat label="Invited" value={stats.invited} tone="warning" />
          <Stat label="Disabled" value={stats.disabled} tone="danger" />
        </section>

        <section className="panel" style={{ padding: 16 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ position: "relative", flex: "1 1 260px" }}>
              <Search size={16} style={{ position: "absolute", left: 12, top: 12, opacity: .55 }} />
              <input className="input" style={{ paddingLeft: 36 }} placeholder="Search name, email, phone, extension..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {isSuper ? (
              <select className="input" style={{ width: 230 }} value={selectedTenantId} onChange={(e) => setSelectedTenantId(e.target.value)}>
                {(data?.tenants || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            ) : null}
            <select className="input" style={{ width: 170 }} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
              <option value="all">All roles</option>
              {DEFAULT_PORTAL_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            <select className="input" style={{ width: 150 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All status</option>
              <option value="INVITED">Invited</option>
              <option value="ACTIVE">Active</option>
              <option value="DISABLED">Disabled</option>
            </select>
            <button className="btn" onClick={() => setCreating(true)}><Plus size={16} /> Create User</button>
          </div>
          {message ? <div className="chip info" style={{ marginTop: 12 }}>{message}</div> : null}
        </section>

        <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>User</th><th>Tenant</th><th>Extension</th><th>Role</th><th>Status</th><th>Last Login</th><th>Actions</th></tr></thead>
              <tbody>
                {(data?.users || []).map((u) => (
                  <tr key={u.id} onClick={() => setSelected(u)} style={{ cursor: "pointer" }}>
                    <td><strong>{u.displayName}</strong><div className="muted">{u.email}</div></td>
                    <td>{u.tenantName || "Tenant"}</td>
                    <td>{u.extension ? `${u.extension.extNumber} · ${u.extension.displayName}` : "Unassigned"}</td>
                    <td>{ROLE_LABEL[u.role] || u.role}</td>
                    <td><span className={`chip ${statusTone(u.status)}`}>{u.status.toLowerCase()}</span></td>
                    <td>{formatDate(u.lastLoginAt)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button className="btn ghost" onClick={() => setEditing(u)}>Edit</button>
                        {u.status === "DISABLED"
                          ? <button className="btn ghost" onClick={() => action(`/admin/users/${u.id}/enable`, "User enabled")}>Enable</button>
                          : <button className="btn ghost" onClick={() => action(`/admin/users/${u.id}/disable`, "User disabled")}>Disable</button>}
                        <button className="btn ghost" onClick={() => action(`/admin/users/${u.id}/resend-invite`, "Invite queued")}>Resend</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {data && data.users.length === 0 ? <tr><td colSpan={7}><div className="state-box">No users match your filters.</div></td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>

        {selected ? <UserPanel user={selected} onClose={() => setSelected(null)} onEdit={() => { setEditing(selected); setSelected(null); }} /> : null}
        {creating ? <UserModal mode="create" defaultTenantId={effectiveTenantId} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} /> : null}
        {editing ? <UserModal mode="edit" user={editing} defaultTenantId={editing.tenantId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} /> : null}
      </div>
    </PermissionGate>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return <div className="panel" style={{ padding: 18 }}><div className="muted">{label}</div><div style={{ fontSize: 30, fontWeight: 900, color: tone === "danger" ? "var(--danger)" : tone === "warning" ? "var(--warning)" : tone === "success" ? "var(--success)" : "inherit" }}>{value}</div></div>;
}

function UserPanel({ user, onClose, onEdit }: { user: AdminUser; onClose: () => void; onEdit: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <aside className="modal" style={{ marginLeft: "auto", width: "min(460px, 94vw)", height: "100vh", borderRadius: "22px 0 0 22px", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <button className="btn ghost" style={{ float: "right" }} onClick={onClose}>Close</button>
        <div style={{ width: 64, height: 64, borderRadius: 22, background: "linear-gradient(135deg,#2563eb,#7c3aed)", color: "#fff", display: "grid", placeItems: "center", fontWeight: 900, fontSize: 24 }}>{user.displayName.slice(0, 1).toUpperCase()}</div>
        <h2>{user.displayName}</h2>
        <p className="muted">{user.email}</p>
        <div className="stack" style={{ gap: 10, marginTop: 20 }}>
          <Info label="Tenant" value={user.tenantName || user.tenantId} />
          <Info label="Extension" value={user.extension ? `${user.extension.extNumber} · ${user.extension.displayName}` : "Unassigned"} />
          <Info label="Role" value={ROLE_LABEL[user.role] || user.role} />
          <Info label="Status" value={user.status} />
          <Info label="Invite" value={user.invite ? `Expires ${formatDate(user.invite.expiresAt)}` : "No open invite"} />
          <Info label="Last Login" value={formatDate(user.lastLoginAt)} />
          <Info label="Title" value={user.title || "—"} />
          <Info label="Department" value={user.department || "—"} />
          <Info label="Notes" value={user.notes || "—"} />
        </div>
        <button className="btn" style={{ marginTop: 18 }} onClick={onEdit}><UserCog size={16} /> Edit User</button>
        {user.extension ? <PhoneProvisioningPanel userId={user.id} /> : null}
      </aside>
    </div>
  );
}

type PhoneStatus = {
  provisionStatus: "PENDING" | "PROVISIONED" | "FAILED" | "DISABLED" | string;
  provisionSource: string | null;
  hasSipPassword: boolean;
  webrtcEnabled: boolean;
  endpointName: string | null;
  extensionNumber: string | null;
  lastProvisionedAt: string | null;
};

function provisionTone(status: string): string {
  if (status === "PROVISIONED") return "success";
  if (status === "FAILED") return "danger";
  if (status === "DISABLED") return "info";
  return "warning";
}

function PhoneProvisioningPanel({ userId }: { userId: string }) {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await apiGet<any>(`/admin/users/${userId}/phone/status`);
      setStatus({
        provisionStatus: r.provisionStatus || "PENDING",
        provisionSource: r.provisionSource || null,
        hasSipPassword: !!r.hasSipPassword,
        webrtcEnabled: !!r.webrtcEnabled,
        endpointName: r.endpointName || null,
        extensionNumber: r.extensionNumber || null,
        lastProvisionedAt: r.lastProvisionedAt || null,
      });
    } catch {
      setStatus(null);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  async function run(action: "provision" | "sync" | "disable", body: Record<string, unknown> = {}) {
    setBusy(action);
    setMessage("");
    try {
      const r = await apiPost<any>(`/admin/users/${userId}/phone/${action}`, body);
      setMessage(r?.message || `Phone ${action} succeeded`);
      await load();
    } catch (e: any) {
      setMessage(e?.message || `Phone ${action} failed`);
    } finally {
      setBusy(null);
    }
  }

  async function runRegenerate() {
    const confirmed = typeof window !== "undefined" && window.confirm("Regenerate the SIP password? Any desk phone still using the old secret will stop registering until it is updated.");
    if (!confirmed) return;
    setBusy("regenerate");
    setMessage("");
    try {
      const r = await apiPost<any>(`/admin/users/${userId}/phone/regenerate`, { confirm: true, acknowledgeBreaksExistingPhones: true });
      setMessage(r?.message || "SIP password regenerated");
      await load();
    } catch (e: any) {
      setMessage(e?.message || "Regenerate failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel" style={{ marginTop: 18, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>Portal Phone</h3>
        {status ? <span className={`chip ${provisionTone(status.provisionStatus)}`}>{String(status.provisionStatus).toLowerCase()}</span> : null}
      </div>
      {status ? (
        <div className="stack" style={{ gap: 6, marginTop: 10 }}>
          <Info label="Endpoint" value={status.endpointName || "—"} />
          <Info label="Extension" value={status.extensionNumber || "—"} />
          <Info label="WebRTC" value={status.webrtcEnabled ? "Enabled" : "Disabled"} />
          <Info label="SIP password" value={status.hasSipPassword ? "Encrypted at rest" : "Not set"} />
          <Info label="Source" value={status.provisionSource ? status.provisionSource.toLowerCase() : "—"} />
          <Info label="Last sync" value={formatDate(status.lastProvisionedAt)} />
        </div>
      ) : (
        <p className="muted" style={{ marginTop: 8 }}>No PBX link for this user yet. Sync the extension from the PBX to activate the portal softphone.</p>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <button className="btn ghost" disabled={busy !== null} onClick={() => run("provision")}>{busy === "provision" ? "Working..." : "Provision"}</button>
        <button className="btn ghost" disabled={busy !== null} onClick={() => run("sync")}>{busy === "sync" ? "Syncing..." : "Re-sync credentials"}</button>
        <button className="btn ghost" disabled={busy !== null} onClick={runRegenerate} style={{ borderColor: "var(--danger, #ef4444)", color: "var(--danger, #ef4444)" }}>{busy === "regenerate" ? "Resetting..." : "Regenerate password"}</button>
        <button className="btn ghost" disabled={busy !== null} onClick={() => run("disable")}>{busy === "disable" ? "Working..." : "Disable portal phone"}</button>
      </div>
      {message ? <div className="chip info" style={{ marginTop: 10 }}>{message}</div> : null}
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border)" }}><span className="muted">{label}</span><strong style={{ textAlign: "right" }}>{value}</strong></div>;
}

function UserModal({ mode, user, defaultTenantId, onClose, onSaved }: {
  mode: "create" | "edit"; user?: AdminUser; defaultTenantId: string; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState(() => user ? {
    tenantId: user.tenantId,
    extensionId: user.extension?.id || "",
    role: portalBucketForRole(user.role),
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    displayName: user.displayName,
    phone: user.phone,
    title: user.title,
    department: user.department,
    notes: user.notes,
    active: user.status !== "DISABLED",
    sendInvite: false,
  } : { ...emptyForm, tenantId: defaultTenantId || "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>(DEFAULT_PORTAL_ROLES);
  const [extensionOptions, setExtensionOptions] = useState<ExtensionOption[]>([]);
  const [userFacingOnly, setUserFacingOnly] = useState(true);
  const [extensionFilterStats, setExtensionFilterStats] = useState<{ total: number; hidden: number }>({ total: 0, hidden: 0 });
  const selectedExtension = extensionOptions.find((e) => e.id === form.extensionId);
  const roleOptions = roles.length ? roles : DEFAULT_PORTAL_ROLES;

  // Bootstrap: fetch tenants + portal-bucket roles the first time the modal opens.
  useEffect(() => {
    let active = true;
    apiGet<CatalogResponse>(`/admin/users/catalog?userFacingOnly=${userFacingOnly ? "true" : "false"}`)
      .then((r) => {
        if (!active) return;
        setTenants(r.tenants || []);
        if (r.roles?.length) setRoles(r.roles);
        if (!form.tenantId) {
          const initial = r.tenants.some((t) => t.id === defaultTenantId) ? defaultTenantId : (r.tenants[0]?.id || "");
          if (initial) setForm((f) => ({ ...f, tenantId: initial }));
        }
      })
      .catch((e: any) => { if (active) setError(e?.message || "Failed to load tenants"); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh the extension dropdown every time the tenant or the user-facing
  // toggle changes. The server already filters for us.
  useEffect(() => {
    let active = true;
    if (!form.tenantId) return;
    const qs = new URLSearchParams({
      tenantId: form.tenantId,
      userFacingOnly: userFacingOnly ? "true" : "false",
    });
    apiGet<CatalogResponse>(`/admin/users/catalog?${qs.toString()}`)
      .then((r) => {
        if (!active) return;
        setExtensionOptions(r.extensions || []);
        setExtensionFilterStats({ total: r.totalExtensions, hidden: r.filteredOut });
      })
      .catch(() => { if (active) setExtensionOptions([]); });
    return () => { active = false; };
  }, [form.tenantId, userFacingOnly]);

  async function pickExtension(id: string) {
    setForm((f) => ({ ...f, extensionId: id }));
    if (!id || mode !== "create") return;
    try {
      const qs = new URLSearchParams({ tenantId: form.tenantId, extensionId: id });
      const result = await apiGet<{ prefill: Partial<typeof emptyForm>; warning: string | null }>(`/admin/users/extension-prefill?${qs.toString()}`);
      setForm((f) => ({
        ...f,
        firstName: f.firstName || result.prefill.firstName || "",
        lastName: f.lastName || result.prefill.lastName || "",
        displayName: f.displayName || result.prefill.displayName || "",
        email: f.email || result.prefill.email || "",
        phone: f.phone || result.prefill.phone || "",
      }));
      if (result.warning) setError("This extension is already linked to another active user.");
      else setError("");
    } catch (e: any) {
      setError(e?.message || "Could not load extension details");
    }
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      if (mode === "create") await apiPost("/admin/users", form);
      else if (user) await apiPatch(`/admin/users/${user.id}`, { ...form, status: form.active ? "ACTIVE" : "DISABLED" });
      onSaved();
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: "min(760px, 94vw)", maxHeight: "92vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12 }}>
          <div><h2>{mode === "create" ? "Create User" : "Edit User"}</h2><p className="muted">Tenant and extension are validated server-side.</p></div>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
        <div className="grid two" style={{ marginTop: 16 }}>
          <Field label="Tenant">
            <select className="input" value={form.tenantId} disabled={mode === "edit"} onChange={(e) => setForm({ ...form, tenantId: e.target.value, extensionId: "" })}>
              <option value="">Select tenant</option>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}{t.status === "SUSPENDED" ? " (suspended)" : ""}</option>)}
            </select>
          </Field>
          <Field label="Extension">
            <select className="input" value={form.extensionId} onChange={(e) => pickExtension(e.target.value)}>
              <option value="">Select extension</option>
              {extensionOptions.map((e) => {
                const assigned = e.ownerUserId && e.ownerUserId !== user?.id;
                const pieces = [
                  `${e.extNumber} \u00b7 ${e.displayName}`,
                  e.pbxDeviceName ? `(${e.pbxDeviceName})` : null,
                  assigned ? "\u2014 assigned" : null,
                  !e.webrtcEnabled ? "\u2014 webrtc off" : null,
                ].filter(Boolean);
                return <option key={e.id} value={e.id} disabled={!!assigned}>{pieces.join(" ")}</option>;
              })}
            </select>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                <input type="checkbox" checked={userFacingOnly} onChange={(e) => setUserFacingOnly(e.target.checked)} />
                <span className="muted">User-facing only{extensionFilterStats.total ? ` \u00b7 showing ${extensionOptions.length}/${extensionFilterStats.total}` : ""}</span>
              </label>
              {selectedExtension?.provisionStatus ? <span className="muted" style={{ fontSize: 12 }}>Provision: {selectedExtension.provisionStatus.toLowerCase()}</span> : null}
            </div>
          </Field>
          <Field label="Role">
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {roleOptions.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </Field>
          <Field label="Email"><input className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="First name"><input className="input" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></Field>
          <Field label="Last name"><input className="input" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></Field>
          <Field label="Display name"><input className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
          <Field label="Phone"><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Title"><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Department"><input className="input" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} /></Field>
        </div>
        {selectedExtension ? <div className="state-box" style={{ marginTop: 14 }}><Shield size={16} /> Selected extension {selectedExtension.extNumber} belongs to this tenant and will be linked to the user.</div> : null}
        <Field label="Notes"><textarea className="input" rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 12 }}>
          <label><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>
          {mode === "create" ? <label><input type="checkbox" checked={form.sendInvite} onChange={(e) => setForm({ ...form, sendInvite: e.target.checked })} /> Send welcome/password setup email</label> : null}
        </div>
        {error ? <div className="chip danger" style={{ marginTop: 12 }}>{error}</div> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={saving || !form.email || !form.firstName || !form.lastName || !form.extensionId} onClick={save}>{saving ? "Saving..." : mode === "create" ? <><Mail size={16} /> Create & Invite</> : "Save Changes"}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="stack" style={{ gap: 6, marginTop: 12 }}><span className="muted">{label}</span>{children}</label>;
}
