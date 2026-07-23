"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm } from "../../../../components/crm";
import { deliveryApi } from "../../../../services/deliveryApi";

export default function TrackingExceptionsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    deliveryApi.exceptions().then(setRows)
      .catch((e) => setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for this tenant yet." : "Couldn't load exceptions."))
      .finally(() => setLoading(false));
  }, []);
  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader icon={<AlertTriangle size={20} />} title="Exception queue" subtitle="Orders needing dispatcher attention." />
      <CRMCard padding="none">
        {error ? <p className="p-4 text-sm text-crm-muted">{error}</p>
          : loading ? <p className="p-4 text-sm text-crm-muted">Loading…</p>
          : rows.length === 0 ? <p className="p-4 text-sm text-crm-muted">No open exceptions. All caught up.</p>
          : (
            <ul className="divide-y divide-crm-border">
              {rows.map((o) => (
                <li key={o.id} className="flex items-center justify-between px-4 py-3">
                  <div><span className="font-mono text-xs text-crm-text">{o.sourceId}</span> <span className="ml-2 text-sm text-crm-muted">{o.addrLine1}</span></div>
                  <span className="rounded-full border border-crm-warning/40 bg-crm-warning/10 px-2 py-0.5 text-[11px] font-semibold text-crm-warning">{String(o.status).replace(/_/g, " ").toLowerCase()}</span>
                </li>
              ))}
            </ul>
          )}
      </CRMCard>
    </CRMPageShell>
  );
}
