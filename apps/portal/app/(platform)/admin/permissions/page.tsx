"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PROTECTED_PLATFORM_ADMIN_PERMISSIONS,
  SIDEBAR_ITEMS,
  SIDEBAR_SECTIONS,
  type PortalPermissionKey,
} from "@connect/shared";
import { PageHeader } from "../../../../components/PageHeader";
import { DetailCard } from "../../../../components/DetailCard";
import { PermissionGate } from "../../../../components/PermissionGate";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost } from "../../../../services/apiClient";
import type { Permission, Role } from "../../../../types/app";
import { ROLE_PERMISSION_MAP } from "../../../../permissions/permissionMap";

type RolePermissionsResponse = {
  permissions: Partial<Record<Role, Permission[]>>;
  version?: number;
  keys?: Permission[];
};

const ROLES: { role: Role; label: string; description: string; color: string }[] = [
  { role: "END_USER", label: "End User", description: "Standard user-facing access", color: "var(--info)" },
  { role: "TENANT_ADMIN", label: "Tenant Admin", description: "Tenant management and configuration", color: "var(--warning)" },
  { role: "SUPER_ADMIN", label: "Platform Admin", description: "Platform-wide access", color: "var(--danger)" },
];

const PROTECTED = new Set<PortalPermissionKey>(PROTECTED_PLATFORM_ADMIN_PERMISSIONS);

const SECTION_GROUPS = SIDEBAR_SECTIONS.map((section) => ({
  section,
  items: SIDEBAR_ITEMS.filter((item) => item.section === section.id),
}));

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
        opacity: disabled ? 0.45 : 1,
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

function copyDefaults(): Record<Role, Set<Permission>> {
  return {
    END_USER: new Set(ROLE_PERMISSION_MAP.END_USER),
    TENANT_ADMIN: new Set(ROLE_PERMISSION_MAP.TENANT_ADMIN),
    SUPER_ADMIN: new Set(ROLE_PERMISSION_MAP.SUPER_ADMIN),
  };
}

