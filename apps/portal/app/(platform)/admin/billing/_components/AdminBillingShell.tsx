"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "../../../../../services/apiClient";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { ErrorState } from "../../../../../components/ErrorState";
import { useAppContext } from "../../../../../hooks/useAppContext";
import {
  ADMIN_BILLING_TENANT_SESSION_KEY,
  BILLING_SECTION_QUERY,
  mergeSearchParams,
} from "./adminBillingLinks";
import { adminTenantStandingHeadline, dollars, worstNonTerminalInvoiceStatus } from "../../../../../lib/billingUi";
import { useAdminBillingTenant } from "./useAdminBillingTenant";

export type TenantWorkspaceRow = {
  id: string;
  name: string;
  balanceDueCents?: number;
  invoices?: any[];
  paymentMethods?: any[];
  billingSettings?: { autoBillingEnabled?: boolean; billingDayOfMonth?: number } | null;
};

/** @deprecated use TenantWorkspaceRow */
export type TenantOption = TenantWorkspaceRow;

/** Values for the compact workspace `<select>` (E2E + deploy verification). */
export type BillingWorkspaceNavValue =
  | "overview"
  | "invoices"
  | "payments"
  | "reports"
  | "collections"
  | "payment-methods"
  | "pricing"
  | "taxes"
  | "activity";

const BILLING_TENANT_PATHS = [
  "/admin/billing",
  "/admin/billing/settings",
  "/admin/billing/invoices",
  "/admin/billing/payments",
  "/admin/billing/collections",
  "/admin/billing/reports",
  "/admin/billing/methods",
  "/admin/billing/activity",
  "/admin/billing/plans",
  "/admin/billing/sola-imports",
];

function pathnameIsCatalog(pathname: string) {
  return pathname === "/admin/billing/plans" || pathname.startsWith("/admin/billing/plans/");
}

const WORKSPACE_SEG: Array<{ key: BillingWorkspaceNavValue; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "invoices", label: "Invoices" },
  { key: "payments", label: "Payments" },
  { key: "payment-methods", label: "Methods" },
  { key: "pricing", label: "Pricing" },
  { key: "collections", label: "Collections" },
  { key: "taxes", label: "Taxes" },
  { key: "activity", label: "Activity" },
  { key: "reports", label: "Reports" },
];

function WorkspaceSegButton({
  navKey,
  label,
  active,
  onSelect,
}: {
  navKey: BillingWorkspaceNavValue;
  label: string;
  active: boolean;
  onSelect: (key: BillingWorkspaceNavValue) => void;
}) {
  return (
    <button
      type="button"
      className={active ? "active" : ""}
      data-testid={`billing-admin-ws-nav-${navKey}`}
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(navKey)}
    >
      {label}
    </button>
  );
}

