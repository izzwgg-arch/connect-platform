"use client";

import type { ReactNode } from "react";
import { PageShell } from "../components/PageShell";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <PageShell>
      {children}
    </PageShell>
  );
}
