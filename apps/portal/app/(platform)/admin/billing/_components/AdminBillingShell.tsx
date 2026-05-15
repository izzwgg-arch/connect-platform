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

export type TenantOption = { id: string; name: string };

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

  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(canAdmin);
  const [tenantsError, setTenantsError] = useState("");
  const [comboOpen, setComboOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const comboRef = useRef<HTMLDivElement>(null);
  const [sessionStoredId, setSessionStoredId] = useState("");

  const urlTenantId = String(rawSearchParams.get("tenantId") || "").trim();

  useEffect(() => {
    try {
      setSessionStoredId(sessionStorage.getItem(ADMIN_BILLING_TENANT_SESSION_KEY) || "");
    } catch {
      setSessionStoredId("");
    }
  }, []);

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
      const rows = await apiGet<Array<{ id: string; name: string }>>("/admin/billing/platform/tenants");
      setTenants(rows.map((r) => ({ id: r.id, name: r.name })));
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

  const selectedName = tenants.find((t) => t.id === effectiveTenantId)?.name || "Company";

  const billingSection =
    pathname === "/admin/billing/settings" ? rawSearchParams.get(BILLING_SECTION_QUERY) || "plans-pricing" : "";

  const activeOpsTab: AdminOpsTab | null =
    pathname === "/admin/billing/invoices"
      ? (rawSearchParams.get(OPS_TAB_QUERY) as AdminOpsTab | null) || "invoices"
      : null;

  const isInvoicesPage = pathname === "/admin/billing/invoices";

  const workspaceHref = useMemo(() => {
    function build(tid: string): Record<WorkspaceLinkKey, string> {
      const base = mergeSearchParams(new URLSearchParams(), { tenantId: tid });
      return {
        summary: `/admin/billing${base}`,
        invoices: `/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [OPS_TAB_QUERY]: "invoices" })}`,
        payments: `/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [OPS_TAB_QUERY]: "transactions" })}`,
        methods: `/admin/billing${mergeSearchParams(new URLSearchParams(), { tenantId: tid })}#payment-methods`,
        plans: `/admin/billing/settings${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [BILLING_SECTION_QUERY]: "plans-pricing" })}`,
        collections: `/admin/billing/settings${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [BILLING_SECTION_QUERY]: "collections" })}`,
        tax: `/admin/billing/settings${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [BILLING_SECTION_QUERY]: "tax-billing" })}`,
        gateway: `/admin/billing/settings${mergeSearchParams(new URLSearchParams(), { tenantId: tid, [BILLING_SECTION_QUERY]: "gateway" })}`,
        activity: `/admin/billing${mergeSearchParams(new URLSearchParams(), { tenantId: tid })}#recent-activity`,
      };
    }
    return build;
  }, []);

  function tabActive(label: string): boolean {
    if (catalogMode) return false;
    switch (label) {
      case "Summary":
        return pathname === "/admin/billing";
      case "Invoices":
        return isInvoicesPage && activeOpsTab === "invoices";
      case "Payments":
        return isInvoicesPage && activeOpsTab === "transactions";
      case "Payment methods":
      case "Activity":
        return false;
      case "Plans & pricing":
        return pathname === "/admin/billing/settings" &&
          ["plans-pricing", "preview", "pricing-explanation"].includes(billingSection);
      case "Collections":
        return pathname === "/admin/billing/settings" && billingSection === "collections";
      case "Tax & billing details":
        return pathname === "/admin/billing/settings" && billingSection === "tax-billing";
      case "Payment gateway":
        return pathname === "/admin/billing/settings" && billingSection === "gateway";
      default:
        return false;
    }
  }

  const wsLinks: Array<[string, WorkspaceLinkKey]> = [
    ["Summary", "summary"],
    ["Invoices", "invoices"],
    ["Payments", "payments"],
    ["Payment methods", "methods"],
    ["Plans & pricing", "plans"],
    ["Collections", "collections"],
    ["Tax & billing details", "tax"],
    ["Payment gateway", "gateway"],
    ["Activity", "activity"],
  ];

  if (!canAdmin) {
    return <>{children}</>;
  }

  return (
    <div className="admin-billing-phase2-root stack compact-stack billing-admin-shell" style={{ maxWidth: 1320, margin: "0 auto", paddingBottom: 32 }}>
      <header
        className="panel admin-billing-shell-header"
        style={{ position: "sticky", top: 8, zIndex: 40, padding: "16px 20px", borderRadius: 14 }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}>
          <div>
            <h1 style={{ margin: "0 0 4px", fontSize: "1.35rem", fontWeight: 700, letterSpacing: "-0.02em" }}>Admin Billing</h1>
            <p style={{ margin: 0, fontSize: 13, color: "var(--muted, #64748b)", maxWidth: 580 }}>
              {catalogMode ? (
                <>Platform catalog — edits affect future invoicing.</>
              ) : (
                <>
                  Managing <strong style={{ color: "var(--text-primary)" }}>{selectedName}</strong>. Use the workspace tabs to move without losing this
                  company.
                </>
              )}
            </p>
          </div>

          {!catalogMode && (
            <div ref={comboRef} style={{ position: "relative", minWidth: 240, flex: "1 1 220px", maxWidth: 380 }}>
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
              <button
                type="button"
                className="input"
                aria-expanded={comboOpen}
                disabled={tenantsLoading || tenants.length === 0}
                onClick={() => setComboOpen((o) => !o)}
                style={{
                  marginTop: 6,
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
          )}
        </div>

        <div className="admin-billing-command-row" style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", marginRight: 4 }}>Quick links</span>
          <Link className="btn ghost" style={{ fontSize: 13 }} href="/admin/billing">
            Platform overview
          </Link>
          <Link className="btn ghost" style={{ fontSize: 13 }} href={effectiveTenantId ? workspaceHref(effectiveTenantId).invoices : "/admin/billing/invoices"}>
            Invoices & payments
          </Link>
          <Link className="btn ghost" style={{ fontSize: 13 }} href={effectiveTenantId ? workspaceHref(effectiveTenantId).plans : "/admin/billing/settings"}>
            Company settings
          </Link>
          <Link className="btn ghost" style={{ fontSize: 13 }} href="/admin/billing/plans">
            Billing plans (catalog)
          </Link>
        </div>

        {!catalogMode && effectiveTenantId ? (
          <nav
            aria-label="Company billing workspace"
            style={{
              marginTop: 16,
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              borderTop: "1px solid var(--border, #e5e7eb)",
              paddingTop: 14,
            }}
          >
            {wsLinks.map(([label, key]) => {
              const active = tabActive(label);
              return (
                <Link
                  key={label}
                  href={workspaceHref(effectiveTenantId)[key]}
                  scroll={false}
                  className={`admin-billing-ws-tab ${active ? "admin-billing-ws-tab-active" : ""}`}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 999,
                    fontSize: 13,
                    fontWeight: active ? 600 : 500,
                    textDecoration: "none",
                    border: active ? "1px solid var(--accent, #2563eb)" : "1px solid transparent",
                    background:
                      active
                        ? "color-mix(in srgb, var(--accent, #2563eb) 12%, transparent)"
                        : "var(--surface-alt, #f8fafc)",
                    color: active ? "var(--accent, #2563eb)" : "var(--text-primary, inherit)",
                  }}
                >
                  {label}
                </Link>
              );
            })}
          </nav>
        ) : null}

        {catalogMode && (
          <nav style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border, #e5e7eb)" }}>
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
          <div style={{ marginTop: 14 }}>
            <LoadingSkeleton rows={1} />
          </div>
        ) : null}
        {tenantsError ? (
          <div style={{ marginTop: 12 }}>
            <ErrorState message={tenantsError} />
          </div>
        ) : null}
        {!catalogMode && !tenantsLoading && tenants.length === 0 ? (
          <p className="muted" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
            No billable companies found yet.
          </p>
        ) : null}
      </header>

      <section className="admin-billing-shell-content" style={{ marginTop: 12 }}>
        {children}
      </section>
    </div>
  );
}
