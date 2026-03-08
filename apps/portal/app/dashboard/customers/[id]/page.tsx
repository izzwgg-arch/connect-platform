"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { canViewCustomers, readRoleFromToken } from "../../../../lib/roles";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [role, setRole] = useState("");
  const [summary, setSummary] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!id) return;
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/customers/${id}/summary`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null);
    setSummary(json);
    if (json?.customer) {
      setEdit({
        displayName: json.customer.displayName || "",
        companyName: json.customer.companyName || "",
        primaryEmail: json.customer.primaryEmail || "",
        primaryPhone: json.customer.primaryPhone || "",
        whatsappNumber: json.customer.whatsappNumber || "",
        notes: json.customer.notes || ""
      });
    }
  }

  useEffect(() => {
    setRole(readRoleFromToken());
    load().catch(() => setStatus("Failed to load customer summary"));
  }, [id]);

  if (role && !canViewCustomers(role)) {
    return <div className="card"><h1>Customer Detail</h1><p>Access denied.</p></div>;
  }

  async function save() {
    if (!id || !edit) return;
    setLoading(true);
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/customers/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(edit)
    });
    const json = await res.json().catch(() => ({}));
    setStatus(res.ok ? "Customer updated." : String(json?.error || "Update failed"));
    await load();
    setLoading(false);
  }

  const customer = summary?.customer;

  return (
    <div className="card">
      <h1>Customer Detail</h1>
      {!summary || !customer ? <p>Loading customer dashboard...</p> : (
        <>
          <div className="card">
            <h2>Summary</h2>
            <p><strong>Name:</strong> {customer.displayName}</p>
            <p><strong>Company:</strong> {customer.companyName || "-"}</p>
            <p><strong>Email:</strong> {customer.primaryEmail || "-"}</p>
            <p><strong>Phone:</strong> {customer.primaryPhone || "-"}</p>
            <p><strong>WhatsApp:</strong> {customer.whatsappNumber || "-"}</p>
            <p><strong>Unpaid Invoices:</strong> {summary?.invoices?.unpaidCount || 0}</p>
          </div>

          <div className="card">
            <h2>Edit Customer</h2>
            <input value={edit?.displayName || ""} onChange={(e) => setEdit((v: any) => ({ ...v, displayName: e.target.value }))} placeholder="Display name" />
            <input value={edit?.companyName || ""} onChange={(e) => setEdit((v: any) => ({ ...v, companyName: e.target.value }))} placeholder="Company" />
            <input value={edit?.primaryEmail || ""} onChange={(e) => setEdit((v: any) => ({ ...v, primaryEmail: e.target.value }))} placeholder="Email" />
            <input value={edit?.primaryPhone || ""} onChange={(e) => setEdit((v: any) => ({ ...v, primaryPhone: e.target.value }))} placeholder="Phone" />
            <input value={edit?.whatsappNumber || ""} onChange={(e) => setEdit((v: any) => ({ ...v, whatsappNumber: e.target.value }))} placeholder="WhatsApp number" />
            <textarea value={edit?.notes || ""} onChange={(e) => setEdit((v: any) => ({ ...v, notes: e.target.value }))} placeholder="Notes" />
            <button onClick={save} disabled={loading || role === "READ_ONLY"}>Save</button>
          </div>

          <div className="card">
            <h2>Invoices</h2>
            <p>Status totals: DRAFT {summary.invoices?.byStatus?.DRAFT || 0} | SENT {summary.invoices?.byStatus?.SENT || 0} | OVERDUE {summary.invoices?.byStatus?.OVERDUE || 0} | PAID {summary.invoices?.byStatus?.PAID || 0} | VOID {summary.invoices?.byStatus?.VOID || 0}</p>
            {Array.isArray(summary.invoices?.recent) && summary.invoices.recent.length > 0 ? (
              <table>
                <thead><tr><th>ID</th><th>Status</th><th>Amount</th><th>Created</th></tr></thead>
                <tbody>
                  {summary.invoices.recent.map((r: any) => (
                    <tr key={r.id}>
                      <td><Link href={`/dashboard/billing/invoices/${r.id}`}>{r.id.slice(0, 10)}...</Link></td>
                      <td>{r.status}</td>
                      <td>${(Number(r.amountCents || 0) / 100).toFixed(2)} {r.currency}</td>
                      <td>{new Date(r.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p>No invoices linked.</p>}
          </div>

          <div className="card">
            <h2>SMS Activity</h2>
            <p>Total recent messages: {summary.smsActivity?.totalRecent || 0}</p>
            <p>Latest activity: {summary.smsActivity?.latestAt ? new Date(summary.smsActivity.latestAt).toLocaleString() : "-"}</p>
          </div>

          <div className="card">
            <h2>WhatsApp Activity</h2>
            <p>Linked threads: {summary.whatsappActivity?.threadCount || 0}</p>
            {summary.whatsappActivity?.latestThread ? (
              <p>
                Latest thread: <Link href={`/dashboard/whatsapp/${summary.whatsappActivity.latestThread.id}`}>{summary.whatsappActivity.latestThread.id.slice(0, 10)}...</Link>
              </p>
            ) : <p>No linked thread.</p>}
          </div>

          <div className="card">
            <h2>Email Activity</h2>
            {Array.isArray(summary.emailActivity) && summary.emailActivity.length > 0 ? (
              <table>
                <thead><tr><th>Type</th><th>Status</th><th>Created</th><th>Error</th></tr></thead>
                <tbody>
                  {summary.emailActivity.map((e: any) => (
                    <tr key={e.id}>
                      <td>{e.type}</td>
                      <td>{e.status}</td>
                      <td>{new Date(e.createdAt).toLocaleString()}</td>
                      <td>{e.lastErrorCode || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p>No recent emails.</p>}
          </div>
        </>
      )}
      {status ? <pre>{status}</pre> : null}
    </div>
  );
}
