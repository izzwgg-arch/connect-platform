"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function PublicInvoicePayPage() {
  const params = useParams<{ token: string }>();
  const search = useSearchParams();
  const token = params?.token;
  const [invoice, setInvoice] = useState<any>(null);
  const [status, setStatus] = useState("");

  async function load() {
    if (!token) return;
    const res = await fetch(`${apiBase}/billing/invoices/pay/${token}`);
    const json = await res.json().catch(() => null);
    setInvoice(json);
  }

  useEffect(() => {
    load().catch(() => setStatus("Unable to load invoice"));
  }, [token]);

  async function payNow() {
    if (!token) return;
    setStatus("Starting hosted checkout...");
    const res = await fetch(`${apiBase}/billing/invoices/pay/${token}/hosted-session`, { method: "POST" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.redirectUrl) {
      setStatus(String(json?.error || "Unable to create hosted session"));
      return;
    }
    window.location.href = json.redirectUrl;
  }

  return (
    <main className="card" style={{ maxWidth: 640, margin: "2rem auto" }}>
      <h1>Pay Invoice</h1>
      {search.get("result") === "success" ? <p className="status-chip live" style={{ borderRadius: 2 }}>Payment completed. Confirmation pending webhook finalization.</p> : null}
      {search.get("result") === "cancel" ? <p className="status-chip pending" style={{ borderRadius: 2 }}>Checkout cancelled. You can retry payment below.</p> : null}

      {!invoice ? <p>Loading invoice...</p> : (
        <>
          <p>Status: <strong>{invoice.status}</strong></p>
          <p>Amount due: <strong>${(Number(invoice.amountCents || 0) / 100).toFixed(2)} {invoice.currency || "USD"}</strong></p>
          <button onClick={payNow} disabled={invoice.status === "PAID"}>{invoice.status === "PAID" ? "Paid" : "Pay Now"}</button>
        </>
      )}

      {status ? <p>{status}</p> : null}
    </main>
  );
}
