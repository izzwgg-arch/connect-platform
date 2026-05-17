"use client";

import { Suspense, useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ListOrdered, PhoneCall, ExternalLink, SkipForward, Clock, Ban,
  RefreshCw, CheckCheck, CalendarClock, UserCheck, X, Edit2,
  AlertCircle, Zap, ZapOff, Pause, Play, ArrowRight,
  PhoneMissed, Voicemail, ThumbsUp, ThumbsDown, CheckCircle2,
  Sparkles, Megaphone,
} from "lucide-react";
import {
  CRMPageShell,
  CRMPageHeader,
  CRMActionBar,
  crm,
  cn,
  QueueOperationalRow,
  QueueOverviewPanel,
  QueueAttentionPanel,
  QueuePowerSessionBar,
  QueueEmptyOperational,
  QueueCountPill,
  type QueueOperationalStats,
} from "../../../../components/crm";
import { MEMBER_STATUS_COLORS, MEMBER_STATUS_LABELS } from "../../../../components/crm/queue/queueUtils";
import { apiGet, apiPatch, apiPost } from "../../../../services/apiClient";
import { useSipPhone } from "../../../../hooks/useSipPhone";

// ── Types ──────────────────────────────────────────────────────────────────────

type MemberStatus = "PENDING" | "IN_PROGRESS" | "CONTACTED" | "CALLBACK" | "CONVERTED" | "SKIPPED" | "DO_NOT_CALL";

type QueueMember = {
  id: string;
  contactId: string;
  /** false when the linked contact is archived/inactive — server excludes these from queue; UI fallback only */
  queueWorkEligible?: boolean;
  contact: {
    id: string;
    displayName: string;
    active?: boolean;
    archivedAt?: string | null;
    primaryPhone: string | null;
    primaryEmail: string | null;
    crmStage: string | null;
    lastActivityAt: string | null;
    lastDisposition: string | null;
    lastDispositionAt: string | null;
  } | null;
  campaign: { id: string; name: string; priority: string; scriptId: string | null; checklistId: string | null } | null;
  status: MemberStatus;
  attemptCount: number;
  lastAttemptAt: string | null;
  callbackAt: string | null;
  callbackNote: string | null;
  sortOrder: number;
  createdAt?: string;
};

type QueueCounts = { pending: number; due: number; overdue: number; upcoming: number };

type QueueFilter = "pending" | "due" | "overdue" | "upcoming";

type CampaignOption = { id: string; name: string; memberCount?: number };

type CrmSettingsDefaults = { defaultQueueSort: string; defaultQueueFilter: string };

// ── Constants ──────────────────────────────────────────────────────────────────

const PAUSE_STORAGE_KEY = "crm_power_queue_paused";
const SORT_MODE_KEY = "crm_queue_sort_mode";
const CAMPAIGN_FILTER_KEY = "crm_queue_campaign_id";
const WRAP_UP_SECONDS = 5;

type SortMode = "smart" | "original";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Queue list is filtered server-side; this is a safety net if a stale row appears */
function isQueueMemberActionable(m: QueueMember): boolean {
  return m.queueWorkEligible !== false;
}

function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function callbackTimeLabel(iso: string): { label: string; urgent: boolean } {
  const d = new Date(iso);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  const absDiff = Math.abs(diff) / 1000;

  if (diff < -86400) return { label: `Overdue ${Math.floor(absDiff / 86400)}d`, urgent: true };
  if (diff < 0) return { label: `Overdue ${Math.floor(absDiff / 3600)}h ${Math.floor((absDiff % 3600) / 60)}m`, urgent: true };
  if (diff < 3600) return { label: `Due in ${Math.floor(diff / 1000 / 60)}m`, urgent: false };
  if (diff < 86400) return { label: `Due in ${Math.floor(diff / 1000 / 3600)}h`, urgent: false };
  const dStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const tStr = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return { label: `${dStr} at ${tStr}`, urgent: false };
}

function priorityReason(member: QueueMember): string | null {
  if (member.status === "CALLBACK" && member.callbackAt) {
    const diff = new Date(member.callbackAt).getTime() - Date.now();
    if (diff < 0) return "Overdue callback";
    const hours = diff / 3600_000;
    if (hours <= 24) return "Due today";
    return "Scheduled callback";
  }
  const cp = member.campaign?.priority ?? "NORMAL";
  if (member.attemptCount === 0) {
    if (cp === "URGENT") return "Urgent campaign · fresh lead";
    if (cp === "HIGH") return "High priority · fresh lead";
    return "Fresh lead, no attempts";
  }
  if (member.attemptCount <= 3) {
    if (cp === "URGENT") return "Urgent campaign · fewer attempts";
    if (cp === "HIGH") return "High priority · fewer attempts";
    return "Fewer attempts";
  }
  if (cp === "URGENT") return "Urgent campaign";
  if (cp === "HIGH") return "High priority campaign";
  return null;
}

// ── Set Callback Modal ─────────────────────────────────────────────────────────

