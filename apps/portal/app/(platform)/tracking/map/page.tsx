"use client";

import { useEffect, useState } from "react";
import { Map as MapIcon, RefreshCw } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm } from "../../../../components/crm";
import { deliveryApi } from "../../../../services/deliveryApi";

const MOVE_TONE: Record<string, string> = {
  moving: "border-crm-success/40 bg-crm-success/10 text-crm-success",
  stopped: "border-crm-warning/40 bg-crm-warning/10 text-crm-warning",
  stale: "border-crm-danger/40 bg-crm-danger/10 text-crm-danger",
  offline: "border-crm-border bg-crm-surface-2 text-crm-muted",
  unknown: "border-crm-border bg-crm-surface-2 text-crm-muted",
};

export default function TrackingMapPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try { setRows(await deliveryApi.map()); }
    catch (e: any) { setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for this tenant yet." : "Couldn't load live map data."); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader icon={<MapIcon size={20} />} title="Live map" subtitle="Active runs and driver positions. Stale/offline drivers show no live pin."
        actions={<button className={crm.btnSecondary} onClick={load}><RefreshCw size={14} /> Refresh</button>} />
      <CRMCard padding="none">
        {error ? <p className="p-4 text-sm text-crm-muted">{error}</p>
          : loading ? <p className="p-4 text-sm text-crm-muted">Loading…</p>
          : rows.length === 0 ? <p className="p-4 text-sm text-crm-muted">No active runs right now.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-crm-border text-left text-[11px] uppercase tracking-wide text-crm-muted">
                  <th className="px-4 py-2 font-semibold">Run</th><th className="px-4 py-2 font-semibold">Driver</th>
                  <th className="px-4 py-2 font-semibold">Movement</th><th className="px-4 py-2 font-semibold">Position</th>
                  <th className="px-4 py-2 font-semibold">Last update</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.runId} className="border-b border-crm-border hover:bg-crm-surface-2">
                      <td className="px-4 py-2.5 font-mono text-xs">{String(r.runId).slice(-6)}</td>
                      <td className="px-4 py-2.5">{r.driverId ? String(r.driverId).slice(-6) : "—"}</td>
                      <td className="px-4 py-2.5"><span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${MOVE_TONE[r.movement] || MOVE_TONE.unknown}`}>{r.movement}</span></td>
                      <td className="px-4 py-2.5 font-mono text-xs text-crm-muted">{r.position ? `${r.position.lat.toFixed(4)}, ${r.position.lng.toFixed(4)}` : "hidden (not live)"}</td>
                      <td className="px-4 py-2.5 tabular-nums text-crm-muted">{r.lastUpdateSec == null ? "—" : `${Math.round(r.lastUpdateSec)}s ago`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </CRMCard>
      <p className="text-xs text-crm-muted">A visual map canvas lands with the map-provider wiring (Phase 5 finalize). This shows the same live data as a table.</p>
    </CRMPageShell>
  );
}
