"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
import { apiDelete, apiGet, apiPost, getPortalApiBaseUrl } from "../../../../../services/apiClient";
import { DataTable } from "../../../../../components/DataTable";
import { ErrorState } from "../../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { billingErrorMessage } from "../../../../../components/BillingActionToast";
import { BillingActionPanel } from "../../../../../components/billing/BillingActionPanel";
import { BillingActivityList } from "../../../../../components/billing/BillingActivityList";
import { BillingEmptyState } from "../../../../../components/billing/BillingEmptyState";
import { dollars, invoiceStatusLabel, transactionStatusLabel } from "../../../../../lib/billingUi";
import { useAppContext } from "../../../../../hooks/useAppContext";
import { OPS_TAB_QUERY, isAdminOpsTab, type AdminOpsTab } from "../_components/adminBillingLinks";

function openAdminInvoicePdf(invoiceId: string) {
  const token = localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  window.open(`${getPortalApiBaseUrl()}/billing/platform/invoices/${encodeURIComponent(invoiceId)}/pdf${qs}`, "_blank", "noopener,noreferrer");
}

// ── types ─────────────────────────────────────────────────────────────────────

type InvoiceRow = {
  id: string;
  invoiceNumber: string | null;
  tenantId: string;
  status: string;
  totalCents: number;
  subtotalCents: number;
  taxCents: number;
  balanceDueCents: number;
  dueDate: string | null;
  paidAt: string | null;
  failedAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  lastEmailStatus: string | null;
  lastEmailedAt: string | null;
  createdAt: string;
  tenant: { id: string; name: string; billingSettings?: { billingEmail?: string | null; defaultPaymentMethodId?: string | null } | null };
  paymentMethod?: { id: string; brand: string | null; last4: string | null } | null;
  transactions: { id: string; status: string; processorTransactionId: string | null; responseCode: string | null; amountCents: number; createdAt: string }[];
};

type InvoiceListResult = { invoices: InvoiceRow[]; total: number; page: number; pages: number; limit: number };

type InvoiceLineItem = { id: string; description: string | null; quantity: number | null; unitAmountCents: number | null; totalCents: number; taxCents?: number | null };

type InvoiceTxRow = {
  id: string;
  amountCents: number;
  status: string;
  processorTransactionId: string | null;
  responseCode: string | null;
  responseMessage: string | null;
  createdAt: string;
  paymentMethod?: { id: string; brand: string | null; last4: string | null } | null;
};

type InvoiceEventRow = { id: string; type: string; message: string | null; metadata?: unknown; createdAt: string };

type InvoiceDetail = Omit<InvoiceRow, "transactions"> & {
  lineItems: InvoiceLineItem[];
  transactions: InvoiceTxRow[];
  events: InvoiceEventRow[];
  isLiveCharge: boolean;
  metadata?: unknown;
};

type AdminPaymentMethod = {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  cardholderName: string | null;
  billingZip: string | null;
  isDefault: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  lastSuccessfulCharge: { id: string; amountCents: number; createdAt: string } | null;
};

type TxRow = {
  id: string;
  tenantId: string;
  invoiceId: string | null;
  amountCents: number;
  currency: string | null;
  status: string;
  processor: string | null;
  processorTransactionId: string | null;
  responseCode: string | null;
  responseMessage: string | null;
  createdAt: string;
  tenant: { id: string; name: string };
  invoice: { id: string; invoiceNumber: string | null } | null;
  paymentMethod: { id: string; brand: string | null; last4: string | null } | null;
};

type TxDetail = TxRow & {
  paymentMethod: { id: string; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null } | null;
  invoice: { id: string; invoiceNumber: string | null; status: string; totalCents: number } | null;
  rawResponseSafeJson: unknown;
  idempotencyKey: string | null;
};

type SmsCapability = {
  capable: boolean;
  fromNumber: string | null;
  provider: string | null;
  reason: string | null;
};

type TxListResult = { transactions: TxRow[]; total: number; page: number; pages: number; limit: number };

// ── helpers ───────────────────────────────────────────────────────────────────

const INV_STATUSES = ["ALL", "DRAFT", "OPEN", "FAILED", "OVERDUE", "PAID", "VOID"];
const TX_STATUSES = ["ALL", "PENDING", "APPROVED", "DECLINED", "ERROR", "VOIDED", "REFUNDED"];

function invStatusClass(status: string) {
  if (status === "PAID") return "good";
  if (status === "FAILED" || status === "OVERDUE") return "bad";
  if (status === "VOID") return "";
  return "warn";
}

function txStatusClass(status: string) {
  if (status === "APPROVED") return "good";
  if (status === "DECLINED" || status === "ERROR") return "bad";
  return "warn";
}

function fmtDate(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString();
}

function fmtDatetime(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

function fmtPeriod(start: string | null, end: string | null) {
  if (!start || !end) return null;
  return `${new Date(start).toLocaleDateString()} – ${new Date(end).toLocaleDateString()}`;
}

function cardLabel(m: { brand: string | null; last4: string | null; expMonth?: number | null; expYear?: number | null; cardholderName?: string | null }) {
  const brand = m.brand || "Card";
  const last4 = m.last4 ? `···${m.last4}` : "";
  const exp = m.expMonth && m.expYear ? ` exp ${m.expMonth}/${String(m.expYear).slice(-2)}` : "";
  const name = m.cardholderName ? ` · ${m.cardholderName}` : "";
  return `${brand} ${last4}${exp}${name}`;
}

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="row-actions" style={{ justifyContent: "flex-end", marginTop: 8 }}>
      <button className="btn ghost" type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>← Prev</button>
      <span className="muted" style={{ padding: "0 8px", lineHeight: "32px" }}>Page {page} of {pages}</span>
      <button className="btn ghost" type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next →</button>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000,
  display: "flex", alignItems: "flex-start", justifyContent: "flex-end", overflow: "auto",
};

const drawerStyle: React.CSSProperties = {
  background: "var(--surface, #fff)", width: "min(680px, 100vw)", minHeight: "100vh",
  boxShadow: "-4px 0 24px rgba(0,0,0,0.18)", padding: "24px 28px", overflowY: "auto",
};

const modalStyle: React.CSSProperties = {
  background: "var(--surface, #fff)", borderRadius: 10, padding: "28px 32px",
  width: "min(520px, 96vw)", margin: "60px auto", boxShadow: "0 8px 40px rgba(0,0,0,0.22)",
};

// ── InvoiceDetailModal ────────────────────────────────────────────────────────

function readInvoiceCollections(metadata: unknown) {
  const root = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  const c = root.collections && typeof root.collections === "object" && !Array.isArray(root.collections) ? (root.collections as Record<string, unknown>) : {};
  const paused = Boolean(c.paused);
  const doNotCharge = Boolean(c.doNotCharge);
  const skipNextRetry = Boolean(c.skipNextRetry);
  const status: "NORMAL" | "PAUSED" | "DO_NOT_CHARGE" = doNotCharge ? "DO_NOT_CHARGE" : paused ? "PAUSED" : "NORMAL";
  return { status, paused, doNotCharge, skipNextRetry, pausedBy: c.pausedBy as string | null ?? null, pauseReason: c.pauseReason as string | null ?? null };
}

