"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppSidebar } from "../components/AppSidebar";
import { HeaderBar } from "../components/HeaderBar";
import { SupportBanner } from "../components/SupportBanner";
import { TenantContextBanner } from "../components/TenantContextBanner";

function titleFromPath(pathname: string): string {
  if (pathname === "/") return "Dashboard";
  const cleaned = pathname.replace("/", "");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="shell">
      <AppSidebar />
      <div className="workspace">
        <HeaderBar title={titleFromPath(pathname)} />
        <TenantContextBanner />
        <SupportBanner />
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
