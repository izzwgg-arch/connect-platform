"use client";

import { useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function CheckoutReturnPage() {
  const [status, setStatus] = useState<string>("PENDING");
  const [message, setMessage] = useState("Payment received. Finalizing subscription...");

  useEffect(() => {
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      const token = localStorage.getItem("token") || "";
      const res = await fetch(`${apiBase}/billing/subscription`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      const s = String(json?.status || "");
      setStatus(s);
      if (s === "ACTIVE") {
        setMessage("Subscription activated successfully.");
        clearInterval(timer);
      }
      if (s === "PAST_DUE" || s === "FAILED" || attempts >= 10) {
        if (s !== "ACTIVE") setMessage("Payment verification failed. Please retry checkout.");
        clearInterval(timer);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="card">
      <h1>Billing Checkout</h1>
      <p>{message}</p>
      <p>Current status: <strong>{status}</strong></p>
    </div>
  );
}
