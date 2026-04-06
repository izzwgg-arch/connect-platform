"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { useAppContext } from "../hooks/useAppContext";
import { navItems } from "../navigation/navConfig";
import { SidebarNav } from "./SidebarNav";
import { Topbar } from "./Topbar";

function titleFromPath(pathname: string): string {
  const match = [...navItems]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
  if (match) return match.label;
  const fallback = pathname.split("/").filter(Boolean).pop() || "Dashboard";
  return fallback.charAt(0).toUpperCase() + fallback.slice(1).replace(/-/g, " ");
}

export function PageShell({ children, banners }: { children: ReactNode; banners?: ReactNode }) {
  const pathname = usePathname();
  const { can } = useAppContext();
  const [navOpen, setNavOpen] = useState(false);
  const visibleItems = useMemo(() => navItems.filter((item) => can(item.permission)), [can]);

  return (
    <div className="console-shell">
      {/* Fixed header — always on top, never moves */}
      <Topbar title={titleFromPath(pathname)} onToggleNav={() => setNavOpen((v) => !v)} />

      {/* Body below header: drawer + content side by side */}
      <div className="console-body">
        <SidebarNav
          items={visibleItems}
          mobileOpen={navOpen}
          onCloseMobile={() => setNavOpen(false)}
        />
        <div className="console-workspace">
          {banners ? <div className="workspace-banners">{banners}</div> : null}
          <main className="console-content">{children}</main>
        </div>
      </div>

      {/* Mobile backdrop only — hidden on desktop via CSS */}
      {navOpen ? (
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
        />
      ) : null}
    </div>
  );
}
