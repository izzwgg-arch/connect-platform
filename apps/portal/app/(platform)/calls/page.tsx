"use client";

import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PermissionGate } from "../../../components/PermissionGate";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { apiGet } from "../../../services/apiClient";
import { CRMPageHeader, cn, crm } from "../../../components/crm";
import {
  ArrowDown, ArrowLeftRight, ArrowUp,
  Phone, PhoneOff, PhoneMissed, PhoneIncoming,
  ChevronDown, ChevronRight, Voicemail,
  Radio, CheckCircle2, XCircle, AlertCircle, Info,
  X, Mic, Download, Pause, Play, Volume2,
  Search, MoreHorizontal, Copy, SlidersHorizontal, PhoneCall,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

type CallDirection = "incoming" | "outgoing" | "internal";
type CallStatus = "answered" | "missed" | "canceled" | "failed";
type AnsweredByType = "human" | "ivr" | "voicemail" | "system" | null;
type FeedTab = "all" | "answered" | "missed" | "voicemail";
type DirectionFilter = "all" | CallDirection;
type DatePreset = "today" | "yesterday" | "last7" | "custom";

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

function buildCallHistoryPreview(): CallHistoryResponse {
  const names = ["Avery Stone", "Jordan Hayes", "Morgan River", "Northstar Desk", "Harbor Retail", "Crescent Auto"];
  const rows: CallHistoryRow[] = Array.from({ length: 36 }, (_, index) => {
    const direction: CallDirection = index % 5 === 0 ? "outgoing" : index % 4 === 0 ? "internal" : "incoming";
    const voicemailAnswered = index % 7 === 0;
    const missed = index % 6 === 0 && !voicemailAnswered;
    const status: CallStatus = missed ? "missed" : index % 11 === 0 ? "canceled" : "answered";
    const startedAt = new Date(Date.now() - index * 37 * 60_000).toISOString();
    const durationSec = status === "answered" ? 48 + ((index * 17) % 420) : 0;
    return {
      callId: `preview-call-${index + 1}`,
      rowId: `preview-row-${index + 1}`,
      linkedId: `preview-linked-${Math.floor(index / 2)}`,
      fromNumber: direction === "outgoing" ? "220" : `+1555901${String(index).padStart(4, "0")}`,
      fromName: direction === "outgoing" ? "Local Dev" : names[index % names.length],
      toNumber: direction === "outgoing" ? `+1555902${String(index).padStart(4, "0")}` : index % 3 === 0 ? "Sales Queue" : "220",
      direction,
      status,
      disposition: status === "answered" ? "ANSWERED" : status.toUpperCase(),
      durationSec,
      talkSec: Math.max(0, durationSec - 12),
      startedAt,
      answeredAt: status === "answered" ? new Date(new Date(startedAt).getTime() + 12_000).toISOString() : null,
      endedAt: new Date(new Date(startedAt).getTime() + Math.max(25, durationSec) * 1000).toISOString(),
      tenantId: "preview-tenant",
      tenantName: "Local Dev Workspace",
      rangExtension: direction === "incoming" ? String(220 + (index % 8)) : null,
      recordingAvailable: status === "answered" && index % 3 !== 0,
      recordingPath: status === "answered" && index % 3 !== 0 ? `/preview/recordings/${index + 1}.wav` : null,
      answeredByType: voicemailAnswered ? "voicemail" : status === "answered" ? "human" : null,
      humanAnswered: status === "answered" && !voicemailAnswered,
      ivrAnswered: direction === "incoming" && index % 4 === 0,
      voicemailAnswered,
      attemptedExtensions: direction === "incoming" ? [String(220 + (index % 8)), String(230 + (index % 5))] : [],
      journeySummary: voicemailAnswered ? "Caller reached voicemail after queue timeout" : status === "answered" ? "Connected to agent" : "No answer",
      finalOutcomeReason: voicemailAnswered ? "voicemail" : status,
      journeySteps: [
        { label: "Call received", detail: direction, result: "info" },
        { label: status === "answered" ? "Answered" : "No answer", detail: voicemailAnswered ? "Sent to voicemail" : undefined, result: status === "answered" ? "ok" : "missed" },
      ],
    };
  });
  return {
    items: rows,
    total: rows.length,
    showing: rows.length,
    page: 1,
    pageSize: rows.length,
    totalPages: 1,
    totalsByDirection: {
      incoming: rows.filter((row) => row.direction === "incoming").length,
      outgoing: rows.filter((row) => row.direction === "outgoing").length,
      internal: rows.filter((row) => row.direction === "internal").length,
      total: rows.length,
    },
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function todayDateInput(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function dateInputFor(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
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

function smartTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const isYest = d.toDateString() === yest.toDateString();
  const timePart = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (isToday) return timePart;
  if (isYest) return `Yest. ${timePart}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

function CallKpiTile({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string | number;
  icon: ReactNode;
  tone: "blue" | "green" | "violet" | "amber" | "rose" | "cyan";
}) {
  return (
    <div className={cn(crm.queueCountPill, `crm-queue-kpi-${tone}`, "relative overflow-hidden bg-crm-surface-2")}>
      <span className="flex w-full items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">{label}</span>
          <span className="crm-queue-kpi-value mt-1 block text-2xl font-bold tabular-nums leading-none tracking-tight text-crm-text">
            {value}
          </span>
        </span>
        <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
          {icon}
        </span>
      </span>
    </div>
  );
}

function callDescription(row: CallHistoryRow): string {
  const dir = row.direction === "incoming" ? "Incoming" : row.direction === "outgoing" ? "Outgoing" : "Internal";
  if (row.voicemailAnswered) return `${dir} · Voicemail`;
  if (row.humanAnswered) return `${dir} · Answered`;
  if (row.ivrAnswered && !row.humanAnswered && row.status === "missed") return `${dir} · IVR then missed`;
  if (row.ivrAnswered && !row.humanAnswered) return `${dir} · IVR only`;
  if (row.status === "missed") return `${dir} · Missed`;
  if (row.status === "canceled") return `${dir} · Canceled`;
  if (row.status === "failed") return `${dir} · Failed`;
  return dir;
}

type CallGroup = { key: string; label: string; items: CallHistoryRow[] };

function groupCalls(items: CallHistoryRow[]): CallGroup[] {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today.getTime() - 86_400_000);
  const groups = new Map<string, CallGroup>();
  for (const row of items) {
    const d = new Date(row.startedAt); d.setHours(0, 0, 0, 0);
    let key: string; let label: string;
    if (d.getTime() === today.getTime()) { key = "today"; label = "Today"; }
    else if (d.getTime() === yesterday.getTime()) { key = "yesterday"; label = "Yesterday"; }
    else {
      key = d.toISOString().slice(0, 10);
      label = d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    }
    if (!groups.has(key)) groups.set(key, { key, label, items: [] });
    groups.get(key)!.items.push(row);
  }
  return [...groups.values()];
}

// ─── Direction & outcome helpers ──────────────────────────────────────────────

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

// ─── Avatar ───────────────────────────────────────────────────────────────────

function CallAvatar({ row }: { row: CallHistoryRow }) {
  const { direction, fromName, voicemailAnswered, status } = row;
  const dotClass = voicemailAnswered ? "voicemail" : status === "missed" ? "missed" : direction;

  let initials: string | null = null;
  if (direction === "incoming" && fromName) {
    const parts = fromName.trim().split(/\s+/);
    initials = parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : fromName.slice(0, 2).toUpperCase();
  }

  return (
    <div className={`ch-avatar ${direction}`} aria-hidden="true">
      {initials ? initials : (
        direction === "incoming" ? <PhoneIncoming size={17} /> :
        direction === "outgoing" ? <Phone size={17} /> :
        <ArrowLeftRight size={17} />
      )}
      <span className={`ch-avatar-dot ${dotClass}`} />
    </div>
  );
}

// ─── Feed item ────────────────────────────────────────────────────────────────

function CallFeedItem({
  row,
  isSelected,
  onClick,
  isGlobal,
  onCopy,
}: {
  row: CallHistoryRow;
  isSelected: boolean;
  onClick: () => void;
  isGlobal: boolean;
  onCopy: (num: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const contactNumber = row.direction === "outgoing" ? row.toNumber : row.fromNumber;

  const displayName =
    row.direction === "incoming" && row.fromName
      ? row.fromName
      : row.direction === "outgoing"
        ? formatPhone(row.toNumber)
        : formatPhone(row.fromNumber);

  function dialBack() {
    window.dispatchEvent(new CustomEvent("crm:dial", { detail: { target: contactNumber } }));
    setMenuOpen(false);
  }

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  return (
    <div
      className={`ch-item ${isSelected ? "selected" : ""} ${row.status === "missed" ? "is-missed-call" : ""}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      aria-label={`${callDescription(row)} — ${displayName}`}
    >
      <CallAvatar row={row} />

      <div className="ch-item-main">
        <div className="ch-item-name">
          {displayName}
          {isGlobal && row.tenantName !== "Unassigned" ? (
            <span className="ch-item-tenant"> · {row.tenantName}</span>
          ) : null}
        </div>
        <div className="ch-item-sub">
          <span className={`ch-item-status ${outcomeClass(row)}`}>
            <OutcomeIcon row={row} />
            {callDescription(row)}
          </span>
          {row.rangExtension ? (
            <>
              <span className="ch-item-sub-sep" aria-hidden="true">·</span>
              <span className="ch-item-ext">ext {row.rangExtension}</span>
            </>
          ) : null}
        </div>
        {row.journeySummary ? (
          <div className="ch-item-journey">{row.journeySummary}</div>
        ) : null}
      </div>

      <div className="ch-item-right">
        <span className="ch-item-time">{smartTime(row.startedAt)}</span>
        <span className="ch-item-duration">{formatDuration(row.durationSec)}</span>
        <div className="ch-item-actions" onClick={(e) => e.stopPropagation()}>
          {row.recordingAvailable ? (
            <button
              className="ch-action-btn rec"
              title="Open recording"
              onClick={(e) => { e.stopPropagation(); onClick(); }}
            >
              <Mic size={13} />
            </button>
          ) : null}
          <div className="ch-menu-wrap" ref={menuRef}>
            <button
              className="ch-action-btn"
              title="More actions"
              aria-label="More actions"
              onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            >
              <MoreHorizontal size={13} />
            </button>
            {menuOpen ? (
              <div className="ch-menu" role="menu">
                <button
                  type="button"
                  className="ch-menu-item"
                  onClick={(e) => { e.stopPropagation(); dialBack(); }}
                  role="menuitem"
                >
                  <PhoneCall size={14} />
                  Call back
                </button>
                <button
                  className="ch-menu-item"
                  role="menuitem"
                  onClick={(e) => { e.stopPropagation(); onCopy(contactNumber); setMenuOpen(false); }}
                >
                  <Copy size={14} />
                  Copy number
                </button>
                <button
                  className="ch-menu-item"
                  role="menuitem"
                  onClick={(e) => { e.stopPropagation(); onClick(); setMenuOpen(false); }}
                >
                  <ChevronRight size={14} />
                  View details
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function CallDetailPanel({ row, onClose }: { row: CallHistoryRow; onClose: () => void }) {
  const { can } = useAppContext();
  // Listening to a recording requires the "View Recordings" action permission
  // (can_view_recordings); downloading additionally requires can_download_recordings.
  // Gate on the ACTION key can_view_recordings — NOT the sidebar-item key
  // can_view_pbx_call_recordings — because custom roles resolve permissions
  // literally with no legacy expansion, so a role granting "View Recordings"
  // exposes can_view_recordings only. The server enforces both with an owner
  // carve-out (your own extension's recordings stay playable/downloadable).
  const canViewRecordings = can("can_view_recordings");
  const canDownloadRecording = can("can_download_recordings");
  const [techExpanded, setTechExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const dir = row.direction;

  const contactName = dir === "incoming"
    ? (row.fromName || formatPhone(row.fromNumber))
    : formatPhone(row.toNumber);
  const contactNumber = dir === "outgoing" ? row.toNumber : row.fromNumber;

  function heroInitials(): string | null {
    if (dir !== "incoming" || !row.fromName) return null;
    const parts = row.fromName.trim().split(/\s+/);
    return parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : row.fromName.slice(0, 2).toUpperCase();
  }

  function copyNumber() {
    if (typeof navigator === "undefined") return;
    navigator.clipboard.writeText(contactNumber).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  function dialBack() {
    window.dispatchEvent(new CustomEvent("crm:dial", { detail: { target: contactNumber } }));
  }

  const initials = heroInitials();
  const recordingToken = typeof window !== "undefined" ? (localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "") : "";
  const recordingStreamSrc = `/api/voice/recording/${encodeURIComponent(row.linkedId)}/stream?token=${recordingToken}`;
  const recordingDownloadSrc = `/api/voice/recording/${encodeURIComponent(row.linkedId)}/download?token=${recordingToken}`;

  return (
      <aside className="call-detail-panel ch-detail-panel custom-scrollbar" aria-label="Call details">

        {/* Sticky header */}
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

        {/* Hero */}
        <div className="cdp-hero">
          <div className={`cdp-hero-avatar ${dir}`}>
            {initials ? initials : <Phone size={22} />}
          </div>
          <div className="cdp-hero-body">
            <div className="cdp-hero-name">{contactName}</div>
            <div className="cdp-hero-number">{formatPhone(contactNumber)}</div>
            <div className="cdp-hero-time">{formatAbsTime(row.startedAt)}</div>
            <div className="cdp-hero-actions">
              <button type="button" className="cdp-hero-action-btn" onClick={dialBack}>
                <PhoneCall size={13} />
                Call back
              </button>
              <button className="cdp-hero-action-btn" onClick={copyNumber}>
                <Copy size={13} />
                {copied ? "Copied!" : "Copy number"}
              </button>
              {row.recordingAvailable ? (
                <span className="cdp-hero-rec-badge">
                  <Mic size={12} />
                  Recording
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {/* Info grid */}
        <div className="cdp-info-grid">
          <div className="cdp-info-item">
            <span className="cdp-info-label">Direction</span>
            <span className="cdp-info-value">
              {dir === "incoming" ? "Inbound" : dir === "outgoing" ? "Outbound" : "Internal"}
            </span>
          </div>
          <div className="cdp-info-item">
            <span className="cdp-info-label">Status</span>
            <span className={`cdp-info-value cdp-info-status ${outcomeClass(row)}`}>{outcomeLabel(row)}</span>
          </div>
          <div className="cdp-info-item">
            <span className="cdp-info-label">Duration</span>
            <span className="cdp-info-value">{formatDuration(row.durationSec)}</span>
          </div>
          {row.talkSec > 0 ? (
            <div className="cdp-info-item">
              <span className="cdp-info-label">Talk time</span>
              <span className="cdp-info-value">{formatDuration(row.talkSec)}</span>
            </div>
          ) : null}
          {row.answeredByType ? (
            <div className="cdp-info-item">
              <span className="cdp-info-label">Answered by</span>
              <span className="cdp-info-value" style={{ textTransform: "capitalize" }}>{row.answeredByType}</span>
            </div>
          ) : null}
          {row.rangExtension ? (
            <div className="cdp-info-item">
              <span className="cdp-info-label">Extension</span>
              <span className="cdp-info-value">ext {row.rangExtension}</span>
            </div>
          ) : null}
          {row.tenantName && row.tenantName !== "Unassigned" ? (
            <div className="cdp-info-item">
              <span className="cdp-info-label">Tenant</span>
              <span className="cdp-info-value">{row.tenantName}</span>
            </div>
          ) : null}
          {row.endedAt ? (
            <div className="cdp-info-item">
              <span className="cdp-info-label">Ended at</span>
              <span className="cdp-info-value">{new Date(row.endedAt).toLocaleTimeString()}</span>
            </div>
          ) : null}
        </div>

        {/* Outcome summary */}
        <div className={`cdp-outcome-card ${outcomeClass(row)}`}>
          <div className="cdp-outcome-icon-wrap"><OutcomeIcon row={row} /></div>
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

        {/* Extensions involved */}
        {row.attemptedExtensions.length > 0 ? (
          <div className="cdp-section">
            <h4 className="cdp-section-title">Extensions involved</h4>
            <div className="cdp-ext-list">
              {row.attemptedExtensions.map((ext) => (
                <span
                  key={ext}
                  className={`cdp-ext-chip ${row.humanAnswered && row.rangExtension === ext ? "answered" : "rang"}`}
                >
                  <Phone size={11} />
                  {ext}
                  {row.humanAnswered && row.rangExtension === ext ? " ✓" : ""}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {/* Recording — preload="none" so opening the panel does NOT trigger a PBX request until play */}
        {row.recordingAvailable && canViewRecordings ? (
          <div className="cdp-section">
            <h4 className="cdp-section-title">
              <Mic size={14} style={{ marginRight: 4, verticalAlign: "middle" }} />
              Recording
            </h4>
            <div className="cdp-recording-player">
              <CallRecordingPlayer src={recordingStreamSrc} />
              {canDownloadRecording ? (
                <a
                  className="cdp-recording-download"
                  href={recordingDownloadSrc}
                  download
                >
                  <Download size={13} />
                  Download
                </a>
              ) : null}
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
      </aside>
  );
}

function formatPlayerTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function CallRecordingPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  }

  function seek(value: string) {
    const next = Number(value);
    const audio = audioRef.current;
    setCurrent(next);
    if (audio && Number.isFinite(next)) audio.currentTime = next;
  }

  const progress = duration > 0 ? (current / duration) * 100 : 0;

  return (
    <div className="cdp-custom-audio">
      <audio
        ref={audioRef}
        preload="none"
        src={src}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime || 0)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <button type="button" className="cdp-custom-audio-play" onClick={togglePlayback} aria-label={playing ? "Pause recording" : "Play recording"}>
        {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      <span className="cdp-custom-audio-time">
        {formatPlayerTime(current)} / {formatPlayerTime(duration)}
      </span>
      <label className="cdp-custom-audio-track" aria-label="Recording progress">
        <span style={{ width: `${progress}%` }} />
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={duration ? current : 0}
          onChange={(event) => seek(event.currentTarget.value)}
        />
      </label>
      <Volume2 className="cdp-custom-audio-volume" size={16} aria-hidden />
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const TABS: { id: FeedTab; label: string }[] = [
  { id: "all",      label: "All" },
  { id: "answered", label: "Answered" },
  { id: "missed",   label: "Missed" },
  { id: "voicemail",label: "Voicemail" },
];

const DIRECTION_FILTERS: { id: DirectionFilter; label: string }[] = [
  { id: "all",      label: "All directions" },
  { id: "incoming", label: "Incoming" },
  { id: "outgoing", label: "Outgoing" },
  { id: "internal", label: "Internal" },
];

const DATE_PRESETS: { id: DatePreset; label: string }[] = [
  { id: "today",     label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last7",     label: "Last 7 days" },
];

export default function CallsPage() {
  const { adminScope, tenantId } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const scopedTenantId = isGlobal ? null : tenantId;

  // Filter state
  const [searchDraft, setSearchDraft]   = useState("");
  const [search, setSearch]             = useState("");
  const [activeTab, setActiveTab]       = useState<FeedTab>("all");
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [datePreset, setDatePreset]     = useState<DatePreset>("today");
  const [startDate, setStartDate]       = useState(todayDateInput());
  const [endDate, setEndDate]           = useState(todayDateInput());
  const [hasRecording, setHasRecording] = useState<"all" | "yes" | "no">("all");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pageSize, setPageSize]         = useState(100);
  const [page, setPage]                 = useState(1);
  const [selectedRow, setSelectedRow]   = useState<CallHistoryRow | null>(null);
  const [copyToast, setCopyToast]       = useState<string | null>(null);

  // Search debounce
  useEffect(() => {
    const t = window.setTimeout(() => { setSearch(searchDraft.trim()); setPage(1); }, 220);
    return () => clearTimeout(t);
  }, [searchDraft]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [activeTab, directionFilter, hasRecording, startDate, endDate, adminScope, scopedTenantId]);

  // Date preset → update date range
  useEffect(() => {
    if (datePreset === "today")     { const t = todayDateInput(); setStartDate(t); setEndDate(t); }
    if (datePreset === "yesterday") { const y = dateInputFor(1);  setStartDate(y); setEndDate(y); }
    if (datePreset === "last7")     { setStartDate(dateInputFor(6)); setEndDate(todayDateInput()); }
  }, [datePreset]);

  // Build API query — tenant filtering is preserved via scopedTenantId param
  const historyQuery = useMemo(() => {
    const { startIso, endIso } = toIsoRange(startDate, endDate);
    const stat = activeTab === "missed" ? "missed"
      : (activeTab === "answered" || activeTab === "voicemail") ? "answered"
      : "all";
    const p = new URLSearchParams({
      startDate: startIso, endDate: endIso,
      direction: directionFilter, status: stat,
      page: String(page), pageSize: String(pageSize),
    });
    if (search) p.set("search", search);
    if (scopedTenantId) p.set("tenantId", scopedTenantId);
    if (hasRecording !== "all") p.set("hasRecording", hasRecording);
    return p.toString();
  }, [activeTab, directionFilter, endDate, hasRecording, page, pageSize, scopedTenantId, search, startDate]);

  const historyState = useAsyncResource<CallHistoryResponse>(
    () => apiGet<CallHistoryResponse>(`/calls/history?${historyQuery}`),
    [historyQuery],
  );

  const history = historyState.status === "success"
    ? historyState.data.items.length < 24 && process.env.NODE_ENV === "development"
      ? (() => {
          const preview = buildCallHistoryPreview();
          const existingIds = new Set(historyState.data.items.map((row) => row.rowId));
          const items = [
            ...historyState.data.items,
            ...preview.items.filter((row) => !existingIds.has(row.rowId)).slice(0, 36 - historyState.data.items.length),
          ];
          return { ...historyState.data, items, total: Math.max(historyState.data.total, items.length), showing: items.length, totalPages: Math.max(historyState.data.totalPages, 1) };
        })()
      : historyState.data
    : null;

  // Client-side voicemail filter (API has no voicemail-only filter param)
  const rawItems    = history?.items ?? [];
  const displayItems = activeTab === "voicemail"
    ? rawItems.filter((r) => r.voicemailAnswered)
    : rawItems;

  // Group feed by date
  const groups = useMemo(() => groupCalls(displayItems), [displayItems]);

  // KPI stats — computed from current page for "this filter" context
  const kpiStats = useMemo(() => {
    if (!rawItems.length) {
      return {
        total: history?.total ?? 0,
        answeredPct: 0,
        missedPct: 0,
        avgDuration: 0,
        voicemails: 0,
      };
    }
    const answered  = rawItems.filter((r) => r.humanAnswered).length;
    const missed    = rawItems.filter((r) => r.status === "missed").length;
    const voicemails = rawItems.filter((r) => r.voicemailAnswered).length;
    const avgDur    = Math.round(rawItems.reduce((a, r) => a + (r.durationSec || 0), 0) / rawItems.length);
    return {
      total:       history?.total ?? rawItems.length,
      answeredPct: Math.round((answered  / rawItems.length) * 100),
      missedPct:   Math.round((missed    / rawItems.length) * 100),
      avgDuration: avgDur,
      voicemails,
    };
  }, [rawItems, history?.total]);

  // Escape closes detail panel
  useEffect(() => {
    if (!selectedRow) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setSelectedRow(null); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [selectedRow]);

  function handleCopy(num: string) {
    if (typeof navigator === "undefined") return;
    navigator.clipboard.writeText(num).then(() => {
      setCopyToast("Number copied!");
      setTimeout(() => setCopyToast(null), 2000);
    }).catch(() => {});
  }

  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have permission to view calls.</div>}>
      <div className="ch-shell crm-queue-workspace crm-calls-workspace">
        <header className="ch-hero crm-workspace-header">
          <CRMPageHeader
            compact
            className={cn(crm.contactsHeaderPanel, "campaigns-command-header")}
            icon={<PhoneCall className="h-6 w-6" aria-hidden />}
            title="Call History"
          />
        </header>

        <div className="ch-toolbar crm-workspace-toolbar">
          {/* ── KPI bar ── */}
          {historyState.status === "success" && kpiStats ? (
            <section className="ch-kpi-bar crm-queue-kpi-strip grid w-full grid-cols-2 items-stretch gap-3 md:grid-cols-4 xl:grid-cols-4" aria-label="Call statistics">
              <CallKpiTile label="Total Calls" value={kpiStats.total.toLocaleString()} tone="blue" icon={<PhoneCall className="h-4 w-4" />} />
              <CallKpiTile label="Answered" value={`${kpiStats.answeredPct}%`} tone="green" icon={<CheckCircle2 className="h-4 w-4" />} />
              <CallKpiTile label="Missed" value={`${kpiStats.missedPct}%`} tone="rose" icon={<PhoneMissed className="h-4 w-4" />} />
              <CallKpiTile label="Avg Duration" value={formatDuration(kpiStats.avgDuration)} tone="amber" icon={<AlertCircle className="h-4 w-4" />} />
            </section>
          ) : historyState.status === "loading" ? (
            <div className="ch-kpi-bar ch-kpi-bar--loading crm-queue-kpi-strip" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className={cn(crm.queueCountPill, "crm-queue-kpi-card ch-kpi-skeleton")}>
                  <div className="ch-kpi-skeleton-val" />
                  <div className="ch-kpi-skeleton-lbl" />
                </div>
              ))}
            </div>
          ) : null}

        {/* ── Smart filter bar ── */}
        <section className="ch-filter-bar campaigns-filter-panel crm-queue-filter-bar" aria-label="Filters">
          <div className="ch-filter-top">
            {/* Search */}
            <div className="ch-search-wrap">
              <Search size={14} className="ch-search-icon" aria-hidden="true" />
              <input
                className="ch-search-input"
                type="search"
                placeholder="Search by name, number, extension…"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                aria-label="Search calls"
              />
            </div>

            {/* Outcome tabs */}
            <div className="ch-tab-row" role="tablist" aria-label="Filter by outcome">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  className={`ch-tab ${activeTab === tab.id ? "active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Direction tabs */}
            <div className="ch-direction-row" role="group" aria-label="Filter by direction">
              {DIRECTION_FILTERS.map((direction) => (
                <button
                  key={direction.id}
                  className={`ch-direction-chip ${directionFilter === direction.id ? "active" : ""}`}
                  onClick={() => setDirectionFilter(direction.id)}
                  type="button"
                  aria-pressed={directionFilter === direction.id}
                >
                  {direction.label}
                </button>
              ))}
            </div>

            {/* Date chips */}
            <div className="ch-chip-row" role="group" aria-label="Date range presets">
              {DATE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  className={`ch-chip ${datePreset === preset.id ? "active" : ""}`}
                  onClick={() => setDatePreset(preset.id)}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            {/* Advanced toggle */}
            <button
              className={`ch-adv-toggle ${advancedOpen ? "open" : ""}`}
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
            >
              <SlidersHorizontal size={13} />
              <span>Filters</span>
              <ChevronDown size={12} className={`ch-adv-chevron ${advancedOpen ? "up" : ""}`} />
            </button>

            {/* Total count */}
            {history ? (
              <span className="calls-filter-count">
                {history.total.toLocaleString()} call{history.total !== 1 ? "s" : ""}
              </span>
            ) : null}
          </div>

          {/* Advanced panel */}
          {advancedOpen ? (
            <div className="ch-adv-panel">
              <div className="ch-adv-row">
                <label className="ch-adv-label">Custom date range</label>
                <div className="calls-date-range">
                  <input
                    type="date"
                    className="calls-date-input"
                    value={startDate}
                    onChange={(e) => { setStartDate(e.target.value); setDatePreset("custom"); }}
                    aria-label="Start date"
                  />
                  <span className="calls-date-sep">—</span>
                  <input
                    type="date"
                    className="calls-date-input"
                    value={endDate}
                    onChange={(e) => { setEndDate(e.target.value); setDatePreset("custom"); }}
                    aria-label="End date"
                  />
                </div>
              </div>
              <div className="ch-adv-row">
                <label className="ch-adv-label">Recording</label>
                <select
                  className="calls-filter-select"
                  value={hasRecording}
                  onChange={(e) => setHasRecording(e.target.value as typeof hasRecording)}
                  aria-label="Recording filter"
                >
                  <option value="all">All calls</option>
                  <option value="yes">Has recording</option>
                  <option value="no">No recording</option>
                </select>
              </div>
              <div className="ch-adv-row">
                <label className="ch-adv-label">Per page</label>
                <select
                  className="calls-filter-select"
                  value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                  aria-label="Page size"
                >
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                </select>
              </div>
            </div>
          ) : null}
        </section>
        </div>

        <main className={`ch-workspace ${selectedRow ? "has-detail" : ""}`}>
          {/* ── Call feed ── */}
          <section className="calls-history-section ch-feed-pane custom-scrollbar" aria-label="Call history">
            {historyState.status === "loading" ? <LoadingSkeleton rows={8} /> : null}
            {historyState.status === "error" ? (
              <ErrorState message={historyState.error || "Could not load call history."} />
            ) : null}

            {historyState.status === "success" && displayItems.length === 0 ? (
              <div className="ch-empty">
                <EmptyState
                  title={activeTab === "voicemail" ? "No voicemails" : "No calls found"}
                  message={
                    search || activeTab !== "all" || directionFilter !== "all"
                      ? "Try adjusting your filters or search query."
                      : "No calls recorded for this period."
                  }
                />
              </div>
            ) : null}

            {historyState.status === "success" && displayItems.length > 0 ? (
              <div className="ch-feed">
                {groups.map((group) => (
                  <div key={group.key} className="ch-group">
                    <div className="ch-group-header" aria-label={group.label}>
                      <span className="ch-group-label">{group.label}</span>
                      <span className="ch-group-count">{group.items.length}</span>
                      <div className="ch-group-line" aria-hidden="true" />
                    </div>
                    <div className="ch-group-items">
                      {group.items.map((row) => (
                        <CallFeedItem
                          key={row.rowId}
                          row={row}
                          isSelected={selectedRow?.rowId === row.rowId}
                          onClick={() => setSelectedRow(row)}
                          isGlobal={isGlobal}
                          onCopy={handleCopy}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Pagination */}
            {history && history.totalPages > 1 ? (
              <div className="calls-pagination">
                <button className="btn ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
                <span className="calls-page-info">Page {page} of {history.totalPages}</span>
                <button className="btn ghost btn-sm" disabled={page >= history.totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            ) : null}
          </section>

          {selectedRow ? (
            <CallDetailPanel row={selectedRow} onClose={() => setSelectedRow(null)} />
          ) : (
            <aside className="ch-detail-placeholder custom-scrollbar">
              <PhoneIncoming size={26} />
              <h2>Select a call</h2>
              <p>Open a conversation to review routing, outcomes, recordings, technical details, and follow-up actions.</p>
            </aside>
          )}
        </main>

        {/* Copy toast */}
        {copyToast ? <div className="ch-copy-toast" role="status">{copyToast}</div> : null}

      </div>
    </PermissionGate>
  );
}
