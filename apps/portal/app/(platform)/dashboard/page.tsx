"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, ArrowLeftRight, Phone, TrendingUp, ShieldCheck, AlertTriangle, BarChart3,
  Workflow, Users, Voicemail, Mic, CreditCard, Activity, Clock, GitMerge, ListOrdered,
  CheckCircle2, XCircle, PhoneCall, Radio, Wifi, WifiOff,
} from "lucide-react";
import { LiveCallBadge } from "../../../components/LiveCallBadge";
import { apiGet } from "../../../services/apiClient";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { useTelephony } from "../../../contexts/TelephonyContext";
import {
  loadPbxLiveCombined,
  loadAdminPbxLiveCombined,
  formatDurationSec,
  directionLabel,
  directionClass,
  type PbxLiveSummary,
  type AdminPbxLiveSummary,
  type PbxLiveCombined,
  type AdminPbxLiveCombined,
} from "../../../services/pbxLive";

// ── Helpers ─────────────────────────────────────────────────────────────────

function callStateLabel(state: string): string {
  const s = (state || "").toLowerCase();
  if (s === "ringing" || s === "dialing") return "Ringing";
  if (s === "up") return "Talking";
  if (s === "held") return "On hold";
  if (s === "hungup") return "Ended";
  return state || "—";
}

function DirectionIcon({ direction, size = 14 }: { direction: string; size?: number }) {
  if (direction === "incoming") return <ArrowDown className="call-dir-icon incoming" size={size} />;
  if (direction === "outgoing") return <ArrowUp className="call-dir-icon outgoing" size={size} />;
  return <ArrowLeftRight className="call-dir-icon internal" size={size} />;
}

// ── Types ────────────────────────────────────────────────────────────────────

type DashboardCallTraffic = {
  range: "today" | "7d";
  timezone: string;
  totals: { made: number; total: number; incoming: number; outgoing: number; internal: number; missed: number };
  points: Array<{
    label: string;
    start: string;
    end: string;
    total: number;
    incoming: number;
    outgoing: number;
    internal: number;
    missed: number;
  }>;
};

