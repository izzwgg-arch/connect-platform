"use client";

/* Mockup 6 — Payments. Every charge, refund and card in one place. */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiPost } from "../../../../../services/apiClient";
import { BillingNav, Pill, SearchBox, asList, dateTime, errText, money, txTone, useApi } from "../_new/ui";
import "../customer/customerBilling.css";

type Tx = {
  id: string;
  tenantId: string;
  invoiceId?: string | null;
  amountCents: number;
  status: string;
  processor?: string | null;
  processorTransactionId?: string | null;
  responseCode?: string | null;
  responseMessage?: string | null;
  createdAt: string;
  tenant?: { id: string; name?: string } | null;
  invoice?: { id: string; invoiceNumber?: string } | null;
  paymentMethod?: { id: string; brand?: string | null; last4?: string | null } | null;
};

type Filter = "all" | "APPROVED" | "DECLINED" | "REFUNDED";

export default function BillingMoneyPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Tx | null>(null);

  const { data, error, loading, reload } = useApi<Tx[]>(
    "/admin/billing/transactions?limit=100",
    (raw) => asList<Tx>(raw, "transactions"),
  );

  const [refunding, setRefunding] = useState("");
  const [actionErr, setActionErr] = useState("");
  const [actionOk, setActionOk] = useState("");

  /** Refunds move real money, so this always confirms with the amount named.

      ⛔ This used to run through window.confirm + window.prompt — an unstyled
      grey box that cannot show the company in bold, cannot warn properly, and
      that some browsers suppress outright. The confirm now happens in the page,
      and "Refund" finally looks different from "Cancel". */
  const [confirming, setConfirming] = useState<Tx | null>(null);
  const [reason, setReason] = useState("");

  const refund = async (t: Tx, reasonText: string) => {
    const label = `${money(t.amountCents)} to ${t.tenant?.name || "this customer"}`;
    setConfirming(null);
    setRefunding(t.id);
    setActionErr("");
    setActionOk("");
    try {
      await apiPost(`/admin/billing/transactions/${t.id}/refund`, { reason: reasonText, confirmLive: true });
      setActionOk(`Refunded ${label}.`);
      setSelected(null);
      void reload();
    } catch (e: any) {
      setActionErr(errText(e, "The refund did not go through. Nothing was refunded."));
    } finally {
      setRefunding("");
    }
  };

  const rows = useMemo(() => {
    const list = data || [];
    const needle = q.trim().toLowerCase();
    return list.filter((t) => {
      if (filter !== "all" && String(t.status).toUpperCase() !== filter) return false;
      if (!needle) return true;
      return (
        String(t.tenant?.name || "").toLowerCase().includes(needle) ||
        String(t.invoice?.invoiceNumber || "").toLowerCase().includes(needle)
      );
    });
  }, [data, filter, q]);

  const totals = useMemo(() => {
    const list = data || [];
    const approved = list.filter((t) => t.status === "APPROVED");
    const declined = list.filter((t) => t.status === "DECLINED" || t.status === "ERROR");
    const refunded = list.filter((t) => t.status === "REFUNDED");
    return {
      collected: approved.reduce((s, t) => s + Number(t.amountCents || 0), 0),
      approved: approved.length,
      declined: declined.length,
      refunded: refunded.length,
    };
  }, [data]);

  return (
    <div className="cbill">
      <BillingNav current="payments" />
      <div className="cbill-head">
        <div>
          <h2>Payments</h2>
          <div className="cbill-sub">
            <span>{(data || []).length} most recent transactions</span>
          </div>
        </div>
        <div className="cbill-toolbar">
          <SearchBox value={q} onChange={setQ} placeholder="Search customer or invoice…" label="Search payments" />
          <div className="cbill-seg">
            <button type="button" data-on={filter === "all"} onClick={() => setFilter("all")}>All</button>
            <button type="button" data-on={filter === "APPROVED"} onClick={() => setFilter("APPROVED")}>Approved</button>
            <button type="button" data-on={filter === "DECLINED"} onClick={() => setFilter("DECLINED")}>Declined</button>
            <button type="button" data-on={filter === "REFUNDED"} onClick={() => setFilter("REFUNDED")}>Refunded</button>
          </div>
        </div>
      </div>

      {error && <div className="cbill-banner bad">{error}</div>}
      {actionErr && <div className="cbill-banner bad">{actionErr}</div>}
      {actionOk && <div className="cbill-banner ok">{actionOk}</div>}

      <div className="cbill-kpis" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <div className="cbill-kpi good">
          <span className="k">Collected</span>
          <span className="v">{money(totals.collected)}</span>
          <span className="s">{totals.approved} approved</span>
        </div>
        <div className={totals.declined ? "cbill-kpi alert" : "cbill-kpi"}>
          <span className="k">Declined</span>
          <span className="v">{totals.declined}</span>
          <span className="s">in this view</span>
        </div>
        <div className="cbill-kpi">
          <span className="k">Refunded</span>
          <span className="v">{totals.refunded}</span>
          <span className="s">in this view</span>
        </div>
      </div>

      <section className="cbill-card">
        <div className="cbill-card-hd">
          <h3>
            Transactions
            {rows.length !== (data || []).length ? ` — showing ${rows.length} of ${(data || []).length}` : ""}
          </h3>
          <span className="hint">open a row for the processor's own response</span>
        </div>
        <div className="cbill-table-wrap">
          <table className="cbill-table">
            <thead>
              <tr>
                <th>When</th><th>Customer</th><th>Invoice</th><th>Method</th>
                <th className="r">Amount</th><th className="r">Result</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} style={{ color: "var(--cb-muted)" }}>Loading…</td></tr>}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={6} style={{ color: "var(--cb-muted)" }}>No payments match.</td></tr>
              )}
              {rows.map((t) => {
                const tone = txTone(t.status);
                return (
                  /* Rows carry the only route to the processor's response, so
                     they must be reachable without a mouse. */
                  <tr
                    key={t.id}
                    className="clickable"
                    onClick={() => setSelected(t)}
                    tabIndex={0}
                    role="button"
                    aria-label={`Open payment details for ${t.tenant?.name || "customer"}`}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(t);
                      }
                    }}
                  >
                    <td className="n">{dateTime(t.createdAt)}</td>
                    <td>
                      {t.tenant?.id ? (
                        <Link href={`/admin/billing/customer/${t.tenant.id}`} onClick={(e) => e.stopPropagation()}>
                          {t.tenant?.name || "Customer"}
                        </Link>
                      ) : (t.tenant?.name || "—")}
                    </td>
                    <td>
                      {t.invoice?.id ? (
                        <Link href={`/admin/billing/invoice/${t.invoice.id}`} onClick={(e) => e.stopPropagation()}>
                          {t.invoice.invoiceNumber}
                        </Link>
                      ) : "—"}
                    </td>
                    <td>
                      {t.paymentMethod
                        ? `${t.paymentMethod.brand || "Card"} ····${t.paymentMethod.last4 || "????"}`
                        : t.processor || "—"}
                    </td>
                    <td className="r n">{money(t.amountCents)}</td>
                    <td className="r"><Pill tone={tone.tone}>{tone.label}</Pill></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <section className="cbill-card">
          <div className="cbill-card-hd">
            <h3>{selected.tenant?.name || "Transaction"} — {dateTime(selected.createdAt)}</h3>
            <div className="cbill-toolbar">
              <Pill tone={txTone(selected.status).tone}>{txTone(selected.status).label}</Pill>
              <button className="cbill-btn" onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>
          <div className="cbill-card-bd">
            <div className="cbill-row">
              <div className="cbill-label"><span className="t">Amount</span></div>
              <span className="n" style={{ fontFamily: "ui-monospace, monospace" }}>{money(selected.amountCents)}</span>
            </div>
            <div className="cbill-row">
              <div className="cbill-label"><span className="t">Processor</span></div>
              <span>{selected.processor || "—"}</span>
            </div>
            <div className="cbill-row">
              <div className="cbill-label"><span className="t">Processor reference</span></div>
              <span className="n" style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                {selected.processorTransactionId || "—"}
              </span>
            </div>
            <div className="cbill-row">
              <div className="cbill-label">
                <span className="t">Response</span>
                <span className="h">What the bank actually said</span>
              </div>
              <span>
                {selected.responseCode ? `${selected.responseCode} — ` : ""}
                {selected.responseMessage || "—"}
              </span>
            </div>
            {selected.status === "APPROVED" && (
              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Refund this payment</span>
                  <span className="h">Sends the money back to the customer's card</span>
                </div>
                <button
                  className="cbill-btn danger"
                  disabled={refunding === selected.id}
                  onClick={() => { setReason(""); setConfirming(selected); }}
                >
                  {refunding === selected.id ? "Refunding…" : `Refund ${money(selected.amountCents)}`}
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {confirming && (
        <RefundDialog
          tx={confirming}
          reason={reason}
          onReason={setReason}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void refund(confirming, reason)}
        />
      )}
    </div>
  );
}

