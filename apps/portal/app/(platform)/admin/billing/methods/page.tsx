"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiGet } from "../../../../../services/apiClient";
import { ErrorState } from "../../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { useAppContext } from "../../../../../hooks/useAppContext";
import type { TenantDetail } from "../_components/tenantBillingConfigForms";
import { BillingPaymentMethodsSection } from "../_components/billingWorkspaceSections";

export default function AdminBillingMethodsPage() {
  return (
    <Suspense fallback={<LoadingSkeleton rows={4} />}>
      <AdminBillingMethodsBody />
    </Suspense>
  );
}

function AdminBillingMethodsBody() {
  const { can, backendJwtRole } = useAppContext();
  const searchParams = useSearchParams();
  const canAdmin = backendJwtRole === "SUPER_ADMIN" && can("can_view_admin_billing");
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const tenantId = String(searchParams.get("tenantId") || "").trim();

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError("");
    try {
      setDetail(await apiGet<TenantDetail>(`/admin/billing/platform/tenants/${id}`));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unable to load company.");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tenantId) void load(tenantId);
  }, [tenantId, load]);

  if (!canAdmin) {
    return <div className="state-box">Platform billing access required.</div>;
  }

  if (!tenantId) {
    return <p className="muted">Select a company from the rail.</p>;
  }

  return (
    <>
      {loading ? <LoadingSkeleton rows={4} /> : null}
      {error ? <ErrorState message={error} /> : null}
      {detail ? <BillingPaymentMethodsSection detail={detail} /> : null}
    </>
  );
}
