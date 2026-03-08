"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

type RangeKey = "24h" | "7d" | "30d";

export default function Dashboard() {
  const [range, setRange] = useState<RangeKey>("30d");
  const [summary, setSummary] = useState<any>(null);
  const [activity, setActivity] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(nextRange: RangeKey) {
    setLoading(true);
    setError("");
    const token = localStorage.getItem("token") || "";
    const [summaryRes, activityRes] = await Promise.all([
      fetch(`${apiBase}/dashboard/summary?range=${nextRange}`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/dashboard/activity?range=${nextRange}`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    const summaryJson = await summaryRes.json().catch(() => null);
    const activityJson = await activityRes.json().catch(() => ({ items: [] }));
    if (!summaryRes.ok || !activityRes.ok) {
      setError("Failed to load dashboard data.");
    }
    setSummary(summaryJson);
    setActivity(Array.isArray(activityJson?.items) ? activityJson.items : []);
    setLoading(false);
  }

  useEffect(() => {
    load(range).catch(() => {
      setError("Failed to load dashboard data.");
      setLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const cards = useMemo(() => ([
    { label: "Unpaid Invoices", value: summary?.invoiceSummary?.unpaidCount ?? 0 },
    { label: "Overdue Invoices", value: summary?.invoiceSummary?.overdueCount ?? 0 },
    { label: `Paid (${range})`, value: summary?.invoiceSummary?.paidInRangeCount ?? 0 },
    { label: "Payment Failures", value: summary?.paymentSummary?.recentFailureCount ?? 0 },
    { label: `SMS Campaigns Sent (${range})`, value: summary?.messagingSummary?.smsCampaignsSentInRange ?? 0 },
    { label: "WhatsApp Inbound", value: summary?.whatsappSummary?.inboundCount ?? 0 },
    { label: "WhatsApp Outbound", value: summary?.whatsappSummary?.outboundCount ?? 0 },
    { label: "Email Failures", value: summary?.emailSummary?.failedCount ?? 0 },
    { label: "Email Queued", value: summary?.emailSummary?.queuedCount ?? 0 },
    { label: "Customers Overdue", value: summary?.customerAttentionSummary?.overdueCustomerCount ?? 0 }
  ]), [range, summary]);

  return (
    <>
      <div className="card">
        <div className="page-head">
          <div>
            <h1>Operations Dashboard</h1>
            <p>Compact cross-channel operations cockpit for billing, messaging, customer engagement, and voice readiness.</p>
          </div>
          <div className="row">
            <label>Range</label>
            <select value={range} onChange={(e) => setRange(e.target.value as RangeKey)} disabled={loading}>
              <option value="24h">24h</option>
              <option value="7d">7d</option>
              <option value="30d">30d</option>
            </select>
          </div>
        </div>

        {error ? <p className="status-chip failed" style={{ borderRadius: 2 }}>{error}</p> : null}
        {loading ? <p>Loading dashboard...</p> : null}

        <div className="metric-grid">
          {cards.map((card) => (
            <div key={card.label} className="metric-card">
              <h4>{card.label}</h4>
              <strong>{card.value}</strong>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Attention Needed</h2>
        <h3>Overdue Customers</h3>
        {Array.isArray(summary?.attention?.overdueCustomers) && summary.attention.overdueCustomers.length > 0 ? (
          <table>
            <thead><tr><th>Customer</th><th>Overdue Invoices</th><th>Overdue Amount</th></tr></thead>
            <tbody>
              {summary.attention.overdueCustomers.map((c: any) => (
                <tr key={c.customerId || c.displayName}>
                  <td>{c.customerId ? <Link href={`/dashboard/customers/${c.customerId}`}>{c.displayName}</Link> : c.displayName}</td>
                  <td>{c.overdueInvoiceCount}</td>
                  <td>${(Number(c.overdueAmountCents || 0) / 100).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p>No overdue customers.</p>}

        <h3>Failed Email Jobs</h3>
        {Array.isArray(summary?.attention?.failedEmailJobs) && summary.attention.failedEmailJobs.length > 0 ? (
          <table>
            <thead><tr><th>Type</th><th>To</th><th>Error</th><th>When</th></tr></thead>
            <tbody>
              {summary.attention.failedEmailJobs.map((e: any) => (
                <tr key={e.id}>
                  <td>{e.type}</td>
                  <td>{e.toEmailMasked}</td>
                  <td>{e.lastErrorCode || "-"}</td>
                  <td>{new Date(e.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p>No failed email jobs.</p>}
        <p><Link href="/dashboard/settings/email">Open Email Settings</Link></p>

        <h3>Blocked or Suspended SMS Campaigns</h3>
        {Array.isArray(summary?.attention?.blockedCampaigns) && summary.attention.blockedCampaigns.length > 0 ? (
          <table>
            <thead><tr><th>Name</th><th>Status</th><th>Reason</th></tr></thead>
            <tbody>
              {summary.attention.blockedCampaigns.map((c: any) => (
                <tr key={c.id}>
                  <td><Link href={`/dashboard/sms/campaigns/${c.id}`}>{c.name}</Link></td>
                  <td>{c.status}</td>
                  <td>{c.holdReason || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p>No blocked campaigns.</p>}

        <h3>WhatsApp Inbound Requiring Follow-up</h3>
        {Array.isArray(summary?.attention?.whatsappInboundNeedsFollowup) && summary.attention.whatsappInboundNeedsFollowup.length > 0 ? (
          <table>
            <thead><tr><th>Contact</th><th>Status</th><th>Last Inbound</th></tr></thead>
            <tbody>
              {summary.attention.whatsappInboundNeedsFollowup.map((w: any) => (
                <tr key={w.threadId}>
                  <td><Link href={`/dashboard/whatsapp/${w.threadId}`}>{w.contactName || w.contactNumberMasked || "Thread"}</Link></td>
                  <td>{w.lastStatus || "-"}</td>
                  <td>{new Date(w.lastMessageAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p>No inbound follow-up needed.</p>}
      </div>

      <div className="card">
        <h2>Quick Actions</h2>
        <div className="row">
          <button type="button" onClick={() => { window.location.href = "/dashboard/voice/extensions"; }}>Create Extension</button>
          <button type="button" onClick={() => { window.location.href = "/dashboard/sms/campaigns/new"; }}>Create Campaign</button>
          <button type="button" onClick={() => { window.location.href = "/dashboard/billing/invoices"; }}>Create Invoice</button>
          <button type="button" onClick={() => { window.location.href = "/dashboard/customers"; }}>Add Customer</button>
        </div>
      </div>

      <div className="card">
        <h2>Recent Activity</h2>
        {activity.length === 0 ? <p>No recent activity in this range.</p> : (
          <table>
            <thead><tr><th>When</th><th>Type</th><th>Label</th><th>Link</th></tr></thead>
            <tbody>
              {activity.map((item: any, i: number) => (
                <tr key={`${item.type}-${item.timestamp}-${i}`}>
                  <td>{new Date(item.timestamp).toLocaleString()}</td>
                  <td>{item.type}</td>
                  <td>{item.label}</td>
                  <td><Link href={item.link}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
