"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Camera, Clock, RefreshCw, CalendarClock, Check, BellRing, X } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../components/crm";
import { deliveryApi, type ExceptionRow } from "../../../../services/deliveryApi";

type ActionKey = "reschedule" | "resolve" | "notify" | "dismiss";

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export default function TrackingExceptionsPage() {
  const [rows, setRows] = useState<ExceptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setRows(await deliveryApi.exceptionQueue());
    } catch (e: any) {
      setError(e?.message === "delivery_not_enabled" ? "Delivery isn't enabled for this tenant yet." : "Couldn't load exceptions.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  async function act(row: ExceptionRow, action: ActionKey) {
    setBusy(`${row.id}:${action}`);
    try {
      await deliveryApi.exceptionAction(row.id, action);
      await load();
    } catch {
      /* surfaced by the row staying; a toast layer can be added later */
    } finally {
      setBusy(null);
    }
  }

  const reasons = useMemo(() => Array.from(new Set(rows.map((r) => r.reasonCode))), [rows]);
  const shown = reason ? rows.filter((r) => r.reasonCode === reason) : rows;

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        icon={<AlertTriangle size={20} />}
        title="Exception queue"
        subtitle="Orders that need a dispatcher decision — act without leaving the queue."
        actions={
          <div className="flex items-center gap-2">
            {rows.length > 0 && (
              <span className="rounded-full border border-crm-danger/40 bg-crm-danger/10 px-2.5 py-0.5 text-xs font-semibold text-crm-danger">
                {rows.length} open
              </span>
            )}
            <button className={crm.btnSecondary} onClick={load}><RefreshCw size={14} /> Refresh</button>
          </div>
        }
      />

      {reasons.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <button className={reason === "" ? crm.filterPillActive : crm.filterPill} onClick={() => setReason("")}>all reasons</button>
          {reasons.map((rc) => {
            const label = rows.find((r) => r.reasonCode === rc)?.reasonLabel ?? rc;
            return (
              <button key={rc} className={reason === rc ? crm.filterPillActive : crm.filterPill} onClick={() => setReason(rc)}>{label}</button>
            );
          })}
        </div>
      )}

      {error ? (
        <CRMCard><p className="text-sm text-crm-muted">{error}</p></CRMCard>
      ) : loading ? (
        <CRMCard><p className="text-sm text-crm-muted">Loading…</p></CRMCard>
      ) : shown.length === 0 ? (
        <CRMCard>
          <div className="flex flex-col items-center gap-1 py-8 text-center">
            <div className="text-crm-success"><Check size={22} /></div>
            <p className="text-sm font-medium text-crm-text">No open exceptions</p>
            <p className="text-xs text-crm-muted">Everything on route is going smoothly.</p>
          </div>
        </CRMCard>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {shown.map((r) => {
            const danger = r.severity === "high";
            return (
              <li
                key={r.id}
                className={cn(
                  "relative overflow-hidden rounded-crm-lg border bg-crm-surface pl-4 pr-3 py-3 shadow-crm",
                  danger ? "border-crm-danger/40" : "border-crm-warning/40",
                )}
              >
                <span className={cn("absolute left-0 top-0 h-full w-1", danger ? "bg-crm-danger" : "bg-crm-warning")} />
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={cn("text-sm font-semibold", danger ? "text-crm-danger" : "text-crm-warning")}>{r.reasonLabel}</span>
                      {r.needsApproval && (
                        <span className="rounded-full border border-crm-danger/40 bg-crm-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-crm-danger">approval</span>
                      )}
                    </div>
                    <div className="mt-1 text-sm text-crm-text">
                      <span className="font-mono text-xs">{r.sourceId}</span>
                      <span className="text-crm-muted"> · {r.customerName || "—"} · {r.address}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-crm-muted">
                      <span className="inline-flex items-center gap-1"><Clock size={11} /> {timeAgo(r.occurredAt)}</span>
                      {r.driverId && <span>driver {r.driverId.slice(0, 8)}</span>}
                      {r.hasPhoto && <span className="inline-flex items-center gap-1 text-crm-accent"><Camera size={11} /> photo</span>}
                      <span className="rounded-full border border-crm-border px-1.5 py-0.5">{String(r.status).replace(/_/g, " ").toLowerCase()}</span>
                    </div>
                    {r.note && <p className="mt-1.5 text-xs italic text-crm-muted">“{r.note}”</p>}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <button className={crm.btnGhost} disabled={!!busy} onClick={() => act(r, "reschedule")}>
                      <CalendarClock size={13} /> {busy === `${r.id}:reschedule` ? "…" : "Reschedule"}
                    </button>
                    <button className={crm.btnGhost} disabled={!!busy} onClick={() => act(r, "notify")}>
                      <BellRing size={13} /> {busy === `${r.id}:notify` ? "…" : "Notify"}
                    </button>
                    <button className={crm.btnSecondary} disabled={!!busy} onClick={() => act(r, "resolve")}>
                      <Check size={13} /> {busy === `${r.id}:resolve` ? "…" : "Resolve"}
                    </button>
                    <button className={crm.btnGhost} disabled={!!busy} onClick={() => act(r, "dismiss")} title="Dismiss">
                      <X size={13} />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </CRMPageShell>
  );
}
