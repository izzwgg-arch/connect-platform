"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DetailCard } from "../../../components/DetailCard";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { MetricCard } from "../../../components/MetricCard";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { useTelephony } from "../../../contexts/TelephonyContext";
import { loadPbxResource } from "../../../services/pbxData";
import { callsForTenant } from "../../../services/liveCallState";
import type { LiveCall } from "../../../types/liveCall";
import { loadPbxLiveCombined, formatDurationSec, type PbxLiveCombined } from "../../../services/pbxLive";

// LiveCall direction labels (the WS feed uses inbound/outbound/internal — the
// old HTTP payload used incoming/outgoing, so pbxLive's helpers don't apply).
function liveDirectionLabel(d: LiveCall["direction"]): string {
  if (d === "inbound") return "Incoming";
  if (d === "outbound") return "Outgoing";
  if (d === "internal") return "Internal";
  return "Call";
}

function liveDirectionClass(d: LiveCall["direction"]): string {
  if (d === "inbound") return "success";
  if (d === "outbound") return "info";
  return "neutral";
}

function liveDurationSec(call: LiveCall, nowMs: number): number {
  const ref = call.answeredAt || call.startedAt;
  const refMs = ref ? new Date(ref).getTime() : NaN;
  if (!Number.isFinite(refMs)) return call.durationSec ?? 0;
  return Math.max(0, Math.floor((nowMs - refMs) / 1000));
}

