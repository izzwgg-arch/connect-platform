"use client";

import "../admin/billing/_components/billingPhase3.css";
import "../admin/billing/_components/billingPhase4.css";
import "../admin/billing/_components/billingPhase5.css";
import "./billingWorkspace.css";
import Link from "next/link";
import {
  CalendarDays,
  CreditCard,
  FileText,
  PhoneCall,
  Plus,
  ReceiptText,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { apiGet } from "../../../services/apiClient";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PermissionGate } from "../../../components/PermissionGate";
import { useAppContext } from "../../../hooks/useAppContext";
import { useUiLanguage, LanguageToggle } from "../../../hooks/useUiLanguage";
import { BillingActivityList } from "../../../components/billing/BillingActivityList";
import { CRMPageHeader } from "../../../components/crm/CRMPageHeader";
import {
  CRMWorkspaceBody,
  CRMWorkspaceChrome,
  CRMWorkspaceHeader,
  CRMWorkspaceShell,
  CRMWorkspaceToolbar,
} from "../../../components/crm/CRMWorkspaceShell";
import { CRMPageShell } from "../../../components/crm/CRMPageShell";
import { mk } from "../../../components/crm/campaign/campaignCinemaClasses";
import { cn } from "../../../components/crm/cn";
import { crm } from "../../../components/crm/crmClasses";
import {
  dollars, formatDate,
  invoiceStatusLabel, invoiceStatusClass,
  worstOpenInvoice, nextBillingSummary,
  nextOpenInvoiceDueSummary,
} from "../../../lib/billingUi";

/** Registered up front so the page arrives translated in one batch rather than
 *  a line at a time. Amounts, dates and invoice numbers are never sent — they
 *  are the customer's own data, not interface wording. */
const PHRASES = [
  "You do not have billing access.", "Billing", "Billing workspace", "billing workspace",
  "Invoices", "Payment methods", "Pay", "View all", "View invoices", "Review billing settings",
  "Estimated next invoice", "Item", "Qty", "Unit price", "Amount", "Estimated total",
  "No estimate available", "We'll show your next invoice preview as soon as it's ready.",
  "Timeline", "No recent billing activity", "You'll see payments and invoice updates here.",
  "Billing status", "Status", "Autopay", "Open invoices",
  "Recent invoices", "No invoices yet", "Your invoices will appear here once generated.",
  "Services", "Extensions", "phone numbers", "Preview pending", "Billing summary",
  "Includes", "in taxes and fees.",
];

type PreviewLineItem = {
  type: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
};

