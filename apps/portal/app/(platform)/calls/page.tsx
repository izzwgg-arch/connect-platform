"use client";

import { DataTable } from "../../../components/DataTable";
import { DetailCard } from "../../../components/DetailCard";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { GlobalScopeNotice } from "../../../components/GlobalScopeNotice";
import { LiveBadge } from "../../../components/LiveBadge";
import { LiveCallBadge } from "../../../components/LiveCallBadge";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { ScopeBadge } from "../../../components/ScopeBadge";
import { StatusChip } from "../../../components/StatusChip";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { useTelephony } from "../../../contexts/TelephonyContext";
import { loadCallsData } from "../../../services/platformData";
import { formatDurationSec, directionLabel, directionClass } from "../../../services/pbxLive";

export default function CallsPage() {
  const { adminScope } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const telephony = useTelephony();
  const tenantId = typeof window !== "undefined" ? localStorage.getItem("cc-tenant-id") : null;
  const liveCalls = telephony.callsByTenant(isGlobal ? null : tenantId);

  const state = useAsyncResource(() => loadCallsData(adminScope), [adminScope]);

  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have calls access.</div>}>
      <div className="stack">
        <PageHeader
          title="Calls Console"
          subtitle={`Live operational visibility and historical records (${isGlobal ? "global" : "tenant"} scope).`}
          badges={<><ScopeBadge scope={isGlobal ? "GLOBAL" : "TENANT"} /><LiveBadge status={telephony.status} /></>}
        />
        {isGlobal ? <GlobalScopeNotice /> : null}

        {/* ── Live calls — prefer WebSocket; fall back to polled data ─────── */}
        <DetailCard title={`Live Calls${liveCalls.length > 0 ? ` (${liveCalls.length})` : ""}`}>
          {telephony.isLive ? (
            liveCalls.length === 0 ? (
              <EmptyState title="No live calls" message="All channels are idle." />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Direction</th>
                    <th>From</th>
                    <th>To</th>
                    <th>State</th>
                    <th>Duration</th>
                    {liveCalls.some((c) => c.extensions.length > 0) ? <th>Extension</th> : null}
                    {liveCalls.some((c) => c.queueId) ? <th>Queue</th> : null}
                    {isGlobal ? <th>Tenant</th> : null}
                    <th>Live</th>
                  </tr>
                </thead>
                <tbody>
                  {liveCalls.map((call) => {
                    const dir = call.direction === "inbound" ? "incoming"
                      : call.direction === "outbound" ? "outgoing"
                      : "internal";
                    const elapsed = call.answeredAt
                      ? Math.floor((Date.now() - new Date(call.answeredAt).getTime()) / 1000)
                      : Math.floor((Date.now() - new Date(call.startedAt).getTime()) / 1000);
                    return (
                      <tr key={call.id}>
                        <td>
                          <span className={`chip ${directionClass(dir)}`}>{directionLabel(dir)}</span>
                        </td>
                        <td className="mono">{call.from || "—"}</td>
                        <td className="mono">{call.to || "—"}</td>
                        <td>
                          <span className="chip info">{call.state}</span>
                        </td>
                        <td className="mono">{formatDurationSec(elapsed)}</td>
                        {liveCalls.some((c) => c.extensions.length > 0) ? (
                          <td className="muted">{call.extensions.join(", ") || "—"}</td>
                        ) : null}
                        {liveCalls.some((c) => c.queueId) ? (
                          <td className="muted">{call.queueId || "—"}</td>
                        ) : null}
                        {isGlobal ? <td className="muted">{call.tenantId || "—"}</td> : null}
                        <td>
                          <LiveCallBadge active={true} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          ) : state.status === "loading" ? (
            <LoadingSkeleton rows={3} />
          ) : state.status === "error" ? (
            <ErrorState message="Could not load live calls. Configure NEXT_PUBLIC_TELEPHONY_WS_URL for real-time data." />
          ) : (state.data?.live ?? []).length === 0 ? (
            <EmptyState title="No live calls" message="Active tenant calls appear here in real time." />
          ) : (
            <DataTable
              rows={state.data!.live}
              columns={[
                { key: "ext", label: "Extension", render: (r) => r.extension },
                { key: "dir", label: "Direction", render: (r) => r.direction },
                { key: "caller", label: "Caller", render: (r) => r.caller },
                { key: "dur", label: "Duration", render: (r) => r.duration },
                { key: "state", label: "Status", render: (r) => <StatusChip tone="info" label={r.state} /> },
                { key: "live", label: "Live", render: () => <LiveCallBadge active={true} /> },
              ]}
            />
          )}
        </DetailCard>

        {/* ── Extension presence (WebSocket only) ─────────────────────────── */}
        {telephony.isLive && telephony.extensionList.length > 0 ? (
          <DetailCard title={`Extension Presence (${telephony.extensionList.length})`}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Extension</th>
                  <th>Status</th>
                  {isGlobal ? <th>Tenant</th> : null}
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {telephony.extensionList.map((ext) => (
                  <tr key={ext.extension}>
                    <td className="mono">{ext.extension}</td>
                    <td>
                      <span
                        className={`chip ${
                          ext.status === "idle" ? "success"
                          : ext.status === "inuse" || ext.status === "busy" ? "danger"
                          : ext.status === "ringing" ? "warning"
                          : ext.status === "unavailable" ? "neutral"
                          : "info"
                        }`}
                      >
                        {ext.status}
                      </span>
                    </td>
                    {isGlobal ? <td className="muted">{ext.tenantId || "—"}</td> : null}
                    <td className="muted">
                      {new Date(ext.updatedAt).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DetailCard>
        ) : null}

        {/* ── Queue state (WebSocket only) ─────────────────────────────────── */}
        {telephony.isLive && telephony.queueList.length > 0 ? (
          <DetailCard title={`Queue State (${telephony.queueList.length})`}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Queue</th>
                  <th>Callers Waiting</th>
                  <th>Members</th>
                  {isGlobal ? <th>Tenant</th> : null}
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {telephony.queueList.map((q) => (
                  <tr key={q.queueName}>
                    <td className="mono">{q.queueName}</td>
                    <td>
                      <span className={`chip ${q.callerCount > 0 ? "warning" : "success"}`}>
                        {q.callerCount}
                      </span>
                    </td>
                    <td>{q.memberCount}</td>
                    {isGlobal ? <td className="muted">{q.tenantId || "—"}</td> : null}
                    <td className="muted">
                      {new Date(q.updatedAt).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DetailCard>
        ) : null}

        {/* ── Call history ─────────────────────────────────────────────────── */}
        <DetailCard title="Call History">
          {state.status === "loading" ? (
            <LoadingSkeleton rows={5} />
          ) : state.status === "error" ? (
            <ErrorState message={state.error} />
          ) : (state.data?.history ?? []).length === 0 ? (
            <EmptyState title="No call history" message="Historical call records will populate once CDR sync runs." />
          ) : (
            <DataTable
              rows={state.data!.history}
              columns={[
                { key: "when", label: "Time", render: (r) => r.when },
                { key: "ext", label: "Extension", render: (r) => r.ext },
                { key: "dir", label: "Direction", render: (r) => r.direction },
                { key: "num", label: "Number", render: (r) => r.number },
                {
                  key: "disp",
                  label: "Disposition",
                  render: (r) => (
                    <StatusChip
                      tone={r.disposition === "Answered" ? "success" : "warning"}
                      label={r.disposition}
                    />
                  ),
                },
                {
                  key: "rec",
                  label: "Recording",
                  render: (r) => r.recording
                    ? <a className="btn ghost" style={{ fontSize: 12 }} href={`/pbx/call-recordings?callId=${r.id}`}>Play</a>
                    : <span className="muted" style={{ fontSize: 12 }}>—</span>,
                },
              ]}
            />
          )}
        </DetailCard>
      </div>
    </PermissionGate>
  );
}
