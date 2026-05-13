"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
import { apiDelete, apiGet, apiPost } from "../../../../../services/apiClient";
import { DataTable } from "../../../../../components/DataTable";
import { ErrorState } from "../../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../../components/PageHeader";
import { BillingPageChrome, billingErrorMessage } from "../../../../../components/BillingActionToast";
import { dollars } from "../../../../../lib/billingUi";
import { useAppContext } from "../../../../../hooks/useAppContext";

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

function InvoiceDetailModal({ invoiceId, onClose, onAction }: { invoiceId: string; onClose: () => void; onAction: () => void }) {
  const data = useAsyncResource<InvoiceDetail>(() => apiGet<InvoiceDetail>(`/admin/billing/invoices/${invoiceId}`), [invoiceId]);
  const inv = data.status === "success" ? data.data : null;

  return (
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
              <p className="muted" style={{ fontSize: 13 }}>No line items recorded.</p>
            )}

            {/* Payment transactions */}
            {inv.transactions?.length > 0 ? (
              <>
                <h4 style={{ margin: "16px 0 6px" }}>Payment Attempts</h4>
                <DataTable
                  rows={inv.transactions.map((t) => ({ ...t, id: t.id }))}
                  columns={[
                    { key: "date", label: "Date", render: (r: InvoiceTxRow) => fmtDatetime(r.createdAt) },
                    {
                      key: "status", label: "Status",
                      render: (r: InvoiceTxRow) => <span className={`billing-status-pill ${txStatusClass(r.status)}`}>{r.status}</span>,
                    },
                    { key: "amt", label: "Amount", render: (r: InvoiceTxRow) => dollars(r.amountCents) },
                    { key: "card", label: "Card", render: (r: InvoiceTxRow) => r.paymentMethod ? cardLabel(r.paymentMethod) : "—" },
                    { key: "ref", label: "Processor Ref", render: (r: InvoiceTxRow) => r.processorTransactionId || "—" },
                    { key: "msg", label: "Response", render: (r: InvoiceTxRow) => r.responseMessage || r.responseCode || "—" },
                  ]}
                />
              </>
            ) : (
              <p className="muted" style={{ fontSize: 13 }}>No payment attempts recorded.</p>
            )}

            {/* Event log */}
            {inv.events?.length > 0 ? (
              <>
                <h4 style={{ margin: "16px 0 6px" }}>Activity Log</h4>
                <DataTable
                  rows={inv.events.map((e) => ({ ...e, id: e.id || `${invoiceId}-${e.createdAt}` }))}
                  columns={[
                    { key: "t", label: "Time", render: (r: InvoiceEventRow) => fmtDatetime(r.createdAt) },
                    { key: "y", label: "Type", render: (r: InvoiceEventRow) => r.type },
                    { key: "m", label: "Detail", render: (r: InvoiceEventRow) => r.message || (r.metadata ? JSON.stringify(r.metadata) : "—") },
                  ]}
                />
              </>
            ) : null}

            <div className="row-actions" style={{ marginTop: 16 }}>
              <button className="btn primary" type="button" onClick={() => { onAction(); onClose(); }}>Refresh list</button>
              <button className="btn ghost" type="button" onClick={onClose}>Close</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── ManualPayModal ─────────────────────────────────────────────────────────────

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

  return (
    <div style={{ ...overlayStyle, alignItems: "center", justifyContent: "center" }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modalStyle}>
        <h3 style={{ margin: "0 0 16px" }}>
          Charge invoice {invoice.invoiceNumber || invoice.id.slice(0, 8)}
          {isLive ? (
            <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 700, color: "#fff", background: "#dc2626", borderRadius: 4, padding: "2px 7px", verticalAlign: "middle" }}>
              ⚡ LIVE CHARGE
            </span>
          ) : (
            <span style={{ marginLeft: 10, fontSize: 11, color: "#6b7280", background: "#f3f4f6", borderRadius: 4, padding: "2px 7px", verticalAlign: "middle" }}>
              SANDBOX
            </span>
          )}
        </h3>

        <p style={{ margin: "0 0 16px", fontSize: 13 }}>
          <strong>{invoice.tenant?.name}</strong> · Balance due: <strong>{dollars(invoice.balanceDueCents)}</strong>
        </p>

        {step === "done" ? (
          <>
            <div style={{ color: "green", marginBottom: 16, fontSize: 14 }}>✓ Charge submitted successfully.</div>
            <button className="btn primary" type="button" onClick={onClose}>Close</button>
          </>
        ) : step === "confirm" ? (
          <>
            <div style={{ background: "var(--surface-alt, #f9fafb)", borderRadius: 8, padding: "14px 16px", marginBottom: 16, fontSize: 13 }}>
              <p style={{ margin: "0 0 8px" }}>
                You are about to charge <strong>{dollars(invoice.balanceDueCents)}</strong> to{" "}
                <strong>{selectedMethod ? cardLabel(selectedMethod) : selectedMethodId}</strong>.
              </p>
              {note ? <p style={{ margin: 0, color: "#6b7280" }}>Note: {note}</p> : null}
              {isLive ? (
                <p style={{ margin: "10px 0 0", fontWeight: 600, color: "#dc2626" }}>
                  ⚡ This is a LIVE charge. The customer's card will be billed immediately.
                </p>
              ) : (
                <p style={{ margin: "10px 0 0", color: "#6b7280" }}>This is a sandbox charge — no real funds will be moved.</p>
              )}
            </div>
            {error ? <div style={{ color: "#dc2626", marginBottom: 12, fontSize: 13 }}>{error}</div> : null}
            <div className="row-actions">
              <button className="btn danger" type="button" disabled={busy} onClick={submit}>
                {busy ? "Charging…" : isLive ? "⚡ Confirm live charge" : "Confirm charge"}
              </button>
              <button className="btn ghost" type="button" disabled={busy} onClick={() => { setStep("pick"); submitted.current = false; }}>
                ← Back
              </button>
            </div>
          </>
        ) : (
          <>
            {pmData.status === "loading" ? <LoadingSkeleton rows={3} /> : null}
            {pmData.status === "error" ? <ErrorState message={pmData.error} /> : null}
            {pmData.status === "success" && methods.length === 0 ? (
              <div style={{ color: "#6b7280", fontSize: 13, marginBottom: 12 }}>
                No saved cards for this tenant. Ask the customer to add a card via the billing portal.
              </div>
            ) : null}

            {methods.length > 0 ? (
              <>
                <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 500 }}>Select saved card:</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                  {methods.map((m) => (
                    <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "8px 10px", borderRadius: 6, border: `1.5px solid ${selectedMethodId === m.id ? "var(--accent, #2563eb)" : "var(--border, #e0e0e0)"}`, fontSize: 13 }}>
                      <input type="radio" name="paymentMethod" value={m.id} checked={selectedMethodId === m.id} onChange={() => setSelectedMethodId(m.id)} />
                      {cardLabel(m)}
                      {m.isDefault ? <span style={{ marginLeft: 4, fontSize: 10, background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 5px" }}>Default</span> : null}
                      {m.lastSuccessfulCharge ? (
                        <span style={{ marginLeft: "auto", fontSize: 11, color: "#6b7280" }}>
                          Last: {dollars(m.lastSuccessfulCharge.amountCents)} {fmtDate(m.lastSuccessfulCharge.createdAt)}
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
              </>
            ) : null}

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 }}>
                Operator note (optional — logged to activity):
              </label>
              <input
                type="text"
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Customer called and requested retry"
                style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border, #e0e0e0)", fontSize: 13, boxSizing: "border-box" }}
              />
            </div>

            <div className="row-actions">
              <button
                className="btn primary"
                type="button"
                disabled={!selectedMethodId}
                onClick={() => setStep("confirm")}
              >
                Preview charge →
              </button>
              <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── PaymentMethodsModal ────────────────────────────────────────────────────────

type AdminSolaPublicConfig = { configured: boolean; enabled: boolean; ifieldsKey: string | null; mode: string | null };

function PaymentMethodsModal({ tenantId, tenantName, onClose }: { tenantId: string; tenantName: string; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [rev, setRev] = useState(0);

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
    if (!window.confirm("Remove this saved card? This cannot be undone.")) return;
    setBusy(`remove-${methodId}`);
    try {
      await apiDelete(`/admin/billing/platform/tenants/${tenantId}/payment-methods/${methodId}`);
      showToast("ok", "Card removed.");
      setRev((r) => r + 1);
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
          <p className="muted">No saved cards for this tenant.</p>
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
              <button className="btn danger" type="button" disabled={!!busy} onClick={() => void removeCard(m.id)} style={{ fontSize: 12 }}>
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
              {solaConfig === null ? "Loading…" : canAddCard ? "+ Add card" : "+ Add card (SOLA not configured)"}
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
                  SOLA iFields is not configured for this tenant. Enable it in Admin → Billing → Settings before adding cards.
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
  );
}

// ── TransactionDetailModal ─────────────────────────────────────────────────────

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
              <div><span className="muted" style={{ fontSize: 12 }}>Status</span><br /><span className={`billing-status-pill ${txStatusClass(tx.status)}`}>{tx.status}</span></div>
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

  async function act(invoiceId: string, label: string, path: string, body: Record<string, unknown> = {}) {
    setBusy(`${label}-${invoiceId}`);
    try {
      await apiPost(path, body);
      showToast("ok", `${label} succeeded.`);
      setListRev((r) => r + 1);
    } catch (err) {
      showToast("err", billingErrorMessage(err, `${label} failed.`));
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
    <>
      {toast ? (
        <div className={`billing-toast billing-toast--${toast.kind}`} style={{ position: "relative", bottom: "auto", right: "auto", maxWidth: "100%" }} role="status">
          {toast.text}
        </div>
      ) : null}

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <div className="row-actions" style={{ margin: 0, flexWrap: "wrap" }}>
          {INV_STATUSES.map((s) => (
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
            {rows.length === 0 ? <p className="muted">No invoices match these filters.</p> : null}
            {rows.map((inv) => {
              const canAct = inv.status !== "PAID" && inv.status !== "VOID";
              const hasCard = !!(inv.paymentMethod || inv.tenant?.billingSettings?.defaultPaymentMethodId);
              const lastTx = inv.transactions[0] ?? null;
              const period = fmtPeriod(inv.periodStart, inv.periodEnd);
              const isLogOpen = logInvoiceId === inv.id;
              const isBusy = (label: string) => busy === `${label}-${inv.id}`;

              return (
                <div className="billing-invoice-row" key={inv.id} style={{ flexWrap: "wrap", gap: 6 }}>
                  {/* Identity */}
                  <span style={{ minWidth: 160 }}>
                    <strong>{inv.invoiceNumber || inv.id.slice(0, 8)}</strong>
                    <small>{inv.tenant?.name || inv.tenantId}</small>
                    {period ? <small>{period}</small> : null}
                  </span>

                  {/* Amounts */}
                  <em style={{ minWidth: 100, textAlign: "right" }}>
                    {dollars(inv.totalCents)}
                    {inv.balanceDueCents > 0 && inv.status !== "PAID" ? (
                      <small> bal {dollars(inv.balanceDueCents)}</small>
                    ) : null}
                  </em>

                  {/* Status */}
                  <span className={`billing-status-pill ${invStatusClass(inv.status)}`}>{inv.status}</span>

                  {/* Dates */}
                  <span style={{ minWidth: 160 }} className="muted">
                    <small>Due {fmtDate(inv.dueDate)}</small>
                    {inv.paidAt ? <small>Paid {fmtDate(inv.paidAt)}</small> : null}
                    {inv.failedAt && !inv.paidAt ? <small>Failed {fmtDate(inv.failedAt)}</small> : null}
                  </span>

                  {/* Card / last txn */}
                  <span style={{ minWidth: 140 }} className="muted">
                    {inv.paymentMethod ? (
                      <small>{inv.paymentMethod.brand || "Card"} ···{inv.paymentMethod.last4 || "----"}</small>
                    ) : null}
                    {lastTx?.processorTransactionId ? (
                      <small title="Last processor transaction ID">Ref: {lastTx.processorTransactionId}</small>
                    ) : null}
                    {lastTx ? (
                      <small>
                        <span className={`billing-status-pill ${txStatusClass(lastTx.status)}`} style={{ fontSize: 10, padding: "1px 5px" }}>
                          {lastTx.status}
                        </span>
                      </small>
                    ) : null}
                  </span>

                  {/* Actions */}
                  <div className="row-actions" style={{ flexWrap: "wrap" }}>
                    {/* Detail drawer */}
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => setDetailInvoiceId(inv.id)}
                    >
                      Detail
                    </button>

                    {/* Cards modal */}
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => setCardsForTenant({ tenantId: inv.tenantId, name: inv.tenant?.name || inv.tenantId })}
                    >
                      Cards
                    </button>

                    {canAct ? (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={!!busy}
                        onClick={() => act(inv.id, "Mark paid", `/admin/billing/invoices/${inv.id}/mark-paid`)}
                      >
                        {isBusy("Mark paid") ? "Marking…" : "Mark Paid"}
                      </button>
                    ) : null}

                    {canAct ? (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={!!busy}
                        onClick={() => setPayInvoice(inv)}
                        title={hasCard ? "Charge with saved card" : "No saved card — use Cards button to check"}
                      >
                        Charge card
                      </button>
                    ) : null}

                    {canAct ? (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={!!busy}
                        onClick={() => act(inv.id, "Send", `/admin/billing/invoices/${inv.id}/send`)}
                      >
                        {isBusy("Send") ? "Sending…" : "Send invoice"}
                      </button>
                    ) : null}

                    {canAct ? (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={!!busy}
                        onClick={() => act(inv.id, "Email link", `/billing/platform/invoices/${inv.id}/email-payment-link`)}
                      >
                        {isBusy("Email link") ? "Sending…" : "Email link"}
                      </button>
                    ) : null}

                    {canAct ? (
                      <button
                        className="btn danger"
                        type="button"
                        disabled={!!busy}
                        onClick={() => act(inv.id, "Void", `/admin/billing/invoices/${inv.id}/void`)}
                      >
                        {isBusy("Void") ? "Voiding…" : "Void"}
                      </button>
                    ) : null}

                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => void toggleLog(inv.id)}
                    >
                      {isLogOpen ? "Hide log" : "Activity"}
                    </button>

                    {canAct ? (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={!!busy}
                        onClick={() => setSmsInvoice(inv)}
                        title="Send payment link via SMS"
                      >
                        SMS link
                      </button>
                    ) : null}
                  </div>

                  {/* Inline event log */}
                  {isLogOpen ? (
                    <div style={{ width: "100%", marginTop: 8 }}>
                      {logLoading ? <p className="muted">Loading events…</p> : null}
                      {logError ? <ErrorState message={logError} /> : null}
                      {!logLoading && !logError && logEvents.length === 0 ? (
                        <p className="muted">No events recorded for this invoice.</p>
                      ) : null}
                      {!logLoading && !logError && logEvents.length > 0 ? (
                        <DataTable
                          rows={logEvents.map((e) => ({ ...e, id: e.id ?? `${inv.id}-${e.createdAt}` }))}
                          columns={[
                            { key: "t", label: "Time", render: (r) => fmtDatetime(r.createdAt) },
                            { key: "y", label: "Type", render: (r) => r.type },
                            { key: "m", label: "Detail", render: (r) => r.message || (r.metadata ? JSON.stringify(r.metadata) : "—") },
                          ]}
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
    </>
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
        <span className={`billing-status-pill ${txStatusClass(r.status)}`}>{r.status}</span>
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
            <p className="muted">No transactions match these filters.</p>
          ) : (
            <DataTable rows={data.data.transactions} columns={txColumns} />
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

// ── Page root ─────────────────────────────────────────────────────────────────

export default function AdminBillingInvoicesPage() {
  const { can, backendJwtRole } = useAppContext();
  const canAdmin = backendJwtRole === "SUPER_ADMIN" && can("can_view_admin_billing");
  const [activeTab, setActiveTab] = useState<"invoices" | "transactions">("invoices");

  if (!canAdmin) {
    return (
      <div className="state-box">
        Platform admin billing access required. Tenant admins can view their own invoices under{" "}
        <Link href="/billing/invoices">Billing → Invoices</Link>.
      </div>
    );
  }

  return (
    <BillingPageChrome toast={null}>
      <div className="stack compact-stack billing-admin-shell">
        <PageHeader
          title="Payment Operations"
          subtitle="Cross-tenant invoice list and payment transaction audit. Use the Invoices tab to act on open invoices; Transactions is read-only."
        />

        <div className="row-actions" style={{ marginBottom: 4 }}>
          <Link className="btn ghost" href="/admin/billing">← Admin Billing</Link>
          <Link className="btn ghost" href="/admin/billing/settings">Billing Settings</Link>
        </div>

        {/* Tab bar */}
        <div className="row-actions" style={{ borderBottom: "2px solid var(--border, #e0e0e0)", marginBottom: 16, paddingBottom: 0, gap: 0 }}>
          {(["invoices", "transactions"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              style={{
                background: "none",
                border: "none",
                borderBottom: activeTab === tab ? "2px solid var(--accent, #2563eb)" : "2px solid transparent",
                padding: "8px 16px",
                marginBottom: -2,
                cursor: "pointer",
                fontWeight: activeTab === tab ? 600 : 400,
                color: activeTab === tab ? "var(--accent, #2563eb)" : "inherit",
                fontSize: 14,
                textTransform: "capitalize",
              }}
            >
              {tab === "invoices" ? "Invoices" : "Transactions"}
            </button>
          ))}
        </div>

        {activeTab === "invoices" ? <InvoicesTab /> : <TransactionsTab />}
      </div>
    </BillingPageChrome>
  );
}
