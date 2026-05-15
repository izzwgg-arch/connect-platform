"use client";

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
