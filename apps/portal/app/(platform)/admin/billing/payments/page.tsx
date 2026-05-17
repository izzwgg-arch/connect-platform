"use client";

import { Suspense } from "react";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { PaymentsWorkspace } from "../_components/adminBillingPaymentsWorkspace";

export default function AdminBillingPaymentsPage() {
  return (
    <Suspense fallback={<LoadingSkeleton rows={6} />}>
      <PaymentsWorkspace />
    </Suspense>
  );
}
