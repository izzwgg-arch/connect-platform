"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Users, ListOrdered, Truck, Activity } from "lucide-react";
import { apiGet } from "../../../services/apiClient";
import { DetailCard } from "../../../components/DetailCard";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { GlobalScopeNotice } from "../../../components/GlobalScopeNotice";
import { LiveBadge } from "../../../components/LiveBadge";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { QRPairingModal } from "../../../components/QRPairingModal";
import { RoleGate } from "../../../components/RoleGate";
import { ScopeBadge } from "../../../components/ScopeBadge";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { useTelephony } from "../../../contexts/TelephonyContext";
import {
  loadPbxLiveCombined,
  loadAdminPbxLiveCombined,
  loadPbxLiveDiagnostics,
  formatDurationSec,
  directionLabel,
  directionClass,
  type PbxLiveSummary,
  type AdminPbxLiveSummary,
  type PbxActiveCallsResponse,
  type PbxLiveCombined,
  type AdminPbxLiveCombined,
  type PbxLiveDiagnostics
} from "../../../services/pbxLive";
import { loadDashboardData } from "../../../services/platformData";

/** Display label for call state (presentation only) */
function callStateLabel(state: string): string {
  const s = (state || "").toLowerCase();
  if (s === "ringing" || s === "dialing") return "Ringing";
  if (s === "up") return "Talking";
  if (s === "held") return "On hold";
  if (s === "hungup") return "Ended";
  return state || "—";
}

type DashboardCallTraffic = {
  totals: { made: number; incoming: number; outgoing: number; internal: number };
  points: Array<{ label: string; incoming: number; outgoing: number; internal: number }>;
};

type ConnectKpis = {
  incomingToday: number;
  outgoingToday: number;
  internalToday: number;
  missedToday: number;
  scope: "global" | "tenant";
  tenantId?: string;
  asOf: string;
  /** connect = ConnectCdr DB (default); pbx = VitalPBX CDR API only if enabled server-side */
  source?: "connect" | "pbx";
  pbxFallback?: boolean;
  tenantsQueried?: number;
};

