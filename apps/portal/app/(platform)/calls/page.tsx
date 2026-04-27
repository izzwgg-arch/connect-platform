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
import { useTelephony } from "../../../contexts/TelephonyContext";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { apiGet } from "../../../services/apiClient";
import { directionClass, directionLabel, formatDurationSec } from "../../../services/pbxLive";
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Calendar,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  Download,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Phone,
  PhoneMissed,
  Radio,
  Search,
  Sparkles,
  StickyNote,
  Voicemail,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type CallDirection = "incoming" | "outgoing" | "internal";
type CallStatus = "answered" | "missed" | "canceled" | "failed";
type AnsweredByType = "human" | "ivr" | "voicemail" | "system" | null;
type SmartTab = "all" | "missed" | "answered" | "voicemail" | "internal";
type QuickRange = "today" | "yesterday" | "last7";

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
  recordingAvailable: boolean;
  recordingPath: string | null;
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

function todayDateInput(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function addDays(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toIsoRange(startDate: string, endDate: string) {
  const s = new Date(`${startDate}T00:00:00`);
  const e = new Date(`${endDate}T00:00:00`);
  return { startIso: s.toISOString(), endIso: new Date(e.getTime() + 86_400_000).toISOString() };
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatPhone(num: string): string {
  const digits = num.replace(/\D/g, "");
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return num || "—";
}

function formatTimeBucket(iso: string): string {
  const now = new Date();
  const d = new Date(iso);
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const hhmm = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (isToday) return `Today ${hhmm}`;
  if (isYesterday) return `Yesterday ${hhmm}`;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function ringTimeSec(row: CallHistoryRow): number {
  if (!row.answeredAt) return 0;
  const started = new Date(row.startedAt).getTime();
  const answered = new Date(row.answeredAt).getTime();
  if (Number.isNaN(started) || Number.isNaN(answered)) return 0;
  return Math.max(0, Math.round((answered - started) / 1000));
}

function DirectionIcon({ direction, size = 14 }: { direction: CallDirection; size?: number }) {
  if (direction === "incoming") return <ArrowDown className="call-dir-icon incoming" size={size} />;
  if (direction === "outgoing") return <ArrowUp className="call-dir-icon outgoing" size={size} />;
  return <ArrowLeftRight className="call-dir-icon internal" size={size} />;
}

function outcomeLabel(row: CallHistoryRow): string {
  if (row.voicemailAnswered) return "Voicemail";
  if (row.humanAnswered || row.status === "answered") return "Answered";
  if (row.status === "missed") return "Missed";
  if (row.ivrAnswered) return "IVR";
  if (row.status === "failed") return "Failed";
  if (row.status === "canceled") return "Canceled";
  return row.status;
}

function outcomeClass(row: CallHistoryRow): string {
  if (row.voicemailAnswered) return "outcome-voicemail";
  if (row.humanAnswered || row.status === "answered") return "outcome-answered";
  if (row.status === "missed") return "outcome-missed";
  if (row.ivrAnswered) return "outcome-ivr";
  return "outcome-neutral";
}

function statusDescription(row: CallHistoryRow): string {
  if (row.voicemailAnswered) return "Voicemail captured";
  if (row.direction === "incoming" && row.status === "missed") return "Missed call";
  if (row.direction === "outgoing" && (row.humanAnswered || row.status === "answered")) return "Outgoing call answered";
  if (row.direction === "internal") return "Internal call";
  if (row.status === "canceled") return "Call canceled";
  if (row.status === "failed") return "Call failed";
  return `${row.direction} call`;
}

function OutcomeIcon({ row }: { row: CallHistoryRow }) {
  if (row.voicemailAnswered) return <Voicemail size={13} />;
  if (row.humanAnswered || row.status === "answered") return <CheckCircle2 size={13} />;
  if (row.status === "missed") return <PhoneMissed size={13} />;
  if (row.ivrAnswered) return <Radio size={13} />;
  return <Phone size={13} />;
}

function contactLabel(row: CallHistoryRow): string {
  if (row.fromName?.trim()) return row.fromName.trim();
  return row.direction === "outgoing" ? formatPhone(row.toNumber) : formatPhone(row.fromNumber);
}

function contactNumber(row: CallHistoryRow): string {
  return row.direction === "outgoing" ? row.toNumber : row.fromNumber;
}

function initialsFromRow(row: CallHistoryRow): string {
  const label = contactLabel(row);
  const parts = label.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function getAudioToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
}

function recordingStreamUrl(linkedId: string): string {
  return `/api/voice/recording/${encodeURIComponent(linkedId)}/stream?token=${getAudioToken()}`;
}

function recordingDownloadUrl(linkedId: string): string {
  return `/api/voice/recording/${encodeURIComponent(linkedId)}/download?token=${getAudioToken()}`;
}

function splitByGroup(rows: CallHistoryRow[]) {
  const today: CallHistoryRow[] = [];
  const yesterday: CallHistoryRow[] = [];
  const earlier: CallHistoryRow[] = [];
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  for (const row of rows) {
    const d = new Date(row.startedAt);
    if (d.toDateString() === now.toDateString()) {
      today.push(row);
    } else if (d.toDateString() === y.toDateString()) {
      yesterday.push(row);
    } else {
      earlier.push(row);
    }
  }
  return { today, yesterday, earlier };
}

export default function CallsPage() {
  const { adminScope, tenantId } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const scopedTenantId = isGlobal ? null : tenantId;
  const telephony = useTelephony();
  const liveCalls = telephony.callsByTenant(scopedTenantId);

  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [smartTab, setSmartTab] = useState<SmartTab>("all");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [direction, setDirection] = useState<"all" | CallDirection>("all");
  const [status, setStatus] = useState<"all" | CallStatus>("all");
  const [hasRecording, setHasRecording] = useState<"all" | "yes" | "no">("all");
  const [startDate, setStartDate] = useState(todayDateInput());
  const [endDate, setEndDate] = useState(todayDateInput());
  const [range, setRange] = useState<QuickRange>("today");
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage] = useState(1);
  const [feedRows, setFeedRows] = useState<CallHistoryRow[]>([]);
  const [loadedTotalPages, setLoadedTotalPages] = useState(1);
  const [loadedTotal, setLoadedTotal] = useState(0);
  const [selectedRow, setSelectedRow] = useState<CallHistoryRow | null>(null);
  const [notesByCallId, setNotesByCallId] = useState<Record<string, string>>({});
  const [copiedForRowId, setCopiedForRowId] = useState<string | null>(null);
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchDraft.trim());
      setPage(1);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  useEffect(() => {
    setPage(1);
  }, [smartTab, direction, status, hasRecording, startDate, endDate, adminScope, scopedTenantId]);

  useEffect(() => {
    setFeedRows([]);
    setLoadedTotalPages(1);
    setLoadedTotal(0);
  }, [smartTab, direction, status, hasRecording, startDate, endDate, adminScope, scopedTenantId, search, pageSize]);

  useEffect(() => {
    if (!selectedRow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedRow(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedRow]);

  useEffect(() => {
    if (!copiedForRowId) return;
    const t = window.setTimeout(() => setCopiedForRowId(null), 1400);
    return () => window.clearTimeout(t);
  }, [copiedForRowId]);

  const queryDirection = smartTab === "internal" ? "internal" : direction;
  const queryStatus = smartTab === "missed" ? "missed" : smartTab === "answered" ? "answered" : status;

  const historyQuery = useMemo(() => {
    const { startIso, endIso } = toIsoRange(startDate, endDate);
    const p = new URLSearchParams({
      startDate: startIso,
      endDate: endIso,
      direction: queryDirection,
      status: queryStatus,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (search) p.set("search", search);
    if (scopedTenantId) p.set("tenantId", scopedTenantId);
    if (hasRecording !== "all") p.set("hasRecording", hasRecording);
    return p.toString();
  }, [endDate, hasRecording, page, pageSize, queryDirection, queryStatus, scopedTenantId, search, startDate]);

  const historyState = useAsyncResource<CallHistoryResponse>(
    () => apiGet<CallHistoryResponse>(`/calls/history?${historyQuery}`),
    [historyQuery],
  );

  useEffect(() => {
    if (historyState.status !== "success") return;
    const data = historyState.data;
    setLoadedTotalPages(data.totalPages || 1);
    setLoadedTotal(data.total || 0);
    setFeedRows((prev) => {
      const next = page === 1 ? [] : [...prev];
      const seen = new Set(next.map((row) => row.rowId));
      for (const row of data.items) {
        if (!seen.has(row.rowId)) {
          seen.add(row.rowId);
          next.push(row);
        }
      }
      return next;
    });
  }, [historyState.status, page]);

  const hasMorePages = page < loadedTotalPages;

  useEffect(() => {
    if (!hasMorePages || historyState.status === "loading") return;
    const sentinel = loadMoreRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setPage((current) => (current < loadedTotalPages ? current + 1 : current));
        }
      },
      { rootMargin: "420px 0px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMorePages, historyState.status, loadedTotalPages]);

  const filteredItems = useMemo(() => {
    return feedRows.filter((row) => {
      if (smartTab === "voicemail" && !row.voicemailAnswered) return false;
      if (search) {
        const blob = [
          row.fromName || "",
          row.fromNumber || "",
          row.toNumber || "",
          row.rangExtension || "",
          row.tenantName || "",
          row.linkedId || "",
        ].join(" ").toLowerCase();
        if (!blob.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [feedRows, search, smartTab]);

  const grouped = useMemo(() => splitByGroup(filteredItems), [filteredItems]);

  const kpis = useMemo(() => {
    const rows = filteredItems;
    const total = rows.length;
    const answered = rows.filter((r) => r.humanAnswered || r.status === "answered").length;
    const missed = rows.filter((r) => r.status === "missed").length;
    const voicemail = rows.filter((r) => r.voicemailAnswered).length;
    const avgDuration = total > 0 ? Math.round(rows.reduce((acc, r) => acc + Number(r.durationSec || 0), 0) / total) : 0;
    return {
      total,
      answeredPct: total > 0 ? Math.round((answered / total) * 100) : 0,
      missedPct: total > 0 ? Math.round((missed / total) * 100) : 0,
      voicemail,
      avgDuration,
    };
  }, [filteredItems]);

  const onQuickRange = (next: QuickRange) => {
    const today = todayDateInput();
    setRange(next);
    if (next === "today") {
      setStartDate(today);
      setEndDate(today);
    } else if (next === "yesterday") {
      const y = addDays(today, -1);
      setStartDate(y);
      setEndDate(y);
    } else {
      setStartDate(addDays(today, -6));
      setEndDate(today);
    }
  };

  const callNumber = (num: string) => {
    if (!num) return;
    window.location.href = `tel:${num}`;
  };

  const messageNumber = (num: string) => {
    if (!num) return;
    window.location.href = `/chat?to=${encodeURIComponent(num)}`;
  };

  const copyNumber = async (row: CallHistoryRow) => {
    const num = contactNumber(row);
    if (!num) return;
    try {
      await navigator.clipboard.writeText(num);
      setCopiedForRowId(row.rowId);
    } catch {
      setCopiedForRowId(row.rowId);
    }
  };

  const renderLiveCalls = () => {
    if (liveCalls.length > 0) {
      return (
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
              return (
                <div key={call.id} className="calls-live-row">
                  <DirectionIcon direction={dir as CallDirection} size={15} />
                  <span className="calls-live-caller">
                    {call.fromName ? <span className="calls-live-cnam">{call.fromName}</span> : null}
                    <span className="mono">{call.from || "—"}</span>
                  </span>
                  <span className="calls-live-arrow">→</span>
                  <span className="mono">{call.to || "Resolving…"}</span>
                  <span className={`chip ${directionClass(dir)}`}>{directionLabel(dir)}</span>
                  <span className="chip info">{call.state}</span>
                  <span className="mono muted">{formatDurationSec(elapsed)}</span>
                  <LiveCallBadge active />
                </div>
              );
            })}
          </div>
        </section>
      );
    }
    if (telephony.status === "connected") {
      return (
        <section className="calls-live-section calls-live-idle" aria-label="Live calls">
          <div className="calls-live-header">
            <span className="calls-live-dot idle" />
            <h3 className="calls-live-title">Live calls</h3>
            <span className="calls-live-idle-label">No active calls right now</span>
          </div>
        </section>
      );
    }
    if (telephony.status === "failed") {
      return (
        <section className="calls-live-section calls-live-idle" aria-label="Live calls">
          <div className="calls-live-header">
            <span className="calls-live-dot error" />
            <h3 className="calls-live-title">Live calls</h3>
            <span className="calls-live-idle-label">Connection lost — refresh to reconnect</span>
          </div>
        </section>
      );
    }
    return null;
  };

  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have permission to view calls.</div>}>
      <div className="calls-page calls-premium stack compact-stack">
        <PageHeader
          title="Call History"
          subtitle="Conversations and outcomes across your voice stack."
          badges={
            <>
              <ScopeBadge scope={isGlobal ? "GLOBAL" : "TENANT"} />
              <LiveBadge status={telephony.status} />
            </>
          }
        />

        {isGlobal ? <GlobalScopeNotice /> : null}
        {renderLiveCalls()}

        <section className="calls-kpi-grid" aria-label="Call performance">
          <article className="calls-kpi-card">
            <span className="calls-kpi-label">Total Calls</span>
            <strong>{(loadedTotal || kpis.total).toLocaleString()}</strong>
            <span className="calls-kpi-trend up"><Sparkles size={12} /> Active {liveCalls.length}</span>
          </article>
          <article className="calls-kpi-card">
            <span className="calls-kpi-label">Answered %</span>
            <strong>{kpis.answeredPct}%</strong>
            <span className={`calls-kpi-trend ${kpis.answeredPct >= 50 ? "up" : "down"}`}>{kpis.answeredPct >= 50 ? "↑" : "↓"} Service quality</span>
          </article>
          <article className="calls-kpi-card">
            <span className="calls-kpi-label">Missed %</span>
            <strong>{kpis.missedPct}%</strong>
            <span className={`calls-kpi-trend ${kpis.missedPct <= 20 ? "up" : "down"}`}>{kpis.missedPct <= 20 ? "↓" : "↑"} Attention needed</span>
          </article>
          <article className="calls-kpi-card">
            <span className="calls-kpi-label">Avg Duration</span>
            <strong>{formatDuration(kpis.avgDuration)}</strong>
            <span className="calls-kpi-trend up">↑ Talk time</span>
          </article>
          <article className="calls-kpi-card">
            <span className="calls-kpi-label">Voicemails</span>
            <strong>{kpis.voicemail.toLocaleString()}</strong>
            <span className="calls-kpi-trend neutral">• Follow-ups</span>
          </article>
        </section>

        <section className="calls-smart-filters" aria-label="Smart filters">
          <label className="calls-search-wrap">
            <Search size={15} />
            <input
              type="search"
              className="calls-search-input"
              placeholder="Search name, number, extension"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
            />
          </label>

          <div className="calls-pill-tabs">
            {([
              ["all", "All"],
              ["missed", "Missed"],
              ["answered", "Answered"],
              ["voicemail", "Voicemail"],
              ["internal", "Internal"],
            ] as Array<[SmartTab, string]>).map(([value, label]) => (
              <button
                key={value}
                className={`calls-pill-tab ${smartTab === value ? "active" : ""}`}
                onClick={() => setSmartTab(value)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="calls-quick-range">
            {([
              ["today", "Today"],
              ["yesterday", "Yesterday"],
              ["last7", "Last 7 days"],
            ] as Array<[QuickRange, string]>).map(([value, label]) => (
              <button
                key={value}
                className={`calls-range-chip ${range === value ? "active" : ""}`}
                onClick={() => onQuickRange(value)}
              >
                <Calendar size={12} />
                {label}
              </button>
            ))}
          </div>

          <button className={`btn ghost btn-sm calls-advanced-toggle ${showAdvanced ? "active" : ""}`} onClick={() => setShowAdvanced((v) => !v)}>
            <ChevronDown size={13} />
            Advanced filters
          </button>

          {showAdvanced ? (
            <div className="calls-advanced-panel">
              <label>
                Direction
                <select value={direction} onChange={(e) => setDirection(e.target.value as "all" | CallDirection)}>
                  <option value="all">All</option>
                  <option value="incoming">Incoming</option>
                  <option value="outgoing">Outgoing</option>
                  <option value="internal">Internal</option>
                </select>
              </label>
              <label>
                Status
                <select value={status} onChange={(e) => setStatus(e.target.value as "all" | CallStatus)}>
                  <option value="all">All</option>
                  <option value="answered">Answered</option>
                  <option value="missed">Missed</option>
                  <option value="canceled">Canceled</option>
                  <option value="failed">Failed</option>
                </select>
              </label>
              <label>
                Recording
                <select value={hasRecording} onChange={(e) => setHasRecording(e.target.value as "all" | "yes" | "no")}>
                  <option value="all">All</option>
                  <option value="yes">Has recording</option>
                  <option value="no">No recording</option>
                </select>
              </label>
              <label>
                Start
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </label>
              <label>
                End
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </label>
              <label>
                Page size
                <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                </select>
              </label>
            </div>
          ) : null}
        </section>

        <section className="calls-premium-main" aria-label="Call feed and details">
          <div className="calls-feed-shell">
            {historyState.status === "loading" && page === 1 ? <LoadingSkeleton rows={7} /> : null}
            {historyState.status === "error" ? <ErrorState message={historyState.error || "Could not load call history."} /> : null}
            {historyState.status === "success" && loadedTotal === 0 ? (
              <EmptyState title="No calls yet" message="Calls will appear here once telephony activity starts." />
            ) : null}
            {historyState.status === "success" && loadedTotal > 0 && filteredItems.length === 0 ? (
              <EmptyState title="No calls match your filters" message="Try adjusting your search, tab, or date range." />
            ) : null}

            {historyState.status === "success" && filteredItems.length > 0 ? (
              <div className="calls-feed-groups">
                {([
                  ["Today", grouped.today],
                  ["Yesterday", grouped.yesterday],
                  ["Earlier", grouped.earlier],
                ] as Array<[string, CallHistoryRow[]]>).map(([label, rows]) => (
                  <section key={label} className="calls-group-section">
                    {rows.length > 0 ? (
                      <>
                        <header className="calls-group-header">{label}</header>
                        <div className="calls-feed-list">
                          {rows.map((row) => (
                            <article
                              key={row.rowId}
                              className={`call-feed-card ${outcomeClass(row)} ${selectedRow?.rowId === row.rowId ? "selected" : ""}`}
                              onClick={() => setSelectedRow(row)}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") setSelectedRow(row);
                              }}
                            >
                              <div className="call-feed-avatar">{initialsFromRow(row)}</div>

                              <div className="call-feed-main">
                                <div className="call-feed-title-row">
                                  <strong className="call-feed-name">{contactLabel(row)}</strong>
                                  <span className="call-feed-number mono">{formatPhone(contactNumber(row))}</span>
                                </div>
                                <div className="call-feed-sub">
                                  {row.rangExtension ? <span>ext {row.rangExtension}</span> : null}
                                  <span>{row.direction === "internal" ? "Internal" : "External"}</span>
                                  {isGlobal && row.tenantName !== "Unassigned" ? <span>{row.tenantName}</span> : null}
                                </div>
                                <div className="call-feed-center">
                                  <span className="call-feed-direction"><DirectionIcon direction={row.direction} size={14} /></span>
                                  <span className={`call-feed-status ${outcomeClass(row)}`}>
                                    <OutcomeIcon row={row} />
                                    {outcomeLabel(row)}
                                  </span>
                                  <span className="call-feed-description">{statusDescription(row)}</span>
                                </div>
                              </div>

                              <div className="call-feed-right">
                                <span className="call-feed-time">{formatTimeBucket(row.startedAt)}</span>
                                <span className="call-feed-duration">{formatDuration(row.durationSec)}</span>
                                <div className="call-feed-actions">
                                  <button
                                    className="call-action-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      callNumber(contactNumber(row));
                                    }}
                                    title="Call back"
                                  >
                                    <Phone size={13} />
                                  </button>
                                  <button
                                    className="call-action-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      messageNumber(contactNumber(row));
                                    }}
                                    title="Message"
                                  >
                                    <MessageSquare size={13} />
                                  </button>
                                  {row.recordingAvailable ? (
                                    <button
                                      className="call-action-btn"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setSelectedRow(row);
                                      }}
                                      title="Play recording"
                                    >
                                      <Mic size={13} />
                                    </button>
                                  ) : null}

                                  <details className="call-menu" onClick={(e) => e.stopPropagation()}>
                                    <summary className="call-action-btn" title="More actions">
                                      <MoreHorizontal size={13} />
                                    </summary>
                                    <div className="call-menu-list">
                                      <button onClick={() => callNumber(contactNumber(row))}><Phone size={13} />Call back</button>
                                      <button onClick={() => messageNumber(contactNumber(row))}><MessageSquare size={13} />Message</button>
                                      <button onClick={() => copyNumber(row)}><Copy size={13} />Copy number</button>
                                      <button onClick={() => setSelectedRow(row)}><ChevronDown size={13} />View details</button>
                                      {row.recordingAvailable ? (
                                        <a href={recordingDownloadUrl(row.linkedId)} download>
                                          <Download size={13} />Download recording
                                        </a>
                                      ) : null}
                                    </div>
                                  </details>
                                </div>
                                {copiedForRowId === row.rowId ? <span className="call-feed-copied">Copied</span> : null}
                              </div>
                            </article>
                          ))}
                        </div>
                      </>
                    ) : null}
                  </section>
                ))}
              </div>
            ) : null}

            <div ref={loadMoreRef} className="calls-load-more" aria-live="polite">
              {historyState.status === "loading" && page > 1 ? (
                <span className="calls-load-status">Loading more calls...</span>
              ) : hasMorePages ? (
                <button className="btn ghost btn-sm" onClick={() => setPage((p) => Math.min(p + 1, loadedTotalPages))}>
                  Load older calls
                </button>
              ) : filteredItems.length > 0 ? (
                <span className="calls-load-status">All visible calls loaded</span>
              ) : null}
            </div>
          </div>

          <aside className={`calls-side-panel ${selectedRow ? "open" : ""}`} aria-label="Call details">
            {!selectedRow ? (
              <div className="calls-side-empty">
                <Sparkles size={20} />
                <h4>Select a call</h4>
                <p>Choose any conversation to view full details, notes, and recording actions.</p>
              </div>
            ) : (
              <div className="calls-side-content">
                <div className="calls-side-top">
                  <div className="calls-side-avatar">{initialsFromRow(selectedRow)}</div>
                  <div>
                    <h3>{contactLabel(selectedRow)}</h3>
                    <p className="mono">{formatPhone(contactNumber(selectedRow))}</p>
                  </div>
                  <button className="calls-side-close" onClick={() => setSelectedRow(null)} aria-label="Close details">
                    <X size={16} />
                  </button>
                </div>

                <div className={`calls-side-status ${outcomeClass(selectedRow)}`}>
                  <OutcomeIcon row={selectedRow} />
                  {outcomeLabel(selectedRow)}
                </div>

                <dl className="calls-side-grid">
                  <dt>Direction</dt><dd className="capitalize">{selectedRow.direction}</dd>
                  <dt>Duration</dt><dd>{formatDuration(selectedRow.durationSec)}</dd>
                  <dt>Ring time</dt><dd>{formatDuration(ringTimeSec(selectedRow))}</dd>
                  <dt>Answered by</dt><dd>{selectedRow.answeredByType || "—"}</dd>
                  <dt>Type</dt><dd>{selectedRow.direction === "internal" ? "Internal" : "External"}</dd>
                  <dt>Call ID</dt><dd className="mono">{selectedRow.linkedId || selectedRow.callId}</dd>
                  <dt>Timestamp</dt><dd>{formatTimeBucket(selectedRow.startedAt)}</dd>
                </dl>

                {selectedRow.recordingAvailable ? (
                  <section className="calls-side-recording">
                    <h4><Mic size={14} /> Recording</h4>
                    <div className="calls-waveform" aria-hidden>
                      {Array.from({ length: 26 }).map((_, i) => (
                        <span key={i} style={{ height: `${10 + ((i * 7) % 24)}px` }} />
                      ))}
                    </div>
                    <audio controls preload="none" src={recordingStreamUrl(selectedRow.linkedId)}>
                      Your browser does not support audio playback.
                    </audio>
                    <a className="btn ghost btn-sm" href={recordingDownloadUrl(selectedRow.linkedId)} download>
                      <Download size={13} />
                      Download recording
                    </a>
                  </section>
                ) : null}

                <section className="calls-side-actions">
                  <button className="btn primary btn-sm" onClick={() => callNumber(contactNumber(selectedRow))}><Phone size={14} />Call</button>
                  <button className="btn ghost btn-sm" onClick={() => messageNumber(contactNumber(selectedRow))}><MessageSquare size={14} />Message</button>
                  <button className="btn ghost btn-sm" onClick={() => notesRef.current?.focus()}><StickyNote size={14} />Add note</button>
                </section>

                <section className="calls-side-notes">
                  <h4>Notes</h4>
                  <textarea
                    ref={notesRef}
                    placeholder="Add call notes for follow-up..."
                    value={notesByCallId[selectedRow.callId] || ""}
                    onChange={(e) =>
                      setNotesByCallId((prev) => ({
                        ...prev,
                        [selectedRow.callId]: e.target.value,
                      }))
                    }
                  />
                </section>

                {selectedRow.journeySteps.length > 0 ? (
                  <section className="calls-side-journey">
                    <h4>Journey</h4>
                    <ol>
                      {selectedRow.journeySteps.map((step, idx) => (
                        <li key={`${selectedRow.rowId}-${idx}`}>
                          <span>{step.label}</span>
                          {step.detail ? <small>{step.detail}</small> : null}
                        </li>
                      ))}
                    </ol>
                  </section>
                ) : null}
              </div>
            )}
          </aside>
        </section>

        {selectedRow ? <button className="calls-side-backdrop" onClick={() => setSelectedRow(null)} aria-label="Close details panel" /> : null}
      </div>
    </PermissionGate>
  );
}
