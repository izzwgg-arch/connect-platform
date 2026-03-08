"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { useAppContext } from "../hooks/useAppContext";
import { navItems } from "../navigation/navConfig";
import { SidebarNav } from "./SidebarNav";
import { Topbar } from "./Topbar";

function titleFromPath(pathname: string): string {
  const match = navItems.find((item) => item.href === pathname);
  if (match) return match.label;
  const fallback = pathname.split("/").filter(Boolean).pop() || "Dashboard";
  return fallback.charAt(0).toUpperCase() + fallback.slice(1).replace(/-/g, " ");
}

export function PageShell({ children, banners }: { children: ReactNode; banners?: ReactNode }) {
  const pathname = usePathname();
  const { can } = useAppContext();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const visibleItems = useMemo(() => navItems.filter((item) => can(item.permission)), [can]);

  return (
    <div className="console-shell">
      <SidebarNav items={visibleItems} mobileOpen={mobileNavOpen} onCloseMobile={() => setMobileNavOpen(false)} />
      <div className="console-workspace">
        <Topbar title={titleFromPath(pathname)} onToggleNav={() => setMobileNavOpen((v) => !v)} />
        {banners ? <div className="workspace-banners">{banners}</div> : null}
        <main className="console-content">{children}</main>
      </div>
      {mobileNavOpen ? <button className="nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} /> : null}
    </div>
  );
}
