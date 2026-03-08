"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavItem } from "../navigation/navConfig";

export function SidebarNavGroup({ label, items }: { label: string; items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <div className="sidebar-group">
      <div className="sidebar-group-label">{label}</div>
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link key={item.href} className={`nav-link ${active ? "active" : ""}`} href={item.href}>
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
