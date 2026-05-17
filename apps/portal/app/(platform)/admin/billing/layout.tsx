"use client";

import "./_components/billingPhase3.css";
import "./_components/billingPhase4.css";
import "./_components/billingPhase5.css";
import "./_components/billingPhase6.css";
import "./_components/billingPhase7.css";
import "./_components/billingPhase8.css";
import { Suspense, type ReactNode } from "react";
import { AdminBillingShell } from "./_components/AdminBillingShell";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";

export default function AdminBillingLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<LoadingSkeleton rows={6} />}>
      <AdminBillingShell>{children}</AdminBillingShell>
    </Suspense>
  );
}
