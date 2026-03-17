"use client";

import { useMemo, useState } from "react";
import { PageHeader } from "../../../../components/PageHeader";
import { DetailCard } from "../../../../components/DetailCard";
import { RoleGate } from "../../../../components/RoleGate";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost } from "../../../../services/apiClient";
import type { Permission, Role } from "../../../../types/app";
import { ROLE_PERMISSION_MAP } from "../../../../permissions/permissionMap";

// ── Permission Categories ─────────────────────────────────────────────────────

interface PermissionMeta {
  key: Permission;
  label: string;
  description: string;
}

const PERMISSION_GROUPS: { group: string; perms: PermissionMeta[] }[] = [
  {
    group: "Dashboard & Navigation",
    perms: [
      { key: "can_view_dashboard",   label: "View Dashboard",         description: "Access main dashboard and KPI overview" },
      { key: "can_view_apps",        label: "View Apps",              description: "Access the Apps section (SMS, WhatsApp, Customers)" },
    ],
  },
  {
    group: "Calls & Live Telephony",
    perms: [
      { key: "can_view_calls",       label: "View Calls",             description: "View call history and active call state" },
      { key: "can_view_live_calls",  label: "View Live Calls",        description: "Monitor real-time active call board" },
    ],
  },
  {
    group: "Team & Extensions",
    perms: [
      { key: "can_view_team",        label: "View Team Directory",    description: "See all extension and team member presence" },
      { key: "can_edit_team",        label: "Manage Team",            description: "Add, edit, and remove team members and extensions" },
    ],
  },
  {
    group: "Messaging",
    perms: [
      { key: "can_view_sms",         label: "View SMS Inbox",         description: "Read SMS threads and message history" },
      { key: "can_send_sms",         label: "Send SMS",               description: "Compose and send outbound SMS messages" },
    ],
  },
  {
    group: "Voicemail",
    perms: [
      { key: "can_view_voicemail",   label: "View Voicemail",         description: "Listen to and read voicemail transcriptions" },
      { key: "can_delete_voicemail", label: "Delete Voicemail",       description: "Permanently delete voicemail messages" },
    ],
  },
  {
    group: "Contacts",
    perms: [
      { key: "can_view_contacts",    label: "View Contacts",          description: "Access contact directory and records" },
      { key: "can_manage_contacts",  label: "Manage Contacts",        description: "Create, update, and delete contact records" },
    ],
  },
  {
    group: "Recordings & Reports",
    perms: [
      { key: "can_view_recordings",      label: "View Recordings",        description: "Access call recording list" },
      { key: "can_download_recordings",  label: "Download Recordings",    description: "Download call recording files" },
      { key: "can_view_reports",         label: "View Reports",           description: "Access CDR, performance, and queue reports" },
    ],
  },
  {
    group: "Settings & Configuration",
    perms: [
      { key: "can_view_settings",            label: "View Settings",              description: "Access tenant settings pages" },
      { key: "can_manage_call_forwarding",   label: "Manage Call Forwarding",     description: "Configure call forwarding and voicemail routing" },
      { key: "can_manage_blfs",              label: "Manage BLFs",                description: "Configure Busy Lamp Field monitors" },
      { key: "can_manage_integrations",      label: "Manage Integrations",        description: "Connect third-party integrations (CRM, webhooks)" },
      { key: "can_manage_tenant_settings",   label: "Manage Tenant Settings",     description: "Full tenant configuration access" },
    ],
  },
  {
    group: "Admin & Platform",
    perms: [
      { key: "can_view_admin",               label: "View Admin Panel",           description: "Access admin console, PBX instances, and events" },
      { key: "can_switch_tenants",           label: "Switch Tenants",             description: "Switch context between tenants (SUPER_ADMIN only)" },
      { key: "can_manage_global_settings",   label: "Manage Global Settings",     description: "Modify platform-wide settings (SUPER_ADMIN only)" },
    ],
  },
  {
    group: "Mobile App",
    perms: [
      { key: "can_download_apk",  label: "Download Mobile App",  description: "Access mobile app download and QR linking" },
    ],
  },
  {
    group: "Chat",
    perms: [
      { key: "can_view_chat",   label: "View Chat",  description: "Access internal team chat" },
    ],
  },
];

