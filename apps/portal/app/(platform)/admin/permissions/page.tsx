"use client";

import { useEffect, useMemo, useState } from "react";
import {
  EMPTY_NAV_VISIBILITY,
  NAV_ITEMS_ALWAYS_VISIBLE,
  PROTECTED_PLATFORM_ADMIN_PERMISSIONS,
  normalizeNavVisibility,
  type PortalNavVisibility,
  type PortalPermissionKey,
} from "@connect/shared";
import { PageHeader } from "../../../../components/PageHeader";
import { DetailCard } from "../../../../components/DetailCard";
import { PermissionGate } from "../../../../components/PermissionGate";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost } from "../../../../services/apiClient";
import type { Permission, Role } from "../../../../types/app";
import { ROLE_PERMISSION_MAP } from "../../../../permissions/permissionMap";
import {
  NAV_SECTION_ORDER,
  OWNER_ONLY_FIXED_NAV_ITEMS,
  navItems,
  navSectionMeta,
  type NavItem,
} from "../../../../navigation/navConfig";

type RolePermissionsResponse = {
  permissions: Partial<Record<Role, Permission[]>>;
  version?: number;
  keys?: Permission[];
  navVisibility?: unknown;
};

const ROLES: { role: Role; label: string; description: string; color: string }[] = [
  { role: "END_USER", label: "End User", description: "Standard user-facing access", color: "var(--info)" },
  { role: "TENANT_ADMIN", label: "Tenant Admin", description: "Tenant management and configuration", color: "var(--warning)" },
  { role: "SUPER_ADMIN", label: "Platform Admin", description: "Platform-wide access", color: "var(--danger)" },
];

const PROTECTED = new Set<PortalPermissionKey>(PROTECTED_PLATFORM_ADMIN_PERMISSIONS);
const ALWAYS_VISIBLE = new Set<string>(NAV_ITEMS_ALWAYS_VISIBLE);
const OWNER_ONLY_FIXED = new Set<string>(OWNER_ONLY_FIXED_NAV_ITEMS);

/**
 * THE SIDEBAR ITSELF IS THE CATALOG.
 *
 * This screen used to render the shared SIDEBAR_ITEMS list, which had drifted
 * badly behind the real sidebar: the whole Store section, Conference, Direct,
 * Meetings, Desk Phones and a dozen admin pages simply had no row here, so
 * there was no way to control them (Izzy, 2026-08-31 - "I have permissions
 * toggles in the custom roles for it, but not for the sidebar"). Reading
 * navItems means a page can never again exist in the sidebar and be missing
 * from this screen.
 *
 * Sections outside NAV_SECTION_ORDER are appended last: their permissions are
 * still real and worth managing even though the sidebar renders no such group
 * today (Tracking).
 */
const SECTION_GROUPS = (() => {
  const present = [...new Set(navItems.map((item) => item.section))];
  const ordered = [
    ...NAV_SECTION_ORDER.filter((id) => present.includes(id)),
    ...present.filter((id) => !NAV_SECTION_ORDER.includes(id)),
  ];
  return ordered.map((id) => ({
    id,
    label: navSectionMeta[id]?.label || id,
    permission: navItems.find((item) => item.section === id)!.sectionPermission,
    inSidebar: NAV_SECTION_ORDER.includes(id),
    items: navItems.filter((item) => item.section === id),
  }));
})();

/**
 * Which OTHER sidebar pages share this page's access permission.
 *
 * ⛔ Since 2026-09-02 this is EMPTY for every page and a test keeps it so
 * (permissionToggleCoverage.test.ts): every sidebar page has its own key, so a
 * role toggle here never moves another page. Kept as a live check rather than
 * deleted — if a future nav item reuses a key, the row says so instead of
 * silently coupling two toggles again.
 */
const SHARED_KEY_SIBLINGS = new Map<string, string[]>(
  navItems.map((item) => [
    item.id,
    navItems
      .filter((other) => other.id !== item.id && other.permission === item.permission)
      .map((other) => other.label),
  ]),
);

const GRID = "minmax(240px, 1fr) 108px 108px repeat(3, 130px)";

