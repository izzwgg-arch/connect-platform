"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Package } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm } from "../../../../components/crm";
import { deliveryApi, type DeliveryOrderRow } from "../../../../services/deliveryApi";

const STATUS_TONES: Record<string, string> = {
  DELIVERED: "border-crm-success/40 bg-crm-success/10 text-crm-success",
  CANCELED: "border-crm-border bg-crm-surface-2 text-crm-muted",
  DELIVERY_FAILED: "border-crm-danger/40 bg-crm-danger/10 text-crm-danger",
  OUT_FOR_DELIVERY: "border-crm-accent/40 bg-crm-accent/10 text-crm-accent",
  EN_ROUTE: "border-crm-accent/40 bg-crm-accent/10 text-crm-accent",
};
function statusClass(s: string) {
  return STATUS_TONES[s] || "border-crm-border bg-crm-surface-2 text-crm-muted";
}

const FILTERS = ["", "READY", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_FAILED"];

export default function DeliveryOrdersPage() {
  const [rows, setRows] = useState<DeliveryOrderRow[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    deliveryApi
      .orders({ status: status || undefined })
      .then(setRows)
      .catch((e) => setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for this tenant yet." : "Couldn't load orders."))
      .finally(() => setLoading(false));
  }, [status]);

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        icon={<Package size={20} />}
        title="Orders"
        subtitle="Search and manage delivery orders. Open one for its full audit timeline."
        actions={
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f || "all"}
                className={status === f ? crm.filterPillActive : crm.filterPill}
                onClick={() => setStatus(f)}
              >
                {f ? f.replace(/_/g, " ").toLowerCase() : "all"}
              </button>
            ))}
          </div>
        }
      />

      <CRMCard padding="none">
        {error ? (
          <p className="p-4 text-sm text-crm-muted">{error}</p>
        ) : loading ? (
          <p className="p-4 text-sm text-crm-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-crm-muted">No orders match this filter.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-crm-border text-left text-[11px] uppercase tracking-wide text-crm-muted">
                  <th className="px-4 py-2 font-semibold">Order</th>
                  <th className="px-4 py-2 font-semibold">Customer / address</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} className="border-b border-crm-border hover:bg-crm-surface-2">
                    <td className="px-4 py-2.5 font-mono text-xs text-crm-text">{o.sourceId}</td>
                    <td className="px-4 py-2.5 text-crm-text">
                      {o.customerName || "—"} <span className="text-crm-muted">· {o.addrLine1}{o.addrUnit ? ` ${o.addrUnit}` : ""}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusClass(o.status)}`}>
                        {o.status.replace(/_/g, " ").toLowerCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Link href={`/tracking/orders/${o.id}`} className={crm.btnGhost}>Open</Link>
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
