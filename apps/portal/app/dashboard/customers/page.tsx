"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function CustomersPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ displayName: "", companyName: "", primaryEmail: "", primaryPhone: "", whatsappNumber: "" });

  async function load(q?: string) {
    const token = localStorage.getItem("token") || "";
    const qs = q ? `?q=${encodeURIComponent(q)}` : "";
    const res = await fetch(`${apiBase}/customers${qs}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => []);
    setRows(Array.isArray(json) ? json : []);
  }

  useEffect(() => {
    load().catch(() => setResult("Failed to load customers"));
  }, []);

  async function createCustomer() {
    if (!newCustomer.displayName.trim()) {
      setResult("Display name is required");
      return;
    }
    setLoading(true);
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/customers`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        displayName: newCustomer.displayName.trim(),
        companyName: newCustomer.companyName || null,
        primaryEmail: newCustomer.primaryEmail || null,
        primaryPhone: newCustomer.primaryPhone || null,
        whatsappNumber: newCustomer.whatsappNumber || null
      })
    });
    const json = await res.json().catch(() => ({}));
    setResult(res.ok ? "Customer created" : String(json?.error || "Failed to create customer"));
    if (res.ok) {
      setNewCustomer({ displayName: "", companyName: "", primaryEmail: "", primaryPhone: "", whatsappNumber: "" });
      await load(search);
    }
    setLoading(false);
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      String(r.displayName || "").toLowerCase().includes(q)
      || String(r.companyName || "").toLowerCase().includes(q)
      || String(r.primaryEmail || "").toLowerCase().includes(q)
      || String(r.primaryPhone || "").includes(q)
      || String(r.whatsappNumber || "").includes(q)
    );
  }, [rows, search]);

  return (
    <div className="card">
      <h1>Customer Hub</h1>
      <p>Manage tenant customer records shared across billing, SMS, WhatsApp, and email.</p>

      <label>Search</label>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search name, email, phone, WhatsApp"
      />
      <div className="row">
        <button disabled={loading} onClick={() => load(search)}>Refresh</button>
      </div>

      <div className="card">
        <h2>Create Customer</h2>
        <input value={newCustomer.displayName} onChange={(e) => setNewCustomer((v) => ({ ...v, displayName: e.target.value }))} placeholder="Display name" />
        <input value={newCustomer.companyName} onChange={(e) => setNewCustomer((v) => ({ ...v, companyName: e.target.value }))} placeholder="Company (optional)" />
        <input value={newCustomer.primaryEmail} onChange={(e) => setNewCustomer((v) => ({ ...v, primaryEmail: e.target.value }))} placeholder="Primary email (optional)" />
        <input value={newCustomer.primaryPhone} onChange={(e) => setNewCustomer((v) => ({ ...v, primaryPhone: e.target.value }))} placeholder="Primary phone (optional)" />
        <input value={newCustomer.whatsappNumber} onChange={(e) => setNewCustomer((v) => ({ ...v, whatsappNumber: e.target.value }))} placeholder="WhatsApp number (optional)" />
        <button disabled={loading} onClick={createCustomer}>Create Customer</button>
      </div>

      {filtered.length === 0 ? <p>No customers found. Create one to start linking activity.</p> : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Company</th>
              <th>Email</th>
              <th>Phone</th>
              <th>WhatsApp</th>
              <th>Unpaid</th>
              <th>Latest Activity</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.id}>
                <td><Link href={`/dashboard/customers/${row.id}`}>{row.displayName}</Link></td>
                <td>{row.companyName || "-"}</td>
                <td>{row.primaryEmail || "-"}</td>
                <td>{row.primaryPhone || "-"}</td>
                <td>{row.whatsappNumber || "-"}</td>
                <td>{row.unpaidInvoiceCount || 0}</td>
                <td>{row.latestActivityAt ? new Date(row.latestActivityAt).toLocaleString() : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {result ? <pre>{result}</pre> : null}
    </div>
  );
}
