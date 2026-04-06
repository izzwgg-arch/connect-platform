"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAppContext } from "../hooks/useAppContext";
import { useTelephony } from "../contexts/TelephonyContext";
import { TenantSwitcher } from "./TenantSwitcher";
import { navSectionMeta, type NavItem } from "../navigation/navConfig";

type SidebarNavProps = {
  items: NavItem[];
  mobileOpen: boolean;
  onCloseMobile: () => void;
};

const SECTION_ORDER: NavItem["section"][] = [
  "dashboard",
  "pbx",
  "reports",
  "settings",
  "admin",
  "billing",
  "apps",
];

export function SidebarNav({ items, mobileOpen, onCloseMobile }: SidebarNavProps) {
  const pathname = usePathname();
  const { user } = useAppContext();
  const telephony = useTelephony();
  const isConnected = telephony.status === "connected";

  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <aside className={`console-nav ${mobileOpen ? "open" : ""}`}>
      {/* Profile + tenant block */}
      <div className="drawer-profile">
        <div className="drawer-user">
          <div className="drawer-user-avatar">{initials}</div>
          <div className="drawer-user-details">
            <span className="drawer-user-name">{user.name}</span>
            <span className={`drawer-user-status ${isConnected ? "connected" : "disconnected"}`}>
              {isConnected ? "● Connected" : "● Disconnected"}
            </span>
          </div>
        </div>
        <div className="drawer-tenant-wrap">
          <TenantSwitcher />
        </div>
      </div>

      {/* Scrollable nav */}
      <nav className="drawer-nav" aria-label="Main navigation">
        {SECTION_ORDER.map((section) => {
          const sectionItems = items.filter((item) => item.section === section);
          if (sectionItems.length === 0) return null;
          return (
            <div key={section} className="drawer-section">
              <div className="drawer-section-label">
                {navSectionMeta[section].label}
              </div>
              {sectionItems.map((item) => {
                const active =
                  pathname === item.href ||
                  (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`));
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`drawer-nav-link ${active ? "active" : ""}`}
                    onClick={onCloseMobile}
                  >
                    <span className="drawer-nav-icon">{item.icon}</span>
                    <span className="drawer-nav-label">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
