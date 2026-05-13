"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
import { apiGet, apiPost } from "../../../../../services/apiClient";
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
  }, [statusFilter, search, page]);

  const data = useAsyncResource<InvoiceListResult>(() => apiGet<InvoiceListResult>(url), [url]);
  const rows = data.status === "success" ? data.data.invoices : [];

  const showToast = useCallback((kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  async function act(invoiceId: string, label: string, path: string) {
    setBusy(`${label}-${invoiceId}`);
    try {
      await apiPost(path, {});
      showToast("ok", `${label} succeeded.`);
      // Trigger refetch by changing page state momentarily
      setPage((p) => p);
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

                    {canAct && hasCard ? (
                      <button
                        className="btn ghost"
                        type="button"
                        disabled={!!busy}
                        onClick={() => act(inv.id, "Charge", `/admin/billing/invoices/${inv.id}/retry-payment`)}
                      >
                        {isBusy("Charge") ? "Charging…" : "Charge card"}
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

                    {/* SMS placeholder — deferred */}
                    <button className="btn ghost" type="button" disabled title="SMS payment link — coming soon">
                      SMS link
                    </button>
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
    </>
  );
}

// ── Transactions tab ──────────────────────────────────────────────────────────

function TransactionsTab() {
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);

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
