"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { AlertTriangle, ArrowLeft, Shield } from "lucide-react";
import Link from "next/link";
import {
  ACCOUNT_OWNER_PERMISSION_KEY,
  SIDEBAR_SECTIONS,
  SIDEBAR_ITEMS,
  ACTION_PERMISSION_KEYS,
  type PortalPermissionKey,
} from "@connect/shared";
import {
  NAV_SECTION_ORDER,
  OWNER_ONLY_FIXED_NAV_ITEMS,
  OWNER_ONLY_LIFTABLE_NAV_ITEMS,
  navItems,
  navSectionMeta,
} from "../../../../../navigation/navConfig";
import { PageHeader } from "../../../../../components/PageHeader";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
import { apiGet, apiPost, apiPut } from "../../../../../services/apiClient";

type CatalogResponse = {
  keys: PortalPermissionKey[];
  grantableKeys: PortalPermissionKey[];
  bucketDefaults?: Record<string, PortalPermissionKey[]>;
};

const BASE_ROLE_OPTIONS: Array<{ bucket: string; label: string }> = [
  { bucket: "END_USER", label: "End User" },
  { bucket: "TENANT_ADMIN", label: "Tenant Administrator" },
  { bucket: "SUPER_ADMIN", label: "Admin" },
];

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

type MatrixItem = { id: string; label: string; permission: string };
type MatrixSection = { id: string; label: string; permission: string };

/**
 * THE SIDEBAR ITSELF IS THE CATALOG (Izzy's standing rule, 2026-08-31).
 *
 * This screen rendered the shared SIDEBAR_ITEMS list, which had drifted 23
 * pages behind the real sidebar - Direct, Meetings, Desk Phones, Install, the
 * whole Store section and 13 admin pages had NO row here at all, so a custom
 * role could not be given or denied any of them. /admin/permissions was moved
 * off that list on 2026-08-31; this screen was left behind, which is the half
 * that broke. Reading navItems means a page can never again exist in the
 * sidebar and be missing from this matrix.
 *
 * Do NOT simplify this back to SIDEBAR_ITEMS, and do not drop the orphan group
 * below - it carries permission keys that are real and grantable but whose page
 * is not in the sidebar today (the billing sub-pages). Dropping it would
 * silently remove the only place those can be granted.
 */
const SECTION_GROUPS: Array<{ section: MatrixSection; items: MatrixItem[] }> = (() => {
  const present = [...new Set(navItems.map((item) => item.section))];
  const ordered = [
    ...NAV_SECTION_ORDER.filter((id) => present.includes(id)),
    ...present.filter((id) => !NAV_SECTION_ORDER.includes(id)),
  ];

  const groups: Array<{ section: MatrixSection; items: MatrixItem[] }> = ordered.map((id) => ({
    section: {
      id,
      label: navSectionMeta[id]?.label || id,
      permission: navItems.find((item) => item.section === id)!.sectionPermission,
    },
    items: navItems
      .filter((item) => item.section === id)
      .map((item) => ({ id: item.id, label: item.label, permission: item.permission })),
  }));

  // Keys only the old catalog offered: keep a home for them so switching
  // catalogs cannot take a grantable permission away from anyone.
  const covered = new Set<string>([
    ...navItems.map((item) => item.permission),
    ...navItems.map((item) => item.sectionPermission),
    ...(ACTION_PERMISSION_KEYS as readonly string[]),
  ]);
  const orphans = SIDEBAR_ITEMS.filter((item) => !covered.has(item.permission));
  if (orphans.length) {
    groups.push({
      section: {
        id: "legacy",
        label: "Other pages",
        permission:
          SIDEBAR_SECTIONS.find((sec) => sec.id === orphans[0].section)?.permission
          || orphans[0].permission,
      },
      items: orphans.map((item) => ({
        id: item.id,
        label: item.label,
        permission: item.permission,
      })),
    });
  }

  return groups;
})();

/** Every item permission, by section id - used when a section is switched off. */
const SECTION_ITEM_PERMISSIONS = new Map<string, string[]>(
  SECTION_GROUPS.map(({ section, items }) => [section.id, items.map((i) => i.permission)]),
);

/**
 * Several sidebar pages deliberately SHARE one access permission (Direct rides
 * Chat's key, Meetings rides Overview's, Install rides Contacts', all five Store
 * pages share one). Toggling such a row here moves its siblings too - so the row
 * says so, rather than letting an admin switch Direct off and silently lose Chat.
 * Per-PAGE hiding that does not touch siblings is the In-sidebar switch on
 * /admin/permissions, which keys on nav ids instead of permission keys.
 */
