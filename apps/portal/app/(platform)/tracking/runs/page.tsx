"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ListChecks, Plus, Route, Sparkles, Play } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../components/crm";
import { deliveryApi, type RunRow } from "../../../../services/deliveryApi";

interface UnassignedOrder {
  id: string;
  sourceId: string;
  storeId: string;
  addrLine1: string;
  addrUnit?: string | null;
  customerName?: string | null;
  priority?: string | null;
}

function statusPillClass(status: string): string {
  if (status === "ACTIVE") return "border-crm-success/40 bg-crm-success/10 text-crm-success";
  if (status === "PAUSED") return "border-crm-warning/40 bg-crm-warning/10 text-crm-warning";
  return "border-crm-border bg-crm-surface-2 text-crm-muted";
}

function fmtTime(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function TrackingRunsPage() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [pool, setPool] = useState<UnassignedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [runRows, unassigned] = await Promise.all([
        deliveryApi.runs(),
        deliveryApi.unassignedOrders() as Promise<UnassignedOrder[]>,
      ]);
      setRuns(runRows);
      setPool(unassigned);
      setError(null);
      setNotEnabled(false);
    } catch (e: any) {
      if (e?.message === "delivery_not_enabled") {
        setNotEnabled(true);
      } else {
        setError("Couldn't load the run board.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const act = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy(key);
      try {
        await fn();
        await load();
      } catch {
        // Surface transient failures via the shared error banner without tearing down the board.
        setError("That action didn't go through. Try again.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const active = useMemo(() => runs.filter((r) => r.status === "ACTIVE" || r.status === "PAUSED"), [runs]);
  const drafts = useMemo(() => runs.filter((r) => r.status === "DRAFT"), [runs]);

  const newRunStoreId = pool[0]?.storeId ?? null;

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        icon={<Route size={20} />}
        title="Runs"
        subtitle="Build runs from the unassigned pool, then optimize and start them."
      />

      {error ? <CRMCard className={cn(crm.bannerDanger, "px-4 py-3 text-sm")}>{error}</CRMCard> : null}

      {notEnabled ? (
        <CRMCard>
          <p className="text-sm text-crm-text">Delivery isn't enabled for this tenant yet.</p>
        </CRMCard>
      ) : loading ? (
        <CRMCard>
          <p className="text-sm text-crm-muted">Loading…</p>
        </CRMCard>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          {/* LEFT — unassigned pool */}
          <CRMCard padding="none" className="flex flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-crm-border px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-crm-text">Unassigned</span>
                <span className="inline-flex min-w-[1.5rem] items-center justify-center rounded-full border border-crm-border bg-crm-surface-2 px-2 py-0.5 text-xs font-medium tabular-nums text-crm-muted">
                  {pool.length}
                </span>
              </div>
              <button
                className={cn(crm.btnSecondary, "h-8 px-2.5 text-xs")}
                disabled={!newRunStoreId || busy === "new-run"}
                onClick={() => newRunStoreId && act("new-run", () => deliveryApi.createRun(newRunStoreId))}
              >
                <Plus size={14} />
                {busy === "new-run" ? "Creating…" : "New run"}
              </button>
            </div>

            {pool.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-crm-muted">No unassigned orders.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-crm-border">
                {pool.map((o) => {
                  const runOptions = runs.filter((r) => r.storeId === o.storeId);
                  const rowBusy = busy === `stop-${o.id}`;
                  return (
                    <li key={o.id} className="flex flex-col gap-2 px-4 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-mono text-xs text-crm-text">{o.sourceId}</span>
                        {o.priority && o.priority !== "NORMAL" ? (
                          <span className="inline-flex items-center rounded-full border border-crm-warning/40 bg-crm-warning/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-crm-warning">
                            {o.priority.toLowerCase()}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs leading-snug text-crm-muted">
                        {o.customerName ? <span className="text-crm-text">{o.customerName}</span> : null}
                        {o.customerName ? " · " : ""}
                        {o.addrLine1}
                        {o.addrUnit ? ` ${o.addrUnit}` : ""}
                      </div>
                      <select
                        className={cn(crm.select, "h-8 py-0 text-xs")}
                        value=""
                        disabled={rowBusy || runOptions.length === 0}
                        onChange={(e) => {
                          const runId = e.target.value;
                          if (runId) act(`stop-${o.id}`, () => deliveryApi.addStop(runId, o.id));
                        }}
                      >
                        <option value="">
                          {runOptions.length === 0 ? "No run for this store" : rowBusy ? "Adding…" : "Add to run…"}
                        </option>
                        {runOptions.map((r) => (
                          <option key={r.id} value={r.id}>
                            {(r.driverName || "unassigned") + " · " + r.status.toLowerCase() + " · " + r.stopsTotal + " stops"}
                          </option>
                        ))}
                      </select>
                    </li>
                  );
                })}
              </ul>
            )}
          </CRMCard>

          {/* RIGHT — run columns */}
          <div className="flex flex-col gap-5">
            {runs.length === 0 ? (
              <CRMCard>
                <p className="text-sm text-crm-muted">No runs yet — create one from the pool.</p>
              </CRMCard>
            ) : (
              <>
                <RunGroup title="Active" icon={<ListChecks size={14} />} runs={active} busy={busy} onAct={act} />
                <RunGroup title="Draft" icon={<Route size={14} />} runs={drafts} busy={busy} onAct={act} />
              </>
            )}
          </div>
        </div>
      )}
    </CRMPageShell>
  );
}

function RunGroup({
  title,
  icon,
  runs,
  busy,
  onAct,
}: {
  title: string;
  icon: ReactNode;
  runs: RunRow[];
  busy: string | null;
  onAct: (key: string, fn: () => Promise<unknown>) => void;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="text-crm-muted">{icon}</span>
        <h2 className={crm.label}>{title}</h2>
        <span className="text-xs tabular-nums text-crm-muted">{runs.length}</span>
      </div>
      {runs.length === 0 ? (
        <p className="rounded-crm border border-dashed border-crm-border px-3 py-4 text-xs text-crm-muted">
          {title === "Active" ? "No active runs." : "No draft runs."}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {runs.map((r) => (
            <RunCard key={r.id} run={r} busy={busy} onAct={onAct} />
          ))}
        </div>
      )}
    </section>
  );
}

function RunCard({
  run,
  busy,
  onAct,
}: {
  run: RunRow;
  busy: string | null;
  onAct: (key: string, fn: () => Promise<unknown>) => void;
}) {
  const total = run.stopsTotal || 0;
  const done = run.stopsDone || 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const startKey = `start-${run.id}`;
  const optKey = `opt-${run.id}`;
  const winStart = fmtTime(run.windowStart);
  const winEnd = fmtTime(run.windowEnd);

  return (
    <CRMCard padding="none" className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold text-crm-text">{run.driverName || "unassigned"}</span>
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            statusPillClass(run.status),
          )}
        >
          {run.status.toLowerCase()}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-crm-surface-2">
          <div className="h-full rounded-full bg-crm-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex items-center justify-between text-xs text-crm-muted">
          <span className="tabular-nums">
            {done}/{total} stops
          </span>
          {winStart ? (
            <span className="tabular-nums">
              {winStart}
              {winEnd ? `–${winEnd}` : ""}
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        {run.status === "DRAFT" ? (
          <button
            className={cn(crm.btnPrimary, "h-8 px-3 text-xs")}
            disabled={total === 0 || busy === startKey}
            onClick={() => onAct(startKey, () => deliveryApi.startRun(run.id))}
          >
            <Play size={13} />
            {busy === startKey ? "Starting…" : "Start run"}
          </button>
        ) : null}
        <button
          className={cn(crm.btnSecondary, "h-8 px-3 text-xs")}
          disabled={busy === optKey}
          title="Compute the best stop order for this run"
          onClick={() => onAct(optKey, () => deliveryApi.optimizeRun(run.id))}
        >
          <Sparkles size={13} />
          {busy === optKey ? "Optimizing…" : "Optimize route"}
        </button>
        <Link href={`/tracking/runs/${run.id}`} className={cn(crm.btnGhost, "h-8 px-3 text-xs")}>
          <Route size={13} /> Open
        </Link>
      </div>
    </CRMCard>
  );
}
