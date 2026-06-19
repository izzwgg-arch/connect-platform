"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useAppContext } from "../hooks/useAppContext";
import { useNavSectionExpansion } from "../hooks/useNavSectionExpansion";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserAvatarUpload } from "./UserAvatarUpload";
import { NAV_SECTION_ORDER, navSectionMeta, type NavItem } from "../navigation/navConfig";
import { CollapsibleNavSection } from "./CollapsibleNavSection";
import { getPreferredUserDisplayName } from "../lib/userDisplayName";

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
                        title={item.label}
                        onClick={onCloseMobile}
                      >
                        <span className="drawer-nav-icon drawer-nav-icon-lucide" style={{ position: "relative" }}>
                          <Icon size={18} strokeWidth={1.85} />
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
                      onClick={onCloseMobile}
                    >
                      <span className="drawer-nav-icon drawer-nav-icon-lucide">
                        <Icon size={18} strokeWidth={1.85} />
                      </span>
                      <span className="drawer-nav-label">{item.label}</span>
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
    </aside>
  );
}
