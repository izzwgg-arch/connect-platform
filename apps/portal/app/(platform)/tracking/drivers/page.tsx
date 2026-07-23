"use client";

import { useEffect, useState } from "react";
import { Truck } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm } from "../../../../components/crm";
import { deliveryApi } from "../../../../services/deliveryApi";

const STATUS_TONE: Record<string, string> = {
  ON_RUN: "border-crm-success/40 bg-crm-success/10 text-crm-success",
  AVAILABLE: "border-crm-accent/40 bg-crm-accent/10 text-crm-accent",
  OFFLINE: "border-crm-border bg-crm-surface-2 text-crm-muted",
};

export default function TrackingDriversPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    deliveryApi.drivers().then(setRows)
      .catch((e) => setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for this tenant yet." : "Couldn't load drivers."))
      .finally(() => setLoading(false));
  }, []);
  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader icon={<Truck size={20} />} title="Drivers" subtitle="Delivery drivers and their current operational status." />
      <CRMCard padding="none">
        {error ? <p className="p-4 text-sm text-crm-muted">{error}</p>
          : loading ? <p className="p-4 text-sm text-crm-muted">Loading…</p>
          : rows.length === 0 ? <p className="p-4 text-sm text-crm-muted">No drivers yet.</p>
          : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="border-b border-crm-border text-left text-[11px] uppercase tracking-wide text-crm-muted">
                <th className="px-4 py-2 font-semibold">Driver</th><th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">Active run</th><th className="px-4 py-2 font-semibold">Stores</th></tr></thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id} className="border-b border-crm-border hover:bg-crm-surface-2">
                    <td className="px-4 py-2.5 font-mono text-xs">{String(d.userId).slice(-8)}</td>
                    <td className="px-4 py-2.5"><span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[d.status] || STATUS_TONE.OFFLINE}`}>{d.status}</span>{!d.active && <span className="ml-2 text-[11px] text-crm-danger">deactivated</span>}</td>
                    <td className="px-4 py-2.5 text-crm-muted">{d.activeRunId ? String(d.activeRunId).slice(-6) : "—"}</td>
                    <td className="px-4 py-2.5 text-crm-muted">{(d.stores || []).length}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
      </CRMCard>
    </CRMPageShell>
  );
}
