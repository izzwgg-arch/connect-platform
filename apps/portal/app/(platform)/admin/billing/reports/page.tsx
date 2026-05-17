"use client";

import { Suspense } from "react";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { AdminBillingOpsView } from "../_components/adminBillingOpsPanels";

export default function AdminBillingReportsPage() {
  return (
    <Suspense fallback={<LoadingSkeleton rows={6} />}>
      <AdminBillingOpsView view="reports" />
    </Suspense>
  );
}
