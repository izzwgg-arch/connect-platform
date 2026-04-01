"use client";

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
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { useTelephony } from "../../../contexts/TelephonyContext";
import { apiGet } from "../../../services/apiClient";
import { formatDurationSec, directionLabel, directionClass } from "../../../services/pbxLive";
import { ArrowDown, ArrowLeftRight, ArrowUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type CallDirection = "incoming" | "outgoing" | "internal";
type CallStatus = "answered" | "missed" | "canceled" | "failed";

type CallHistoryRow = {
  callId: string;
  rowId: string;
  linkedId: string;
  fromNumber: string;
  toNumber: string;
  direction: CallDirection;
  status: CallStatus;
  disposition: string;
  durationSec: number;
  startedAt: string;
  tenantId: string | null;
  tenantName: string;
};

type CallHistoryResponse = {
  items: CallHistoryRow[];
  total: number;
  showing: number;
  page: number;
  pageSize: number;
  totalPages: number;
  totalsByDirection: {
    incoming: number;
    outgoing: number;
    internal: number;
    total: number;
  };
};

type ConnectKpis = {
  incomingToday: number;
  outgoingToday: number;
  internalToday: number;
};

function todayDateInput(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toIsoRange(startDate: string, endDate: string): { startIso: string; endIso: string } {
  const s = new Date(`${startDate}T00:00:00`);
  const e = new Date(`${endDate}T00:00:00`);
  const end = new Date(e.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: s.toISOString(), endIso: end.toISOString() };
}

function formatDuration(durationSec: number): string {
  if (!durationSec || durationSec <= 0) return "—";
  const min = Math.floor(durationSec / 60);
  const sec = durationSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function relativeTimeFromNow(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(ms);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60_000) return rtf.format(-Math.round(ms / 1000), "second");
  if (abs < 3_600_000) return rtf.format(-Math.round(ms / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(-Math.round(ms / 3_600_000), "hour");
  return rtf.format(-Math.round(ms / 86_400_000), "day");
}

function DirectionIcon({ direction }: { direction: CallDirection }) {
  if (direction === "incoming") return <ArrowDown className="calls-dir-icon incoming" size={14} />;
  if (direction === "outgoing") return <ArrowUp className="calls-dir-icon outgoing" size={14} />;
  return <ArrowLeftRight className="calls-dir-icon internal" size={14} />;
}

export default function CallsPage() {
  const { adminScope, tenantId } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const telephony = useTelephony();
  const scopedTenantId = isGlobal ? null : tenantId;
  const liveCalls = telephony.callsByTenant(scopedTenantId);

  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [direction, setDirection] = useState<"all" | CallDirection>("all");
  const [status, setStatus] = useState<"all" | CallStatus>("all");
  const [startDate, setStartDate] = useState(todayDateInput());
  const [endDate, setEndDate] = useState(todayDateInput());
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchDraft.trim());
      setPage(1);
    }, 220);
    return () => clearTimeout(timer);
  }, [searchDraft]);

  useEffect(() => {
    setPage(1);
  }, [direction, status, startDate, endDate, adminScope, scopedTenantId]);

  const historyQuery = useMemo(() => {
    const { startIso, endIso } = toIsoRange(startDate, endDate);
    const params = new URLSearchParams({
      startDate: startIso,
      endDate: endIso,
      direction,
      status,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (search) params.set("search", search);
    if (scopedTenantId) params.set("tenantId", scopedTenantId);
    return params.toString();
  }, [direction, endDate, page, pageSize, scopedTenantId, search, startDate, status]);

  const historyState = useAsyncResource<CallHistoryResponse>(
    () => apiGet<CallHistoryResponse>(`/calls/history?${historyQuery}`),
    [historyQuery]
  );

  const kpiPath = useMemo(() => {
    const params = new URLSearchParams({ source: "connect" });
    if (!isGlobal && scopedTenantId) params.set("tenantId", scopedTenantId);
    return `/dashboard/call-kpis?${params.toString()}`;
  }, [isGlobal, scopedTenantId]);
  const kpiState = useAsyncResource<ConnectKpis>(() => apiGet<ConnectKpis>(kpiPath), [kpiPath]);

  useEffect(() => {
    if (historyState.status !== "success" || kpiState.status !== "success") return;
    if (direction !== "all" || status !== "all" || search) return;
    const isTodayOnly = startDate === todayDateInput() && endDate === todayDateInput();
    if (!isTodayOnly) return;
    const totals = historyState.data.totalsByDirection;
    const k = kpiState.data;
    if (
      totals.incoming !== k.incomingToday ||
      totals.outgoing !== k.outgoingToday ||
      totals.internal !== k.internalToday
    ) {
      console.warn("Call history mismatch with KPI", {
        history: totals,
        kpi: {
          incoming: k.incomingToday,
          outgoing: k.outgoingToday,
          internal: k.internalToday,
        },
        scope: isGlobal ? "global" : scopedTenantId,
      });
    }
  }, [direction, endDate, historyState, isGlobal, kpiState, scopedTenantId, search, startDate, status]);

  const history = historyState.status === "success" ? historyState.data : null;

  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have calls access.</div>}>
      <div className="stack compact-stack">
        <PageHeader
          title="Call History"
          subtitle={`Real-time + historical calls in ${isGlobal ? "global" : "tenant"} scope.`}
          badges={<><ScopeBadge scope={isGlobal ? "GLOBAL" : "TENANT"} /><LiveBadge status={telephony.status} /></>}
        />
        {isGlobal ? <GlobalScopeNotice /> : null}

        <DetailCard title={`Live Calls${liveCalls.length > 0 ? ` (${liveCalls.length})` : ""}`}>
          {!telephony.isLive ? (
            <LoadingSkeleton rows={3} />
          ) : liveCalls.length === 0 ? (
            <EmptyState title="No live calls" message="Active tenant calls appear here in real time." />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>From</th>
                  <th>To</th>
                  <th>State</th>
                  <th>Duration</th>
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
                      <td><span className={`chip ${directionClass(dir)}`}>{directionLabel(dir)}</span></td>
                      <td className="mono">{call.from || "—"}</td>
                      <td className="mono">{call.to || "—"}</td>
                      <td><span className="chip info">{call.state}</span></td>
                      <td className="mono">{formatDurationSec(elapsed)}</td>
                      {isGlobal ? <td className="muted">{call.tenantId || "—"}</td> : null}
                      <td><LiveCallBadge active={true} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </DetailCard>

        <DetailCard title="Call History">
          <div className="calls-toolbar">
            <div className="calls-toolbar-left">
              <input
                className="input calls-search"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                placeholder="Search from/to number"
              />
              <select className="select" value={direction} onChange={(e) => setDirection(e.target.value as "all" | CallDirection)}>
                <option value="all">All directions</option>
                <option value="incoming">Incoming</option>
                <option value="outgoing">Outgoing</option>
                <option value="internal">Internal</option>
              </select>
              <select className="select" value={status} onChange={(e) => setStatus(e.target.value as "all" | CallStatus)}>
                <option value="all">All statuses</option>
                <option value="answered">Answered</option>
                <option value="missed">Missed</option>
                <option value="canceled">Canceled</option>
                <option value="failed">Failed</option>
              </select>
              <input className="input calls-date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <input className="input calls-date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <div className="calls-toolbar-right">
              <span className="calls-count">Showing {history?.showing ?? 0} calls</span>
              <select className="select calls-page-size" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                <option value={50}>50 / page</option>
                <option value={100}>100 / page</option>
                <option value={200}>200 / page</option>
              </select>
            </div>
          </div>

          {historyState.status === "loading" ? (
            <LoadingSkeleton rows={5} />
          ) : historyState.status === "error" ? (
            <ErrorState message={historyState.error} />
          ) : !history || history.items.length === 0 ? (
            <EmptyState title="No call history" message="No calls match the current filters." />
          ) : (
            <>
              <div className="calls-history-wrap">
                <table className="calls-history-table">
                  <thead>
                    <tr>
                      <th />
                      <th>From</th>
                      <th>To</th>
                      <th>Direction</th>
                      <th>Status</th>
                      <th>Duration</th>
                      <th>Time</th>
                      <th>Tenant</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.items.map((row) => {
                      const exactTime = new Date(row.startedAt).toLocaleString();
                      return (
                        <tr key={row.rowId} className="calls-history-row" role="button" tabIndex={0}>
                          <td className="calls-col-icon"><DirectionIcon direction={row.direction} /></td>
                          <td className="mono">{row.fromNumber || "—"}</td>
                          <td className="mono">{row.toNumber || "—"}</td>
                          <td><span className={`chip ${directionClass(row.direction)}`}>{directionLabel(row.direction)}</span></td>
                          <td>
                            <span className={`chip ${
                              row.status === "answered" ? "success"
                                : row.status === "missed" ? "danger"
                                  : row.status === "canceled" ? "neutral"
                                    : "warning"
                            }`}>
                              {row.status}
                            </span>
                          </td>
                          <td className="mono">{formatDuration(row.durationSec)}</td>
                          <td className="muted" title={exactTime}>{relativeTimeFromNow(row.startedAt)}</td>
                          <td>{row.tenantName || "Unassigned"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="calls-pagination">
                <button className="btn ghost" disabled={(history.page ?? 1) <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  Previous
                </button>
                <span className="muted">
                  Page {history.page} of {history.totalPages} · {history.total} total
                </span>
                <button
                  className="btn ghost"
                  disabled={(history.page ?? 1) >= (history.totalPages ?? 1)}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </DetailCard>
      </div>
    </PermissionGate>
  );
}
