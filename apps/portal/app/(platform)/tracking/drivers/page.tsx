"use client";

import { useEffect, useMemo, useState } from "react";
import { Truck, Search, BatteryLow, BatteryMedium, BatteryFull } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../components/crm";
import { deliveryApi, type DriverRow } from "../../../../services/deliveryApi";

const STATUS_TONE: Record<string, string> = {
  ON_RUN: "border-crm-success/40 bg-crm-success/10 text-crm-success",
  AVAILABLE: "border-crm-accent/40 bg-crm-accent/10 text-crm-accent",
  OFFLINE: "border-crm-border bg-crm-surface-2 text-crm-muted",
};

const STALE_MS = 5 * 60_000; // no fix in 5 min while on a run = stale GPS

function syncAge(iso?: string | null): { label: string; stale: boolean } {
  if (!iso) return { label: "never", stale: false };
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  const label = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
  return { label, stale: ms > STALE_MS };
}

function BatteryPip({ pct }: { pct?: number | null }) {
  if (pct == null) return <span className="text-crm-muted">—</span>;
  const tone = pct <= 15 ? "text-crm-danger" : pct <= 40 ? "text-crm-warning" : "text-crm-success";
  const Icon = pct <= 15 ? BatteryLow : pct <= 40 ? BatteryMedium : BatteryFull;
  return (
    <span className={cn("inline-flex items-center gap-1 tabular-nums", tone)}>
      <Icon size={14} /> {pct}%
    </span>
  );
}

export default function TrackingDriversPage() {
  const [rows, setRows] = useState<DriverRow[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setRows(await deliveryApi.drivers());
    } catch (e: any) {
      setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for this tenant yet." : "Couldn't load drivers.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? rows.filter((d) => [d.name, d.userId].some((v) => String(v).toLowerCase().includes(n))) : rows;
  }, [rows, q]);
  const onShift = rows.filter((d) => d.status !== "OFFLINE" && d.active).length;

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        icon={<Truck size={20} />}
        title="Drivers"
        subtitle="Delivery drivers, their status, and device health — spot a stale-GPS cause fast."
        actions={
          <div className="flex items-center gap-2">
            {rows.length > 0 && (
              <span className="rounded-full border border-crm-border bg-crm-surface-2 px-2.5 py-0.5 text-xs font-medium text-crm-muted">{onShift} on shift</span>
            )}
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-crm-muted" />
              <input className={cn(crm.input, crm.inputWithIcon, "h-9 w-48")} placeholder="Search driver…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
        }
      />
      <CRMCard padding="none">
        {error ? (
          <p className="p-4 text-sm text-crm-muted">{error}</p>
        ) : loading ? (
          <p className="p-4 text-sm text-crm-muted">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="p-4 text-sm text-crm-muted">{rows.length === 0 ? "No drivers yet." : "No drivers match your search."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-crm-border text-left text-[11px] uppercase tracking-wide text-crm-muted">
                  <th className="px-4 py-2 font-semibold">Driver</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold">Active run</th>
                  <th className="px-4 py-2 font-semibold">Last sync</th>
                  <th className="px-4 py-2 font-semibold">Battery</th>
                  <th className="px-4 py-2 font-semibold">Stores</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => {
                  const sync = syncAge(d.lastSyncAt);
                  const onRun = d.status === "ON_RUN";
                  return (
                    <tr key={d.id} className="border-b border-crm-border hover:bg-crm-surface-2">
                      <td className="px-4 py-2.5 text-crm-text">{d.name}</td>
                      <td className="px-4 py-2.5">
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[d.status] || STATUS_TONE.OFFLINE}`}>{d.status.replace(/_/g, " ").toLowerCase()}</span>
                        {!d.active && <span className="ml-2 text-[11px] text-crm-danger">deactivated</span>}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-crm-muted">{d.activeRunId ? d.activeRunId.slice(-6) : "—"}</td>
                      <td className="px-4 py-2.5">
                        <span className={cn("tabular-nums", onRun && sync.stale ? "font-semibold text-crm-warning" : "text-crm-muted")}>
                          {sync.label}{onRun && sync.stale ? " · stale" : ""}
                        </span>
                      </td>
                      <td className="px-4 py-2.5"><BatteryPip pct={d.batteryPct} /></td>
                      <td className="px-4 py-2.5 text-crm-muted tabular-nums">{d.storeCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CRMCard>
    </CRMPageShell>
  );
}
