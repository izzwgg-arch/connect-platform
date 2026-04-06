"use client";

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
import {
  ArrowDown, ArrowLeftRight, ArrowUp,
  Phone, PhoneOff, PhoneMissed, PhoneIncoming,
  ChevronDown, ChevronRight, Clock, User, Voicemail,
  Radio, GitBranch, CheckCircle2, XCircle, AlertCircle, Info,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type CallDirection = "incoming" | "outgoing" | "internal";
type CallStatus = "answered" | "missed" | "canceled" | "failed";
type AnsweredByType = "human" | "ivr" | "voicemail" | "system" | null;

type JourneyStep = {
  label: string;
  detail?: string;
  result: "ok" | "warn" | "missed" | "info";
};

type CallHistoryRow = {
  callId: string;
  rowId: string;
  linkedId: string;
  fromNumber: string;
  fromName: string | null;
  toNumber: string;
  direction: CallDirection;
  status: CallStatus;
  disposition: string;
  durationSec: number;
  talkSec: number;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  tenantId: string | null;
  tenantName: string;
  rangExtension: string | null;
  // Derived outcome fields
  answeredByType: AnsweredByType;
  humanAnswered: boolean;
  ivrAnswered: boolean;
  voicemailAnswered: boolean;
  attemptedExtensions: string[];
  journeySummary: string;
  finalOutcomeReason: string;
  journeySteps: JourneyStep[];
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

// ─── Utilities ────────────────────────────────────────────────────────────────

function todayDateInput(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function toIsoRange(startDate: string, endDate: string) {
  const s = new Date(`${startDate}T00:00:00`);
  const e = new Date(`${endDate}T00:00:00`);
  return { startIso: s.toISOString(), endIso: new Date(e.getTime() + 86_400_000).toISOString() };
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(ms);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60_000) return rtf.format(-Math.round(ms / 1_000), "second");
  if (abs < 3_600_000) return rtf.format(-Math.round(ms / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(-Math.round(ms / 3_600_000), "hour");
  return rtf.format(-Math.round(ms / 86_400_000), "day");
}

function formatAbsTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function formatPhone(num: string): string {
  const d = num.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1")) return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return num || "—";
}

// ─── Direction & status display ───────────────────────────────────────────────

function DirectionIcon({ direction, size = 14 }: { direction: CallDirection; size?: number }) {
  if (direction === "incoming") return <ArrowDown className="call-dir-icon incoming" size={size} />;
  if (direction === "outgoing") return <ArrowUp className="call-dir-icon outgoing" size={size} />;
  return <ArrowLeftRight className="call-dir-icon internal" size={size} />;
}

function outcomeLabel(row: CallHistoryRow): string {
  if (row.status === "canceled") return "Canceled";
  if (row.status === "failed") return "Failed";
  if (row.voicemailAnswered) return "Voicemail";
  if (row.ivrAnswered && !row.humanAnswered && row.status === "missed") return "IVR → Missed";
  if (row.ivrAnswered && !row.humanAnswered) return "IVR only";
  if (row.humanAnswered) return "Answered";
  if (row.status === "missed") return "Missed";
  return row.status;
}

function outcomeClass(row: CallHistoryRow): string {
  if (row.status === "canceled" || row.status === "failed") return "outcome-neutral";
  if (row.voicemailAnswered) return "outcome-voicemail";
  if (row.ivrAnswered && !row.humanAnswered && row.status === "missed") return "outcome-missed";
  if (row.ivrAnswered && !row.humanAnswered) return "outcome-ivr";
  if (row.humanAnswered) return "outcome-answered";
  if (row.status === "missed") return "outcome-missed";
  return "outcome-neutral";
}

function OutcomeIcon({ row }: { row: CallHistoryRow }) {
  if (row.voicemailAnswered) return <Voicemail size={13} />;
  if (row.ivrAnswered && !row.humanAnswered && row.status === "missed") return <PhoneMissed size={13} />;
  if (row.ivrAnswered && !row.humanAnswered) return <Radio size={13} />;
  if (row.humanAnswered) return <Phone size={13} />;
  if (row.status === "missed") return <PhoneMissed size={13} />;
  if (row.status === "canceled") return <PhoneOff size={13} />;
  return <PhoneOff size={13} />;
}

function StepIcon({ result }: { result: JourneyStep["result"] }) {
  if (result === "ok") return <CheckCircle2 size={15} className="step-icon ok" />;
  if (result === "missed") return <XCircle size={15} className="step-icon missed" />;
  if (result === "warn") return <AlertCircle size={15} className="step-icon warn" />;
  return <Info size={15} className="step-icon info" />;
}

// ─── Call detail panel ────────────────────────────────────────────────────────

function CallDetailPanel({ row, onClose }: { row: CallHistoryRow; onClose: () => void }) {
  const [techExpanded, setTechExpanded] = useState(false);
  const dir = row.direction;

  return (
    <div className="call-detail-overlay" onClick={onClose} role="dialog" aria-modal aria-label="Call details">
      <div className="call-detail-panel" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="cdp-header">
          <div className="cdp-header-left">
            <div className={`cdp-dir-badge ${dir}`}>
              <DirectionIcon direction={dir} size={16} />
              <span>{dir === "incoming" ? "Inbound" : dir === "outgoing" ? "Outbound" : "Internal"}</span>
            </div>
            <div className={`cdp-outcome-badge ${outcomeClass(row)}`}>
              <OutcomeIcon row={row} />
              <span>{outcomeLabel(row)}</span>
            </div>
          </div>
          <button className="cdp-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {/* Call identity */}
        <div className="cdp-identity">
          <div className="cdp-number-row">
            <div className="cdp-number-block">
              <span className="cdp-number-label">From</span>
              {row.fromName && <span className="cdp-caller-name">{row.fromName}</span>}
              <span className="cdp-number">{formatPhone(row.fromNumber)}</span>
            </div>
            <div className="cdp-arrow">→</div>
            <div className="cdp-number-block">
              <span className="cdp-number-label">To</span>
              <span className="cdp-number">{formatPhone(row.toNumber)}</span>
            </div>
          </div>
          <div className="cdp-meta-row">
            {row.tenantName !== "Unassigned" ? (
              <span className="cdp-meta-chip"><User size={12} />{row.tenantName}</span>
            ) : null}
            <span className="cdp-meta-chip"><Clock size={12} />{formatAbsTime(row.startedAt)}</span>
            {row.durationSec > 0 ? (
              <span className="cdp-meta-chip"><Phone size={12} />{formatDuration(row.durationSec)} total</span>
            ) : null}
            {row.talkSec > 0 ? (
              <span className="cdp-meta-chip talk"><CheckCircle2 size={12} />{formatDuration(row.talkSec)} talk</span>
            ) : null}
          </div>
        </div>

        {/* Outcome summary card */}
        <div className={`cdp-outcome-card ${outcomeClass(row)}`}>
          <div className="cdp-outcome-icon-wrap">
            <OutcomeIcon row={row} />
          </div>
          <p className="cdp-outcome-text">{row.journeySummary || "No summary available."}</p>
        </div>

        {/* Journey timeline */}
        {row.journeySteps.length > 0 ? (
          <div className="cdp-section">
            <h4 className="cdp-section-title">Call journey</h4>
            <ol className="cdp-timeline">
              {row.journeySteps.map((step, i) => (
                <li key={i} className={`cdp-step cdp-step-${step.result}`}>
                  <div className="cdp-step-icon"><StepIcon result={step.result} /></div>
                  <div className="cdp-step-body">
                    <span className="cdp-step-label">{step.label}</span>
                    {step.detail ? <span className="cdp-step-detail">{step.detail}</span> : null}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {/* Attempted extensions */}
        {row.attemptedExtensions.length > 0 ? (
          <div className="cdp-section">
            <h4 className="cdp-section-title">Extensions involved</h4>
            <div className="cdp-ext-list">
              {row.attemptedExtensions.map((ext) => (
                <span key={ext} className={`cdp-ext-chip ${row.humanAnswered && row.rangExtension === ext ? "answered" : "rang"}`}>
                  <Phone size={11} />
                  {ext}
                  {row.humanAnswered && row.rangExtension === ext ? " ✓" : ""}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {/* Technical details (collapsed) */}
        <div className="cdp-section">
          <button
            className="cdp-tech-toggle"
            onClick={() => setTechExpanded((v) => !v)}
            aria-expanded={techExpanded}
          >
            <span>Technical details</span>
            {techExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          {techExpanded ? (
            <dl className="cdp-tech-grid">
              <dt>Linked ID</dt><dd className="mono">{row.linkedId}</dd>
              <dt>Disposition</dt><dd>{row.disposition}</dd>
              <dt>Outcome reason</dt><dd>{row.finalOutcomeReason || "—"}</dd>
              {row.answeredByType ? <><dt>Answered by</dt><dd>{row.answeredByType}</dd></> : null}
              {row.rangExtension ? <><dt>Rang extension</dt><dd>{row.rangExtension}</dd></> : null}
              {row.answeredAt ? <><dt>Answered at</dt><dd>{new Date(row.answeredAt).toLocaleTimeString()}</dd></> : null}
              {row.endedAt ? <><dt>Ended at</dt><dd>{new Date(row.endedAt).toLocaleTimeString()}</dd></> : null}
            </dl>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

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
  const [selectedRow, setSelectedRow] = useState<CallHistoryRow | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => { setSearch(searchDraft.trim()); setPage(1); }, 220);
    return () => clearTimeout(t);
  }, [searchDraft]);

  useEffect(() => { setPage(1); }, [direction, status, startDate, endDate, adminScope, scopedTenantId]);

  const historyQuery = useMemo(() => {
    const { startIso, endIso } = toIsoRange(startDate, endDate);
    const p = new URLSearchParams({ startDate: startIso, endDate: endIso, direction, status, page: String(page), pageSize: String(pageSize) });
    if (search) p.set("search", search);
    if (scopedTenantId) p.set("tenantId", scopedTenantId);
    return p.toString();
  }, [direction, endDate, page, pageSize, scopedTenantId, search, startDate, status]);

  const historyState = useAsyncResource<CallHistoryResponse>(
    () => apiGet<CallHistoryResponse>(`/calls/history?${historyQuery}`),
    [historyQuery]
  );

  const history = historyState.status === "success" ? historyState.data : null;

  // Close detail panel on Escape
  useEffect(() => {
    if (!selectedRow) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setSelectedRow(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedRow]);

  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have permission to view calls.</div>}>
      <div className="calls-page stack compact-stack">
        <PageHeader
          title="Call History"
          subtitle="All calls routed through the platform."
          badges={<><ScopeBadge scope={adminScope === "GLOBAL" ? "GLOBAL" : "TENANT"} /><LiveBadge status={telephony.status} /></>}
        />

        {isGlobal ? <GlobalScopeNotice /> : null}

        {/* ── Live calls ── */}
        {liveCalls.length > 0 ? (
          <section className="calls-live-section" aria-label="Live calls">
            <div className="calls-live-header">
              <span className="calls-live-dot" />
              <h3 className="calls-live-title">Live calls</h3>
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
                    <DirectionIcon direction={dir as CallDirection} size={15} />
                    <span className="calls-live-caller">
                      {call.fromName && <span className="calls-live-cnam">{call.fromName}</span>}
                      <span className="mono">{call.from || "—"}</span>
                    </span>
                    <span className="calls-live-arrow">→</span>
                    <span className="mono">{displayTo}</span>
                    <span className={`chip ${directionClass(dir)}`}>{directionLabel(dir)}</span>
                    <span className="chip info">{call.state}</span>
                    <span className="mono muted">{formatDurationSec(elapsed)}</span>
                    {isGlobal && displayTenant ? (
                      <span className="muted">{displayTenant}</span>
                    ) : null}
                    <LiveCallBadge active />
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* ── Filters ── */}
        <section className="calls-filters" aria-label="Filters">
          <input
            className="calls-search"
            type="search"
            placeholder="Search by number…"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            aria-label="Search calls"
          />
          <select className="calls-filter-select" value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)} aria-label="Direction">
            <option value="all">All directions</option>
            <option value="incoming">Incoming</option>
            <option value="outgoing">Outgoing</option>
            <option value="internal">Internal</option>
          </select>
          <select className="calls-filter-select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
            <option value="all">All statuses</option>
            <option value="answered">Answered</option>
            <option value="missed">Missed</option>
            <option value="canceled">Canceled</option>
          </select>
          <div className="calls-date-range">
            <input type="date" className="calls-date-input" value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-label="Start date" />
            <span className="calls-date-sep">—</span>
            <input type="date" className="calls-date-input" value={endDate} onChange={(e) => setEndDate(e.target.value)} aria-label="End date" />
          </div>
          <select className="calls-filter-select" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} aria-label="Page size">
            <option value={50}>50 / page</option>
            <option value={100}>100 / page</option>
            <option value={200}>200 / page</option>
          </select>
          {history ? (
            <span className="calls-filter-count">{history.total.toLocaleString()} call{history.total !== 1 ? "s" : ""}</span>
          ) : null}
        </section>

        {/* ── History list ── */}
        <section className="calls-history-section" aria-label="Call history">
          {historyState.status === "loading" ? <LoadingSkeleton rows={6} /> : null}
          {historyState.status === "error" ? (
            <ErrorState message={historyState.error || "Could not load call history."} />
          ) : null}
          {historyState.status === "success" && history!.items.length === 0 ? (
            <EmptyState title="No calls found" message="Try adjusting the date range or filters." />
          ) : null}
          {historyState.status === "success" && history!.items.length > 0 ? (
            <div className="calls-card-list">
              {history!.items.map((row) => (
                <button
                  key={row.rowId}
                  className="call-row-card"
                  onClick={() => setSelectedRow(row)}
                  aria-label={`Call from ${row.fromNumber} to ${row.toNumber}`}
                >
                  {/* Left: direction icon */}
                  <div className="crc-dir">
                    <DirectionIcon direction={row.direction} size={16} />
                  </div>

                  {/* Centre: from/to + journey summary */}
                  <div className="crc-main">
                    <div className="crc-numbers">
                      <span className="crc-number">
                        {row.fromName ? (
                          <span className="crc-caller-name">{row.fromName}</span>
                        ) : null}
                        {formatPhone(row.fromNumber)}
                      </span>
                      <span className="crc-arrow">→</span>
                      <span className="crc-number">{formatPhone(row.toNumber)}</span>
                      {row.rangExtension ? <span className="crc-ext-chip">ext {row.rangExtension}</span> : null}
                    </div>
                    {row.journeySummary ? (
                      <p className="crc-journey">{row.journeySummary}</p>
                    ) : null}
                    {isGlobal && row.tenantName !== "Unassigned" ? (
                      <p className="crc-tenant">{row.tenantName}</p>
                    ) : null}
                  </div>

                  {/* Right: outcome badge + time + duration */}
                  <div className="crc-meta">
                    <span className={`crc-outcome ${outcomeClass(row)}`}>
                      <OutcomeIcon row={row} />
                      {outcomeLabel(row)}
                    </span>
                    <span className="crc-time" title={formatAbsTime(row.startedAt)}>{relativeTime(row.startedAt)}</span>
                    <span className="crc-duration">{formatDuration(row.durationSec)}</span>
                  </div>

                  <ChevronRight size={14} className="crc-chevron" />
                </button>
              ))}
            </div>
          ) : null}

          {/* Pagination */}
          {history && history.totalPages > 1 ? (
            <div className="calls-pagination">
              <button className="btn ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Previous</button>
              <span className="calls-page-info">Page {page} of {history.totalPages}</span>
              <button className="btn ghost btn-sm" disabled={page >= history.totalPages} onClick={() => setPage((p) => p + 1)}>Next →</button>
            </div>
          ) : null}
        </section>

        {/* ── Detail panel ── */}
        {selectedRow ? (
          <CallDetailPanel row={selectedRow} onClose={() => setSelectedRow(null)} />
        ) : null}
      </div>
    </PermissionGate>
  );
}
