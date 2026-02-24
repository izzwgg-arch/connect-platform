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
  const [billingEmail, setBillingEmail] = useState("support@connectcomunications.com");
  const [paymentToken, setPaymentToken] = useState("");
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(true);
  const [message, setMessage] = useState("");

  async function loadSubscription() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/billing/subscription`, { headers: { Authorization: `Bearer ${token}` } });
    setSubscription(await res.json());
  }

  useEffect(() => {
    if (role === "ADMIN" || role === "SUPER_ADMIN") loadSubscription();
  }, [role]);

  async function startSubscription() {
    if ((process.env.NEXT_PUBLIC_SOLA_CARDKNOX_ENABLED || "false") !== "true") {
      setMessage("Cardknox SDK is not configured yet. Configure NEXT_PUBLIC_SOLA_CARDKNOX_ENABLED=true and hosted fields integration first.");
      return;
    }
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/billing/subscription/start`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ billingEmail, paymentToken })
    });
    setMessage(JSON.stringify(await res.json(), null, 2));
    await loadSubscription();
  }

  async function updatePaymentMethod() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/billing/subscription/update-payment-method`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ paymentToken })
    });
    setMessage(JSON.stringify(await res.json(), null, 2));
    await loadSubscription();
  }

  async function cancelSubscription() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/billing/subscription/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ cancelAtPeriodEnd })
    });
    setMessage(JSON.stringify(await res.json(), null, 2));
    await loadSubscription();
  }

  if (role !== "ADMIN" && role !== "SUPER_ADMIN") {
    return <div className="card"><h1>Billing</h1><p>Insufficient permissions.</p></div>;
  }

  return (
    <div className="card">
      <h1>Billing</h1>
      <p>Plan: SMS Monthly $10 per tenant.</p>
      <p>Status: <strong>{subscription?.status || "NONE"}</strong></p>
      <p>Current Period: {subscription?.currentPeriodStart ? new Date(subscription.currentPeriodStart).toLocaleDateString() : "-"} to {subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toLocaleDateString() : "-"}</p>
      <p>Payment Method: {subscription?.paymentMethod?.brand || "-"} {subscription?.paymentMethod?.last4 ? `****${subscription.paymentMethod.last4}` : ""}</p>

      <h3>Start Subscription</h3>
      <p>Use SOLA Cardknox tokenized payment capture. Raw card data is never stored by this app.</p>
      <input value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} placeholder="Billing email" />
      <input value={paymentToken} onChange={(e) => setPaymentToken(e.target.value)} placeholder="Cardknox payment token" />
      <button onClick={startSubscription} disabled={!paymentToken}>Start $10/mo Subscription</button>

      <h3>Update Payment Method</h3>
      <input value={paymentToken} onChange={(e) => setPaymentToken(e.target.value)} placeholder="New Cardknox payment token" />
      <button onClick={updatePaymentMethod} disabled={!paymentToken}>Update Payment Method</button>

      <h3>Cancel Subscription</h3>
      <label>
        <input type="checkbox" checked={cancelAtPeriodEnd} onChange={(e) => setCancelAtPeriodEnd(e.target.checked)} /> Cancel at period end
      </label>
      <button onClick={cancelSubscription}>Cancel Subscription</button>

      {message ? <pre>{message}</pre> : null}
    </div>
  );
}
