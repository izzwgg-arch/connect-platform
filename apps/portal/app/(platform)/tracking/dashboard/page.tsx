"use client";

import { useEffect, useState } from "react";
import { Truck, AlertTriangle, RefreshCw } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../components/crm";
import { deliveryApi, type DashboardResponse, type DashboardTile } from "../../../../services/deliveryApi";

const toneClass: Record<DashboardTile["tone"], string> = {
  neutral: "text-crm-text",
  positive: "text-crm-success",
  warn: "text-crm-warning",
  danger: "text-crm-danger",
};

export default function DeliveryDashboardPage() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setData(await deliveryApi.dashboard());
    } catch (e: any) {
      setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for this tenant yet." : "Couldn't load the dashboard.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000); // poll fallback; realtime WS lands in Phase 5
    return () => clearInterval(t);
  }, []);

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        icon={<Truck size={20} />}
        title="Delivery dashboard"
        subtitle="Live view of active deliveries, drivers, and anything that needs attention."
        actions={
          <button className={crm.btnSecondary} onClick={load}>
            <RefreshCw size={14} /> Refresh
          </button>
        }
      />

      {error ? (
        <CRMCard><p className="text-sm text-crm-muted">{error}</p></CRMCard>
      ) : loading && !data ? (
        <CRMCard><p className="text-sm text-crm-muted">Loading…</p></CRMCard>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {data.tiles.map((t) => (
              <CRMCard key={t.key} padding="md">
                <div className={cn("text-2xl font-semibold tabular-nums", toneClass[t.tone])}>{t.value}</div>
                <div className="mt-1 text-xs text-crm-muted">{t.label}</div>
              </CRMCard>
            ))}
          </div>

          <CRMCard>
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle size={15} className="text-crm-warning" />
              <h2 className="text-sm font-semibold text-crm-text">Needs attention</h2>
              {data.needsIntervention ? (
                <span className="ml-auto rounded-full border border-crm-danger/40 bg-crm-danger/10 px-2 py-0.5 text-[11px] font-semibold text-crm-danger">
                  action required
                </span>
              ) : null}
            </div>
            {data.attention.length === 0 ? (
              <p className="text-sm text-crm-muted">All caught up — no exceptions right now.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.attention.map((a, i) => (
                  <li key={`${a.ref}-${i}`} className="flex items-center gap-3 rounded-crm border border-crm-border bg-crm-surface-2 px-3 py-2">
                    <span className="rounded-full border border-crm-border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-crm-muted">
                      {a.kind.replace(/_/g, " ")}
                    </span>
                    <span className="font-mono text-xs text-crm-text">{a.ref}</span>
                    <span className="text-xs text-crm-muted">{a.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </CRMCard>
        </>
      ) : null}
    </CRMPageShell>
  );
}
