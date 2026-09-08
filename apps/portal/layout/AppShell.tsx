"use client";

import type { ReactNode } from "react";
import { PageShell } from "../components/PageShell";
import { FloatingAssistant } from "../components/FloatingAssistant";
import { OnboardingSetupNudge } from "../components/OnboardingSetupNudge";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <PageShell>
      {children}
      <FloatingAssistant />
      <OnboardingSetupNudge />
    </PageShell>
  );
}
