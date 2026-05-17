"use client";

import Link from "next/link";
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
  // NOTE: we read globalTenantId only as a fallback hint for initial tenant
  // selection. We intentionally do NOT call setTenantId here: the billing
  // admin workspace manages its own tenant selection and writing back to the
  // global context caused an oscillation loop with useAppContext's reset
  // guard (which resets tenantId when it's not in the switcher list).
  const { can, backendJwtRole, tenantId: globalTenantId } = useAppContext();
  const pathname = usePathname() || "";
  const rawSearchParams = useSearchParams();
  const router = useRouter();
  const searchParamsMemo = useMemo(() => new URLSearchParams(rawSearchParams.toString()), [rawSearchParams]);

  const catalogMode = pathnameIsCatalog(pathname);
  const canAdmin = backendJwtRole === "SUPER_ADMIN" && can("can_view_admin_billing");

  const [tenants, setTenants] = useState<TenantWorkspaceRow[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(canAdmin);
  const [tenantsError, setTenantsError] = useState("");
  const [filter, setFilter] = useState("");
  const [sessionStoredId, setSessionStoredId] = useState("");
  const urlTenantId = String(rawSearchParams.get("tenantId") || "").trim();

  useEffect(() => {
    try {
      setSessionStoredId(sessionStorage.getItem(ADMIN_BILLING_TENANT_SESSION_KEY) || "");
    } catch {
      setSessionStoredId("");
    }
  }, []);

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

  const effectiveTenantId = useMemo(() => {
    if (urlTenantId && tenants.some((t) => t.id === urlTenantId)) return urlTenantId;
    if (sessionStoredId && tenants.some((t) => t.id === sessionStoredId)) return sessionStoredId;
    if (globalTenantId && tenants.some((t) => t.id === globalTenantId)) return globalTenantId;
    return tenants[0]?.id || "";
  }, [urlTenantId, tenants, sessionStoredId, globalTenantId]);

  useEffect(() => {
    if (!canAdmin || catalogMode || !effectiveTenantId) return;
    if (!BILLING_TENANT_PATHS.includes(pathname)) return;
    const inList = tenants.some((t) => t.id === urlTenantId);
    if (!urlTenantId || !inList) {
      const next = mergeSearchParams(searchParamsMemo, { tenantId: effectiveTenantId });
      router.replace(`${pathname}${next}`, { scroll: false });
    }
  }, [canAdmin, catalogMode, effectiveTenantId, urlTenantId, tenants, pathname, router, searchParamsMemo]);

  useEffect(() => {
    if (!canAdmin || !effectiveTenantId) return;
    try {
      sessionStorage.setItem(ADMIN_BILLING_TENANT_SESSION_KEY, effectiveTenantId);
    } catch {
      /* ignore */
    }
    // Do NOT call setTenantId / setAdminScope here. Writing the billing
    // tenant selection back to the global AppContext caused an infinite
    // oscillation: useAppContext resets tenantId when it's not in the
    // super-admin switcher list, which in turn re-fires this effect.
  }, [canAdmin, effectiveTenantId]);

  function selectTenant(id: string) {
    try {
      sessionStorage.setItem(ADMIN_BILLING_TENANT_SESSION_KEY, id);
    } catch {
      /* ignore */
    }
    if (pathnameIsCatalog(pathname)) {
      router.push(`/admin/billing?tenantId=${encodeURIComponent(id)}`);
      return;
    }
    const next = mergeSearchParams(searchParamsMemo, { tenantId: id });
    router.push(`${pathname}${next}`);
    setFilter("");
  }

  const filteredTenants = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter((t) => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
  }, [tenants, filter]);

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
    if (!tid) return;
    switch (key) {
      case "overview":
        router.push(`/admin/billing${mergeSearchParams(new URLSearchParams(), { tenantId: tid })}`);
        break;
      case "invoices":
        router.push(`/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: tid })}`);
        break;
      case "payments":
        router.push(`/admin/billing/payments${mergeSearchParams(new URLSearchParams(), { tenantId: tid })}`);
        break;
      case "reports":
        router.push(`/admin/billing/reports${mergeSearchParams(new URLSearchParams(), { tenantId: tid })}`);
        break;
      case "collections":
        router.push(`/admin/billing/collections${mergeSearchParams(new URLSearchParams(), { tenantId: tid })}`);
        break;
      case "payment-methods":
        router.push(`/admin/billing/methods${mergeSearchParams(new URLSearchParams(), { tenantId: tid })}`);
        break;
      case "pricing":
        router.push(`/admin/billing/settings${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [BILLING_SECTION_QUERY]: "plans-pricing" })}`);
        break;
      case "taxes":
        router.push(`/admin/billing/settings${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [BILLING_SECTION_QUERY]: "tax-billing" })}`);
        break;
      case "activity":
        router.push(`/admin/billing/activity${mergeSearchParams(new URLSearchParams(), { tenantId: tid })}`);
        break;
      default:
        break;
    }
  }

  if (!canAdmin) {
    return <>{children}</>;
  }

  return (
    <div className="billing-ws-shell billing-ws-scope billing-p5-scope billing-p8-scope" data-testid="billing-admin-workspace-root">
      <input type="hidden" data-testid="billing-admin-tenant-select" name="adminBillingTenantId" value={effectiveTenantId} readOnly tabIndex={-1} aria-hidden />
      <div className="billing-ws-split">
        <aside className="billing-ws-rail" aria-label="Companies">
          <div className="billing-ws-rail-head">
            <label htmlFor="billing-ws-rail-search">Companies</label>
            <input
              id="billing-ws-rail-search"
              className="input billing-ws-rail-search"
              placeholder="Search…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="billing-ws-rail-scroll custom-scrollbar">
            {tenantsLoading ? <LoadingSkeleton rows={4} /> : null}
            {tenantsError ? <ErrorState message={tenantsError} /> : null}
            {!tenantsLoading && filteredTenants.length === 0 ? (
              <p className="muted" style={{ padding: 8, fontSize: 12, margin: 0 }}>No matches.</p>
            ) : null}
            {filteredTenants.map((t) => {
              const w = worstNonTerminalInvoiceStatus(t.invoices);
              const hasCard = (t.paymentMethods || []).length > 0;
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`billing-ws-rail-item ${t.id === effectiveTenantId ? "active" : ""}`}
                  onClick={() => selectTenant(t.id)}
                >
                  <strong>{t.name}</strong>
                  <small>
                    {dollars(t.balanceDueCents ?? 0)} due
                    {w !== "—" ? ` · ${adminTenantStandingHeadline(w)}` : ""}
                    {!hasCard ? " · No card" : ""}
                  </small>
                </button>
              );
            })}
          </div>
        </aside>
        <div className="billing-ws-main">
          {effectiveTenantId && selectedRow ? (
            <div className="billing-ws-toolbar" aria-label="Billing workspace">
              <div className="billing-ws-toolbar-meta">
                <span className="billing-ws-toolbar-name">{selectedRow.name}</span>
                <span className="billing-ws-toolbar-balance">{toolbarBalance} due</span>
                <span className={`billing-p5-status-chip billing-ws-toolbar-chip ${toolbarChipClass}`}>{toolbarStanding}</span>
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
          <div className="billing-ws-main-scroll billing-ws-scope custom-scrollbar">{children}</div>
        </div>
      </div>
    </div>
  );
}
