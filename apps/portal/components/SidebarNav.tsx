"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Phone, Users, ListOrdered, Truck, BarChart3, Settings } from "lucide-react";
import { navItems, navSectionMeta, type NavItem } from "../navigation/navConfig";
import { useAppContext } from "../hooks/useAppContext";
import { useTelephony } from "../contexts/TelephonyContext";

type SidebarNavProps = {
  items: NavItem[];
  mobileOpen: boolean;
  onCloseMobile: () => void;
};

function activeSection(pathname: string, items: NavItem[]): NavItem["section"] {
  const match = [...items]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
  return match?.section || "dashboard";
}

const sectionIcons = {
  dashboard: LayoutDashboard,
  pbx: Phone,
  reports: BarChart3,
  settings: Settings,
  admin: Settings,
  billing: BarChart3,
  apps: LayoutDashboard,
} as const;

export function SidebarNav({ items, mobileOpen, onCloseMobile }: SidebarNavProps) {
  const pathname = usePathname();
  const { user } = useAppContext();
  const telephony = useTelephony();
  const currentSection = activeSection(pathname, items);
  const sectionItems = items.filter((item) => item.section === currentSection);
  const sectionOrder: NavItem["section"][] = ["dashboard", "pbx", "reports", "settings", "admin", "billing", "apps"];
  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const isConnected = telephony.status === "connected";

  return (
    <aside className={`console-nav ${mobileOpen ? "open" : ""}`}>
      <div className="icon-rail">
        <div className="brand-mark" title="Connect Communications">
          CC
        </div>
        <nav className="icon-rail-list" aria-label="Primary">
          {sectionOrder.map((section) => {
            const target = items.find((entry) => entry.section === section);
            if (!target) return null;
            const active = section === currentSection;
            const Icon = sectionIcons[section];
            return (
              <Link
                key={section}
                href={target.href}
                className={`rail-link ${active ? "active" : ""}`}
                title={navSectionMeta[section].label}
                onClick={onCloseMobile}
              >
                {Icon ? <Icon size={16} /> : <span>{navSectionMeta[section].railIcon}</span>}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="secondary-rail">
        <div className="secondary-title">{navSectionMeta[currentSection].label}</div>
        <nav className="secondary-list" aria-label="Section">
          {sectionItems.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`secondary-link ${active ? "active" : ""}`}
                onClick={onCloseMobile}
              >
                <span className="secondary-link-icon">{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-user-avatar">{initials}</div>
            <div className="sidebar-user-info">
              <span className="sidebar-user-name">{user.name}</span>
              <span className={`sidebar-user-status ${isConnected ? "connected" : "disconnected"}`}>
                {isConnected ? "🟢 Connected" : "🔴 Disconnected"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
