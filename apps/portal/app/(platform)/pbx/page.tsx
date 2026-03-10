"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DetailCard } from "../../../components/DetailCard";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { MetricCard } from "../../../components/MetricCard";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import {
  loadPbxLiveCombined,
  formatDurationSec,
  directionLabel,
  directionClass,
  type PbxLiveCombined
} from "../../../services/pbxLive";

export default function PbxOverviewPage() {
  const { adminScope } = useAppContext();

  // Single combined tick — one HTTP call per interval, server-cached 10 s.
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
  const activeCalls = combined?.activeCalls ?? null;

  const answerRate = summary && summary.callsToday > 0
    ? Math.round((summary.answeredToday / summary.callsToday) * 100)
    : null;

  const hasAri = summary?.activeCallsSource === "ari";
  const regCount = summary?.registeredEndpoints;
  const unregCount = summary?.unregisteredEndpoints;

  const kpiTiles = [
    { label: "Active Calls",   value: summary?.activeCalls !== undefined ? String(summary.activeCalls) : "--",    meta: hasAri ? "Live via ARI" : "ARI not configured" },
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
          subtitle="Live call activity, today's metrics, and registered endpoint status. Refreshes every 60 seconds."
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

        <DetailCard title={`Active Calls${activeCalls?.calls ? ` (${activeCalls.calls.length})` : ""}`}>
          {combinedState.status === "loading" ? (
            <LoadingSkeleton rows={2} />
          ) : activeCalls?.calls && activeCalls.calls.length > 0 ? (
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
                {activeCalls.calls.map((call) => (
                  <tr key={call.channelId}>
                    <td><span className={`chip ${directionClass(call.direction)}`}>{directionLabel(call.direction)}</span></td>
                    <td className="mono">{call.caller || "—"}</td>
                    <td className="mono">{call.callee || call.extension || "—"}</td>
                    <td className="mono">{formatDurationSec(call.durationSeconds)}</td>
                    <td><span className="chip info">{call.state}</span></td>
                    <td className="muted">{call.queue || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : activeCalls?.source === "unavailable" ? (
            <EmptyState
              title="Active call list not available"
              message="Real-time channel data requires Asterisk ARI. Set PBX_ARI_USER and PBX_ARI_PASS environment variables to enable live active call monitoring."
            />
          ) : (
            <EmptyState title="No active calls" message="All channels are idle right now." />
          )}
          <div className="row-wrap" style={{ marginTop: "0.5rem" }}>
            <span className="chip neutral">
              Source: {activeCalls?.source === "ari" ? "ARI (live)" : "Unavailable"}
            </span>
            <span className="chip neutral">
              Last updated: {activeCalls?.lastUpdatedAt ? new Date(activeCalls.lastUpdatedAt).toLocaleTimeString() : "--"}
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
              <li>Active calls: requires ARI (PBX_ARI_USER / PBX_ARI_PASS)</li>
              <li>Metrics update every 15 seconds</li>
              <li>Tenant scope: your tenant only</li>
            </ul>
          </DetailCard>
        </section>
      </div>
    </PermissionGate>
  );
}
