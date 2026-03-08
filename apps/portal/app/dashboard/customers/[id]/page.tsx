"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { canManageBilling, canManageCustomerWorkflow, canViewCustomers, readRoleFromToken } from "../../../../lib/roles";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [role, setRole] = useState("");
  const [summary, setSummary] = useState<any>(null);
  const [activity, setActivity] = useState<any[]>([]);
  const [notes, setNotes] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [tagsRaw, setTagsRaw] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!id) return;
    const token = localStorage.getItem("token") || "";
    const [summaryRes, activityRes, notesRes] = await Promise.all([
      fetch(`${apiBase}/customers/${id}/summary`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/customers/${id}/activity`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/customers/${id}/notes`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    const summaryJson = await summaryRes.json().catch(() => null);
    const activityJson = await activityRes.json().catch(() => ({ timeline: [] }));
    const notesJson = await notesRes.json().catch(() => []);
    setSummary(summaryJson);
    setActivity(Array.isArray(activityJson?.timeline) ? activityJson.timeline : []);
    setNotes(Array.isArray(notesJson) ? notesJson : []);
    if (summaryJson?.customer) {
      setEdit({
        displayName: summaryJson.customer.displayName || "",
        companyName: summaryJson.customer.companyName || "",
        primaryEmail: summaryJson.customer.primaryEmail || "",
        primaryPhone: summaryJson.customer.primaryPhone || "",
        whatsappNumber: summaryJson.customer.whatsappNumber || "",
        notes: summaryJson.customer.notes || "",
        status: summaryJson.customer.status || "ACTIVE"
      });
      setTagsRaw(Array.isArray(summaryJson.customer.tags) ? summaryJson.customer.tags.join(", ") : "");
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

  async function saveTags() {
    if (!id) return;
    setLoading(true);
    const token = localStorage.getItem("token") || "";
    const tags = tagsRaw.split(",").map((x) => x.trim()).filter(Boolean);
    const res = await fetch(`${apiBase}/customers/${id}/tags`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tags, status: edit?.status || "ACTIVE" })
    });
    const json = await res.json().catch(() => ({}));
    setStatus(res.ok ? "Tags updated." : String(json?.error || "Tag update failed"));
    await load();
    setLoading(false);
  }

  async function addNote() {
    if (!id || !noteInput.trim()) return;
    setLoading(true);
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/customers/${id}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: noteInput.trim() })
    });
    const json = await res.json().catch(() => ({}));
    setStatus(res.ok ? "Note added." : String(json?.error || "Failed to add note"));
    if (res.ok) setNoteInput("");
    await load();
    setLoading(false);
  }

  async function sendReminder() {
    if (!id) return;
    setLoading(true);
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/customers/${id}/send-reminder`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({}));
    setStatus(res.ok ? "Reminder sent." : String(json?.error || "Reminder failed"));
    await load();
    setLoading(false);
  }

  async function sendInvoice() {
    if (!id) return;
    setLoading(true);
    const token = localStorage.getItem("token") || "";
    const invoiceId = Array.isArray(summary?.invoices?.recent)
      ? (summary.invoices.recent.find((r: any) => ["DRAFT", "SENT", "OVERDUE"].includes(r.status))?.id || summary.invoices.recent[0]?.id)
      : undefined;
    const res = await fetch(`${apiBase}/customers/${id}/send-invoice`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ invoiceId })
    });
    const json = await res.json().catch(() => ({}));
    setStatus(res.ok ? "Invoice sent." : String(json?.error || "Invoice send failed"));
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
            <p><strong>Unpaid Balance:</strong> ${(Number(summary?.invoices?.unpaidBalanceCents || 0) / 100).toFixed(2)}</p>
            <p><strong>Status:</strong> {customer.status || "ACTIVE"}</p>
            <p><strong>Last Contacted:</strong> {customer.lastContactAt ? new Date(customer.lastContactAt).toLocaleString() : "-"}</p>
            <div className="row">
              {canManageBilling(role) ? <button disabled={loading} onClick={sendInvoice}>Send Invoice</button> : null}
              {canManageBilling(role) ? <button disabled={loading} onClick={sendReminder}>Send Reminder</button> : null}
              {summary?.whatsappActivity?.latestThread ? <Link href={`/dashboard/whatsapp/${summary.whatsappActivity.latestThread.id}`}>Open WhatsApp Thread</Link> : <Link href="/dashboard/whatsapp">Open WhatsApp</Link>}
              <Link href="/dashboard/billing/invoices">View Invoices</Link>
            </div>
          </div>

          <div className="card">
            <h2>Edit Customer</h2>
            <input value={edit?.displayName || ""} onChange={(e) => setEdit((v: any) => ({ ...v, displayName: e.target.value }))} placeholder="Display name" />
            <input value={edit?.companyName || ""} onChange={(e) => setEdit((v: any) => ({ ...v, companyName: e.target.value }))} placeholder="Company" />
            <input value={edit?.primaryEmail || ""} onChange={(e) => setEdit((v: any) => ({ ...v, primaryEmail: e.target.value }))} placeholder="Email" />
            <input value={edit?.primaryPhone || ""} onChange={(e) => setEdit((v: any) => ({ ...v, primaryPhone: e.target.value }))} placeholder="Phone" />
            <input value={edit?.whatsappNumber || ""} onChange={(e) => setEdit((v: any) => ({ ...v, whatsappNumber: e.target.value }))} placeholder="WhatsApp number" />
            <select value={edit?.status || "ACTIVE"} onChange={(e) => setEdit((v: any) => ({ ...v, status: e.target.value }))}>
              <option value="ACTIVE">ACTIVE</option>
              <option value="PAST_DUE">PAST_DUE</option>
              <option value="INACTIVE">INACTIVE</option>
            </select>
            <textarea value={edit?.notes || ""} onChange={(e) => setEdit((v: any) => ({ ...v, notes: e.target.value }))} placeholder="Notes" />
            <input value={tagsRaw} onChange={(e) => setTagsRaw(e.target.value)} placeholder="Tags comma-separated" />
            <div className="row">
              <button onClick={save} disabled={loading || !canManageCustomerWorkflow(role)}>Save</button>
              <button onClick={saveTags} disabled={loading || !canManageCustomerWorkflow(role)}>Save Tags</button>
            </div>
          </div>

          <div className="card">
            <h2>Notes</h2>
            <textarea value={noteInput} onChange={(e) => setNoteInput(e.target.value)} placeholder="Add follow-up note..." />
            <button onClick={addNote} disabled={loading || !canManageCustomerWorkflow(role)}>Add Note</button>
            {notes.length === 0 ? <p>No notes yet.</p> : (
              <ul>
                {notes.map((n) => (
                  <li key={n.id}>
                    <strong>{new Date(n.createdAt).toLocaleString()}</strong> - {n.createdByUser?.email || "staff"} - {n.body}
                  </li>
                ))}
              </ul>
            )}
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

          <div className="card">
            <h2>Unified Activity Timeline</h2>
            {activity.length === 0 ? <p>No activity yet.</p> : (
              <table>
                <thead><tr><th>When</th><th>Type</th><th>Label</th></tr></thead>
                <tbody>
                  {activity.map((a: any, idx: number) => (
                    <tr key={`${a.type}-${a.createdAt}-${idx}`}>
                      <td>{new Date(a.createdAt).toLocaleString()}</td>
                      <td>{a.type}</td>
                      <td>{a.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
      {status ? <pre>{status}</pre> : null}
    </div>
  );
}
