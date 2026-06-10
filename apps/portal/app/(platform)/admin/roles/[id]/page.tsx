"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { AlertTriangle, ArrowLeft, Shield } from "lucide-react";
import Link from "next/link";
import {
  SIDEBAR_SECTIONS,
  SIDEBAR_ITEMS,
  ACTION_PERMISSION_KEYS,
  type PortalPermissionKey,
} from "@connect/shared";
import { PageHeader } from "../../../../../components/PageHeader";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
import { apiGet, apiPost, apiPut } from "../../../../../services/apiClient";

type CatalogResponse = {
  keys: PortalPermissionKey[];
  grantableKeys: PortalPermissionKey[];
};

type RoleResponse = {
  role: {
    id: string;
    tenantId: string;
    name: string;
    description: string | null;
    active: boolean;
    permissions: string[];
    userCount: number;
  };
};

const SECTION_GROUPS = SIDEBAR_SECTIONS.map((section) => ({
  section,
  items: SIDEBAR_ITEMS.filter((item) => item.section === section.id),
}));

const DANGEROUS_PERMISSIONS: Set<string> = new Set([
  "can_manage_global_settings",
  "can_switch_tenants",
  "can_manage_deploys",
  "can_view_admin_permissions",
  "can_sync_voip_ms_numbers",
]);

// Tenant-wide communications permission keys and labels
const TENANT_COMM_PERMS: Array<{ key: PortalPermissionKey | string; label: string }> = [
  { key: "can_view_tenant_call_history",    label: "View all tenant call history" },
  { key: "can_view_tenant_voicemails",      label: "View all tenant voicemails" },
  { key: "can_view_tenant_chats",           label: "View all tenant chats" },
  { key: "can_view_tenant_call_recordings", label: "View all tenant call recordings" },
];

function PermissionToggle({
  checked,
  disabled,
  onChange,
  title,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      title={title}
      aria-pressed={checked}
      disabled={disabled}
      style={{
        width: 38,
        height: 22,
        borderRadius: 999,
        border: "1px solid var(--border)",
        background: checked ? "var(--success)" : "var(--border)",
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.2s, opacity 0.2s",
        flexShrink: 0,
        opacity: disabled ? 0.4 : 1,
        padding: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: checked ? 20 : 3,
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 0.15s",
          boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
        }}
      />
    </button>
  );
}