function PbxErrorWithDiagnostics({ errorMessage, isGlobal }: { errorMessage: string; isGlobal: boolean }) {
  const [diagnostics, setDiagnostics] = useState<PbxLiveDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const runDiagnostics = async () => {
    if (isGlobal) return;
    setLoading(true);
    setDiagnostics(null);
    try {
      const d = await loadPbxLiveDiagnostics();
      setDiagnostics(d);
    } catch {
      setDiagnostics({ step: "reach", ok: false, message: "Failed to load diagnostics.", code: "REQUEST_FAILED" });
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <ErrorState message={errorMessage} />
      {!isGlobal ? (
        <div className="mt-3">
          <button type="button" onClick={runDiagnostics} disabled={loading} className="btn btn-secondary btn-sm">
            {loading ? "Running…" : "Run diagnostics"}
          </button>
          {diagnostics ? (
            <div className="mt-2 p-2 rounded bg-black/10 text-sm font-mono">
              <div><strong>Step:</strong> {diagnostics.step} {diagnostics.ok ? "✓" : "✗"}</div>
              <div><strong>Message:</strong> {diagnostics.message}</div>
              {diagnostics.code ? <div><strong>Code:</strong> {diagnostics.code}</div> : null}
              {diagnostics.baseUrlHost != null ? <div><strong>PBX host:</strong> {diagnostics.baseUrlHost}</div> : null}
              {diagnostics.hasLink != null ? <div><strong>Has link:</strong> {String(diagnostics.hasLink)}</div> : null}
              {diagnostics.isEnabled != null ? <div><strong>Instance enabled:</strong> {String(diagnostics.isEnabled)}</div> : null}
              {diagnostics.step === "ok" && diagnostics.incomingToday != null ? (
                <div><strong>Today KPIs:</strong> In {diagnostics.incomingToday} / Out {diagnostics.outgoingToday} / Int {diagnostics.internalToday} / Missed {diagnostics.missedToday}</div>
              ) : null}
              {diagnostics.cdrDebug ? (
                <div><strong>CDR request:</strong> date={diagnostics.cdrDebug.todayStr ?? "?"} ({diagnostics.cdrDebug.requestStartIso} → {diagnostics.cdrDebug.requestEndIso}); PBX returned {diagnostics.cdrDebug.rawRowCountFromApi} row(s)</div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export default function DashboardPage() {
  const { adminScope } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const telephony = useTelephony();
  const tenantId = typeof window !== "undefined" ? localStorage.getItem("cc-tenant-id") : null;
  const liveCalls = telephony.callsByTenant(isGlobal ? null : tenantId);

  // Staggered ticks — scope-aware cadence (live combined = DB KPIs + ARI only; no VitalPBX REST CDR).
  // combinedTick  120 s (GLOBAL) / 60 s (TENANT) : live summary + active calls (ARI)
  // kpiTick       30 s baseline : KPI cards (also bumped instantly when a call ends)
  // trafficTick   300 s (GLOBAL) / 120 s (TENANT) : call traffic chart (ConnectCdr / callRecord)
  const [combinedTick,  setCombinedTick]  = useState(0);
  const [kpiTick,       setKpiTick]       = useState(0);
  const [trafficTick,   setTrafficTick]   = useState(0);

  useEffect(() => {
    const combinedMs  = isGlobal ? 120_000 : 60_000;
    const trafficMs   = isGlobal ? 300_000 : 120_000;
    const kpiMs       = 30_000; // 30 s baseline for KPI cards
    const t1 = window.setInterval(() => setCombinedTick((v) => v + 1),  combinedMs);
    const t2 = window.setInterval(() => setTrafficTick((v)  => v + 1),  trafficMs);
    const t3 = window.setInterval(() => setKpiTick((v)       => v + 1), kpiMs);
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); };
  }, [isGlobal]);

  // When a call ends (goes to hungup state), refresh KPI cards after a short delay.
  // We track activeCalls.length (non-hungup) so we detect the end as soon as the
  // state changes — giving the CDR ingest pipeline time to write to DB before we query.
  const prevActiveCount = useRef<number | null>(null);
  useEffect(() => {
    const count = liveCalls.length;
    if (prevActiveCount.current !== null && count < prevActiveCount.current) {
      // A call just ended — wait 4 s for CDR ingest to commit, then refresh KPIs
      const timer = window.setTimeout(() => setKpiTick((v) => v + 1), 4_000);
      prevActiveCount.current = count;
      return () => clearTimeout(timer);
    }
    prevActiveCount.current = count;
  }, [liveCalls.length]);

  // Platform billing/activity — fetched once per scope change, no tick.
  const state = useAsyncResource(() => loadDashboardData(adminScope), [adminScope]);

  // ONE combined PBX call — used for ACTIVE CALLS only. KPIs come from Connect CDR below.
  const pbxCombinedState = useAsyncResource<PbxLiveCombined | AdminPbxLiveCombined>(
    () => isGlobal ? loadAdminPbxLiveCombined() : loadPbxLiveCombined(),
    [adminScope, combinedTick]
  );

  // KPI totals: default ConnectCdr (DB) — no VitalPBX REST fan-out. Optional PBX aggregate is API-only
  // when CALL_KPIS_USE_VITALPBX_API=true and ?source=pbx (admin/debug; heavy on the PBX).
  const kpiParam =
    !isGlobal && tenantId
      ? `?tenantId=${encodeURIComponent(tenantId)}`
      : "";
  const connectKpisState = useAsyncResource<ConnectKpis>(
    () => apiGet<ConnectKpis>(`/dashboard/call-kpis${kpiParam}`),
    [adminScope, tenantId, kpiTick]
  );

  // Call traffic chart — slower cadence, already server-cached (ConnectCdr / callRecord only; no PBX REST).
  const trafficState = useAsyncResource<DashboardCallTraffic>(
    () => apiGet<DashboardCallTraffic>(`/dashboard/call-traffic?scope=${adminScope}&windowMinutes=1440`),
    [adminScope, trafficTick]
  );

  const data        = state.status === "success" ? state.data : null;
  const activity    = data?.activity || [];
  const scopeLabel  = data?.scopeLabel || (adminScope as "GLOBAL" | "TENANT");

  const combined   = pbxCombinedState.status === "success" ? pbxCombinedState.data : null;
  const pbxLive    = combined?.summary ?? null;
  const activeCalls = combined?.activeCalls ?? null;
  const traffic    = trafficState.status === "success" ? trafficState.data : null;

  const isAdminSummary = (s: PbxLiveSummary | AdminPbxLiveSummary | null): s is AdminPbxLiveSummary =>
    s !== null && "totalCallsToday" in s;

  const callsToday = isAdminSummary(pbxLive) ? pbxLive.totalCallsToday : pbxLive?.callsToday ?? null;
  const answeredToday = isAdminSummary(pbxLive) ? pbxLive.answeredToday : pbxLive?.answeredToday ?? null;
  const activeCallCount = isAdminSummary(pbxLive) ? pbxLive.totalActiveCalls : pbxLive?.activeCalls ?? null;
  const activeCallsSource = isAdminSummary(pbxLive) ? "global" : pbxLive?.activeCallsSource ?? null;

  const connectKpis = connectKpisState.status === "success" ? connectKpisState.data : null;
  const incomingToday = connectKpis?.incomingToday ?? null;
  const outgoingToday = connectKpis?.outgoingToday ?? null;
  const internalToday = connectKpis?.internalToday ?? null;
  const missedToday   = connectKpis?.missedToday ?? null;
  const kpiSourceNote =
    connectKpis?.pbxFallback
      ? "Today totals: Connect database (VitalPBX CDR aggregate failed — check PBX API / instance)."
      : connectKpis?.source === "pbx"
        ? `Today totals: VitalPBX CDR${typeof connectKpis.tenantsQueried === "number" && connectKpis.tenantsQueried > 0 ? ` (${connectKpis.tenantsQueried} tenant${connectKpis.tenantsQueried === 1 ? "" : "s"})` : ""} — matches PBX traffic chart.`
        : null;

  const peak = Math.max(1, ...(traffic?.points || []).map((p) => Math.max(p.incoming, p.outgoing, p.internal)));

  // Tick every second so live call duration displays update (UI only, no API).
  const [, setDurationTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setDurationTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // If WebSocket is live, use its authoritative active call count; fall back to ARI/CDR.
  const wsActiveCalls = telephony.isLive ? liveCalls.length : null;
  const displayActiveCount = wsActiveCalls !== null ? wsActiveCalls : activeCallCount;
  const activeCountMeta = telephony.isLive
    ? "Live via AMI"
    : activeCallsSource === "ari"
    ? "Live via ARI"
    : "ARI not configured";

  const lastSyncAt = pbxLive?.lastUpdatedAt ?? activeCalls?.lastUpdatedAt ?? null;

  return (
    <PermissionGate permission="can_view_dashboard" fallback={<div className="state-box">You do not have dashboard access.</div>}>
      <div className="stack compact-stack dashboard-2026">
        <PageHeader
          title="Overview"
          subtitle={`${scopeLabel} scope. ${telephony.isLive ? "Live calls and KPIs update automatically." : `Data refreshes every 30 s.`}`}
          badges={<><ScopeBadge scope={scopeLabel} /><LiveBadge status={telephony.status} /></>}
          actions={<QRPairingModal />}
        />

        {isGlobal ? <GlobalScopeNotice /> : null}
        {pbxCombinedState.status === "loading" ? <LoadingSkeleton rows={1} /> : null}
        {pbxCombinedState.status === "error" ? (
          <PbxErrorWithDiagnostics
            errorMessage={pbxCombinedState.error || "PBX live metrics unavailable — check PBX link configuration."}
            isGlobal={isGlobal}
          />
        ) : null}

        {/* SECTION A — KPI CARDS */}
        <section className="dash-section" aria-label="Key metrics">
          <h3 className="dash-section-title">Key metrics</h3>
          {kpiSourceNote ? (
            <p className="text-sm opacity-80 mb-2 max-w-3xl">{kpiSourceNote}</p>
          ) : null}
          <div className="dash-kpi-grid">
            <article className={`dash-kpi-card active-calls`}>
              <div className="dash-kpi-label">Active Calls</div>
              <div className="dash-kpi-value">{displayActiveCount !== null ? displayActiveCount : "--"}</div>
              <div className="dash-kpi-meta">{activeCountMeta}</div>
            </article>
            <article className="dash-kpi-card incoming">
              <div className="dash-kpi-label">Incoming today</div>
              <div className="dash-kpi-value">{incomingToday !== null ? incomingToday : "--"}</div>
              <div className="dash-kpi-meta">Inbound</div>
            </article>
            <article className="dash-kpi-card outgoing">
              <div className="dash-kpi-label">Outgoing today</div>
              <div className="dash-kpi-value">{outgoingToday !== null ? outgoingToday : "--"}</div>
              <div className="dash-kpi-meta">Outbound</div>
            </article>
            <article className="dash-kpi-card internal">
              <div className="dash-kpi-label">Internal today</div>
              <div className="dash-kpi-value">{internalToday !== null ? internalToday : "--"}</div>
              <div className="dash-kpi-meta">Extension-to-extension</div>
            </article>
            <article className="dash-kpi-card missed">
              <div className="dash-kpi-label">Missed today</div>
              <div className="dash-kpi-value">{missedToday !== null ? missedToday : "--"}</div>
              <div className="dash-kpi-meta">Unanswered</div>
            </article>
            {isGlobal && isAdminSummary(pbxLive) ? (
              <article className="dash-kpi-card">
                <div className="dash-kpi-label">Active tenants</div>
                <div className="dash-kpi-value">{pbxLive.activeTenantsCount}</div>
                <div className="dash-kpi-meta">With calls today</div>
              </article>
            ) : null}
          </div>
        </section>

        {/* SECTION B — LIVE CALLS PANEL */}
        <section className="dash-section" aria-label="Live calls">
          <h3 className="dash-section-title">Live calls</h3>
          <div className="dash-live-panel">
            {telephony.isLive ? (
              liveCalls.length > 0 ? (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Caller</th>
                        <th>Destination</th>
                        <th>Direction</th>
                        <th>Duration</th>
                        <th>Status</th>
                        {isGlobal ? <th>Tenant</th> : null}
                        {isGlobal ? <th>Queue</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {liveCalls.map((call) => {
                        const dir = call.direction === "inbound" ? "incoming" : call.direction === "outbound" ? "outgoing" : "internal";
                        const elapsedSec = call.answeredAt
                          ? Math.floor((Date.now() - new Date(call.answeredAt).getTime()) / 1000)
                          : Math.floor((Date.now() - new Date(call.startedAt).getTime()) / 1000);
                        return (
                          <tr key={call.id}>
                            <td className="mono">{call.from || "—"}</td>
                            <td className="mono">{call.to || "—"}</td>
                            <td><span className={`chip ${directionClass(dir)}`}>{dir === "incoming" ? "IN" : dir === "outgoing" ? "OUT" : "INTERNAL"}</span></td>
                            <td className="mono">{formatDurationSec(elapsedSec)}</td>
                            <td><span className="chip info">{callStateLabel(call.state)}</span></td>
                            {isGlobal ? <td className="muted">{call.tenantId || "—"}</td> : null}
                            {isGlobal ? <td className="muted">{call.queueId || "—"}</td> : null}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState title="No active calls" message="All channels are idle." />
              )
            ) : pbxCombinedState.status === "loading" ? (
              <LoadingSkeleton rows={1} />
            ) : activeCalls?.calls && activeCalls.calls.length > 0 ? (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Caller</th>
                      <th>Destination</th>
                      <th>Direction</th>
                      <th>Duration</th>
                      <th>Status</th>
                      {isGlobal ? <th>Tenant</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {activeCalls.calls.map((call) => (
                      <tr key={call.channelId}>
                        <td className="mono">{call.caller || "—"}</td>
                        <td className="mono">{call.callee || "—"}</td>
                        <td><span className={`chip ${directionClass(call.direction)}`}>{call.direction === "incoming" ? "IN" : call.direction === "outgoing" ? "OUT" : "INTERNAL"}</span></td>
                        <td className="mono">{formatDurationSec(call.durationSeconds)}</td>
                        <td><span className="chip info">{callStateLabel(call.state)}</span></td>
                        {isGlobal ? <td className="muted">{call.tenantId || "—"}</td> : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : activeCalls?.source === "unavailable" ? (
              <EmptyState title="Active calls not available" message="Real-time active calls require the telephony service or Asterisk ARI." />
            ) : (
              <EmptyState title="No active calls" message="All channels are idle." />
            )}
          </div>
        </section>

        {/* SECTION C — CALL VOLUME GRAPH + SECTION D — SYSTEM SUMMARY: 2-col */}
        <section className="dashboard-main-grid">
          <DetailCard title="Call volume" actions={null}>
            {trafficState.status === "error" ? (
              <ErrorState message="Call traffic data unavailable." />
            ) : !traffic || traffic.points.length === 0 ? (
              <EmptyState title="No call traffic in this window" message="Completed calls appear here from Connect (AMI-ingested CDR), or legacy call records if present." />
            ) : (
              <>
                <div className="dash-chart-wrap">
                  <CallVolumeLineChart points={traffic.points} peak={peak} />
                </div>
                <div className="dash-chart-legend">
                  <span><span className="dot" style={{ background: "var(--dash-incoming)"}} /> Incoming: {traffic.totals?.incoming ?? "--"}</span>
                  <span><span className="dot" style={{ background: "var(--dash-outgoing)"}} /> Outgoing: {traffic.totals?.outgoing ?? "--"}</span>
                  <span><span className="dot" style={{ background: "var(--dash-internal)"}} /> Internal: {traffic.totals?.internal ?? "--"}</span>
                </div>
              </>
            )}
          </DetailCard>

          <div className="dashboard-side-stack">
            <h3 className="dash-section-title">System summary</h3>
            <p className="text-sm opacity-70 mb-2 max-w-xl">
              Extension, queue, trunk, and ring-group counts are not loaded here so the dashboard does not call the PBX REST API. Use the PBX section in the nav for those lists.
            </p>
            <div className="dash-summary-grid">
              {[
                { label: "Extensions", value: null, icon: Users, color: "var(--console-accent)" },
                { label: "Ring groups", value: null, icon: ListOrdered, color: "var(--dash-internal)" },
                { label: "Queues", value: null, icon: ListOrdered, color: "var(--console-warning)" },
                { label: "Trunks", value: null, icon: Truck, color: "var(--dash-incoming)" }
              ].map(({ label, value, icon: Icon, color }) => (
                <article key={label} className="dash-summary-card">
                  <div className="dash-summary-icon" style={{ background: color }}>
                    <Icon size={20} />
                  </div>
                  <div>
                    <div className="dash-summary-value">{value === null ? "--" : value}</div>
                    <div className="dash-summary-label">{label}</div>
                  </div>
                </article>
              ))}
            </div>

            {/* SECTION E — QUICK HEALTH */}
            <h3 className="dash-section-title" style={{ marginTop: 16 }}>Quick health</h3>
            <div className="dash-health-panel">
              <div className="dash-health-row">
                <Activity size={16} />
                <span>PBX: {telephony.status === "connected" ? "✅ Connected" : "❌ Disconnected"}</span>
              </div>
              <div className="dash-health-row">
                <span className="muted">Last sync:</span>
                <span>{lastSyncAt ? new Date(lastSyncAt).toLocaleString() : "—"}</span>
              </div>
              <div className="dash-health-row">
                <span className="muted">API:</span>
                <span>{pbxCombinedState.status === "success" ? "✅ OK" : pbxCombinedState.status === "error" ? "❌ Error" : "…"}</span>
              </div>
              <div className="dash-health-row">
                <span className="muted">Event stream:</span>
                <span>{telephony.status === "connected" ? "✅ AMI/ARI" : "❌ Offline"}</span>
              </div>
            </div>
          </div>
        </section>

        {isGlobal && isAdminSummary(pbxLive) && pbxLive.topTenants.length > 0 ? (
          <DetailCard title="Top tenants by call volume today">
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Tenant ID</th>
                    <th>Calls today</th>
                    <th>Incoming</th>
                    <th>Outgoing</th>
                    <th>Active now</th>
                  </tr>
                </thead>
                <tbody>
                  {pbxLive.topTenants.map((t) => (
                    <tr key={t.tenantId}>
                      <td className="mono">{t.tenantId}</td>
                      <td>{t.callsToday}</td>
                      <td>{t.incomingToday}</td>
                      <td>{t.outgoingToday}</td>
                      <td>{t.activeCalls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </DetailCard>
        ) : null}

        <DetailCard title="Recent activity">
          {activity.length === 0 ? (
            <EmptyState title="No activity yet" message="Platform events from billing, messaging, and PBX appear here." />
          ) : (
            <ul className="list">
              {activity.map((item, idx) => (
                <li key={`${item.type}-${idx}`}>
                  <strong>{item.type}</strong>: {item.label}
                </li>
              ))}
            </ul>
          )}
        </DetailCard>

        <RoleGate allow={["TENANT_ADMIN", "SUPER_ADMIN"]}>
          <section className="grid two">
            <DetailCard title="Quick actions">
              <div className="row-actions">
                <Link className="btn ghost" href="/pbx/extensions">Extensions</Link>
                <Link className="btn ghost" href="/apps/sms-campaigns">SMS Campaigns</Link>
                <Link className="btn ghost" href="/contacts">Contacts</Link>
                <Link className="btn ghost" href="/pbx/ivr">IVR Builder</Link>
              </div>
            </DetailCard>
            <DetailCard title="PBX navigation">
              <div className="row-actions">
                <Link className="btn ghost" href="/pbx">PBX Overview</Link>
                <Link className="btn ghost" href="/pbx/extensions">Extensions</Link>
                <Link className="btn ghost" href="/pbx/call-reports">Call Reports</Link>
                <Link className="btn ghost" href="/reports">Reports</Link>
              </div>
            </DetailCard>
          </section>
        </RoleGate>
      </div>
    </PermissionGate>
  );
}

function CallVolumeLineChart({ points, peak }: { points: Array<{ label: string; incoming: number; outgoing: number; internal: number }>; peak: number }) {
  const w = 600;
  const h = 160;
  const pad = { top: 8, right: 8, bottom: 24, left: 8 };
  const xScale = (i: number) => pad.left + (i / Math.max(1, points.length - 1)) * (w - pad.left - pad.right);
  const yScale = (v: number) => h - pad.bottom - (v / peak) * (h - pad.top - pad.bottom);
  const toPath = (getVal: (p: typeof points[0]) => number) =>
    points.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(getVal(p))}`).join(" ");
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="dash-line-chart">
      <path d={toPath((p) => p.incoming)} fill="none" stroke="var(--dash-incoming)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d={toPath((p) => p.outgoing)} fill="none" stroke="var(--dash-outgoing)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d={toPath((p) => p.internal)} fill="none" stroke="var(--dash-internal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