function Toggle({
  checked,
  disabled,
  onChange,
  title,
  tone = "success",
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  title?: string;
  tone?: "success" | "accent";
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
        background: checked ? (tone === "accent" ? "var(--accent)" : "var(--success)") : "var(--border)",
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
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [ownerOnlyLifted, setOwnerOnlyLifted] = useState<Set<string>>(() => new Set());

  const serverState = useAsyncResource<RolePermissionsResponse>(
    () => apiGet("/admin/role-permissions"),
    [],
  );

  useEffect(() => {
    if (serverState.status !== "success") return;
    const srv = serverState.data.permissions;
    if (srv) {
      setOverrides((prev) => {
        const next = { ...prev };
        for (const role of ["END_USER", "TENANT_ADMIN", "SUPER_ADMIN"] as Role[]) {
          if (Array.isArray(srv[role])) next[role] = new Set(srv[role]);
        }
        return next;
      });
    }
    const nav: PortalNavVisibility = serverState.data.navVisibility
      ? normalizeNavVisibility(serverState.data.navVisibility)
      : { ...EMPTY_NAV_VISIBILITY };
    setHidden(new Set(nav.hidden));
    setOwnerOnlyLifted(new Set(nav.ownerOnlyLifted));
  }, [serverState.data, serverState.status]);

  const counts = useMemo(() => {
    return ROLES.reduce<Record<Role, number>>(
      (acc, role) => {
        acc[role.role] = overrides[role.role].size;
        return acc;
      },
      { END_USER: 0, TENANT_ADMIN: 0, SUPER_ADMIN: 0 },
    );
  }, [overrides]);

  function markDirty() {
    setDirty(true);
    setSaveMsg("");
    setSaveError("");
  }

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
    markDirty();
  }

  /** The sidebar switch. Deliberately independent of every permission column. */
  function setInSidebar(navItemId: string, visible: boolean) {
    if (ALWAYS_VISIBLE.has(navItemId)) return;
    setHidden((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(navItemId);
      else next.add(navItemId);
      return next;
    });
    markDirty();
  }

  function setSectionInSidebar(items: NavItem[], visible: boolean) {
    setHidden((prev) => {
      const next = new Set(prev);
      for (const item of items) {
        if (ALWAYS_VISIBLE.has(item.id)) continue;
        if (visible) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
    markDirty();
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
      await apiPost("/admin/role-permissions", {
        permissions: payload,
        navVisibility: {
          hidden: Array.from(hidden),
          ownerOnlyLifted: Array.from(ownerOnlyLifted),
        },
      });
      setSaveMsg("Saved. This window's sidebar updates now; other windows pick it up on their next refresh or sign-in.");
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
    setHidden(new Set());
    setOwnerOnlyLifted(new Set());
    markDirty();
  }

  const hiddenCount = hidden.size;

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
          subtitle="Choose which pages appear in the sidebar, and who is allowed to open them."
          actions={
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {dirty ? <span className="chip warning" style={{ fontSize: 12 }}>Unsaved changes</span> : null}
              <button className="btn ghost" onClick={handleReset} disabled={saving}>Reset to Defaults</button>
              <button
                className="btn"
                onClick={handleSave}
                disabled={saving || !dirty}
                style={!dirty ? { opacity: 0.5 } : undefined}
              >
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          }
        />

        <div className="panel" style={{ padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Two separate things</div>
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
            <strong>In sidebar</strong> decides whether a page&rsquo;s link appears at all, for everybody, whatever their role.
            The three role columns decide who is allowed to open it. A page needs both: switched off here it is hidden from
            everyone, and switched on it still only shows for roles whose access is on. Every page has its own permission,
            so no toggle on this screen ever moves another page.
            {hiddenCount > 0 ? (
              <>
                {" "}
                Right now <strong>{hiddenCount}</strong> {hiddenCount === 1 ? "page is" : "pages are"} switched off.
              </>
            ) : null}
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

        {SECTION_GROUPS.map((section) => {
          const togglable = section.items.filter((item) => !ALWAYS_VISIBLE.has(item.id));
          const anyVisible = togglable.length === 0 || togglable.some((item) => !hidden.has(item.id));
          return (
            <div key={section.id} className="panel" style={{ overflow: "hidden" }}>
              <div
                style={{
                  padding: "12px 16px",
                  background: "var(--panel-2)",
                  borderBottom: "1px solid var(--border)",
                  display: "grid",
                  gridTemplateColumns: GRID,
                  gap: 12,
                  alignItems: "center",
                }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 800 }}>{section.label}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {section.inSidebar
                      ? `Master section access - ${section.items.length} pages`
                      : "No sidebar group is rendered for this section today - access only"}
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <Toggle
                    tone="accent"
                    checked={anyVisible}
                    onChange={(value) => setSectionInSidebar(section.items, value)}
                    title={`Show or hide every ${section.label} page in the sidebar`}
                  />
                </div>
                <div />
                {ROLES.map((role) => {
                  const locked =
                    role.role === "SUPER_ADMIN" && PROTECTED.has(section.permission as PortalPermissionKey);
                  const checked = locked || overrides[role.role].has(section.permission);
                  return (
                    <div key={role.role} style={{ display: "flex", justifyContent: "center" }}>
                      <Toggle
                        checked={checked}
                        disabled={locked}
                        title={
                          locked
                            ? "Platform Admin must retain permissions access."
                            : `${role.label}: ${section.label}`
                        }
                        onChange={(value) => toggle(role.role, section.permission, value)}
                      />
                    </div>
                  );
                })}
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: GRID,
                  gap: 12,
                  padding: "8px 16px",
                  borderBottom: "1px solid var(--border)",
                  fontSize: 11,
                  color: "var(--text-dim)",
                  fontWeight: 600,
                }}
              >
                <div>Sidebar page</div>
                <div style={{ textAlign: "center" }}>In sidebar</div>
                <div style={{ textAlign: "center" }}>Platform only</div>
                {ROLES.map((r) => (
                  <div key={r.role} style={{ textAlign: "center", fontWeight: 700, color: r.color }}>
                    {r.label}
                  </div>
                ))}
              </div>

              {section.items.map((item, idx) => {
                const isHidden = hidden.has(item.id);
                const alwaysVisible = ALWAYS_VISIBLE.has(item.id);
                const fixedOwnerOnly = OWNER_ONLY_FIXED.has(item.id);
                const siblings = SHARED_KEY_SIBLINGS.get(item.id) || [];
                return (
                  <div
                    key={item.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: GRID,
                      gap: 12,
                      alignItems: "center",
                      padding: "10px 16px",
                      borderBottom: idx < section.items.length - 1 ? "1px solid var(--border)" : undefined,
                      background: idx % 2 === 0 ? undefined : "rgba(255,255,255,0.01)",
                      opacity: isHidden ? 0.62 : 1,
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 650, display: "flex", alignItems: "center", gap: 8 }}>
                        {item.label}
                        {isHidden ? <span className="chip" style={{ fontSize: 10 }}>Hidden</span> : null}
                      </div>
                      <div className="muted" style={{ fontSize: 11 }}>{item.href}</div>
                      {siblings.length > 0 ? (
                        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                          Shares its access with {siblings.join(", ")} &mdash; use In sidebar to separate them.
                        </div>
                      ) : null}
                    </div>

                    <div style={{ display: "flex", justifyContent: "center" }}>
                      <Toggle
                        tone="accent"
                        checked={!isHidden}
                        disabled={alwaysVisible}
                        onChange={(value) => setInSidebar(item.id, value)}
                        title={
                          alwaysVisible
                            ? "This page can never be hidden - it is the only way back to these settings."
                            : `Show ${item.label} in the sidebar`
                        }
                      />
                    </div>

                    <div style={{ display: "flex", justifyContent: "center" }}>
                      {fixedOwnerOnly ? (
                        <span
                          className="chip"
                          style={{ fontSize: 10 }}
                          title="Platform-internal: this page shows or changes every customer's data, so it is locked to the platform owner."
                        >
                          Locked
                        </span>
                      ) : (
                        <span className="muted" style={{ fontSize: 12 }}>&mdash;</span>
                      )}
                    </div>

                    {ROLES.map((role) => {
                      const roleSectionOn = overrides[role.role].has(section.permission);
                      const locked =
                        role.role === "SUPER_ADMIN" && PROTECTED.has(item.permission as PortalPermissionKey);
                      const checked = locked || overrides[role.role].has(item.permission);
                      const disabled = locked || !roleSectionOn;
                      return (
                        <div
                          key={role.role}
                          style={{ display: "flex", justifyContent: "center", opacity: roleSectionOn ? 1 : 0.55 }}
                        >
                          <Toggle
                            checked={checked}
                            disabled={disabled}
                            title={
                              !roleSectionOn
                                ? `${section.label} is off for ${role.label}`
                                : locked
                                  ? "Platform Admin must retain permissions access."
                                  : `${role.label}: ${item.label}`
                            }
                            onChange={(value) => toggle(role.role, item.permission, value)}
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              {section.inSidebar ? null : (
                <div
                  className="muted"
                  style={{ padding: "10px 16px", fontSize: 12, borderTop: "1px solid var(--border)" }}
                >
                  The sidebar renders no {section.label} group today, so these switches affect access only.
                </div>
              )}
            </div>
          );
        })}

        <DetailCard title="How this works">
          <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.7 }}>
            <p>
              <strong>In sidebar</strong> is the platform&rsquo;s own switch and applies to everybody, including you. It only
              ever hides a link: it can never grant access, and the server checks permissions again on every request either way.
            </p>
            <p style={{ marginTop: 8 }}>
              Pages marked <em>Locked</em> show or change every customer&rsquo;s data, so they are held to the platform owner and no
              switch can open them to a customer role.
            </p>
            <p style={{ marginTop: 8 }}>
              Every page has its own permission. Turning a page on or off for a role never changes any other page, and a page
              held back for a first look (Meetings, Direct) simply starts with every role off &mdash; switching a role on is its
              launch for that role.
            </p>
            <p style={{ marginTop: 8 }}>
              Platform Admin access to this page is protected so the platform cannot be locked out of its own settings.
            </p>
          </div>
        </DetailCard>
      </div>
    </PermissionGate>
  );
}
