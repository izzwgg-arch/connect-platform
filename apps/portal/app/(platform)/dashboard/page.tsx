"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../../../services/apiClient";
import { PermissionGate } from "../../../components/PermissionGate";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { useTelephony } from "../../../contexts/TelephonyContext";
import { loadPbxResource } from "../../../services/pbxData";
import { callsForTenant } from "../../../services/liveCallState";
import { DateRangeFilter, type DateRangeValue } from "../../../components/DateRangeFilter";
import { CallVolumeChart, type TrafficData } from "../../../components/dashboard/CallVolumeChart";
import { ActiveCallsPanel } from "../../../components/dashboard/ActiveCallsPanel";
import { CallActivityRow } from "../../../components/dashboard/CallActivityRow";
import { CommunicationsRow, type CommunicationsData } from "../../../components/dashboard/CommunicationsRow";
import { IvrAnalyticsCard, type IvrAnalyticsData } from "../../../components/dashboard/IvrAnalyticsCard";

type ConnectKpis = {
  incomingToday: number;
  outgoingToday: number;
  internalToday: number;
  missedToday: number;
  canceledToday?: number;
  callsToday?: number;
  scope: "global" | "tenant";
  asOf: string;
};

function buildKpiQuery(range: DateRangeValue, isGlobal: boolean, contextTenantId: string | null): string {
  const params = new URLSearchParams({ source: "connect", mode: "canonical", range: range.key });
  if (range.key === "custom") {
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
  }
  if (!isGlobal && contextTenantId) params.set("tenantId", contextTenantId);
  return `?${params.toString()}`;
}

function buildTrafficQuery(range: DateRangeValue, isGlobal: boolean, contextTenantId: string | null): string {
  const params = new URLSearchParams({ scope: isGlobal ? "GLOBAL" : "TENANT", range: range.key });
  if (range.key === "custom") {
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
  }
  if (!isGlobal && contextTenantId) params.set("tenantId", contextTenantId);
  return `?${params.toString()}`;
}

function buildIvrQuery(range: DateRangeValue, isGlobal: boolean, contextTenantId: string | null): string {
  const params = new URLSearchParams({ range: range.key });
  if (range.key === "custom") {
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
  }
  if (!isGlobal && contextTenantId) params.set("tenantId", contextTenantId);
  return `?${params.toString()}`;
}

function firstName(name: string | null | undefined, email: string | null | undefined): string {
  const raw = (name || "").trim();
  if (raw && !raw.includes("@")) return raw.split(/\s+/)[0] || raw;
  const emailLocal = (email || "").split("@")[0] || "";
  if (emailLocal) return emailLocal.split(/[._-]/)[0] || emailLocal;
  return "there";
}

