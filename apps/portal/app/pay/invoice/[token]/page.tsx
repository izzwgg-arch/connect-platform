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
    if (!invoice?.canPay) {
      setStatus("This invoice cannot be paid in its current state.");
      return;
    }
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
          <p>
            {invoice.state === "paid" ? "This invoice is already paid."
              : invoice.state === "void" ? "This invoice has been voided."
                : invoice.state === "overdue" ? "This invoice is overdue. Please pay as soon as possible."
                  : "This invoice is unpaid."}
          </p>
          <p>Amount due: <strong>${(Number(invoice.amountCents || 0) / 100).toFixed(2)} {invoice.currency || "USD"}</strong></p>
          {invoice.state === "overdue" ? <p className="status-chip pending" style={{ borderRadius: 2 }}>Overdue</p> : null}
          <button onClick={payNow} disabled={!invoice.canPay}>{invoice.canPay ? "Pay Now" : "Payment Disabled"}</button>
          {!invoice.canPay ? <p>If you think this is a mistake, contact billing support.</p> : null}
        </>
      )}

      {status ? <p>{status}</p> : null}
    </main>
  );
}
