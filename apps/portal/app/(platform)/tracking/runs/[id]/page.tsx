"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Route, ArrowUp, ArrowDown, Wand2, Play, Save, ArrowLeft } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../../components/crm";
import { deliveryApi } from "../../../../../services/deliveryApi";

const RUN_TONE: Record<string, string> = {
  ACTIVE: "border-crm-success/40 bg-crm-success/10 text-crm-success",
  PAUSED: "border-crm-warning/40 bg-crm-warning/10 text-crm-warning",
  DRAFT: "border-crm-border bg-crm-surface-2 text-crm-muted",
  COMPLETED: "border-crm-accent/40 bg-crm-accent/10 text-crm-accent",
  CLOSED: "border-crm-border bg-crm-surface-2 text-crm-muted",
};
const STOP_TONE: Record<string, string> = {
  DONE: "text-crm-success",
  FAILED: "text-crm-danger",
  SKIPPED: "text-crm-muted",
  ARRIVED: "text-crm-accent",
  PENDING: "text-crm-muted",
};

export default function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id || "");
  const [run, setRun] = useState<any>(null);
  const [stops, setStops] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const r = await deliveryApi.run(id);
      setRun(r);
      setStops(r.stops || []);
      setDirty(false);
    } catch {
      setError("Couldn't load this run.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (id) load(); }, [id]);

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= stops.length) return;
    const next = stops.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setStops(next);
    setDirty(true);
  }
  async function saveOrder() {
    setBusy("save");
    try { await deliveryApi.reorderRun(id, stops.map((s) => s.id)); await load(); } finally { setBusy(null); }
  }
  async function optimize() {
    setBusy("opt");
    try { await deliveryApi.optimizeRun(id); await load(); } finally { setBusy(null); }
  }
  async function start() {
    setBusy("start");
    try { await deliveryApi.startRun(id); await load(); } finally { setBusy(null); }
  }

  if (loading) return <CRMPageShell><CRMCard><p className="text-sm text-crm-muted">Loading…</p></CRMCard></CRMPageShell>;
  if (error || !run) return <CRMPageShell><CRMCard><p className="text-sm text-crm-muted">{error || "Not found."}</p></CRMCard></CRMPageShell>;

  const pct = run.stopsTotal ? Math.round((run.stopsDone / run.stopsTotal) * 100) : 0;

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        icon={<Route size={20} />}
        title={`Run ${id.slice(-6)}`}
        subtitle={run.driverName ? `Driver ${run.driverName}` : "Unassigned run"}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/tracking/runs" className={crm.btnGhost}><ArrowLeft size={14} /> Runs</Link>
            <span className={cn("rounded-full border px-2.5 py-1 text-xs font-semibold", RUN_TONE[run.status] || RUN_TONE.DRAFT)}>{String(run.status).toLowerCase()}</span>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Route editor */}
        <CRMCard className="lg:col-span-2" padding="none">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-crm-border px-4 py-3">
            <h2 className="text-sm font-semibold text-crm-text">Route · {run.stopsTotal} stops</h2>
            <div className="flex items-center gap-1.5">
              <button className={crm.btnGhost} disabled={!!busy} onClick={optimize}><Wand2 size={13} /> {busy === "opt" ? "…" : "Optimize (best route)"}</button>
              <button className={crm.btnSecondary} disabled={!dirty || !!busy} onClick={saveOrder}><Save size={13} /> {busy === "save" ? "Saving…" : "Save order"}</button>
            </div>
          </div>
          {stops.length === 0 ? (
            <p className="p-4 text-sm text-crm-muted">No stops on this run yet — add orders from the run board.</p>
          ) : (
            <ol className="flex flex-col">
              {stops.map((s, i) => (
                <li key={s.id} className="flex items-center gap-3 border-b border-crm-border px-4 py-2.5 last:border-b-0">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-crm-border text-[11px] font-bold tabular-nums text-crm-muted">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-crm-text">
                      <span className="font-mono text-xs">{s.order?.sourceId}</span>
                      <span className="text-crm-muted"> · {s.order?.customerName || "—"} · {s.order?.addrLine1}{s.order?.addrUnit ? ` ${s.order.addrUnit}` : ""}</span>
                    </div>
                    <div className={cn("text-[11px]", STOP_TONE[s.status] || "text-crm-muted")}>{String(s.status).toLowerCase()}{s.order?.lat == null ? " · no geocode" : ""}</div>
                  </div>
                  <div className="flex shrink-0 flex-col">
                    <button className="text-crm-muted hover:text-crm-text disabled:opacity-30" disabled={i === 0 || !!busy} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                    <button className="text-crm-muted hover:text-crm-text disabled:opacity-30" disabled={i === stops.length - 1 || !!busy} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CRMCard>

        {/* Run summary */}
        <div className="flex flex-col gap-3">
          <CRMCard>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-crm-muted">Progress</h2>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-2xl font-semibold tabular-nums text-crm-text">{run.stopsDone}/{run.stopsTotal}</span>
              <span className="text-xs text-crm-muted">{pct}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-crm-surface-2">
              <div className="h-full rounded-full bg-crm-accent" style={{ width: `${pct}%` }} />
            </div>
            {run.status === "DRAFT" && (
              <button className={cn(crm.btnPrimary, "mt-3 w-full")} disabled={run.stopsTotal === 0 || busy === "start"} onClick={start}>
                <Play size={14} /> {busy === "start" ? "Starting…" : "Start run"}
              </button>
            )}
          </CRMCard>

          <CRMCard>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-crm-muted">Details</h2>
            <dl className="flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between"><dt className="text-crm-muted">Driver</dt><dd className="text-crm-text">{run.driverName || "unassigned"}</dd></div>
              <div className="flex justify-between"><dt className="text-crm-muted">Store</dt><dd className="font-mono text-xs text-crm-text">{String(run.storeId).slice(-8)}</dd></div>
              <div className="flex justify-between"><dt className="text-crm-muted">Window</dt><dd className="text-crm-text">{run.windowStart ? new Date(run.windowStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}{run.windowEnd ? `–${new Date(run.windowEnd).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</dd></div>
              <div className="flex justify-between"><dt className="text-crm-muted">Started</dt><dd className="text-crm-text">{run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}</dd></div>
            </dl>
          </CRMCard>
        </div>
      </div>
    </CRMPageShell>
  );
}