const SHARED_KEY_SIBLINGS = new Map<string, string[]>(
  SECTION_GROUPS.flatMap(({ items }) =>
    items.map((item) => [
      item.id,
      items.filter((o) => o.id !== item.id && o.permission === item.permission).map((o) => o.label),
    ] as [string, string[]]),
  ),
);

/**
 * Keys that already render as a sidebar-page row above (Desk Phones rides
 * can_setup_desk_phones, Remote Support rides can_remote_support). Rendering
 * them again in the Action Permissions panel would be two toggles bound to ONE
 * key that flip together — exactly the coupling Izzy ruled out on 2026-09-02
 * ("every toggle should be individual"). One key, one toggle.
 */
const NAV_BOUND_ACTION_KEYS = new Set<string>(navItems.map((item) => item.permission as string));

const DANGEROUS_PERMISSIONS: Set<string> = new Set([
  "can_manage_global_settings",
  "can_switch_tenants",
  "can_manage_deploys",
  "can_view_admin_permissions",
  "can_sync_voip_ms_numbers",
]);

/**
 * Action permission keys hidden from the editor's Action Permissions panel
 * because they are not (yet) enforced anywhere, so toggling them would mislead.
 *  - No working backend: call forwarding (no API route), BLFs (UI stub),
 *    edit team (Team Directory is read-only).
 *  - Public by design: APK download endpoint bypasses auth for pre-login invites.
 *  - Legacy "view" keys superseded by the granular sidebar section/item keys
 *    above — visibility is driven by those, so these are dead duplicates here.
 */
/**
 * Sidebar pages whose visibility is FORCED to platform staff in
 * isNavItemVisibleForUser regardless of any granted permission. Offering a
 * toggle for them here is a toggle that lies — the save lands, the server
 * grants the key, and the sidebar refuses anyway (the exact complaint of
 * 2026-09-01: "I've turned on toggles for people and they don't see it").
 * They render as Locked instead.
 */
const LOCKED_NAV_ITEMS = new Set<string>(OWNER_ONLY_FIXED_NAV_ITEMS);

/** Pages hidden until the platform owner launches them (In-sidebar "Owner only" switch). */
const LAUNCH_GATED_NAV_ITEMS = new Set<string>(OWNER_ONLY_LIFTABLE_NAV_ITEMS);

/** Per-row honesty notes for gates a permission cannot open. */
const STORE_DATA_NOTE =
  "Shows the page; loading its data also needs can_view_supermarket_orders under Action Permissions";
const NAV_ITEM_NOTES: Record<string, string> = {
  "crm.diagnostics": "Only shows for admin accounts",
  "store.orders": STORE_DATA_NOTE,
  "store.deliveries": STORE_DATA_NOTE,
  "store.drivers": STORE_DATA_NOTE,
  "store.specials": STORE_DATA_NOTE,
  "store.teach": STORE_DATA_NOTE,
};

