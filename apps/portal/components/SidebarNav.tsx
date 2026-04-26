"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useAppContext } from "../hooks/useAppContext";
import { useNavSectionExpansion } from "../hooks/useNavSectionExpansion";
import { useTelephony } from "../contexts/TelephonyContext";
import { TenantSwitcher } from "./TenantSwitcher";
import { NAV_SECTION_ORDER, navSectionMeta, type NavItem } from "../navigation/navConfig";
import { CollapsibleNavSection } from "./CollapsibleNavSection";

type SidebarNavProps = {
  items: NavItem[];
  mobileOpen: boolean;
  onCloseMobile: () => void;
  isMobile: boolean;
  railMode: boolean;
  onToggleRail: () => void;
};

function navLinkActive(pathname: string, href: string) {
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
  onToggleRail
}: SidebarNavProps) {
  const pathname = usePathname();
  const { user } = useAppContext();
  const telephony = useTelephony();
  const { isExpanded, toggle } = useNavSectionExpansion();
  const isConnected = telephony.status === "connected";

  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

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
            <div className="drawer-user-avatar" aria-hidden>
              {initials}
            </div>
            <div className="drawer-user-details">
              <span className="drawer-user-name">{user.name}</span>
              <span className={`drawer-user-status ${isConnected ? "connected" : "disconnected"}`}>
                {isConnected ? "● Connected" : "● Disconnected"}
              </span>
            </div>
          </div>
        ) : (
          <div className="drawer-user-rail" title={`${user.name} — ${user.email || "Signed in"}`}>
            <div className="drawer-user-avatar drawer-user-avatar-sm" aria-hidden>
              {initials}
            </div>
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
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={`drawer-nav-link drawer-nav-link-rail ${active ? "active" : ""}`}
                        title={item.label}
                        onClick={onCloseMobile}
                      >
                        <span className="drawer-nav-icon drawer-nav-icon-lucide">
                          <Icon size={18} strokeWidth={1.85} />
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
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`drawer-nav-link ${active ? "active" : ""}`}
                      onClick={onCloseMobile}
                    >
                      <span className="drawer-nav-icon drawer-nav-icon-lucide">
                        <Icon size={18} strokeWidth={1.85} />
                      </span>
                      <span className="drawer-nav-label">{item.label}</span>
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
