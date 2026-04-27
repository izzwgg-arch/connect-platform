"use client";

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
  Phone, PhoneOff, PhoneMissed,
  ChevronDown, ChevronRight, Clock, User, Voicemail,
  Radio, CheckCircle2, XCircle, AlertCircle, Info,
  X, Mic, Download, Search, Filter, Copy, PhoneCall,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

// ─── Types ─────────────────────────────────────────────────────────────────

type CallDirection = "incoming" | "outgoing" | "internal";
type CallStatus = "answered" | "missed" | "canceled" | "failed";
type AnsweredByType = "human" | "ivr" | "voicemail" | "system" | null;
type ActiveTab = "all" | "missed" | "answered" | "voicemail" | "internal";
type QuickDate = "today" | "yesterday" | "week" | "custom";

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

// ─── Utilities ─────────────────────────────────────────────────────────────

function todayDateInput(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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

function getInitials(name: string | null, number: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  const digits = number.replace(/\D/g, "");
  return digits.length >= 2 ? digits.slice(0, 2) : (digits[0] ?? "#");
}

function getDateGroup(iso: string): { label: string; sortKey: number } {
  const d = new Date(iso); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yest = new Date(today); yest.setDate(today.getDate() - 1);
  if (d.getTime() === today.getTime()) return { label: "Today", sortKey: 0 };
  if (d.getTime() === yest.getTime()) return { label: "Yesterday", sortKey: 1 };
  const label = d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  return { label, sortKey: Math.round((today.getTime() - d.getTime()) / 86400000) };
}

function groupCalls(items: CallHistoryRow[]): Array<{ label: string; calls: CallHistoryRow[] }> {
  const groups = new Map<string, { sortKey: number; calls: CallHistoryRow[] }>();
  for (const row of items) {
    const { label, sortKey } = getDateGroup(row.startedAt);
    if (!groups.has(label)) groups.set(label, { sortKey, calls: [] });
    groups.get(label)!.calls.push(row);
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => a.sortKey - b.sortKey)
    .map(([label, g]) => ({ label, calls: g.calls }));
}

// ─── Outcome & direction helpers ───────────────────────────────────────────

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
  if (row.status === "canceled" || row.status === "failed") return "canceled";
  if (row.voicemailAnswered) return "voicemail";
  if (row.ivrAnswered && !row.humanAnswered) return "ivr";
  if (row.humanAnswered) return "answered";
  if (row.status === "missed") return "missed";
  return "canceled";
}

function OutcomeIcon({ row, size = 13 }: { row: CallHistoryRow; size?: number }) {
  if (row.voicemailAnswered) return <Voicemail size={size} />;
  if (row.ivrAnswered && !row.humanAnswered && row.status === "missed") return <PhoneMissed size={size} />;
  if (row.ivrAnswered && !row.humanAnswered) return <Radio size={size} />;
  if (row.humanAnswered) return <CheckCircle2 size={size} />;
  if (row.status === "missed") return <PhoneMissed size={size} />;
  return <PhoneOff size={size} />;
}

function DirectionIcon({ direction, size = 14 }: { direction: CallDirection; size?: number }) {
  if (direction === "incoming") return <ArrowDown className="call-dir-icon incoming" size={size} />;
  if (direction === "outgoing") return <ArrowUp className="call-dir-icon outgoing" size={size} />;
  return <ArrowLeftRight className="call-dir-icon internal" size={size} />;
}

function StepIcon({ result }: { result: JourneyStep["result"] }) {
  if (result === "ok") return <CheckCircle2 size={11} />;
  if (result === "missed") return <XCircle size={11} />;
  if (result === "warn") return <AlertCircle size={11} />;
  return <Info size={11} />;
}

// ─── KPI Card ──────────────────────────────────────────────────────────────

function KPICard({ label, value, accent, icon, sub }: {
  label: string;
  value: string | number;
  accent: "blue" | "green" | "red" | "amber" | "purple";
  icon: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className={`ch-kpi-card accent-${accent}`}>
      <div className="ch-kpi-icon">{icon}</div>
      <div className="ch-kpi-value">{value}</div>
      <div className="ch-kpi-label">{label}</div>
      {sub ? <div className="ch-kpi-sub">{sub}</div> : null}
    </div>
  );
}

// ─── Call Avatar ───────────────────────────────────────────────────────────

