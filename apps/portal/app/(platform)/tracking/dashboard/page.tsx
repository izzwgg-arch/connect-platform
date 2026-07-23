"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Truck, AlertTriangle, RefreshCw, MapPin, ArrowRight } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../components/crm";
import { deliveryApi, type DashboardResponse, type DashboardTile, type AttentionItem } from "../../../../services/deliveryApi";

const toneClass: Record<DashboardTile["tone"], string> = {
  neutral: "text-crm-text",
  positive: "text-crm-success",
  warn: "text-crm-warning",
  danger: "text-crm-danger",
};

type Severity = "danger" | "warning" | "neutral";

// Derive a severity from the attention item's `kind` string so each row can carry
// a coloured left rail + tag tone (mirrors the mockup's danger/warning/neutral rails).
function severityFor(kind: string): Severity {
  const k = kind.toLowerCase();
  if (/(fail|exception|refused|address)/.test(k)) return "danger";
  if (/(stale|delay|unavailable)/.test(k)) return "warning";
  return "neutral";
}

const railClass: Record<Severity, string> = {
  danger: "bg-crm-danger",
  warning: "bg-crm-warning",
  neutral: "bg-crm-border",
};

const tagClass: Record<Severity, string> = {
  danger: "border-crm-danger/40 bg-crm-danger/10 text-crm-danger",
  warning: "border-crm-warning/40 bg-crm-warning/10 text-crm-warning",
  neutral: "border-crm-border bg-crm-surface text-crm-muted",
};

function AttentionRow({ item }: { item: AttentionItem }) {
  const severity = severityFor(item.kind);
  return (
    <li className="relative flex items-center gap-3 overflow-hidden rounded-crm border border-crm-border bg-crm-surface-2 py-2 pl-4 pr-3">
      {/* severity left rail */}
      <span className={cn("absolute inset-y-0 left-0 w-1", railClass[severity])} aria-hidden />
      <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", tagClass[severity])}>
        {item.kind.replace(/_/g, " ")}
      </span>
      <span className="shrink-0 font-mono text-xs text-crm-text">{item.ref}</span>
      <span className="min-w-0 truncate text-xs text-crm-muted">{item.detail}</span>
    </li>
  );
}

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

  const driversOnline = data?.counts?.driversOnline ?? 0;
  const driversOffline = data?.counts?.driversOffline ?? 0;

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

          {/* Drivers-on-shift summary. Stands in for the mockup's live map canvas — the
              full map lives on the dedicated /tracking/map page, so this is a compact
              summary + deep link rather than an embedded map. */}
          <CRMCard padding="md">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <MapPin size={15} className="text-crm-accent" />
              <span className="text-crm-text">
                <span className="font-semibold tabular-nums">{driversOnline}</span> on shift
              </span>
              <span className="text-crm-muted">·</span>
              <span className="text-crm-muted tabular-nums">{driversOffline} offline</span>
              <Link href="/tracking/map" className={cn(crm.btnGhost, "ml-auto")}>
                View live map <ArrowRight size={14} />
              </Link>
            </div>
          </CRMCard>

          <CRMCard>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <AlertTriangle size={15} className="text-crm-warning" />
              <h2 className="text-sm font-semibold text-crm-text">Needs attention</h2>
              {data.needsIntervention ? (
                <span className="rounded-full border border-crm-danger/40 bg-crm-danger/10 px-2 py-0.5 text-[11px] font-semibold text-crm-danger">
                  action required
                </span>
              ) : null}
              <Link href="/tracking/exceptions" className={cn(crm.btnSecondary, "ml-auto")}>
                Open exception queue <ArrowRight size={14} />
              </Link>
            </div>

            {/* Display-only filter chrome to match the mockup. These are inert placeholders —
                the dashboard endpoint doesn't accept date/driver params yet, so wiring is
                deferred until the API exposes them. */}
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <span className={cn(crm.filterPill, "cursor-default")} aria-disabled>Today</span>
              <span className={cn(crm.filterPill, "cursor-default")} aria-disabled>All drivers</span>
            </div>

            {data.attention.length === 0 ? (
              <p className="text-sm text-crm-muted">All caught up — no exceptions right now.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.attention.map((a, i) => (
                  <AttentionRow key={`${a.ref}-${i}`} item={a} />
                ))}
              </ul>
            )}
          </CRMCard>
        </>
      ) : null}
    </CRMPageShell>
  );
}
