"use client";

import { useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function BillingInvoicesPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [email, setEmail] = useState("customer@example.com");
  const [amountCents, setAmountCents] = useState(2500);
  const [result, setResult] = useState("");

  async function load() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/billing/invoices`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => []);
    setRows(Array.isArray(json) ? json : []);
  }

  useEffect(() => {
    load().catch(() => setResult("Failed to load invoices"));
  }, []);

  async function createInvoice(sendEmail: boolean) {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/billing/invoices`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ customerEmail: email, amountCents: Number(amountCents), currency: "USD", sendEmail })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    await load();
  }

  async function simulate(id: string, status: "SUCCEEDED" | "FAILED") {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/billing/invoices/${id}/simulate-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    await load();
  }

  return (
    <div className="card">
      <h1>Invoices</h1>
      <p>Create invoice emails and monitor pay status.</p>
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Customer email" />
      <input type="number" value={amountCents} onChange={(e) => setAmountCents(Number(e.target.value || 0))} placeholder="Amount cents" />
      <button onClick={() => createInvoice(true)}>Create + Send Invoice</button>
      <button onClick={() => createInvoice(false)}>Create Draft Invoice</button>

      <table>
        <thead><tr><th>ID</th><th>Email</th><th>Amount</th><th>Status</th><th>Pay Link</th><th>Actions</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.customerEmail}</td>
              <td>${(Number(r.amountCents || 0) / 100).toFixed(2)}</td>
              <td>{r.status}</td>
              <td>{r.payToken ? <a href={`/pay/invoice/${r.payToken}`} target="_blank">Open</a> : "-"}</td>
              <td>
                <button onClick={() => simulate(r.id, "SUCCEEDED")}>Sim Success</button>
                <button onClick={() => simulate(r.id, "FAILED")}>Sim Fail</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <pre>{result}</pre>
    </div>
  );
}
