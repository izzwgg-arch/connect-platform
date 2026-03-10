"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiGet } from "../../../services/apiClient";
import { DetailCard } from "../../../components/DetailCard";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { GlobalScopeNotice } from "../../../components/GlobalScopeNotice";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { MetricCard } from "../../../components/MetricCard";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { QRPairingModal } from "../../../components/QRPairingModal";
import { RoleGate } from "../../../components/RoleGate";
import { ScopedActionButton } from "../../../components/ScopedActionButton";
import { ScopeBadge } from "../../../components/ScopeBadge";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import {
  loadPbxLiveCombined,
  loadAdminPbxLiveCombined,
  formatDurationSec,
  directionLabel,
  directionClass,
  type PbxLiveSummary,
  type AdminPbxLiveSummary,
  type PbxActiveCallsResponse,
  type PbxLiveCombined,
  type AdminPbxLiveCombined
} from "../../../services/pbxLive";
import { loadDashboardData } from "../../../services/platformData";

type DashboardCallTraffic = {
  totals: { made: number; incoming: number; outgoing: number; internal: number };
  points: Array<{ label: string; incoming: number; outgoing: number; internal: number }>;
};

export default function DashboardPage() {
  const { adminScope } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";

  // Staggered ticks — scope-aware cadence to protect VitalPBX CDR from overload.
  // GLOBAL (admin) scope aggregates 100+ tenants — poll far less frequently.
  // TENANT scope fetches one CDR query — can afford slightly more frequent refresh.
  // combinedTick  120 s (GLOBAL) / 60 s (TENANT) : PBX live data
  // trafficTick   300 s (GLOBAL) / 120 s (TENANT) : CDR traffic chart
  // resourcesTick 300 s : extension/trunk/queue counts (rarely change)
  const [combinedTick, setCombinedTick]   = useState(0);
  const [trafficTick,  setTrafficTick]    = useState(0);
  const [resourcesTick, setResourcesTick] = useState(0);

  useEffect(() => {
    const combinedMs  = isGlobal ? 120_000 : 60_000;
    const trafficMs   = isGlobal ? 300_000 : 120_000;
    const resourcesMs = 300_000;
    const t1 = window.setInterval(() => setCombinedTick((v) => v + 1),  combinedMs);
    const t2 = window.setInterval(() => setTrafficTick((v)  => v + 1),  trafficMs);
    const t3 = window.setInterval(() => setResourcesTick((v) => v + 1), resourcesMs);
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); };
  }, [isGlobal]);

  // Platform billing/activity — fetched once per scope change, no tick.
  const state = useAsyncResource(() => loadDashboardData(adminScope), [adminScope]);

  // ONE combined PBX call returns both summary + active calls.
  const pbxCombinedState = useAsyncResource<PbxLiveCombined | AdminPbxLiveCombined>(
    () => isGlobal ? loadAdminPbxLiveCombined() : loadPbxLiveCombined(),
    [adminScope, combinedTick]
  );

  // Call traffic chart — slower cadence, already server-cached.
  const trafficState = useAsyncResource<DashboardCallTraffic>(
    () => apiGet<DashboardCallTraffic>(`/dashboard/call-traffic?scope=${adminScope}&windowMinutes=1440`),
    [adminScope, trafficTick]
  );

  // Resource counts — slowest cadence; server-cached 120 s anyway.
  const pbxCountsState = useAsyncResource(
    async () => {
      if (isGlobal) return null;
      const safeCount = async (resource: string) => {
        try {
          const res = await apiGet<{ rows?: unknown[] }>(`/voice/pbx/resources/${resource}`);
          return Array.isArray(res?.rows) ? res.rows.length : 0;
        } catch { return null; }
      };
      const [extensions, trunks, queues] = await Promise.all([
        safeCount("extensions"),
        safeCount("trunks"),
        safeCount("queues")
      ]);
      return { extensions, trunks, queues };
    },
    [adminScope, resourcesTick]
  );

  const data        = state.status === "success" ? state.data : null;
  const activity    = data?.activity || [];
  const scopeLabel  = data?.scopeLabel || (adminScope as "GLOBAL" | "TENANT");

  const combined   = pbxCombinedState.status === "success" ? pbxCombinedState.data : null;
  const pbxLive    = combined?.summary ?? null;
  const activeCalls = combined?.activeCalls ?? null;
  const traffic    = trafficState.status === "success" ? trafficState.data : null;
  const pbxCounts  = pbxCountsState.status === "success" ? pbxCountsState.data : null;

  const isAdminSummary = (s: PbxLiveSummary | AdminPbxLiveSummary | null): s is AdminPbxLiveSummary =>
    s !== null && "totalCallsToday" in s;

  const callsToday = isAdminSummary(pbxLive) ? pbxLive.totalCallsToday : pbxLive?.callsToday ?? null;
  const incomingToday = isAdminSummary(pbxLive) ? pbxLive.incomingToday : pbxLive?.incomingToday ?? null;
  const outgoingToday = isAdminSummary(pbxLive) ? pbxLive.outgoingToday : pbxLive?.outgoingToday ?? null;
  const internalToday = isAdminSummary(pbxLive) ? pbxLive.internalToday : pbxLive?.internalToday ?? null;
  const answeredToday = isAdminSummary(pbxLive) ? pbxLive.answeredToday : pbxLive?.answeredToday ?? null;
  const activeCallCount = isAdminSummary(pbxLive) ? pbxLive.totalActiveCalls : pbxLive?.activeCalls ?? null;
  const activeCallsSource = isAdminSummary(pbxLive) ? "global" : pbxLive?.activeCallsSource ?? null;

  const peak = Math.max(1, ...(traffic?.points || []).map((p) => Math.max(p.incoming, p.outgoing, p.internal)));

  const kpiTiles = [
    { label: "Calls Today", value: callsToday !== null ? String(callsToday) : "--", meta: answeredToday !== null ? `${answeredToday} answered` : "CDR data" },
    { label: "Incoming", value: incomingToday !== null ? String(incomingToday) : "--", meta: "Inbound today" },
    { label: "Outgoing", value: outgoingToday !== null ? String(outgoingToday) : "--", meta: "Outbound today" },
    { label: "Internal", value: internalToday !== null ? String(internalToday) : "--", meta: "Extension-to-extension" },
    { label: "Active Calls", value: activeCallCount !== null ? String(activeCallCount) : "--", meta: activeCallsSource === "ari" ? "Live via ARI" : "ARI not configured" },
    ...(isGlobal && isAdminSummary(pbxLive) ? [{ label: "Active Tenants", value: String(pbxLive.activeTenantsCount), meta: "With calls today" }] : [])
  ];

  return (
    <PermissionGate permission="can_view_dashboard" fallback={<div className="state-box">You do not have dashboard access.</div>}>
      <div className="stack compact-stack">
        <PageHeader
          title="Operations Dashboard"
          subtitle={`Live PBX call metrics and platform health (${scopeLabel.toLowerCase()} scope). Refreshes every ${isGlobal ? "2 min" : "60 s"}.`}
          badges={<ScopeBadge scope={scopeLabel} />}
          actions={<QRPairingModal />}
        />

        {isGlobal ? <GlobalScopeNotice /> : null}
        {pbxCombinedState.status === "loading" ? <LoadingSkeleton rows={1} /> : null}
        {pbxCombinedState.status === "error" ? (
          <ErrorState message="PBX live metrics unavailable — check PBX link configuration." />
        ) : null}

        <section className="dashboard-top-tiles">
          {kpiTiles.map((tile) => (
            <MetricCard key={tile.label} label={tile.label} value={tile.value} meta={tile.meta} />
          ))}
        </section>

        <section className="dashboard-main-grid">
          <DetailCard title="Call Traffic Today (24h)">
            {trafficState.status === "error" ? (
              <ErrorState message="Call traffic data unavailable." />
            ) : !traffic || traffic.points.length === 0 ? (
              <EmptyState title="No call traffic yet today" message="As calls complete, they appear here from the PBX CDR." />
            ) : (
              <div className="live-traffic-graph">
                {traffic.points.map((bucket) => (
                  <div key={bucket.label} className="live-traffic-col">
                    <div className="live-traffic-bars">
                      <span className="live-bar incoming" style={{ height: `${Math.max(2, (bucket.incoming / peak) * 68)}px` }} title={`Incoming: ${bucket.incoming}`} />
                      <span className="live-bar outgoing" style={{ height: `${Math.max(2, (bucket.outgoing / peak) * 68)}px` }} title={`Outgoing: ${bucket.outgoing}`} />
                      <span className="live-bar internal" style={{ height: `${Math.max(2, (bucket.internal / peak) * 68)}px` }} title={`Internal: ${bucket.internal}`} />
                    </div>
                    <span className="live-traffic-time">{bucket.label}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="row-wrap">
              <span className="chip success">Incoming: {traffic?.totals?.incoming ?? "--"}</span>
              <span className="chip warning">Outgoing: {traffic?.totals?.outgoing ?? "--"}</span>
              <span className="chip info">Internal: {traffic?.totals?.internal ?? "--"}</span>
              <span className="chip neutral">Updated: {trafficState.status === "success" ? "Live (15s)" : "--"}</span>
            </div>
          </DetailCard>

          <div className="dashboard-side-stack">
            {[
              { label: "Extensions", value: pbxCounts?.extensions ?? null },
              { label: "Trunks", value: pbxCounts?.trunks ?? null },
              { label: "Queues", value: pbxCounts?.queues ?? null }
            ].map((item) => (
              <article key={item.label} className="dashboard-side-card">
                <div className="dashboard-side-title">{item.label}</div>
                <div className="dashboard-side-value">{item.value === null ? "--" : String(item.value)}</div>
              </article>
            ))}
          </div>
        </section>

        <DetailCard title={`Active Calls Now${activeCallCount !== null ? ` (${activeCallCount})` : ""}`}>
          {pbxCombinedState.status === "loading" ? (
            <LoadingSkeleton rows={1} />
          ) : activeCalls?.calls && activeCalls.calls.length > 0 ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>Caller</th>
                  <th>Callee</th>
                  <th>Duration</th>
                  <th>State</th>
                  {isGlobal ? <th>Tenant</th> : null}
                </tr>
              </thead>
              <tbody>
                {activeCalls.calls.map((call) => (
                  <tr key={call.channelId}>
                    <td><span className={`chip ${directionClass(call.direction)}`}>{directionLabel(call.direction)}</span></td>
                    <td className="mono">{call.caller || "—"}</td>
                    <td className="mono">{call.callee || "—"}</td>
                    <td className="mono">{formatDurationSec(call.durationSeconds)}</td>
                    <td><span className="chip info">{call.state}</span></td>
                    {isGlobal ? <td className="muted">{call.tenantId || "—"}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : activeCalls?.source === "unavailable" ? (
            <EmptyState
              title="Active calls not available"
              message="Real-time active calls require Asterisk ARI. Set PBX_ARI_USER and PBX_ARI_PASS to enable. CDR metrics above are always real."
            />
          ) : (
            <EmptyState title="No active calls right now" message="All channels are idle." />
          )}
        </DetailCard>

        {isGlobal && isAdminSummary(pbxLive) && pbxLive.topTenants.length > 0 ? (
          <DetailCard title="Top Tenants by Call Volume Today">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tenant ID</th>
                  <th>Calls Today</th>
                  <th>Incoming</th>
                  <th>Outgoing</th>
                  <th>Active Now</th>
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
          </DetailCard>
        ) : null}

        <DetailCard title="Recent Activity">
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
            <DetailCard title="Quick Actions">
              <div className="row-actions">
                <ScopedActionButton className="btn ghost">Create Extension</ScopedActionButton>
                <ScopedActionButton className="btn ghost">Create Campaign</ScopedActionButton>
                <ScopedActionButton className="btn ghost" allowInGlobal>Create Invoice</ScopedActionButton>
                <ScopedActionButton className="btn ghost">Add Customer</ScopedActionButton>
              </div>
            </DetailCard>
            <DetailCard title="PBX Navigation">
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