export default function PermissionsPage() {
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [saveError, setSaveError] = useState("");
  const [overrides, setOverrides] = useState<Record<Role, Set<Permission>>>(copyDefaults);

  const serverState = useAsyncResource<RolePermissionsResponse>(
    () => apiGet("/admin/role-permissions"),
    [],
  );

  useEffect(() => {
    if (serverState.status !== "success") return;
    const srv = serverState.data.permissions;
    if (!srv) return;
    setOverrides((prev) => {
      const next = { ...prev };
      for (const role of ["END_USER", "TENANT_ADMIN", "SUPER_ADMIN"] as Role[]) {
        if (Array.isArray(srv[role])) next[role] = new Set(srv[role]);
      }
      return next;
    });
  }, [serverState.data, serverState.status]);

  const counts = useMemo(() => {
    return ROLES.reduce<Record<Role, number>>((acc, role) => {
      acc[role.role] = overrides[role.role].size;
      return acc;
    }, { END_USER: 0, TENANT_ADMIN: 0, SUPER_ADMIN: 0 });
  }, [overrides]);

  function toggle(role: Role, perm: Permission, value: boolean) {
    setOverrides((prev) => {
      const set = new Set(prev[role]);
      if (value) set.add(perm);
      else set.delete(perm);
      if (role === "SUPER_ADMIN") {
        for (const protectedKey of PROTECTED_PLATFORM_ADMIN_PERMISSIONS) set.add(protectedKey);
      }
      return { ...prev, [role]: set };
    });
    setDirty(true);
    setSaveMsg("");
    setSaveError("");
  }

  async function handleSave() {
    setSaving(true);
    setSaveError("");
    try {
      const payload: Record<string, string[]> = {};
      for (const role of ["END_USER", "TENANT_ADMIN", "SUPER_ADMIN"] as Role[]) {
        const list = new Set(overrides[role]);
        if (role === "SUPER_ADMIN") {
          for (const protectedKey of PROTECTED_PLATFORM_ADMIN_PERMISSIONS) list.add(protectedKey);
        }
        payload[role] = Array.from(list);
      }
      await apiPost("/admin/role-permissions", { permissions: payload });
      setSaveMsg("Permission changes saved. They apply after refresh or next login.");
      setDirty(false);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("cc-portal-permissions-saved"));
      }
    } catch (err: any) {
      setSaveError(err?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setOverrides(copyDefaults());
    setDirty(true);
    setSaveMsg("");
    setSaveError("");
  }

  return (
    <PermissionGate
      permission="can_view_admin_permissions"
      fallback={
        <div className="state-box" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Access denied</div>
          <p className="muted">You do not have permission to manage platform role access.</p>
        </div>
      }
    >
      <div className="stack compact-stack">
        <PageHeader
          title="Permissions Management"
          subtitle="Control sidebar sections, sidebar pages, and role access across the platform."
          actions={
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {dirty ? <span className="chip warning" style={{ fontSize: 12 }}>Unsaved changes</span> : null}
              <button className="btn ghost" onClick={handleReset} disabled={saving}>Reset to Defaults</button>
              <button className="btn" onClick={handleSave} disabled={saving || !dirty} style={!dirty ? { opacity: 0.5 } : undefined}>
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          }
        />

        <div className="panel" style={{ padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Sidebar permissions</div>
          <div className="muted" style={{ fontSize: 13 }}>
            Section toggles control the whole sidebar group. Item toggles control individual pages.
          </div>
        </div>

        {saveMsg ? <div className="chip success" style={{ alignSelf: "flex-start" }}>{saveMsg}</div> : null}
        {saveError ? <div className="chip danger" style={{ alignSelf: "flex-start" }}>{saveError}</div> : null}

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {ROLES.map((r) => (
            <div
              key={r.role}
              className="panel"
              style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, flex: "1 1 220px" }}
            >
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: r.color, flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 650, fontSize: 13 }}>{r.label}</div>
                <div className="muted" style={{ fontSize: 11 }}>{r.description}</div>
              </div>
              <div className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
                {counts[r.role]} permissions
              </div>
            </div>
          ))}
        </div>

        {SECTION_GROUPS.map(({ section, items }) => (
          <div key={section.id} className="panel" style={{ overflow: "hidden" }}>
            <div
              style={{
                padding: "12px 16px",
                background: "var(--panel-2)",
                borderBottom: "1px solid var(--border)",
                display: "grid",
                gridTemplateColumns: "minmax(260px, 1fr) repeat(3, 150px)",
                gap: 12,
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 800 }}>{section.label}</div>
                <div className="muted" style={{ fontSize: 12 }}>Master section access</div>
              </div>
              {ROLES.map((role) => {
                const locked = role.role === "SUPER_ADMIN" && PROTECTED.has(section.permission);
                const checked = locked || overrides[role.role].has(section.permission);
                return (
                  <div key={role.role} style={{ display: "flex", justifyContent: "center" }}>
                    <PermissionToggle
                      checked={checked}
                      disabled={locked}
                      title={locked ? "Platform Admin must retain permissions access." : `${role.label}: ${section.label}`}
                      onChange={(value) => toggle(role.role, section.permission, value)}
                    />
                  </div>
                );
              })}
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", fontSize: 11, color: "var(--text-dim)" }}>
                  <th style={{ textAlign: "left", padding: "8px 16px", fontWeight: 600 }}>Sidebar item</th>
                  {ROLES.map((r) => (
                    <th key={r.role} style={{ textAlign: "center", padding: "8px 14px", fontWeight: 700, color: r.color }}>
                      {r.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => (
                  <tr
                    key={item.id}
                    style={{
                      borderBottom: idx < items.length - 1 ? "1px solid var(--border)" : undefined,
                      background: idx % 2 === 0 ? undefined : "rgba(255,255,255,0.01)",
                    }}
                  >
                    <td style={{ padding: "10px 16px" }}>
                      <div style={{ fontSize: 13, fontWeight: 650 }}>{item.label}</div>
                      <div className="muted" style={{ fontSize: 11 }}>{item.href}</div>
                    </td>
                    {ROLES.map((role) => {
                      const sectionOn = overrides[role.role].has(section.permission);
                      const locked = role.role === "SUPER_ADMIN" && PROTECTED.has(item.permission);
                      const checked = locked || overrides[role.role].has(item.permission);
                      const disabled = locked || !sectionOn;
                      return (
                        <td key={role.role} style={{ textAlign: "center", padding: "10px 14px", opacity: sectionOn ? 1 : 0.55 }}>
                          <div style={{ display: "flex", justifyContent: "center" }}>
                            <PermissionToggle
                              checked={checked}
                              disabled={disabled}
                              title={!sectionOn ? `${section.label} is off for ${role.label}` : locked ? "Platform Admin must retain permissions access." : `${role.label}: ${item.label}`}
                              onChange={(value) => toggle(role.role, item.permission, value)}
                            />
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        <DetailCard title="How Permissions Work">
          <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.7 }}>
            <p>
              Sidebar section toggles hide or show entire navigation groups. Item toggles hide or show individual pages inside
              enabled sections. Backend APIs for those modules also check the saved role permissions before returning data.
            </p>
            <p style={{ marginTop: 8 }}>
              Platform Admin access to this Permissions page is protected so the platform cannot be locked out accidentally.
            </p>
          </div>
        </DetailCard>
      </div>
    </PermissionGate>
  );
}
