"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Truck, ArrowLeft, BatteryLow, BatteryMedium, BatteryFull, AlertTriangle } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../../components/crm";
import { deliveryApi } from "../../../../../services/deliveryApi";

const STATUS_TONE: Record<string, string> = {
  ON_RUN: "border-crm-success/40 bg-crm-success/10 text-crm-success",
  AVAILABLE: "border-crm-accent/40 bg-crm-accent/10 text-crm-accent",
  OFFLINE: "border-crm-border bg-crm-surface-2 text-crm-muted",
};
const RUN_TONE: Record<string, string> = {
  ACTIVE: "text-crm-success",
  PAUSED: "text-crm-warning",
  DRAFT: "text-crm-muted",
  COMPLETED: "text-crm-accent",
  CLOSED: "text-crm-muted",
};

function ago(iso?: string | null): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}
function Battery({ pct }: { pct?: number | null }) {
  if (pct == null) return <span className="text-crm-muted">—</span>;
  const tone = pct <= 15 ? "text-crm-danger" : pct <= 40 ? "text-crm-warning" : "text-crm-success";
  const Icon = pct <= 15 ? BatteryLow : pct <= 40 ? BatteryMedium : BatteryFull;
  return <span className={cn("inline-flex items-center gap-1 tabular-nums", tone)}><Icon size={15} /> {pct}%</span>;
}

export default function DriverDetailPage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id || "");
  const [d, setD] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    deliveryApi.driver(id).then(setD).catch(() => setError("Couldn't load this driver.")).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <CRMPageShell><CRMCard><p className="text-sm text-crm-muted">Loading…</p></CRMCard></CRMPageShell>;
  if (error || !d) return <CRMPageShell><CRMCard><p className="text-sm text-crm-muted">{error || "Not found."}</p></CRMCard></CRMPageShell>;

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        icon={<Truck size={20} />}
        title={d.name}
        subtitle={`${d.storeCount} store${d.storeCount === 1 ? "" : "s"} · ${d.active ? "active" : "deactivated"}`}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/tracking/drivers" className={crm.btnGhost}><ArrowLeft size={14} /> Drivers</Link>
            <span className={cn("rounded-full border px-2.5 py-1 text-xs font-semibold", STATUS_TONE[d.status] || STATUS_TONE.OFFLINE)}>{String(d.status).replace(/_/g, " ").toLowerCase()}</span>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <CRMCard padding="md"><div className="text-[11px] text-crm-muted">Last sync</div><div className="mt-1 text-lg font-semibold tabular-nums text-crm-text">{ago(d.lastSyncAt)}</div></CRMCard>
        <CRMCard padding="md"><div className="text-[11px] text-crm-muted">Battery</div><div className="mt-1 text-lg font-semibold"><Battery pct={d.batteryPct} /></div></CRMCard>
        <CRMCard padding="md"><div className="text-[11px] text-crm-muted">Active run</div><div className="mt-1 font-mono text-sm text-crm-text">{d.activeRunId ? d.activeRunId.slice(-6) : "—"}</div></CRMCard>
        <CRMCard padding="md"><div className="text-[11px] text-crm-muted">Exceptions logged</div><div className="mt-1 text-lg font-semibold tabular-nums text-crm-text">{(d.exceptions || []).length}</div></CRMCard>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <CRMCard className="lg:col-span-2" padding="none">
          <h2 className="border-b border-crm-border px-4 py-3 text-sm font-semibold text-crm-text">Recent runs</h2>
          {(d.runs || []).length === 0 ? (
            <p className="p-4 text-sm text-crm-muted">No runs yet.</p>
          ) : (
            <ul className="flex flex-col">
              {d.runs.map((r: any) => (
                <li key={r.id} className="flex items-center justify-between border-b border-crm-border px-4 py-2.5 last:border-b-0">
                  <Link href={`/tracking/runs/${r.id}`} className="font-mono text-xs text-crm-accent hover:underline">{r.id.slice(-6)}</Link>
                  <span className={cn("text-xs font-medium", RUN_TONE[r.status] || "text-crm-muted")}>{String(r.status).toLowerCase()}</span>
                  <span className="text-xs tabular-nums text-crm-muted">{r.stopsDone}/{r.stopsTotal} stops</span>
                  <span className="text-xs text-crm-muted">{r.startedAt ? new Date(r.startedAt).toLocaleDateString() : "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </CRMCard>

        <CRMCard padding="none">
          <h2 className="border-b border-crm-border px-4 py-3 text-sm font-semibold text-crm-text">Recent exceptions</h2>
          {(d.exceptions || []).length === 0 ? (
            <p className="p-4 text-sm text-crm-muted">None logged.</p>
          ) : (
            <ul className="flex flex-col">
              {d.exceptions.map((e: any) => (
                <li key={e.id} className="flex items-center gap-2 border-b border-crm-border px-4 py-2.5 last:border-b-0">
                  <AlertTriangle size={13} className="shrink-0 text-crm-warning" />
                  <span className="flex-1 text-xs text-crm-text">{String(e.reasonCode).replace(/_/g, " ")}</span>
                  <span className="text-[11px] text-crm-muted">{ago(e.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CRMCard>
      </div>
    </CRMPageShell>
  );
}
