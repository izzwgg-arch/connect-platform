"use client";

import Link from "next/link";
import type { MouseEvent as ReactMouseEvent } from "react";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useAppContext } from "../hooks/useAppContext";
import { useNavSectionExpansion } from "../hooks/useNavSectionExpansion";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserAvatarUpload } from "./UserAvatarUpload";
import { NAV_SECTION_ORDER, navSectionMeta, type NavItem } from "../navigation/navConfig";
import { CollapsibleNavSection } from "./CollapsibleNavSection";
import { getPreferredUserDisplayName } from "../lib/userDisplayName";
import { DesktopShellBeacon, DesktopUpdateToast, installDesktopUpdate, useDesktopUpdate } from "./DesktopUpdateNotice";

type SidebarNavProps = {
  items: NavItem[];
  mobileOpen: boolean;
  onCloseMobile: () => void;
  isMobile: boolean;
  railMode: boolean;
  onToggleRail: () => void;
  /** Unread count badges keyed by NavItem.badgeKey (e.g. "chat", "voicemail"). */
  badges?: Record<string, number>;
};

function navLinkActive(pathname: string, href: string) {
  if (href.startsWith("/downloads/")) return false;
  if (pathname === href) return true;
  if (href === "/dashboard") return false;
  return pathname.startsWith(`${href}/`);
}