export function AdminBillingShell({ children }: { children: ReactNode }) {
  const { can, backendJwtRole } = useAppContext();
  const pathname = usePathname() || "";
  const rawSearchParams = useSearchParams();
  const router = useRouter();
  const searchParamsMemo = useMemo(() => new URLSearchParams(rawSearchParams.toString()), [rawSearchParams]);

  const catalogMode = pathnameIsCatalog(pathname);
  const canAdmin = backendJwtRole === "SUPER_ADMIN" && can("can_view_admin_billing");

  const [tenants, setTenants] = useState<TenantWorkspaceRow[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(canAdmin);
  const [tenantsError, setTenantsError] = useState("");

  const tenantIds = useMemo(() => tenants.map((t) => t.id), [tenants]);
  const { effectiveTenantId, isGlobalScope, displayName, urlTenantId } = useAdminBillingTenant(tenantIds);

  const loadTenants = useCallback(async () => {
    if (!canAdmin) return;
    setTenantsLoading(true);
    setTenantsError("");
    try {
      const rows = await apiGet<TenantWorkspaceRow[]>("/admin/billing/platform/tenants");
      setTenants(rows);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Could not load companies.";
      setTenantsError(msg);
      setTenants([]);
    } finally {
      setTenantsLoading(false);
    }
  }, [canAdmin]);

  useEffect(() => {
    void loadTenants();
  }, [loadTenants]);

  // Keep ?tenantId= aligned with global workspace (deep links still win via hook).
  useEffect(() => {
    if (!canAdmin || catalogMode) return;
    if (!BILLING_TENANT_PATHS.includes(pathname)) return;

    if (isGlobalScope || !effectiveTenantId) return;

    const inList = tenants.some((t) => t.id === urlTenantId);
    if (!urlTenantId || !inList || urlTenantId !== effectiveTenantId) {
      const next = mergeSearchParams(searchParamsMemo, { tenantId: effectiveTenantId });
      router.replace(`${pathname}${next}`, { scroll: false });
    }
  }, [
    canAdmin,
    catalogMode,
    effectiveTenantId,
    isGlobalScope,
    urlTenantId,
    tenants,
    pathname,
    router,
    searchParamsMemo,
  ]);

  useEffect(() => {
    if (!canAdmin || !effectiveTenantId) return;
    try {
      sessionStorage.setItem(ADMIN_BILLING_TENANT_SESSION_KEY, effectiveTenantId);
    } catch {
      /* ignore */
    }
  }, [canAdmin, effectiveTenantId]);

  const selectedRow = tenants.find((t) => t.id === effectiveTenantId);
  const toolbarWorst = selectedRow ? worstNonTerminalInvoiceStatus(selectedRow.invoices) : "—";
  const toolbarChipClass =
    toolbarWorst === "—" ? "good" : toolbarWorst === "FAILED" ? "bad" : toolbarWorst === "OVERDUE" ? "bad" : "warn";
  const toolbarStanding = adminTenantStandingHeadline(toolbarWorst);
  const toolbarBalance = dollars(Number(selectedRow?.balanceDueCents ?? 0));

  const billingSection =
    pathname === "/admin/billing/settings" ? rawSearchParams.get(BILLING_SECTION_QUERY) || "plans-pricing" : "";

  const currentNavKey = useMemo((): BillingWorkspaceNavValue => {
    if (pathname === "/admin/billing/invoices") return "invoices";
    if (pathname === "/admin/billing/payments") return "payments";
    if (pathname === "/admin/billing/reports") return "reports";
    if (pathname === "/admin/billing/collections") return "collections";
    if (pathname === "/admin/billing/methods") return "payment-methods";
    if (pathname === "/admin/billing/activity") return "activity";
    if (pathname === "/admin/billing/settings") {
      if (billingSection === "tax-billing") return "taxes";
      return "pricing";
    }
    if (pathname === "/admin/billing/plans" || catalogMode) return "pricing";
    return "overview";
  }, [catalogMode, pathname, billingSection]);

  function pushWorkspaceNav(key: BillingWorkspaceNavValue) {
    const tid = effectiveTenantId;
    const tenantQ = tid ? { tenantId: tid } : {};
    switch (key) {
      case "overview":
        router.push(`/admin/billing${mergeSearchParams(new URLSearchParams(), tenantQ)}`);
        break;
      case "invoices":
        router.push(`/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), tenantQ)}`);
        break;
      case "payments":
        router.push(`/admin/billing/payments${mergeSearchParams(new URLSearchParams(), tenantQ)}`);
        break;
      case "reports":
        router.push(`/admin/billing/reports${mergeSearchParams(new URLSearchParams(), tenantQ)}`);
        break;
      case "collections":
        router.push(`/admin/billing/collections${mergeSearchParams(new URLSearchParams(), tenantQ)}`);
        break;
      case "payment-methods":
        router.push(`/admin/billing/methods${mergeSearchParams(new URLSearchParams(), tenantQ)}`);
        break;
      case "pricing":
        router.push(
          `/admin/billing/settings${mergeSearchParams(new URLSearchParams(), {
            ...tenantQ,
            [BILLING_SECTION_QUERY]: "plans-pricing",
          })}`,
        );
        break;
      case "taxes":
        router.push(
          `/admin/billing/settings${mergeSearchParams(new URLSearchParams(), {
            ...tenantQ,
            [BILLING_SECTION_QUERY]: "tax-billing",
          })}`,
        );
        break;
      case "activity":
        router.push(`/admin/billing/activity${mergeSearchParams(new URLSearchParams(), tenantQ)}`);
        break;
      default:
        break;
    }
  }

  if (!canAdmin) {
    return <>{children}</>;
  }

  const showToolbar = !tenantsLoading && !tenantsError;
  const toolbarLabel = selectedRow?.name || displayName;
  const shellClass = [
    "billing-ws-shell",
    "billing-ws-scope",
    "billing-p5-scope",
    "billing-p8-scope",
    "billing-ws-shell--context-wide",
    isGlobalScope && !effectiveTenantId ? "billing-ws-shell--all-tenants" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClass} data-testid="billing-admin-workspace-root">
      <input
        type="hidden"
        data-testid="billing-admin-tenant-select"
        name="adminBillingTenantId"
        value={effectiveTenantId}
        readOnly
        tabIndex={-1}
        aria-hidden
      />
      <div className="billing-ws-main billing-ws-main--wide">
        {showToolbar ? (
          <div className="billing-ws-toolbar" aria-label="Billing workspace">
            <div className="billing-ws-toolbar-meta">
              <span className="billing-ws-toolbar-name">{toolbarLabel}</span>
              {selectedRow ? (
                <>
                  <span className="billing-ws-toolbar-balance">{toolbarBalance} due</span>
                  <span className={`billing-p5-status-chip billing-ws-toolbar-chip ${toolbarChipClass}`}>
                    {toolbarStanding}
                  </span>
                </>
              ) : isGlobalScope ? (
                <span className="billing-p5-status-chip billing-ws-toolbar-chip good">Cross-tenant</span>
              ) : null}
            </div>
            <div className="billing-ws-seg-wrap" data-testid="billing-admin-workspace-nav">
              <div className="billing-ws-seg" role="tablist" aria-label="Workspace sections">
                {WORKSPACE_SEG.map((seg) => (
                  <WorkspaceSegButton
                    key={seg.key}
                    navKey={seg.key}
                    label={seg.label}
                    active={currentNavKey === seg.key}
                    onSelect={pushWorkspaceNav}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : null}
        {tenantsLoading ? (
          <div className="billing-ws-main-scroll billing-ws-scope custom-scrollbar" style={{ padding: 12 }}>
            <LoadingSkeleton rows={4} />
          </div>
        ) : tenantsError ? (
          <div className="billing-ws-main-scroll billing-ws-scope custom-scrollbar" style={{ padding: 12 }}>
            <ErrorState message={tenantsError} />
          </div>
        ) : (
          <div className="billing-ws-main-scroll billing-ws-scope custom-scrollbar">{children}</div>
        )}
      </div>
    </div>
  );
}