function CallAvatar({ name, number, direction }: {
  name: string | null;
  number: string;
  direction: CallDirection;
}) {
  return (
    <div className={`ch-avatar dir-${direction}`} aria-hidden>
      {getInitials(name, number)}
    </div>
  );
}

// ─── Call Item ─────────────────────────────────────────────────────────────

function CallItem({ row, isSelected, onSelect, isGlobal }: {
  row: CallHistoryRow;
  isSelected: boolean;
  onSelect: (row: CallHistoryRow) => void;
  isGlobal: boolean;
}) {
  const oc = outcomeClass(row);
  const displayName = row.fromName || formatPhone(row.fromNumber);
  const hasName = Boolean(row.fromName);

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(row.fromNumber).catch(() => { /* silent fail */ });
  }

  return (
    <button
      className={`ch-call-item${isSelected ? " selected" : ""}`}
      onClick={() => onSelect(row)}
      aria-label={`${row.direction} call ${hasName ? `from ${row.fromName}` : `from ${row.fromNumber}`}`}
      aria-pressed={isSelected}
    >
      {/* Avatar */}
      <CallAvatar name={row.fromName} number={row.fromNumber} direction={row.direction} />

      {/* Main info */}
      <div className="ch-call-info">
        <div className="ch-call-name">{displayName}</div>
        {hasName && <div className="ch-call-number">{formatPhone(row.fromNumber)}</div>}
        <div className="ch-call-sub">
          {row.rangExtension ? (
            <span className="ch-ext-tag">
              <Phone size={9} /> ext {row.rangExtension}
            </span>
          ) : null}
          {isGlobal && row.tenantName !== "Unassigned" ? (
            <span className="ch-tenant-tag">{row.tenantName}</span>
          ) : null}
          {row.journeySummary && !row.rangExtension ? (
            <span className="ch-call-journey">{row.journeySummary}</span>
          ) : null}
        </div>
      </div>

      {/* Direction + status (center column) */}
      <div className="ch-call-center">
        <div className="ch-dir-tag">
          <DirectionIcon direction={row.direction} size={12} />
          <span>{row.direction === "incoming" ? "Inbound" : row.direction === "outgoing" ? "Outbound" : "Internal"}</span>
        </div>
        <div className={`ch-status-badge ${oc}`}>
          <OutcomeIcon row={row} size={11} />
          {outcomeLabel(row)}
        </div>
      </div>

      {/* Right meta */}
      <div className="ch-call-meta">
        <div className="ch-call-time">{formatTime(row.startedAt)}</div>
        <div className="ch-call-duration">{formatDuration(row.durationSec)}</div>
        {row.recordingAvailable ? (
          <span className="ch-rec-dot" title="Recording available" />
        ) : null}
      </div>

      {/* Quick actions (fade in on hover) */}
      <div className="ch-quick-actions" onClick={(e) => e.stopPropagation()}>
        <a
          className="ch-qa-btn"
          href={`tel:${row.fromNumber}`}
          title="Call back"
          onClick={(e) => e.stopPropagation()}
        >
          <PhoneCall size={13} />
        </a>
        <button className="ch-qa-btn" title="Copy number" onClick={handleCopy}>
          <Copy size={13} />
        </button>
      </div>
    </button>
  );
}

// ─── Call Feed ─────────────────────────────────────────────────────────────

