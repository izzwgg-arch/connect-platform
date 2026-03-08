"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [invoice, setInvoice] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!id) return;
    const token = localStorage.getItem("token") || "";
    const [invoiceRes, eventsRes] = await Promise.all([
      fetch(`${apiBase}/billing/invoices/${id}`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/billing/invoices/${id}/events`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    setInvoice(await invoiceRes.json().catch(() => null));
    setEvents(await eventsRes.json().catch(() => []));
  }

  useEffect(() => {
    load().catch(() => setStatus("Failed to load invoice details"));
  }, [id]);

  async function runAction(action: "send" | "remind" | "void") {
    if (!id) return;
    setLoading(true);
    setStatus("");
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/billing/invoices/${id}/${action}`, {
      method: "POST",
      headers: action === "void"
        ? { "content-type": "application/json", Authorization: `Bearer ${token}` }
        : { Authorization: `Bearer ${token}` },
      body: action === "void" ? JSON.stringify({ reason: "VOIDED_FROM_DETAIL" }) : undefined
    });
    const json = await res.json().catch(() => ({}));
    setStatus(res.ok ? `${action.toUpperCase()} completed.` : String(json?.error || `${action.toUpperCase()} failed`));
    await load();
    setLoading(false);
  }

  return (
    <div className="card">
      <h1>Invoice Detail</h1>
      {!invoice ? <p>Loading...</p> : (
        <>
          <div className="card">
            <p><strong>ID:</strong> {invoice.id}</p>
            <p><strong>Status:</strong> {invoice.status}</p>
            <p><strong>Email:</strong> {invoice.customerEmail}</p>
            <p><strong>Customer:</strong> {invoice.customer ? <Link href={`/dashboard/customers/${invoice.customer.id}`}>{invoice.customer.displayName}</Link> : "n/a"}</p>
            <p><strong>Phone:</strong> {invoice.customerPhone || "n/a"}</p>
            <p><strong>Amount:</strong> ${(Number(invoice.amountCents || 0) / 100).toFixed(2)} {invoice.currency}</p>
            <p><strong>Due:</strong> {invoice.dueAt ? new Date(invoice.dueAt).toLocaleString() : "n/a"}</p>
            <p><strong>Paid At:</strong> {invoice.paidAt ? new Date(invoice.paidAt).toLocaleString() : "n/a"}</p>
            <p><strong>Last Failure:</strong> {invoice.lastFailureReason || "n/a"}</p>
            <p><strong>Pay Link:</strong> {invoice.payToken ? <Link href={`/pay/invoice/${invoice.payToken}`} target="_blank">Open pay page</Link> : "n/a"}</p>
          </div>
          <div className="row">
            <button disabled={loading || invoice.status === "PAID" || invoice.status === "VOID"} onClick={() => runAction("send")}>Send</button>
            <button disabled={loading || invoice.status === "PAID" || invoice.status === "VOID"} onClick={() => runAction("remind")}>Remind</button>
            <button disabled={loading || invoice.status === "PAID" || invoice.status === "VOID"} onClick={() => runAction("void")}>Void</button>
          </div>
          <h2>Timeline</h2>
          {events.length === 0 ? <p>No events yet.</p> : (
            <table>
              <thead>
                <tr><th>When</th><th>Type</th><th>Details</th></tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>{new Date(event.createdAt).toLocaleString()}</td>
                    <td>{event.type}</td>
                    <td><code>{JSON.stringify(event.payload || {})}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h2>Payment Attempts</h2>
          {Array.isArray(invoice.paymentAttempts) && invoice.paymentAttempts.length > 0 ? (
            <table>
              <thead>
                <tr><th>When</th><th>Status</th><th>Type</th><th>Amount</th></tr>
              </thead>
              <tbody>
                {invoice.paymentAttempts.map((attempt: any) => (
                  <tr key={attempt.id}>
                    <td>{new Date(attempt.createdAt).toLocaleString()}</td>
                    <td>{attempt.status}</td>
                    <td>{attempt.type}</td>
                    <td>${(Number(attempt.amountCents || 0) / 100).toFixed(2)} {attempt.currency || "USD"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p>No payment attempts yet.</p>}
        </>
      )}
      {status ? <p>{status}</p> : null}
    </div>
  );
}