export default function RoleEditPage() {
  const router = useRouter();
  const params = useParams();
  const id = params?.id as string;
  const isNew = id === "new";

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(true);
  const [selectedPerms, setSelectedPerms] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const catalog = useAsyncResource<CatalogResponse>(
    () => apiGet("/admin/custom-roles/permissions-catalog"),
    [],
  );

  const existingRole = useAsyncResource<RoleResponse>(
    () => (isNew ? Promise.resolve(null as any) : apiGet(`/admin/custom-roles/${id}`)),
    [id],
  );

  useEffect(() => {
    if (loaded) return;
    if (!isNew && existingRole.status === "success" && existingRole.data?.role) {
      const r = existingRole.data.role;
      setName(r.name);
      setDescription(r.description ?? "");
      setActive(r.active);
      setSelectedPerms(new Set(r.permissions));
      setLoaded(true);
    }
    if (isNew) setLoaded(true);
  }, [isNew, existingRole.status, existingRole.data, loaded]);

  const grantable = useMemo(() => {
    if (catalog.status !== "success") return new Set<string>();
    return new Set(catalog.data.grantableKeys);
  }, [catalog.status, catalog.data]);

  function togglePerm(key: string, value: boolean) {
    setSelectedPerms((prev) => {
      const next = new Set(prev);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function handleSave() {
    if (!name.trim()) {
      setSaveError("Role name is required.");
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        active,
        permissions: [...selectedPerms],
      };
      if (isNew) {
        await apiPost("/admin/custom-roles", payload);
      } else {
        await apiPut(`/admin/custom-roles/${id}`, payload);
      }
      router.push("/admin/roles");
    } catch (err: any) {
      setSaveError(err?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const loading = catalog.status === "loading" || (!isNew && existingRole.status === "loading");
  const hasDangerous = [...selectedPerms].some((p) => DANGEROUS_PERMISSIONS.has(p));

  return (
    <PermissionGate
      permission="can_view_admin_roles"
      fallback={
        <div className="state-box" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Access denied</div>
        </div>
      }
    >
      <div className="stack compact-stack">
        <PageHeader
          title={isNew ? "New Custom Role" : `Edit Role: ${name || "…"}`}
          subtitle={isNew ? "Define a name, description, and permission set." : "Modify the role's permissions and status."}
          actions={
            <div style={{ display: "flex", gap: 8 }}>
              <Link href="/admin/roles" className="btn ghost">
                <ArrowLeft size={14} style={{ marginRight: 4 }} />
                Back
              </Link>
              <button className="btn" onClick={handleSave} disabled={saving || loading}>
                {saving ? "Saving…" : "Save Role"}
              </button>
            </div>
          }
        />

        {saveError && (
          <div className="chip danger" style={{ alignSelf: "flex-start" }}>{saveError}</div>
        )}

        {hasDangerous && (
          <div className="panel" style={{ padding: "10px 14px", border: "1px solid var(--warning)", display: "flex", gap: 8, alignItems: "flex-start" }}>
            <AlertTriangle size={16} style={{ color: "var(--warning)", flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 12, color: "var(--warning)" }}>
              This role includes <strong>elevated permissions</strong> (global settings, deploy access, tenant switching). Grant with care.
            </div>
          </div>
        )}

        {/* Role metadata */}
        <div className="panel" style={{ padding: "16px 20px" }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Role Details</div>
          <div className="stack" style={{ gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }}>Name *</label>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Billing Viewer, Support Agent"
                maxLength={80}
                style={{ maxWidth: 380 }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }}>Description</label>
              <input
                className="input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional: what this role is for"
                maxLength={500}
                style={{ maxWidth: 520 }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <PermissionToggle
                checked={active}
                onChange={setActive}
                title="Active roles are applied during permission resolution. Inactive roles are ignored."
              />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600 }}>Active</div>
                <div className="muted" style={{ fontSize: 11 }}>Inactive roles are ignored during permission checks</div>
              </div>
            </div>
          </div>
        </div>

        {/* Permission matrix */}
        {loading && (
          <div className="state-box muted" style={{ padding: 24, textAlign: "center" }}>Loading permissions…</div>
        )}

        {!loading && (
          <>
            <div className="panel" style={{ padding: "12px 16px" }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Permission Matrix</div>
              <div className="muted" style={{ fontSize: 12 }}>
                Greyed-out permissions are outside what you can grant. Selected: {selectedPerms.size}
              </div>
            </div>

            {/* Sidebar sections + items */}
            {SECTION_GROUPS.map(({ section, items }) => {
              const sectionGrantable = grantable.has(section.permission);
              const sectionOn = selectedPerms.has(section.permission);
              return (
                <div key={section.id} className="panel" style={{ overflow: "hidden" }}>
                  <div
                    style={{
                      padding: "12px 16px",
                      background: "var(--panel-2)",
                      borderBottom: items.length > 0 ? "1px solid var(--border)" : undefined,
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <PermissionToggle
                      checked={sectionOn}
                      disabled={!sectionGrantable}
                      title={!sectionGrantable ? "You cannot grant this permission" : `${section.label} section access`}
                      onChange={(v) => togglePerm(section.permission, v)}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{section.label}</div>
                      <div className="muted" style={{ fontSize: 11 }}>{section.permission}</div>
                    </div>
                    {DANGEROUS_PERMISSIONS.has(section.permission) && (
                      <span className="chip warning" style={{ fontSize: 10 }}>Elevated</span>
                    )}
                  </div>
                  {items.length > 0 && (
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <tbody>
                        {items.map((item, idx) => {
                          const itemGrantable = grantable.has(item.permission);
                          const checked = selectedPerms.has(item.permission);
                          const disabled = !itemGrantable || !sectionOn;
                          const isDangerous = DANGEROUS_PERMISSIONS.has(item.permission);
                          return (
                            <tr
                              key={item.id}
                              style={{
                                borderBottom: idx < items.length - 1 ? "1px solid var(--border)" : undefined,
                                background: idx % 2 === 0 ? undefined : "rgba(255,255,255,0.01)",
                                opacity: sectionOn ? 1 : 0.55,
                              }}
                            >
                              <td style={{ padding: "9px 16px" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <PermissionToggle
                                    checked={checked}
                                    disabled={disabled}
                                    title={
                                      !itemGrantable
                                        ? "You cannot grant this permission"
                                        : !sectionOn
                                        ? `Enable the ${section.label} section first`
                                        : item.label
                                    }
                                    onChange={(v) => togglePerm(item.permission, v)}
                                  />
                                  <div>
                                    <div style={{ fontSize: 12, fontWeight: 600 }}>
                                      {item.label}
                                      {isDangerous && (
                                        <span className="chip warning" style={{ fontSize: 10, marginLeft: 6 }}>Elevated</span>
                                      )}
                                    </div>
                                    <div className="muted" style={{ fontSize: 10 }}>{item.permission}</div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}

            {/* Action permissions */}
            <div className="panel" style={{ overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", background: "var(--panel-2)", borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Action Permissions</div>
                <div className="muted" style={{ fontSize: 11 }}>Fine-grained functional capabilities</div>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <tbody>
                  {ACTION_PERMISSION_KEYS.filter((k) => !TENANT_COMM_PERMS.some((t) => t.key === k)).map((key, idx) => {
                    const isGrantable = grantable.has(key);
                    const checked = selectedPerms.has(key);
                    const isDangerous = DANGEROUS_PERMISSIONS.has(key);
                    return (
                      <tr
                        key={key}
                        style={{
                          borderBottom: idx < ACTION_PERMISSION_KEYS.length - 1 ? "1px solid var(--border)" : undefined,
                          background: idx % 2 === 0 ? undefined : "rgba(255,255,255,0.01)",
                        }}
                      >
                        <td style={{ padding: "9px 16px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <PermissionToggle
                              checked={checked}
                              disabled={!isGrantable}
                              title={!isGrantable ? "You cannot grant this permission" : key}
                              onChange={(v) => togglePerm(key, v)}
                            />
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 600 }}>
                                {key}
                                {isDangerous && (
                                  <span className="chip warning" style={{ fontSize: 10, marginLeft: 6 }}>Elevated</span>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Tenant Communications Access */}
            <div className="panel" style={{ overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", background: "var(--panel-2)", borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Tenant Communications Access</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  Allows this role to view communications for all users in the same tenant only.
                </div>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <tbody>
                  {TENANT_COMM_PERMS.map((p, idx) => {
                    const key = p.key as string;
                    const isGrantable = grantable.has(key);
                    const checked = selectedPerms.has(key);
                    return (
                      <tr
                        key={key}
                        style={{
                          borderBottom: idx < TENANT_COMM_PERMS.length - 1 ? "1px solid var(--border)" : undefined,
                          background: idx % 2 === 0 ? undefined : "rgba(255,255,255,0.01)",
                        }}
                      >
                        <td style={{ padding: "9px 16px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <PermissionToggle
                              checked={checked}
                              disabled={!isGrantable}
                              title={!isGrantable ? "You cannot grant this permission" : p.label}
                              onChange={(v) => togglePerm(key, v)}
                            />
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 600 }}>{p.label}</div>
                              <div className="muted" style={{ fontSize: 10 }}>{key}</div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </PermissionGate>
  );
}
