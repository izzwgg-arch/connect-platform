"use client";

import { Suspense } from "react";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { PaymentsWorkspace } from "../_components/adminBillingPaymentsWorkspace";
import { TransactionsTab } from "../_components/adminBillingOpsPanels";
import { useAdminBillingTenant } from "../_components/useAdminBillingTenant";

function AdminBillingPaymentsBody() {
  const { effectiveTenantId } = useAdminBillingTenant();

  if (!effectiveTenantId) {
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