// ── Role Definitions ─────────────────────────────────────────────────────────

const ROLES: { role: Role; label: string; description: string; color: string }[] = [
  { role: "END_USER",     label: "End User",      description: "Standard user — call, SMS, voicemail, contacts",  color: "var(--info)" },
  { role: "TENANT_ADMIN", label: "Tenant Admin",  description: "Full tenant management + admin panel access",     color: "var(--warning)" },
  { role: "SUPER_ADMIN",  label: "Platform Admin", description: "Global platform administrator",                  color: "var(--danger)" },
];

// ── Permission Toggle ─────────────────────────────────────────────────────────

function PermissionToggle({
  checked,
  locked,
  onChange,
}: {
  checked: boolean;
  locked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      onClick={() => !locked && onChange(!checked)}
      title={locked ? "This permission is locked for this role" : undefined}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        background: checked ? "var(--success)" : "var(--border)",
        position: "relative",
        cursor: locked ? "not-allowed" : "pointer",
        transition: "background 0.2s",
        flexShrink: 0,
        opacity: locked ? 0.5 : 1,
      }}
    >
      <div style={{
        position: "absolute",
        top: 3,
        left: checked ? 19 : 3,
        width: 14,
        height: 14,
        borderRadius: "50%",
        background: "#fff",
        transition: "left 0.15s",
        boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
      }} />
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function PermissionsPage() {
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [saveError, setSaveError] = useState("");

  // Local override state: starts from the compiled permissionMap, can be edited
  const [overrides, setOverrides] = useState<Record<Role, Set<Permission>>>(() => ({
    END_USER:     new Set(ROLE_PERMISSION_MAP.END_USER),
    TENANT_ADMIN: new Set(ROLE_PERMISSION_MAP.TENANT_ADMIN),
    SUPER_ADMIN:  new Set(ROLE_PERMISSION_MAP.SUPER_ADMIN),
  }));

  // Load server-side overrides if available
  const serverState = useAsyncResource<{ permissions: Partial<Record<Role, Permission[]>> }>(
    () => apiGet("/admin/role-permissions"),
    []
  );

  // Apply server overrides on load
  useMemo(() => {
    if (serverState.status !== "success") return;
    const srv = serverState.data.permissions;
    if (!srv) return;
    setOverrides((prev) => {
      const next = { ...prev };
      for (const role of ["END_USER", "TENANT_ADMIN", "SUPER_ADMIN"] as Role[]) {
        if (srv[role]) next[role] = new Set(srv[role]);
      }
      return next;
    });
  }, [serverState.status]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(role: Role, perm: Permission, value: boolean) {
    setOverrides((prev) => {
      const set = new Set(prev[role]);
      if (value) set.add(perm);
      else set.delete(perm);
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
        payload[role] = Array.from(overrides[role]);
      }
      await apiPost("/admin/role-permissions", { permissions: payload });
      setSaveMsg("Permission changes saved. They will apply on the next login.");
      setDirty(false);
    } catch (err: any) {
      setSaveError(err?.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setOverrides({
      END_USER:     new Set(ROLE_PERMISSION_MAP.END_USER),
      TENANT_ADMIN: new Set(ROLE_PERMISSION_MAP.TENANT_ADMIN),
      SUPER_ADMIN:  new Set(ROLE_PERMISSION_MAP.SUPER_ADMIN),
    });
    setDirty(false);
    setSaveMsg("");
    setSaveError("");
  }

  // SUPER_ADMIN always has all perms — lock those toggles
  const lockedForSuperAdmin = new Set(
    Object.values(PERMISSION_GROUPS).flatMap((g) => g.perms.map((p) => p.key))
  );

  return (
    <RoleGate allow={["SUPER_ADMIN"]} fallback={
      <div className="state-box" style={{ padding: 32, textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Access Restricted</div>
        <p style={{ color: "var(--text-dim)" }}>Only Platform Admins can manage permissions.</p>
      </div>
    }>
      <div className="stack compact-stack">
        <PageHeader
          title="Permissions Management"
          subtitle="Control which features are accessible to each role. Changes apply platform-wide on next login."
          actions={
            <div style={{ display: "flex", gap: 8 }}>
              {dirty ? (
                <button className="btn ghost" onClick={handleReset}>Reset to Defaults</button>
              ) : null}
              <button
                className="btn"
                onClick={handleSave}
                disabled={saving || !dirty}
                style={!dirty ? { opacity: 0.5 } : undefined}
              >
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          }
        />

        {saveMsg ? <div className="chip success" style={{ alignSelf: "flex-start" }}>{saveMsg}</div> : null}
        {saveError ? <div className="chip danger" style={{ alignSelf: "flex-start" }}>{saveError}</div> : null}
        {dirty ? (
          <div className="chip warning" style={{ alignSelf: "flex-start", fontSize: 12 }}>
            ⚠ Unsaved changes — click "Save Changes" to apply
          </div>
        ) : null}

        {/* Role legend */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {ROLES.map((r) => (
            <div
              key={r.role}
              className="panel"
              style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, flex: "1 1 200px" }}
            >
              <div style={{
                width: 10, height: 10, borderRadius: "50%",
                background: r.color, flexShrink: 0,
              }} />
              <div>
                <div style={{ fontWeight: 650, fontSize: 13 }}>{r.label}</div>
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{r.description}</div>
              </div>
              <div style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-dim)" }}>
                {overrides[r.role].size} permissions
              </div>
            </div>
          ))}
        </div>

        {/* Permission groups table */}
        {PERMISSION_GROUPS.map((group) => (
          <div key={group.group} className="panel" style={{ overflow: "hidden" }}>
            <div style={{
              padding: "10px 16px",
              background: "var(--panel-2)",
              borderBottom: "1px solid var(--border)",
              fontSize: 13,
              fontWeight: 650,
              color: "var(--text-dim)",
            }}>
              {group.group}
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", fontSize: 11, color: "var(--text-dim)" }}>
                  <th style={{ textAlign: "left", padding: "6px 16px", fontWeight: 500 }}>Permission</th>
                  {ROLES.map((r) => (
                    <th key={r.role} style={{ textAlign: "center", padding: "6px 14px", fontWeight: 600, color: r.color }}>
                      {r.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {group.perms.map((perm, idx) => (
                  <tr
                    key={perm.key}
                    style={{
                      borderBottom: idx < group.perms.length - 1 ? "1px solid var(--border)" : undefined,
                      background: idx % 2 === 0 ? undefined : "rgba(255,255,255,0.01)",
                    }}
                  >
                    <td style={{ padding: "10px 16px" }}>
                      <div style={{ fontSize: 13, fontWeight: 550 }}>{perm.label}</div>
                      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{perm.description}</div>
                    </td>
                    {ROLES.map((r) => {
                      const checked = overrides[r.role].has(perm.key);
                      // SUPER_ADMIN always has everything locked to ON
                      const locked = r.role === "SUPER_ADMIN";
                      // END_USER can't have TENANT_ADMIN-only perms — leave as-is but show warning
                      return (
                        <td key={r.role} style={{ textAlign: "center", padding: "10px 14px" }}>
                          <div style={{ display: "flex", justifyContent: "center" }}>
                            <PermissionToggle
                              checked={locked || checked}
                              locked={locked}
                              onChange={(v) => toggle(r.role, perm.key, v)}
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
            <p>Permissions are role-based and apply globally across all tenants by default. Each user is assigned one of three roles:</p>
            <ul style={{ paddingLeft: 18, marginTop: 6 }}>
              <li><strong>End User</strong> — standard agents and users. Can use calls, SMS, voicemail, and contacts.</li>
              <li><strong>Tenant Admin</strong> — manages the tenant's configuration, team, and reports.</li>
              <li><strong>Platform Admin</strong> — full access to all settings, all tenants, and global configuration.</li>
            </ul>
            <p style={{ marginTop: 8 }}>
              Platform Admin permissions are locked — they always have full access. Changes to End User and Tenant Admin 
              permissions take effect on next login. Nav items and UI elements are automatically shown or hidden based on permissions.
            </p>
          </div>
        </DetailCard>
      </div>
    </RoleGate>
  );
}
