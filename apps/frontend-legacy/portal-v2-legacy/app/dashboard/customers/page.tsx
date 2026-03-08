"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { canManageBilling, canManageCustomerWorkflow, canViewCustomers, readRoleFromToken } from "../../../lib/roles";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function CustomersPage() {
  const [role, setRole] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [segments, setSegments] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<"" | "overdue" | "unpaid" | "whatsapp" | "email_only" | "inactive">("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ displayName: "", companyName: "", primaryEmail: "", primaryPhone: "", whatsappNumber: "" });

  async function load(q?: string, filter?: string) {
    const token = localStorage.getItem("token") || "";
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (filter) params.set("filter", filter);
    const qs = params.toString();
    const [res, segmentRes] = await Promise.all([
      fetch(`${apiBase}/customers${qs ? `?${qs}` : ""}`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/customers/segments/summary`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    const json = await res.json().catch(() => []);
    const segmentJson = await segmentRes.json().catch(() => null);
    setRows(Array.isArray(json) ? json : []);
    setSegments(segmentJson || null);
  }

  useEffect(() => {
    setRole(readRoleFromToken());
    load().catch(() => setResult("Failed to load customers"));
  }, []);

  if (role && !canViewCustomers(role)) {
    return <div className="card"><h1>Customer Hub</h1><p>Access denied.</p></div>;
  }

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
      await load(search, activeFilter);
    }
    setLoading(false);
  }

  async function sendReminder(customerId: string) {
    setLoading(true);
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/customers/${customerId}/send-reminder`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    const json = await res.json().catch(() => ({}));
    setResult(res.ok ? "Reminder sent." : String(json?.error || "Reminder failed"));
    await load(search, activeFilter);
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
        <button disabled={loading} onClick={() => load(search, activeFilter)}>Refresh</button>
        <button disabled={loading} onClick={() => { setActiveFilter("overdue"); load(search, "overdue"); }}>Overdue ({segments?.totals?.overdueCustomers || 0})</button>
        <button disabled={loading} onClick={() => { setActiveFilter("unpaid"); load(search, "unpaid"); }}>Unpaid ({segments?.totals?.unpaidCustomers || 0})</button>
        <button disabled={loading} onClick={() => { setActiveFilter("whatsapp"); load(search, "whatsapp"); }}>WhatsApp ({segments?.totals?.withWhatsApp || 0})</button>
        <button disabled={loading} onClick={() => { setActiveFilter("email_only"); load(search, "email_only"); }}>Email Only ({segments?.totals?.emailOnly || 0})</button>
        <button disabled={loading} onClick={() => { setActiveFilter("inactive"); load(search, "inactive"); }}>Inactive ({segments?.totals?.inactive || 0})</button>
        <button disabled={loading} onClick={() => { setActiveFilter(""); load(search, ""); }}>Clear</button>
      </div>

      <div className="card">
        <h2>Create Customer</h2>
        <input value={newCustomer.displayName} onChange={(e) => setNewCustomer((v) => ({ ...v, displayName: e.target.value }))} placeholder="Display name" />
        <input value={newCustomer.companyName} onChange={(e) => setNewCustomer((v) => ({ ...v, companyName: e.target.value }))} placeholder="Company (optional)" />
        <input value={newCustomer.primaryEmail} onChange={(e) => setNewCustomer((v) => ({ ...v, primaryEmail: e.target.value }))} placeholder="Primary email (optional)" />
        <input value={newCustomer.primaryPhone} onChange={(e) => setNewCustomer((v) => ({ ...v, primaryPhone: e.target.value }))} placeholder="Primary phone (optional)" />
        <input value={newCustomer.whatsappNumber} onChange={(e) => setNewCustomer((v) => ({ ...v, whatsappNumber: e.target.value }))} placeholder="WhatsApp number (optional)" />
        <button disabled={loading || !canManageCustomerWorkflow(role)} onClick={createCustomer}>Create Customer</button>
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
              <th>Status / Tags</th>
              <th>Unpaid</th>
              <th>Balance</th>
              <th>Latest Activity</th>
              <th>Actions</th>
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
                <td>
                  <span>{row.status || "ACTIVE"}</span>
                  {Array.isArray(row.tags) && row.tags.length > 0 ? <div>{row.tags.join(", ")}</div> : null}
                </td>
                <td>{row.unpaidInvoiceCount || 0}</td>
                <td>${(Number(row.unpaidBalanceCents || 0) / 100).toFixed(2)}</td>
                <td>{row.latestActivityAt ? new Date(row.latestActivityAt).toLocaleString() : "-"}</td>
                <td>
                  <Link href={`/dashboard/customers/${row.id}`}>View</Link>{" "}
                  {canManageBilling(role) ? <button disabled={loading} onClick={() => sendReminder(row.id)}>Remind</button> : null}{" "}
                  <Link href={row.whatsappNumber ? `/dashboard/whatsapp` : `/dashboard/sms/campaigns/new`}>Message</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {result ? <pre>{result}</pre> : null}
    </div>
  );
}
