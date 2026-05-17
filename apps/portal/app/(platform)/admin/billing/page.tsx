"use client";

import Link from "next/link";
import {
  Banknote,
  CreditCard,
  FileText,
  Receipt,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import { useSearchParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { DataTable } from "../../../../components/DataTable";
import { DetailCard } from "../../../../components/DetailCard";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { BillingEmptyState } from "../../../../components/billing/BillingEmptyState";
import { useAppContext } from "../../../../hooks/useAppContext";
import {
  adminTenantStandingHeadline,
  dollars,
  formatDate,
  nextBillingSummary,
  invoiceStatusLabel,
  billingEventLabel,
  billingEventIcon,
  humanizeStoredPricingMode,
  worstNonTerminalInvoiceStatus,
} from "../../../../lib/billingUi";
import type { TenantDetail } from "./_components/tenantBillingConfigForms";
import { parseStoredPricingMode } from "./_components/tenantBillingConfigForms";
import { BILLING_SECTION_QUERY, mergeSearchParams, OPS_TAB_QUERY } from "./_components/adminBillingLinks";

type TenantRow = {
  id: string;
  name: string;
  balanceDueCents: number;
  billingSettings?: any;
  paymentMethods?: any[];
  invoices?: any[];
};

function readInvoiceCollectionsFlags(invoices: any[]) {
  let paused = 0;
  let doNotCharge = 0;
  for (const inv of invoices) {
    const root = inv?.metadata && typeof inv.metadata === "object" ? (inv.metadata as Record<string, unknown>) : {};
    const c = root.collections && typeof root.collections === "object" ? (root.collections as Record<string, unknown>) : {};
    if (c.paused) paused += 1;
    if (c.doNotCharge) doNotCharge += 1;
  }
  return { paused, doNotCharge };
}

export default function AdminBillingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can, backendJwtRole } = useAppContext();
  const canPlatformAdminBilling = backendJwtRole === "SUPER_ADMIN" && can("can_view_admin_billing");
  const [busy, setBusy] = useState<string | null>(null);
  const [fleetAck, setFleetAck] = useState(false);
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [platformToast, setPlatformToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const overview = useAsyncResource(() => apiGet<any>("/admin/billing/overview"), []);
  const runs = useAsyncResource(() => apiGet<{ runs: any[] }>("/admin/billing/runs/recent?limit=8"), []);
  const tenants = useAsyncResource<TenantRow[]>(() => apiGet<TenantRow[]>("/admin/billing/platform/tenants"), []);
  const tenantRows = tenants.status === "success" ? tenants.data : [];
  const tidParam = String(searchParams.get("tenantId") || "").trim();
  const selectedTenantId = useMemo(() => {
    if (tidParam && tenantRows.some((t) => t.id === tidParam)) return tidParam;
    return tenantRows[0]?.id || "";
  }, [tidParam, tenantRows]);
  const selectedTenant = tenantRows.find((tenant) => tenant.id === selectedTenantId) || tenantRows[0] || null;

  const loadDetail = useCallback(async (tenantId: string) => {
    if (!tenantId) return;
    setDetailLoading(true);
    setDetailError("");
    try {
      setDetail(await apiGet<TenantDetail>(`/admin/billing/platform/tenants/${tenantId}`));
    } catch (err: any) {
      setDetailError(err?.message || "Unable to load tenant billing detail.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedTenantId) void loadDetail(selectedTenantId);
  }, [loadDetail, selectedTenantId]);

  const projectedMrr = useMemo(() => {
    if (!detail?.preview) return 0;
    return Number(detail.preview.totalCents || 0);
  }, [detail]);

  async function runMonthly(dryRun: boolean) {
    setBusy(dryRun ? "dry-run" : "monthly");
    try {
      await apiPost("/admin/billing/runs/monthly", { dryRun });
      window.location.reload();
    } catch (err: any) {
      setPlatformToast({ kind: "err", text: err?.message || "Monthly run failed." });
      window.setTimeout(() => setPlatformToast(null), 5000);
    } finally {
      setBusy(null);
    }
  }

  if (!canPlatformAdminBilling) {
    return (
      <div className="state-box">
        Platform Admin Billing is only available to platform administrators (JWT role SUPER_ADMIN) with billing access. Tenant administrators should use{" "}
        <a href="/billing">Billing</a> for their own workspace.
      </div>
    );
  }

  const payState = selectedTenant ? worstNonTerminalInvoiceStatus(selectedTenant.invoices) : "—";
  const pricingMode = detail ? parseStoredPricingMode(detail.settings?.metadata) : "legacy";
  const expl = detail?.preview?.pricingPreviewExplanation as
    | { tenantOverridesDetected?: boolean; scheduledPlanSummary?: string | null; activePlanName?: string | null }
    | undefined;
  const planName =
    (detail?.settings?.billingPlan?.name as string | undefined) ||
    (expl?.activePlanName as string | undefined) ||
    "—";
  const colFlags = detail ? readInvoiceCollectionsFlags(detail.invoices || []) : { paused: 0, doNotCharge: 0 };
  const unpaidCount = detail ? (detail.invoices || []).filter((i: { status?: string }) => !["PAID", "VOID"].includes(String(i.status))).length : 0;
  const failedCount = detail ? (detail.invoices || []).filter((i: { status?: string }) => String(i.status) === "FAILED").length : 0;
  const nextBill = detail?.settings ? nextBillingSummary(detail.settings.billingDayOfMonth, !!detail.settings.autoBillingEnabled) : null;

  const primaryCollect =
    !!selectedTenant &&
    (Number(selectedTenant.balanceDueCents || 0) > 0 || payState === "FAILED" || payState === "OVERDUE");

  return (
    <div className="stack compact-stack billing-p5-scope billing-p6-scope billing-phase3">
      <p className="b3-muted" style={{ margin: "0 0 8px", maxWidth: 720, fontSize: 12, lineHeight: 1.45 }}>
        Fleet metrics cover every company; the rail and header toolbar scope actions to one account.
      </p>

      {platformToast ? (
        <div className={`billing-toast billing-toast--${platformToast.kind}`} style={{ position: "relative", bottom: "auto", right: "auto", maxWidth: "100%" }} role="status">
          {platformToast.text}
        </div>
      ) : null}

      {overview.status === "loading" || tenants.status === "loading" ? <LoadingSkeleton rows={4} /> : null}
      {overview.status === "error" ? <ErrorState message={overview.error} /> : null}
      {tenants.status === "error" ? <ErrorState message={tenants.error} /> : null}

      {overview.status === "success" ? (
        <div className="b3-fleet-strip">
          <div className="b3-fleet-metric">
            <small>Recurring (est.)</small>
            <strong>{dollars(overview.data.mrrCents)}</strong>
          </div>
          <div className="b3-fleet-metric">
            <small>Open balance</small>
            <strong>{dollars(overview.data.openCents)}</strong>
          </div>
          <div className="b3-fleet-metric">
            <small>Needs attention</small>
            <strong>{String(overview.data.counts?.failed || 0)}</strong>
          </div>
          <div className="b3-fleet-metric">
            <small>No card on file</small>
            <strong>{String(overview.data.counts?.tenantsWithoutCards || 0)}</strong>
          </div>
        </div>
      ) : null}

      {overview.status === "success" && (overview.data.recentFailures?.length > 0) ? (
        <DetailCard title="Invoices needing attention (fleet)">
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            Open a company above, then use <strong>Collect payment</strong> or <strong>View invoices</strong> for that account.
          </p>
          <DataTable
            rows={overview.data.recentFailures as any[]}
            columns={[
              { key: "t", label: "Company", render: (r) => r.tenantName || r.tenantId },
              { key: "inv", label: "Invoice", render: (r) => r.invoiceNumber || r.invoiceId },
              { key: "st", label: "Status", render: (r) => r.status },
              { key: "bal", label: "Balance", render: (r) => dollars(r.balanceDueCents) },
              { key: "fail", label: "Updated", render: (r) => (r.failedAt ? new Date(r.failedAt).toLocaleString() : "—") },
            ]}
          />
        </DetailCard>
      ) : null}

      {runs.status === "success" && runs.data.runs?.length ? (
        <details className="b3-details-muted">
          <summary>Recent platform billing runs</summary>
          <div className="billing-line-list">
            {runs.data.runs.map((run: any) => (
              <div key={run.id}>
                <span>
                  <strong>{run.dryRun ? "Dry run" : "Live run"}</strong>
                  <small>
                    {run.status} · {run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}
                    {run.tenantId ? ` · one company` : " · all companies"}
                  </small>
                </span>
                <strong>{run.finishedAt ? "Done" : "In progress"}</strong>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {runs.status === "error" ? <ErrorState message={runs.error} /> : null}

      <div className="billing-admin-grid">
        <aside className="billing-tenant-rail">
          <div className="billing-panel-head">
            <span>Companies</span>
            <strong>{tenantRows.length}</strong>
          </div>
          <div className="billing-tenant-list">
            {tenantRows.map((tenant) => {
              const active = tenant.id === selectedTenant?.id;
              const w = worstNonTerminalInvoiceStatus(tenant.invoices);
              const hasCard = (tenant.paymentMethods || []).length > 0;
              return (
                <button
                  key={tenant.id}
                  type="button"
                  className={`billing-tenant-item ${active ? "active" : ""}`}
                  onClick={() => router.push(`/admin/billing?tenantId=${encodeURIComponent(tenant.id)}`)}
                >
                  <span>
                    <strong>{tenant.name}</strong>
                    <small>
                      {w !== "—" ? `${adminTenantStandingHeadline(w)} · ` : ""}
                      {hasCard ? "Card on file" : "No card"}
                      {" · "}
                      {dollars(tenant.balanceDueCents || 0)} open
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="billing-tenant-workspace">
          {detailLoading ? <LoadingSkeleton rows={6} /> : null}
          {detailError ? <ErrorState message={detailError} /> : null}
          {detail ? (
            <>
              <p className="billing-p6-overview-meta muted" style={{ fontSize: 12, margin: "0 0 10px", lineHeight: 1.5 }}>
                <strong>{detail.tenant.name}</strong>
                {" · "}
                Projected {dollars(projectedMrr)}/mo
                {" · "}
                Plan {planName}
                {" · "}
                Autopay {detail.settings?.autoBillingEnabled ? `on (day ${detail.settings.billingDayOfMonth ?? "—"})` : "off"}
                {nextBill ? ` · ${nextBill}` : ""}
                {" · "}
                Cards {detail.paymentMethods?.length ? `${detail.paymentMethods.length} saved` : "none"}
              </p>

              <p className="b3-section-title">Quick actions</p>
              <div className="billing-p5-action-bar">
                <div className="billing-p5-action-bar__primary">
                  {primaryCollect ? (
                    <Link
                      className="btn primary"
                      href={`/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: detail.tenant.id, [OPS_TAB_QUERY]: "invoices" })}`}
                    >
                      Collect payment
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => document.getElementById("admin-generate-invoice")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                    >
                      Generate invoice
                    </button>
                  )}
                  <span className="muted" style={{ fontSize: 12, lineHeight: 1.35 }}>
                    {primaryCollect ? "Ledger, receipts, and manual captures live in Invoices & payments." : "When the account is current, generate the next cycle from usage below."}
                  </span>
                </div>
                <div className="billing-p5-action-bar__sep" aria-hidden />
                <div className="billing-p5-action-bar__groups">
                  <div className="billing-p5-action-bar__group">
                    {primaryCollect ? (
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => document.getElementById("admin-generate-invoice")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                      >
                        <FileText size={16} aria-hidden style={{ marginRight: 6, verticalAlign: "text-bottom" }} />
                        Generate invoice
                      </button>
                    ) : (
                      <Link
                        className="btn ghost"
                        href={`/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: detail.tenant.id, [OPS_TAB_QUERY]: "invoices" })}`}
                      >
                        <Banknote size={16} aria-hidden style={{ marginRight: 6, verticalAlign: "text-bottom" }} />
                        Collect payment
                      </Link>
                    )}
                    <Link
                      className="btn ghost"
                      href={`/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: detail.tenant.id, [OPS_TAB_QUERY]: "invoices" })}`}
                    >
                      <Receipt size={16} aria-hidden style={{ marginRight: 6, verticalAlign: "text-bottom" }} />
                      Open register
                    </Link>
                  </div>
                  <div className="billing-p5-action-bar__group">
                    <Link
                      className="btn ghost"
                      href={`/admin/billing/settings${mergeSearchParams(new URLSearchParams(), { tenantId: detail.tenant.id, [BILLING_SECTION_QUERY]: "plans-pricing" })}`}
                    >
                      <SlidersHorizontal size={16} aria-hidden style={{ marginRight: 6, verticalAlign: "text-bottom" }} />
                      Pricing &amp; plans
                    </Link>
                    <button type="button" className="btn ghost" onClick={() => document.getElementById("payment-methods")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                      <CreditCard size={16} aria-hidden style={{ marginRight: 6, verticalAlign: "text-bottom" }} />
                      Saved cards
                    </button>
                  </div>
                </div>
              </div>

              <p className="b3-section-title">Account health</p>
              <div className="b3-health-grid">
                <div className={`b3-health-card ${unpaidCount ? "b3-health-warn" : "b3-health-ok"}`}>
                  <h4>Unpaid invoices</h4>
                  <p>{unpaidCount ? `${unpaidCount} open — review payment or terms.` : "No open invoices for this company."}</p>
                </div>
                <div className={`b3-health-card ${failedCount ? "b3-health-bad" : "b3-health-ok"}`}>
                  <h4>Failed charges</h4>
                  <p>{failedCount ? `${failedCount} invoice(s) need a successful payment.` : "No failed payment state on recent invoices."}</p>
                </div>
                <div className={`b3-health-card ${colFlags.paused || colFlags.doNotCharge ? "b3-health-warn" : "b3-health-ok"}`}>
                  <h4>Collections</h4>
                  <p>
                    {colFlags.paused || colFlags.doNotCharge
                      ? "Some invoices have retries paused or auto-charge turned off. Review in Invoices → Collections."
                      : "No collection holds detected on this company’s open invoices."}
                  </p>
                </div>
                <div className={`b3-health-card ${!(detail.paymentMethods || []).length ? "b3-health-warn" : "b3-health-ok"}`}>
                  <h4>Payment method</h4>
                  <p>{!(detail.paymentMethods || []).length ? "No saved card — autopay cannot run until a card is added." : "At least one card is saved."}</p>
                </div>
                <div className={`b3-health-card ${pricingMode === "custom" || expl?.tenantOverridesDetected ? "b3-health-warn" : "b3-health-ok"}`}>
                  <h4>Pricing</h4>
                  <p>
                    {expl?.tenantOverridesDetected && pricingMode === "catalog"
                      ? "Row amounts differ from the active plan — invoices still follow the plan until you align or reset."
                      : pricingMode === "custom"
                        ? "Custom company pricing is active."
                        : "Pricing follows the standard rules for this company."}
                  </p>
                </div>
                <div className={`b3-health-card ${expl?.scheduledPlanSummary ? "b3-health-warn" : "b3-health-ok"}`}>
                  <h4>Scheduled plan change</h4>
                  <p>{expl?.scheduledPlanSummary || "No upcoming plan switch scheduled."}</p>
                </div>
              </div>

              <div id="payment-methods" style={{ scrollMarginTop: 72 }}>
                <PaymentMethodsCard detail={detail} />
              </div>

              <div id="admin-generate-invoice" style={{ scrollMarginTop: 72 }}>
                <InvoicePreviewCard detail={detail} setBusy={setBusy} busy={busy} onSaved={() => loadDetail(detail.tenant.id)} />
              </div>

              <div id="recent-activity" style={{ scrollMarginTop: 72 }}>
                <RecentActivityCard detail={detail} />
              </div>
            </>
          ) : null}
        </main>
      </div>

      <details className="b3-details-muted">
        <summary>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Wallet size={16} aria-hidden />
            Platform billing run (all companies)
          </span>
        </summary>
        <p className="b3-muted" style={{ marginTop: 0 }}>
          Runs the monthly job for <strong>every</strong> company. Prefer generating a single invoice above unless you intend a fleet-wide cycle.
        </p>
        <label className="b3-muted" style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 10, fontSize: 13, cursor: "pointer", maxWidth: 520 }}>
          <input type="checkbox" checked={fleetAck} onChange={(e) => setFleetAck(e.target.checked)} style={{ marginTop: 2 }} />
          <span>I understand this live run affects every company and is not limited to the account in the toolbar.</span>
        </label>
        <div className="row-actions">
          <button className="btn ghost" type="button" disabled={!!busy} onClick={() => runMonthly(true)}>
            {busy === "dry-run" ? "Running…" : "Dry run (all companies)"}
          </button>
          <button className="btn primary" type="button" disabled={!!busy || !fleetAck} onClick={() => runMonthly(false)}>
            {busy === "monthly" ? "Running…" : "Run monthly billing (all companies)"}
          </button>
        </div>
      </details>
    </div>
  );
}

function InvoicePreviewCard({
  detail,
  busy,
  setBusy,
  onSaved,
}: {
  detail: TenantDetail;
  busy: string | null;
  setBusy: (v: string | null) => void;
  onSaved: () => void;
}) {
  const preview = detail.preview;
  const pr = preview?.pricingResolution;
  return (
    <DetailCard title="Generate invoice" dataTestId="admin-billing-generate-invoice">
      {pr?.banner ? (
        <div className="billing-status-pill warn" style={{ marginBottom: 12, fontSize: 12, whiteSpace: "normal", lineHeight: 1.45, textAlign: "left" }}>
          <strong>Pricing note:</strong> {pr.banner}
        </div>
      ) : null}
      <div className="billing-preview-total">
        <span>Estimated monthly amount</span>
        <strong>{dollars(preview.totalCents)}</strong>
        <small>
          Subtotal {dollars(preview.subtotalCents)} · Taxes &amp; fees {dollars(preview.taxCents)}
        </small>
      </div>
      <div className="billing-line-list">
        {preview.lineItems.map((item: any) => (
          <div key={`${item.type}-${item.description}`}>
            <span>
              {item.description}
              <small>
                {item.quantity} × {dollars(item.unitPriceCents)}
              </small>
            </span>
            <strong>{dollars(item.amountCents)}</strong>
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "12px 0" }}>
        <strong>Generate invoice</strong> creates this company’s next invoice. <strong>Run monthly billing</strong> runs the automated cycle for this company only (respects autopay rules).
      </p>
      <div className="row-actions">
        <button
          className="btn primary"
          type="button"
          disabled={!!busy}
          onClick={async () => {
            setBusy("generate");
            try {
              await apiPost(`/admin/billing/tenants/${detail.tenant.id}/invoices`, {});
              onSaved();
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "generate" ? "Generating…" : "Generate invoice"}
        </button>
        <button
          className="btn ghost"
          type="button"
          disabled={!!busy}
          onClick={async () => {
            setBusy("run-one");
            try {
              await apiPost("/admin/billing/runs/monthly", { dryRun: false, tenantId: detail.tenant.id });
              onSaved();
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "run-one" ? "Running…" : "Run monthly billing (this company only)"}
        </button>
      </div>
    </DetailCard>
  );
}

function PaymentMethodsCard({ detail }: { detail: TenantDetail }) {
  const methods = detail.paymentMethods || [];
  return (
    <DetailCard title="Saved payment methods">
      {methods.length === 0 ? (
        <div className="b3-health-card b3-health-warn" style={{ marginBottom: 0 }}>
          <h4>No card on file</h4>
          <p style={{ marginBottom: 10 }}>Add a card from <strong>Invoices &amp; payments</strong> using the payment methods dialog for this company.</p>
          <Link
            className="btn primary"
            style={{ fontSize: 13 }}
            href={`/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: detail.tenant.id, [OPS_TAB_QUERY]: "invoices" })}`}
          >
            Open invoices &amp; payments
          </Link>
        </div>
      ) : (
        <div className="b3-pm-grid">
          {methods.map((method: any) => (
            <div key={method.id} className={`b3-pm-card ${method.isDefault ? "b3-pm-default" : ""}`}>
              <div>
                <strong>
                  {(method.brand || "Card").toString()} ···{method.last4 || "----"}
                </strong>
                {method.isDefault ? <span className="b3-pm-badge">Default</span> : null}
                <div className="b3-pm-meta">
                  {method.cardholderName || "Cardholder not set"}
                  {method.expMonth && method.expYear ? ` · Expires ${method.expMonth}/${method.expYear}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </DetailCard>
  );
}

function RecentActivityCard({ detail }: { detail: TenantDetail }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [events, setEvents] = useState<{ id: string; type: string; message: string | null; createdAt: string; metadata?: unknown }[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  async function toggle(invoiceId: string) {
    if (openId === invoiceId) {
      setOpenId(null);
      return;
    }
    setOpenId(invoiceId);
    setLoading(true);
    setErr("");
    setEvents([]);
    try {
      const res = await apiGet<{ events: any[] }>(`/admin/billing/invoices/${invoiceId}/events`);
      setEvents(res.events || []);
    } catch (e: any) {
      setErr(e?.message || "Unable to load activity.");
    } finally {
      setLoading(false);
    }
  }

  const recent = [...(detail.invoices || [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 8);

  return (
    <DetailCard title="Recent activity">
      {recent.length === 0 ? (
        <BillingEmptyState
          title="No invoices yet"
          message="Once this company has billing activity, recent invoices and their audit trail will show here."
        />
      ) : null}
      <div className="b3-timeline">
        {recent.map((invoice) => (
          <div className="b3-timeline-item" key={invoice.id}>
            <div className="b3-timeline-dot" aria-hidden />
            <div className="b3-timeline-body">
              <strong>
                {invoice.invoiceNumber || "Invoice"}{" "}
                <span className={`billing-status-pill ${invoice.status === "PAID" ? "good" : invoice.status === "FAILED" ? "bad" : "warn"}`} style={{ fontSize: 10, marginLeft: 6 }}>
                  {invoiceStatusLabel(invoice.status)}
                </span>
              </strong>
              <small>
                {formatDate((invoice.createdAt || invoice.dueDate) as string)} · {dollars(invoice.totalCents)}
                {invoice.dueDate ? ` · Due ${formatDate(invoice.dueDate)}` : ""}
              </small>
              <div className="row-actions" style={{ marginTop: 8 }}>
                <button className="btn ghost" type="button" style={{ fontSize: 12 }} onClick={() => void toggle(invoice.id)}>
                  {openId === invoice.id ? "Hide activity" : "View activity"}
                </button>
                <Link className="btn ghost" style={{ fontSize: 12 }} href={`/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: detail.tenant.id, [OPS_TAB_QUERY]: "invoices" })}`}>
                  Open in register
                </Link>
              </div>
              {openId === invoice.id ? (
                <div style={{ marginTop: 10 }}>
                  {loading ? <p className="muted">Loading…</p> : null}
                  {err ? <ErrorState message={err} /> : null}
                  {!loading && !err && events.length === 0 ? (
                    <BillingEmptyState
                      title="No events on this invoice"
                      message="Charges, emails, and plan changes will appear after they happen."
                    />
                  ) : null}
                  {!loading && !err && events.length > 0 ? (
                    <div className="billing-timeline-v2" style={{ marginTop: 8 }}>
                      {events.slice(0, 12).map((ev) => (
                        <div className="billing-timeline-v2__item" key={ev.id}>
                          <div className="billing-timeline-v2__icon" aria-hidden>{billingEventIcon(ev.type)}</div>
                          <div>
                            <strong>{billingEventLabel(ev.type)}</strong>
                            <div className="billing-timeline-v2__time">
                              {new Date(ev.createdAt).toLocaleString()}
                              {ev.message ? ` · ${ev.message}` : ""}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </DetailCard>
  );
}
