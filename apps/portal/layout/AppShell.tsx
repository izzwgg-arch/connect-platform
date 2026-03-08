"use client";

import type { ReactNode } from "react";
import { PageShell } from "../components/PageShell";
import { SupportBanner } from "../components/SupportBanner";
import { TenantContextBanner } from "../components/TenantContextBanner";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <PageShell
      banners={
        <>
          <TenantContextBanner />
          <SupportBanner />
        </>
      }
    >
      {children}
    </PageShell>
  );
}