const HIDDEN_ACTION_KEYS: Set<string> = new Set([
  ACCOUNT_OWNER_PERMISSION_KEY, // rendered as the dedicated Owner card, never a generic row
  "can_manage_call_forwarding",
  "can_manage_blfs",
  "can_edit_team",
  "can_download_apk",
  "can_view_dashboard",
  "can_view_team",
  "can_view_calls",
  "can_view_voicemail",
  "can_view_chat",
  "can_view_contacts",
  "can_view_settings",
  "can_view_apps",
  "can_view_admin",
  "can_view_ivr_routing",
  "can_view_moh",
  "can_view_did_routing",
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

  /**
   * Toggling a sidebar SECTION off also removes every child item permission
   * under it, so "off" genuinely means hidden — there are no orphaned child
   * permissions left in the saved set under a disabled section.
   */
  function toggleSection(sectionPermission: string, sectionId: string, value: boolean) {
    setSelectedPerms((prev) => {
      const next = new Set(prev);
      if (value) {
        next.add(sectionPermission);
      } else {
        next.delete(sectionPermission);
        for (const permission of SECTION_ITEM_PERMISSIONS.get(sectionId) || []) {
          next.delete(permission);
        }
      }
      return next;
    });
  }

  /**
   * Seed the permission matrix from a built-in role bucket's defaults (only the
   * keys this admin is allowed to grant). The admin can then add/remove
   * individual toggles. This is a convenience prefill — the saved role is always
   * exactly the resulting toggle state, never the bucket itself.
   */
  function applyBaseRole(bucket: string) {
    if (catalog.status !== "success") return;
    const defaults = catalog.data.bucketDefaults?.[bucket] ?? [];
    const grantableDefaults = defaults.filter((p) => grantable.has(p));
    setSelectedPerms(new Set(grantableDefaults));
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

            {/* Base role prefill */}
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 2 }}>Start from a base role</label>
              <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
                Fills the permission matrix with a built-in role&apos;s defaults. Add or remove individual toggles below — the role is saved exactly as you leave it.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {BASE_ROLE_OPTIONS.filter(
                  (opt) => (catalog.status === "success" ? (catalog.data.bucketDefaults?.[opt.bucket]?.length ?? 0) > 0 : false),
                ).map((opt) => (
                  <button
                    key={opt.bucket}
                    type="button"
                    className="btn ghost"
                    style={{ fontSize: 12 }}
                    disabled={loading}
                    onClick={() => applyBaseRole(opt.bucket)}
                    title={`Replace current selection with ${opt.label} defaults`}
                  >
                    {opt.label}
                  </button>
                ))}
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
            {/* Owner — full account access */}
            {(() => {
              const ownerGrantable = grantable.has(ACCOUNT_OWNER_PERMISSION_KEY as PortalPermissionKey);
              const ownerOn = selectedPerms.has(ACCOUNT_OWNER_PERMISSION_KEY);
              return (
                <div className="panel" style={{ padding: "14px 16px", border: ownerOn ? "1px solid var(--accent)" : undefined }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <PermissionToggle
                      checked={ownerOn}
                      disabled={!ownerGrantable}
                      title={!ownerGrantable ? "You cannot grant owner status" : "Owner — full access to their account"}
                      onChange={(v) => togglePerm(ACCOUNT_OWNER_PERMISSION_KEY, v)}
                    />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>
                        Owner — full access to their account
                        <span className="chip warning" style={{ fontSize: 10, marginLeft: 8 }}>Elevated</span>
                      </div>
                      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                        Everyone with this role gets every tenant-admin permission in their own account —
                        including pages added in the future, with no re-save. The toggles below still add
                        extras on top. It never grants platform-staff screens.
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

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
                      onChange={(v) => toggleSection(section.permission, section.id, v)}
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
                          const locked = LOCKED_NAV_ITEMS.has(item.id);
                          const launchGated = LAUNCH_GATED_NAV_ITEMS.has(item.id);
                          const navNote = NAV_ITEM_NOTES[item.id];
                          const disabled = locked || !itemGrantable || !sectionOn;
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
                                    checked={locked ? false : checked}
                                    disabled={disabled}
                                    title={
                                      locked
                                        ? "Platform staff only — no permission can open this page"
                                        : !itemGrantable
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
                                      {locked && (
                                        <span className="chip" style={{ fontSize: 10, marginLeft: 6 }} title="Platform staff only — no permission can open this page">Locked</span>
                                      )}
                                    </div>
                                    <div className="muted" style={{ fontSize: 10 }}>{item.permission}</div>
                                    {locked && (
                                      <div className="muted" style={{ fontSize: 10, fontStyle: "italic", marginTop: 2 }}>
                                        Platform staff only — granting a permission cannot show this page
                                      </div>
                                    )}
                                    {!locked && launchGated && (
                                      <div className="muted" style={{ fontSize: 10, fontStyle: "italic", marginTop: 2 }}>
                                        Hidden for everyone until the platform owner launches this page (Admin → Permissions → Owner only)
                                      </div>
                                    )}
                                    {!locked && navNote && (
                                      <div className="muted" style={{ fontSize: 10, fontStyle: "italic", marginTop: 2 }}>{navNote}</div>
                                    )}
                                    {(SHARED_KEY_SIBLINGS.get(item.id) || []).length > 0 && (
                                      <div
                                        className="muted"
                                        style={{ fontSize: 10, fontStyle: "italic", marginTop: 2 }}
                                        title="These pages share one access permission, so this toggle moves all of them."
                                      >
                                        shares access with {(SHARED_KEY_SIBLINGS.get(item.id) || []).join(", ")}
                                      </div>
                                    )}
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
                  {ACTION_PERMISSION_KEYS.filter((k) => !TENANT_COMM_PERMS.some((t) => t.key === k) && !HIDDEN_ACTION_KEYS.has(k) && !NAV_BOUND_ACTION_KEYS.has(k)).map((key, idx) => {
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
