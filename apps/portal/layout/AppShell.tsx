"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { PageShell } from "../components/PageShell";
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
    <PageShell
      banners={
        <>
          <TenantContextBanner />
          <SupportBanner />
        </>
      }
    >
      <div className="stack compact-stack">
        <div className="page-kicker">{titleFromPath(pathname)}</div>
        {children}
      </div>
    </PageShell>
  );
}
