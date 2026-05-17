"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { PaymentsWorkspace } from "../_components/adminBillingPaymentsWorkspace";
import { TransactionsTab } from "../_components/adminBillingOpsPanels";

function AdminBillingPaymentsBody() {
  const searchParams = useSearchParams();
  const tenantId = String(searchParams.get("tenantId") || "").trim();

  if (!tenantId) {
    return (
      <div className="billing-ws-section billing-p8-scope billing-pay-scope" data-testid="billing-admin-payments-global">
        <TransactionsTab />
      </div>
    );
  }

  return <PaymentsWorkspace />;
}

export default function AdminBillingPaymentsPage() {
  return (
    <Suspense fallback={<LoadingSkeleton rows={6} />}>
      <AdminBillingPaymentsBody />
    </Suspense>
  );
}