function InvoiceDetailModal({ invoiceId, onClose, onAction }: { invoiceId: string; onClose: () => void; onAction: () => void }) {
  const [rev, setRev] = useState(0);
  const data = useAsyncResource<InvoiceDetail>(() => apiGet<InvoiceDetail>(`/admin/billing/invoices/${invoiceId}`), [invoiceId, rev]);
  const inv = data.status === "success" ? data.data : null;
  const [collectionsMsg, setCollectionsMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [collectionsBusy, setCollectionsBusy] = useState(false);
  const [collectionsDncConfirm, setCollectionsDncConfirm] = useState(false);

  return (
    <>
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={drawerStyle}>
        <div className="row-actions" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: 0, flex: 1 }}>
            Invoice {inv?.invoiceNumber || invoiceId.slice(0, 8)}
          </h3>
          <button className="btn ghost" type="button" onClick={onClose}>✕ Close</button>
        </div>

        {data.status === "loading" ? <LoadingSkeleton rows={6} /> : null}
        {data.status === "error" ? <ErrorState message={data.error} /> : null}

        {inv ? (
          <div className="stack compact-stack">
            {/* Summary */}
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 8 }}>
              <div><span className="muted" style={{ fontSize: 12 }}>Status</span><br /><span className={`billing-status-pill ${invStatusClass(inv.status)}`}>{inv.status}</span></div>
              <div><span className="muted" style={{ fontSize: 12 }}>Total</span><br /><strong>{dollars(inv.totalCents)}</strong></div>
              {inv.balanceDueCents > 0 && inv.status !== "PAID" ? (
                <div><span className="muted" style={{ fontSize: 12 }}>Balance due</span><br /><strong style={{ color: "var(--danger, #dc2626)" }}>{dollars(inv.balanceDueCents)}</strong></div>
              ) : null}
              {inv.taxCents > 0 ? <div><span className="muted" style={{ fontSize: 12 }}>Tax</span><br />{dollars(inv.taxCents)}</div> : null}
              <div><span className="muted" style={{ fontSize: 12 }}>Due</span><br />{fmtDate(inv.dueDate)}</div>
              {inv.paidAt ? <div><span className="muted" style={{ fontSize: 12 }}>Paid</span><br />{fmtDate(inv.paidAt)}</div> : null}
              <div><span className="muted" style={{ fontSize: 12 }}>Tenant</span><br />{inv.tenant?.name}</div>
            </div>
            {inv.paymentMethod ? (
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                Card on invoice: {cardLabel(inv.paymentMethod)}
              </p>
            ) : null}

            {/* Line items */}
            {inv.lineItems?.length > 0 ? (
              <>
                <h4 style={{ margin: "16px 0 6px" }}>Line Items</h4>
                <DataTable
                  rows={inv.lineItems.map((li) => ({ ...li, id: li.id }))}
                  columns={[
                    { key: "desc", label: "Description", render: (r: InvoiceLineItem) => r.description || "—" },
                    { key: "qty", label: "Qty", render: (r: InvoiceLineItem) => r.quantity ?? "—" },
                    { key: "unit", label: "Unit", render: (r: InvoiceLineItem) => r.unitAmountCents != null ? dollars(r.unitAmountCents) : "—" },
                    { key: "tax", label: "Tax", render: (r: InvoiceLineItem) => r.taxCents ? dollars(r.taxCents) : "—" },
                    { key: "total", label: "Total", render: (r: InvoiceLineItem) => dollars(r.totalCents) },
                  ]}
                />
              </>
            ) : (
              <BillingEmptyState
                title="No line items"
                message="This invoice has no service or fee lines yet. It may still be a draft or was created without detail rows."
              />
            )}

            {/* Payment transactions */}
            {inv.transactions?.length > 0 ? (
              <>
                <h4 style={{ margin: "16px 0 6px" }}>Payment Attempts</h4>
                <div className="billing-ops-table-wrap billing-ops-scroll">
                <DataTable
                  rows={inv.transactions.map((t) => ({ ...t, id: t.id }))}
                  columns={[
                    { key: "date", label: "Date", render: (r: InvoiceTxRow) => fmtDatetime(r.createdAt) },
                    {
                      key: "status", label: "Status",
                      render: (r: InvoiceTxRow) => <span className={`billing-status-pill ${txStatusClass(r.status)}`}>{transactionStatusLabel(r.status)}</span>,
                    },
                    { key: "amt", label: "Amount", render: (r: InvoiceTxRow) => dollars(r.amountCents) },
                    { key: "card", label: "Card", render: (r: InvoiceTxRow) => r.paymentMethod ? cardLabel(r.paymentMethod) : "—" },
                    { key: "ref", label: "Processor Ref", render: (r: InvoiceTxRow) => r.processorTransactionId || "—" },
                    { key: "msg", label: "Response", render: (r: InvoiceTxRow) => r.responseMessage || r.responseCode || "—" },
                  ]}
                />
                </div>
              </>
            ) : (
              <BillingEmptyState
                title="No payment attempts yet"
                message="When a card is charged or retried, each attempt appears here with the processor response."
              />
            )}

            {/* Event log */}
            <h4 style={{ margin: "16px 0 6px" }}>Activity</h4>
            {inv.events?.length ? (
              <BillingActivityList events={inv.events.map((e) => ({ ...e, id: e.id || `${invoiceId}-${e.createdAt}` }))} />
            ) : (
              <BillingEmptyState
                title="No activity on this invoice"
                message="Audit events (emails, charges, plan changes) will show here as they occur."
              />
            )}

            {/* Collections controls */}
            {(() => {
              if (!inv || ["PAID", "VOID"].includes(inv.status)) return null;
              const cs = readInvoiceCollections(inv.metadata);
              return (
                <div style={{ marginTop: 16, padding: "12px 14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8 }}>
                  <div className="row-actions" style={{ marginBottom: 8 }}>
                    <strong style={{ fontSize: 13 }}>Automatic retries</strong>
                    <span className={`billing-status-pill ${cs.status === "DO_NOT_CHARGE" ? "bad" : cs.status === "PAUSED" ? "warn" : "ok"}`} style={{ fontSize: 11 }}>
                      {cs.status === "DO_NOT_CHARGE" ? "Auto-charge off" : cs.status === "PAUSED" ? "Paused" : "Active"}
                    </span>
                  </div>
                  <p className="muted" style={{ fontSize: 12, margin: "0 0 10px" }}>
                    These controls change what happens on the next scheduled retry window. They do not charge immediately.
                  </p>
                  {cs.paused && (
                    <p style={{ fontSize: 12, margin: "0 0 6px", color: "#6b7280" }}>
                      Paused by {cs.pausedBy || "operator"}{cs.pauseReason ? ` — ${cs.pauseReason}` : ""}
                    </p>
                  )}
                  {cs.skipNextRetry && !cs.paused && (
                    <p style={{ fontSize: 12, margin: "0 0 6px", color: "#6b7280" }}>Skip-next-retry is set.</p>
                  )}
                  {collectionsMsg && (
                    <div className={`billing-status-pill ${collectionsMsg.type === "ok" ? "ok" : "bad"}`} style={{ marginBottom: 8, fontSize: 12 }}>
                      {collectionsMsg.text}
                    </div>
                  )}
                  <div className="row-actions" style={{ flexWrap: "wrap", gap: 6 }}>
                    {!cs.paused && !cs.doNotCharge && (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={collectionsBusy}
                        style={{ fontSize: 12 }}
                        onClick={async () => {
                          setCollectionsBusy(true);
                          setCollectionsMsg(null);
                          try {
                            await apiPost(`/admin/billing/invoices/${invoiceId}/collections/pause`, {});
                            setCollectionsMsg({ type: "ok", text: "Paused. Worker enforcement in Phase 2." });
                            setRev((r) => r + 1);
                          } catch (err: unknown) {
                            setCollectionsMsg({ type: "err", text: billingErrorMessage(err, "Pause failed.") });
                          } finally { setCollectionsBusy(false); }
                        }}
                      >
                        ⏸ Pause collections
                      </button>
                    )}
                    {(cs.paused || cs.doNotCharge || cs.skipNextRetry) && (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={collectionsBusy}
                        style={{ fontSize: 12 }}
                        onClick={async () => {
                          setCollectionsBusy(true);
                          setCollectionsMsg(null);
                          try {
                            await apiPost(`/admin/billing/invoices/${invoiceId}/collections/resume`, {});
                            setCollectionsMsg({ type: "ok", text: "Resumed." });
                            setRev((r) => r + 1);
                          } catch (err: unknown) {
                            setCollectionsMsg({ type: "err", text: billingErrorMessage(err, "Resume failed.") });
                          } finally { setCollectionsBusy(false); }
                        }}
                      >
                        ▶ Resume
                      </button>
                    )}
                    {!cs.skipNextRetry && !cs.paused && !cs.doNotCharge && (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={collectionsBusy}
                        style={{ fontSize: 12 }}
                        onClick={async () => {
                          setCollectionsBusy(true);
                          setCollectionsMsg(null);
                          try {
                            await apiPost(`/admin/billing/invoices/${invoiceId}/collections/skip-next-retry`, {});
                            setCollectionsMsg({ type: "ok", text: "Skip-next-retry set. Worker enforcement in Phase 2." });
                            setRev((r) => r + 1);
                          } catch (err: unknown) {
                            setCollectionsMsg({ type: "err", text: billingErrorMessage(err, "Skip failed.") });
                          } finally { setCollectionsBusy(false); }
                        }}
                      >
                        ⏭ Skip next retry
                      </button>
                    )}
                    {!cs.doNotCharge && (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={collectionsBusy}
                        style={{ fontSize: 12, color: "var(--danger, #dc2626)", borderColor: "var(--danger, #dc2626)" }}
                        onClick={() => setCollectionsDncConfirm(true)}
                      >
                        🚫 Do not auto-charge
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}

            <div className="row-actions" style={{ marginTop: 16 }}>
              <button className="btn primary" type="button" onClick={() => { onAction(); onClose(); }}>Refresh list</button>
              <button className="btn ghost" type="button" onClick={onClose}>Close</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>

    {collectionsDncConfirm && inv && !["PAID", "VOID"].includes(inv.status) ? (() => {
      const cs = readInvoiceCollections(inv.metadata);
      return (
        <BillingActionPanel
          layout="center"
          centerWidth="min(520px, 96vw)"
          variant="danger"
          onClose={() => { if (!collectionsBusy) setCollectionsDncConfirm(false); }}
          eyebrow={inv.tenant?.name || "Company"}
          title="Turn off automatic charging?"
          subtitle="The billing worker will skip autopay attempts for this invoice until you resume collections."
          summary={(
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li><strong>Invoice</strong> {inv.invoiceNumber || invoiceId.slice(0, 8)}</li>
              <li><strong>Balance due</strong> {dollars(inv.balanceDueCents)}</li>
              <li><strong>Retry state now</strong> {cs.status === "PAUSED" ? "Paused" : cs.status === "DO_NOT_CHARGE" ? "Already off" : "Active"}</li>
            </ul>
          )}
          notice="You can still collect manually (charge card or mark paid). Use Resume when the customer is ready for autopay again."
          warning="This is an operational collections change — confirm it matches what the customer agreed to."
          footer={(
            <>
              <button className="btn ghost" type="button" disabled={collectionsBusy} onClick={() => setCollectionsDncConfirm(false)}>Cancel</button>
              <button
                className="btn danger"
                type="button"
                disabled={collectionsBusy}
                onClick={async () => {
                  setCollectionsBusy(true);
                  setCollectionsMsg(null);
                  try {
                    await apiPost(`/admin/billing/invoices/${invoiceId}/collections/do-not-charge`, {});
                    setCollectionsMsg({ type: "ok", text: "Marked do-not-charge. Worker enforcement in Phase 2." });
                    setCollectionsDncConfirm(false);
                    setRev((r) => r + 1);
                  } catch (err: unknown) {
                    setCollectionsMsg({ type: "err", text: billingErrorMessage(err, "Failed.") });
                  } finally {
                    setCollectionsBusy(false);
                  }
                }}
              >
                {collectionsBusy ? "Applying…" : "Turn off auto-charge"}
              </button>
            </>
          )}
        />
      );
    })() : null}
    </>
  );
}

function ManualPayModal({ invoice, onClose, onSuccess }: { invoice: InvoiceRow; onClose: () => void; onSuccess: () => void }) {
  const [step, setStep] = useState<"pick" | "confirm" | "done">("pick");
  const [selectedMethodId, setSelectedMethodId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitted = useRef(false);

  const pmData = useAsyncResource<{ methods: AdminPaymentMethod[]; isLiveCharge: boolean }>(
    () => apiGet(`/admin/billing/platform/tenants/${invoice.tenantId}/payment-methods`),
    [invoice.tenantId],
  );

  const methods = pmData.status === "success" ? pmData.data.methods : [];
  const isLive = pmData.status === "success" ? pmData.data.isLiveCharge : false;
  const selectedMethod = methods.find((m) => m.id === selectedMethodId) ?? null;

  async function submit() {
    if (submitted.current || busy) return;
    submitted.current = true;
    setBusy(true);
    setError("");
    try {
      await apiPost(`/admin/billing/invoices/${invoice.id}/pay`, {
        paymentMethodId: selectedMethodId,
        note: note.trim() || undefined,
        confirmLive: true,
      });
      setStep("done");
      onSuccess();
    } catch (err) {
      setError(billingErrorMessage(err, "Charge failed."));
      submitted.current = false;
    } finally {
      setBusy(false);
    }
  }

  const isRetryFlow = invoice.status === "FAILED" || invoice.status === "OVERDUE";
  const sortedTx = [...(invoice.transactions || [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const lastBad = sortedTx.find((t) => String(t.status).toUpperCase() !== "APPROVED");

  const flowSummary = (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      <li><strong>Invoice</strong> {invoice.invoiceNumber || invoice.id.slice(0, 8)}</li>
      <li><strong>Company</strong> {invoice.tenant?.name || invoice.tenantId}</li>
      <li><strong>Balance due</strong> {dollars(invoice.balanceDueCents)}</li>
      <li><strong>Status</strong> {invoiceStatusLabel(invoice.status)}</li>
      {invoice.paymentMethod ? (
        <li><strong>Card on invoice</strong> {cardLabel(invoice.paymentMethod)}</li>
      ) : null}
      {isRetryFlow && lastBad ? (
        <li>
          <strong>Last attempt</strong> {transactionStatusLabel(lastBad.status)} · {fmtDatetime(lastBad.createdAt)}
          {lastBad.responseCode ? ` · ${lastBad.responseCode}` : ""}
        </li>
      ) : null}
      {isRetryFlow && !lastBad ? <li><strong>Last attempt</strong> No declined rows on this list yet — check Activity after charging.</li> : null}
    </ul>
  );

  const envBadge = isLive ? (
    <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: "#fff", background: "#dc2626", borderRadius: 4, padding: "2px 7px", verticalAlign: "middle" }}>
      LIVE
    </span>
  ) : (
    <span style={{ marginLeft: 8, fontSize: 11, color: "#64748b", background: "#f1f5f9", borderRadius: 4, padding: "2px 7px", verticalAlign: "middle" }}>
      Sandbox
    </span>
  );

  return (
    <BillingActionPanel
      layout="drawer"
      drawerWidth="min(520px, 100vw)"
      variant={step === "confirm" && isLive ? "danger" : "default"}
      onClose={() => { if (!busy) onClose(); }}
      eyebrow={invoice.tenant?.name || "Company"}
      title={<span>{isRetryFlow ? "Retry payment" : "Collect payment"}{envBadge}</span>}
      subtitle={
        step === "done"
          ? "The charge was submitted to the processor."
          : isRetryFlow
            ? "Run a new attempt with a saved card. Confirm the amount and environment before submitting."
            : "Charge a saved card for the open balance. Confirm the amount and environment before submitting."
      }
      summary={step === "done" ? undefined : flowSummary}
      footer={
        step === "done" ? (
          <button className="btn primary" type="button" onClick={onClose}>
            Close
          </button>
        ) : step === "confirm" ? (
          <>
            <button className="btn ghost" type="button" disabled={busy} onClick={() => { setStep("pick"); submitted.current = false; }}>
              ← Back
            </button>
            <button className="btn danger" type="button" disabled={busy} onClick={submit}>
              {busy ? "Charging…" : isLive ? "Submit live charge" : "Submit charge"}
            </button>
          </>
        ) : (
          <>
            <button className="btn ghost" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" type="button" disabled={!selectedMethodId} onClick={() => setStep("confirm")}>
              Review charge →
            </button>
          </>
        )
      }
    >
      {step === "done" ? (
        <div style={{ color: "#15803d", fontSize: 15, fontWeight: 600 }}>Charge submitted successfully.</div>
      ) : step === "confirm" ? (
        <>
          <p style={{ margin: "0 0 12px", fontSize: 14 }}>
            You are about to charge <strong>{dollars(invoice.balanceDueCents)}</strong> to{" "}
            <strong>{selectedMethod ? cardLabel(selectedMethod) : selectedMethodId}</strong>.
          </p>
          {note ? <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>Operator note: {note}</p> : null}
          {isLive ? (
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#991b1b" }}>
              This runs against the live gateway — funds move for real.
            </p>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Sandbox — no real funds are moved.</p>
          )}
          {error ? <div style={{ color: "#dc2626", marginTop: 12, fontSize: 13 }}>{error}</div> : null}
        </>
      ) : (
        <>
          {pmData.status === "loading" ? <LoadingSkeleton rows={3} /> : null}
          {pmData.status === "error" ? <ErrorState message={pmData.error} /> : null}
          {pmData.status === "success" && methods.length === 0 ? (
            <BillingEmptyState
              title="No saved cards"
              message="Ask the customer to add a card from their billing portal, or use Cards on the invoice row to add one on their behalf when the gateway is configured."
            />
          ) : null}

          {methods.length > 0 ? (
            <>
              <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 600 }}>Payment method</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                {methods.map((m) => (
                  <label
                    key={m.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      cursor: "pointer",
                      padding: "10px 12px",
                      borderRadius: 8,
                      border: `1.5px solid ${selectedMethodId === m.id ? "var(--accent, #2563eb)" : "var(--border, #e2e8f0)"}`,
                      fontSize: 13,
                    }}
                  >
                    <input type="radio" name="paymentMethod" value={m.id} checked={selectedMethodId === m.id} onChange={() => setSelectedMethodId(m.id)} />
                    {cardLabel(m)}
                    {m.isDefault ? <span style={{ marginLeft: 4, fontSize: 10, background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 5px" }}>Default</span> : null}
                    {m.lastSuccessfulCharge ? (
                      <span style={{ marginLeft: "auto", fontSize: 11, color: "#64748b" }}>
                        Last ok: {dollars(m.lastSuccessfulCharge.amountCents)} {fmtDate(m.lastSuccessfulCharge.createdAt)}
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
            </>
          ) : null}

          <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>
            Operator note (optional, stored on activity)
          </label>
          <input
            type="text"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Customer approved retry over the phone"
            style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border, #e2e8f0)", fontSize: 13, boxSizing: "border-box" }}
          />
        </>
      )}
    </BillingActionPanel>
  );
}

// ── PaymentMethodsModal ────────────────────────────────────────────────────────

type AdminSolaPublicConfig = { configured: boolean; enabled: boolean; ifieldsKey: string | null; mode: string | null };

function PaymentMethodsModal({ tenantId, tenantName, onClose }: { tenantId: string; tenantName: string; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [rev, setRev] = useState(0);
  const [removeTarget, setRemoveTarget] = useState<AdminPaymentMethod | null>(null);

  // iFields add-card state
  const [solaConfig, setSolaConfig] = useState<AdminSolaPublicConfig | null>(null);
  const [ifieldsReady, setIfieldsReady] = useState(false);
  const [showAddCard, setShowAddCard] = useState(false);
  const [addCardBusy, setAddCardBusy] = useState(false);
  const [addCardMsg, setAddCardMsg] = useState("");
  const submittedRef = useRef(false);

  const data = useAsyncResource<{ methods: AdminPaymentMethod[]; isLiveCharge: boolean }>(
    () => apiGet(`/admin/billing/platform/tenants/${tenantId}/payment-methods`),
    [tenantId, rev],
  );
  const methods = data.status === "success" ? data.data.methods : [];

  function showToast(kind: "ok" | "err", text: string) {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3500);
  }

  // Fetch tenant SOLA public config once on open
  useEffect(() => {
    let active = true;
    apiGet<AdminSolaPublicConfig>(`/admin/billing/platform/tenants/${tenantId}/sola/public-config`)
      .then((cfg) => { if (active) setSolaConfig(cfg); })
      .catch(() => { if (active) setSolaConfig({ configured: false, enabled: false, ifieldsKey: null, mode: null }); });
    return () => { active = false; };
  }, [tenantId]);

  // Load iFields script when public config is ready
  useEffect(() => {
    if (!solaConfig?.enabled || !solaConfig?.ifieldsKey) return;
    const version = "3.4.2602.2001";
    const scriptId = `cardknox-ifields-${version}`;
    const configure = () => {
      if (window.setAccount) {
        window.setAccount(solaConfig.ifieldsKey!, "ConnectComms", "1.0.0");
        setIfieldsReady(true);
      }
    };
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (existing) { configure(); return; }
    const script = document.createElement("script");
    script.id = scriptId;
    script.src = `https://cdn.cardknox.com/ifields/${version}/ifields.min.js`;
    script.async = true;
    script.onload = configure;
    script.onerror = () => setAddCardMsg("Unable to load the secure card form. Contact support.");
    document.body.appendChild(script);
  }, [solaConfig]);

  async function setDefault(methodId: string) {
    setBusy(`default-${methodId}`);
    try {
      await apiPost(`/admin/billing/platform/tenants/${tenantId}/payment-methods/${methodId}/default`, {});
      showToast("ok", "Default card updated.");
      setRev((r) => r + 1);
    } catch (err) {
      showToast("err", billingErrorMessage(err, "Failed to set default."));
    } finally {
      setBusy(null);
    }
  }

  async function removeCard(methodId: string) {
    setBusy(`remove-${methodId}`);
    try {
      await apiDelete(`/admin/billing/platform/tenants/${tenantId}/payment-methods/${methodId}`);
      showToast("ok", "Card removed.");
      setRev((r) => r + 1);
      setRemoveTarget(null);
    } catch (err) {
      showToast("err", billingErrorMessage(err, "Failed to remove card."));
    } finally {
      setBusy(null);
    }
  }

  const ifieldsVersion = "3.4.2602.2001";
  const canAddCard = !!solaConfig?.enabled && !!solaConfig?.ifieldsKey;
  const isSandboxMode = solaConfig?.mode === "sandbox";

  return (
    <>
    <div style={{ ...overlayStyle, alignItems: "center", justifyContent: "center" }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ ...modalStyle, width: "min(640px, 96vw)", maxHeight: "90vh", overflowY: "auto" }}>
        <div className="row-actions" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Saved Cards — {tenantName}</h3>
          <button className="btn ghost" type="button" onClick={onClose}>✕</button>
        </div>

        {toast ? (
          <div className={`billing-toast billing-toast--${toast.kind}`} style={{ position: "relative", bottom: "auto", right: "auto", maxWidth: "100%", marginBottom: 12 }} role="status">
            {toast.text}
          </div>
        ) : null}

        {data.status === "loading" ? <LoadingSkeleton rows={3} /> : null}
        {data.status === "error" ? <ErrorState message={data.error} /> : null}

        {data.status === "success" && methods.length === 0 ? (
          <BillingEmptyState
            title="No payment methods on file"
            message="When this company saves a card, it appears here for autopay and manual charges. You can add a card below when the gateway is configured."
          />
        ) : null}

        {methods.map((m) => (
          <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border, #e0e0e0)", marginBottom: 8, flexWrap: "wrap" }}>
            <span style={{ flex: 1, fontSize: 13 }}>
              {cardLabel(m)}
              {m.isDefault ? <span style={{ marginLeft: 6, fontSize: 10, background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 5px" }}>Default</span> : null}
            </span>
            {m.lastSuccessfulCharge ? (
              <span style={{ fontSize: 11, color: "#6b7280" }}>
                Last charge: {dollars(m.lastSuccessfulCharge.amountCents)} on {fmtDate(m.lastSuccessfulCharge.createdAt)}
              </span>
            ) : (
              <span style={{ fontSize: 11, color: "#9ca3af" }}>No successful charges</span>
            )}
            <div className="row-actions" style={{ margin: 0 }}>
              {!m.isDefault ? (
                <button className="btn ghost" type="button" disabled={!!busy} onClick={() => void setDefault(m.id)} style={{ fontSize: 12 }}>
                  {busy === `default-${m.id}` ? "Setting…" : "Set default"}
                </button>
              ) : null}
              <button className="btn danger" type="button" disabled={!!busy} onClick={() => setRemoveTarget(m)} style={{ fontSize: 12 }}>
                {busy === `remove-${m.id}` ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        ))}

        {/* Add card section */}
        <div style={{ marginTop: 16, borderTop: "1px solid var(--border, #e0e0e0)", paddingTop: 14 }}>
          {!showAddCard ? (
            <button
              className="btn ghost"
              type="button"
              onClick={() => setShowAddCard(true)}
              disabled={solaConfig === null}
              style={{ fontSize: 13 }}
            >
              {solaConfig === null ? "Loading…" : canAddCard ? "+ Add card" : "+ Add card (gateway not configured)"}
            </button>
          ) : (
            <div>
              <div className="row-actions" style={{ marginBottom: 10 }}>
                <strong style={{ fontSize: 13 }}>Add a card</strong>
                <button className="btn ghost" type="button" style={{ fontSize: 12 }} onClick={() => { setShowAddCard(false); setAddCardMsg(""); }}>Cancel</button>
              </div>

              {isSandboxMode ? (
                <div style={{ marginBottom: 10, padding: "7px 10px", borderRadius: 6, background: "#fef9c3", border: "1px solid #fde68a", fontSize: 12, color: "#713f12" }}>
                  <strong>Sandbox mode</strong> — use test card numbers only. No real charges will be made.
                </div>
              ) : null}

              {!canAddCard ? (
                <div style={{ fontSize: 13, color: "#6b7280", padding: "10px 0" }}>
                  Hosted card capture is not configured for this company yet. Configure the payment gateway in Admin Billing → Company billing setup before adding cards.
                </div>
              ) : (
                <form
                  className="billing-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (submittedRef.current || addCardBusy) return;
                    const form = event.currentTarget;
                    setAddCardBusy(true);
                    setAddCardMsg("");
                    if (!window.getTokens) {
                      setAddCardBusy(false);
                      setAddCardMsg("The secure card form is not ready yet. Please wait a moment and try again.");
                      return;
                    }
                    window.getTokens(async () => {
                      submittedRef.current = true;
                      const formData = new FormData(form);
                      const xSut = String(formData.get("xCardNum") || "");
                      if (!xSut) {
                        setAddCardBusy(false);
                        submittedRef.current = false;
                        setAddCardMsg("The secure form did not return a card token. Verify the card number and try again.");
                        return;
                      }
                      try {
                        await apiPost(`/admin/billing/platform/tenants/${tenantId}/payment-methods/sola/save`, {
                          xSut,
                          cardholderName: String(formData.get("cardholderName") || ""),
                          billingZip: String(formData.get("billingZip") || ""),
                          makeDefault: methods.length === 0,
                        });
                        showToast("ok", "Card saved successfully.");
                        setShowAddCard(false);
                        setAddCardMsg("");
                        setRev((r) => r + 1);
                      } catch (err: unknown) {
                        setAddCardMsg(billingErrorMessage(err, "Unable to save this card."));
                      } finally {
                        setAddCardBusy(false);
                        submittedRef.current = false;
                      }
                    }, () => {
                      setAddCardBusy(false);
                      setAddCardMsg("The secure form could not tokenize the card. Verify the card details and try again.");
                    }, 30000);
                  }}
                >
                  <label>Cardholder name <input name="cardholderName" autoComplete="cc-name" placeholder="Jane Smith" /></label>
                  <label>Billing ZIP <input name="billingZip" autoComplete="postal-code" placeholder="10950" /></label>
                  <label>
                    Card number
                    <iframe
                      className="sola-ifield-frame"
                      title="Secure card number"
                      data-ifields-id="card-number"
                      data-ifields-placeholder="Card Number"
                      src={`https://cdn.cardknox.com/ifields/${ifieldsVersion}/ifield.htm`}
                    />
                  </label>
                  <label>
                    CVV
                    <iframe
                      className="sola-ifield-frame"
                      title="Secure CVV"
                      data-ifields-id="cvv"
                      data-ifields-placeholder="CVV"
                      src={`https://cdn.cardknox.com/ifields/${ifieldsVersion}/ifield.htm`}
                    />
                  </label>
                  <input name="xCardNum" data-ifields-id="card-number-token" type="hidden" />
                  <input name="xCVV" data-ifields-id="cvv-token" type="hidden" />
                  {addCardMsg ? <div className="billing-status-pill bad">{addCardMsg}</div> : null}
                  <button
                    className="btn primary"
                    type="submit"
                    disabled={addCardBusy || !ifieldsReady}
                    style={{ fontSize: 13 }}
                  >
                    {addCardBusy ? "Securing…" : ifieldsReady ? "Save card" : "Loading secure form…"}
                  </button>
                </form>
              )}
            </div>
          )}
        </div>

        <div style={{ marginTop: 16 }}>
          <button className="btn ghost" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
    {removeTarget ? (
      <BillingActionPanel
        layout="center"
        centerWidth="min(440px, 96vw)"
        variant="danger"
        onClose={() => { if (!busy) setRemoveTarget(null); }}
        eyebrow={tenantName}
        title="Remove saved card?"
        summary={<p style={{ margin: 0, fontSize: 14 }}>{cardLabel(removeTarget)}</p>}
        warning="The token is removed at the gateway. If this was the default card, pick a new default before the next autopay run."
        footer={(
          <>
            <button className="btn ghost" type="button" disabled={!!busy} onClick={() => setRemoveTarget(null)}>Cancel</button>
            <button className="btn danger" type="button" disabled={!!busy} onClick={() => void removeCard(removeTarget.id)}>
              {busy === `remove-${removeTarget.id}` ? "Removing…" : "Remove card"}
            </button>
          </>
        )}
      />
    ) : null}
    </>
  );
}

function TransactionDetailModal({ txId, onClose }: { txId: string; onClose: () => void }) {
  const data = useAsyncResource<TxDetail>(() => apiGet<TxDetail>(`/admin/billing/transactions/${txId}`), [txId]);
  const tx = data.status === "success" ? data.data : null;

  const rawEntries = useMemo(() => {
    if (!tx?.rawResponseSafeJson || typeof tx.rawResponseSafeJson !== "object") return [];
    return Object.entries(tx.rawResponseSafeJson as Record<string, unknown>).filter(([, v]) => v != null && v !== "");
  }, [tx]);

  return (
    <div style={{ ...overlayStyle, alignItems: "center", justifyContent: "center" }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ ...modalStyle, width: "min(580px, 96vw)" }}>
        <div className="row-actions" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Transaction Detail</h3>
          <button className="btn ghost" type="button" onClick={onClose}>✕ Close</button>
        </div>

        {data.status === "loading" ? <LoadingSkeleton rows={5} /> : null}
        {data.status === "error" ? <ErrorState message={data.error} /> : null}

        {tx ? (
          <div className="stack compact-stack">
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
              <div><span className="muted" style={{ fontSize: 12 }}>Status</span><br /><span className={`billing-status-pill ${txStatusClass(tx.status)}`}>{transactionStatusLabel(tx.status)}</span></div>
              <div><span className="muted" style={{ fontSize: 12 }}>Amount</span><br /><strong>{dollars(tx.amountCents)}</strong></div>
              <div><span className="muted" style={{ fontSize: 12 }}>Date</span><br />{fmtDatetime(tx.createdAt)}</div>
              <div><span className="muted" style={{ fontSize: 12 }}>Tenant</span><br />{tx.tenant?.name}</div>
            </div>

            {tx.invoice ? (
              <p style={{ fontSize: 13, margin: "0 0 8px" }}>
                Invoice: <strong>{tx.invoice.invoiceNumber || tx.invoiceId}</strong> · {tx.invoice.status} · {dollars(tx.invoice.totalCents)}
              </p>
            ) : null}

            {tx.paymentMethod ? (
              <p style={{ fontSize: 13, margin: "0 0 8px" }}>
                Card: {cardLabel(tx.paymentMethod)}
              </p>
            ) : null}

            <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse", marginBottom: 12 }}>
              <tbody>
                {tx.processorTransactionId ? (
                  <tr>
                    <td style={{ padding: "4px 0", color: "#6b7280", width: 160 }}>Processor Ref</td>
                    <td style={{ padding: "4px 0", fontFamily: "monospace" }}>{tx.processorTransactionId}</td>
                  </tr>
                ) : null}
                {tx.responseCode ? (
                  <tr>
                    <td style={{ padding: "4px 0", color: "#6b7280" }}>Response Code</td>
                    <td style={{ padding: "4px 0" }}>{tx.responseCode}</td>
                  </tr>
                ) : null}
                {tx.responseMessage ? (
                  <tr>
                    <td style={{ padding: "4px 0", color: "#6b7280" }}>Response Message</td>
                    <td style={{ padding: "4px 0" }}>{tx.responseMessage}</td>
                  </tr>
                ) : null}
                {tx.processor ? (
                  <tr>
                    <td style={{ padding: "4px 0", color: "#6b7280" }}>Processor</td>
                    <td style={{ padding: "4px 0" }}>{tx.processor}</td>
                  </tr>
                ) : null}
                {tx.idempotencyKey ? (
                  <tr>
                    <td style={{ padding: "4px 0", color: "#6b7280" }}>Idempotency Key</td>
                    <td style={{ padding: "4px 0", fontFamily: "monospace", fontSize: 11 }}>{tx.idempotencyKey}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>

            {rawEntries.length > 0 ? (
              <>
                <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>Gateway Response</h4>
                <div style={{ background: "var(--surface-alt, #f9fafb)", borderRadius: 6, padding: "10px 12px", fontSize: 12, fontFamily: "monospace", maxHeight: 200, overflowY: "auto" }}>
                  {rawEntries.map(([k, v]) => (
                    <div key={k} style={{ display: "flex", gap: 8, marginBottom: 2 }}>
                      <span style={{ color: "#6b7280", minWidth: 140 }}>{k}</span>
                      <span>{String(v)}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            <div style={{ marginTop: 16 }}>
              <button className="btn ghost" type="button" onClick={onClose}>Close</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── SmsPaymentLinkModal ────────────────────────────────────────────────────────

function SmsPaymentLinkModal({ invoice, onClose, onSuccess }: { invoice: InvoiceRow; onClose: () => void; onSuccess: () => void }) {
  const [step, setStep] = useState<"form" | "confirm" | "done">("form");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sentTo, setSentTo] = useState("");
  const submitted = useRef(false);

  const capability = useAsyncResource<SmsCapability>(
    () => apiGet<SmsCapability>(`/admin/billing/platform/tenants/${invoice.tenantId}/sms-capability`),
    [invoice.tenantId],
  );
  const cap = capability.status === "success" ? capability.data : null;

  const payUrl = `${typeof window !== "undefined" ? window.location.origin.replace(/:3000$/, ":3001") : ""}`
    + `/billing/invoices/${invoice.id}`;
  const msgPreview = `${invoice.tenant?.name || "Connect"}: Pay invoice ${invoice.invoiceNumber || invoice.id.slice(0, 8)} (${dollars(invoice.balanceDueCents)}): ${payUrl}`;

  async function send() {
    if (submitted.current || busy) return;
    submitted.current = true;
    setBusy(true);
    setError("");
    try {
      const res = await apiPost<{ ok: boolean; toPhone: string; fromPhone: string; providerMessageId?: string }>(
        `/admin/billing/invoices/${invoice.id}/sms-payment-link`,
        { phone, note: note.trim() || undefined },
      );
      setSentTo(res.toPhone);
      setStep("done");
      onSuccess();
    } catch (err) {
      setError(billingErrorMessage(err, "SMS send failed."));
      submitted.current = false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ ...overlayStyle, alignItems: "center", justifyContent: "center" }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ ...modalStyle, width: "min(500px, 96vw)" }}>
        <div className="row-actions" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: 0, flex: 1 }}>
            Send Payment Link via SMS
          </h3>
          <button className="btn ghost" type="button" onClick={onClose}>✕</button>
        </div>

        <p style={{ fontSize: 13, margin: "0 0 14px" }}>
          <strong>{invoice.tenant?.name}</strong> · Invoice {invoice.invoiceNumber || invoice.id.slice(0, 8)} · Balance: <strong>{dollars(invoice.balanceDueCents)}</strong>
        </p>

        {/* Provider capability check */}
        {capability.status === "loading" ? <LoadingSkeleton rows={3} /> : null}
        {capability.status === "error" ? <ErrorState message={capability.error} /> : null}

        {cap && !cap.capable ? (
          <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "12px 14px", marginBottom: 16, fontSize: 13 }}>
            <strong>SMS not available for this tenant.</strong>
            <p style={{ margin: "4px 0 0", color: "#6b7280" }}>{cap.reason}</p>
            <p style={{ margin: "8px 0 0", color: "#6b7280" }}>Configure Twilio or VoIP.ms credentials in the tenant SMS settings before using this feature.</p>
          </div>
        ) : null}

        {cap?.capable ? (
          <>
            <div style={{ background: "var(--surface-alt, #f9fafb)", borderRadius: 6, padding: "8px 12px", fontSize: 12, marginBottom: 14, color: "#6b7280" }}>
              From: <strong>{cap.fromNumber}</strong> · Provider: {cap.provider}
            </div>

            {step === "done" ? (
              <>
                <div style={{ color: "green", marginBottom: 16, fontSize: 14 }}>
                  ✓ Payment link sent to {sentTo}.
                </div>
                <button className="btn primary" type="button" onClick={onClose}>Close</button>
              </>
            ) : step === "confirm" ? (
              <>
                <div style={{ background: "var(--surface-alt, #f9fafb)", borderRadius: 8, padding: "12px 14px", marginBottom: 14, fontSize: 13 }}>
                  <p style={{ margin: "0 0 6px" }}>
                    Sending to: <strong>{phone}</strong>
                  </p>
                  <p style={{ margin: "0 0 6px", color: "#6b7280", fontSize: 12 }}>
                    Message preview (approximate):
                  </p>
                  <div style={{ fontFamily: "monospace", fontSize: 11, background: "#fff", borderRadius: 4, padding: "8px 10px", border: "1px solid var(--border, #e0e0e0)", wordBreak: "break-all" }}>
                    {msgPreview}
                  </div>
                  {note ? <p style={{ margin: "8px 0 0", color: "#6b7280", fontSize: 12 }}>Note: {note}</p> : null}
                </div>
                {error ? <div style={{ color: "#dc2626", marginBottom: 10, fontSize: 13 }}>{error}</div> : null}
                <div className="row-actions">
                  <button className="btn primary" type="button" disabled={busy} onClick={send}>
                    {busy ? "Sending…" : "Send SMS"}
                  </button>
                  <button className="btn ghost" type="button" disabled={busy} onClick={() => { setStep("form"); submitted.current = false; }}>
                    ← Back
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>
                    Destination phone number: <span style={{ color: "#dc2626" }}>*</span>
                  </label>
                  <input
                    type="tel"
                    maxLength={20}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+1 (555) 555-5555"
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border, #e0e0e0)", fontSize: 13, boxSizing: "border-box" }}
                  />
                  <p style={{ margin: "4px 0 0", fontSize: 11, color: "#6b7280" }}>
                    US numbers: enter 10 digits or +1 format. International: include + and country code.
                  </p>
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>
                    Operator note (optional — logged to activity):
                  </label>
                  <input
                    type="text"
                    maxLength={300}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. Customer requested resend"
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border, #e0e0e0)", fontSize: 13, boxSizing: "border-box" }}
                  />
                </div>

                {error ? <div style={{ color: "#dc2626", marginBottom: 10, fontSize: 13 }}>{error}</div> : null}

                <div className="row-actions">
                  <button
                    className="btn primary"
                    type="button"
                    disabled={phone.trim().length < 7}
                    onClick={() => setStep("confirm")}
                  >
                    Preview &amp; confirm →
                  </button>
                  <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
                </div>
              </>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Invoices tab ──────────────────────────────────────────────────────────────

function InvoicesTab() {
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [logInvoiceId, setLogInvoiceId] = useState<string | null>(null);
  const [logEvents, setLogEvents] = useState<{ id: string; type: string; message: string | null; createdAt: string; metadata?: unknown }[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState("");

  // Modal state
  const [detailInvoiceId, setDetailInvoiceId] = useState<string | null>(null);
  const [payInvoice, setPayInvoice] = useState<InvoiceRow | null>(null);
  const [cardsForTenant, setCardsForTenant] = useState<{ tenantId: string; name: string } | null>(null);
  const [smsInvoice, setSmsInvoice] = useState<InvoiceRow | null>(null);
  const [listRev, setListRev] = useState(0);
  const [markPaidTarget, setMarkPaidTarget] = useState<InvoiceRow | null>(null);
  const [voidTarget, setVoidTarget] = useState<InvoiceRow | null>(null);

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const url = useMemo(() => {
    const p = new URLSearchParams();
    if (statusFilter !== "ALL") p.set("status", statusFilter);
    if (search) p.set("search", search);
    p.set("page", String(page));
    p.set("limit", "50");
    return `/admin/billing/invoices?${p.toString()}`;
  }, [statusFilter, search, page, listRev]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = useAsyncResource<InvoiceListResult>(() => apiGet<InvoiceListResult>(url), [url]);
  const rows = data.status === "success" ? data.data.invoices : [];

  const showToast = useCallback((kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  async function act(invoiceId: string, label: string, path: string, body: Record<string, unknown> = {}): Promise<boolean> {
    setBusy(`${label}-${invoiceId}`);
    try {
      await apiPost(path, body);
      showToast("ok", `${label} succeeded.`);
      setListRev((r) => r + 1);
      return true;
    } catch (err) {
      showToast("err", billingErrorMessage(err, `${label} failed.`));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function toggleLog(invoiceId: string) {
    if (logInvoiceId === invoiceId) { setLogInvoiceId(null); return; }
    setLogInvoiceId(invoiceId);
    setLogLoading(true);
    setLogError("");
    setLogEvents([]);
    try {
      const res = await apiGet<{ events: typeof logEvents }>(`/admin/billing/invoices/${invoiceId}/events`);
      setLogEvents(res.events || []);
    } catch (err: any) {
      setLogError(err?.message || "Failed to load events.");
    } finally {
      setLogLoading(false);
    }
  }

  return (
    <div data-testid="billing-admin-tab-panel-invoices">
      {toast ? (
        <div className={`billing-toast billing-toast--${toast.kind}`} style={{ position: "relative", bottom: "auto", right: "auto", maxWidth: "100%" }} role="status">
          {toast.text}
        </div>
      ) : null}

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <div className="b3-filter-pills" style={{ margin: 0 }}>
          {INV_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={`btn ${statusFilter === s ? "primary" : "ghost"}`}
              onClick={() => {
                setStatusFilter(s);
                setPage(1);
              }}
            >
              {s === "ALL" ? "All" : s}
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="Search invoice # or tenant…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border, #e0e0e0)", fontSize: 13, minWidth: 220 }}
        />
      </div>

      {data.status === "loading" ? <LoadingSkeleton rows={8} /> : null}
      {data.status === "error" ? <ErrorState message={data.error} /> : null}

      {data.status === "success" ? (
        <>
          <p className="muted" style={{ marginBottom: 8 }}>
            {data.data.total} invoice{data.data.total !== 1 ? "s" : ""}
            {statusFilter !== "ALL" ? ` · status: ${statusFilter}` : ""}
            {search ? ` · matching "${search}"` : ""}
          </p>
          <div className="billing-invoice-stack">
            {rows.length === 0 ? (
              <BillingEmptyState
                title="No invoices in this view"
                message="Try clearing the status filter or widening your search. Invoices appear here as soon as they are generated for any company."
              />
            ) : null}
            {rows.map((inv) => {
              const canAct = inv.status !== "PAID" && inv.status !== "VOID";
              const period = fmtPeriod(inv.periodStart, inv.periodEnd);
              const isLogOpen = logInvoiceId === inv.id;
              const isBusy = (label: string) => busy === `${label}-${inv.id}`;

              return (
                <div className="b3-inv-row" key={inv.id}>
                  <div className="b3-inv-row-main">
                    <strong>{inv.invoiceNumber || inv.id.slice(0, 8)}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {inv.tenant?.name || inv.tenantId}
                      {period ? ` · ${period}` : ""}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12 }} className="muted">
                      Due {fmtDate(inv.dueDate)}
                      {inv.paidAt ? ` · Paid ${fmtDate(inv.paidAt)}` : ""}
                      {inv.failedAt && !inv.paidAt ? ` · Failed ${fmtDate(inv.failedAt)}` : ""}
                    </div>
                  </div>

                  <em style={{ minWidth: 88, textAlign: "right", fontStyle: "normal", fontWeight: 600 }}>
                    {dollars(inv.totalCents)}
                    {inv.balanceDueCents > 0 && inv.status !== "PAID" ? (
                      <div style={{ fontSize: 11, fontWeight: 500, color: "var(--muted)" }}>Due {dollars(inv.balanceDueCents)}</div>
                    ) : null}
                  </em>

                  <span className={`billing-status-pill ${invStatusClass(inv.status)}`}>{invoiceStatusLabel(inv.status)}</span>

                  <div className="b3-inv-actions">
                    <button className="btn primary" type="button" onClick={() => setDetailInvoiceId(inv.id)}>
                      View
                    </button>

                    <details className="b3-menu">
                      <summary>More actions</summary>
                      <div className="b3-menu-panel" onClick={(e) => e.stopPropagation()}>
                        {canAct ? (
                          <button
                            type="button"
                            disabled={!!busy}
                            onClick={(e) => {
                              void act(inv.id, "Send", `/admin/billing/invoices/${inv.id}/send`);
                              (e.currentTarget as HTMLButtonElement).closest("details")?.removeAttribute("open");
                            }}
                          >
                            {isBusy("Send") ? "Sending…" : "Email invoice"}
                          </button>
                        ) : null}
                        {canAct ? (
                          <button
                            type="button"
                            disabled={!!busy}
                            onClick={(e) => {
                              void act(inv.id, "Email link", `/billing/platform/invoices/${inv.id}/email-payment-link`);
                              (e.currentTarget as HTMLButtonElement).closest("details")?.removeAttribute("open");
                            }}
                          >
                            {isBusy("Email link") ? "Sending…" : "Email payment link"}
                          </button>
                        ) : null}
                        {canAct ? (
                          <button
                            type="button"
                            disabled={!!busy}
                            onClick={(e) => {
                              setPayInvoice(inv);
                              (e.currentTarget as HTMLButtonElement).closest("details")?.removeAttribute("open");
                            }}
                          >
                            Retry payment…
                          </button>
                        ) : null}
                        {canAct ? (
                          <button
                            type="button"
                            disabled={!!busy}
                            onClick={(e) => {
                              setMarkPaidTarget(inv);
                              (e.currentTarget as HTMLButtonElement).closest("details")?.removeAttribute("open");
                            }}
                          >
                            Mark paid…
                          </button>
                        ) : null}
                        <button type="button" onClick={() => openAdminInvoicePdf(inv.id)}>
                          Download PDF
                        </button>
                        {canAct ? (
                          <button
                            type="button"
                            className="b3-menu-danger"
                            disabled={!!busy}
                            onClick={(e) => {
                              setVoidTarget(inv);
                              (e.currentTarget as HTMLButtonElement).closest("details")?.removeAttribute("open");
                            }}
                          >
                            Void invoice…
                          </button>
                        ) : null}
                        {canAct ? (
                          <button
                            type="button"
                            disabled={!!busy}
                            onClick={(e) => {
                              setSmsInvoice(inv);
                              (e.currentTarget as HTMLButtonElement).closest("details")?.removeAttribute("open");
                            }}
                          >
                            SMS payment link
                          </button>
                        ) : null}
                      </div>
                    </details>

                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => setCardsForTenant({ tenantId: inv.tenantId, name: inv.tenant?.name || inv.tenantId })}
                      title="Manage saved cards"
                    >
                      Cards
                    </button>

                    <button className="btn ghost" type="button" onClick={() => void toggleLog(inv.id)}>
                      {isLogOpen ? "Hide log" : "Activity"}
                    </button>
                  </div>

                  {/* Inline event log */}
                  {isLogOpen ? (
                    <div style={{ width: "100%", marginTop: 8 }}>
                      {logLoading ? <p className="muted">Loading events…</p> : null}
                      {logError ? <ErrorState message={logError} /> : null}
                      {!logLoading && !logError && logEvents.length === 0 ? (
                        <BillingEmptyState
                          title="No activity for this row"
                          message="Open the invoice drawer for the full ledger. Inline activity loads the same audit trail in compact form."
                        />
                      ) : null}
                      {!logLoading && !logError && logEvents.length > 0 ? (
                        <BillingActivityList
                          events={logEvents.map((e) => ({ ...e, id: e.id ?? `${inv.id}-${e.createdAt}` }))}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <Pager page={data.data.page} pages={data.data.pages} onPage={(p) => setPage(p)} />
        </>
      ) : null}

      {/* Modals */}
      {detailInvoiceId ? (
        <InvoiceDetailModal
          invoiceId={detailInvoiceId}
          onClose={() => setDetailInvoiceId(null)}
          onAction={() => setListRev((r) => r + 1)}
        />
      ) : null}

      {payInvoice ? (
        <ManualPayModal
          invoice={payInvoice}
          onClose={() => setPayInvoice(null)}
          onSuccess={() => { setListRev((r) => r + 1); }}
        />
      ) : null}

      {cardsForTenant ? (
        <PaymentMethodsModal
          tenantId={cardsForTenant.tenantId}
          tenantName={cardsForTenant.name}
          onClose={() => setCardsForTenant(null)}
        />
      ) : null}

      {smsInvoice ? (
        <SmsPaymentLinkModal
          invoice={smsInvoice}
          onClose={() => setSmsInvoice(null)}
          onSuccess={() => setListRev((r) => r + 1)}
        />
      ) : null}

      {markPaidTarget ? (
        <BillingActionPanel
          layout="drawer"
          drawerWidth="min(440px, 100vw)"
          onClose={() => { if (!busy) setMarkPaidTarget(null); }}
          eyebrow={markPaidTarget.tenant?.name || "Company"}
          title="Record invoice as paid?"
          subtitle="Use this when funds already cleared outside autopay (wire, check, or manual processor). The balance will read zero and the invoice will show Paid."
          summary={(
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li><strong>Invoice</strong> {markPaidTarget.invoiceNumber || markPaidTarget.id.slice(0, 8)}</li>
              <li><strong>Total</strong> {dollars(markPaidTarget.totalCents)}</li>
              <li><strong>Balance due</strong> {dollars(markPaidTarget.balanceDueCents)}</li>
              <li><strong>Status</strong> {invoiceStatusLabel(markPaidTarget.status)}</li>
            </ul>
          )}
          notice="Recommended next step: attach your internal reference in your accounting system — Connect stores the status change only."
          footer={(
            <>
              <button className="btn ghost" type="button" disabled={!!busy} onClick={() => setMarkPaidTarget(null)}>Cancel</button>
              <button
                className="btn primary"
                type="button"
                disabled={!!busy}
                onClick={async () => {
                  const ok = await act(markPaidTarget.id, "Mark paid", `/admin/billing/invoices/${markPaidTarget.id}/mark-paid`);
                  if (ok) setMarkPaidTarget(null);
                }}
              >
                {busy === `Mark paid-${markPaidTarget.id}` ? "Recording…" : "Record as paid"}
              </button>
            </>
          )}
        />
      ) : null}

      {voidTarget ? (
        <BillingActionPanel
          layout="drawer"
          drawerWidth="min(440px, 100vw)"
          variant="danger"
          onClose={() => { if (!busy) setVoidTarget(null); }}
          eyebrow={voidTarget.tenant?.name || "Company"}
          title="Void this invoice?"
          subtitle="Voiding freezes this invoice for payment. Use it for incorrect or duplicate bills — not as a substitute for refunds on settled charges."
          summary={(
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li><strong>Invoice</strong> {voidTarget.invoiceNumber || voidTarget.id.slice(0, 8)}</li>
              <li><strong>Total</strong> {dollars(voidTarget.totalCents)}</li>
              <li><strong>Balance due</strong> {dollars(voidTarget.balanceDueCents)}</li>
              <li><strong>Status</strong> {invoiceStatusLabel(voidTarget.status)}</li>
            </ul>
          )}
          warning="This cannot be undone in the portal. If the customer still owes, create a replacement invoice after voiding."
          footer={(
            <>
              <button className="btn ghost" type="button" disabled={!!busy} onClick={() => setVoidTarget(null)}>Cancel</button>
              <button
                className="btn danger"
                type="button"
                disabled={!!busy}
                onClick={async () => {
                  const ok = await act(voidTarget.id, "Void", `/admin/billing/invoices/${voidTarget.id}/void`);
                  if (ok) setVoidTarget(null);
                }}
              >
                {busy === `Void-${voidTarget.id}` ? "Voiding…" : "Void invoice"}
              </button>
            </>
          )}
        />
      ) : null}
    </div>
  );
}

// ── Transactions tab ──────────────────────────────────────────────────────────

function TransactionsTab() {
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [detailTxId, setDetailTxId] = useState<string | null>(null);

  const url = useMemo(() => {
    const p = new URLSearchParams();
    if (statusFilter !== "ALL") p.set("status", statusFilter);
    p.set("page", String(page));
    p.set("limit", "50");
    return `/admin/billing/transactions?${p.toString()}`;
  }, [statusFilter, page]);

  const data = useAsyncResource<TxListResult>(() => apiGet<TxListResult>(url), [url]);

  const txColumns = [
    { key: "date", label: "Date", render: (r: TxRow) => fmtDatetime(r.createdAt) },
    { key: "tenant", label: "Tenant", render: (r: TxRow) => r.tenant?.name || r.tenantId },
    { key: "inv", label: "Invoice", render: (r: TxRow) => r.invoice?.invoiceNumber || r.invoiceId || "—" },
    { key: "amt", label: "Amount", render: (r: TxRow) => dollars(r.amountCents) },
    {
      key: "status",
      label: "Status",
      render: (r: TxRow) => (
        <span className={`billing-status-pill ${txStatusClass(r.status)}`}>{transactionStatusLabel(r.status)}</span>
      ),
    },
    { key: "method", label: "Card", render: (r: TxRow) => r.paymentMethod ? `${r.paymentMethod.brand || "Card"} ···${r.paymentMethod.last4 || "----"}` : "—" },
    { key: "ref", label: "Processor Ref", render: (r: TxRow) => r.processorTransactionId || "—" },
    { key: "code", label: "Response", render: (r: TxRow) => r.responseCode || "—" },
    {
      key: "detail",
      label: "",
      render: (r: TxRow) => (
        <button className="btn ghost" type="button" onClick={() => setDetailTxId(r.id)} style={{ fontSize: 12, padding: "2px 8px" }}>
          Detail
        </button>
      ),
    },
  ];

  return (
    <>
      <div className="row-actions" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        {TX_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={`btn ${statusFilter === s ? "primary" : "ghost"}`}
            onClick={() => { setStatusFilter(s); setPage(1); }}
          >
            {s}
          </button>
        ))}
      </div>

      {data.status === "loading" ? <LoadingSkeleton rows={8} /> : null}
      {data.status === "error" ? <ErrorState message={data.error} /> : null}

      {data.status === "success" ? (
        <>
          <p className="muted" style={{ marginBottom: 8 }}>
            {data.data.total} transaction{data.data.total !== 1 ? "s" : ""}
            {statusFilter !== "ALL" ? ` · status: ${statusFilter}` : ""}
          </p>
          {data.data.transactions.length === 0 ? (
            <BillingEmptyState
              title="No transactions in this view"
              message="Adjust the status chips above or load a different page. Each row is a processor attempt tied to an invoice when available."
            />
          ) : (
            <div className="billing-ops-table-wrap billing-ops-scroll">
              <DataTable rows={data.data.transactions} columns={txColumns} />
            </div>
          )}
          <Pager page={data.data.page} pages={data.data.pages} onPage={(p) => setPage(p)} />
        </>
      ) : null}

      {detailTxId ? (
        <TransactionDetailModal txId={detailTxId} onClose={() => setDetailTxId(null)} />
      ) : null}
    </>
  );
}

// ── Reports tab ───────────────────────────────────────────────────────────────

type AgingRow = {
  invoiceId: string;
  invoiceNumber: string | null;
  tenantId: string;
  tenantName: string;
  status: string;
  dueDate: string | null;
  daysOverdue: number;
  balanceDueCents: number;
  totalCents: number;
};

type FailedPaymentRow = {
  invoiceId: string;
  invoiceNumber: string | null;
  tenantId: string;
  tenantName: string;
  totalCents: number;
  balanceDueCents: number;
  status: string;
  lastFailureReason: string | null;
  lastResponseCode: string | null;
  lastAttemptAt: string | null;
  failedAt: string | null;
};

type AgingResult = { rows: AgingRow[]; capped: boolean };
type FailedPaymentsResult = { rows: FailedPaymentRow[]; capped: boolean };

function CappedNotice({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div style={{ padding: "6px 10px", borderRadius: 6, background: "#fef9c3", border: "1px solid #fde68a", fontSize: 12, color: "#713f12", marginBottom: 8 }}>
      ⚠ Result set is capped — not all records are shown. Use filters or export CSV to retrieve more data.
    </div>
  );
}

function ReportsTab() {
  // Aging report state
  const [agingData, setAgingData] = useState<AgingResult | null>(null);
  const [agingLoading, setAgingLoading] = useState(false);
  const [agingError, setAgingError] = useState<string | null>(null);

  // Failed payments report state
  const [failedData, setFailedData] = useState<FailedPaymentsResult | null>(null);
  const [failedLoading, setFailedLoading] = useState(false);
  const [failedError, setFailedError] = useState<string | null>(null);

  // CSV export filter state
  const [exportStatus, setExportStatus] = useState("ALL");

  function buildExportHref(type: "invoices" | "transactions") {
    const p = new URLSearchParams();
    if (exportStatus !== "ALL") p.set("status", exportStatus);
    return `/api/admin/billing/reports/export/${type}?${p.toString()}`;
  }

  async function loadAging() {
    setAgingLoading(true);
    setAgingError(null);
    try {
      const result = await apiGet<AgingResult>("/admin/billing/reports/aging");
      setAgingData(result);
    } catch (err: unknown) {
      setAgingError(billingErrorMessage(err, "Failed to load aging report."));
    } finally {
      setAgingLoading(false);
    }
  }

  async function loadFailedPayments() {
    setFailedLoading(true);
    setFailedError(null);
    try {
      const result = await apiGet<FailedPaymentsResult>("/admin/billing/reports/failed-payments");
      setFailedData(result);
    } catch (err: unknown) {
      setFailedError(billingErrorMessage(err, "Failed to load failed payments report."));
    } finally {
      setFailedLoading(false);
    }
  }

  const agingColumns = [
    { key: "tenant", label: "Tenant", render: (r: AgingRow) => r.tenantName },
    { key: "inv", label: "Invoice #", render: (r: AgingRow) => r.invoiceNumber || "—" },
    {
      key: "status", label: "Status",
      render: (r: AgingRow) => <span className={`billing-status-pill ${invStatusClass(r.status)}`}>{r.status}</span>,
    },
    { key: "due", label: "Due Date", render: (r: AgingRow) => fmtDate(r.dueDate) },
    {
      key: "overdue", label: "Days Overdue",
      render: (r: AgingRow) => (
        <span style={{ color: r.daysOverdue > 0 ? "var(--danger, #dc2626)" : "inherit", fontWeight: r.daysOverdue > 30 ? 700 : 400 }}>
          {r.daysOverdue > 0 ? `${r.daysOverdue}d` : "—"}
        </span>
      ),
    },
    { key: "balance", label: "Balance Due", render: (r: AgingRow) => <strong style={{ color: "var(--danger, #dc2626)" }}>{dollars(r.balanceDueCents)}</strong> },
    { key: "total", label: "Total", render: (r: AgingRow) => dollars(r.totalCents) },
  ];

  const failedColumns = [
    { key: "tenant", label: "Tenant", render: (r: FailedPaymentRow) => r.tenantName },
    { key: "inv", label: "Invoice #", render: (r: FailedPaymentRow) => r.invoiceNumber || "—" },
    {
      key: "status", label: "Status",
      render: (r: FailedPaymentRow) => <span className={`billing-status-pill ${invStatusClass(r.status)}`}>{r.status}</span>,
    },
    { key: "total", label: "Amount", render: (r: FailedPaymentRow) => dollars(r.totalCents) },
    { key: "balance", label: "Balance Due", render: (r: FailedPaymentRow) => dollars(r.balanceDueCents) },
    { key: "reason", label: "Last Failure Reason", render: (r: FailedPaymentRow) => r.lastFailureReason || "—" },
    { key: "code", label: "Response Code", render: (r: FailedPaymentRow) => r.lastResponseCode || "—" },
    { key: "attempt", label: "Last Attempt", render: (r: FailedPaymentRow) => fmtDatetime(r.lastAttemptAt) },
  ];

  return (
    <div className="stack compact-stack" data-testid="billing-admin-tab-panel-reports">
      <div style={{ background: "var(--surface-alt, #f9fafb)", border: "1px solid var(--border, #e0e0e0)", borderRadius: 8, padding: "16px 20px" }}>
        <h4 style={{ margin: "0 0 10px" }}>CSV Exports</h4>
        <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          Downloads are generated server-side and include all matching rows (up to the safety cap). Files are named with today&apos;s date.
        </p>

        <div className="row-actions" style={{ marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
          <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
            Status filter:
            <select
              value={exportStatus}
              onChange={(e) => setExportStatus(e.target.value)}
              style={{ fontSize: 13, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--border, #d1d5db)" }}
            >
              {INV_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>

        <div className="row-actions" style={{ flexWrap: "wrap", gap: 8 }}>
          <a
            className="btn ghost"
            href={buildExportHref("invoices")}
            download
            style={{ fontSize: 13, textDecoration: "none" }}
          >
            ⬇ Download invoices CSV
          </a>
          <a
            className="btn ghost"
            href={buildExportHref("transactions")}
            download
            style={{ fontSize: 13, textDecoration: "none" }}
          >
            ⬇ Download transactions CSV
          </a>
        </div>
      </div>

      {/* ── Aging Report ────────────────────────────────────────────────── */}
      <div style={{ background: "var(--surface-alt, #f9fafb)", border: "1px solid var(--border, #e0e0e0)", borderRadius: 8, padding: "16px 20px" }}>
        <div className="row-actions" style={{ marginBottom: 8 }}>
          <h4 style={{ margin: 0, flex: 1 }}>Aging Report</h4>
          <button
            className="btn ghost"
            type="button"
            onClick={loadAging}
            disabled={agingLoading}
            style={{ fontSize: 13 }}
          >
            {agingLoading ? "Loading…" : agingData ? "↻ Refresh" : "Load report"}
          </button>
          {agingData && (
            <a
              className="btn ghost"
              href="/api/admin/billing/reports/aging/export"
              download
              style={{ fontSize: 13, textDecoration: "none" }}
            >
              ⬇ CSV
            </a>
          )}
        </div>
        <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
          All open invoices with outstanding balance, sorted by due date ascending.
        </p>

        {agingError ? <div className="billing-status-pill bad" style={{ marginBottom: 8 }}>{agingError}</div> : null}

        {agingData ? (
          <>
            <CappedNotice visible={agingData.capped} />
            <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              {agingData.rows.length} invoice{agingData.rows.length !== 1 ? "s" : ""}
              {agingData.capped ? " (capped)" : ""}
            </p>
            {agingData.rows.length === 0 ? (
              <BillingEmptyState
                title="Nothing overdue in this report"
                message="Either every open balance is healthy, or run the report after generating invoices. Export CSV when you need a wider slice."
              />
            ) : (
              <div className="billing-ops-table-wrap billing-ops-scroll">
                <DataTable rows={agingData.rows.map((r) => ({ ...r, id: r.invoiceId }))} columns={agingColumns} />
              </div>
            )}
          </>
        ) : (
          !agingLoading && <p className="muted" style={{ fontSize: 13 }}>Click &quot;Load report&quot; to run the aging report.</p>
        )}
      </div>

      {/* ── Failed Payments Report ───────────────────────────────────────── */}
      <div style={{ background: "var(--surface-alt, #f9fafb)", border: "1px solid var(--border, #e0e0e0)", borderRadius: 8, padding: "16px 20px" }}>
        <div className="row-actions" style={{ marginBottom: 8 }}>
          <h4 style={{ margin: 0, flex: 1 }}>Failed Payments</h4>
          <button
            className="btn ghost"
            type="button"
            onClick={loadFailedPayments}
            disabled={failedLoading}
            style={{ fontSize: 13 }}
          >
            {failedLoading ? "Loading…" : failedData ? "↻ Refresh" : "Load report"}
          </button>
          {failedData && (
            <a
              className="btn ghost"
              href="/api/admin/billing/reports/failed-payments/export"
              download
              style={{ fontSize: 13, textDecoration: "none" }}
            >
              ⬇ CSV
            </a>
          )}
        </div>
        <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
          Invoices in FAILED or OVERDUE status with last processor response.
        </p>

        {failedError ? <div className="billing-status-pill bad" style={{ marginBottom: 8 }}>{failedError}</div> : null}

        {failedData ? (
          <>
            <CappedNotice visible={failedData.capped} />
            <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              {failedData.rows.length} invoice{failedData.rows.length !== 1 ? "s" : ""}
              {failedData.capped ? " (capped)" : ""}
            </p>
            {failedData.rows.length === 0 ? (
              <BillingEmptyState
                title="No failed payments in this report"
                message="When cards decline, they land here with the processor message. Refresh after the next billing run or retry from the Invoices tab."
              />
            ) : (
              <div className="billing-ops-table-wrap billing-ops-scroll">
                <DataTable rows={failedData.rows.map((r) => ({ ...r, id: r.invoiceId }))} columns={failedColumns} />
              </div>
            )}
          </>
        ) : (
          !failedLoading && <p className="muted" style={{ fontSize: 13 }}>Click &quot;Load report&quot; to run the failed payments report.</p>
        )}
      </div>

    </div>
  );
}

// ── Collections tab ───────────────────────────────────────────────────────────

type CollectionsRow = {
  invoiceId: string;
  invoiceNumber: string | null;
  tenantId: string;
  tenantName: string;
  status: string;
  balanceDueCents: number;
  totalCents: number;
  dueDate: string | null;
  failedAt: string | null;
  dunningAttempts: number;
  dunningMaxAttempts: number;
  nextRetryAt: string | null;
  collections: {
    status: "NORMAL" | "PAUSED" | "DO_NOT_CHARGE";
    paused: boolean;
    doNotCharge: boolean;
    skipNextRetry: boolean;
    pausedBy: string | null;
    pauseReason: string | null;
    updatedAt: string | null;
  };
  lastFailureReason: string | null;
};

type CollectionsOverview = {
  counts: { failed: number; retryEligible: number; paused: number; exhausted: number; doNotCharge: number };
  retryEligible: CollectionsRow[];
  paused: CollectionsRow[];
  exhausted: CollectionsRow[];
  previewNote: string;
};

type PreviewRetriesResult = { rows: CollectionsRow[]; note: string };

function collectionsStatusPill(s: string) {
  if (s === "DO_NOT_CHARGE") return "bad";
  if (s === "PAUSED") return "warn";
  return "ok";
}

function collectionsHumanLabel(s: string) {
  if (s === "DO_NOT_CHARGE") return "Auto-charge off";
  if (s === "PAUSED") return "Paused";
  return "Active";
}

function CollectionsRowTable({ rows, onOpenInvoice }: { rows: CollectionsRow[]; onOpenInvoice: (id: string) => void }) {
  if (rows.length === 0) return <p className="muted" style={{ fontSize: 13 }}>None.</p>;
  return (
    <div className="billing-ops-table-wrap billing-ops-scroll">
      <DataTable
        rows={rows.map((r) => ({ ...r, id: r.invoiceId }))}
        columns={[
          { key: "inv", label: "Invoice", render: (r: CollectionsRow) => (
            <button className="btn ghost" type="button" style={{ fontSize: 12, padding: "2px 8px" }} onClick={() => onOpenInvoice(r.invoiceId)}>
              {r.invoiceNumber || r.invoiceId.slice(0, 8)}
            </button>
          )},
          { key: "tenant", label: "Company", render: (r: CollectionsRow) => r.tenantName },
          { key: "status", label: "Invoice status", render: (r: CollectionsRow) => <span className={`billing-status-pill ${invStatusClass(r.status)}`}>{invoiceStatusLabel(r.status)}</span> },
          { key: "col", label: "Retry state", render: (r: CollectionsRow) => <span className={`billing-status-pill ${collectionsStatusPill(r.collections.status)}`}>{collectionsHumanLabel(r.collections.status)}</span> },
          { key: "bal", label: "Balance", render: (r: CollectionsRow) => <strong style={{ color: "var(--danger, #dc2626)" }}>{dollars(r.balanceDueCents)}</strong> },
          { key: "att", label: "Attempts", render: (r: CollectionsRow) => `${r.dunningAttempts}/${r.dunningMaxAttempts}` },
          { key: "next", label: "Next retry", render: (r: CollectionsRow) => r.nextRetryAt ? fmtDatetime(r.nextRetryAt) : "—" },
          { key: "fail", label: "Last failure", render: (r: CollectionsRow) => r.lastFailureReason ? <span style={{ fontSize: 11 }}>{r.lastFailureReason}</span> : "—" },
        ]}
      />
    </div>
  );
}

function CollectionsTab() {
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);
  const [overviewRev, setOverviewRev] = useState(0);
  const [previewRev, setPreviewRev] = useState(0);
  const [overviewLoaded, setOverviewLoaded] = useState(false);
  const [previewLoaded, setPreviewLoaded] = useState(false);

  const [overview, setOverview] = useState<CollectionsOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [preview, setPreview] = useState<PreviewRetriesResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    setOverviewError(null);
    try {
      const r = await apiGet<CollectionsOverview>("/admin/billing/collections/overview");
      setOverview(r);
      setOverviewLoaded(true);
    } catch (err: unknown) {
      setOverviewError(billingErrorMessage(err, "Failed to load collections overview."));
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const loadPreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const r = await apiGet<PreviewRetriesResult>("/admin/billing/collections/preview-retries");
      setPreview(r);
      setPreviewLoaded(true);
    } catch (err: unknown) {
      setPreviewError(billingErrorMessage(err, "Failed to load preview."));
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  // Re-load on rev bump
  useEffect(() => {
    if (overviewLoaded) void loadOverview();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overviewRev]);

  useEffect(() => {
    if (previewLoaded) void loadPreview();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewRev]);

  function afterInvoiceAction() {
    if (overviewLoaded) setOverviewRev((r) => r + 1);
    if (previewLoaded) setPreviewRev((r) => r + 1);
  }

  return (
    <div className="stack compact-stack" data-testid="billing-admin-tab-panel-collections">
      <p className="b3-muted" style={{ marginBottom: 12, maxWidth: 720 }}>
        Track automatic payment retries. Pausing or skipping affects the next scheduled run only — changes are picked up on the regular retry cycle.
      </p>

      {/* Overview section */}
      <div style={{ padding: "14px 16px", background: "var(--surface, #fff)", border: "1px solid var(--border, #e2e8f0)", borderRadius: 10 }}>
        <div className="row-actions" style={{ marginBottom: 8 }}>
          <h4 style={{ margin: 0, fontWeight: 700 }}>Queue overview</h4>
          <button className="btn ghost" type="button" style={{ fontSize: 12 }} disabled={overviewLoading} onClick={() => {
            if (!overviewLoaded) { void loadOverview(); } else { setOverviewRev((r) => r + 1); }
          }}>
            {overviewLoading ? "Loading…" : overviewLoaded ? "Refresh" : "Load queue"}
          </button>
        </div>
        {overviewError ? <ErrorState message={overviewError} /> : null}
        {overviewLoading ? <LoadingSkeleton rows={3} /> : null}
        {overview && !overviewLoading ? (
          <div className="stack compact-stack">
            {/* Count badges */}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
              {[
                { label: "Open / failed", value: overview.counts.failed, style: "bad" },
                { label: "Ready to retry", value: overview.counts.retryEligible, style: "warn" },
                { label: "Paused", value: overview.counts.paused, style: "warn" },
                { label: "Max retries hit", value: overview.counts.exhausted, style: "bad" },
                { label: "Auto-charge off", value: overview.counts.doNotCharge, style: "bad" },
              ].map(({ label, value, style }) => (
                <div key={label} style={{ textAlign: "center" }}>
                  <div className={`billing-status-pill ${style}`} style={{ fontSize: 18, fontWeight: 700, padding: "4px 14px" }}>{value}</div>
                  <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Retry-eligible */}
            {overview.retryEligible.length > 0 && (
              <>
                <h5 style={{ margin: "12px 0 4px", fontSize: 13, fontWeight: 600 }}>Ready for next retry</h5>
                <CollectionsRowTable rows={overview.retryEligible} onOpenInvoice={setOpenInvoiceId} />
              </>
            )}

            {/* Paused */}
            {overview.paused.length > 0 && (
              <>
                <h5 style={{ margin: "12px 0 4px", fontSize: 13, fontWeight: 600 }}>Paused or auto-charge off</h5>
                <CollectionsRowTable rows={overview.paused} onOpenInvoice={setOpenInvoiceId} />
              </>
            )}

            {/* Exhausted */}
            {overview.exhausted.length > 0 && (
              <>
                <h5 style={{ margin: "12px 0 4px", fontSize: 13, fontWeight: 600 }}>Retries exhausted</h5>
                <CollectionsRowTable rows={overview.exhausted} onOpenInvoice={setOpenInvoiceId} />
              </>
            )}

            {overview.retryEligible.length === 0 && overview.paused.length === 0 && overview.exhausted.length === 0 && (
              <BillingEmptyState
                title="Collections queue is clear"
                message="Nothing needs operator attention in this snapshot. Load the next sweep preview to see what the worker would pick up."
              />
            )}
          </div>
        ) : null}
      </div>

      {/* Preview next sweep */}
      <div style={{ padding: "14px 16px", background: "var(--surface, #fff)", border: "1px solid var(--border, #e2e8f0)", borderRadius: 10 }}>
        <div className="row-actions" style={{ marginBottom: 8 }}>
          <h4 style={{ margin: 0, fontWeight: 700 }}>Next automated sweep (preview)</h4>
          <button className="btn ghost" type="button" style={{ fontSize: 12 }} disabled={previewLoading} onClick={() => {
            if (!previewLoaded) { void loadPreview(); } else { setPreviewRev((r) => r + 1); }
          }}>
            {previewLoading ? "Loading…" : previewLoaded ? "Refresh" : "Load preview"}
          </button>
        </div>
        {previewError ? <ErrorState message={previewError} /> : null}
        {previewLoading ? <LoadingSkeleton rows={3} /> : null}
        {preview && !previewLoading ? (
          <div>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>{preview.note}</div>
            {preview.rows.length === 0 ? (
              <BillingEmptyState
                title="No invoices in the next sweep"
                message="Either retries are not scheduled yet, or filters exclude these rows. Refresh after the billing worker runs."
              />
            ) : (
              <CollectionsRowTable rows={preview.rows} onOpenInvoice={setOpenInvoiceId} />
            )}
          </div>
        ) : null}
      </div>

      {openInvoiceId ? (
        <InvoiceDetailModal
          invoiceId={openInvoiceId}
          onClose={() => setOpenInvoiceId(null)}
          onAction={afterInvoiceAction}
        />
      ) : null}
    </div>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────

function AdminBillingInvoicesBody() {
  const { can, backendJwtRole } = useAppContext();
  const canAdmin = backendJwtRole === "SUPER_ADMIN" && can("can_view_admin_billing");
  const searchParams = useSearchParams();

  const rawOps = searchParams.get(OPS_TAB_QUERY);
  const activeTab: AdminOpsTab = isAdminOpsTab(rawOps) ? rawOps : "invoices";

  if (!canAdmin) {
    return (
      <div className="state-box">
        Platform admin billing access required. Tenant admins can view their own invoices under{" "}
        <Link href="/billing/invoices">Billing → Invoices</Link>.
      </div>
    );
  }

  return (
    <div className="stack compact-stack billing-admin-shell billing-p5-scope billing-p6-scope">
      <p className="muted billing-p6-invoices-hint" style={{ margin: "0 0 8px", fontSize: 12, lineHeight: 1.45 }}>
        Invoices, ledger, exports, and invoice-level collections for the company selected in the header. Switch views with the{" "}
        <strong>Billing workspace</strong> menu above.
      </p>

      {activeTab === "invoices" ? <InvoicesTab /> : activeTab === "transactions" ? <TransactionsTab /> : activeTab === "reports" ? <ReportsTab /> : <CollectionsTab />}
    </div>
  );
}

export default function AdminBillingInvoicesPage() {
  return (
    <Suspense fallback={<LoadingSkeleton rows={6} />}>
      <AdminBillingInvoicesBody />
    </Suspense>
  );
}