export function SidebarNav({
  items,
  mobileOpen,
  onCloseMobile,
  isMobile,
  railMode,
  onToggleRail,
  badges = {},
}: SidebarNavProps) {
  const pathname = usePathname();
  const { user, setUserAvatarUrl } = useAppContext();
  const { isExpanded, toggle } = useNavSectionExpansion();
  const displayName = getPreferredUserDisplayName(user);

  // Desktop auto-update: when the shell reports an update, the "Install" nav
  // item becomes the in-app update surface — "New Update" chip, download
  // progress, and a one-click install (quitAndInstall) instead of the browser
  // download link. In the web portal (no bridge) it stays a plain download.
  const desktopUpdate = useDesktopUpdate();
  const updateReady = desktopUpdate?.status === "downloaded";
  const updateDownloading = desktopUpdate?.status === "available" || desktopUpdate?.status === "downloading";
  const installChip = updateReady
    ? "New Update"
    : updateDownloading
      ? `Downloading ${desktopUpdate?.percent ?? 0}%`
      : null;
  const handleInstallItemClick = (item: NavItem, event: ReactMouseEvent) => {
    if (item.id !== "workspace.install") return;
    if (updateReady) {
      event.preventDefault();
      installDesktopUpdate();
    } else if (updateDownloading) {
      event.preventDefault(); // already on its way — don't also download the installer
    }
  };

  const effectiveRail = !isMobile && railMode;
  const asideClass = [
    "console-nav",
    isMobile && mobileOpen ? "open" : "",
    !isMobile && effectiveRail ? "nav-rail" : "",
    !isMobile && !effectiveRail ? "nav-expanded" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <aside className={asideClass}>
      <div className={`drawer-profile ${effectiveRail ? "drawer-profile-rail" : ""}`}>
        {!effectiveRail ? (
          <div className="drawer-user">
            <UserAvatarUpload
              name={displayName}
              avatarUrl={user.avatarUrl}
              size={38}
              editable
              onUploaded={setUserAvatarUrl}
              className="drawer-user-avatar"
            />
            <div className="drawer-user-details">
              <span className="drawer-user-name">{displayName}</span>
            </div>
          </div>
        ) : (
          <div className="drawer-user-rail" title={displayName}>
            <UserAvatarUpload
              name={displayName}
              avatarUrl={user.avatarUrl}
              size={28}
              className="drawer-user-avatar drawer-user-avatar-sm"
            />
          </div>
        )}
        <div className={`drawer-tenant-wrap ${effectiveRail ? "drawer-tenant-wrap-rail" : ""}`}>
          <TenantSwitcher railMode={effectiveRail} />
        </div>
      </div>

      <nav className="drawer-nav" aria-label="Main navigation">
        {effectiveRail ? (
          <div className="nav-rail-stack">
            {NAV_SECTION_ORDER.map((section) => {
              const sectionItems = items.filter((item) => item.section === section);
              if (sectionItems.length === 0) return null;
              return (
                <div key={section} className="nav-rail-group">
                  {sectionItems.map((item) => {
                    const active = navLinkActive(pathname, item.href);
                    const Icon = item.lucide;
                    const badgeCount = item.badgeKey ? (badges[item.badgeKey] ?? 0) : 0;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        download={item.download ? "" : undefined}
                        prefetch={item.download ? false : undefined}
                        className={`drawer-nav-link drawer-nav-link-rail ${active ? "active" : ""}`}
                        title={item.id === "workspace.install" && installChip ? `${item.label} — ${installChip}` : item.label}
                        onClick={(event) => { handleInstallItemClick(item, event); onCloseMobile(); }}
                      >
                        <span className="drawer-nav-icon drawer-nav-icon-lucide" style={{ position: "relative" }}>
                          <Icon size={18} strokeWidth={1.85} />
                          {item.id === "workspace.install" && installChip && (
                            <span
                              aria-label={installChip}
                              style={{
                                position: "absolute",
                                top: -3,
                                right: -3,
                                width: 9,
                                height: 9,
                                borderRadius: "9999px",
                                background: "#22c55e",
                                boxShadow: "0 0 8px rgba(34,197,94,.9)",
                              }}
                            />
                          )}
                          {badgeCount > 0 && (
                            <span
                              aria-label={`${badgeCount} unread`}
                              style={{
                                position: "absolute",
                                top: -4,
                                right: -4,
                                minWidth: "1rem",
                                height: "1rem",
                                borderRadius: "9999px",
                                background: "var(--danger)",
                                color: "#fff",
                                fontSize: "9px",
                                fontWeight: 700,
                                lineHeight: "1rem",
                                textAlign: "center",
                                padding: "0 2px",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              {badgeCount > 99 ? "99+" : badgeCount}
                            </span>
                          )}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ) : (
          NAV_SECTION_ORDER.map((section) => {
            const sectionItems = items.filter((item) => item.section === section);
            if (sectionItems.length === 0) return null;
            const label = navSectionMeta[section].label;
            const expanded = isExpanded(section);
            return (
              <CollapsibleNavSection
                key={section}
                id={`nav-sec-${section}`}
                label={label}
                expanded={expanded}
                onToggle={() => toggle(section)}
                railMode={false}
              >
                {sectionItems.map((item) => {
                  const active = navLinkActive(pathname, item.href);
                  const Icon = item.lucide;
                  const badgeCount = item.badgeKey ? (badges[item.badgeKey] ?? 0) : 0;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      download={item.download ? "" : undefined}
                      prefetch={item.download ? false : undefined}
                      className={`drawer-nav-link ${active ? "active" : ""}`}
                      onClick={(event) => { handleInstallItemClick(item, event); onCloseMobile(); }}
                    >
                      <span className="drawer-nav-icon drawer-nav-icon-lucide">
                        <Icon size={18} strokeWidth={1.85} />
                      </span>
                      <span className="drawer-nav-label">{item.label}</span>
                      {item.id === "workspace.install" && installChip && (
                        <span
                          style={{
                            marginLeft: "auto",
                            borderRadius: "9999px",
                            padding: "2px 8px",
                            fontSize: 10,
                            fontWeight: 800,
                            letterSpacing: 0.2,
                            background: updateReady ? "#22c55e" : "rgba(34,197,94,.18)",
                            color: updateReady ? "#04120a" : "#22c55e",
                            flexShrink: 0,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {installChip}
                        </span>
                      )}
                      {badgeCount > 0 && (
                        <span
                          aria-label={`${badgeCount} unread`}
                          style={{
                            marginLeft: "auto",
                            minWidth: "1.25rem",
                            height: "1.25rem",
                            borderRadius: "9999px",
                            background: "var(--danger)",
                            color: "#fff",
                            fontSize: "10px",
                            fontWeight: 700,
                            lineHeight: "1.25rem",
                            textAlign: "center",
                            padding: "0 4px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          {badgeCount > 99 ? "99+" : badgeCount}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </CollapsibleNavSection>
            );
          })
        )}
      </nav>

      {!isMobile ? (
        <div className="drawer-footer">
          <button
            type="button"
            className="drawer-rail-toggle"
            onClick={onToggleRail}
            title={effectiveRail ? "Expand sidebar" : "Collapse to icons"}
            aria-label={effectiveRail ? "Expand sidebar" : "Collapse sidebar to icon rail"}
          >
            {effectiveRail ? <PanelLeftOpen size={18} strokeWidth={1.85} /> : <PanelLeftClose size={18} strokeWidth={1.85} />}
          </button>
        </div>
      ) : null}

      {/* Desktop-only: "New update ready — Install" notice (fixed position, renders app-wide). */}
      <DesktopUpdateToast />
      {/* Desktop-only, invisible: reports shell version + user for the install census. */}
      <DesktopShellBeacon />
    </aside>
  );
}