function SetCallbackModal({ member, onClose, onSaved }: {
  member: QueueMember; onClose: () => void; onSaved: () => void;
}) {
  const defaultDatetime = (() => {
    const d = member.callbackAt ? new Date(member.callbackAt) : new Date(Date.now() + 3600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();

  const [datetime, setDatetime] = useState(defaultDatetime);
  const [note, setNote] = useState(member.callbackNote ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;

  async function handleSave() {
    if (!datetime) return;
    setSaving(true);
    setError("");
    try {
      await apiPatch(`/crm/queue/${member.id}`, {
        action: "set-callback",
        callbackAt: new Date(datetime).toISOString(),
        callbackNote: note.trim() || null,
      }, token);
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError((err as Error)?.message ?? "Failed to save");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-crm-surface rounded-crm border border-crm-border shadow-xl p-6 w-full max-w-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-crm-text flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-crm-warning" />
            Schedule Callback
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-crm-surface-2 rounded"><X className="h-4 w-4" /></button>
        </div>
        <p className="text-sm text-crm-muted mb-4 truncate">{member.contact?.displayName ?? "Contact"}</p>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-crm-muted mb-1">Callback date &amp; time</label>
            <input
              type="datetime-local"
              value={datetime}
              onChange={(e) => setDatetime(e.target.value)}
              className="w-full border border-crm-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
            />
          </div>
          <div>
            <label className="block text-xs text-crm-muted mb-1">Note <span className="text-crm-muted/80">(optional)</span></label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full border border-crm-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 resize-none"
              rows={2}
              placeholder="Reason for callback…"
              maxLength={1000}
            />
          </div>
        </div>
        {error && <p className="text-xs text-crm-danger mt-2">{error}</p>}
        <div className="flex gap-2 justify-end mt-4">
          <button onClick={onClose} className="px-3 py-2 text-sm border border-crm-border rounded-lg text-crm-text hover:bg-crm-bg">Cancel</button>
          <button onClick={handleSave} disabled={saving || !datetime} className={cn(crm.btnPrimary, "px-4 py-2 text-sm")}>
            {saving ? "Saving…" : "Schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Power Card ────────────────────────────────────────────────────────────────
// Shown as the primary card in Power Dialer mode.
// Includes an inline outcome panel so agents can log call results without
// leaving the queue page. Calls POST /crm/contacts/:id/disposition +
// PATCH /crm/queue/:memberId via the onSaveOutcome callback.

type OutcomeDef = {
  label: string;
  icon: React.ElementType;
  colorClass: string;
  destructive?: boolean;
};

const OUTCOME_DEFS: OutcomeDef[] = [
  { label: "No Answer", icon: PhoneMissed, colorClass: "border-crm-border bg-crm-surface-2/60 text-crm-text hover:bg-crm-surface" },
  { label: "Voicemail", icon: Voicemail, colorClass: "border-crm-border bg-crm-surface-2/60 text-crm-text hover:bg-crm-surface" },
  { label: "Interested", icon: ThumbsUp, colorClass: "border-crm-success/40 bg-crm-success/10 text-crm-success hover:bg-crm-success/15" },
  { label: "Not Interested", icon: ThumbsDown, colorClass: "border-crm-warning/40 bg-crm-warning/10 text-crm-warning hover:bg-crm-warning/15" },
  { label: "Callback", icon: CalendarClock, colorClass: "border-crm-warning/40 bg-crm-warning/10 text-crm-warning hover:bg-crm-warning/15" },
  { label: "Converted", icon: CheckCircle2, colorClass: "border-crm-success/40 bg-crm-success/10 text-crm-success hover:bg-crm-success/15" },
];

function PowerCard({
  member,
  sipReady,
  paused,
  acting,
  feedback,
  sortMode,
  onCall,
  onAction,
  onOpenWorkspace,
  onSaveOutcome,
}: {
  member: QueueMember;
  sipReady: boolean;
  paused: boolean;
  acting: boolean;
  feedback: string | null;
  sortMode: SortMode;
  onCall: () => void;
  onAction: (action: string, extra?: Record<string, unknown>) => void;
  onOpenWorkspace: () => void;
  onSaveOutcome: (disposition: string, opts?: { followUpAt?: string | null; callbackNote?: string; note?: string }) => Promise<void>;
}) {
  const contact = member.contact;
  const phone = contact?.primaryPhone;
  const isCallback = member.status === "CALLBACK";
  const cb = member.callbackAt ? callbackTimeLabel(member.callbackAt) : null;
  const actionable = isQueueMemberActionable(member);

  // Outcome panel local state
  // Note: all state auto-resets when member changes because the parent renders
  // <PowerCard key={member.id} …> — React fully unmounts on member change.
  const [outcomeSaving, setOutcomeSaving] = useState(false);
  const [outcomeError, setOutcomeError] = useState<string | null>(null);
  const [callbackPickerOpen, setCallbackPickerOpen] = useState(false);
  const [callbackDatetime, setCallbackDatetime] = useState("");
  const [callbackNoteText, setCallbackNoteText] = useState("");
  const [outcomeNoteOpen, setOutcomeNoteOpen] = useState(false);
  const [outcomeNoteText, setOutcomeNoteText] = useState("");

  function defaultCallbackDatetime() {
    const d = new Date(Date.now() + 3_600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function openCallbackPicker() {
    setCallbackDatetime(defaultCallbackDatetime());
    setCallbackNoteText("");
    setCallbackPickerOpen(true);
    setOutcomeNoteOpen(false);
  }

  function closeCallbackPicker() {
    setCallbackPickerOpen(false);
    setCallbackNoteText("");
  }

  async function fireOutcome(
    disposition: string,
    opts?: { followUpAt?: string | null; callbackNote?: string; note?: string },
  ) {
    setOutcomeSaving(true);
    setOutcomeError(null);
    try {
      await onSaveOutcome(disposition, opts);
      // Parent calls load() + key={member.id} causes unmount — no manual cleanup needed
    } catch (err: unknown) {
      setOutcomeError((err as Error)?.message ?? "Save failed — please try again.");
      setOutcomeSaving(false);
    }
  }

  function handleOutcomeClick(def: OutcomeDef) {
    if (outcomeSaving || acting) return;
    if (def.label === "Callback") { openCallbackPicker(); return; }
    const note = outcomeNoteText.trim() || undefined;
    void fireOutcome(def.label, note ? { note } : undefined);
  }

  async function handleCallbackSave() {
    if (!callbackDatetime) return;
    await fireOutcome("Callback", {
      followUpAt: new Date(callbackDatetime).toISOString(),
      callbackNote: callbackNoteText.trim() || undefined,
    });
    closeCallbackPicker();
  }

  const anyBusy = outcomeSaving || acting;

  if (!actionable) {
    return (
      <div className="bg-crm-surface-2 rounded-crm-lg p-6 border-2 border-crm-border shadow-lg mb-4 opacity-90">
        <div className={cn("mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm", crm.bannerWarning)}>
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>This lead is archived or inactive and is not live queue work. Refresh the queue or contact an admin.</span>
        </div>
        <h2 className="text-xl font-bold text-crm-muted mb-1">{contact?.displayName ?? "Unknown"}</h2>
        {phone ? <p className="text-crm-muted font-mono">{phone}</p> : null}
        <p className="text-xs text-crm-muted mt-3">Outcomes and queue actions are disabled for this lead.</p>
      </div>
    );
  }

  return (
    <div className="bg-crm-surface rounded-crm-lg border border-crm-border p-6 border-2 border-crm-accent shadow-lg mb-4">
      {/* Status badge */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-crm-accent uppercase tracking-wider">Next best lead</span>
          {member.attemptCount > 0 && (
            <span className="text-xs text-crm-muted/80">{member.attemptCount} previous attempt{member.attemptCount !== 1 ? "s" : ""}</span>
          )}
          {sortMode === "smart" && (() => {
            const reason = priorityReason(member);
            if (!reason) return null;
            const isUrgent = reason === "Overdue callback" || reason === "Due today" || reason.startsWith("Urgent");
            const isHigh = !isUrgent && reason.startsWith("High priority");
            return (
              <span
                title="Why this lead?"
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 cursor-default ${
                  isUrgent
                    ? "bg-crm-danger/15 text-crm-danger border border-crm-danger/30"
                    : isHigh
                      ? "bg-crm-warning/15 text-crm-warning border border-crm-warning/30"
                      : "bg-crm-accent/12 text-crm-accent"
                }`}
              >
                <Sparkles className="h-3 w-3" />
                {reason}
              </span>
            );
          })()}
        </div>
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium shrink-0 ${MEMBER_STATUS_COLORS[member.status]}`}>
          {MEMBER_STATUS_LABELS[member.status]}
        </span>
      </div>

      {/* Contact info */}
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-crm-text mb-1">{contact?.displayName ?? "Unknown"}</h2>
        {phone
          ? <p className="text-lg text-crm-muted font-mono">{phone}</p>
          : <p className="text-sm text-crm-muted/80 italic">No phone number on file</p>
        }
        {member.campaign && (
          <span className="inline-block mt-1.5 text-xs text-crm-muted bg-crm-surface-2 px-2 py-0.5 rounded">
            {member.campaign.name}
          </span>
        )}
      </div>

      {/* Context pills — help agent prepare before calling */}
      <div className="flex flex-wrap gap-1.5 mb-4 text-xs">
        {contact?.crmStage && (
          <span className="bg-crm-accent/12 text-crm-accent px-2 py-0.5 rounded-full font-medium">
            {contact.crmStage}
          </span>
        )}
        {contact?.lastDisposition && (
          <span className="bg-crm-accent/10 text-crm-accent px-2 py-0.5 rounded-full flex items-center gap-1">
            <CheckCheck className="h-3 w-3" />
            {contact.lastDisposition}
            {contact.lastDispositionAt && (
              <span className="text-purple-400 ml-0.5">· {relativeTime(contact.lastDispositionAt)}</span>
            )}
          </span>
        )}
        {member.attemptCount > 0 && member.lastAttemptAt && (
          <span className="bg-crm-accent/15 text-crm-accent px-2 py-0.5 rounded-full flex items-center gap-1">
            <PhoneCall className="h-3 w-3" />
            Called {member.attemptCount}× · {relativeTime(member.lastAttemptAt)}
          </span>
        )}
        {contact?.lastActivityAt && !member.lastAttemptAt && (
          <span className="bg-crm-surface-2 text-crm-muted px-2 py-0.5 rounded-full">
            Active {relativeTime(contact.lastActivityAt)}
          </span>
        )}
      </div>

      {/* Callback banner */}
      {cb && (
        <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg mb-4 border ${cb.urgent ? "bg-crm-danger/15 text-crm-danger border-crm-danger/35" : "bg-crm-warning/15 text-crm-warning border-crm-warning/35"}`}>
          {cb.urgent && <AlertCircle className="h-4 w-4 shrink-0" />}
          <CalendarClock className="h-4 w-4 shrink-0" />
          <span>{cb.label}</span>
          {member.callbackNote && (
            <span className="ml-1 italic text-xs truncate">&ldquo;{member.callbackNote.slice(0, 50)}&rdquo;</span>
          )}
        </div>
      )}

      {/* SIP warning */}
      {!sipReady && (
        <div className={cn("mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm", crm.bannerWarning)}>
          <AlertCircle className="h-4 w-4 shrink-0" />
          SIP phone not registered — connect your softphone before calling.
        </div>
      )}

      {/* Paused notice */}
      {paused && (
        <div className="flex items-center gap-2 text-crm-muted bg-crm-bg text-sm px-3 py-2 rounded-lg mb-4 border border-crm-border">
          <Pause className="h-4 w-4 shrink-0" />
          Power Dialer is paused. Resume above to re-enable shortcuts.
        </div>
      )}

      {/* Brief action feedback (skip/defer/DNC from parent) */}
      {feedback && (
        <div className={cn("mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold", crm.bannerSuccess)}>
          <CheckCheck className="h-4 w-4 shrink-0" />
          {feedback} — loading next lead…
        </div>
      )}

      {/* LARGE CALL BUTTON */}
      <button
        onClick={onCall}
        disabled={!phone || !sipReady || anyBusy || paused}
        className={cn("mb-5 w-full gap-3 py-4 px-6 text-lg", crm.btnCallSuccess)}
      >
        <PhoneCall className="h-6 w-6" />
        {phone ? `Call ${phone}` : "No phone number"}
      </button>

      {/* ── Inline outcome panel ─────────────────────────────────────────────── */}
      <div className="border-t border-crm-border/60 pt-4 mb-4">
        <p className="text-xs font-semibold text-crm-muted/80 uppercase tracking-wider mb-3">Log Outcome</p>

        {/* 3-column outcome button grid */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          {OUTCOME_DEFS.map((def) => {
            const Icon = def.icon;
            return (
              <button
                key={def.label}
                onClick={() => handleOutcomeClick(def)}
                disabled={anyBusy}
                className={`flex flex-col items-center gap-1.5 px-2 py-3 border rounded-crm text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${def.colorClass}`}
              >
                <Icon className="h-4 w-4" />
                <span>{def.label}</span>
              </button>
            );
          })}
        </div>

        {/* Optional outcome note — shown when not in callback picker mode */}
        {!callbackPickerOpen && (
          <div className="mb-1">
            {!outcomeNoteOpen ? (
              <button
                onClick={() => setOutcomeNoteOpen(true)}
                disabled={anyBusy}
                className="text-xs text-crm-muted/80 hover:text-crm-muted disabled:opacity-40"
              >
                + Add note
              </button>
            ) : (
              <div className="mt-1">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-crm-muted font-medium">Note <span className="text-crm-muted/80">(optional — saved with outcome)</span></span>
                  <button
                    onClick={() => { setOutcomeNoteOpen(false); setOutcomeNoteText(""); }}
                    className="text-xs text-crm-muted/80 hover:text-crm-muted"
                  >
                    Clear
                  </button>
                </div>
                <textarea
                  value={outcomeNoteText}
                  onChange={(e) => setOutcomeNoteText(e.target.value)}
                  placeholder="Quick note about this call…"
                  maxLength={1000}
                  rows={2}
                  className="w-full border border-crm-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none bg-crm-bg"
                />
              </div>
            )}
          </div>
        )}

        {/* Inline callback time picker */}
        {callbackPickerOpen && (
          <div className="mt-2 rounded-crm border border-crm-warning/35 bg-crm-warning/10 p-3">
            <p className="text-sm font-semibold text-yellow-900 mb-2 flex items-center gap-1.5">
              <CalendarClock className="h-4 w-4" />Schedule Callback
            </p>
            <div className="space-y-2 mb-3">
              <div>
                <label className="block text-xs text-crm-muted mb-1">Date &amp; time</label>
                <input
                  type="datetime-local"
                  value={callbackDatetime}
                  onChange={(e) => setCallbackDatetime(e.target.value)}
                  className="w-full border border-crm-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 bg-crm-surface"
                />
              </div>
              <div>
                <label className="block text-xs text-crm-muted mb-1">Note <span className="text-crm-muted/80">(optional)</span></label>
                <input
                  type="text"
                  value={callbackNoteText}
                  onChange={(e) => setCallbackNoteText(e.target.value)}
                  placeholder="Reason for callback…"
                  maxLength={200}
                  className="w-full border border-crm-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 bg-crm-surface"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={closeCallbackPicker}
                className="px-3 py-1.5 text-xs border border-crm-border rounded-lg text-crm-text hover:bg-crm-bg"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleCallbackSave()}
                disabled={!callbackDatetime || outcomeSaving}
                className={cn(crm.btnPrimary, "px-3 py-1.5 text-xs")}
              >
                {outcomeSaving ? "Saving…" : "Save Callback →"}
              </button>
            </div>
          </div>
        )}

        {/* Outcome API error */}
        {outcomeError && (
          <div className="mt-2 flex items-center gap-2 text-crm-danger bg-crm-danger/15 text-xs px-3 py-2 rounded-lg border border-crm-danger/35">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {outcomeError}
          </div>
        )}

        {/* Outcome saving spinner */}
        {outcomeSaving && !callbackPickerOpen && (
          <div className="mt-2 text-xs text-crm-muted text-center">Saving outcome…</div>
        )}
      </div>

      {/* ── Queue management actions ──────────────────────────────────────────── */}
      <div className="border-t border-crm-border/60 pt-4">
        <p className="text-xs font-semibold text-crm-muted/80 uppercase tracking-wider mb-3">Queue Actions</p>
        <div className="flex flex-wrap gap-2 mb-4">
          <button
            onClick={onOpenWorkspace}
            disabled={anyBusy}
            className="flex items-center gap-1.5 px-3 py-2 border border-crm-border text-crm-text rounded-lg text-sm hover:bg-crm-bg disabled:opacity-50"
          >
            <ExternalLink className="h-3.5 w-3.5" />Full Workspace
          </button>
          {!isCallback && (
            <button
              onClick={() => onAction("skip")}
              disabled={anyBusy || paused}
              className="flex items-center gap-1.5 px-2.5 py-2 border border-crm-border text-crm-text rounded-lg text-sm hover:bg-crm-bg disabled:opacity-50"
            >
              <SkipForward className="h-3.5 w-3.5" />Skip
            </button>
          )}
          {!isCallback && (
            <button
              onClick={() => onAction("defer")}
              disabled={anyBusy || paused}
              className="flex items-center gap-1.5 px-2.5 py-2 border border-crm-border text-crm-text rounded-lg text-sm hover:bg-crm-bg disabled:opacity-50"
            >
              <Clock className="h-3.5 w-3.5" />Defer
            </button>
          )}
          <button
            onClick={() => onAction("set-callback-modal")}
            disabled={anyBusy}
            className="flex items-center gap-1.5 px-2.5 py-2 border border-crm-warning/40 text-crm-warning rounded-lg text-sm hover:bg-crm-warning/10 disabled:opacity-50"
          >
            <CalendarClock className="h-3.5 w-3.5" />
            {isCallback ? "Edit Callback" : "Reschedule"}
          </button>
          <button
            onClick={() => { if (confirm(`Mark ${contact?.displayName ?? "this contact"} as Do Not Call?`)) onAction("dnc"); }}
            disabled={anyBusy || paused}
            className="flex items-center gap-1.5 px-2.5 py-2 border border-crm-danger/35 text-crm-danger rounded-lg text-sm hover:bg-crm-danger/15 disabled:opacity-50"
          >
            <Ban className="h-3.5 w-3.5" />DNC
          </button>
        </div>

        {/* Keyboard hints */}
        {!paused && (
          <div className="text-xs text-crm-muted/80 text-center select-none">
            Keyboard: &nbsp;
            <kbd className="px-1.5 py-0.5 bg-crm-surface-2 rounded text-xs font-mono">C</kbd> call &nbsp;
            <kbd className="px-1.5 py-0.5 bg-crm-surface-2 rounded text-xs font-mono">S</kbd> skip &nbsp;
            <kbd className="px-1.5 py-0.5 bg-crm-surface-2 rounded text-xs font-mono">D</kbd> defer
          </div>
        )}
      </div>
    </div>
  );
}

// ── Member Card (manual mode) ──────────────────────────────────────────────────

function MemberCard({
  member,
  isTop,
  filter,
  onAction,
  acting,
  sipReady,
  onDial,
  queueReturnTo,
}: {
  member: QueueMember;
  isTop: boolean;
  filter: QueueFilter;
  onAction: (action: string, extra?: Record<string, unknown>) => void;
  acting: boolean;
  sipReady?: boolean;
  onDial?: () => void;
  queueReturnTo: string;
}) {
  const router = useRouter();
  const contact = member.contact;
  const isCallback = member.status === "CALLBACK";
  const actionable = isQueueMemberActionable(member);

  const cb = member.callbackAt ? callbackTimeLabel(member.callbackAt) : null;

  function openWorkspace() {
    const params = new URLSearchParams({ contactId: member.contactId, returnTo: queueReturnTo });
    if (member.campaign) params.set("campaignId", member.campaign.id);
    params.set("memberId", member.id);
    router.push(`/crm/live-call?${params}`);
  }

  return (
    <div className={`bg-crm-surface rounded-crm-lg border border-crm-border p-5 mb-4 ${isTop ? "border-2 border-crm-accent shadow-md" : "border border-crm-border shadow-crm"} ${!actionable ? "opacity-75 border-crm-warning/35 bg-crm-warning/10" : ""}`}>
      {!actionable && (
        <div className="mb-3 flex items-center gap-2 text-crm-warning bg-crm-warning/15 border border-crm-warning/35 rounded-lg px-3 py-2 text-xs">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          Archived / inactive lead — not actionable. Refresh if this looks wrong.
        </div>
      )}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          {isTop ? (
            <p className="text-xs font-bold text-crm-accent uppercase tracking-wider mb-1">Next best lead</p>
          ) : null}
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className={`font-bold text-crm-text truncate ${isTop ? "text-xl" : "text-base"}`}>{contact?.displayName ?? "Unknown"}</h2>
            {member.campaign && (
              <span className="text-xs text-crm-muted bg-crm-surface-2 px-2 py-0.5 rounded shrink-0">{member.campaign.name}</span>
            )}
          </div>
          {isTop && priorityReason(member) && (
            <p className="text-xs text-slate-600 mt-1 flex items-center gap-1">
              <Sparkles className="h-3 w-3 text-indigo-500 shrink-0" />
              {priorityReason(member)}
            </p>
          )}
          {contact?.primaryPhone && (
            <p className="text-sm text-crm-muted mt-0.5">{contact.primaryPhone}</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${MEMBER_STATUS_COLORS[member.status]}`}>
            {MEMBER_STATUS_LABELS[member.status]}
          </span>
          {member.attemptCount > 0 && (
            <p className="text-xs text-crm-muted/80 mt-1">{member.attemptCount} attempt{member.attemptCount !== 1 ? "s" : ""}</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4 text-xs">
        {contact?.crmStage && (
          <span className="bg-crm-accent/12 text-crm-accent px-2 py-0.5 rounded-full">{contact.crmStage}</span>
        )}
        {contact?.lastDisposition && (
          <span className="bg-crm-accent/10 text-crm-accent px-2 py-0.5 rounded-full flex items-center gap-1">
            <CheckCheck className="h-3 w-3" />Last: {contact.lastDisposition}
          </span>
        )}
        {contact?.lastActivityAt && (
          <span className="bg-crm-surface-2 text-crm-muted px-2 py-0.5 rounded-full">Active {relativeTime(contact.lastActivityAt)}</span>
        )}
        {cb && (
          <span className={`px-2 py-0.5 rounded-full flex items-center gap-1 ${cb.urgent ? "bg-crm-danger/15 text-crm-danger font-semibold" : "bg-crm-warning/15 text-crm-warning"}`}>
            {cb.urgent && <AlertCircle className="h-3 w-3" />}
            <CalendarClock className="h-3 w-3" />
            {cb.label}
          </span>
        )}
        {member.callbackNote && (
          <span className="bg-crm-warning/15 text-crm-warning px-2 py-0.5 rounded-full italic">&ldquo;{member.callbackNote.slice(0, 60)}{member.callbackNote.length > 60 ? "…" : ""}&rdquo;</span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={openWorkspace} disabled={acting || !actionable} className="flex items-center gap-1.5 px-3 py-2 bg-crm-accent text-white rounded-crm text-sm font-semibold hover:brightness-110 disabled:opacity-50 shadow-crm">
          <PhoneCall className="h-4 w-4" />Open workspace
        </button>
        {isTop && onDial && contact?.primaryPhone && (
          <button
            type="button"
            onClick={onDial}
            disabled={acting || !actionable || !sipReady}
            className="flex items-center gap-1.5 px-3 py-2 bg-crm-success text-white rounded-crm text-sm font-semibold hover:brightness-110 disabled:opacity-50 shadow-crm"
            title={!sipReady ? "Register your softphone to place calls" : undefined}
          >
            <PhoneCall className="h-4 w-4" />Call
          </button>
        )}
        <button onClick={() => router.push(`/crm/contacts/${member.contactId}`)} disabled={acting} className="flex items-center gap-1.5 px-2.5 py-2 border border-crm-success/40 text-crm-success rounded-crm text-sm hover:bg-crm-success/10">
          <CheckCheck className="h-3.5 w-3.5" />Log outcome
        </button>
        {!isCallback && (
          <button onClick={() => onAction("set-callback-modal")} disabled={acting || !actionable} className="flex items-center gap-1.5 px-2.5 py-2 border border-crm-warning/40 text-crm-warning rounded-crm text-sm hover:bg-crm-warning/10">
            <CalendarClock className="h-3.5 w-3.5" />Set Callback
          </button>
        )}
        {isCallback && (
          <button onClick={() => onAction("set-callback-modal")} disabled={acting || !actionable} className="flex items-center gap-1.5 px-2.5 py-2 border border-crm-warning/40 text-crm-warning rounded-crm text-sm hover:bg-crm-warning/10">
            <Edit2 className="h-3.5 w-3.5" />Edit Callback
          </button>
        )}
        {isCallback && (
          <button onClick={() => onAction("clear-callback")} disabled={acting || !actionable} className="flex items-center gap-1.5 px-2.5 py-2 border border-crm-border text-crm-muted rounded-crm text-sm hover:bg-crm-bg">
            <X className="h-3.5 w-3.5" />Clear Callback
          </button>
        )}
        <button onClick={() => onAction("assign-to-me")} disabled={acting || !actionable} className="flex items-center gap-1.5 px-2.5 py-2 border border-crm-border text-crm-text rounded-crm text-sm hover:bg-crm-bg">
          <UserCheck className="h-3.5 w-3.5" />Assign to Me
        </button>
        {!isCallback && (
          <button onClick={() => onAction("skip")} disabled={acting || !actionable} className="flex items-center gap-1.5 px-2.5 py-2 border border-crm-border text-crm-text rounded-crm text-sm hover:bg-crm-bg">
            <SkipForward className="h-3.5 w-3.5" />Skip
          </button>
        )}
        {!isCallback && (
          <button onClick={() => onAction("defer")} disabled={acting || !actionable} className="flex items-center gap-1.5 px-2.5 py-2 border border-crm-border text-crm-text rounded-crm text-sm hover:bg-crm-bg">
            <Clock className="h-3.5 w-3.5" />Defer
          </button>
        )}
        <button onClick={() => { if (confirm(`Mark ${contact?.displayName ?? "this contact"} as Do Not Call?`)) onAction("dnc"); }} disabled={acting || !actionable} className="flex items-center gap-1.5 px-2.5 py-2 border border-crm-danger/35 text-crm-danger rounded-crm text-sm hover:bg-crm-danger/15">
          <Ban className="h-3.5 w-3.5" />DNC
        </button>
      </div>
    </div>
  );
}

// ── Wrap-Up Overlay ────────────────────────────────────────────────────────────
// Shown between leads after a successful outcome save in Power Dialer mode.
// Gives agents a brief breathing window before the next lead is presented.
// NEVER auto-dials. NEVER dispatches crm:dial. Navigation only.

function WrapUpOverlay({
  countdown,
  nextLead,
  paused,
  onGoNow,
  onPause,
  onSkipNext,
}: {
  countdown: number;
  nextLead: QueueMember | null;
  paused: boolean;
  onGoNow: () => void;
  onPause: () => void;
  onSkipNext: () => void;
}) {
  const contact = nextLead?.contact ?? null;

  return (
    <div className="mb-4 rounded-crm-lg border-2 border-crm-success/40 bg-crm-surface p-6 shadow-lg">
      {/* Countdown header */}
      <div className="text-center mb-5">
        <div className="mb-3 inline-flex items-center gap-2 text-base font-semibold text-crm-success">
          <CheckCircle2 className="h-5 w-5" />
          Outcome saved
        </div>
        {!paused ? (
          <>
            <p className="text-5xl font-bold text-crm-text tabular-nums leading-none mb-2">{countdown}</p>
            <p className="text-crm-muted/80 text-sm">Next lead ready in {countdown}… press <kbd className="bg-crm-surface-2 px-1 rounded text-xs">G</kbd> to go now</p>
          </>
        ) : (
          <p className="text-sm font-medium text-crm-warning">Queue paused — resume to continue</p>
        )}
      </div>

      {/* Next lead preview — uses already-loaded queue data, no extra API calls */}
      {nextLead && contact ? (
        <div className="bg-crm-bg rounded-crm p-4 mb-5 border border-crm-border">
          <p className="text-xs font-semibold text-crm-muted/80 uppercase tracking-wider mb-1.5">Up Next</p>
          <p className="font-semibold text-crm-text text-base truncate">{contact.displayName}</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {contact.crmStage && (
              <span className="text-xs px-2 py-0.5 bg-crm-accent/15 text-crm-accent rounded-full font-medium">
                {contact.crmStage}
              </span>
            )}
            {contact.lastDisposition && (
              <span className="text-xs px-2 py-0.5 bg-crm-accent/10 text-crm-accent rounded-full">
                {contact.lastDisposition}
                {contact.lastDispositionAt ? ` · ${relativeTime(contact.lastDispositionAt)}` : ""}
              </span>
            )}
            {nextLead.attemptCount > 0 && (
              <span className="text-xs px-2 py-0.5 bg-crm-surface-2 text-crm-muted rounded-full">
                Called {nextLead.attemptCount}×
                {nextLead.lastAttemptAt ? ` · last ${relativeTime(nextLead.lastAttemptAt)}` : ""}
              </span>
            )}
            {nextLead.callbackAt && (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                callbackTimeLabel(nextLead.callbackAt).urgent
                  ? "bg-crm-danger/15 text-crm-danger border border-crm-danger/30"
                  : "bg-crm-warning/15 text-crm-warning"
              }`}>
                {callbackTimeLabel(nextLead.callbackAt).label}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="text-center text-crm-muted/80 text-sm py-3 mb-5">
          No more leads in this filter — queue complete after this.
        </div>
      )}

      {/* CTAs */}
      <div className="flex gap-3">
        <button
          onClick={onGoNow}
          className={cn(crm.btnPrimary, "flex-1 py-3 text-base font-bold")}
        >
          <ArrowRight className="h-5 w-5" />
          Go Now
        </button>
        <button
          onClick={onPause}
          className={cn(crm.btnSecondary, "border-crm-warning/40 bg-crm-warning/10 text-crm-warning hover:bg-crm-warning/15")}
        >
          <Pause className="h-4 w-4" />
          Pause
        </button>
        <button
          onClick={onSkipNext}
          disabled={!nextLead}
          className="flex items-center gap-1.5 px-4 py-3 bg-crm-surface-2 text-crm-muted rounded-crm text-sm hover:bg-crm-surface-2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <SkipForward className="h-4 w-4" />
          Skip Next
        </button>
      </div>
      <p className="text-center text-xs text-crm-muted/80 mt-2.5">
        <kbd className="bg-crm-surface-2 px-1 rounded">G</kbd> Go Now ·{" "}
        <kbd className="bg-crm-surface-2 px-1 rounded">P</kbd> Pause/Resume ·{" "}
        <kbd className="bg-crm-surface-2 px-1 rounded">X</kbd> Skip Next
      </p>
    </div>
  );
}

// ── Inner page component (needs useSearchParams) ───────────────────────────────

function QueuePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const powerModeActive = searchParams.get("mode") === "power";

  // Derive filter from URL when in power mode; falls back to "pending"
  const urlPowerFilter = searchParams.get("filter");
  const powerFilter: QueueFilter =
    powerModeActive && (urlPowerFilter === "due" || urlPowerFilter === "overdue")
      ? (urlPowerFilter as QueueFilter)
      : "pending";

  const urlManualFilter = !powerModeActive ? searchParams.get("filter") : null;
  const initialManualFilter: QueueFilter =
    urlManualFilter === "pending" ||
    urlManualFilter === "due" ||
    urlManualFilter === "overdue" ||
    urlManualFilter === "upcoming"
      ? urlManualFilter
      : "pending";

  const [queue, setQueue] = useState<QueueMember[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<QueueCounts>({ pending: 0, due: 0, overdue: 0, upcoming: 0 });
  const [filter, setFilter] = useState<QueueFilter>(() =>
    powerModeActive ? (urlPowerFilter === "due" || urlPowerFilter === "overdue" ? (urlPowerFilter as QueueFilter) : "pending") : initialManualFilter,
  );
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");

  // Tenant defaults — loaded once on mount, used only when URL and localStorage have nothing.
  // Precedence: URL > localStorage > tenant default > hardcoded fallback.
  const [tenantDefaults, setTenantDefaults] = useState<CrmSettingsDefaults | null>(null);

  // Active campaigns for the dropdown filter
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);

  const [opStats, setOpStats] = useState<QueueOperationalStats | null>(null);
  const [opStatsLoading, setOpStatsLoading] = useState(true);

  // Campaign filter — driven from URL searchParam, synced to localStorage as soft pref.
  const urlCampaignId = searchParams.get("campaignId") ?? null;
  const [campaignId, setCampaignId] = useState<string | null>(() => {
    if (urlCampaignId) return urlCampaignId;
    if (typeof window === "undefined") return null;
    return localStorage.getItem(CAMPAIGN_FILTER_KEY) ?? null;
  });

  // Sort mode — precedence: URL > localStorage > tenant default > hardcoded fallback.
  // Tenant default is applied after settings load if no URL/LS preference.
  const urlSort = searchParams.get("sort");
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    if (urlSort === "smart" || urlSort === "original") return urlSort;
    if (typeof window === "undefined") return powerModeActive ? "smart" : "original";
    const stored = localStorage.getItem(SORT_MODE_KEY) as SortMode | null;
    if (stored === "smart" || stored === "original") return stored;
    return powerModeActive ? "smart" : "original";
  });
  const sortModeSetFromTenantDefault = useRef(false);

  const [callbackModalMember, setCallbackModalMember] = useState<QueueMember | null>(null);

  // Pause state — persisted to localStorage so it survives navigation/reload
  const [paused, setPaused] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(PAUSE_STORAGE_KEY) === "true";
  });

  // Sync pause to localStorage whenever it changes
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (paused) localStorage.setItem(PAUSE_STORAGE_KEY, "true");
    else localStorage.removeItem(PAUSE_STORAGE_KEY);
  }, [paused]);

  // Persist sort mode
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem(SORT_MODE_KEY, sortMode);
  }, [sortMode]);

  // Persist campaign filter
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (campaignId) localStorage.setItem(CAMPAIGN_FILTER_KEY, campaignId);
    else localStorage.removeItem(CAMPAIGN_FILTER_KEY);
  }, [campaignId]);

  // Load active campaigns for the dropdown (non-blocking, silent on error)
  useEffect(() => {
    const t = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;
    apiGet<{ campaigns: CampaignOption[] }>("/crm/campaigns?status=ACTIVE", t)
      .then((r) => setCampaigns(r.campaigns ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;
    setOpStatsLoading(true);
    apiGet<QueueOperationalStats>("/crm/tasks/stats", t)
      .then((s) => setOpStats(s))
      .catch(() => setOpStats(null))
      .finally(() => setOpStatsLoading(false));
  }, []);

  // Load tenant defaults once — only apply to sort/filter if URL and localStorage were both empty.
  useEffect(() => {
    const t = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;
    apiGet<CrmSettingsDefaults>("/crm/settings", t)
      .then((s) => {
        setTenantDefaults(s);
        // Apply tenant default sort only if nothing was set from URL or localStorage
        if (!sortModeSetFromTenantDefault.current && !urlSort && !localStorage.getItem(SORT_MODE_KEY)) {
          const def = s.defaultQueueSort?.toLowerCase();
          if (def === "smart" || def === "original") {
            setSortMode(def as SortMode);
          }
          sortModeSetFromTenantDefault.current = true;
        }
        // Apply tenant default filter only if URL has no explicit filter and we're not in power mode
        if (!powerModeActive && !searchParams.get("filter") && !filter) {
          const def = s.defaultQueueFilter?.toLowerCase();
          if (def === "pending" || def === "due" || def === "overdue" || def === "upcoming") {
            setFilter(def as QueueFilter);
          }
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wrap-up timer state — shown between leads after a successful outcome save
  const [wrapUpActive, setWrapUpActive] = useState(false);
  const [wrapUpCountdown, setWrapUpCountdown] = useState(WRAP_UP_SECONDS);
  const wrapUpTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const phone = useSipPhone();
  const sipReady = phone?.regState === "registered";

  const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;

  const load = useCallback(async (f?: QueueFilter, s?: SortMode, cid?: string | null) => {
    // In power mode use the URL-derived filter unless an explicit override is passed
    const activeFilter = f ?? (powerModeActive ? powerFilter : filter);
    const activeSort = s ?? sortMode;
    // cid=undefined means "use current state", cid=null means "clear", cid=string means "use it"
    const activeCampaignId = cid !== undefined ? cid : campaignId;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ filter: activeFilter, sort: activeSort });
      if (activeCampaignId) params.set("campaignId", activeCampaignId);
      const res = await apiGet<{ queue: QueueMember[]; total: number; counts: QueueCounts; sort?: string }>(
        `/crm/queue?${params.toString()}`,
        token
      );
      setQueue(res.queue);
      setTotal(res.total);
      if (res.counts) setCounts(res.counts);
    } catch (err: unknown) {
      setError((err as Error)?.message ?? "Failed to load queue");
    }
    setLoading(false);
  // powerFilter is derived from searchParams (stable ref) — safe to include
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, powerFilter, powerModeActive, sortMode, campaignId, token]);

  useEffect(() => { load(); }, [load]);

  // Sync URL power filter → local filter state
  useEffect(() => {
    if (powerModeActive && powerFilter !== filter) setFilter(powerFilter);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [powerModeActive, powerFilter]);

  // Wrap-up countdown — counts from WRAP_UP_SECONDS to 0, then auto-advances.
  // NEVER auto-dials. Clears on unmount, pause change, or manual cancellation.
  useEffect(() => {
    if (!wrapUpActive || paused) {
      if (wrapUpTimerRef.current) {
        clearInterval(wrapUpTimerRef.current);
        wrapUpTimerRef.current = null;
      }
      return;
    }

    let count = WRAP_UP_SECONDS;
    setWrapUpCountdown(count);

    const id = setInterval(() => {
      count -= 1;
      setWrapUpCountdown(count);
      if (count <= 0) {
        clearInterval(id);
        wrapUpTimerRef.current = null;
        setWrapUpActive(false);
      }
    }, 1000);

    wrapUpTimerRef.current = id;
    return () => {
      clearInterval(id);
      wrapUpTimerRef.current = null;
    };
  }, [wrapUpActive, paused]);

  // Clear wrap-up if power mode is exited mid-countdown
  useEffect(() => {
    if (!powerModeActive && wrapUpActive) setWrapUpActive(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [powerModeActive]);

  function switchFilter(f: QueueFilter) {
    setFilter(f);
    load(f, sortMode);
  }

  function toggleSortMode() {
    const next: SortMode = sortMode === "smart" ? "original" : "smart";
    setSortMode(next);
    load(undefined, next);
  }

  function switchCampaign(newCampaignId: string | null) {
    setCampaignId(newCampaignId);
    // Update URL to reflect campaign selection (preserves other params)
    const params = new URLSearchParams(searchParams.toString());
    if (newCampaignId) params.set("campaignId", newCampaignId);
    else params.delete("campaignId");
    router.replace(`/crm/queue?${params.toString()}`);
    load(undefined, undefined, newCampaignId);
  }

  function switchPowerFilter(f: QueueFilter) {
    if (f === "pending") router.push("/crm/queue?mode=power");
    else router.push(`/crm/queue?mode=power&filter=${f}`);
  }

  function showFeedback(label: string) {
    setActionFeedback(label);
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => setActionFeedback(null), 2000);
  }

  async function handleAction(memberId: string, action: string, extra?: Record<string, unknown>) {
    if (action === "set-callback-modal") {
      const m = queue.find((x) => x.id === memberId);
      if (m) setCallbackModalMember(m);
      return;
    }
    setActing(true);
    try {
      await apiPatch(`/crm/queue/${memberId}`, { action, ...extra }, token);
      if (powerModeActive) {
        const label =
          action === "skip" ? "Skipped ✓" :
          action === "defer" ? "Deferred ✓" :
          action === "dnc" ? "Marked DNC ✓" :
          "Updated ✓";
        showFeedback(label);
      }
      await load();
    } catch {
      // Silently ignore; load() will restore current state
    }
    setActing(false);
  }

  // Inline outcome save — called from PowerCard's outcome panel.
  // 1. POSTs disposition to contact record (primary source of truth).
  // 2. PATCHes queue member to update status + increment attempt count.
  // 3. Shows feedback then reloads the queue to advance to next pending lead.
  // Throws on any API error so PowerCard can surface the message inline.
  async function handleSaveOutcome(
    memberId: string,
    contactId: string,
    disposition: string,
    opts?: { followUpAt?: string | null; callbackNote?: string; note?: string },
  ) {
    // The note field sent to POST /disposition (creates CRM note + timeline entry).
    // Callback uses callbackNote; other outcomes use the general note field.
    const noteForPost = opts?.callbackNote ?? opts?.note ?? undefined;

    await apiPost(
      `/crm/contacts/${contactId}/disposition`,
      {
        disposition,
        memberId,
        ...(opts?.followUpAt ? { followUpAt: opts.followUpAt } : {}),
        ...(noteForPost ? { note: noteForPost } : {}),
      },
      token,
    );

    // "Not Interested" records the real disposition on the contact (above) but we
    // intentionally send "contacted" to the PATCH so the server's pattern matcher
    // (`d.includes("not interest")` → DO_NOT_CALL) is not triggered. The agent
    // chose not-interested to move on, not to permanently block the lead.
    // Hard DNC is still available as the explicit "DNC" Queue Action.
    const patchDisposition = disposition === "Not Interested" ? "contacted" : disposition;

    await apiPatch(
      `/crm/queue/${memberId}`,
      { action: "outcome", disposition: patchDisposition },
      token,
    );

    const hadNote = Boolean(noteForPost);
    showFeedback(`${disposition} saved${hadNote ? " with note" : ""} ✓`);
    await load();

    // After reload the queue is updated. In power mode, show the wrap-up overlay
    // instead of jumping straight to the next lead. Wrap-up never auto-dials.
    if (powerModeActive && !paused) {
      setWrapUpActive(true);
    }
  }

  function handlePowerDial(member: QueueMember) {
    const phoneNumber = member.contact?.primaryPhone;
    if (!phoneNumber) return;
    if (!sipReady) return;
    window.dispatchEvent(new CustomEvent("crm:dial", { detail: { target: phoneNumber } }));
  }

  const queueReturnTo = useMemo(() => {
    const q = searchParams.toString();
    return q ? `/crm/queue?${q}` : "/crm/queue";
  }, [searchParams]);

  function openWorkspacePowerMode(member: QueueMember) {
    const params = new URLSearchParams({ contactId: member.contactId });
    if (member.campaign) params.set("campaignId", member.campaign.id);
    params.set("memberId", member.id);
    params.set("mode", "power");
    params.set("returnTo", queueReturnTo);
    router.push(`/crm/live-call?${params}`);
  }

  // Keyboard shortcuts — power mode only, never in text inputs
  // C = Call · S = Skip · D = Defer · G = Go Now (wrap-up) · P = Pause/Resume · X = Skip Next (wrap-up)
  const nextRef = useRef<QueueMember | null>(null);
  nextRef.current = queue[0] ?? null;

  useEffect(() => {
    if (!powerModeActive) return;

    function handleKey(e: KeyboardEvent) {
      // Never fire while typing in an input/textarea/select or contenteditable
      const tgt = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tgt.tagName)) return;
      if (tgt.getAttribute("contenteditable") === "true") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // P: Pause/Resume — works even when paused so agents can unpause
      if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        setPaused((prev) => !prev);
        setWrapUpActive(false);
        return;
      }

      // All other shortcuts disabled while paused
      if (paused) return;

      const current = nextRef.current;

      // G: Go Now — only during wrap-up countdown
      if (e.key === "g" || e.key === "G") {
        if (!wrapUpActive) return;
        e.preventDefault();
        setWrapUpActive(false);
        return;
      }

      // X: Skip Next Lead — only during wrap-up countdown
      if (e.key === "x" || e.key === "X") {
        if (!wrapUpActive) return;
        e.preventDefault();
        if (current) {
          setWrapUpActive(false);
          void handleAction(current.id, "skip");
        }
        return;
      }

      // C / S / D — only active when NOT in wrap-up and a lead is present
      if (!current || wrapUpActive) return;
      if (!isQueueMemberActionable(current)) return;

      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        handlePowerDial(current);
      }
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        void handleAction(current.id, "skip");
      }
      if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        void handleAction(current.id, "defer");
      }
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  // handleAction and handlePowerDial use queue/sipReady via closure; re-attach when those change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [powerModeActive, paused, sipReady, wrapUpActive]);

  const next = queue[0] ?? null;
  const rest = queue.slice(1);
  const activeCampaignName = campaignId
    ? campaigns.find((c) => c.id === campaignId)?.name ?? null
    : null;

  const sidePanels = (
    <div className="col-span-12 flex flex-col gap-3 xl:col-span-4 2xl:col-span-4">
      <QueueOverviewPanel
        filter={filter}
        total={total}
        stats={opStats}
        statsLoading={opStatsLoading}
        counts={counts}
        campaignId={campaignId}
        campaignName={activeCampaignName}
      />
      <QueueAttentionPanel
        stats={opStats}
        statsLoading={opStatsLoading}
        campaigns={campaigns}
        campaignId={campaignId}
        campaignName={activeCampaignName}
      />
    </div>
  );

  return (
    <CRMPageShell innerClassName={crm.pageInnerQueue}>
      {callbackModalMember && (
        <SetCallbackModal
          member={callbackModalMember}
          onClose={() => setCallbackModalMember(null)}
          onSaved={() => { setCallbackModalMember(null); load(); }}
        />
      )}

      {powerModeActive ? (
        <QueuePowerSessionBar
          filter={filter}
          counts={counts}
          paused={paused}
          sortMode={sortMode}
          loading={loading}
          acting={acting}
          sipReady={sipReady}
          campaignId={campaignId}
          campaigns={campaigns}
          total={total}
          onFilterChange={(f) => {
            setWrapUpActive(false);
            switchPowerFilter(f);
          }}
          onToggleSort={toggleSortMode}
          onRefresh={() => load()}
          onTogglePause={() => {
            setPaused((p) => !p);
            setWrapUpActive(false);
          }}
          onStop={() => router.push("/crm/queue")}
        />
      ) : null}

      {!powerModeActive ? (
        <CRMPageHeader
          icon={<ListOrdered className="h-7 w-7" />}
          title="My Queue"
          subtitle={
            loading
              ? "Loading your assigned work…"
              : total === 0
                ? "Operational workbench — switch focus with queue snapshots"
                : `${total} lead${total !== 1 ? "s" : ""} in this view`
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={toggleSortMode}
                disabled={loading}
                className={cn(
                  crm.btnSecondary,
                  sortMode === "smart" && "border-crm-accent/40 bg-crm-accent/12 text-crm-accent",
                )}
              >
                <Sparkles className="h-4 w-4" />
                {sortMode === "smart" ? "Smart sort" : "Original sort"}
              </button>
              <button
                type="button"
                onClick={() => router.push("/crm/queue?mode=power")}
                disabled={loading || total === 0}
                className={crm.btnPrimary}
              >
                <Zap className="h-4 w-4" />
                Power session
              </button>
              <button type="button" onClick={() => load()} disabled={loading || acting} className={crm.btnSecondary}>
                <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                Refresh
              </button>
            </div>
          }
        />
      ) : null}

      {!powerModeActive ? (
        <CRMActionBar>
          <div className="grid w-full grid-cols-2 items-stretch gap-2 sm:grid-cols-4">
            <QueueCountPill label="Pending" count={counts.pending} active={filter === "pending"} onClick={() => switchFilter("pending")} disabled={loading} />
            <QueueCountPill label="Due" count={counts.due} active={filter === "due"} urgent={counts.due > 0} onClick={() => switchFilter("due")} disabled={loading} />
            <QueueCountPill label="Overdue" count={counts.overdue} active={filter === "overdue"} urgent={counts.overdue > 0} onClick={() => switchFilter("overdue")} disabled={loading} />
            <QueueCountPill label="Upcoming" count={counts.upcoming} active={filter === "upcoming"} onClick={() => switchFilter("upcoming")} disabled={loading} />
          </div>
          {campaigns.length > 0 ? (
            <div className="flex w-full flex-wrap items-center gap-2 border-t border-crm-border/60 pt-3">
              <Megaphone className="h-4 w-4 shrink-0 text-crm-muted" />
              <label htmlFor="crm-queue-campaign" className={cn(crm.label, "shrink-0")}>Campaign</label>
              <select
                id="crm-queue-campaign"
                value={campaignId ?? ""}
                onChange={(e) => switchCampaign(e.target.value || null)}
                className={cn(crm.input, "max-w-md flex-1 min-w-[12rem] py-1.5")}
                disabled={loading}
              >
                <option value="">All campaigns</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {campaignId ? (
                <button type="button" onClick={() => switchCampaign(null)} className="text-xs font-medium text-crm-accent hover:underline">
                  Clear
                </button>
              ) : null}
            </div>
          ) : null}
        </CRMActionBar>
      ) : powerModeActive && campaigns.length > 0 ? (
        <CRMActionBar className="mb-0">
          <Megaphone className="h-4 w-4 shrink-0 text-crm-muted" />
          <label htmlFor="crm-queue-campaign-power" className={cn(crm.label, "shrink-0")}>Campaign</label>
          <select
            id="crm-queue-campaign-power"
            value={campaignId ?? ""}
            onChange={(e) => switchCampaign(e.target.value || null)}
            className={cn(crm.input, "max-w-md flex-1 min-w-[10rem] py-1.5")}
            disabled={loading}
          >
            <option value="">All campaigns</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {campaignId ? (
            <button type="button" onClick={() => switchCampaign(null)} className="text-xs font-medium text-crm-accent hover:underline">
              Clear
            </button>
          ) : null}
        </CRMActionBar>
      ) : null}

      <div className="grid grid-cols-12 gap-4 items-start">
        <div className="col-span-12 flex min-w-0 flex-col gap-3 xl:col-span-8 2xl:col-span-8">
        {/* Content */}
        {loading ? (
          <div className="py-24 text-center text-crm-muted/80 text-sm">Loading…</div>
        ) : error ? (
          <div className="py-24 text-center text-red-500 text-sm">{error}</div>
        ) : !next ? (
          <QueueEmptyOperational
            filter={filter}
            powerMode={powerModeActive}
            campaignId={campaignId}
            onClearCampaign={() => switchCampaign(null)}
            onSwitchPending={() => switchFilter("pending")}
            onExitPower={() => router.push("/crm/queue")}
          />
        ) : powerModeActive ? (
          // ── Power Dialer layout ──────────────────────────────────────────────
          <>
            {wrapUpActive ? (
              // Wrap-up overlay: shows countdown + next lead preview after outcome save.
              // Countdown auto-advances to next lead. NEVER auto-dials.
              <WrapUpOverlay
                countdown={wrapUpCountdown}
                nextLead={next}
                paused={paused}
                onGoNow={() => setWrapUpActive(false)}
                onPause={() => { setPaused(true); setWrapUpActive(false); }}
                onSkipNext={() => {
                  // Skip the upcoming lead (queue[0] after reload) and reload again
                  setWrapUpActive(false);
                  void handleAction(next.id, "skip");
                }}
              />
            ) : (
              <PowerCard
                key={next.id}
                member={next}
                sipReady={sipReady}
                paused={paused}
                acting={acting}
                feedback={actionFeedback}
                sortMode={sortMode}
                onCall={() => handlePowerDial(next)}
                onAction={(action, extra) => handleAction(next.id, action, extra)}
                onOpenWorkspace={() => openWorkspacePowerMode(next)}
                onSaveOutcome={(disposition, opts) =>
                  handleSaveOutcome(next.id, next.contactId, disposition, opts)
                }
              />
            )}

            {/* Up next list */}
            {rest.length > 0 && (
              <div className="rounded-crm-lg border border-crm-border bg-crm-surface/80 p-3 sm:p-4 shadow-crm">
                <h2 className="text-xs font-bold text-crm-muted uppercase tracking-wide mb-3 px-1">
                  Up next ({rest.length + 1} in this pull)
                </h2>
                <div>
                  {rest.map((m, i) => (
                    <QueueOperationalRow
                      key={m.id}
                      member={m}
                      rank={i + 2}
                      compact
                      returnTo={queueReturnTo}
                      acting={acting}
                      sipReady={sipReady}
                      onOpenWorkspace={() => {
                        const params = new URLSearchParams({ contactId: m.contactId, memberId: m.id, returnTo: queueReturnTo });
                        if (m.campaign) params.set("campaignId", m.campaign.id);
                        router.push(`/crm/live-call?${params}`);
                      }}
                      onQuickCall={m.contact?.primaryPhone ? () => handlePowerDial(m) : undefined}
                      onSkip={() => void handleAction(m.id, "skip")}
                    />
                  ))}
                </div>
                {total > queue.length && (
                  <p className="text-center text-xs text-crm-muted/80 mt-3 px-1">
                    + {total - queue.length} more in queue
                  </p>
                )}
              </div>
            )}
          </>
        ) : (
          // ── Manual mode layout ───────────────────────────────────────────────
          <>
            <MemberCard
              member={next}
              isTop={true}
              filter={filter}
              acting={acting}
              sipReady={sipReady}
              queueReturnTo={queueReturnTo}
              onDial={() => handlePowerDial(next)}
              onAction={(action, extra) => handleAction(next.id, action, extra)}
            />

            {rest.length > 0 && (
              <div className="rounded-crm-lg border border-crm-border bg-crm-surface/80 p-3 sm:p-4 shadow-crm">
                <h2 className="text-xs font-bold text-crm-muted uppercase tracking-wide mb-3 px-1">
                  {filter === "pending" ? `More in queue (${rest.length + 1} shown)` :
                   filter === "overdue" ? `Also overdue (${rest.length + 1} shown)` :
                   filter === "due" ? `Also due today (${rest.length + 1} shown)` :
                   `Upcoming (${rest.length + 1} shown)`}
                </h2>
                <div className="space-y-0">
                  {rest.map((m, i) => (
                    <QueueOperationalRow
                      key={m.id}
                      member={m}
                      rank={i + 2}
                      compact
                      returnTo={queueReturnTo}
                      acting={acting}
                      sipReady={sipReady}
                      onOpenWorkspace={() => {
                        const params = new URLSearchParams({ contactId: m.contactId, memberId: m.id, returnTo: queueReturnTo });
                        if (m.campaign) params.set("campaignId", m.campaign.id);
                        router.push(`/crm/live-call?${params}`);
                      }}
                      onQuickCall={m.contact?.primaryPhone ? () => handlePowerDial(m) : undefined}
                      onSkip={() => void handleAction(m.id, "skip")}
                    />
                  ))}
                </div>
                {total > queue.length && (
                  <p className="text-center text-xs text-crm-muted/80 mt-3 px-1">
                    + {total - queue.length} more in queue (open filters or refresh)
                  </p>
                )}
              </div>
            )}
          </>
        )}
      
        </div>
        {!loading && !error ? sidePanels : null}
      </div>
    </CRMPageShell>
  );
}

// ── Main page export — wraps inner component in Suspense for useSearchParams ──

export default function QueuePage() {
  return (
    <Suspense fallback={<div className="py-24 text-center text-crm-muted/80 text-sm">Loading…</div>}>
      <QueuePageInner />
    </Suspense>
  );
}



