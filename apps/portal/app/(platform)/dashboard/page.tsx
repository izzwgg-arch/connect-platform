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
import { getPreferredUserDisplayName } from "../../../lib/userDisplayName";
import {
  buildDashboardDevPreviewCalls,
  buildDashboardDevPreviewCommunications,
  buildDashboardDevPreviewTraffic,
  DASHBOARD_DEV_PREVIEW_IVR,
} from "../../../components/dashboard/devPreviewData";

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

// ⛔ This screen used to resolve the greeting itself, off user.name + user.email
// only — it never looked at the extension, so 55 of 65 customers were greeted by
// the front half of their email address ("Welcome, 845luzerj") while the sidebar
// beside it showed their real name. Use the shared helper; the PBX name is the
// source of truth. Do NOT take the first word off it — that turns "Front Desk"
// into "Front" and "Mrs. Halpert" into "Mrs.".

const IS_DEV_PREVIEW_ENABLED = process.env.NODE_ENV === "development";

function hasTrafficData(data: TrafficData | null): boolean {
  if (!data) return false;
  if ((data.totals?.total ?? 0) > 0) return true;
  return (data.points ?? []).some((point) =>
    (point.incoming ?? 0) + (point.outgoing ?? 0) + (point.internal ?? 0) + (point.missed ?? 0) + (point.canceled ?? 0) > 0,
  );
}

function hasCommunicationsData(data: CommunicationsData | null): boolean {
  if (!data) return false;
  return (
    (data.voicemails?.unread ?? 0) > 0 ||
    (data.messages?.unread ?? 0) > 0 ||
    (data.voicemails?.recent?.length ?? 0) > 0 ||
    (data.messages?.recent?.length ?? 0) > 0
  );
}

function hasIvrData(data: IvrAnalyticsData | null): boolean {
  if (!data) return false;
  const totals = data.totals;
  return (
    (totals?.ivrCalls ?? 0) > 0 ||
    (totals?.optionsPressed ?? 0) > 0 ||
    (totals?.timeouts ?? 0) > 0 ||
    (totals?.invalidEntries ?? 0) > 0 ||
    (data.topOptions?.length ?? 0) > 0
  );
}

export default function DashboardPage() {
  const { adminScope, tenantId: contextTenantId, tenant, user, role } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const isAdmin = role === "TENANT_ADMIN" || role === "SUPER_ADMIN";
  const telephony = useTelephony();

  // Date range filter state — controls the volume chart, KPIs, and IVR analytics.
  // Active Calls and Communications are always "now" (live state, not date-windowed).
  const [range, setRange] = useState<DateRangeValue>({ key: "7d" });
  const previewNow = useMemo(() => Date.now(), []);

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
  const usingTrafficPreview =
    IS_DEV_PREVIEW_ENABLED &&
    !trafficLoading &&
    !hasTrafficData(trafficData);
  const displayTrafficData = useMemo(
    () => usingTrafficPreview ? buildDashboardDevPreviewTraffic(range, previewNow) : trafficData,
    [previewNow, range, trafficData, usingTrafficPreview],
  );

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
    const t = displayTrafficData?.totals;
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
  }, [displayTrafficData, kpis]);

  // Communications — per-user, no range
  const commState = useAsyncResource<CommunicationsData>(
    () => apiGet<CommunicationsData>("/dashboard/communications"),
    [commTick],
  );
  const commData = commState.status === "success" ? commState.data : null;
  const commLoading = commState.status === "loading";
  const usingCommunicationsPreview =
    IS_DEV_PREVIEW_ENABLED &&
    !commLoading &&
    !hasCommunicationsData(commData);
  const displayCommData = useMemo(
    () => usingCommunicationsPreview ? buildDashboardDevPreviewCommunications(previewNow) : commData,
    [commData, previewNow, usingCommunicationsPreview],
  );

  // IVR analytics — admin only, date-range aware
  const ivrQuery = useMemo(() => buildIvrQuery(range, isGlobal, contextTenantId), [range, isGlobal, contextTenantId]);
  const ivrState = useAsyncResource<IvrAnalyticsData>(
    () => isAdmin ? apiGet<IvrAnalyticsData>(`/dashboard/ivr-analytics${ivrQuery}`) : Promise.resolve(null as any),
    [isAdmin, ivrQuery, kpiTick],
  );
  const ivrData = isAdmin && ivrState.status === "success" ? ivrState.data : null;
  const ivrLoading = isAdmin && ivrState.status === "loading";
  const usingIvrPreview =
    IS_DEV_PREVIEW_ENABLED &&
    isAdmin &&
    !ivrLoading &&
    !hasIvrData(ivrData);
  const displayIvrData = usingIvrPreview ? DASHBOARD_DEV_PREVIEW_IVR : ivrData;

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
  const usingActiveCallsPreview = IS_DEV_PREVIEW_ENABLED && liveCalls.length === 0;
  const displayLiveCalls = useMemo(
    () => usingActiveCallsPreview ? buildDashboardDevPreviewCalls(isGlobal ? null : contextTenantId, tenant?.name, previewNow) : liveCalls,
    [contextTenantId, isGlobal, liveCalls, previewNow, tenant?.name, usingActiveCallsPreview],
  );
  const showTenantBadge = useMemo(() => {
    if (isGlobal) return true;
    const tenantKeys = new Set(
      displayLiveCalls.map((call) => call.tenantId || call.tenantSlug || call.tenantName || "__unknown__"),
    );
    return tenantKeys.size > 1;
  }, [displayLiveCalls, isGlobal]);

  const greetingName = getPreferredUserDisplayName(user) || "there";
  const usingDevPreview =
    usingTrafficPreview ||
    usingCommunicationsPreview ||
    usingIvrPreview ||
    usingActiveCallsPreview;

  return (
    <PermissionGate permission="can_view_dashboard" fallback={<div className="state-box">You do not have dashboard access.</div>}>
      <div className="dash-v2-shell workspace-overview">
        {/* Header */}
        <header className="dash-v2-header">
          <div className="dash-v2-header-text">
            <h1 className="dash-v2-title">Welcome, {greetingName}</h1>
            <p className="dash-v2-subtitle">
              {tenant?.name ? `${tenant.name} · ` : ""}Here's what's happening right now.
              {usingDevPreview ? (
                <span className="ml-2 rounded-full border border-crm-border/60 bg-crm-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-crm-muted">
                  Dev preview data
                </span>
              ) : null}
            </p>
          </div>
          <DateRangeFilter value={range} onChange={setRange} />
        </header>

        {/* 1. Hourly call volume chart — top */}
        <CallVolumeChart data={displayTrafficData} loading={trafficLoading && !usingTrafficPreview} rangeKey={range.key} />

        {/* 2. Call activity (5 metrics) */}
        <CallActivityRow
          totals={callTotals}
          loading={kpiLoading && trafficLoading}
        />

        {/* 3. Active calls — live, below metrics (gated by can_view_live_calls) */}
        <PermissionGate permission="can_view_live_calls" fallback={null}>
          <ActiveCallsPanel calls={displayLiveCalls} isLive={telephony.isLive || usingActiveCallsPreview} showTenantBadge={showTenantBadge} />
        </PermissionGate>

        {/* 4. Communications — voicemail + messages */}
        <CommunicationsRow data={displayCommData} loading={commLoading && !usingCommunicationsPreview} />

        {/* 5. IVR analytics — admin only */}
        {isAdmin ? <IvrAnalyticsCard data={displayIvrData} loading={ivrLoading && !usingIvrPreview} /> : null}
      </div>
    </PermissionGate>
  );
}
