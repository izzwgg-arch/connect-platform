"use client";

/* Mockup 5 — An invoice, its editor and everything it triggered.
   Every action the old billing screens offered is present here, on the invoice
   itself, instead of spread across four drawers. */

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiDelete, apiPost, apiPut } from "../../../../../../services/apiClient";
import { BillingNav, Pill, asList, dateTime, errText, invoiceTone, longDate, money, useApi } from "../../_new/ui";
import "../../customer/customerBilling.css";

type LineItem = {
  id: string;
  type: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  taxable?: boolean;
};

type Invoice = {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  status: string;
  source?: string | null;
  totalCents: number;
  subtotalCents: number;
  taxCents: number;
  amountPaidCents: number;
  balanceDueCents: number;
  periodStart: string;
  periodEnd: string;
  issueDate?: string;
  dueDate: string;
  paidAt?: string | null;
  failedAt?: string | null;
  notes?: string | null;
  billingEmail?: string | null;
  lineItems?: LineItem[];
  tenant?: { id: string; name?: string } | null;
};

type EventRow = {
  id: string;
  type: string;
  message?: string | null;
  createdAt: string;
  metadata?: any;
};

export default function InvoicePage() {
  const params = useParams();
  const id = String((params as any)?.id || "");

  const inv = useApi<Invoice>(id ? `/admin/billing/invoices/${id}` : null);
  const events = useApi<EventRow[]>(
    id ? `/admin/billing/invoices/${id}/events` : null,
    (raw) => asList<EventRow>(raw, "events"),
  );

  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const i = inv.data;
  const lines = useMemo(() => i?.lineItems || [], [i]);
  const tone = invoiceTone(i?.status || "");

  const act = useCallback(
    async (label: string, run: () => Promise<any>) => {
      if (busy) return;
      setBusy(label);
      setErr("");
      setMsg("");
      try {
        await run();
        setMsg(`${label} — done.`);
        void inv.reload();
        void events.reload();
      } catch (e: any) {
        setErr(errText(e, `${label} failed.`));
      } finally {
        setBusy("");
      }
    },
    [busy, inv, events],
  );

  if (inv.loading) return <div className="cbill"><p className="cbill-sub">Loading invoice…</p></div>;
  if (inv.error) return <div className="cbill"><div className="cbill-banner bad">{inv.error}</div></div>;
  if (!i) return null;

  const paid = i.status === "PAID";
  const voided = i.status === "VOID";

  return (
    <div className="cbill">
      <BillingNav current="invoices" />
      <div className="cbill-head">
        <div>
          <h2>{i.invoiceNumber}</h2>
          <div className="cbill-sub">
            <Pill tone={tone.tone}>{tone.label}</Pill>
            {i.source === "MANUAL" && <Pill tone="off">Custom invoice</Pill>}
            <span>
              <Link href={`/admin/billing/customer/${i.tenantId}`}>{i.tenant?.name || "Customer"}</Link>
            </span>
            <span>·</span>
            <span>service {longDate(i.periodStart)} – {longDate(i.periodEnd)}</span>
            <span>·</span>
            <span>due {longDate(i.dueDate)}</span>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 28, fontWeight: 660, letterSpacing: "-0.03em", color: "var(--cb-ink)" }}>
            {money(i.totalCents)}
          </div>
          <div className="cbill-sub" style={{ justifyContent: "flex-end" }}>
            {paid ? `Paid ${longDate(i.paidAt)}` : `Balance due ${money(i.balanceDueCents)}`}
          </div>
        </div>
      </div>

      {err && <div className="cbill-banner bad">{err}</div>}
      {msg && <div className="cbill-banner ok">{msg}</div>}

      <section className="cbill-card">
        <div className="cbill-card-hd"><h3>Actions</h3></div>
        <div className="cbill-actions">
          <button className="cbill-btn primary" disabled={!!busy || paid || voided}
            onClick={() => act("Charge the card", () => apiPost(`/admin/billing/invoices/${i.id}/pay`, {}))}>
            {busy === "Charge the card" ? "Charging…" : "Charge card on file"}
          </button>
          <button className="cbill-btn" disabled={!!busy || paid || voided}
            onClick={() => act("Retry payment", () => apiPost(`/admin/billing/invoices/${i.id}/retry-payment`, {}))}>
            Retry payment
          </button>
          <button className="cbill-btn" disabled={!!busy || voided}
            onClick={() => act("Send the invoice", () => apiPost(`/admin/billing/invoices/${i.id}/send`, {}))}>
            Send invoice
          </button>
          <button className="cbill-btn" disabled={!!busy || paid || voided}
            onClick={() => act("Email a payment link", () => apiPost(`/admin/billing/invoices/${i.id}/email-payment-link`, {}))}>
            Email payment link
          </button>
          <button className="cbill-btn" disabled={!!busy || paid || voided}
            onClick={() => act("Text a payment link", () => apiPost(`/admin/billing/invoices/${i.id}/sms-payment-link`, {}))}>
            Text payment link
          </button>
          <button className="cbill-btn" disabled={!!busy || !paid}
            onClick={() => act("Resend the receipt", () => apiPost(`/admin/billing/invoices/${i.id}/resend-receipt`, {}))}>
            Resend receipt
          </button>
          <button className="cbill-btn" disabled={!!busy || paid || voided}
            onClick={() => act("Mark as paid", () => apiPost(`/admin/billing/invoices/${i.id}/mark-paid`, {}))}>
            Mark as paid
          </button>
          <button className="cbill-btn" disabled={!!busy || voided}
            onClick={() => act("Pause collections", () => apiPost(`/admin/billing/invoices/${i.id}/collections/pause`, {}))}>
            Pause chasing
          </button>
          <button className="cbill-btn" disabled={!!busy || voided}
            onClick={() => act("Resume collections", () => apiPost(`/admin/billing/invoices/${i.id}/collections/resume`, {}))}>
            Resume chasing
          </button>
          <button className="cbill-btn" disabled={!!busy || voided}
            onClick={() => act("Skip the next retry", () => apiPost(`/admin/billing/invoices/${i.id}/collections/skip-next-retry`, {}))}>
            Skip next retry
          </button>
          <a className="cbill-btn" href={`/api/admin/billing/invoices/${i.id}/pdf`} target="_blank" rel="noreferrer">
            Download PDF
          </a>
          <button className="cbill-btn" style={{ color: "var(--cb-crit)" }} disabled={!!busy || voided}
            onClick={() => {
              if (!window.confirm("Cancel this invoice? It stays on the record but is no longer owed.")) return;
              void act("Void the invoice", () => apiPost(`/admin/billing/invoices/${i.id}/void`, {}));
            }}>
            Void
          </button>
        </div>
      </section>

      <section className="cbill-card">
        <div className="cbill-card-hd">
          <h3>What they are being charged for</h3>
          <div className="cbill-toolbar">
            <span className="hint">{lines.length} line{lines.length === 1 ? "" : "s"}</span>
            {!paid && !voided && (
              <button
                className="cbill-btn"
                disabled={!!busy}
                onClick={() => {
                  const description = window.prompt("What is this line for?", "");
                  if (!description || !description.trim()) return;
                  const raw = window.prompt("How much? (e.g. 25.00)", "0.00");
                  const cents = Math.round(Number(String(raw || "").replace(/[^0-9.-]/g, "")) * 100);
                  if (!Number.isFinite(cents)) return;
                  void act("Add a line", () =>
                    apiPost(`/admin/billing/invoices/${i.id}/line-items`, {
                      type: "CUSTOM",
                      description: description.trim(),
                      quantity: 1,
                      unitPriceCents: cents,
                      taxable: false,
                    }),
                  );
                }}
              >
                Add a line
              </button>
            )}
          </div>
        </div>
        <div className="cbill-table-wrap">
          <table className="cbill-table">
            <thead>
              <tr>
                <th>Description</th>
                <th className="r">Qty</th>
                <th className="r">Each</th>
                <th className="r">Taxable</th>
                <th className="r">Amount</th>
                <th className="r"></th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={6} style={{ color: "var(--cb-muted)" }}>No line items.</td></tr>
              )}
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.description}</td>
                  <td className="r n">{l.quantity}</td>
                  <td className="r n">{money(l.unitPriceCents)}</td>
                  <td className="r">{l.taxable === false ? <Pill tone="off">No</Pill> : <Pill tone="ok">Yes</Pill>}</td>
                  <td className="r n">{money(l.amountCents)}</td>
                  <td className="r">
                    {!paid && !voided && (
                      <button
                        className="cbill-btn"
                        disabled={!!busy}
                        onClick={() => {
                          if (!window.confirm(`Remove "${l.description}" from this invoice?`)) return;
                          void act("Remove the line", () =>
                            apiDelete(`/admin/billing/invoices/${i.id}/line-items/${l.id}`),
                          );
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              <tr>
                <td colSpan={5} className="r" style={{ fontWeight: 620 }}>Subtotal</td>
                <td className="r n">{money(i.subtotalCents)}</td>
              </tr>
              {i.taxCents > 0 && (
                <tr>
                  <td colSpan={5} className="r" style={{ fontWeight: 620 }}>Sales tax</td>
                  <td className="r n">{money(i.taxCents)}</td>
                </tr>
              )}
              <tr>
                <td colSpan={5} className="r" style={{ fontWeight: 700 }}>Total</td>
                <td className="r n" style={{ fontWeight: 700 }}>{money(i.totalCents)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {!paid && !voided && (
        <OutsidePayment invoice={i} onDone={() => { void inv.reload(); void events.reload(); }} />
      )}

      <InvoiceMeta invoice={i} onSaved={() => { void inv.reload(); void events.reload(); }} />

      <section className="cbill-card">
        <div className="cbill-card-hd">
          <h3>What happened to this invoice</h3>
          <span className="hint">including every email it triggered</span>
        </div>
        <div className="cbill-table-wrap">
          <table className="cbill-table">
            <tbody>
              {(events.data || []).length === 0 && (
                <tr><td style={{ color: "var(--cb-muted)" }}>Nothing recorded yet.</td></tr>
              )}
              {(events.data || []).map((e) => (
                <tr key={e.id}>
                  <td className="n" style={{ whiteSpace: "nowrap", width: 150 }}>{dateTime(e.createdAt)}</td>
                  <td>{e.message || e.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/** They paid you outside Connect — Zelle, a cheque, cash. Record it here and the
    invoice settles, so the card is never charged on the payment date. */
function OutsidePayment({ invoice, onDone }: { invoice: Invoice; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(((invoice.balanceDueCents || 0) / 100).toFixed(2));
  const [method, setMethod] = useState("ZELLE");
  const [when, setWhen] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [payer, setPayer] = useState("");
  const [notes, setNotes] = useState("");
  const [receipt, setReceipt] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    const cents = Math.round(Number(String(amount).replace(/[^0-9.]/g, "")) * 100);
    if (!Number.isFinite(cents) || cents < 1) { setErr("Enter how much they paid."); return; }
    setSaving(true); setErr("");
    try {
      await apiPost(`/admin/billing/invoices/${invoice.id}/external-payment`, {
        amountCents: cents,
        paymentDate: new Date(`${when}T12:00:00Z`).toISOString(),
        method,
        ...(reference.trim() ? { externalReference: reference.trim() } : {}),
        ...(payer.trim() ? { payerName: payer.trim() } : {}),
        ...(notes.trim() ? { externalNotes: notes.trim() } : {}),
        sendReceiptEmail: receipt,
      });
      setOpen(false);
      onDone();
    } catch (e: any) {
      setErr(errText(e, "Could not record that payment."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="cbill-card">
      <div className="cbill-card-hd">
        <h3>They paid outside Connect</h3>
        <div className="cbill-toolbar">
          <span className="hint">Zelle, cheque, cash — recording it stops the card being charged</span>
          <button className="cbill-btn" onClick={() => setOpen(!open)}>
            {open ? "Cancel" : "Record a payment"}
          </button>
        </div>
      </div>
      {open && (
        <div className="cbill-card-bd">
          {err && <div className="cbill-banner bad" style={{ margin: "10px 0" }}>{err}</div>}
          <div className="cbill-row">
            <div className="cbill-label"><span className="t">How much</span><span className="h">Balance due is {money(invoice.balanceDueCents)}</span></div>
            <input className="cbill-input" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount paid" />
          </div>
          <div className="cbill-row">
            <div className="cbill-label"><span className="t">How they paid</span></div>
            <select className="cbill-select" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Payment method">
              <option value="ZELLE">Zelle</option>
              <option value="CHECK">Cheque</option>
              <option value="CASH">Cash</option>
              <option value="QUICKPAY">QuickPay</option>
              <option value="CARD_EXTERNAL">Card, taken elsewhere</option>
              <option value="ACH_EXTERNAL">Bank transfer</option>
              <option value="OTHER">Something else</option>
            </select>
          </div>
          <div className="cbill-row">
            <div className="cbill-label"><span className="t">When</span></div>
            <input className="cbill-input" style={{ width: 150 }} type="date" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Payment date" />
          </div>
          <div className="cbill-row">
            <div className="cbill-label"><span className="t">Reference</span><span className="h">Cheque number, confirmation code — optional</span></div>
            <input className="cbill-input text" value={reference} onChange={(e) => setReference(e.target.value)} aria-label="Reference" />
          </div>
          <div className="cbill-row">
            <div className="cbill-label"><span className="t">Who paid</span><span className="h">Optional</span></div>
            <input className="cbill-input text" value={payer} onChange={(e) => setPayer(e.target.value)} aria-label="Payer name" />
          </div>
          <div className="cbill-row">
            <div className="cbill-label"><span className="t">Note</span><span className="h">Kept on the record, not shown to the customer</span></div>
            <input className="cbill-input text" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" />
          </div>
          <div className="cbill-row">
            <div className="cbill-label"><span className="t">Email them a receipt</span></div>
            <button type="button" className="cbill-toggle" data-on={receipt} aria-label="Send a receipt" onClick={() => setReceipt(!receipt)} />
          </div>
          <div className="cbill-row">
            <div className="cbill-label" />
            <button className="cbill-btn primary" disabled={saving} onClick={() => void submit()}>
              {saving ? "Recording…" : "Record this payment"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Dates, memo and the billing-email override — previously a separate drawer. */
function InvoiceMeta({ invoice, onSaved }: { invoice: Invoice; onSaved: () => void }) {
  const [notes, setNotes] = useState(invoice.notes || "");
  const [email, setEmail] = useState(invoice.billingEmail || "");
  const [dueDate, setDueDate] = useState(String(invoice.dueDate || "").slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const save = async () => {
    setSaving(true); setErr(""); setOk("");
    try {
      await apiPut(`/admin/billing/invoices/${invoice.id}`, {
        notes: notes || null,
        // Sent explicitly — omitting it used to erase the override.
        billingEmail: email.trim() ? email.trim() : null,
        ...(dueDate ? { dueDate: new Date(`${dueDate}T12:00:00Z`).toISOString() } : {}),
      });
      setOk("Saved.");
      onSaved();
    } catch (e: any) {
      setErr(errText(e, "Could not save."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="cbill-card">
      <div className="cbill-card-hd">
        <h3>Dates &amp; memo</h3>
        <div className="cbill-toolbar">
          {err && <span style={{ color: "var(--cb-crit)", fontSize: 12.5 }}>{err}</span>}
          {ok && <span style={{ color: "var(--cb-good)", fontSize: 12.5 }}>{ok}</span>}
          <button className="cbill-btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <div className="cbill-card-bd">
        <div className="cbill-row">
          <div className="cbill-label">
            <span className="t">Due date</span>
            <span className="h">What the customer sees as their deadline</span>
          </div>
          <input className="cbill-input" style={{ width: 150 }} type="date" value={dueDate}
            onChange={(e) => setDueDate(e.target.value)} aria-label="Due date" />
        </div>
        <div className="cbill-row">
          <div className="cbill-label">
            <span className="t">Send this invoice to</span>
            <span className="h">Leave blank to use the customer's usual billing address</span>
          </div>
          <input className="cbill-input text" value={email} placeholder="(customer default)"
            onChange={(e) => setEmail(e.target.value)} aria-label="Invoice billing email" />
        </div>
        <div className="cbill-row">
          <div className="cbill-label">
            <span className="t">Memo</span>
            <span className="h">Printed on the invoice</span>
          </div>
          <input className="cbill-input text" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Memo" />
        </div>
      </div>
    </section>
  );
}
