"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Mail, Plus, Search, Shield, UserCog, XCircle } from "lucide-react";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";
import { useTenantOptions } from "../../../../hooks/useTenantOptions";
import { useExtensionOptions, type ExtensionOption } from "../../../../hooks/useExtensionOptions";

type TenantOption = { id: string; name: string; status: string; kind?: string };
type RoleOption = { id: string; label: string };
type CatalogResponse = {
  tenantId: string | null;
  roles: RoleOption[];
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
type OutboundRouteAssignment = {
  id: string;
  tenantId: string;
  name: string;
  prefix: string;
  callerIdName: string | null;
  callerIdNumber: string | null;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  enabled: boolean;
  isDefault: boolean;
};
type OutboundRoutesResponse = {
  tenantId: string;
  userId?: string;
  routes: OutboundRouteAssignment[];
};

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

  const isSuper = role === "SUPER_ADMIN";

  // Super admins default to "ALL" so they see every customer tenant at once.
  const [selectedTenantId, setSelectedTenantId] = useState<string>(() => isSuper ? "ALL" : contextTenantId);

  // Canonical tenant options for the filter dropdown — includes PBX-only tenants
  // so a newly synced PBX tenant appears immediately without a page refresh.
  // connectOnly is NOT set here because filtering by a tenant is read-only;
  // the user creation modal uses connectOnly:true separately.
  const { options: tenantOptions } = useTenantOptions();

  const [data, setData] = useState<UsersResponse | null>(null);
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [routeUser, setRouteUser] = useState<AdminUser | null>(null);
  const [crmUser, setCrmUser] = useState<AdminUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [message, setMessage] = useState("");
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [syncResults, setSyncResults] = useState<Record<string, string>>({});

  const effectiveTenantId = isSuper ? selectedTenantId : contextTenantId;

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    // "ALL" means no tenantId param → API returns all customer tenants for super admins
    if (effectiveTenantId && effectiveTenantId !== "ALL") params.set("tenantId", effectiveTenantId);
    if (query.trim()) params.set("search", query.trim());
    if (roleFilter !== "all") params.set("role", roleFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    const result = await apiGet<UsersResponse>(`/admin/users?${params.toString()}`);
    setData(result);
  }, [effectiveTenantId, query, roleFilter, statusFilter]);

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

  async function syncUser(userId: string) {
    setSyncingIds((prev) => new Set(prev).add(userId));
    setSyncResults((prev) => ({ ...prev, [userId]: "" }));
    setMessage("");
    try {
      await apiPost(`/admin/users/${userId}/phone/sync`, {}, undefined, { timeoutMs: 90000 });
      setSyncResults((prev) => ({ ...prev, [userId]: "✓ synced" }));
      await load();
    } catch (e: any) {
      const rawMsg = String(e?.message || "sync failed");
      const msg = rawMsg.startsWith("Request timed out")
        ? `${rawMsg}. VitalPBX did not respond in time. The sync may still finish on the server; refresh the users list and try again if the row still is not provisioned.`
        : rawMsg;
      // Short inline chip on the row, full actionable message in the top banner.
      const shortChip = msg.startsWith("NO_WEBRTC_DEVICE_ON_PBX")
        ? "no WebRTC device on PBX"
        : msg.startsWith("SIP_CREDENTIAL_NOT_SET")
        ? "no SIP secret"
        : msg.startsWith("pbx_sync_failed")
        ? "PBX unreachable"
        : msg.startsWith("Request timed out")
        ? "sync timed out"
        : msg.length > 40 ? `${msg.slice(0, 40)}…` : msg;
      setSyncResults((prev) => ({ ...prev, [userId]: shortChip }));
      setMessage(msg);
    } finally {
      setSyncingIds((prev) => { const s = new Set(prev); s.delete(userId); return s; });
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
              <ConnectSelect size="sm" value={selectedTenantId} onChange={setSelectedTenantId}
                style={{ width: 230 }}
                searchable
                options={[
                  { value: "ALL", label: "All tenants" },
                  ...tenantOptions.map((t) => ({ value: t.id, label: t.name })),
                ]}
              />
            ) : null}
            <ConnectSelect size="sm" value={roleFilter} onChange={setRoleFilter}
              style={{ width: 170 }}
              options={[
                { value: "all", label: "All roles" },
                ...DEFAULT_PORTAL_ROLES.map((r) => ({ value: r.id, label: r.label })),
              ]}
            />
            <ConnectSelect size="sm" value={statusFilter} onChange={setStatusFilter}
              style={{ width: 150 }}
              options={[
                { value: "all", label: "All status" },
                { value: "INVITED", label: "Invited" },
                { value: "ACTIVE", label: "Active" },
                { value: "DISABLED", label: "Disabled" },
              ]}
            />
            <button className="btn" onClick={() => setCreating(true)}><Plus size={16} /> Create User</button>
          </div>
          {message ? (
            <div
              className="state-box"
              style={{
                marginTop: 12,
                borderColor: "var(--warning, #f59e0b)",
                color: "var(--text)",
                whiteSpace: "pre-wrap",
                lineHeight: 1.5,
              }}
            >
              {message}
            </div>
          ) : null}
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
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <button className="btn ghost" onClick={() => setEditing(u)}>Edit</button>
                        {u.status === "DISABLED"
                          ? <button className="btn ghost" onClick={() => action(`/admin/users/${u.id}/enable`, "User enabled")}>Enable</button>
                          : <button className="btn ghost" onClick={() => action(`/admin/users/${u.id}/disable`, "User disabled")}>Disable</button>}
                        <button className="btn ghost" onClick={() => action(`/admin/users/${u.id}/resend-invite`, "Invite queued")}>Resend</button>
                        {u.extension ? (
                          <>
                            <button
                              className="btn ghost"
                              onClick={() => setRouteUser(u)}
                              title="Set outbound route prefixes for this user"
                            >
                              Routes
                            </button>
                            <button
                              className="btn ghost"
                              onClick={() => setCrmUser(u)}
                              title="Assign CRM access and campaigns"
                            >
                              CRM
                            </button>
                            <button
                              className="btn ghost"
                              disabled={syncingIds.has(u.id)}
                              onClick={() => syncUser(u.id)}
                              title="Sync SIP/WebRTC credentials from VitalPBX"
                            >
                              {syncingIds.has(u.id) ? "Syncing…" : "Sync SIP"}
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn ghost"
                            onClick={() => setCrmUser(u)}
                            title="Assign CRM access and campaigns"
                          >
                            CRM
                          </button>
                        )}
                        {syncResults[u.id] ? (
                          <span className={`chip ${syncResults[u.id].startsWith("✓") ? "success" : "danger"}`} style={{ fontSize: 11 }}>
                            {syncResults[u.id]}
                          </span>
                        ) : null}
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
        {routeUser ? <OutboundRoutesModal user={routeUser} onClose={() => setRouteUser(null)} /> : null}
        {crmUser ? <CrmAccessModal user={crmUser} onClose={() => setCrmUser(null)} /> : null}
        {creating ? <UserModal mode="create" defaultTenantId={effectiveTenantId === "ALL" ? "" : effectiveTenantId} onClose={() => setCreating(false)} onSaved={(createdTenantId?: string) => { setCreating(false); load(); }} /> : null}
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
        {user.extension ? (
          <>
            <PhoneProvisioningPanel userId={user.id} />
            <OutboundRoutePrefixesPanel user={user} />
          </>
        ) : null}
      </aside>
    </div>
  );
}

