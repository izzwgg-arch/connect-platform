"use client";

import type { ReactNode } from "react";
import { PageShell } from "../components/PageShell";
import { CrmScreenPop } from "../components/CrmScreenPop";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <PageShell>
      {children}
      <CrmScreenPop />
    </PageShell>
  );
}
