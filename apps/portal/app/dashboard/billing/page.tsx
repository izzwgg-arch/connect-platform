"use client";

import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

function readJwtRole(): string {
  const token = localStorage.getItem("token");
  if (!token) return "";
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.role || "";
  } catch {
    return "";
  }
}

export default function BillingPage() {
  const role = useMemo(() => (typeof window !== "undefined" ? readJwtRole() : ""), []);
  const [subscription, setSubscription] = useState<any>(null);
  const [receipts, setReceipts] = useState<any[]>([]);
  const [billingEmail, setBillingEmail] = useState("support@connectcomunications.com");
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(true);
  const [message, setMessage] = useState("");

  async function load() {
    const token = localStorage.getItem("token") || "";
    const [subRes, rcptRes] = await Promise.all([
      fetch(`${apiBase}/billing/subscription`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/billing/receipts`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    setSubscription(await subRes.json());
    const rc = await rcptRes.json();
    setReceipts(Array.isArray(rc) ? rc : []);
  }

  useEffect(() => {
    if (role === "ADMIN" || role === "SUPER_ADMIN") load();
  }, [role]);

  async function startHostedCheckout() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/billing/subscription/hosted-session`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ billingEmail })
    });
    const json = await res.json();
    if (!res.ok) {
      setMessage(JSON.stringify(json, null, 2));
      return;
    }
    if (json.redirectUrl) {
      window.location.href = json.redirectUrl;
      return;
    }
    setMessage("Hosted checkout URL was not returned.");
  }

  async function cancelSubscription() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/billing/subscription/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ cancelAtPeriodEnd })
    });
    setMessage(JSON.stringify(await res.json(), null, 2));
    await load();
  }

  if (role !== "ADMIN" && role !== "SUPER_ADMIN") {
    return <div className="card"><h1>Billing</h1><p>Insufficient permissions.</p></div>;
  }

  return (
    <div className="card">
      <h1>Billing</h1>
      <p><strong>Activate SMS Plan - $10/month</strong></p>
      <p>Status: <strong>{subscription?.status || "NONE"}</strong></p>
      <p>Current Period: {subscription?.currentPeriodStart ? new Date(subscription.currentPeriodStart).toLocaleDateString() : "-"} to {subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toLocaleDateString() : "-"}</p>

      <h3>Hosted Checkout</h3>
      <p>Hosted checkout is the only billing method. Card data is never handled by this app.</p>
      <input value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} placeholder="Billing email" />
      <button onClick={startHostedCheckout} disabled={subscription?.status === "ACTIVE"}>Activate SMS Plan - $10/month</button>

      <h3>Cancel Subscription</h3>
      <label>
        <input type="checkbox" checked={cancelAtPeriodEnd} onChange={(e) => setCancelAtPeriodEnd(e.target.checked)} /> Cancel at period end
      </label>
      <button onClick={cancelSubscription}>Cancel Subscription</button>

      <h3>Receipts</h3>
      <table>
        <thead>
          <tr><th>ID</th><th>Amount</th><th>Period</th><th>Created</th></tr>
        </thead>
        <tbody>
          {receipts.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>${(Number(r.amountCents || 0) / 100).toFixed(2)}</td>
              <td>{new Date(r.periodStart).toLocaleDateString()} - {new Date(r.periodEnd).toLocaleDateString()}</td>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {message ? <pre>{message}</pre> : null}
    </div>
  );
}