export default function DashboardPage() {
  const { adminScope, tenantId: contextTenantId, tenant, user, role } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const isAdmin = role === "TENANT_ADMIN" || role === "SUPER_ADMIN";
  const telephony = useTelephony();

  // Date range filter state — controls the volume chart, KPIs, and IVR analytics.
  // Active Calls and Communications are always "now" (live state, not date-windowed).
  const [range, setRange] = useState<DateRangeValue>({ key: "7d" });

  // Refresh ticks
  const [kpiTick, setKpiTick] = useState(0);
  const [trafficTick, setTrafficTick] = useState(0);
  const [commTick, setCommTick] = useState(0);
  useEffect(() => {
    const t1 = window.setInterval(() => setKpiTick((v) => v + 1), 30_000);
    const t2 = window.setInterval(() => setTrafficTick((v) => v + 1), 60_000);
    const t3 = window.setInterval(() => setCommTick((v) => v + 1), 60_000);
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); };
  }, []);

  // Traffic (volume chart) — date-range aware
  const trafficQuery = useMemo(() => buildTrafficQuery(range, isGlobal, contextTenantId), [range, isGlobal, contextTenantId]);
  const trafficState = useAsyncResource<TrafficData>(
    () => apiGet<TrafficData>(`/dashboard/call-traffic${trafficQuery}`),
    [trafficQuery, trafficTick],
  );
  const trafficData = trafficState.status === "success" ? trafficState.data : null;
  const trafficLoading = trafficState.status === "loading";

  // KPI fetch — date-range aware (Connect canonical totals)
  const kpiQuery = useMemo(() => buildKpiQuery(range, isGlobal, contextTenantId), [range, isGlobal, contextTenantId]);
  const kpiState = useAsyncResource<ConnectKpis>(
    () => apiGet<ConnectKpis>(`/dashboard/call-kpis${kpiQuery}`),
    [kpiQuery, kpiTick],
  );
  const kpis = kpiState.status === "success" ? kpiState.data : null;
  const kpiLoading = kpiState.status === "loading";

  // Prefer the (cheaper, already-aggregated) traffic totals when available so the
  // 5-card row stays in sync with the chart even if the KPI fetch is still in flight.
  const callTotals = useMemo(() => {
    const t = trafficData?.totals;
    if (t) {
      return {
        incoming: t.incoming ?? null,
        outgoing: t.outgoing ?? null,
        internal: t.internal ?? null,
        missed:   t.missed   ?? null,
        canceled: t.canceled ?? null,
      };
    }
    return {
      incoming: kpis?.incomingToday ?? null,
      outgoing: kpis?.outgoingToday ?? null,
      internal: kpis?.internalToday ?? null,
      missed:   kpis?.missedToday   ?? null,
      canceled: kpis?.canceledToday ?? null,
    };
  }, [trafficData, kpis]);

  // Communications — per-user, no range
  const commState = useAsyncResource<CommunicationsData>(
    () => apiGet<CommunicationsData>("/dashboard/communications"),
    [commTick],
  );
  const commData = commState.status === "success" ? commState.data : null;
  const commLoading = commState.status === "loading";

  // IVR analytics — admin only, date-range aware
  const ivrQuery = useMemo(() => buildIvrQuery(range, isGlobal, contextTenantId), [range, isGlobal, contextTenantId]);
  const ivrState = useAsyncResource<IvrAnalyticsData>(
    () => isAdmin ? apiGet<IvrAnalyticsData>(`/dashboard/ivr-analytics${ivrQuery}`) : Promise.resolve(null as any),
    [isAdmin, ivrQuery, kpiTick],
  );
  const ivrData = isAdmin && ivrState.status === "success" ? ivrState.data : null;
  const ivrLoading = isAdmin && ivrState.status === "loading";

  // Live calls (telephony WS, scoped to current tenant)
  const extState = useAsyncResource<{ rows: Record<string, unknown>[] }>(
    () => !isGlobal && contextTenantId ? loadPbxResource("extensions", contextTenantId) : Promise.resolve({ resource: "extensions", rows: [] }),
    [adminScope, contextTenantId, tenant?.name],
    { keepPreviousData: false },
  );
  const extensionRows = extState.status === "success" ? extState.data.rows : [];
  const liveCalls = useMemo(
    () => callsForTenant(telephony.activeCalls, isGlobal ? null : contextTenantId, extensionRows, tenant?.name),
    [contextTenantId, extensionRows, isGlobal, telephony.activeCalls, tenant?.name],
  );
  const showTenantBadge = useMemo(() => {
    if (isGlobal) return true;
    const tenantKeys = new Set(
      liveCalls.map((call) => call.tenantId || call.tenantSlug || call.tenantName || "__unknown__"),
    );
    return tenantKeys.size > 1;
  }, [isGlobal, liveCalls]);

  const greetingName = firstName(user.name, user.email);

  return (
    <PermissionGate permission="can_view_dashboard" fallback={<div className="state-box">You do not have dashboard access.</div>}>
      <div className="dash-v2-shell">
        {/* Header */}
        <header className="dash-v2-header">
          <div className="dash-v2-header-text">
            <h1 className="dash-v2-title">Welcome, {greetingName}</h1>
            <p className="dash-v2-subtitle">{tenant?.name ? `${tenant.name} · ` : ""}Here's what's happening right now.</p>
          </div>
          <DateRangeFilter value={range} onChange={setRange} />
        </header>

        {/* 1. Hourly call volume chart — top */}
        <CallVolumeChart data={trafficData} loading={trafficLoading} rangeKey={range.key} />

        {/* 2. Call activity (5 metrics) */}
        <CallActivityRow
          totals={callTotals}
          loading={kpiLoading && trafficLoading}
        />

        {/* 3. Active calls — live, below metrics */}
        <ActiveCallsPanel calls={liveCalls} isLive={telephony.isLive} showTenantBadge={showTenantBadge} />

        {/* 4. Communications — voicemail + messages */}
        <CommunicationsRow data={commData} loading={commLoading} />

        {/* 5. IVR analytics — admin only */}
        {isAdmin ? <IvrAnalyticsCard data={ivrData} loading={ivrLoading} /> : null}
      </div>
    </PermissionGate>
  );
}