type ConnectKpis = {
  incomingToday: number;
  outgoingToday: number;
  internalToday: number;
  missedToday: number;
  callsToday?: number;
  scope: "global" | "tenant";
  tenantId?: string;
  asOf: string;
  source?: "connect" | "pbx";
  mode?: "raw" | "canonical";
  pbxFallback?: boolean;
  tenantsQueried?: number;
};

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  // ── Context & scope ──
  const { adminScope, tenantId: contextTenantId } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const telephony = useTelephony();
  // Use reactive contextTenantId from AppContext (not direct localStorage read) so the
  // live-call list updates correctly when the user switches tenants via TenantSwitcher.
  const liveCalls = telephony.callsByTenant(isGlobal ? null : contextTenantId);

  // ── Refresh ticks ──
  const [combinedTick, setCombinedTick] = useState(0);
  const [kpiTick,      setKpiTick]      = useState(0);
  const [trafficTick,  setTrafficTick]  = useState(0);

  useEffect(() => {
    const combinedMs = isGlobal ? 120_000 : 60_000;
    const trafficMs  = isGlobal ? 300_000 : 120_000;
    const t1 = window.setInterval(() => setCombinedTick((v) => v + 1), combinedMs);
    const t2 = window.setInterval(() => setTrafficTick((v)  => v + 1), trafficMs);
    const t3 = window.setInterval(() => setKpiTick((v)       => v + 1), 30_000);
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); };
  }, [isGlobal]);

  // Refresh KPIs when a call ends
  const prevActiveCount = useRef<number | null>(null);
  useEffect(() => {
    const count = liveCalls.length;
    if (prevActiveCount.current !== null && count < prevActiveCount.current) {
      const timer = window.setTimeout(() => setKpiTick((v) => v + 1), 4_000);
      prevActiveCount.current = count;
      return () => clearTimeout(timer);
    }
    prevActiveCount.current = count;
  }, [liveCalls.length]);

  // ── Data fetching ──
  const pbxCombinedState = useAsyncResource<PbxLiveCombined | AdminPbxLiveCombined>(
    () => isGlobal ? loadAdminPbxLiveCombined() : loadPbxLiveCombined(),
    [adminScope, combinedTick]
  );

  const kpiParam = (() => {
    const params = new URLSearchParams({ source: "connect", mode: "canonical" });
    if (!isGlobal && contextTenantId) params.set("tenantId", contextTenantId);
    return `?${params.toString()}`;
  })();
  const connectKpisState = useAsyncResource<ConnectKpis>(
    () => apiGet<ConnectKpis>(`/dashboard/call-kpis${kpiParam}`),
    [adminScope, contextTenantId, kpiTick]
  );

  const trafficParam = (() => {
    const params = new URLSearchParams({ scope: adminScope, range: "today" });
    if (!isGlobal && contextTenantId) params.set("tenantId", contextTenantId);
    return `?${params.toString()}`;
  })();
  const trafficState = useAsyncResource<DashboardCallTraffic>(
    () => apiGet<DashboardCallTraffic>(`/dashboard/call-traffic${trafficParam}`),
    [adminScope, contextTenantId, trafficTick]
  );

  // ── Derived values ──
  const combined     = pbxCombinedState.status === "success" ? pbxCombinedState.data : null;
  const pbxLive      = combined?.summary ?? null;
  const activeCalls  = combined?.activeCalls ?? null;
  const traffic      = trafficState.status === "success" ? trafficState.data : null;

  const isAdminSummary = (s: PbxLiveSummary | AdminPbxLiveSummary | null): s is AdminPbxLiveSummary =>
    s !== null && "totalCallsToday" in s;

  const activeCallCount   = isAdminSummary(pbxLive) ? pbxLive.totalActiveCalls : pbxLive?.activeCalls ?? null;
  const activeCallsSource = isAdminSummary(pbxLive) ? "global" : pbxLive?.activeCallsSource ?? null;

  const connectKpis   = connectKpisState.status === "success" ? connectKpisState.data : null;
  const incomingToday = connectKpis?.incomingToday ?? null;
  const outgoingToday = connectKpis?.outgoingToday ?? null;
  const internalToday = connectKpis?.internalToday ?? null;
  const missedToday   = connectKpis?.missedToday ?? null;

  // 1-second tick for duration counters (UI only)
  const [, setDurationTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setDurationTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const wsActiveCalls      = telephony.isLive ? liveCalls.length : null;
  const displayActiveCount = wsActiveCalls !== null ? wsActiveCalls : activeCallCount;
  const activeCountMeta    = telephony.isLive
    ? "Live via AMI"
    : activeCallsSource === "ari" ? "Live via ARI" : "ARI not configured";

  // ── Supporting card data ──
  const totalCalls     = (incomingToday ?? 0) + (outgoingToday ?? 0) + (internalToday ?? 0);
  const answeredCalls  = Math.max(0, totalCalls - (missedToday ?? 0));
  const answerRate     = totalCalls > 0 ? Math.round((answeredCalls / totalCalls) * 100) : null;

  // ── Smart insight derivation (pure frontend, no API) ──
  const insight = deriveInsight({
    incoming: incomingToday, outgoing: outgoingToday, internal: internalToday,
    missed: missedToday, answerRate, totalCalls, kpisReady: connectKpisState.status === "success",
  });

  return (
    <PermissionGate permission="can_view_dashboard" fallback={<div className="state-box">You do not have dashboard access.</div>}>
      <div className="dash-shell">

        <PageHeader title="Overview" />

        {/* ── HERO CHART ── */}
        <section className="dash-hero-section" aria-label="Call activity">
          <div className="dash-hero-card">
            <div className="dash-hero-header">
              <div>
                <h2 className="dash-hero-title">Call activity</h2>
                <p className="dash-hero-sub">Today · total call volume · {traffic?.timezone ?? "local PBX time"}</p>
              </div>
              <div className="dash-hero-status-pill">
                <Activity size={13} />
                <span>Total calls trend</span>
              </div>
            </div>
            <div className="dash-hero-plot">
              {trafficState.status === "loading" ? (
                <LoadingSkeleton rows={5} />
              ) : !traffic || traffic.points.length === 0 || traffic.totals.total === 0 ? (
                <ChartEmptyState />
              ) : (
                <CallVolumeChart points={traffic.points} />
              )}
              </div>
              </div>
        </section>

        {/* ── KPI CARDS ── */}
        <section className="dash-kpi-row" aria-label="Key metrics">
          <KpiCard
            label="Active Calls" value={displayActiveCount} meta={activeCountMeta}
            variant="active" delay={0}
          />
          <KpiCard
            label="Incoming" value={incomingToday} meta="Today"
            variant="incoming" delay={60}
          />
          <KpiCard
            label="Outgoing" value={outgoingToday} meta="Today"
            variant="outgoing" delay={120}
          />
          <KpiCard
            label="Internal" value={internalToday} meta="Extension-to-extension"
            variant="internal" delay={180}
          />
          <KpiCard
            label="Missed" value={missedToday} meta="Unanswered"
            variant="missed" delay={240}
          />
            {isGlobal && isAdminSummary(pbxLive) ? (
            <KpiCard
              label="Active Tenants" value={pbxLive.activeTenantsCount} meta="With calls today"
              variant="default" delay={300}
            />
            ) : null}
        </section>

        {/* ── SUPPORTING METRIC CARDS ── */}
        <section className="dash-support-row" aria-label="Call summary">
          <CallMixCard
            incoming={incomingToday}
            outgoing={outgoingToday}
            internal={internalToday}
            loading={connectKpisState.status === "loading"}
          />
          <AnswerRateCard
            rate={answerRate}
            answered={connectKpisState.status === "success" ? answeredCalls : null}
            missed={missedToday}
            loading={connectKpisState.status === "loading"}
          />
        </section>

        {/* ── INSIGHT ROW ── */}
        <section className="dash-insights-row" aria-label="Insights">
          <SmartInsightCard insight={insight} loading={connectKpisState.status === "loading"} />
          <CallOutcomesCard
            incoming={incomingToday}
            outgoing={outgoingToday}
            internal={internalToday}
            missed={missedToday}
            loading={connectKpisState.status === "loading"}
          />
          <TrafficSnapshotCard
            incoming={incomingToday}
            outgoing={outgoingToday}
            internal={internalToday}
            missed={missedToday}
            loading={connectKpisState.status === "loading"}
          />
        </section>

        {/* ── CALL FLOW PIPELINE ── */}
        <section className="dash-section" aria-label="Call flow">
          <CallFlowWidget
            incoming={incomingToday}
            answered={answeredCalls}
            missed={missedToday}
            outgoing={outgoingToday}
            loading={connectKpisState.status === "loading"}
          />
        </section>

        {/* ── ACTIVITY HEATMAP + SYSTEM STATUS ── */}
        <section className="dash-wide-split" aria-label="Activity patterns">
          <ActivityHeatmapCard
            points={traffic?.points ?? []}
            loading={trafficState.status === "loading"}
          />
          <div className="dash-side-stack">
            <SystemStatusCard isConnected={telephony.status === "connected"} />
            <TimeConditionCard />
                      </div>
        </section>

        {/* ── EXTENSION PRESENCE GRID ── */}
        <section className="dash-section" aria-label="Extension presence">
          <div className="dash-section-hdr">
            <h3 className="dash-section-title">Extension presence</h3>
            <span className="dash-shell-badge">Preview — wire up when live</span>
            </div>
          <ExtensionPresenceGrid />
        </section>

        {/* ── QUEUE + IVR + VOICEMAIL ROW ── */}
        <section className="dash-three-col" aria-label="Operations">
          <QueueAnalyticsCard />
          <IvrAnalyticsCard />
          <VoicemailCard />
        </section>

        {/* ── RECORDINGS + BILLING ROW ── */}
        <section className="dash-two-col" aria-label="Records and billing">
          <RecordingsCard />
          <BillingSnapshotCard />
        </section>

        {/* ── LIVE CALLS ── */}
        <section className="dash-section" aria-label="Live calls">
          <h3 className="dash-section-title">Live calls</h3>
          <div className="dash-live-panel">
            {telephony.isLive ? (
              liveCalls.length > 0 ? (
                <div className="calls-live-section">
                  <div className="calls-live-header">
                    <span className="calls-live-dot" />
                    <h3 className="calls-live-title">Active</h3>
                    <span className="calls-live-count">{liveCalls.length}</span>
                  </div>
                  <div className="calls-live-list">
                      {liveCalls.map((call) => {
                        const dir = call.direction === "inbound" ? "incoming" : call.direction === "outbound" ? "outgoing" : "internal";
                      const elapsed = call.answeredAt
                          ? Math.floor((Date.now() - new Date(call.answeredAt).getTime()) / 1000)
                          : Math.floor((Date.now() - new Date(call.startedAt).getTime()) / 1000);
                      const displayTo = call.to
                        ? call.to
                        : <span style={{ fontStyle: "italic", color: "var(--console-muted)", fontSize: "0.8rem" }}>Resolving…</span>;
                      const displayTenant = call.tenantName ?? call.tenantId ?? null;
                        return (
                        <div key={call.id} className="calls-live-row">
                          <DirectionIcon direction={dir} size={15} />
                          <span className="calls-live-caller">
                            {call.fromName && <span className="calls-live-cnam">{call.fromName}</span>}
                            <span className="mono">{call.from || "—"}</span>
                          </span>
                          <span className="calls-live-arrow">→</span>
                          <span className="mono">{displayTo}</span>
                          <span className={`chip ${directionClass(dir)}`}>{directionLabel(dir)}</span>
                          <span className="chip info">{callStateLabel(call.state)}</span>
                          <span className="mono muted">{formatDurationSec(elapsed)}</span>
                          {isGlobal && displayTenant ? (
                            <span className="muted">{displayTenant}</span>
                          ) : null}
                          <LiveCallBadge active />
                        </div>
                        );
                      })}
                  </div>
                </div>
              ) : (
                <LiveCallsEmptyState />
              )
            ) : pbxCombinedState.status === "loading" ? (
              <LoadingSkeleton rows={1} />
            ) : activeCalls?.calls && activeCalls.calls.length > 0 ? (
              <div className="calls-live-section">
                <div className="calls-live-header">
                  <span className="calls-live-dot" />
                  <h3 className="calls-live-title">Active</h3>
                  <span className="calls-live-count">{activeCalls.calls.length}</span>
                </div>
                <div className="calls-live-list">
                    {activeCalls.calls.map((call) => (
                    <div key={call.channelId} className="calls-live-row">
                      <DirectionIcon direction={call.direction} size={15} />
                      <span className="calls-live-caller">
                        <span className="mono">{call.caller || "—"}</span>
                      </span>
                      <span className="calls-live-arrow">→</span>
                      <span className="mono">{call.callee || "—"}</span>
                      <span className={`chip ${directionClass(call.direction)}`}>{directionLabel(call.direction)}</span>
                      <span className="chip info">{callStateLabel(call.state)}</span>
                      <span className="mono muted">{formatDurationSec(call.durationSeconds)}</span>
                    </div>
                  ))}
              </div>
              </div>
            ) : (
              <LiveCallsEmptyState />
            )}
          </div>
        </section>

      </div>
    </PermissionGate>
  );
}