type CrmAccessCampaign = { id: string; name: string; status: string; assigned: boolean };
type CrmAccessResponse = {
  tenantId: string;
  tenantName: string | null;
  userId: string;
  email: string;
  displayName: string;
  crmTenantEnabled: boolean;
  crmEnabled: boolean;
  crmRole: "AGENT" | "MANAGER" | "ADMIN" | null;
  assignedCampaignIds: string[];
  campaigns: CrmAccessCampaign[];
};

const CRM_ROLE_LABELS: Record<string, string> = {
  AGENT: "Agent",
  MANAGER: "Manager",
  ADMIN: "CRM Admin",
};

function CrmAccessModal({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<CrmAccessResponse | null>(null);
  const [crmEnabled, setCrmEnabled] = useState(false);
  const [crmRole, setCrmRole] = useState<"AGENT" | "MANAGER" | "ADMIN">("AGENT");
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [enablingTenant, setEnablingTenant] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setToast(null);
    try {
      const res = await apiGet<CrmAccessResponse>(`/admin/users/${user.id}/crm-access`);
      setData(res);
      setCrmEnabled(res.crmEnabled);
      setCrmRole((res.crmRole as "AGENT" | "MANAGER" | "ADMIN") || "AGENT");
      setSelectedCampaignIds(new Set(res.assignedCampaignIds || []));
    } catch (e: any) {
      setToast({ kind: "err", text: e?.message || "Failed to load CRM access" });
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [user.id]);

  useEffect(() => { load(); }, [load]);

  function toggleCampaign(campaignId: string, checked: boolean) {
    setSelectedCampaignIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(campaignId);
      else next.delete(campaignId);
      return next;
    });
  }

  async function enableTenantCrm() {
    setEnablingTenant(true);
    setToast(null);
    try {
      await apiPost(`/admin/users/${user.id}/crm-access/enable-tenant`, {});
      setToast({ kind: "ok", text: "CRM enabled for this tenant" });
      await load();
    } catch (e: any) {
      setToast({ kind: "err", text: e?.message || "Failed to enable CRM for tenant" });
    } finally {
      setEnablingTenant(false);
    }
  }

  async function save() {
    if (!data) return;
    setSaving(true);
    setToast(null);
    try {
      await apiPut(`/admin/users/${user.id}/crm-access`, {
        enabled: crmEnabled,
        role: crmRole,
        campaignIds: crmEnabled ? [...selectedCampaignIds] : [],
      });
      setToast({ kind: "ok", text: crmEnabled ? "CRM access saved" : "CRM access removed" });
      await load();
    } catch (e: any) {
      setToast({ kind: "err", text: e?.message || "Failed to save CRM access" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <aside
        className="modal"
        style={{ marginLeft: "auto", width: "min(560px, 96vw)", height: "100vh", borderRadius: "22px 0 0 22px", overflow: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="btn ghost" style={{ float: "right" }} onClick={onClose}>Close</button>
        <div style={{ width: 56, height: 56, borderRadius: 20, background: "linear-gradient(135deg,#7c3aed,#2563eb)", color: "#fff", display: "grid", placeItems: "center", fontWeight: 900, fontSize: 22 }}>
          {user.displayName.slice(0, 1).toUpperCase()}
        </div>
        <h2>CRM Access</h2>
        <p className="muted" style={{ marginTop: -4 }}>
          {user.displayName} · {user.email}
        </p>
        {data ? <p className="muted" style={{ marginTop: 4 }}>Tenant: {data.tenantName || user.tenantName || user.tenantId}</p> : null}

        {loading ? (
          <div className="state-box" style={{ marginTop: 16 }}>Loading CRM access…</div>
        ) : data ? (
          <div className="stack" style={{ gap: 14, marginTop: 18 }}>
            {!data.crmTenantEnabled ? (
              <div className="state-box stack" style={{ gap: 12 }}>
                <p style={{ margin: 0 }}>
                  CRM is not enabled for <strong>{data.tenantName || "this tenant"}</strong>.
                  Enable it here, then grant access to this user.
                </p>
                <button
                  type="button"
                  className="btn"
                  disabled={enablingTenant || saving}
                  onClick={enableTenantCrm}
                >
                  {enablingTenant ? "Enabling…" : "Enable CRM for this tenant"}
                </button>
              </div>
            ) : null}

            <section className="panel" style={{ padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div>
                  <strong>CRM access</strong>
                  <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                    {crmEnabled ? "User can access CRM for this tenant" : "User cannot access CRM"}
                  </div>
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={crmEnabled}
                    disabled={saving || enablingTenant || !data.crmTenantEnabled}
                    onChange={(e) => setCrmEnabled(e.target.checked)}
                  />
                  <span>{crmEnabled ? "Enabled" : "Disabled"}</span>
                </label>
              </div>
              {crmEnabled ? (
                <div style={{ marginTop: 12 }}>
                  <span className="muted" style={{ fontSize: 12 }}>CRM role</span>
                  <select
                    className="input"
                    style={{ marginTop: 6, width: "100%" }}
                    value={crmRole}
                    disabled={saving}
                    onChange={(e) => setCrmRole(e.target.value as "AGENT" | "MANAGER" | "ADMIN")}
                  >
                    {Object.entries(CRM_ROLE_LABELS).map(([val, label]) => (
                      <option key={val} value={val}>{label}</option>
                    ))}
                  </select>
                </div>
              ) : null}
            </section>

            {crmEnabled && data.campaigns.length > 0 ? (
              <section className="panel" style={{ padding: 14 }}>
                <strong>Campaign assignments</strong>
                <p className="muted" style={{ fontSize: 13, margin: "4px 0 12px" }}>
                  Optional. Leave all unchecked to allow every tenant campaign. Select campaigns to restrict this user.
                </p>
                <div className="stack" style={{ gap: 8 }}>
                  {data.campaigns.map((c) => (
                    <label
                      key={c.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 12px",
                        border: "1px solid var(--border)",
                        borderRadius: 12,
                        cursor: saving ? "not-allowed" : "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedCampaignIds.has(c.id)}
                        disabled={saving}
                        onChange={(e) => toggleCampaign(c.id, e.target.checked)}
                      />
                      <span style={{ flex: 1 }}>
                        <strong>{c.name}</strong>
                        <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{c.status.toLowerCase()}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            ) : crmEnabled ? (
              <p className="muted">No campaigns in this tenant yet.</p>
            ) : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button className="btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
              <button className="btn" onClick={save} disabled={saving || enablingTenant || !data.crmTenantEnabled}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : null}

        {toast ? (
          <div className={`chip ${toast.kind === "err" ? "danger" : "success"}`} style={{ marginTop: 12 }}>
            {toast.text}
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function OutboundRoutesModal({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <aside
        className="modal"
        style={{ marginLeft: "auto", width: "min(560px, 96vw)", height: "100vh", borderRadius: "22px 0 0 22px", overflow: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="btn ghost" style={{ float: "right" }} onClick={onClose}>Close</button>
        <div style={{ width: 56, height: 56, borderRadius: 20, background: "linear-gradient(135deg,#0ea5e9,#22c55e)", color: "#fff", display: "grid", placeItems: "center", fontWeight: 900, fontSize: 22 }}>
          {user.displayName.slice(0, 1).toUpperCase()}
        </div>
        <h2>Outbound Routes</h2>
        <p className="muted" style={{ marginTop: -4 }}>
          {user.displayName} · {user.extension ? `Ext ${user.extension.extNumber}` : user.email}
        </p>
        <OutboundRoutePrefixesPanel user={user} />
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

const emptyOutboundRouteForm = {
  name: "",
  prefix: "",
  callerIdName: "",
  callerIdNumber: "",
  description: "",
};

function OutboundRoutePrefixesPanel({ user }: { user: AdminUser }) {
  const [routes, setRoutes] = useState<OutboundRouteAssignment[]>([]);
  const [tenantId, setTenantId] = useState(user.tenantId);
  const [draft, setDraft] = useState(emptyOutboundRouteForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState(emptyOutboundRouteForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await apiGet<OutboundRoutesResponse>(`/admin/users/${user.id}/outbound-routes`);
      setTenantId(result.tenantId || user.tenantId);
      setRoutes(result.routes || []);
    } catch (e: any) {
      setMessage(e?.message || "Failed to load outbound routes");
      setRoutes([]);
    }
  }, [user.id, user.tenantId]);

  useEffect(() => { load(); }, [load]);

  function validateRouteForm(form: typeof emptyOutboundRouteForm): string | null {
    if (!form.name.trim()) return "Company name is required.";
    const prefix = form.prefix.trim();
    if (prefix && !/^\d{1,8}$/.test(prefix)) return "Prefix must be 1-8 digits, or blank for no prefix.";
    const callerIdNumber = form.callerIdNumber.trim();
    if (callerIdNumber && !/^[+()\-\s.\d]{3,40}$/.test(callerIdNumber)) return "Caller ID number is not a valid phone format.";
    return null;
  }

  async function saveAssignments(nextRoutes: OutboundRouteAssignment[]) {
    const enabledRoutes = nextRoutes.filter((route) => route.enabled && route.isActive);
    const hasDefault = enabledRoutes.some((route) => route.isDefault);
    const normalized = nextRoutes.map((route) => ({
      ...route,
      isDefault: route.enabled && route.isActive && (route.isDefault || (!hasDefault && route.id === enabledRoutes[0]?.id)),
    }));
    setRoutes(normalized);
    await apiPut(`/admin/users/${user.id}/outbound-routes`, {
      routes: normalized
        .filter((route) => route.enabled && route.isActive)
        .map((route) => ({ outboundRouteId: route.id, enabled: true, isDefault: route.isDefault })),
    });
  }

  async function toggleRoute(routeId: string, enabled: boolean) {
    setBusy(`toggle:${routeId}`);
    setMessage("");
    try {
      const next = routes.map((route) => route.id === routeId ? { ...route, enabled, isDefault: enabled ? route.isDefault : false } : route);
      await saveAssignments(next);
      setMessage("Outbound route permissions updated");
    } catch (e: any) {
      setMessage(e?.message || "Failed to update route permissions");
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function setDefault(routeId: string) {
    setBusy(`default:${routeId}`);
    setMessage("");
    try {
      const next = routes.map((route) => ({ ...route, enabled: route.id === routeId ? true : route.enabled, isDefault: route.id === routeId }));
      await saveAssignments(next);
      setMessage("Default outbound route updated");
    } catch (e: any) {
      setMessage(e?.message || "Failed to update default route");
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function createRoute() {
    const validation = validateRouteForm(draft);
    if (validation) {
      setMessage(validation);
      return;
    }
    setBusy("create");
    setMessage("");
    try {
      const result = await apiPost<{ route: OutboundRouteAssignment }>("/outbound-routes", {
        tenantId,
        name: draft.name.trim(),
        prefix: draft.prefix.trim(),
        callerIdName: draft.callerIdName.trim() || null,
        callerIdNumber: draft.callerIdNumber.trim() || null,
        description: draft.description.trim() || null,
        isActive: true,
      });
      const route = { ...result.route, enabled: true, isDefault: !routes.some((r) => r.enabled && r.isDefault) };
      const next = [...routes, route];
      await saveAssignments(next);
      setDraft(emptyOutboundRouteForm);
      setMessage("Outbound route created and assigned to this user");
      await load();
    } catch (e: any) {
      setMessage(e?.message || "Failed to create outbound route");
    } finally {
      setBusy(null);
    }
  }

  function startEdit(route: OutboundRouteAssignment) {
    setEditingId(route.id);
    setEditDraft({
      name: route.name,
      prefix: route.prefix || "",
      callerIdName: route.callerIdName || "",
      callerIdNumber: route.callerIdNumber || "",
      description: route.description || "",
    });
  }

  async function saveEdit(route: OutboundRouteAssignment) {
    const validation = validateRouteForm(editDraft);
    if (validation) {
      setMessage(validation);
      return;
    }
    setBusy(`edit:${route.id}`);
    setMessage("");
    try {
      await apiPatch(`/outbound-routes/${route.id}`, {
        tenantId,
        name: editDraft.name.trim(),
        prefix: editDraft.prefix.trim(),
        callerIdName: editDraft.callerIdName.trim() || null,
        callerIdNumber: editDraft.callerIdNumber.trim() || null,
        description: editDraft.description.trim() || null,
      });
      setEditingId(null);
      setMessage("Outbound route updated");
      await load();
    } catch (e: any) {
      setMessage(e?.message || "Failed to update outbound route");
    } finally {
      setBusy(null);
    }
  }

  async function archiveRoute(route: OutboundRouteAssignment) {
    const confirmed = typeof window !== "undefined" && window.confirm(`Disable or delete outbound route "${route.name}"?`);
    if (!confirmed) return;
    setBusy(`delete:${route.id}`);
    setMessage("");
    try {
      await apiDelete(`/outbound-routes/${route.id}?tenantId=${encodeURIComponent(tenantId)}`);
      setMessage("Outbound route removed");
      await load();
    } catch (e: any) {
      setMessage(e?.message || "Failed to remove outbound route");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel" style={{ marginTop: 18, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ margin: 0 }}>Outbound Route Prefixes</h3>
          <p className="muted" style={{ margin: "4px 0 0" }}>Assign company prefixes this user can select in the dialer.</p>
        </div>
        <span className="chip info">{routes.filter((r) => r.enabled && r.isActive).length} allowed</span>
      </div>
      <div className="state-box" style={{ marginTop: 12 }}>
        Prefix must match an outbound route/pattern configured in VitalPBX.
      </div>

      <div className="stack" style={{ gap: 10, marginTop: 12 }}>
        {routes.length ? routes.map((route) => {
          const editing = editingId === route.id;
          return (
            <div key={route.id} style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 12, opacity: route.isActive ? 1 : .55 }}>
              {editing ? (
                <div className="stack" style={{ gap: 8 }}>
                  <input className="input" placeholder="Company name" value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} />
                  <input className="input" placeholder="Prefix, e.g. 999" value={editDraft.prefix} onChange={(e) => setEditDraft({ ...editDraft, prefix: e.target.value.replace(/\D/g, "").slice(0, 8) })} />
                  <input className="input" placeholder="Caller ID name (optional)" value={editDraft.callerIdName} onChange={(e) => setEditDraft({ ...editDraft, callerIdName: e.target.value })} />
                  <input className="input" placeholder="Caller ID number (optional)" value={editDraft.callerIdNumber} onChange={(e) => setEditDraft({ ...editDraft, callerIdNumber: e.target.value })} />
                  <textarea className="input" rows={2} placeholder="Description (optional)" value={editDraft.description} onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })} />
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button className="btn ghost" onClick={() => setEditingId(null)}>Cancel</button>
                    <button className="btn" disabled={busy === `edit:${route.id}`} onClick={() => saveEdit(route)}>{busy === `edit:${route.id}` ? "Saving..." : "Save"}</button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 10 }}>
                    <div>
                      <strong>{route.name}</strong>
                      <div className="muted" style={{ fontSize: 13 }}>
                        {route.prefix ? `Prefix ${route.prefix}` : "No prefix"}{route.callerIdNumber ? ` · ${route.callerIdNumber}` : ""}
                      </div>
                    </div>
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input type="checkbox" disabled={!route.isActive || busy !== null} checked={route.enabled && route.isActive} onChange={(e) => toggleRoute(route.id, e.target.checked)} />
                      <span className="muted">Allowed</span>
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                    <button className="btn ghost" disabled={!route.isActive || !route.enabled || busy !== null} onClick={() => setDefault(route.id)}>
                      {route.isDefault ? "Default" : "Make default"}
                    </button>
                    <button className="btn ghost" disabled={busy !== null} onClick={() => startEdit(route)}>Edit</button>
                    <button className="btn ghost" disabled={busy !== null} onClick={() => archiveRoute(route)}>Remove</button>
                  </div>
                </>
              )}
            </div>
          );
        }) : (
          <p className="muted">No outbound route prefixes have been created for this tenant yet.</p>
        )}
      </div>

      <div style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 14 }}>
        <h4 style={{ margin: "0 0 8px" }}>Create Company Prefix</h4>
        <div className="grid two">
          <input className="input" placeholder="Company name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className="input" placeholder="Prefix, e.g. 999" value={draft.prefix} onChange={(e) => setDraft({ ...draft, prefix: e.target.value.replace(/\D/g, "").slice(0, 8) })} />
          <input className="input" placeholder="Caller ID name (optional)" value={draft.callerIdName} onChange={(e) => setDraft({ ...draft, callerIdName: e.target.value })} />
          <input className="input" placeholder="Caller ID number (optional)" value={draft.callerIdNumber} onChange={(e) => setDraft({ ...draft, callerIdNumber: e.target.value })} />
        </div>
        <textarea className="input" rows={2} style={{ marginTop: 8 }} placeholder="Description (optional)" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        <button className="btn" style={{ marginTop: 10 }} disabled={busy !== null || !draft.name.trim()} onClick={createRoute}>
          <Plus size={16} /> {busy === "create" ? "Creating..." : "Create & assign"}
        </button>
      </div>
      {message ? <div className={`chip ${message.toLowerCase().includes("failed") || message.toLowerCase().includes("invalid") || message.toLowerCase().includes("required") ? "danger" : "info"}`} style={{ marginTop: 10 }}>{message}</div> : null}
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border)" }}><span className="muted">{label}</span><strong style={{ textAlign: "right" }}>{value}</strong></div>;
}

function UserModal({ mode, user, defaultTenantId, onClose, onSaved }: {
  mode: "create" | "edit"; user?: AdminUser; defaultTenantId: string; onClose: () => void; onSaved: (tenantId?: string) => void;
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
  // Tenant list — includes PBX-only tenants so a newly synced PBX tenant
  // appears here. If a PBX-only (vpbx:) tenant is selected, the API will
  // auto-provision a real Connect Tenant + TenantPbxLink on save.
  const { options: tenantOptions } = useTenantOptions();
  const tenants: TenantOption[] = tenantOptions.map((t) => ({ id: t.id, name: t.name, status: "ACTIVE" }));
  const [roles, setRoles] = useState<RoleOption[]>(DEFAULT_PORTAL_ROLES);
  const [userFacingOnly, setUserFacingOnly] = useState(true);
  // Canonical extension options — auto-refetches when cc-pbx-sync-complete fires.
  const { extensions: extensionOptions, totalExtensions: extTotal, filteredOut: extFilteredOut } = useExtensionOptions({
    tenantId: form.tenantId,
    userFacingOnly,
  });
  const extensionFilterStats = { total: extTotal, hidden: extFilteredOut };
  const selectedExtension = extensionOptions.find((e) => e.id === form.extensionId);
  const roleOptions = roles.length ? roles : DEFAULT_PORTAL_ROLES;

  // Bootstrap: fetch portal-bucket roles once when modal opens.
  // Tenant list is provided by useTenantOptions; extension list by useExtensionOptions.
  useEffect(() => {
    let active = true;
    apiGet<CatalogResponse>(`/admin/users/catalog?userFacingOnly=${userFacingOnly ? "true" : "false"}`)
      .then((r) => {
        if (!active) return;
        if (r.roles?.length) setRoles(r.roles);
        if (!form.tenantId && tenants.length > 0) {
          const initial = tenants.some((t) => t.id === defaultTenantId) ? defaultTenantId : (tenants[0]?.id || "");
          if (initial) setForm((f) => ({ ...f, tenantId: initial }));
        }
      })
      .catch((e: any) => { if (active) setError(e?.message || "Failed to load roles"); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Set default tenantId once tenant options have loaded (handles async hook).
  useEffect(() => {
    if (form.tenantId || tenants.length === 0) return;
    const initial = tenants.some((t) => t.id === defaultTenantId) ? defaultTenantId : (tenants[0]?.id || "");
    if (initial) setForm((f) => ({ ...f, tenantId: initial }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenants.length]);

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
      onSaved(mode === "create" ? form.tenantId : undefined);
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
            <ConnectSelect
              value={form.tenantId}
              disabled={mode === "edit"}
              onChange={(v) => setForm({ ...form, tenantId: v, extensionId: "" })}
              searchable
              style={{ width: "100%" }}
              options={[
                { value: "", label: "Select tenant" },
                ...tenants.map((t) => ({ value: t.id, label: `${t.name}${t.status === "SUSPENDED" ? " (suspended)" : ""}` })),
              ]}
            />
          </Field>
          <Field label="Extension">
            <ConnectSelect
              value={form.extensionId}
              onChange={pickExtension}
              searchable
              style={{ width: "100%" }}
              options={[
                { value: "", label: "Select extension" },
                ...extensionOptions.map((e) => {
                  const assigned = !!(e.ownerUserId && e.ownerUserId !== user?.id);
                  const pieces = [
                    `${e.extNumber} · ${e.displayName}`,
                    e.pbxDeviceName ? `(${e.pbxDeviceName})` : null,
                    assigned ? "— assigned" : null,
                    !e.webrtcEnabled ? "— webrtc off" : null,
                  ].filter(Boolean);
                  return { value: e.id, label: pieces.join(" "), disabled: assigned };
                }),
              ]}
            />
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                <input type="checkbox" checked={userFacingOnly} onChange={(e) => setUserFacingOnly(e.target.checked)} />
                <span className="muted">User-facing only{extensionFilterStats.total ? ` \u00b7 showing ${extensionOptions.length}/${extensionFilterStats.total}` : ""}</span>
              </label>
              {selectedExtension?.provisionStatus ? <span className="muted" style={{ fontSize: 12 }}>Provision: {selectedExtension.provisionStatus.toLowerCase()}</span> : null}
            </div>
          </Field>
          <Field label="Role">
            <ConnectSelect
              value={form.role}
              onChange={(v) => setForm({ ...form, role: v })}
              style={{ width: "100%" }}
              options={roleOptions.map((r) => ({ value: r.id, label: r.label }))}
            />
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
