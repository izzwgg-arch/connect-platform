"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItems, navSectionMeta, type NavItem } from "../navigation/navConfig";

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

export function SidebarNav({ items, mobileOpen, onCloseMobile }: SidebarNavProps) {
  const pathname = usePathname();
  const currentSection = activeSection(pathname, items);
  const sectionItems = items.filter((item) => item.section === currentSection);
  const sectionOrder: NavItem["section"][] = ["dashboard", "pbx", "reports", "settings", "admin", "billing", "apps"];

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
            return (
              <Link
                key={section}
                href={target.href}
                className={`rail-link ${active ? "active" : ""}`}
                title={navSectionMeta[section].label}
                onClick={onCloseMobile}
              >
                <span>{navSectionMeta[section].railIcon}</span>
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
      </div>
    </aside>
  );
}
