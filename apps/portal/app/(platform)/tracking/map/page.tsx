"use client";

import { useEffect, useMemo, useState } from "react";
import { MapPin, Map as MapIcon, RefreshCw } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../components/crm";
import { deliveryApi, type MapMarker } from "../../../../services/deliveryApi";

// Movement → pill tone (border + bg + text, all design tokens).
const MOVE_TONE: Record<string, string> = {
  moving: "border-crm-success/40 bg-crm-success/10 text-crm-success",
  stopped: "border-crm-border bg-crm-surface-2 text-crm-muted",
  stale: "border-crm-warning/40 bg-crm-warning/10 text-crm-warning",
  offline: "border-crm-danger/40 bg-crm-danger/10 text-crm-danger",
  unknown: "border-crm-border bg-crm-surface-2 text-crm-muted",
};

// Movement → plotted dot fill (design tokens only).
const DOT_TONE: Record<string, string> = {
  moving: "bg-crm-success",
  stopped: "bg-crm-muted",
  stale: "bg-crm-warning",
  offline: "bg-crm-danger",
  unknown: "bg-crm-muted",
};

// Faint schematic grid drawn from the border token — never a geographic map.
const GRID_BG =
  "repeating-linear-gradient(to right, var(--crm-border) 0 1px, transparent 1px 44px)," +
  "repeating-linear-gradient(to bottom, var(--crm-border) 0 1px, transparent 1px 44px)";

function ageLabel(sec: number | null): string {
  if (sec == null) return "no update yet";
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `updated ${s}s ago`;
  if (s < 3600) return `updated ${Math.round(s / 60)}m ago`;
  return `updated ${Math.round(s / 3600)}h ago`;
}

export default function TrackingMapPage() {
  const [rows, setRows] = useState<MapMarker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setRows(await deliveryApi.map());
    } catch (e: any) {
      setError(
        e?.message === "delivery_not_enabled"
          ? "Delivery isn't enabled for this tenant yet."
          : "Couldn't load live map data.",
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  // Only markers with a live fix are plotted; the rest are "location pending".
  const plotted = useMemo(() => rows.filter((r) => r.position != null), [rows]);
  const onShift = plotted.length;

  // Normalize lat/lng into 6%..94% of the canvas. Guard divide-by-zero when
  // markers share a coordinate (or there's only one live fix).
  const bounds = useMemo(() => {
    if (plotted.length === 0) return null;
    const lats = plotted.map((r) => r.position!.lat);
    const lngs = plotted.map((r) => r.position!.lng);
    return {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLng: Math.min(...lngs),
      maxLng: Math.max(...lngs),
    };
  }, [plotted]);

  function place(lat: number, lng: number): { left: string; top: string } {
    if (!bounds) return { left: "50%", top: "50%" };
    const spanLat = bounds.maxLat - bounds.minLat;
    const spanLng = bounds.maxLng - bounds.minLng;
    const nx = spanLng === 0 ? 0.5 : (lng - bounds.minLng) / spanLng;
    const ny = spanLat === 0 ? 0.5 : (lat - bounds.minLat) / spanLat;
    // Higher latitude sits toward the top, so invert the vertical axis.
    return { left: `${6 + nx * 88}%`, top: `${6 + (1 - ny) * 88}%` };
  }

  const showStates = error || loading || rows.length === 0;

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        icon={<MapPin size={20} />}
        title="Live map"
        subtitle="Active runs and driver positions on a schematic canvas. Stale or offline drivers show no live pin."
        actions={
          <div className="flex items-center gap-2">
            {rows.length > 0 && (
              <span className="rounded-full border border-crm-border bg-crm-surface-2 px-2.5 py-0.5 text-xs font-medium text-crm-muted">
                {onShift} on shift
              </span>
            )}
            <button className={crm.btnSecondary} onClick={load}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
        }
      />

      {showStates ? (
        <CRMCard padding="none">
          {error ? (
            <p className="p-4 text-sm text-crm-muted">{error}</p>
          ) : loading ? (
            <p className="p-4 text-sm text-crm-muted">Loading…</p>
          ) : (
            <p className="p-4 text-sm text-crm-muted">No active runs right now.</p>
          )}
        </CRMCard>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          {/* Schematic canvas — self-contained, not a geographic map. */}
          <CRMCard padding="none" className="overflow-hidden">
            <div
              className="relative min-h-[420px] overflow-hidden rounded-crm-lg border border-crm-border bg-crm-surface-2"
              style={{ backgroundImage: GRID_BG, backgroundPosition: "center" }}
            >
              <span className="absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-crm-border bg-crm-surface/80 px-2.5 py-0.5 text-[11px] font-medium text-crm-muted backdrop-blur-sm">
                <MapIcon size={12} /> Schematic view — not a geographic map
              </span>

              {plotted.map((r) => {
                const p = place(r.position!.lat, r.position!.lng);
                const driver = r.driverId ? String(r.driverId).slice(-6) : "unassigned";
                const title = `${driver} · ${r.movement} · ${ageLabel(r.lastUpdateSec)}`;
                return (
                  <div
                    key={r.runId}
                    className="absolute z-[5] -translate-x-1/2 -translate-y-1/2"
                    style={{ left: p.left, top: p.top }}
                    title={title}
                  >
                    <span
                      className={cn(
                        "block h-3 w-3 rounded-full ring-2 ring-crm-surface/70",
                        DOT_TONE[r.movement] || DOT_TONE.unknown,
                        r.movement === "moving" && "animate-pulse",
                      )}
                    />
                  </div>
                );
              })}

              {plotted.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
                  <p className="text-sm text-crm-muted">
                    No live positions to plot. Active runs without a fix are listed as location pending.
                  </p>
                </div>
              )}
            </div>
          </CRMCard>

          {/* Drivers panel — every run, plotted or pending. */}
          <CRMCard padding="md">
            <div className="mb-3 flex items-center justify-between">
              <span className={crm.label}>Drivers</span>
              <span className="rounded-full border border-crm-border bg-crm-surface-2 px-2 py-0.5 text-[11px] font-medium text-crm-muted">
                {onShift} on shift
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {rows.map((r) => {
                const driver = r.driverId ? String(r.driverId).slice(-6) : "unassigned";
                const live = r.position != null;
                return (
                  <div
                    key={r.runId}
                    className={cn(
                      "rounded-crm border bg-crm-surface-2/40 px-3 py-2.5",
                      live ? "border-crm-border/70" : "border-crm-border/50 border-dashed",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-crm-text">{driver}</span>
                      <span
                        className={cn(
                          "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize",
                          MOVE_TONE[r.movement] || MOVE_TONE.unknown,
                        )}
                      >
                        {r.movement}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-crm-muted">
                      <span className="font-mono">run {String(r.runId).slice(-6)}</span>
                      <span aria-hidden>·</span>
                      {live ? (
                        <span className="tabular-nums">{ageLabel(r.lastUpdateSec)}</span>
                      ) : (
                        <span className="text-crm-warning">location pending — no live fix</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CRMCard>
        </div>
      )}
    </CRMPageShell>
  );
}
