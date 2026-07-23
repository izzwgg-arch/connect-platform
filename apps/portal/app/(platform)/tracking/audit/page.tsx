"use client";

import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm } from "../../../../components/crm";
import { deliveryApi } from "../../../../services/deliveryApi";

export default function TrackingAuditPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    deliveryApi.audit().then(setRows)
      .catch((e) => setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for this tenant yet." : "Couldn't load the audit log."))
      .finally(() => setLoading(false));
  }, []);
  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader icon={<History size={20} />} title="Audit log" subtitle="Immutable, tenant-scoped record of every delivery action." />
      <CRMCard padding="none">
        {error ? <p className="p-4 text-sm text-crm-muted">{error}</p>
          : loading ? <p className="p-4 text-sm text-crm-muted">Loading…</p>
          : rows.length === 0 ? <p className="p-4 text-sm text-crm-muted">No delivery activity recorded yet.</p>
          : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="border-b border-crm-border text-left text-[11px] uppercase tracking-wide text-crm-muted">
                <th className="px-4 py-2 font-semibold">Time</th><th className="px-4 py-2 font-semibold">Action</th>
                <th className="px-4 py-2 font-semibold">Target</th><th className="px-4 py-2 font-semibold">Actor</th></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="border-b border-crm-border hover:bg-crm-surface-2">
                    <td className="px-4 py-2.5 tabular-nums text-crm-muted">{new Date(a.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{a.action}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-crm-muted">{a.entityType}:{String(a.entityId).slice(-6)}</td>
                    <td className="px-4 py-2.5 text-crm-muted">{a.actorUserId ? String(a.actorUserId).slice(-8) : "system"}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
      </CRMCard>
    </CRMPageShell>
  );
}