type InvoicePreview = {
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  lineItems: PreviewLineItem[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};

type BillingDemoData = {
  settings: any;
  invoices: any[];
  methods: any[];
  usage: any;
  invoicePreview: InvoicePreview;
  timeline: { events: Array<{ id: string; type: string; message: string | null; createdAt: string }> };
};

function isoDaysFromNow(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function buildBillingDemoData(): BillingDemoData {
  const periodStart = isoDaysFromNow(-9);
  const periodEnd = isoDaysFromNow(21);
  const dueDate = isoDaysFromNow(12);

  return {
    settings: {
      autoBillingEnabled: true,
      billingDayOfMonth: 15,
      defaultPaymentMethodId: "demo-card-visa",
    },
    methods: [
      {
        id: "demo-card-visa",
        brand: "Visa",
        last4: "4242",
        expMonth: 4,
        expYear: 2029,
        isDefault: true,
      },
    ],
    usage: {
      extensionCount: 18,
      localPhoneNumberCount: 7,
      tollFreePhoneNumberCount: 2,
    },
    invoicePreview: {
      periodStart,
      periodEnd,
      dueDate,
      lineItems: [
        { type: "EXTENSION", description: "Hosted VoIP extensions", quantity: 18, unitPriceCents: 1699, amountCents: 30582 },
        { type: "PHONE_NUMBER", description: "Local phone numbers", quantity: 7, unitPriceCents: 299, amountCents: 2093 },
        { type: "PHONE_NUMBER", description: "Toll-free numbers", quantity: 2, unitPriceCents: 599, amountCents: 1198 },
        { type: "SMS_PACKAGE", description: "Business messaging package", quantity: 1, unitPriceCents: 1900, amountCents: 1900 },
        { type: "DISCOUNT", description: "Bundle discount", quantity: 1, unitPriceCents: -2500, amountCents: -2500 },
      ],
      subtotalCents: 33273,
      taxCents: 2736,
      totalCents: 36009,
    },
    invoices: [
      {
        id: "demo-open-invoice",
        invoiceNumber: "INV-2026-0615",
        status: "OPEN",
        periodStart,
        periodEnd,
        dueDate,
        totalCents: 36009,
        balanceDueCents: 36009,
        publicPayUrl: "",
        paidAt: null,
      },
      {
        id: "demo-paid-invoice-1",
        invoiceNumber: "INV-2026-0515",
        status: "PAID",
        periodStart: isoDaysFromNow(-39),
        periodEnd: isoDaysFromNow(-10),
        dueDate: isoDaysFromNow(-2),
        totalCents: 34872,
        balanceDueCents: 0,
        paidAt: isoDaysFromNow(-5),
      },
      {
        id: "demo-paid-invoice-2",
        invoiceNumber: "INV-2026-0415",
        status: "PAID",
        periodStart: isoDaysFromNow(-70),
        periodEnd: isoDaysFromNow(-40),
        dueDate: isoDaysFromNow(-32),
        totalCents: 33124,
        balanceDueCents: 0,
        paidAt: isoDaysFromNow(-35),
      },
      {
        id: "demo-void-invoice",
        invoiceNumber: "INV-2026-0315",
        status: "VOID",
        periodStart: isoDaysFromNow(-101),
        periodEnd: isoDaysFromNow(-71),
        dueDate: isoDaysFromNow(-64),
        totalCents: 32500,
        balanceDueCents: 0,
        paidAt: null,
      },
    ],
    timeline: {
      events: [
        {
          id: "demo-event-created",
          type: "invoice_created",
          message: "Invoice INV-2026-0615 was generated for the current billing cycle.",
          createdAt: isoDaysFromNow(-1),
        },
        {
          id: "demo-event-emailed",
          type: "invoice_emailed",
          message: "Invoice email delivered to billing@localdev.example.",
          createdAt: isoDaysFromNow(-1),
        },
        {
          id: "demo-event-paid",
          type: "payment_succeeded",
          message: "Previous invoice INV-2026-0515 was paid with Visa ending 4242.",
          createdAt: isoDaysFromNow(-5),
        },
      ],
    },
  };
}

function invoiceDetailHref(id: string) {
  return `/billing/invoices/${encodeURIComponent(id)}`;
}

function invoicePayHref(invoice: any) {
  const status = String(invoice.status || "");
  const hasBalance = Number(invoice.balanceDueCents || 0) > 0;
  const publicPayUrl = String(invoice.publicPayUrl || "").trim();
  if (hasBalance && status !== "PAID" && status !== "VOID" && publicPayUrl) return publicPayUrl;
  return invoiceDetailHref(invoice.id);
}

function isPastDueDate(dueDate: string | Date | null | undefined) {
  if (!dueDate) return false;
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return due.getTime() < today.getTime();
}

function BillingKpiTile({
  label,
  value,
  icon,
  micro,
  accent,
  tone = "default",
  truncateValue = false,
}: {
  label: string;
  value: string | number;
  icon: JSX.Element;
  micro: string;
  accent: "blue" | "violet" | "green" | "amber" | "rose" | "cyan";
  tone?: "default" | "good" | "warn" | "danger";
  truncateValue?: boolean;
}) {
  const toneClass =
    tone === "good"
      ? "text-crm-success"
      : tone === "warn"
        ? "text-crm-warning"
        : tone === "danger"
          ? "text-crm-danger"
          : "text-crm-text";

  return (
    <div
      className={cn(
        crm.queueCountPill,
        `crm-queue-kpi-${accent}`,
        "relative overflow-hidden bg-crm-surface-2",
      )}
    >
      <span className="flex w-full items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">{label}</span>
          <span
            className={cn(
              "crm-queue-kpi-value mt-1 block font-bold tabular-nums leading-none tracking-tight",
              truncateValue ? "truncate text-xl" : "text-2xl",
              toneClass,
            )}
          >
            {value}
          </span>
        </span>
        <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
          {icon}
        </span>
      </span>
      <span className={cn("crm-queue-kpi-micro text-[10px] font-medium", tone === "default" ? "text-crm-muted" : toneClass)}>
        {micro}
      </span>
    </div>
  );
}

function FailedPaymentBanner({ invoice }: { invoice: any }) {
  const isFailed = invoice.status === "FAILED";
  const isOverdue = invoice.status === "OVERDUE";
  if (!isFailed && !isOverdue) return null;
  return (
    <div className={`billing-alert-banner ${isFailed ? "" : "warn"}`} role="alert">
      <span className="billing-alert-icon">{isFailed ? "⚠️" : "🔔"}</span>
      <div className="billing-alert-body">
        <strong>
          {isFailed ? "Payment failed" : "Invoice overdue"} — {invoice.invoiceNumber}
        </strong>
        <p>
          {dollars(invoice.balanceDueCents)} is due
          {invoice.dueDate ? ` by ${formatDate(invoice.dueDate)}` : ""}.{" "}
          {isFailed
            ? "Update your card or pay manually to bring the account current."
            : "Pay now to avoid interruption."}
        </p>
        <div className="billing-alert-actions">
          <Link className={crm.btnPrimary} href={invoicePayHref(invoice)}>
            Pay now
          </Link>
          <Link className={crm.btnSecondary} href="/billing/payments">
            Update payment method
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function BillingOverviewPage() {
  const { tenantId, tenant } = useAppContext();
  const { t } = useUiLanguage(PHRASES);
  const tenantScopeKey = tenantId;
  const tenantResourceOpts = { keepPreviousData: false as const };

  const settings = useAsyncResource(() => apiGet<any>("/billing/settings"), [tenantScopeKey], tenantResourceOpts);
  const invoices = useAsyncResource(() => apiGet<any[]>("/billing/platform/invoices"), [tenantScopeKey], tenantResourceOpts);
  const methods = useAsyncResource(() => apiGet<any[]>("/billing/payment-methods"), [tenantScopeKey], tenantResourceOpts);
  const usage = useAsyncResource(() => apiGet<any>("/billing/usage/current"), [tenantScopeKey], tenantResourceOpts);
  const invoicePreview = useAsyncResource(() => apiGet<InvoicePreview>("/billing/invoice-preview"), [tenantScopeKey], tenantResourceOpts);

  const rawInvoices = invoices.status === "success" ? invoices.data : [];
  const isLocalBillingPreview =
    typeof window !== "undefined" &&
    ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const shouldUseDemoData =
    isLocalBillingPreview &&
    invoices.status === "success" &&
    rawInvoices.length === 0 &&
    String(tenant?.name || "").toLowerCase().includes("local dev");
  const demoData = shouldUseDemoData ? buildBillingDemoData() : null;

  const allInvoices = demoData?.invoices ?? rawInvoices;
  const openBalance = allInvoices
    .filter((inv) => !["PAID", "VOID"].includes(String(inv.status)) && Number(inv.balanceDueCents || 0) > 0)
    .reduce((sum, inv) => sum + Number(inv.balanceDueCents || 0), 0);
  const worst = worstOpenInvoice(allInvoices);
  const unpaid = allInvoices.filter((inv) => ["OPEN", "FAILED", "OVERDUE", "DRAFT"].includes(String(inv.status)) && Number(inv.balanceDueCents || 0) > 0);
  const balanceTone: "good" | "warn" | "danger" = openBalance === 0
    ? "good"
    : unpaid.some((inv) => ["FAILED", "OVERDUE"].includes(String(inv.status)) || isPastDueDate(inv.dueDate))
      ? "danger"
      : "warn";

  const pmRows = demoData?.methods ?? (methods.status === "success" ? methods.data : []);
  const defaultPm = pmRows.find((m: any) => m.isDefault) || pmRows[0] || null;

  const s = demoData?.settings ?? (settings.status === "success" ? settings.data : null);
  const nextBill = s ? nextBillingSummary(s.billingDayOfMonth, !!s.autoBillingEnabled) : null;
  const usageData = demoData?.usage ?? (usage.status === "success" ? usage.data : null);
  const activeExtensions = usageData ? Number(usageData.extensionCount || 0) : null;
  const activePhoneNumbers = usageData
    ? Number(usageData.localPhoneNumberCount || 0) + Number(usageData.tollFreePhoneNumberCount || 0)
    : null;
  const previewData = demoData?.invoicePreview ?? (invoicePreview.status === "success" ? invoicePreview.data : null);

  const loading = settings.status === "loading" || invoices.status === "loading";

  const timelineId = demoData ? null : (worst?.id || (rawInvoices[0]?.id ?? null));
  const timeline = useAsyncResource<any | null>(
    () => (timelineId ? apiGet<any>(`/billing/platform/invoices/${timelineId}`) : Promise.resolve(null)),
    [timelineId, tenantScopeKey],
    tenantResourceOpts,
  );
  const timelineData = demoData?.timeline ?? (timeline.status === "success" ? timeline.data : null);

  return (
    <PermissionGate permission="can_view_billing_overview" fallback={<div className="state-box">{t("You do not have billing access.")}</div>}>
      <CRMPageShell
        className={cn("campaigns-page-shell billing-page-shell", crm.queueWorkspace)}
        innerClassName={cn(crm.pageInnerQueue, mk.workspace, "campaigns-page-inner billing-workspace")}
      >
        <span data-testid="billing-tenant-overview-loaded" className="sr-only">Billing overview loaded</span>
        <CRMWorkspaceShell className="campaigns-workspace-shell billing-workspace-shell">
          <CRMWorkspaceChrome>
            <CRMWorkspaceHeader>
              <CRMPageHeader
                compact
                className={cn(crm.contactsHeaderPanel, "campaigns-command-header billing-header-panel")}
                icon={<WalletCards className="h-6 w-6" aria-hidden />}
                title={t("Billing")}
                subtitle={tenant?.name ? `${tenant.name} ${t("billing workspace")}` : t("Billing workspace")}
                actions={(
                  <div className="campaigns-hero-actions billing-hero-actions">
                    {/* Renders nothing unless this customer was set up for
                        Yiddish and this person is allowed to use it. */}
                    <LanguageToggle />
                    <Link className="campaigns-btn-secondary" href="/billing/invoices">{t("Invoices")}</Link>
                    <Link className="campaigns-btn-secondary billing-action-button" href="/billing/payments">
                      <Plus className="h-4 w-4" />
                      {t("Payment methods")}
                    </Link>
                    {openBalance > 0 && worst ? (
                      <Link className="campaigns-btn-primary" href={invoicePayHref(worst)}>
                        {t("Pay")} {dollars(openBalance)}
                      </Link>
                    ) : null}
                  </div>
                )}
              />
            </CRMWorkspaceHeader>

            <CRMWorkspaceToolbar className="flex flex-col gap-3">
              {loading ? <LoadingSkeleton rows={3} /> : null}
              {settings.status === "error" ? <ErrorState message={settings.error} /> : null}
              {invoices.status === "error" ? <ErrorState message={invoices.error} /> : null}

              {!loading ? (
                <section
                  className="crm-queue-kpi-strip grid w-full grid-cols-2 items-stretch gap-3 md:grid-cols-4"
                  aria-label={t("Billing summary")}
                >
                  <BillingKpiTile
                    label="Balance"
                    value={dollars(openBalance)}
                    accent="blue"
                    tone={balanceTone}
                    icon={<WalletCards className="h-4 w-4" />}
                    micro={nextOpenInvoiceDueSummary(allInvoices) || (openBalance === 0 ? "No balance due" : "Open balance")}
                  />
                  <BillingKpiTile
                    label="Payment method"
                    value={defaultPm ? `${defaultPm.brand || "Card"} ···${defaultPm.last4 || "••••"}` : "None"}
                    accent="violet"
                    truncateValue
                    icon={<CreditCard className="h-4 w-4" />}
                    micro={
                      defaultPm?.expMonth && defaultPm?.expYear
                        ? `Expires ${defaultPm.expMonth}/${String(defaultPm.expYear).slice(-2)}`
                        : s?.defaultPaymentMethodId
                          ? "Default method"
                          : "No card on file"
                    }
                  />
                  <BillingKpiTile
                    label="Next invoice"
                    value={previewData ? dollars(previewData.totalCents) : "—"}
                    accent="cyan"
                    icon={<ReceiptText className="h-4 w-4" />}
                    micro={
                      previewData
                        ? `${formatDate(previewData.periodStart)} - ${formatDate(previewData.periodEnd)}`
                        : t("Preview pending")
                    }
                  />
                  <BillingKpiTile
                    label={t("Services")}
                    value={activeExtensions ?? "—"}
                    accent="green"
                    icon={<PhoneCall className="h-4 w-4" />}
                    micro={activePhoneNumbers != null ? `${activePhoneNumbers} ${t("phone numbers")}` : t("Extensions")}
                  />
                </section>
              ) : null}

              {!loading && worst ? <FailedPaymentBanner invoice={worst} /> : null}
            </CRMWorkspaceToolbar>
          </CRMWorkspaceChrome>

          <CRMWorkspaceBody className="billing-workspace-body">
            <section className="bw-main-grid">
              <div className="bw-primary-grid">
                <div className="billing-card bw-panel bw-estimate-panel" id="estimate">
                  <div className="bw-section-head">
                    <div>
                      <h2>{t("Estimated next invoice")}</h2>
                    </div>
                  </div>
                  <div className="bw-card-scroll">
                    {!demoData && invoicePreview.status === "loading" ? <LoadingSkeleton rows={3} /> : null}
                    {!demoData && invoicePreview.status === "error" ? <ErrorState message={invoicePreview.error} /> : null}
                    {previewData?.lineItems?.length ? (
                      <div className="bw-estimate-table-wrap">
                        <table className="bw-estimate-table">
                          <thead>
                            <tr>
                              <th>{t("Item")}</th>
                              <th>{t("Qty")}</th>
                              <th>{t("Unit price")}</th>
                              <th>{t("Amount")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {previewData.lineItems.map((item, idx) => (
                              <tr key={idx}>
                                <td>{item.description}</td>
                                <td className="num">{item.quantity ?? "—"}</td>
                                <td className="num">{item.unitPriceCents != null ? dollars(item.unitPriceCents) : "—"}</td>
                                <td className={`num ${item.amountCents < 0 ? "neg" : ""}`}>
                                  {item.amountCents < 0 ? `(${dollars(-item.amountCents)})` : dollars(item.amountCents)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr>
                              <td colSpan={3}>{t("Estimated total")}</td>
                              <td className="num">{dollars(previewData.totalCents)}</td>
                            </tr>
                          </tfoot>
                        </table>
                        {previewData.taxCents > 0 ? (
                          <p className="muted" style={{ marginTop: 8 }}>{t("Includes")} {dollars(previewData.taxCents)} {t("in taxes and fees.")}</p>
                        ) : null}
                      </div>
                    ) : (
                      <div className="state-box">
                        <div className="state-illus" aria-hidden>
                          <svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h16M4 17h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                        </div>
                        <div className="state-title">{t("No estimate available")}</div>
                        <div className="state-text">{t("We'll show your next invoice preview as soon as it's ready.")}</div>
                        <div className="state-actions"><Link className="campaigns-btn-secondary" href="/billing/invoices">{t("View invoices")}</Link></div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="billing-card bw-panel bw-timeline-panel">
                  <div className="bw-section-head">
                    <div>
                      <h2>{t("Timeline")}</h2>
                    </div>
                  </div>
                  <div className="bw-card-scroll">
                    {!demoData && timeline.status === "loading" ? <LoadingSkeleton rows={3} /> : null}
                    {timelineData?.events?.length ? (
                      <BillingActivityList events={timelineData.events} />
                    ) : (
                      <div className="state-box">
                        <div className="state-illus" aria-hidden>
                          <svg viewBox="0 0 24 24" fill="none"><path d="M12 6v6l4 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                        </div>
                        <div className="state-title">{t("No recent billing activity")}</div>
                        <div className="state-text">{t("You'll see payments and invoice updates here.")}</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <aside className="bw-right-rail">
                <div className="billing-card bw-panel bw-panel--summary">
                  <div className="bw-section-head">
                    <div>
                      <h2>{t("Billing status")}</h2>
                    </div>
                  </div>
                  <div className="bw-card-scroll">
                    <div className="bw-status-grid">
                      <div className="bw-status-item">
                        <span><ShieldCheck size={15} />{t("Status")}</span>
                        <strong className={balanceTone === "danger" ? "neg" : balanceTone === "warn" ? "warn" : "pos"}>
                          {worst ? invoiceStatusLabel(worst.status) : "Good standing"}
                        </strong>
                      </div>
                      <div className="bw-status-item">
                        <span><CalendarDays size={15} />{t("Autopay")}</span>
                        <strong>{s?.autoBillingEnabled ? (s.billingDayOfMonth ? `Day ${s.billingDayOfMonth}` : "Enabled") : "Off"}</strong>
                        <small>{nextBill || (s?.autoBillingEnabled ? "Auto-billing on" : "Manual payments")}</small>
                      </div>
                      <div className="bw-status-item">
                        <span><FileText size={15} />{t("Open invoices")}</span>
                        <strong>{unpaid.length}</strong>
                        <small>{openBalance > 0 ? `${dollars(openBalance)} due` : "Nothing due"}</small>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="billing-card bw-panel bw-recent-panel">
                  <div className="bw-section-head">
                    <div>
                      <h2>{t("Recent invoices")}</h2>
                    </div>
                    <Link className="campaigns-btn-secondary" href="/billing/invoices">{t("View all")}</Link>
                  </div>
                  <div className="bw-card-scroll">
                    {!loading && allInvoices.slice(0, 5).length ? (
                      <div className="bw-invoice-list">
                        {allInvoices.slice(0, 5).map((inv) => (
                          <Link className="bw-invoice-row" key={inv.id} href={invoiceDetailHref(inv.id)}>
                            <div className="bw-invoice-id">
                              <strong>{inv.invoiceNumber || inv.id.slice(0, 8)}</strong>
                              <small className="muted">{inv.periodStart && inv.periodEnd ? `${formatDate(inv.periodStart)} – ${formatDate(inv.periodEnd)}` : "—"}</small>
                            </div>
                            <span className={`billing-status-pill ${invoiceStatusClass(inv.status)}`}>
                              {invoiceStatusLabel(inv.status)}
                            </span>
                            <div className="bw-invoice-amt">{dollars(inv.totalCents)}</div>
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <div className="state-box">
                        <div className="state-illus" aria-hidden>
                          <svg viewBox="0 0 24 24" fill="none"><path d="M6 7h12M6 12h12M6 17h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                        </div>
                        <div className="state-title">{t("No invoices yet")}</div>
                        <div className="state-text">{t("Your invoices will appear here once generated.")}</div>
                        <div className="state-actions"><Link className="campaigns-btn-secondary" href="/billing/settings">{t("Review billing settings")}</Link></div>
                      </div>
                    )}
                  </div>
                </div>
              </aside>
            </section>
          </CRMWorkspaceBody>
        </CRMWorkspaceShell>
      </CRMPageShell>
    </PermissionGate>
  );
}
