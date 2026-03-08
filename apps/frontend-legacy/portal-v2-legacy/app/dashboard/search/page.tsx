"use client";

import Link from "next/link";
import { useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function GlobalSearchPage() {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");

  async function search() {
    if (q.trim().length < 2) return;
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/search/global?q=${encodeURIComponent(q.trim())}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) setError(json?.error || "Search failed.");
    else setError("");
    setResult(json);
  }

  return (
    <div className="card">
      <h1>Global Search</h1>
      <p>Search customers, invoices, phone numbers, and extensions.</p>
      <div className="row">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone, invoice id, extension..." />
        <button onClick={search}>Search</button>
      </div>
      {error ? <p>{error}</p> : null}
      {!result ? <p>Enter at least 2 characters to search.</p> : null}
      {result ? (
        <>
          <h2>Customers</h2>
          {(result.customers || []).map((r: any) => <p key={r.id}><Link href={r.link}>{r.displayName}</Link> {r.primaryPhone || ""}</p>)}
          <h2>Invoices</h2>
          {(result.invoices || []).map((r: any) => <p key={r.id}><Link href={r.link}>{r.id}</Link> {r.status}</p>)}
          <h2>Extensions</h2>
          {(result.extensions || []).map((r: any) => <p key={r.id}><Link href={r.link}>{r.ext}</Link> {r.label || ""}</p>)}
          <h2>Numbers</h2>
          {(result.numbers || []).map((r: any) => <p key={r.id}><Link href={r.link}>{r.phoneNumber}</Link></p>)}
        </>
      ) : null}
    </div>
  );
}