export default function PbxOverviewPage() {
  const { adminScope, tenantId: contextTenantId, tenant } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";

  // ── Active Calls: live WS feed (2026-08-31) ─────────────────────────────
  // This table used to render from the 60s-polled HTTP combined payload (plus
  // a ~30s server cache), so a hung-up call could sit on screen for well over
  // a minute. It now rides the same push feed as the dashboard and Team
  // Directory: a hangup's `telephony.call.remove` clears the row the moment
  // the PBX reports it. The HTTP poll below survives ONLY for the CDR "today"
  // metrics and endpoint registration counts — never for active calls.
  const telephony = useTelephony();
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
  // 1s duration tick — render-only, runs only while calls are on screen.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (liveCalls.length === 0) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [liveCalls.length > 0]);

  // Single combined tick — one HTTP call per interval; API caches combined payload ~30 s (see server PBX_LIVE_*).
  const [combinedTick, setCombinedTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setCombinedTick((v) => v + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const combinedState = useAsyncResource<PbxLiveCombined>(
    () => loadPbxLiveCombined(),
    [adminScope, combinedTick]
  );

  const combined    = combinedState.status === "success" ? combinedState.data : null;
  const summary     = combined?.summary ?? null;

  const answerRate = summary && summary.callsToday > 0
    ? Math.round((summary.answeredToday / summary.callsToday) * 100)
    : null;

  const hasAri = summary?.activeCallsSource === "ari" || summary?.activeCallsSource === "telephony_redis";
  const regCount = summary?.registeredEndpoints;
  const unregCount = summary?.unregisteredEndpoints;

  const kpiTiles = [
    { label: "Active Calls",   value: String(liveCalls.length),                                                   meta: telephony.isLive ? "Live — updates instantly" : "Connecting to live feed…" },
    { label: "Calls Today",    value: summary?.callsToday !== undefined ? String(summary.callsToday) : "--",       meta: "Completed calls (CDR)" },
    { label: "Incoming",       value: summary?.incomingToday !== undefined ? String(summary.incomingToday) : "--", meta: "Inbound today" },
    { label: "Outgoing",       value: summary?.outgoingToday !== undefined ? String(summary.outgoingToday) : "--", meta: "Outbound today" },
    { label: "Internal",       value: summary?.internalToday !== undefined ? String(summary.internalToday) : "--", meta: "Extension-to-extension" },
    { label: "Answer Rate",    value: answerRate !== null ? `${answerRate}%` : "--",                               meta: `${summary?.missedToday ?? "--"} missed` },
    { label: "Registered",     value: regCount !== null && regCount !== undefined ? String(regCount) : "--",       meta: hasAri ? "P/SIP endpoints online" : "ARI not configured" },
    { label: "Unregistered",   value: unregCount !== null && unregCount !== undefined ? String(unregCount) : "--", meta: hasAri ? "P/SIP endpoints offline" : "ARI not configured" }
  ];

  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have PBX access.</div>}>
      <div className="stack compact-stack">
        <PageHeader
          title="PBX Operations"
          subtitle="Live call activity (instant), today's metrics, and registered endpoint status (refreshed every 60 seconds)."
        />

        {combinedState.status === "loading" ? <LoadingSkeleton rows={1} /> : null}
        {combinedState.status === "error" ? (
          <ErrorState message="PBX metrics unavailable — check PBX link configuration." />
        ) : null}

        <section className="dashboard-top-tiles">
          {kpiTiles.map((tile) => (
            <MetricCard key={tile.label} label={tile.label} value={tile.value} meta={tile.meta} />
          ))}
        </section>

        <DetailCard title={`Active Calls (${liveCalls.length})`}>
          {liveCalls.length > 0 ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>Caller</th>
                  <th>Callee / Ext</th>
                  <th>Duration</th>
                  <th>State</th>
                  <th>Queue</th>
                </tr>
              </thead>
              <tbody>
                {liveCalls.map((call) => (
                  <tr key={call.id}>
                    <td><span className={`chip ${liveDirectionClass(call.direction)}`}>{liveDirectionLabel(call.direction)}</span></td>
                    <td className="mono">{call.fromName || call.from || "—"}</td>
                    <td className="mono">{call.to || (call.extensions ?? []).join(", ") || "—"}</td>
                    <td className="mono">{formatDurationSec(liveDurationSec(call, nowMs))}</td>
                    <td><span className="chip info">{call.state}</span></td>
                    <td className="muted">{call.queueId || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : telephony.isLive ? (
            <EmptyState title="No active calls" message="All channels are idle right now." />
          ) : (
            <EmptyState
              title="Connecting to the live call feed…"
              message="Live calls appear here the moment the connection is up. If this doesn't clear, the telephony service may be unreachable."
            />
          )}
          <div className="row-wrap" style={{ marginTop: "0.5rem" }}>
            <span className="chip neutral">
              Source: live telephony feed{telephony.isLive ? "" : " (reconnecting)"}
            </span>
            <span className="chip neutral">
              Updates: instant on hangup
            </span>
          </div>
        </DetailCard>

        <section className="grid three">
          <DetailCard title="Core Voice">
            <div className="row-actions">
              <Link className="btn ghost" href="/pbx/extensions">Extensions</Link>
              <Link className="btn ghost" href="/pbx/queues">Queues</Link>
              <Link className="btn ghost" href="/pbx/ring-groups">Ring Groups</Link>
              <Link className="btn ghost" href="/pbx/ivr">IVR</Link>
            </div>
          </DetailCard>
          <DetailCard title="Routing">
            <div className="row-actions">
              <Link className="btn ghost" href="/pbx/trunks">Trunks</Link>
              <Link className="btn ghost" href="/pbx/inbound-routes">Inbound Routes</Link>
              <Link className="btn ghost" href="/pbx/outbound-routes">Outbound Routes</Link>
              <Link className="btn ghost" href="/pbx/time-conditions">Time Conditions</Link>
            </div>
          </DetailCard>
          <DetailCard title="Operations">
            <div className="row-actions">
              <Link className="btn ghost" href="/pbx/softphone">WebRTC Softphone</Link>
              <Link className="btn ghost" href="/pbx/provisioning">Provisioning</Link>
              <Link className="btn ghost" href="/pbx/sbc-connectivity">SBC Connectivity</Link>
              <Link className="btn ghost" href="/pbx/call-recordings">Recordings</Link>
            </div>
          </DetailCard>
        </section>

        <section className="grid two">
          <DetailCard title="Reports">
            <div className="row-actions">
              <Link className="btn ghost" href="/pbx/call-reports">Call Reports (CDR)</Link>
              <Link className="btn ghost" href="/pbx/call-recordings">Call Recordings</Link>
              <Link className="btn ghost" href="/reports">Reports Overview</Link>
              <Link className="btn ghost" href="/reports/cdr">CDR Analysis</Link>
            </div>
          </DetailCard>
          <DetailCard title="Status">
            <ul className="list">
              <li>CDR data: completed calls, written at hangup</li>
              <li>Active calls: live push feed — appears and clears instantly</li>
              <li>Today's metrics refresh every 60 seconds</li>
              <li>Tenant scope: your tenant only</li>
            </ul>
          </DetailCard>
        </section>
      </div>
    </PermissionGate>
  );
}