/** Refunds move real money. This replaces window.confirm + window.prompt, which
    could not name the customer in bold, could not carry a warning, and is
    suppressed outright by some browsers after a few uses. */
function RefundDialog({
  tx,
  reason,
  onReason,
  onCancel,
  onConfirm,
}: {
  tx: Tx;
  reason: string;
  onReason: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      className="cbill-modal"
      ref={ref}
      onCancel={(e) => { e.preventDefault(); onCancel(); }}
      aria-label="Confirm refund"
    >
      <div className="cbill-card">
        <div className="cbill-card-hd">
          <h3>Refund this payment</h3>
        </div>
        <div className="cbill-card-bd">
          <div className="cbill-prev-total" style={{ borderTop: 0, marginTop: 0, paddingTop: 4 }}>
            <span>{tx.tenant?.name || "This customer"}</span>
            <span>{money(tx.amountCents)}</span>
          </div>
          <div className="cbill-banner warn" style={{ margin: "10px 0" }}>
            <span>
              The money goes back to the customer&apos;s card. This cannot be undone from here.
            </span>
          </div>
          <div className="cbill-row">
            <div className="cbill-label">
              <span className="t">Reason</span>
              <span className="h">Kept on the record</span>
            </div>
            <input
              className="cbill-input text"
              value={reason}
              onChange={(e) => onReason(e.target.value)}
              placeholder="Charged twice by mistake"
              aria-label="Reason for the refund"
              autoFocus
            />
          </div>
        </div>
        <div className="cbill-actions" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="cbill-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="cbill-btn danger" onClick={onConfirm}>
            Refund {money(tx.amountCents)}
          </button>
        </div>
      </div>
    </dialog>
  );
}
