"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "../../../../../services/apiClient";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { ErrorState } from "../../../../../components/ErrorState";
import { useAppContext } from "../../../../../hooks/useAppContext";
import {
  ADMIN_BILLING_TENANT_SESSION_KEY,
  BILLING_SECTION_QUERY,
  mergeSearchParams,
  OPS_TAB_QUERY,
  type AdminOpsTab,
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

type WorkspaceLinkKey =
  | "summary"
  | "invoices"
  | "payments"
  | "methods"
  | "plans"
  | "collections"
  | "tax"
  | "gateway"
  | "activity";

/** Values for the compact workspace `<select>` (E2E + deploy verification). */
export type BillingWorkspaceNavValue =
  | "overview"
  | "invoices"
  | "payments"
  | "reports"
  | "collections"
  | "payment-methods"
  | "pricing"
  | "dunning"
  | "taxes"
  | "gateway"
  | "activity"
  | "advanced";

function pathnameIsCatalog(pathname: string) {
  return pathname === "/admin/billing/plans" || pathname.startsWith("/admin/billing/plans/");
}

export function AdminBillingShell({ children }: { children: ReactNode }) {
  const { can, backendJwtRole, tenantId: globalTenantId, setTenantId, setAdminScope } = useAppContext();
  const pathname = usePathname() || "";
  const rawSearchParams = useSearchParams();
  const router = useRouter();
  const searchParamsMemo = useMemo(() => new URLSearchParams(rawSearchParams.toString()), [rawSearchParams]);

  const catalogMode = pathnameIsCatalog(pathname);
  const canAdmin = backendJwtRole === "SUPER_ADMIN" && can("can_view_admin_billing");

  const [tenants, setTenants] = useState<TenantWorkspaceRow[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(canAdmin);
  const [tenantsError, setTenantsError] = useState("");
  const [comboOpen, setComboOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const comboRef = useRef<HTMLDivElement>(null);
  const [sessionStoredId, setSessionStoredId] = useState("");
  const [locHash, setLocHash] = useState("");

  const urlTenantId = String(rawSearchParams.get("tenantId") || "").trim();

  useEffect(() => {
    try {
      setSessionStoredId(sessionStorage.getItem(ADMIN_BILLING_TENANT_SESSION_KEY) || "");
    } catch {
      setSessionStoredId("");
    }
  }, []);

  useEffect(() => {
    const sync = () => setLocHash(typeof window !== "undefined" ? window.location.hash : "");
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    setLocHash(typeof window !== "undefined" ? window.location.hash : "");
  }, [pathname]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!comboRef.current?.contains(e.target as Node)) setComboOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
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
    if (pathname !== "/admin/billing" && pathname !== "/admin/billing/settings" && pathname !== "/admin/billing/invoices")
      return;
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
    setAdminScope("TENANT");
    setTenantId(effectiveTenantId);
  }, [canAdmin, effectiveTenantId, setTenantId, setAdminScope]);

  function selectTenant(id: string) {
    try {
      sessionStorage.setItem(ADMIN_BILLING_TENANT_SESSION_KEY, id);
    } catch {
      /* ignore */
    }
    setAdminScope("TENANT");
    setTenantId(id);
    if (pathnameIsCatalog(pathname)) {
      router.push(`/admin/billing?tenantId=${encodeURIComponent(id)}`);
      return;
    }
    const next = mergeSearchParams(searchParamsMemo, { tenantId: id });
    router.push(`${pathname}${next}`);
    setComboOpen(false);
    setFilter("");
  }

  const filteredTenants = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter((t) => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
  }, [tenants, filter]);

  const selectedRow = tenants.find((t) => t.id === effectiveTenantId);
  const selectedName = selectedRow?.name || "Company";
  const toolbarWorst = selectedRow ? worstNonTerminalInvoiceStatus(selectedRow.invoices) : "—";
  const toolbarChipClass =
    toolbarWorst === "—" ? "good" : toolbarWorst === "FAILED" ? "bad" : toolbarWorst === "OVERDUE" ? "bad" : "warn";
  const toolbarStanding = adminTenantStandingHeadline(toolbarWorst);
  const toolbarBalance = dollars(Number(selectedRow?.balanceDueCents ?? 0));

  const billingSection =
    pathname === "/admin/billing/settings" ? rawSearchParams.get(BILLING_SECTION_QUERY) || "plans-pricing" : "";

  const activeOpsTab: AdminOpsTab | null =
    pathname === "/admin/billing/invoices"
      ? (rawSearchParams.get(OPS_TAB_QUERY) as AdminOpsTab | null) || "invoices"
      : null;

  const currentNavKey = useMemo((): BillingWorkspaceNavValue => {
    if (catalogMode) return "overview";
    if (pathname === "/admin/billing/invoices") {
      const tab = activeOpsTab || "invoices";
      if (tab === "transactions") return "payments";
      if (tab === "reports") return "reports";
      if (tab === "collections") return "collections";
      return "invoices";
    }
    if (pathname === "/admin/billing/settings") {
      if (billingSection === "tax-billing") return "taxes";
      if (billingSection === "gateway") return "gateway";
      if (billingSection === "collections") return "dunning";
      if (billingSection === "preview" || billingSection === "pricing-explanation") return "advanced";
      return "pricing";
    }
    if (pathname === "/admin/billing") {
      if (locHash === "#payment-methods") return "payment-methods";
      if (locHash === "#recent-activity") return "activity";
      return "overview";
    }
    return "overview";
  }, [catalogMode, pathname, activeOpsTab, billingSection, locHash]);

  const workspaceHref = useMemo(() => {
    function build(tid: string): Record<WorkspaceLinkKey, string> {
      return {
        summary: `/admin/billing${mergeSearchParams(new URLSearchParams(), { tenantId: tid })}`,
        invoices: `/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [OPS_TAB_QUERY]: "invoices" })}`,
        payments: `/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [OPS_TAB_QUERY]: "transactions" })}`,
        methods: `/admin/billing${mergeSearchParams(new URLSearchParams(), { tenantId: tid })}#payment-methods`,
        plans: `/admin/billing/settings${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [BILLING_SECTION_QUERY]: "plans-pricing" })}`,
        collections: `/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [OPS_TAB_QUERY]: "collections" })}`,
        tax: `/admin/billing/settings${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [BILLING_SECTION_QUERY]: "tax-billing" })}`,
        gateway: `/admin/billing/settings${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [BILLING_SECTION_QUERY]: "gateway" })}`,
        activity: `/admin/billing${mergeSearchParams(new URLSearchParams(), { tenantId: tid })}#recent-activity`,
      };
    }
    return build;
  }, []);

  function pushWorkspaceNav(key: BillingWorkspaceNavValue) {
    const tid = effectiveTenantId;
    if (!tid) return;
    switch (key) {
      case "overview":
        router.push(`/admin/billing${mergeSearchParams(new URLSearchParams(), { tenantId: tid })}`);
        break;
      case "invoices":
        router.push(`/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [OPS_TAB_QUERY]: "invoices" })}`);
        break;
      case "payments":
        router.push(`/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [OPS_TAB_QUERY]: "transactions" })}`);
        break;
      case "reports":
        router.push(`/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [OPS_TAB_QUERY]: "reports" })}`);
        break;
      case "collections":
        router.push(`/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [OPS_TAB_QUERY]: "collections" })}`);
        break;
      case "payment-methods":
        router.push(`/admin/billing${mergeSearchParams(new URLSearchParams(), { tenantId: tid })}#payment-methods`);
        break;
      case "pricing":
        router.push(`/admin/billing/settings${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [BILLING_SECTION_QUERY]: "plans-pricing" })}`);
        break;
      case "dunning":
        router.push(`/admin/billing/settings${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [BILLING_SECTION_QUERY]: "collections" })}`);
        break;
      case "taxes":
        router.push(`/admin/billing/settings${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [BILLING_SECTION_QUERY]: "tax-billing" })}`);
        break;
      case "gateway":
        router.push(`/admin/billing/settings${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [BILLING_SECTION_QUERY]: "gateway" })}`);
        break;
      case "activity":
        router.push(`/admin/billing${mergeSearchParams(new URLSearchParams(), { tenantId: tid })}#recent-activity`);
        break;
      case "advanced":
        router.push(`/admin/billing/settings${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [BILLING_SECTION_QUERY]: "preview" })}`);
        break;
      default:
        break;
    }
  }

  if (!canAdmin) {
    return <>{children}</>;
  }

  return (
    <div
      className="admin-billing-phase2-root stack compact-stack billing-admin-shell billing-p5-scope billing-p6-scope"
      style={{ maxWidth: 1320, margin: "0 auto", paddingBottom: 24 }}
    >
      <header className="panel admin-billing-shell-header billing-p6-shell-header" style={{ position: "sticky", top: 8, zIndex: 40 }}>
        <div className="billing-p6-header-row">
          <div>
            <h1>{catalogMode ? "Billing plan catalog" : "Billing"}</h1>
            <p>
              {catalogMode ? (
                <>Edits apply to future invoices across companies. Pick a company below to return to operational work.</>
              ) : (
                <>One company at a time — use the menu to switch sections without losing context.</>
              )}
            </p>
          </div>

          {!catalogMode ? (
            <div ref={comboRef} style={{ position: "relative", minWidth: 220, flex: "1 1 200px", maxWidth: 360 }}>
              <label
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "var(--muted)",
                }}
              >
                Company
              </label>
              <input type="hidden" data-testid="billing-admin-tenant-select" name="adminBillingTenantId" value={effectiveTenantId} readOnly tabIndex={-1} aria-hidden />
              <button
                type="button"
                className="input"
                aria-expanded={comboOpen}
                disabled={tenantsLoading || tenants.length === 0}
                onClick={() => setComboOpen((o) => !o)}
                style={{
                  marginTop: 4,
                  width: "100%",
                  textAlign: "left",
                  cursor: tenants.length ? "pointer" : "not-allowed",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  borderRadius: 10,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedName}</span>
                <span aria-hidden style={{ opacity: 0.5 }}>
                  ▾
                </span>
              </button>
              {comboOpen ? (
                <div
                  className="panel"
                  role="listbox"
                  style={{
                    position: "absolute",
                    top: "100%",
                    marginTop: 4,
                    right: 0,
                    left: 0,
                    maxHeight: 304,
                    overflow: "hidden",
                    zIndex: 50,
                    padding: "8px 0",
                    borderRadius: 12,
                  }}
                >
                  <input
                    className="input"
                    aria-label="Search companies"
                    placeholder="Search companies…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    style={{ margin: "0 10px 8px", width: "calc(100% - 20px)", fontSize: 13, borderRadius: 8 }}
                    autoComplete="off"
                  />
                  <div style={{ maxHeight: 220, overflowY: "auto" }}>
                    {filteredTenants.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        role="option"
                        onClick={() => selectTenant(t.id)}
                        style={{
                          width: "100%",
                          padding: "8px 12px",
                          border: "none",
                          background: t.id === effectiveTenantId ? "var(--surface-alt, #f1f5f9)" : "transparent",
                          textAlign: "left",
                          cursor: "pointer",
                          fontSize: 13,
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>{t.name}</div>
                        <div style={{ fontSize: 11, color: "var(--muted)", wordBreak: "break-all", fontFamily: "ui-monospace, monospace" }}>{t.id}</div>
                      </button>
                    ))}
                    {filteredTenants.length === 0 ? (
                      <div className="muted" style={{ padding: "8px 12px", fontSize: 13 }}>
                        No matches.
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {!catalogMode && effectiveTenantId && selectedRow ? (
          <div className="billing-p6-compact-toolbar" aria-label="Company billing workspace">
            <div className="billing-p6-toolbar-meta">
              <span className="billing-p6-toolbar-company">{selectedRow.name}</span>
              <span className="billing-p6-toolbar-balance">Balance due {toolbarBalance}</span>
              <span className={`billing-p5-status-chip billing-p6-toolbar-chip ${toolbarChipClass}`}>{toolbarStanding}</span>
            </div>
            <select
              className="input billing-p6-workspace-nav"
              data-testid="billing-admin-workspace-nav"
              aria-label="Billing workspace section"
              value={currentNavKey}
              onChange={(e) => {
                pushWorkspaceNav(e.target.value as BillingWorkspaceNavValue);
              }}
            >
              <option value="overview">Overview</option>
              <option value="invoices">Invoices</option>
              <option value="payments">Payments</option>
              <option value="reports">Reports</option>
              <option value="collections">Collections</option>
              <option value="payment-methods">Payment methods</option>
              <option value="pricing">Pricing</option>
              <option value="dunning">Dunning &amp; automation</option>
              <option value="taxes">Taxes</option>
              <option value="gateway">Gateway</option>
              <option value="activity">Activity</option>
              <option value="advanced">Preview &amp; diagnostics</option>
            </select>
            <div className="billing-p6-toolbar-actions">
              <Link className="btn ghost" href="/admin/billing/plans">
                Plan catalog
              </Link>
              <Link className="btn ghost" href={workspaceHref(effectiveTenantId).collections}>
                Invoice holds
              </Link>
            </div>
          </div>
        ) : null}

        {catalogMode && (
          <nav style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border, #e5e7eb)" }}>
            <Link
              href={effectiveTenantId ? `/admin/billing?tenantId=${encodeURIComponent(effectiveTenantId)}` : "/admin/billing"}
              className="btn ghost"
              style={{ fontSize: 13 }}
            >
              ← Back to company billing
            </Link>
          </nav>
        )}

        {tenantsLoading ? (
          <div style={{ marginTop: 10 }}>
            <LoadingSkeleton rows={1} />
          </div>
        ) : null}
        {tenantsError ? (
          <div style={{ marginTop: 10 }}>
            <ErrorState message={tenantsError} />
          </div>
        ) : null}
        {!catalogMode && !tenantsLoading && tenants.length === 0 ? (
          <p className="muted" style={{ marginTop: 10, marginBottom: 0, fontSize: 13 }}>
            No billable companies found yet.
          </p>
        ) : null}
      </header>

      <section className="admin-billing-shell-content">{children}</section>
    </div>
  );
}