function CallFeed({ items, selectedId, onSelect, isGlobal }: {
  items: CallHistoryRow[];
  selectedId: string | null;
  onSelect: (row: CallHistoryRow) => void;
  isGlobal: boolean;
}) {
  const groups = useMemo(() => groupCalls(items), [items]);

  return (
    <div className="ch-feed-wrap">
      {groups.map((group) => (
        <div key={group.label} className="ch-calls-group">
          <div className="ch-group-header" aria-label={group.label}>
            <span>{group.label}</span>
            <span className="ch-group-count">{group.calls.length}</span>
          </div>
          {group.calls.map((row) => (
            <CallItem
              key={row.rowId}
              row={row}
              isSelected={selectedId === row.rowId}
              onSelect={onSelect}
              isGlobal={isGlobal}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Smart Filter Bar ──────────────────────────────────────────────────────

function FilterBar({
  searchDraft, setSearchDraft,
  activeTab, setActiveTab,
  quickDate, setQuickDate,
  startDate, setStartDate,
  endDate, setEndDate,
  hasRecording, setHasRecording,
  pageSize, setPageSize,
  total,
}: {
  searchDraft: string; setSearchDraft: (v: string) => void;
  activeTab: ActiveTab; setActiveTab: (v: ActiveTab) => void;
  quickDate: QuickDate; setQuickDate: (v: QuickDate) => void;
  startDate: string; setStartDate: (v: string) => void;
  endDate: string; setEndDate: (v: string) => void;
  hasRecording: "all" | "yes" | "no"; setHasRecording: (v: "all" | "yes" | "no") => void;
  pageSize: number; setPageSize: (v: number) => void;
  total: number | null;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const TABS: Array<{ id: ActiveTab; label: string }> = [
    { id: "all", label: "All" },
    { id: "missed", label: "Missed" },
    { id: "answered", label: "Answered" },
    { id: "voicemail", label: "Voicemail" },
    { id: "internal", label: "Internal" },
  ];

  const CHIPS: Array<{ id: QuickDate; label: string }> = [
    { id: "today", label: "Today" },
    { id: "yesterday", label: "Yesterday" },
    { id: "week", label: "Last 7 days" },
  ];

  return (
    <div className="ch-filter-bar">
      {/* Row 1: search + tabs */}
      <div className="ch-filter-row">
        <div className="ch-search-wrap">
          <Search size={14} className="ch-search-icon" />
          <input
            className="ch-search"
            type="search"
            placeholder="Search name, number, extension…"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            aria-label="Search calls"
          />
        </div>
        <div className="ch-tabs" role="tablist" aria-label="Call type filter">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`ch-tab tab-${tab.id}${activeTab === tab.id ? " active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.id !== "all" ? <span className="ch-tab-dot" /> : null}
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Row 2: date chips + advanced toggle + count */}
      <div className="ch-filter-row">
        <div className="ch-chips">
          {CHIPS.map((chip) => (
            <button
              key={chip.id}
              className={`ch-chip${quickDate === chip.id ? " active" : ""}`}
              onClick={() => setQuickDate(chip.id)}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <button
          className={`ch-advanced-btn${showAdvanced ? " open" : ""}`}
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
        >
          <Filter size={12} />
          Advanced
          <ChevronDown size={11} className={`ch-adv-chevron${showAdvanced ? " rotated" : ""}`} />
        </button>
        {total !== null ? (
          <span className="ch-filter-count">
            {total.toLocaleString()} call{total !== 1 ? "s" : ""}
          </span>
        ) : null}
      </div>

      {/* Advanced filters panel */}
      {showAdvanced ? (
        <div className="ch-advanced-row">
          <div className="ch-date-pair">
            <input
              type="date"
              className="ch-date-input"
              value={startDate}
              onChange={(e) => { setStartDate(e.target.value); setQuickDate("custom"); }}
              aria-label="Start date"
            />
            <span className="ch-date-sep">—</span>
            <input
              type="date"
              className="ch-date-input"
              value={endDate}
              onChange={(e) => { setEndDate(e.target.value); setQuickDate("custom"); }}
              aria-label="End date"
            />
          </div>
          <select
            className="ch-filter-select"
            value={hasRecording}
            onChange={(e) => setHasRecording(e.target.value as "all" | "yes" | "no")}
            aria-label="Recording filter"
          >
            <option value="all">All calls</option>
            <option value="yes">Has recording</option>
            <option value="no">No recording</option>
          </select>
          <select
            className="ch-filter-select"
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            aria-label="Page size"
          >
            <option value={50}>50 / page</option>
            <option value={100}>100 / page</option>
            <option value={200}>200 / page</option>
          </select>
          {quickDate === "custom" ? (
            <span className="ch-custom-badge">Custom range</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ─── Call Detail Drawer ────────────────────────────────────────────────────

function CallDetailDrawer({ row, onClose }: { row: CallHistoryRow | null; onClose: () => void }) {
  const [techExpanded, setTechExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const isOpen = Boolean(row);

  useEffect(() => {
    if (row) setTechExpanded(false);
  }, [row?.rowId]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleCopy() {
    if (!row) return;
    navigator.clipboard.writeText(row.fromNumber)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => { /* silent fail */ });
  }

  const token = typeof window !== "undefined"
    ? (localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "")
    : "";

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className={`ch-drawer-backdrop${isOpen ? " open" : ""}`}
        onClick={onClose}
        aria-hidden
      />

      {/* Drawer */}
      <div
        className={`ch-drawer${isOpen ? " open" : ""}`}
        role="dialog"
        aria-modal
        aria-label="Call details"
      >
        {row ? (
          <>
            {/* Drawer header */}
            <div className="ch-dr-header">
              <div className="ch-dr-header-left">
                <div className={`ch-status-badge ${outcomeClass(row)}`}>
                  <OutcomeIcon row={row} size={12} />
                  {outcomeLabel(row)}
                </div>
                <div className="ch-dir-tag" style={{ fontSize: 12 }}>
                  <DirectionIcon direction={row.direction} size={13} />
                  <span>{row.direction === "incoming" ? "Inbound" : row.direction === "outgoing" ? "Outbound" : "Internal"}</span>
                </div>
              </div>
              <button className="ch-dr-close" onClick={onClose} aria-label="Close panel">
                <X size={16} />
              </button>
            </div>

            {/* Scrollable body */}
            <div className="ch-dr-body">

              {/* Contact block */}
              <div className="ch-dr-contact">
                <div className={`ch-avatar ch-dr-avatar dir-${row.direction}`}>
                  {getInitials(row.fromName, row.fromNumber)}
                </div>
                <div className="ch-dr-contact-info">
                  {row.fromName ? <div className="ch-dr-name">{row.fromName}</div> : null}
                  <div className="ch-dr-number">{formatPhone(row.fromNumber)}</div>
                  <div className="ch-dr-from-to">
                    <span>→ {formatPhone(row.toNumber)}</span>
                    {row.tenantName !== "Unassigned" ? (
                      <span className="ch-dr-tenant">
                        <User size={10} /> {row.tenantName}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="ch-dr-section">
                <div className="ch-dr-section-title">Actions</div>
                <div className="ch-dr-actions">
                  <a href={`tel:${row.fromNumber}`} className="ch-dr-action-btn primary">
                    <PhoneCall size={14} /> Call back
                  </a>
                  <button className="ch-dr-action-btn" onClick={handleCopy}>
                    <Copy size={14} />
                    {copied ? "Copied!" : "Copy number"}
                  </button>
                </div>
              </div>

              {/* Call details grid */}
              <div className="ch-dr-section">
                <div className="ch-dr-section-title">Call details</div>
                <div className="ch-dr-grid">
                  <span className="ch-dr-grid-label"><Clock size={11} /> Time</span>
                  <span className="ch-dr-grid-value">{formatAbsTime(row.startedAt)}</span>

                  <span className="ch-dr-grid-label"><Phone size={11} /> Duration</span>
                  <span className="ch-dr-grid-value">{formatDuration(row.durationSec)}</span>

                  {row.talkSec > 0 ? (
                    <>
                      <span className="ch-dr-grid-label"><CheckCircle2 size={11} /> Talk time</span>
                      <span className="ch-dr-grid-value" style={{ color: "var(--console-success)" }}>
                        {formatDuration(row.talkSec)}
                      </span>
                    </>
                  ) : null}

                  <span className="ch-dr-grid-label">
                    <ArrowDown size={11} /> Type
                  </span>
                  <span className="ch-dr-grid-value">
                    {row.direction === "incoming" ? "Inbound" : row.direction === "outgoing" ? "Outbound" : "Internal"}
                  </span>

                  {row.rangExtension ? (
                    <>
                      <span className="ch-dr-grid-label"><Phone size={11} /> Extension</span>
                      <span className="ch-dr-grid-value">{row.rangExtension}</span>
                    </>
                  ) : null}

                  {row.answeredByType ? (
                    <>
                      <span className="ch-dr-grid-label"><User size={11} /> Answered by</span>
                      <span className="ch-dr-grid-value">{row.answeredByType}</span>
                    </>
                  ) : null}
                </div>
              </div>

              {/* Journey summary */}
              {row.journeySummary ? (
                <div className="ch-dr-section">
                  <div className="ch-dr-section-title">Summary</div>
                  <div className={`ch-dr-summary-card outcome-${outcomeClass(row) === "canceled" ? "neutral" : outcomeClass(row)}`}>
                    <span className="ch-dr-summary-icon"><OutcomeIcon row={row} size={14} /></span>
                    <p className="ch-dr-summary-text">{row.journeySummary}</p>
                  </div>
                </div>
              ) : null}

              {/* Journey timeline */}
              {row.journeySteps.length > 0 ? (
                <div className="ch-dr-section">
                  <div className="ch-dr-section-title">Call journey</div>
                  <ol className="ch-dr-timeline">
                    {row.journeySteps.map((step, i) => (
                      <li key={i} className="ch-dr-step">
                        <div className={`ch-dr-step-dot ${step.result}`}>
                          <StepIcon result={step.result} />
                        </div>
                        <div className="ch-dr-step-body">
                          <span className="ch-dr-step-label">{step.label}</span>
                          {step.detail ? <span className="ch-dr-step-detail">{step.detail}</span> : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              {/* Extensions involved */}
              {row.attemptedExtensions.length > 0 ? (
                <div className="ch-dr-section">
                  <div className="ch-dr-section-title">Extensions involved</div>
                  <div className="ch-dr-ext-list">
                    {row.attemptedExtensions.map((ext) => (
                      <span
                        key={ext}
                        className={`ch-dr-ext-chip${row.humanAnswered && row.rangExtension === ext ? " answered" : ""}`}
                      >
                        <Phone size={10} />
                        {ext}
                        {row.humanAnswered && row.rangExtension === ext ? " ✓" : ""}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Recording — audio fetched on-demand (preload="none") */}
              {row.recordingAvailable ? (
                <div className="ch-dr-section">
                  <div className="ch-dr-section-title">
                    <Mic size={11} style={{ display: "inline", verticalAlign: "middle", marginRight: 4 }} />
                    Recording
                  </div>
                  <div className="ch-recording-block">
                    <audio
                      controls
                      preload="none"
                      src={`/api/voice/recording/${encodeURIComponent(row.linkedId)}/stream?token=${token}`}
                    >
                      Your browser does not support audio playback.
                    </audio>
                    <div className="ch-recording-actions">
                      <a
                        className="ch-dr-action-btn"
                        style={{ fontSize: 12, padding: "6px 10px" }}
                        href={`/api/voice/recording/${encodeURIComponent(row.linkedId)}/download?token=${token}`}
                        download
                      >
                        <Download size={12} /> Download
                      </a>
                    </div>
                  </div>
                </div>
              ) : null}

              {/* Technical details (collapsed) */}
              <div className="ch-dr-section">
                <button
                  className="ch-tech-toggle"
                  onClick={() => setTechExpanded((v) => !v)}
                  aria-expanded={techExpanded}
                >
                  <span>Technical details</span>
                  {techExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                {techExpanded ? (
                  <dl className="ch-tech-grid">
                    <dt>Linked ID</dt><dd className="mono">{row.linkedId}</dd>
                    <dt>Disposition</dt><dd>{row.disposition}</dd>
                    {row.finalOutcomeReason ? <><dt>Outcome reason</dt><dd>{row.finalOutcomeReason}</dd></> : null}
                    {row.answeredAt ? <><dt>Answered at</dt><dd>{new Date(row.answeredAt).toLocaleTimeString()}</dd></> : null}
                    {row.endedAt ? <><dt>Ended at</dt><dd>{new Date(row.endedAt).toLocaleTimeString()}</dd></> : null}
                  </dl>
                ) : null}
              </div>

            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

export default function CallsPage() {
  const { adminScope, tenantId } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const telephony = useTelephony();
  const scopedTenantId = isGlobal ? null : tenantId;
  const liveCalls = telephony.callsByTenant(scopedTenantId);

  // ── Filter state ──────────────────────────────────────────────────────────
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<ActiveTab>("all");
  const [quickDate, setQuickDate] = useState<QuickDate>("today");
  const [startDate, setStartDate] = useState(todayDateInput());
  const [endDate, setEndDate] = useState(todayDateInput());
  const [hasRecording, setHasRecording] = useState<"all" | "yes" | "no">("all");
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage] = useState(1);
  const [selectedRow, setSelectedRow] = useState<CallHistoryRow | null>(null);

  // Derive API direction/status from the active tab
  const apiDirection = activeTab === "internal" ? "internal" : "all";
  const apiStatus = activeTab === "missed" ? "missed"
    : (activeTab === "answered" || activeTab === "voicemail") ? "answered"
    : "all";

  // Debounce search input
  useEffect(() => {
    const t = window.setTimeout(() => { setSearch(searchDraft.trim()); setPage(1); }, 220);
    return () => clearTimeout(t);
  }, [searchDraft]);

  // Reset to page 1 when filters change
  useEffect(() => { setPage(1); }, [activeTab, hasRecording, startDate, endDate, adminScope, scopedTenantId]);

  // Sync quick-date chip → startDate/endDate state
  useEffect(() => {
    if (quickDate === "custom") return;
    const today = new Date();
    const todayStr = fmtDate(today);
    if (quickDate === "today") {
      setStartDate(todayStr); setEndDate(todayStr);
    } else if (quickDate === "yesterday") {
      const y = new Date(today); y.setDate(y.getDate() - 1);
      setStartDate(fmtDate(y)); setEndDate(fmtDate(y));
    } else if (quickDate === "week") {
      const w = new Date(today); w.setDate(w.getDate() - 6);
      setStartDate(fmtDate(w)); setEndDate(todayStr);
    }
  }, [quickDate]);

  // Build query string — tenant filtering preserved via scopedTenantId
  const historyQuery = useMemo(() => {
    const { startIso, endIso } = toIsoRange(startDate, endDate);
    const p = new URLSearchParams({
      startDate: startIso, endDate: endIso,
      direction: apiDirection, status: apiStatus,
      page: String(page), pageSize: String(pageSize),
    });
    if (search) p.set("search", search);
    if (scopedTenantId) p.set("tenantId", scopedTenantId);
    if (hasRecording !== "all") p.set("hasRecording", hasRecording);
    return p.toString();
  }, [apiDirection, apiStatus, endDate, hasRecording, page, pageSize, scopedTenantId, search, startDate]);

  const historyState = useAsyncResource<CallHistoryResponse>(
    () => apiGet<CallHistoryResponse>(`/calls/history?${historyQuery}`),
    [historyQuery]
  );

  const history = historyState.status === "success" ? historyState.data : null;

  // Client-side voicemail filter (API returns answered, we narrow further)
  const displayItems = useMemo(() => {
    if (!history) return [];
    if (activeTab === "voicemail") return history.items.filter((r) => r.voicemailAnswered);
    return history.items;
  }, [history, activeTab]);

  // KPIs computed from current page items + total from server
  const kpis = useMemo(() => {
    if (!history) return null;
    const items = history.items;
    const answered = items.filter((r) => r.humanAnswered).length;
    const missed = items.filter((r) => r.status === "missed").length;
    const voicemails = items.filter((r) => r.voicemailAnswered).length;
    const durItems = items.filter((r) => r.durationSec > 0);
    const avgDur = durItems.length
      ? Math.round(durItems.reduce((a, r) => a + r.durationSec, 0) / durItems.length)
      : 0;
    const answeredPct = items.length ? Math.round((answered / items.length) * 100) : 0;
    const missedPct = items.length ? Math.round((missed / items.length) * 100) : 0;
    return { total: history.total, answered, missed, voicemails, avgDur, answeredPct, missedPct };
  }, [history]);

  // Close drawer on Escape
  useEffect(() => {
    if (!selectedRow) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setSelectedRow(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedRow]);

  const isLoading = historyState.status === "loading";

  return (
    <PermissionGate
      permission="can_view_calls"
      fallback={<div className="state-box">You do not have permission to view calls.</div>}
    >
      <div className={`ch-page stack compact-stack${selectedRow ? " drawer-open" : ""}`}>

        <PageHeader
          title="Call History"
          subtitle="All calls routed through the platform."
          badges={
            <>
              <ScopeBadge scope={adminScope === "GLOBAL" ? "GLOBAL" : "TENANT"} />
              <LiveBadge status={telephony.status} />
            </>
          }
        />

        {isGlobal ? <GlobalScopeNotice /> : null}

        {/* ── KPI Cards ─────────────────────────────────────────────────── */}
        <div className="ch-kpi-row">
          {isLoading || !kpis ? (
            <>
              {[...Array(5)].map((_, i) => (
                <div key={i} className="ch-kpi-card ch-kpi-loading-card">
                  <div className="ch-shimmer" style={{ height: 20, width: "55%", marginBottom: 8, borderRadius: 6 }} />
                  <div className="ch-shimmer" style={{ height: 30, width: "75%", borderRadius: 6 }} />
                </div>
              ))}
            </>
          ) : (
            <>
              <KPICard label="Total Calls" value={kpis.total.toLocaleString()} accent="blue" icon={<Phone size={16} />} />
              <KPICard label="Answered" value={`${kpis.answeredPct}%`} accent="green" icon={<CheckCircle2 size={16} />} sub={`${kpis.answered.toLocaleString()} calls`} />
              <KPICard label="Missed" value={`${kpis.missedPct}%`} accent="red" icon={<PhoneMissed size={16} />} sub={`${kpis.missed.toLocaleString()} calls`} />
              <KPICard label="Avg Duration" value={formatDuration(kpis.avgDur)} accent="amber" icon={<Clock size={16} />} />
              <KPICard label="Voicemail" value={kpis.voicemails.toLocaleString()} accent="purple" icon={<Voicemail size={16} />} />
            </>
          )}
        </div>

        {/* ── Live calls strip ──────────────────────────────────────────── */}
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
                    <DirectionIcon direction={dir as CallDirection} size={14} />
                    <span className="calls-live-caller">
                      {call.fromName ? <span className="calls-live-cnam">{call.fromName}</span> : null}
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
        ) : telephony.status === "connected" ? (
          <section className="calls-live-section calls-live-idle" aria-label="Live calls">
            <div className="calls-live-header">
              <span className="calls-live-dot idle" />
              <h3 className="calls-live-title">Live calls</h3>
              <span className="calls-live-idle-label">No active calls right now</span>
            </div>
          </section>
        ) : telephony.status === "failed" ? (
          <section className="calls-live-section calls-live-idle" aria-label="Live calls">
            <div className="calls-live-header">
              <span className="calls-live-dot error" />
              <h3 className="calls-live-title">Live calls</h3>
              <span className="calls-live-idle-label">Connection lost — refresh to reconnect</span>
            </div>
          </section>
        ) : null}

        {/* ── Smart filter bar ──────────────────────────────────────────── */}
        <FilterBar
          searchDraft={searchDraft} setSearchDraft={setSearchDraft}
          activeTab={activeTab} setActiveTab={setActiveTab}
          quickDate={quickDate} setQuickDate={setQuickDate}
          startDate={startDate} setStartDate={setStartDate}
          endDate={endDate} setEndDate={setEndDate}
          hasRecording={hasRecording} setHasRecording={setHasRecording}
          pageSize={pageSize} setPageSize={(v) => { setPageSize(v); setPage(1); }}
          total={history?.total ?? null}
        />

        {/* ── Call history feed ─────────────────────────────────────────── */}
        <section aria-label="Call history">
          {historyState.status === "loading" ? (
            <LoadingSkeleton rows={8} />
          ) : historyState.status === "error" ? (
            <div className="ch-empty">
              <div className="ch-empty-icon" style={{ color: "var(--console-danger)" }}>
                <PhoneOff size={28} />
              </div>
              <p className="ch-empty-title">Could not load call history</p>
              <p className="ch-empty-sub">{historyState.error || "An error occurred. Please try again."}</p>
            </div>
          ) : displayItems.length === 0 ? (
            <div className="ch-empty">
              <div className="ch-empty-icon">
                <Phone size={28} />
              </div>
              <p className="ch-empty-title">
                {activeTab === "all" ? "No calls found" : `No ${activeTab} calls`}
              </p>
              <p className="ch-empty-sub">
                Try adjusting your filters or date range.
              </p>
            </div>
          ) : (
            <>
              <CallFeed
                items={displayItems}
                selectedId={selectedRow?.rowId ?? null}
                onSelect={setSelectedRow}
                isGlobal={isGlobal}
              />

              {/* Pagination */}
              {history && history.totalPages > 1 ? (
                <div className="ch-pagination">
                  <button
                    className="btn ghost btn-sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    ← Previous
                  </button>
                  <span className="ch-page-info">Page {page} of {history.totalPages}</span>
                  <button
                    className="btn ghost btn-sm"
                    disabled={page >= history.totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next →
                  </button>
                </div>
              ) : null}
            </>
          )}
        </section>

        {/* ── Call detail drawer ────────────────────────────────────────── */}
        <CallDetailDrawer row={selectedRow} onClose={() => setSelectedRow(null)} />

      </div>
    </PermissionGate>
  );
}
