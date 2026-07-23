"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bell, RefreshCw } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../components/crm";
import { deliveryApi, type NotificationRow } from "../../../../services/deliveryApi";

const STATUS_TONE: Record<string, string> = {
  DELIVERED: "border-crm-success/40 bg-crm-success/10 text-crm-success",
  SENT: "border-crm-accent/40 bg-crm-accent/10 text-crm-accent",
  QUEUED: "border-crm-border bg-crm-surface-2 text-crm-muted",
  TEST: "border-crm-warning/40 bg-crm-warning/10 text-crm-warning",
  FAILED: "border-crm-danger/40 bg-crm-danger/10 text-crm-danger",
};
const FILTERS = ["", "SENT", "DELIVERED", "FAILED", "TEST"];

function ago(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(iso).toLocaleDateString();
}

export default function TrackingNotificationsPage() {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setRows(await deliveryApi.notifications(status || undefined));
    } catch (e: any) {
      setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for this tenant yet." : "Couldn't load notifications.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [status]);

  const testMode = useMemo(() => rows.length > 0 && rows.every((r) => r.status === "TEST"), [rows]);

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        icon={<Bell size={20} />}
        title="Notifications"
        subtitle="Customer SMS & voice notifications sent for delivery events."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button key={f || "all"} className={status === f ? crm.filterPillActive : crm.filterPill} onClick={() => setStatus(f)}>
                  {f ? f.toLowerCase() : "all"}
                </button>
              ))}
            </div>
            <button className={crm.btnSecondary} onClick={load}><RefreshCw size={14} /> Refresh</button>
          </div>
        }
      />

      {testMode && (
        <div className={cn(crm.bannerWarning, "rounded-crm px-3 py-2 text-xs font-medium")}>
          SMS is in test mode — messages are recorded but not delivered to carriers. Live send stays off until compliance sign-off.
        </div>
      )}

      <CRMCard padding="none">
        {error ? (
          <p className="p-4 text-sm text-crm-muted">{error}</p>
        ) : loading ? (
          <p className="p-4 text-sm text-crm-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-crm-muted">No notifications yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-crm-border text-left text-[11px] uppercase tracking-wide text-crm-muted">
                  <th className="px-4 py-2 font-semibold">When</th>
                  <th className="px-4 py-2 font-semibold">Trigger</th>
                  <th className="px-4 py-2 font-semibold">Channel</th>
                  <th className="px-4 py-2 font-semibold">To</th>
                  <th className="px-4 py-2 font-semibold">Order</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((n) => (
                  <tr key={n.id} className="border-b border-crm-border hover:bg-crm-surface-2">
                    <td className="px-4 py-2.5 text-crm-muted">{ago(n.createdAt)}</td>
                    <td className="px-4 py-2.5 text-crm-text">{n.trigger.replace(/_/g, " ").toLowerCase()}</td>
                    <td className="px-4 py-2.5 text-crm-muted">{n.channel}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-crm-muted">{n.toPhone || "—"}</td>
                    <td className="px-4 py-2.5">
                      <Link href={`/tracking/orders/${n.orderId}`} className="font-mono text-xs text-crm-accent hover:underline">{n.orderId.slice(-6)}</Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[n.status] || STATUS_TONE.QUEUED}`}>{n.status.toLowerCase()}</span>
                      {n.status === "FAILED" && n.errorReason ? <span className="ml-2 text-[11px] text-crm-danger">{n.errorReason}</span> : null}
                      {n.retryCount > 0 ? <span className="ml-2 text-[11px] text-crm-muted">·{n.retryCount} retr{n.retryCount === 1 ? "y" : "ies"}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CRMCard>
    </CRMPageShell>
  );
}
