"use client";

import type { ReactNode } from "react";
import { PageShell } from "../components/PageShell";
import { CrmScreenPop } from "../components/CrmScreenPop";
import { FloatingAssistant } from "../components/FloatingAssistant";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <PageShell>
      {children}
      <CrmScreenPop />
      <FloatingAssistant />
    </PageShell>
  );
}
