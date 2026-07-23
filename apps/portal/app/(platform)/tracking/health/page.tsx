"use client";

import { useEffect, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../components/crm";
import { deliveryApi } from "../../../../services/deliveryApi";

type Tone = "ok" | "info" | "warn";
function dot(tone: Tone) {
  return tone === "ok" ? "bg-crm-success" : tone === "warn" ? "bg-crm-warning" : "bg-crm-muted";
}

export default function TrackingHealthPage() {
  const [cfg, setCfg] = useState<any>(null);
  const [counts, setCounts] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [c, d] = await Promise.all([deliveryApi.config(), deliveryApi.dashboard()]);
      setCfg(c);
      setCounts(d.counts);
    } catch (e: any) {
      setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for this tenant yet." : "Couldn't load system health.");
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const items: { name: string; tone: Tone; detail: string }[] = [
    { name: "Feature flag", tone: cfg?.enabled ? "ok" : "warn", detail: cfg ? (cfg.enabled ? "Delivery is enabled for this tenant." : "Delivery is disabled for this tenant.") : "…" },
    { name: "Order ingest", tone: "warn", detail: "Mock adapter active — live Order API pending its spec (later phase)." },
    { name: "Location ingestion", tone: "ok", detail: "Driver GPS samples accepted; staleness detection active (never stale-as-live)." },
    { name: "ETA engine", tone: "info", detail: "Heuristic stops-away estimate — refined as routing telemetry lands (approximate)." },
    { name: "Notifications (SMS)", tone: "warn", detail: "Test mode — messages recorded, not delivered, until compliance sign-off." },
    { name: "Voice / IVR", tone: "info", detail: "Read-only status resolve; no VitalPBX writes (safe mode)." },
    { name: "Retention sweep", tone: "ok", detail: cfg ? `Location/ETA data retained ${cfg.retentionDays ?? 30} days, then swept.` : "…" },
    { name: "Multi-tenant isolation", tone: "ok", detail: "Every query is tenant-scoped; no cross-tenant reads." },
  ];

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        icon={<Activity size={20} />}
        title="System health"
        subtitle="Operational status of the delivery-tracking subsystems."
        actions={<button className={crm.btnSecondary} onClick={load}><RefreshCw size={14} /> Refresh</button>}
      />
      {error && <CRMCard><p className="text-sm text-crm-muted">{error}</p></CRMCard>}

      {counts && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <CRMCard padding="md"><div className="text-2xl font-semibold tabular-nums text-crm-text">{counts.activeDeliveries ?? 0}</div><div className="mt-1 text-xs text-crm-muted">Active deliveries</div></CRMCard>
          <CRMCard padding="md"><div className="text-2xl font-semibold tabular-nums text-crm-text">{counts.activeRuns ?? 0}</div><div className="mt-1 text-xs text-crm-muted">Active runs</div></CRMCard>
          <CRMCard padding="md"><div className="text-2xl font-semibold tabular-nums text-crm-text">{counts.driversOnline ?? 0}</div><div className="mt-1 text-xs text-crm-muted">Drivers online</div></CRMCard>
          <CRMCard padding="md"><div className="text-2xl font-semibold tabular-nums text-crm-text">{counts.deliveredToday ?? 0}</div><div className="mt-1 text-xs text-crm-muted">Delivered today</div></CRMCard>
        </div>
      )}

      <CRMCard padding="none">
        <ul className="flex flex-col">
          {items.map((it) => (
            <li key={it.name} className="flex items-center gap-3 border-b border-crm-border px-4 py-3 last:border-b-0">
              <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dot(it.tone))} />
              <span className="w-44 shrink-0 text-sm font-medium text-crm-text">{it.name}</span>
              <span className="text-sm text-crm-muted">{it.detail}</span>
            </li>
          ))}
        </ul>
      </CRMCard>
    </CRMPageShell>
  );
}