// ── New exploration widgets ──────────────────────────────────────────────────

// ── Call Flow Pipeline ────────────────────────────────────────────────────────
function CallFlowWidget({
  incoming, answered, missed, outgoing, loading,
}: {
  incoming: number | null; answered: number; missed: number | null;
  outgoing: number | null; loading: boolean;
}) {
  const steps = [
    { icon: <PhoneCall size={18} />, label: "Incoming", value: incoming, color: "var(--dash-incoming)", note: "PSTN & SIP calls" },
    { icon: <GitMerge size={18} />, label: "IVR / Routing", value: null, color: "var(--dash-outgoing)", note: "Auto-attendant" },
    { icon: <ListOrdered size={18} />, label: "Queue", value: null, color: "var(--dash-internal)", note: "Waiting + answered" },
    { icon: <Users size={18} />, label: "Extension", value: null, color: "#a78bfa", note: "Agent pickup" },
    { icon: <CheckCircle2 size={18} />, label: "Outcome", value: null, color: "var(--dash-incoming)", note: null, outcome: { answered, missed: missed ?? 0 } },
  ];

  return (
    <div className="dash-flow-card">
      <div className="dash-flow-header">
        <Workflow size={16} className="dash-flow-icon" />
        <span className="dash-flow-title">Call flow pipeline</span>
        <span className="dash-flow-sub">Today's inbound journey</span>
      </div>
      <div className="dash-flow-track">
        {steps.map((step, i) => (
          <div key={i} className="dash-flow-step-wrap">
            <div className="dash-flow-step" style={{ "--flow-color": step.color } as React.CSSProperties}>
              <div className="dash-flow-step-icon" style={{ color: step.color }}>{step.icon}</div>
              <div className="dash-flow-step-body">
                <span className="dash-flow-step-label">{step.label}</span>
                {loading ? (
                  <span className="dash-flow-step-val dash-flow-step-val--loading">…</span>
                ) : step.outcome ? (
                  <span className="dash-flow-step-val">
                    <span className="dash-flow-outcome-ok">{step.outcome.answered} ✓</span>
                    {" "}
                    <span className="dash-flow-outcome-miss">{step.outcome.missed} ✗</span>
                  </span>
                ) : step.value !== null ? (
                  <span className="dash-flow-step-val">{step.value.toLocaleString()}</span>
                ) : (
                  <span className="dash-flow-step-val dash-flow-step-val--shell">—</span>
                )}
                {step.note ? <span className="dash-flow-step-note">{step.note}</span> : null}
                </div>
                </div>
            {i < steps.length - 1 && <div className="dash-flow-arrow">›</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Activity Heatmap ──────────────────────────────────────────────────────────
function ActivityHeatmapCard({ points, loading }: { points: Array<{ label: string; incoming: number; outgoing: number; internal: number; missed?: number }>; loading: boolean }) {
  const cells = points.map((p) => ({
    label: p.label,
    total: p.incoming + p.outgoing + p.internal,
  }));
  const peak = Math.max(1, ...cells.map((c) => c.total));
  const [hov, setHov] = useState<{ label: string; total: number } | null>(null);

  return (
    <div className="dash-heatmap-card">
      <div className="dash-flow-header">
        <Activity size={16} className="dash-flow-icon" />
        <span className="dash-flow-title">Activity heatmap</span>
        <span className="dash-flow-sub">Call volume across the day</span>
        {hov && <span className="dash-heatmap-tooltip">{hov.label} · {hov.total} calls</span>}
      </div>
      {loading ? (
        <div className="dash-heatmap-grid dash-heatmap-grid--loading">
          {Array.from({ length: 24 }).map((_, i) => (
            <div key={i} className="dash-heatmap-cell dash-heatmap-cell--skeleton" />
          ))}
        </div>
      ) : cells.length === 0 ? (
        <div className="dash-support-empty">No traffic data available yet</div>
      ) : (
        <div className="dash-heatmap-grid" style={{ "--cell-count": cells.length } as React.CSSProperties}>
          {cells.map((c, i) => {
            const intensity = c.total / peak;
            return (
              <div
                key={i}
                className="dash-heatmap-cell"
                style={{
                  "--intensity": intensity,
                  opacity: 0.15 + intensity * 0.85,
                  background: intensity > 0.7
                    ? "var(--dash-incoming)"
                    : intensity > 0.4
                    ? "var(--dash-outgoing)"
                    : intensity > 0.1
                    ? "var(--dash-internal)"
                    : "var(--console-panel-soft)",
                } as React.CSSProperties}
                onMouseEnter={() => setHov(c)}
                onMouseLeave={() => setHov(null)}
                title={`${c.label}: ${c.total} calls`}
              />
            );
          })}
        </div>
      )}
      <div className="dash-heatmap-legend">
        <span className="dash-heatmap-legend-label">Low</span>
        <span className="dash-heatmap-legend-bar" />
        <span className="dash-heatmap-legend-label">High</span>
      </div>
    </div>
  );
}

// ── System Status Card ─────────────────────────────────────────────────────────
function SystemStatusCard({ isConnected }: { isConnected: boolean }) {
  const items = [
    { label: "AMI / Telephony", ok: isConnected, icon: isConnected ? <Wifi size={13} /> : <WifiOff size={13} /> },
    { label: "API Gateway", ok: true, icon: <Radio size={13} /> },
    { label: "Event Processing", ok: true, icon: <Activity size={13} /> },
  ];
  const allOk = items.every((i) => i.ok);
  return (
    <div className="dash-status-card">
      <div className="dash-status-header">
        <span className={`dash-status-orb ${allOk ? "ok" : "warn"}`} />
        <span className="dash-status-title">System health</span>
                  </div>
      {items.map((item) => (
        <div key={item.label} className={`dash-status-row ${item.ok ? "ok" : "warn"}`}>
          <span className="dash-status-row-icon">{item.icon}</span>
          <span className="dash-status-row-label">{item.label}</span>
          <span className={`dash-status-row-pill ${item.ok ? "ok" : "warn"}`}>{item.ok ? "OK" : "Down"}</span>
                  </div>
              ))}
            </div>
  );
}

// ── Time Condition Card ────────────────────────────────────────────────────────
function TimeConditionCard() {
  const now = new Date();
  const h = now.getHours();
  const isBusinessHours = h >= 8 && h < 18;
  const dayOfWeek = now.getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const mode = isWeekend ? "weekend" : isBusinessHours ? "open" : "after-hours";
  const modeLabel = mode === "open" ? "Open" : mode === "weekend" ? "Weekend" : "After Hours";
  const modeColor = mode === "open" ? "var(--console-success)" : "var(--console-warning)";
  return (
    <div className="dash-timecond-card">
      <div className="dash-status-header">
        <Clock size={14} style={{ color: modeColor }} />
        <span className="dash-status-title">Business hours</span>
              </div>
      <div className="dash-timecond-status" style={{ color: modeColor }}>{modeLabel}</div>
      <div className="dash-timecond-note">
        {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} local · {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][dayOfWeek]}
              </div>
              </div>
  );
}

// ── Extension Presence Grid ───────────────────────────────────────────────────
function ExtensionPresenceGrid() {
  const PLACEHOLDER_EXTS = [
    { ext: "101", name: "Alice M.", status: "available" },
    { ext: "102", name: "Bob K.",   status: "on-call"   },
    { ext: "103", name: "Carol T.", status: "available" },
    { ext: "104", name: "Dan W.",   status: "offline"   },
    { ext: "105", name: "Eve S.",   status: "on-call"   },
    { ext: "106", name: "Frank L.", status: "available" },
    { ext: "107", name: "Grace H.", status: "ringing"   },
    { ext: "108", name: "Hank J.",  status: "offline"   },
    { ext: "109", name: "Iris P.",  status: "available" },
    { ext: "110", name: "Jake R.",  status: "on-call"   },
    { ext: "111", name: "Kim T.",   status: "available" },
    { ext: "112", name: "Leo V.",   status: "offline"   },
  ];
  const STATUS: Record<string, { label: string; color: string }> = {
    "available": { label: "Available", color: "var(--console-success)" },
    "on-call":   { label: "On Call",   color: "var(--dash-outgoing)"   },
    "ringing":   { label: "Ringing",   color: "var(--console-warning)" },
    "offline":   { label: "Offline",   color: "var(--console-muted)"   },
  };
  return (
    <div className="dash-presence-grid">
      {PLACEHOLDER_EXTS.map((e) => {
        const s = STATUS[e.status];
        const initials = e.name.split(" ").map((p) => p[0]).join("").toUpperCase();
        return (
          <div key={e.ext} className={`dash-presence-card dash-presence-card--${e.status}`}>
            <div className="dash-presence-avatar">
              {initials}
              <span className="dash-presence-dot" style={{ background: s.color }} />
              </div>
            <div className="dash-presence-info">
              <span className="dash-presence-name">{e.name}</span>
              <span className="dash-presence-ext">Ext. {e.ext}</span>
            </div>
            <span className="dash-presence-status" style={{ color: s.color }}>{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Queue Analytics Card ──────────────────────────────────────────────────────
function QueueAnalyticsCard() {
  const metrics = [
    { label: "Waiting now",   value: "—", sub: "in queue" },
    { label: "Avg wait time", value: "—", sub: "seconds" },
    { label: "Answered",      value: "—", sub: "today" },
    { label: "Abandoned",     value: "—", sub: "today" },
  ];
  return (
    <div className="dash-ops-card">
      <div className="dash-ops-header">
        <ListOrdered size={15} className="dash-ops-icon" />
        <span className="dash-ops-title">Queue analytics</span>
      </div>
      <div className="dash-ops-note">Live queue data — wire up to connect queue API</div>
      <div className="dash-ops-metrics">
        {metrics.map((m) => (
          <div key={m.label} className="dash-ops-metric">
            <span className="dash-ops-metric-val">{m.value}</span>
            <span className="dash-ops-metric-label">{m.label}</span>
            <span className="dash-ops-metric-sub">{m.sub}</span>
          </div>
        ))}
            </div>
    </div>
  );
}

// ── IVR Analytics Card ────────────────────────────────────────────────────────
function IvrAnalyticsCard() {
  const options = [
    { label: "Option 1 — Sales",    pct: 42, color: "var(--dash-outgoing)"  },
    { label: "Option 2 — Support",  pct: 31, color: "var(--dash-internal)"  },
    { label: "Option 3 — Billing",  pct: 18, color: "#a78bfa"               },
    { label: "Option 0 — Operator", pct: 9,  color: "var(--console-muted)"  },
  ];
  return (
    <div className="dash-ops-card">
      <div className="dash-ops-header">
        <GitMerge size={15} className="dash-ops-icon" />
        <span className="dash-ops-title">IVR analytics</span>
            </div>
      <div className="dash-ops-note">Menu option distribution · shell preview</div>
      <div className="dash-ivr-bars">
        {options.map((o) => (
          <div key={o.label} className="dash-ivr-bar-row">
            <span className="dash-ivr-bar-label">{o.label}</span>
            <div className="dash-ivr-bar-track">
              <div
                className="dash-ivr-bar-fill"
                style={{ width: `${o.pct}%`, background: o.color }}
              />
                  </div>
            <span className="dash-ivr-bar-pct">{o.pct}%</span>
                  </div>
        ))}
                  </div>
                  </div>
  );
}

// ── Voicemail Snapshot Card ───────────────────────────────────────────────────
function VoicemailCard() {
  return (
    <div className="dash-ops-card">
      <div className="dash-ops-header">
        <Voicemail size={15} className="dash-ops-icon" />
        <span className="dash-ops-title">Voicemail</span>
                </div>
      <div className="dash-voicemail-empty">
        <Voicemail size={28} className="dash-voicemail-icon" />
        <p className="dash-voicemail-msg">No unread voicemails</p>
        <span className="dash-ops-note">Connect voicemail API to see messages here</span>
      </div>
    </div>
  );
}

// ── Recordings Panel ──────────────────────────────────────────────────────────
function RecordingsCard() {
                        return (
    <div className="dash-records-card">
      <div className="dash-records-header">
        <Mic size={15} className="dash-ops-icon" />
        <span className="dash-ops-title">Recent recordings</span>
      </div>
      <div className="dash-records-empty">
        <Mic size={30} className="dash-voicemail-icon" />
        <p className="dash-voicemail-msg">No recent recordings</p>
        <span className="dash-ops-note">Completed recorded calls appear here</span>
      </div>
    </div>
  );
}

// ── Billing Snapshot Card ─────────────────────────────────────────────────────
function BillingSnapshotCard() {
  const bars = [
    { label: "Voice minutes", used: 0, total: 1000, color: "var(--dash-outgoing)" },
    { label: "SMS messages",  used: 0, total: 500,  color: "var(--dash-internal)" },
    { label: "Data (MB)",     used: 0, total: 2000, color: "#a78bfa"              },
  ];
  return (
    <div className="dash-records-card">
      <div className="dash-records-header">
        <CreditCard size={15} className="dash-ops-icon" />
        <span className="dash-ops-title">Usage &amp; billing</span>
        <span className="dash-ops-note" style={{ marginLeft: "auto", fontSize: "11px" }}>Month-to-date</span>
                </div>
      <div className="dash-billing-bars">
        {bars.map((b) => (
          <div key={b.label} className="dash-billing-row">
            <div className="dash-billing-row-top">
              <span className="dash-billing-label">{b.label}</span>
              <span className="dash-billing-val">{b.used.toLocaleString()} / {b.total.toLocaleString()}</span>
            </div>
            <div className="dash-billing-track">
              <div
                className="dash-billing-fill"
                style={{ width: `${Math.max(2, b.total > 0 ? (b.used / b.total) * 100 : 0)}%`, background: b.color }}
              />
            </div>
          </div>
                    ))}
                  </div>
      <div className="dash-ops-note" style={{ paddingTop: 8 }}>Connect billing API to populate real usage data</div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function KpiCard({
  label, value, meta, variant, delay,
}: {
  label: string; value: number | null; meta: string;
  variant: "active" | "incoming" | "outgoing" | "internal" | "missed" | "default";
  delay: number;
}) {
  return (
    <article
      className={`dash-kpi2 dash-kpi2--${variant}`}
      style={{ "--kpi-delay": `${delay}ms` } as React.CSSProperties}
    >
      <div className="dash-kpi2-accent" />
      <div className="dash-kpi2-body">
        <div className="dash-kpi2-label">{label}</div>
        <div className="dash-kpi2-value">{value !== null ? value.toLocaleString() : "—"}</div>
        <div className="dash-kpi2-meta">{meta}</div>
      </div>
    </article>
  );
}

function CallMixCard({
  incoming, outgoing, internal, loading,
}: {
  incoming: number | null; outgoing: number | null; internal: number | null; loading: boolean;
}) {
  const hasData = incoming !== null && outgoing !== null && internal !== null;
  const total   = (incoming ?? 0) + (outgoing ?? 0) + (internal ?? 0);
  const segments = hasData && total > 0 ? [
    { value: incoming ?? 0, color: "var(--dash-incoming)", label: "Incoming" },
    { value: outgoing ?? 0, color: "var(--dash-outgoing)", label: "Outgoing" },
    { value: internal ?? 0, color: "var(--dash-internal)", label: "Internal" },
  ] : [];

  return (
    <div className="dash-support-card">
      <div className="dash-support-header">
        <h4 className="dash-support-title">Call mix</h4>
        <span className="dash-support-sub">Direction breakdown today</span>
      </div>
      {loading ? (
        <LoadingSkeleton rows={2} />
      ) : segments.length === 0 ? (
        <p className="dash-support-empty">No calls yet today</p>
      ) : (
        <div className="dash-donut-layout">
          <DonutRing segments={segments} cx={60} cy={60} outerR={54} innerR={36} size={120} />
          <div className="dash-donut-legend">
            {segments.map((s) => (
              <div key={s.label} className="dash-donut-legend-row">
                <span className="dash-donut-swatch" style={{ background: s.color }} />
                <span className="dash-donut-legend-label">{s.label}</span>
                <span className="dash-donut-legend-val">{s.value.toLocaleString()}</span>
                <span className="dash-donut-legend-pct">{Math.round(s.value / total * 100)}%</span>
              </div>
            ))}
                    </div>
        </div>
      )}
    </div>
  );
}

function AnswerRateCard({
  rate, answered, missed, loading,
}: {
  rate: number | null; answered: number | null; missed: number | null; loading: boolean;
}) {
  const hasData = rate !== null;
  const segments = hasData ? [
    { value: answered ?? 0, color: "var(--dash-incoming)", label: "Answered" },
    { value: missed ?? 0,   color: "var(--dash-missed)",   label: "Missed"   },
  ] : [];

  return (
    <div className="dash-support-card">
      <div className="dash-support-header">
        <h4 className="dash-support-title">Answer rate</h4>
        <span className="dash-support-sub">Answered vs missed today</span>
      </div>
      {loading ? (
        <LoadingSkeleton rows={2} />
      ) : !hasData ? (
        <p className="dash-support-empty">No calls yet today</p>
      ) : (
        <div className="dash-donut-layout">
          <div className="dash-rate-ring-wrap">
            <DonutRing segments={segments} cx={60} cy={60} outerR={54} innerR={36} size={120} />
            <div className="dash-rate-center">
              <span className="dash-rate-pct">{rate}%</span>
            </div>
          </div>
          <div className="dash-donut-legend">
            <div className="dash-donut-legend-row">
              <span className="dash-donut-swatch" style={{ background: "var(--dash-incoming)" }} />
              <span className="dash-donut-legend-label">Answered</span>
              <span className="dash-donut-legend-val">{(answered ?? 0).toLocaleString()}</span>
            </div>
            <div className="dash-donut-legend-row">
              <span className="dash-donut-swatch" style={{ background: "var(--dash-missed)" }} />
              <span className="dash-donut-legend-label">Missed</span>
              <span className="dash-donut-legend-val">{(missed ?? 0).toLocaleString()}</span>
            </div>
            <div className="dash-rate-tagline">
              {(rate ?? 0) >= 90
                ? "Excellent answer rate"
                : (rate ?? 0) >= 75
                ? "Good answer rate"
                : "Needs attention"}
            </div>
          </div>
        </div>
      )}
              </div>
  );
}

function LiveCallsEmptyState() {
  return (
    <div className="dash-live-empty">
      <div className="dash-live-empty-ring">
        <Phone size={22} className="dash-live-empty-icon" />
      </div>
      <p className="dash-live-empty-title">All quiet</p>
      <p className="dash-live-empty-sub">No active calls right now. Live updates are on.</p>
    </div>
  );
}

function ChartEmptyState() {
  return (
    <div className="dash-chart-empty">
      <div className="dash-chart-empty-orb">
        <PhoneCall size={22} />
      </div>
      <p className="dash-chart-empty-text">No call activity yet</p>
      <p className="dash-chart-empty-sub">Calls will appear here once activity is recorded.</p>
    </div>
  );
}

// ── Smart Insight ─────────────────────────────────────────────────────────────

type InsightData = {
  headline: string;
  body: string;
  bigNum: string;
  bigLabel: string;
  accent: "green" | "blue" | "amber" | "red" | "purple";
  Icon: React.ElementType;
};

function deriveInsight({
  incoming, outgoing, internal, missed, answerRate, totalCalls, kpisReady,
}: {
  incoming: number | null; outgoing: number | null; internal: number | null;
  missed: number | null; answerRate: number | null; totalCalls: number; kpisReady: boolean;
}): InsightData | null {
  if (!kpisReady || totalCalls === 0) return null;

  const rate    = answerRate ?? 0;
  const missed_ = missed ?? 0;
  const in_     = incoming ?? 0;
  const out_    = outgoing ?? 0;
  const int_    = internal ?? 0;

  if (rate >= 95) {
    return {
      headline: "Outstanding answer rate",
      body: `${rate}% of all calls handled today — your team is crushing it.`,
      bigNum: `${rate}%`, bigLabel: "Answered",
      accent: "green", Icon: ShieldCheck,
    };
  }
  if (rate >= 80) {
    return {
      headline: "Strong performance today",
      body: `${rate}% answered. ${missed_} call${missed_ === 1 ? "" : "s"} went unanswered — well within range.`,
      bigNum: `${rate}%`, bigLabel: "Answer rate",
      accent: "blue", Icon: TrendingUp,
    };
  }
  if (rate < 80 && missed_ > 0) {
    return {
      headline: "Missed calls need attention",
      body: `${missed_} of ${totalCalls} call${totalCalls === 1 ? "" : "s"} went unanswered — ${rate}% answer rate today.`,
      bigNum: `${missed_}`, bigLabel: "Missed today",
      accent: "amber", Icon: AlertTriangle,
    };
  }
  if (in_ > (out_ + int_) * 1.5) {
    return {
      headline: "Heavy inbound traffic",
      body: `${in_} incoming vs ${out_} outgoing — inbound is dominating today's volume.`,
      bigNum: `${in_}`, bigLabel: "Inbound calls",
      accent: "blue", Icon: TrendingUp,
    };
  }
  return {
    headline: "Balanced call activity",
    body: `${in_} incoming · ${out_} outgoing · ${int_} internal today.`,
    bigNum: `${totalCalls}`, bigLabel: "Total calls",
    accent: "purple", Icon: BarChart3,
  };
}

function SmartInsightCard({ insight, loading }: { insight: InsightData | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="dash-insight-card dash-insight-card--loading">
        <LoadingSkeleton rows={3} />
      </div>
    );
  }
  if (!insight) {
    return (
      <div className="dash-insight-card dash-insight-card--empty">
        <BarChart3 size={28} className="dash-insight-empty-icon" />
        <p className="dash-insight-headline">Awaiting today&apos;s data</p>
        <p className="dash-insight-body">Insights appear once call activity is recorded.</p>
      </div>
    );
  }
  const { headline, body, bigNum, bigLabel, accent, Icon } = insight;
  return (
    <div className={`dash-insight-card dash-insight-card--${accent}`}>
      <div className="dash-insight-bg" />
      <div className="dash-insight-icon-wrap">
        <Icon size={18} />
      </div>
      <div className="dash-insight-big-stat">
        <span className="dash-insight-big-num">{bigNum}</span>
        <span className="dash-insight-big-label">{bigLabel}</span>
      </div>
      <p className="dash-insight-headline">{headline}</p>
      <p className="dash-insight-body">{body}</p>
    </div>
  );
}

// ── Call Outcomes ─────────────────────────────────────────────────────────────

function CallOutcomesCard({
  incoming, outgoing, internal, missed, loading,
}: {
  incoming: number | null; outgoing: number | null; internal: number | null;
  missed: number | null; loading: boolean;
}) {
  const answeredIn = Math.max(0, (incoming ?? 0) - (missed ?? 0));
  const segments = [
    { label: "Answered",  value: answeredIn,       color: "var(--dash-incoming)" },
    { label: "Outgoing",  value: outgoing ?? 0,    color: "var(--dash-outgoing)" },
    { label: "Internal",  value: internal ?? 0,    color: "var(--dash-internal)" },
    { label: "Missed",    value: missed ?? 0,      color: "var(--dash-missed)"   },
  ];
  const total = segments.reduce((s, x) => s + x.value, 0);
  const hasData = total > 0;

  return (
    <div className="dash-outcomes-card">
      <div className="dash-outcomes-header">
        <h4 className="dash-outcomes-title">Call outcomes</h4>
        <span className="dash-outcomes-sub">Breakdown today</span>
      </div>
      {loading ? (
        <LoadingSkeleton rows={3} />
      ) : !hasData ? (
        <p className="dash-support-empty">No call data yet today</p>
      ) : (
        <>
          <div className="dash-stacked-bar">
            {segments.filter((s) => s.value > 0).map((s, i) => (
              <div
                key={i}
                className="dash-stacked-seg"
                style={{ width: `${(s.value / total * 100).toFixed(1)}%`, background: s.color, animationDelay: `${i * 80}ms` }}
                title={`${s.label}: ${s.value}`}
              />
            ))}
          </div>
          <div className="dash-outcomes-legend">
            {segments.map((s, i) => (
              <div key={i} className="dash-outcomes-row">
                <span className="dash-outcomes-swatch" style={{ background: s.color }} />
                <span className="dash-outcomes-label">{s.label}</span>
                <span className="dash-outcomes-val">{s.value.toLocaleString()}</span>
                {total > 0 && (
                  <span className="dash-outcomes-pct">{Math.round(s.value / total * 100)}%</span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Traffic Snapshot ──────────────────────────────────────────────────────────

function TrafficSnapshotCard({
  incoming, outgoing, internal, missed, loading,
}: {
  incoming: number | null; outgoing: number | null; internal: number | null;
  missed: number | null; loading: boolean;
}) {
  const rows = [
    { label: "Incoming", value: incoming ?? 0, color: "var(--dash-incoming)" },
    { label: "Outgoing", value: outgoing ?? 0, color: "var(--dash-outgoing)" },
    { label: "Internal", value: internal ?? 0, color: "var(--dash-internal)" },
    { label: "Missed",   value: missed ?? 0,   color: "var(--dash-missed)"   },
  ].sort((a, b) => b.value - a.value);
  const peak    = Math.max(1, rows[0].value);
  const hasData = rows.some((r) => r.value > 0);

  return (
    <div className="dash-snapshot-card">
      <div className="dash-outcomes-header">
        <h4 className="dash-outcomes-title">Traffic snapshot</h4>
        <span className="dash-outcomes-sub">Ranked by volume</span>
              </div>
      {loading ? (
        <LoadingSkeleton rows={3} />
      ) : !hasData ? (
        <p className="dash-support-empty">No call data yet today</p>
      ) : (
        <div className="dash-snapshot-rows">
          {rows.map((row, i) => (
            <div key={row.label} className="dash-snapshot-row" style={{ animationDelay: `${i * 70}ms` }}>
              <span className="dash-snapshot-rank">{i + 1}</span>
              <div className="dash-snapshot-mid">
                <div className="dash-snapshot-top">
                  <span className="dash-snapshot-label">{row.label}</span>
                  <span className="dash-snapshot-val">{row.value.toLocaleString()}</span>
              </div>
                <div className="dash-snapshot-track">
                  <div
                    className="dash-snapshot-fill"
                    style={{
                      width: `${(row.value / peak * 100).toFixed(1)}%`,
                      background: row.color,
                      animationDelay: `${i * 70 + 100}ms`,
                    }}
                  />
      </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Donut ring ────────────────────────────────────────────────────────────────

type DonutSegment = { value: number; color: string; label: string };

function polarXY(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg - 90) * (Math.PI / 180);
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function donutArcPath(
  cx: number, cy: number, outerR: number, innerR: number,
  startDeg: number, endDeg: number,
): string {
  const sweep = endDeg - startDeg;
  if (sweep >= 359.9) {
    return [
      `M ${cx} ${cy - outerR}`,
      `A ${outerR} ${outerR} 0 1 1 ${cx - 0.01} ${cy - outerR} Z`,
    ].join(" ");
  }
  const [ox1, oy1] = polarXY(cx, cy, outerR, startDeg);
  const [ox2, oy2] = polarXY(cx, cy, outerR, endDeg);
  const [ix1, iy1] = polarXY(cx, cy, innerR, endDeg);
  const [ix2, iy2] = polarXY(cx, cy, innerR, startDeg);
  const large = sweep > 180 ? 1 : 0;
  return [
    `M ${ox1.toFixed(2)} ${oy1.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${large} 1 ${ox2.toFixed(2)} ${oy2.toFixed(2)}`,
    `L ${ix1.toFixed(2)} ${iy1.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${large} 0 ${ix2.toFixed(2)} ${iy2.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function DonutRing({
  segments, cx, cy, outerR, innerR, size,
}: {
  segments: DonutSegment[]; cx: number; cy: number; outerR: number; innerR: number; size: number;
}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) return null;

  let angle = 0;
  const GAP = segments.length > 1 ? 2 : 0;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="dash-donut-svg">
      {segments.map((seg, idx) => {
        const sweep = (seg.value / total) * (360 - GAP * segments.length);
        const start = angle + GAP / 2;
        const end   = start + sweep;
        angle       = end + GAP / 2;
        return (
          <path
            key={idx}
            d={donutArcPath(cx, cy, outerR, innerR, start, end)}
            fill={seg.color}
            opacity="0.9"
            className="dash-donut-arc"
          />
        );
      })}
    </svg>
  );
}

// ── Hero Chart ────────────────────────────────────────────────────────────────

type ChartPoint = {
  label: string;
  total: number;
  incoming: number;
  outgoing: number;
  internal: number;
  missed: number;
};

function smoothCurve(pts: [number, number][]): string {
  if (pts.length < 2) return pts.length === 1 ? `M ${pts[0][0]} ${pts[0][1]}` : "";
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

function smoothArea(pts: [number, number][], baseY: number): string {
  if (pts.length === 0) return "";
  return `${smoothCurve(pts)} L ${pts[pts.length - 1][0].toFixed(1)} ${baseY.toFixed(1)} L ${pts[0][0].toFixed(1)} ${baseY.toFixed(1)} Z`;
}

function CallVolumeChart({ points }: { points: ChartPoint[] }) {
  const [hovIdx, setHovIdx] = useState<number | null>(null);

  const W   = 900;
  const H   = 300;
  const PAD = { top: 24, right: 26, bottom: 44, left: 46 };
  const iW  = W - PAD.left - PAD.right;
  const iH  = H - PAD.top  - PAD.bottom;
  const bY  = PAD.top + iH;

  const peak = Math.max(1, ...points.map((p) => p.total));
  const yMax = (() => {
    const raw = peak * 1.2;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    return Math.ceil(raw / mag) * mag;
  })();

  const xOf = (i: number) => PAD.left + (i / Math.max(1, points.length - 1)) * iW;
  const yOf = (v: number) => PAD.top  + iH - (v / yMax) * iH;

  const totalPts:  [number, number][] = points.map((p, i) => [xOf(i), yOf(p.total)]);
  const missedPts: [number, number][] = points.map((p, i) => [xOf(i), yOf(p.missed)]);

  const maxLabels = points.length > 24 ? 8 : 10;
  const step      = Math.max(1, Math.ceil(points.length / maxLabels));
  const xLabels   = points
    .map((p, i) => ({ label: p.label, i }))
    .filter(({ i }) => i % step === 0 || i === points.length - 1);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    v: Math.round(yMax * f),
    y: yOf(yMax * f),
  }));

  const hov = hovIdx !== null ? points[hovIdx] : null;
  const hovX = hovIdx !== null ? xOf(hovIdx) : null;
  const hovTotalY = hov ? yOf(hov.total) : null;

  // Tooltip: flip to left when in the right third
  const tooltipLeft = hovIdx !== null && hovIdx > points.length * 0.65;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const svgX  = relX * W;
    const idx   = Math.round((svgX - PAD.left) / iW * (points.length - 1));
    setHovIdx(Math.max(0, Math.min(points.length - 1, idx)));
  };

  return (
    <svg
      width="100%" height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="dash-hero-svg"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHovIdx(null)}
      role="img"
      aria-label="Call activity chart"
    >
      <defs>
        <linearGradient id="hg-total" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--dash-total-line, #38bdf8)" stopOpacity="0.34" />
          <stop offset="56%" stopColor="var(--dash-total-line, #38bdf8)" stopOpacity="0.10" />
          <stop offset="100%" stopColor="var(--dash-total-line, #38bdf8)" stopOpacity="0.00" />
        </linearGradient>
        <filter id="hg-glow" x="-20%" y="-40%" width="140%" height="180%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <clipPath id="hg-clip">
          <rect x={PAD.left} y={0} height={H} className="hg-clip-rect" style={{ width: iW }} />
        </clipPath>
      </defs>

      {/* Grid lines */}
      {yTicks.map(({ v, y }) => (
        <g key={v}>
          <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y}
            className="hg-grid-line" />
          <text x={PAD.left - 8} y={y} textAnchor="end" dominantBaseline="middle"
            className="hg-axis-label">
            {v}
          </text>
        </g>
      ))}

      {/* Baseline */}
      <line x1={PAD.left} y1={bY} x2={W - PAD.right} y2={bY}
        className="hg-baseline" />

      {/* X labels */}
      {xLabels.map(({ label, i }) => (
        <text key={i} x={xOf(i)} y={bY + 18} textAnchor="middle"
          className="hg-axis-label hg-axis-label--x">
          {label}
        </text>
      ))}

      {/* Area fill */}
      <g clipPath="url(#hg-clip)">
        <path d={smoothArea(totalPts, bY)} fill="url(#hg-total)" className="hg-area hg-area--total" />
      </g>

      {/* Lines */}
      <g clipPath="url(#hg-clip)">
        {points.some((p) => p.missed > 0) && (
          <path d={smoothCurve(missedPts)} fill="none" stroke="var(--dash-missed)" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round"
            pathLength="1" className="hg-line hg-line--missed" />
        )}
        <path d={smoothCurve(totalPts)} fill="none" stroke="var(--dash-total-line, #38bdf8)" strokeWidth="7"
          strokeLinecap="round" strokeLinejoin="round"
          pathLength="1" className="hg-line hg-line--glow" filter="url(#hg-glow)" />
        <path d={smoothCurve(totalPts)} fill="none" stroke="var(--dash-total-line, #38bdf8)" strokeWidth="3.25"
          strokeLinecap="round" strokeLinejoin="round"
          pathLength="1" className="hg-line hg-line--total" />
      </g>

      {/* Hover crosshair */}
      {hovX !== null && hov !== null && hovTotalY !== null && (
        <g>
          <line x1={hovX} y1={PAD.top} x2={hovX} y2={bY}
            className="hg-hover-line" />

          {/* Hover point */}
          <circle cx={hovX} cy={hovTotalY} r="10" className="hg-hover-pulse" />
          <circle cx={hovX} cy={hovTotalY} r="4.5" className="hg-hover-dot" />

          {/* Tooltip box */}
          {(() => {
            const tx = tooltipLeft ? hovX - 176 : hovX + 14;
            const ty = PAD.top + 8;
            return (
              <g className="hg-tooltip">
                <rect x={tx} y={ty} width="162" height="126" rx="12" className="hg-tooltip-bg" />
                <text x={tx + 14} y={ty + 22} className="hg-tooltip-title">{hov.label}</text>
                <text x={tx + 14} y={ty + 45} className="hg-tooltip-total">{hov.total.toLocaleString()} total calls</text>
                {[
                  ["Incoming", hov.incoming, "var(--dash-incoming)"],
                  ["Outgoing", hov.outgoing, "var(--dash-outgoing)"],
                  ["Internal", hov.internal, "var(--dash-internal)"],
                  ["Missed", hov.missed, "var(--dash-missed)"],
                ].map(([label, value, color], idx) => (
                  <g key={String(label)} transform={`translate(${tx + 14} ${ty + 68 + idx * 14})`}>
                    <circle cx="0" cy="-3.5" r="3" fill={String(color)} />
                    <text x="10" y="0" className="hg-tooltip-label">{label}</text>
                    <text x="134" y="0" textAnchor="end" className="hg-tooltip-value">
                      {Number(value).toLocaleString()}
                    </text>
                  </g>
                ))}
              </g>
            );
          })()}
        </g>
      )}
    </svg>
  );
}
