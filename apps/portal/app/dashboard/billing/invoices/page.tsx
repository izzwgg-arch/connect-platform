"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function BillingInvoicesPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [email, setEmail] = useState("customer@example.com");
  const [amountCents, setAmountCents] = useState(2500);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    const token = localStorage.getItem("token") || "";
    const [listRes, summaryRes] = await Promise.all([
      fetch(`${apiBase}/billing/invoices`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/billing/invoices/summary`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    const listJson = await listRes.json().catch(() => []);
    const summaryJson = await summaryRes.json().catch(() => null);
    setRows(Array.isArray(listJson) ? listJson : []);
    setSummary(summaryJson || null);
  }

  useEffect(() => {
    load().catch(() => setResult("Failed to load invoices"));
  }, []);

  async function createInvoice(sendEmail: boolean) {
    setLoading(true);
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/billing/invoices`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ customerEmail: email, amountCents: Number(amountCents), currency: "USD", sendEmail })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    await load();
    setLoading(false);
  }

  async function simulate(id: string, status: "SUCCEEDED" | "FAILED") {
    setLoading(true);
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/billing/invoices/${id}/simulate-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    await load();
    setLoading(false);
  }

  async function voidInvoice(id: string) {
    setLoading(true);
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/billing/invoices/${id}/void`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason: "VOIDED_FROM_PORTAL" })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    await load();
    setLoading(false);
  }

  async function remindInvoice(id: string) {
    setLoading(true);
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/billing/invoices/${id}/remind`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    await load();
    setLoading(false);
  }

  const filteredRows = rows.filter((r) => statusFilter === "ALL" ? true : r.status === statusFilter);

  function statusBadge(status: string) {
    if (status === "OVERDUE") return <span className="status-chip pending">OVERDUE</span>;
    if (status === "PAID") return <span className="status-chip live">PAID</span>;
    if (status === "VOID") return <span className="status-chip inactive">VOID</span>;
    if (status === "SENT") return <span className="status-chip">SENT</span>;
    return <span className="status-chip">{status || "DRAFT"}</span>;
  }

  return (
    <div className="card">
      <h1>Invoices</h1>
      <p>Create invoices, track lifecycle status, and send reminders.</p>
      <div className="row">
        <span>Total: {summary?.totalInvoices ?? rows.length}</span>
        <span>Outstanding: ${((summary?.totals?.outstandingCents || 0) / 100).toFixed(2)}</span>
        <span>Paid: ${((summary?.totals?.paidCents || 0) / 100).toFixed(2)}</span>
      </div>
      <label>Status Filter</label>
      <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
        <option value="ALL">All</option>
        <option value="DRAFT">Draft</option>
        <option value="SENT">Sent</option>
        <option value="OVERDUE">Overdue</option>
        <option value="PAID">Paid</option>
        <option value="VOID">Void</option>
      </select>
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Customer email" />
      <input type="number" value={amountCents} onChange={(e) => setAmountCents(Number(e.target.value || 0))} placeholder="Amount cents" />
      <button onClick={() => createInvoice(true)} disabled={loading}>Create + Send Invoice</button>
      <button onClick={() => createInvoice(false)} disabled={loading}>Create Draft Invoice</button>

      <table>
        <thead><tr><th>ID</th><th>Email</th><th>Amount</th><th>Status</th><th>Created</th><th>Pay Link</th><th>Actions</th></tr></thead>
        <tbody>
          {filteredRows.map((r) => (
            <tr key={r.id}>
              <td><Link href={`/dashboard/billing/invoices/${r.id}`}>{r.id.slice(0, 10)}...</Link></td>
              <td>{r.customerEmail}</td>
              <td>${(Number(r.amountCents || 0) / 100).toFixed(2)}</td>
              <td>{statusBadge(r.status)}</td>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
              <td>{r.payToken ? <a href={`/pay/invoice/${r.payToken}`} target="_blank">Open</a> : "-"}</td>
              <td>
                <button onClick={() => remindInvoice(r.id)} disabled={loading || r.status === "PAID" || r.status === "VOID"}>Remind</button>
                <button onClick={() => voidInvoice(r.id)} disabled={loading || r.status === "PAID" || r.status === "VOID"}>Void</button>
                <button onClick={() => simulate(r.id, "SUCCEEDED")} disabled={loading}>Sim Success</button>
                <button onClick={() => simulate(r.id, "FAILED")} disabled={loading}>Sim Fail</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <pre>{result}</pre>
    </div>
  );
}
