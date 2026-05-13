"use client";

import { Suspense, useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ListOrdered, PhoneCall, ExternalLink, SkipForward, Clock, Ban,
  RefreshCw, CheckCheck, Inbox, CalendarClock, UserCheck, X, Edit2,
  ChevronRight, AlertCircle, Zap, ZapOff, Pause, Play, ArrowRight,
  PhoneMissed, Voicemail, ThumbsUp, ThumbsDown, CheckCircle2,
} from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../../../../services/apiClient";
import { useSipPhone } from "../../../../hooks/useSipPhone";

// ── Types ──────────────────────────────────────────────────────────────────────

type MemberStatus = "PENDING" | "IN_PROGRESS" | "CONTACTED" | "CALLBACK" | "CONVERTED" | "SKIPPED" | "DO_NOT_CALL";

type QueueMember = {
  id: string;
  contactId: string;
  contact: {
    id: string;
    displayName: string;
    primaryPhone: string | null;
    primaryEmail: string | null;
    crmStage: string | null;
    lastActivityAt: string | null;
    lastDisposition: string | null;
    lastDispositionAt: string | null;
  } | null;
  campaign: { id: string; name: string; scriptId: string | null; checklistId: string | null } | null;
  status: MemberStatus;
  attemptCount: number;
  lastAttemptAt: string | null;
  callbackAt: string | null;
  callbackNote: string | null;
  sortOrder: number;
};

type QueueCounts = { pending: number; due: number; overdue: number; upcoming: number };

type QueueFilter = "pending" | "due" | "overdue" | "upcoming";

// ── Constants ──────────────────────────────────────────────────────────────────

const PAUSE_STORAGE_KEY = "crm_power_queue_paused";
const WRAP_UP_SECONDS = 5;

// ── Helpers ────────────────────────────────────────────────────────────────────

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

const MEMBER_STATUS_COLORS: Record<MemberStatus, string> = {
  PENDING: "bg-gray-100 text-gray-600",
  IN_PROGRESS: "bg-blue-100 text-blue-700",
  CONTACTED: "bg-purple-100 text-purple-700",
  CALLBACK: "bg-yellow-100 text-yellow-700",
  CONVERTED: "bg-green-100 text-green-700",
  SKIPPED: "bg-gray-100 text-gray-500",
  DO_NOT_CALL: "bg-red-100 text-red-700",
};

const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = {
  PENDING: "Pending", IN_PROGRESS: "In Progress", CONTACTED: "Contacted",
  CALLBACK: "Callback", CONVERTED: "Converted", SKIPPED: "Skipped", DO_NOT_CALL: "DNC",
};

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
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900 flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-yellow-500" />
            Schedule Callback
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="h-4 w-4" /></button>
        </div>
        <p className="text-sm text-gray-500 mb-4 truncate">{member.contact?.displayName ?? "Contact"}</p>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Callback date &amp; time</label>
            <input
              type="datetime-local"
              value={datetime}
              onChange={(e) => setDatetime(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Note <span className="text-gray-400">(optional)</span></label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 resize-none"
              rows={2}
              placeholder="Reason for callback…"
              maxLength={1000}
            />
          </div>
        </div>
        {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
        <div className="flex gap-2 justify-end mt-4">
          <button onClick={onClose} className="px-3 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">Cancel</button>
          <button onClick={handleSave} disabled={saving || !datetime} className="px-4 py-2 text-sm bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 disabled:opacity-50 font-medium">
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
  { label: "No Answer",      icon: PhoneMissed,    colorClass: "border-gray-300 text-gray-700 hover:bg-gray-50" },
  { label: "Voicemail",      icon: Voicemail,      colorClass: "border-gray-300 text-gray-700 hover:bg-gray-50" },
  { label: "Interested",     icon: ThumbsUp,       colorClass: "border-green-300 text-green-700 hover:bg-green-50" },
  { label: "Not Interested", icon: ThumbsDown,     colorClass: "border-orange-300 text-orange-700 hover:bg-orange-50" },
  { label: "Callback",       icon: CalendarClock,  colorClass: "border-yellow-300 text-yellow-700 hover:bg-yellow-50" },
  { label: "Converted",      icon: CheckCircle2,   colorClass: "border-emerald-400 text-emerald-700 hover:bg-emerald-50" },
];

function PowerCard({
  member,
  sipReady,
  paused,
  acting,
  feedback,
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
  onCall: () => void;
  onAction: (action: string, extra?: Record<string, unknown>) => void;
  onOpenWorkspace: () => void;
  onSaveOutcome: (disposition: string, opts?: { followUpAt?: string | null; callbackNote?: string; note?: string }) => Promise<void>;
}) {
  const contact = member.contact;
  const phone = contact?.primaryPhone;
  const isCallback = member.status === "CALLBACK";
  const cb = member.callbackAt ? callbackTimeLabel(member.callbackAt) : null;

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

  return (
    <div className="bg-white rounded-2xl p-6 border-2 border-blue-400 shadow-lg mb-4">
      {/* Status badge */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <span className="text-xs font-bold text-blue-600 uppercase tracking-wider">Current Lead</span>
          {member.attemptCount > 0 && (
            <span className="ml-2 text-xs text-gray-400">{member.attemptCount} previous attempt{member.attemptCount !== 1 ? "s" : ""}</span>
          )}
        </div>
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium shrink-0 ${MEMBER_STATUS_COLORS[member.status]}`}>
          {MEMBER_STATUS_LABELS[member.status]}
        </span>
      </div>

      {/* Contact info */}
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-gray-900 mb-1">{contact?.displayName ?? "Unknown"}</h2>
        {phone
          ? <p className="text-lg text-gray-600 font-mono">{phone}</p>
          : <p className="text-sm text-gray-400 italic">No phone number on file</p>
        }
        {member.campaign && (
          <span className="inline-block mt-1.5 text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
            {member.campaign.name}
          </span>
        )}
      </div>

      {/* Context pills — help agent prepare before calling */}
      <div className="flex flex-wrap gap-1.5 mb-4 text-xs">
        {contact?.crmStage && (
          <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full font-medium">
            {contact.crmStage}
          </span>
        )}
        {contact?.lastDisposition && (
          <span className="bg-purple-50 text-purple-700 px-2 py-0.5 rounded-full flex items-center gap-1">
            <CheckCheck className="h-3 w-3" />
            {contact.lastDisposition}
            {contact.lastDispositionAt && (
              <span className="text-purple-400 ml-0.5">· {relativeTime(contact.lastDispositionAt)}</span>
            )}
          </span>
        )}
        {member.attemptCount > 0 && member.lastAttemptAt && (
          <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full flex items-center gap-1">
            <PhoneCall className="h-3 w-3" />
            Called {member.attemptCount}× · {relativeTime(member.lastAttemptAt)}
          </span>
        )}
        {contact?.lastActivityAt && !member.lastAttemptAt && (
          <span className="bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
            Active {relativeTime(contact.lastActivityAt)}
          </span>
        )}
      </div>

      {/* Callback banner */}
      {cb && (
        <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg mb-4 border ${cb.urgent ? "bg-red-50 text-red-700 border-red-200" : "bg-yellow-50 text-yellow-700 border-yellow-200"}`}>
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
        <div className="flex items-center gap-2 text-amber-700 bg-amber-50 text-sm px-3 py-2 rounded-lg mb-4 border border-amber-200">
          <AlertCircle className="h-4 w-4 shrink-0" />
          SIP phone not registered — connect your softphone before calling.
        </div>
      )}

      {/* Paused notice */}
      {paused && (
        <div className="flex items-center gap-2 text-gray-600 bg-gray-50 text-sm px-3 py-2 rounded-lg mb-4 border border-gray-200">
          <Pause className="h-4 w-4 shrink-0" />
          Power Dialer is paused. Resume above to re-enable shortcuts.
        </div>
      )}

      {/* Brief action feedback (skip/defer/DNC from parent) */}
      {feedback && (
        <div className="flex items-center gap-2 text-green-700 bg-green-50 text-sm px-3 py-2 rounded-lg mb-4 border border-green-200 font-semibold">
          <CheckCheck className="h-4 w-4 shrink-0" />
          {feedback} — loading next lead…
        </div>
      )}

      {/* LARGE CALL BUTTON */}
      <button
        onClick={onCall}
        disabled={!phone || !sipReady || anyBusy || paused}
        className="w-full flex items-center justify-center gap-3 py-4 px-6 rounded-xl font-bold text-white text-lg mb-5 bg-green-500 hover:bg-green-600 active:bg-green-700 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed shadow-md disabled:shadow-none transition-all"
      >
        <PhoneCall className="h-6 w-6" />
        {phone ? `Call ${phone}` : "No phone number"}
      </button>

      {/* ── Inline outcome panel ─────────────────────────────────────────────── */}
      <div className="border-t border-gray-100 pt-4 mb-4">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Log Outcome</p>

        {/* 3-column outcome button grid */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          {OUTCOME_DEFS.map((def) => {
            const Icon = def.icon;
            return (
              <button
                key={def.label}
                onClick={() => handleOutcomeClick(def)}
                disabled={anyBusy}
                className={`flex flex-col items-center gap-1.5 px-2 py-3 border rounded-xl text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${def.colorClass}`}
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
                className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-40"
              >
                + Add note
              </button>
            ) : (
              <div className="mt-1">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-500 font-medium">Note <span className="text-gray-400">(optional — saved with outcome)</span></span>
                  <button
                    onClick={() => { setOutcomeNoteOpen(false); setOutcomeNoteText(""); }}
                    className="text-xs text-gray-400 hover:text-gray-600"
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
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none bg-gray-50"
                />
              </div>
            )}
          </div>
        )}

        {/* Inline callback time picker */}
        {callbackPickerOpen && (
          <div className="mt-2 p-3 bg-yellow-50 border border-yellow-200 rounded-xl">
            <p className="text-sm font-semibold text-yellow-900 mb-2 flex items-center gap-1.5">
              <CalendarClock className="h-4 w-4" />Schedule Callback
            </p>
            <div className="space-y-2 mb-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Date &amp; time</label>
                <input
                  type="datetime-local"
                  value={callbackDatetime}
                  onChange={(e) => setCallbackDatetime(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 bg-white"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Note <span className="text-gray-400">(optional)</span></label>
                <input
                  type="text"
                  value={callbackNoteText}
                  onChange={(e) => setCallbackNoteText(e.target.value)}
                  placeholder="Reason for callback…"
                  maxLength={200}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400 bg-white"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={closeCallbackPicker}
                className="px-3 py-1.5 text-xs border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleCallbackSave()}
                disabled={!callbackDatetime || outcomeSaving}
                className="px-3 py-1.5 text-xs bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 disabled:opacity-50 font-semibold"
              >
                {outcomeSaving ? "Saving…" : "Save Callback →"}
              </button>
            </div>
          </div>
        )}

        {/* Outcome API error */}
        {outcomeError && (
          <div className="mt-2 flex items-center gap-2 text-red-700 bg-red-50 text-xs px-3 py-2 rounded-lg border border-red-200">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {outcomeError}
          </div>
        )}

        {/* Outcome saving spinner */}
        {outcomeSaving && !callbackPickerOpen && (
          <div className="mt-2 text-xs text-gray-500 text-center">Saving outcome…</div>
        )}
      </div>

      {/* ── Queue management actions ──────────────────────────────────────────── */}
      <div className="border-t border-gray-100 pt-4">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Queue Actions</p>
        <div className="flex flex-wrap gap-2 mb-4">
          <button
            onClick={onOpenWorkspace}
            disabled={anyBusy}
            className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            <ExternalLink className="h-3.5 w-3.5" />Full Workspace
          </button>
          {!isCallback && (
            <button
              onClick={() => onAction("skip")}
              disabled={anyBusy || paused}
              className="flex items-center gap-1.5 px-2.5 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
            >
              <SkipForward className="h-3.5 w-3.5" />Skip
            </button>
          )}
          {!isCallback && (
            <button
              onClick={() => onAction("defer")}
              disabled={anyBusy || paused}
              className="flex items-center gap-1.5 px-2.5 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
            >
              <Clock className="h-3.5 w-3.5" />Defer
            </button>
          )}
          <button
            onClick={() => onAction("set-callback-modal")}
            disabled={anyBusy}
            className="flex items-center gap-1.5 px-2.5 py-2 border border-yellow-300 text-yellow-700 rounded-lg text-sm hover:bg-yellow-50 disabled:opacity-50"
          >
            <CalendarClock className="h-3.5 w-3.5" />
            {isCallback ? "Edit Callback" : "Reschedule"}
          </button>
          <button
            onClick={() => { if (confirm(`Mark ${contact?.displayName ?? "this contact"} as Do Not Call?`)) onAction("dnc"); }}
            disabled={anyBusy || paused}
            className="flex items-center gap-1.5 px-2.5 py-2 border border-red-200 text-red-600 rounded-lg text-sm hover:bg-red-50 disabled:opacity-50"
          >
            <Ban className="h-3.5 w-3.5" />DNC
          </button>
        </div>

        {/* Keyboard hints */}
        {!paused && (
          <div className="text-xs text-gray-400 text-center select-none">
            Keyboard: &nbsp;
            <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-xs font-mono">C</kbd> call &nbsp;
            <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-xs font-mono">S</kbd> skip &nbsp;
            <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-xs font-mono">D</kbd> defer
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
}: {
  member: QueueMember;
  isTop: boolean;
  filter: QueueFilter;
  onAction: (action: string, extra?: Record<string, unknown>) => void;
  acting: boolean;
}) {
  const router = useRouter();
  const contact = member.contact;
  const isCallback = member.status === "CALLBACK";

  const cb = member.callbackAt ? callbackTimeLabel(member.callbackAt) : null;

  function openWorkspace() {
    const params = new URLSearchParams({ contactId: member.contactId });
    if (member.campaign) params.set("campaignId", member.campaign.id);
    params.set("memberId", member.id);
    router.push(`/crm/live-call?${params}`);
  }

  return (
    <div className={`bg-white rounded-2xl p-5 mb-4 ${isTop ? "border-2 border-blue-400 shadow-md" : "border border-gray-200 shadow-sm"}`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          {isTop && <p className="text-xs font-semibold text-blue-600 uppercase tracking-wider mb-1">
            {filter === "pending" ? "Next Up" : filter === "due" ? "Due Now" : filter === "overdue" ? "Overdue" : "Upcoming"}
          </p>}
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className={`font-bold text-gray-900 truncate ${isTop ? "text-xl" : "text-base"}`}>{contact?.displayName ?? "Unknown"}</h2>
            {member.campaign && (
              <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded shrink-0">{member.campaign.name}</span>
            )}
          </div>
          {contact?.primaryPhone && (
            <p className="text-sm text-gray-600 mt-0.5">{contact.primaryPhone}</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${MEMBER_STATUS_COLORS[member.status]}`}>
            {MEMBER_STATUS_LABELS[member.status]}
          </span>
          {member.attemptCount > 0 && (
            <p className="text-xs text-gray-400 mt-1">{member.attemptCount} attempt{member.attemptCount !== 1 ? "s" : ""}</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4 text-xs">
        {contact?.crmStage && (
          <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full">{contact.crmStage}</span>
        )}
        {contact?.lastDisposition && (
          <span className="bg-purple-50 text-purple-700 px-2 py-0.5 rounded-full flex items-center gap-1">
            <CheckCheck className="h-3 w-3" />Last: {contact.lastDisposition}
          </span>
        )}
        {contact?.lastActivityAt && (
          <span className="bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">Active {relativeTime(contact.lastActivityAt)}</span>
        )}
        {cb && (
          <span className={`px-2 py-0.5 rounded-full flex items-center gap-1 ${cb.urgent ? "bg-red-50 text-red-700 font-semibold" : "bg-yellow-50 text-yellow-700"}`}>
            {cb.urgent && <AlertCircle className="h-3 w-3" />}
            <CalendarClock className="h-3 w-3" />
            {cb.label}
          </span>
        )}
        {member.callbackNote && (
          <span className="bg-yellow-50 text-yellow-800 px-2 py-0.5 rounded-full italic">&ldquo;{member.callbackNote.slice(0, 60)}{member.callbackNote.length > 60 ? "…" : ""}&rdquo;</span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={openWorkspace} disabled={acting} className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 shadow-sm">
          <PhoneCall className="h-4 w-4" />Open Workspace
        </button>
        <button onClick={() => router.push(`/crm/contacts/${member.contactId}`)} disabled={acting} className="flex items-center gap-1.5 px-2.5 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50">
          <ExternalLink className="h-3.5 w-3.5" />Contact
        </button>
        {!isCallback && (
          <button onClick={() => onAction("set-callback-modal")} disabled={acting} className="flex items-center gap-1.5 px-2.5 py-2 border border-yellow-300 text-yellow-700 rounded-xl text-sm hover:bg-yellow-50">
            <CalendarClock className="h-3.5 w-3.5" />Set Callback
          </button>
        )}
        {isCallback && (
          <button onClick={() => onAction("set-callback-modal")} disabled={acting} className="flex items-center gap-1.5 px-2.5 py-2 border border-yellow-300 text-yellow-700 rounded-xl text-sm hover:bg-yellow-50">
            <Edit2 className="h-3.5 w-3.5" />Edit Callback
          </button>
        )}
        {isCallback && (
          <button onClick={() => onAction("clear-callback")} disabled={acting} className="flex items-center gap-1.5 px-2.5 py-2 border border-gray-300 text-gray-600 rounded-xl text-sm hover:bg-gray-50">
            <X className="h-3.5 w-3.5" />Clear Callback
          </button>
        )}
        <button onClick={() => onAction("assign-to-me")} disabled={acting} className="flex items-center gap-1.5 px-2.5 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50">
          <UserCheck className="h-3.5 w-3.5" />Assign to Me
        </button>
        {!isCallback && (
          <button onClick={() => onAction("skip")} disabled={acting} className="flex items-center gap-1.5 px-2.5 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50">
            <SkipForward className="h-3.5 w-3.5" />Skip
          </button>
        )}
        {!isCallback && (
          <button onClick={() => onAction("defer")} disabled={acting} className="flex items-center gap-1.5 px-2.5 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50">
            <Clock className="h-3.5 w-3.5" />Defer
          </button>
        )}
        <button onClick={() => { if (confirm(`Mark ${contact?.displayName ?? "this contact"} as Do Not Call?`)) onAction("dnc"); }} disabled={acting} className="flex items-center gap-1.5 px-2.5 py-2 border border-red-200 text-red-600 rounded-xl text-sm hover:bg-red-50">
          <Ban className="h-3.5 w-3.5" />DNC
        </button>
      </div>
    </div>
  );
}

// ── Queue Row (rest list) ──────────────────────────────────────────────────────

function QueueRow({ member, rank, filter }: { member: QueueMember; rank: number; filter: QueueFilter }) {
  const router = useRouter();
  const cb = member.callbackAt ? callbackTimeLabel(member.callbackAt) : null;

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer border-b last:border-b-0"
      onClick={() => router.push(`/crm/contacts/${member.contactId}`)}
    >
      <span className="text-sm text-gray-400 w-6 text-right shrink-0">{rank}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{member.contact?.displayName ?? "Unknown"}</p>
        <p className="text-xs text-gray-500 truncate">
          {cb ? (
            <span className={cb.urgent ? "text-red-600 font-medium" : "text-yellow-700"}>
              {cb.urgent ? "⚠ " : ""}Callback {cb.label.toLowerCase()}
            </span>
          ) : (
            member.contact?.primaryPhone ?? member.campaign?.name ?? ""
          )}
        </p>
      </div>
      <span className={`text-xs px-2 py-0.5 rounded font-medium shrink-0 ${MEMBER_STATUS_COLORS[member.status]}`}>
        {MEMBER_STATUS_LABELS[member.status]}
      </span>
      <ChevronRight className="h-4 w-4 text-gray-400 shrink-0" />
    </div>
  );
}

// ── Tabs ───────────────────────────────────────────────────────────────────────

function TabButton({ active, label, count, urgent, onClick }: {
  active: boolean; label: string; count: number; urgent?: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg transition-colors ${
        active ? "bg-white shadow-sm text-blue-700 border border-blue-200" : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
      }`}
    >
      {label}
      {count > 0 && (
        <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${urgent ? "bg-red-500 text-white" : active ? "bg-blue-100 text-blue-700" : "bg-gray-200 text-gray-600"}`}>
          {count}
        </span>
      )}
    </button>
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
    <div className="bg-white rounded-2xl p-6 border-2 border-green-400 shadow-lg mb-4">
      {/* Countdown header */}
      <div className="text-center mb-5">
        <div className="inline-flex items-center gap-2 text-green-600 font-semibold text-base mb-3">
          <CheckCircle2 className="h-5 w-5" />
          Outcome saved
        </div>
        {!paused ? (
          <>
            <p className="text-5xl font-bold text-gray-800 tabular-nums leading-none mb-2">{countdown}</p>
            <p className="text-gray-400 text-sm">Next lead ready in {countdown}… press <kbd className="bg-gray-100 px-1 rounded text-xs">G</kbd> to go now</p>
          </>
        ) : (
          <p className="text-amber-700 text-sm font-medium">Queue paused — resume to continue</p>
        )}
      </div>

      {/* Next lead preview — uses already-loaded queue data, no extra API calls */}
      {nextLead && contact ? (
        <div className="bg-gray-50 rounded-xl p-4 mb-5 border border-gray-200">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Up Next</p>
          <p className="font-semibold text-gray-900 text-base truncate">{contact.displayName}</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {contact.crmStage && (
              <span className="text-xs px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full font-medium">
                {contact.crmStage}
              </span>
            )}
            {contact.lastDisposition && (
              <span className="text-xs px-2 py-0.5 bg-purple-50 text-purple-700 rounded-full">
                {contact.lastDisposition}
                {contact.lastDispositionAt ? ` · ${relativeTime(contact.lastDispositionAt)}` : ""}
              </span>
            )}
            {nextLead.attemptCount > 0 && (
              <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full">
                Called {nextLead.attemptCount}×
                {nextLead.lastAttemptAt ? ` · last ${relativeTime(nextLead.lastAttemptAt)}` : ""}
              </span>
            )}
            {nextLead.callbackAt && (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                callbackTimeLabel(nextLead.callbackAt).urgent
                  ? "bg-red-100 text-red-700"
                  : "bg-yellow-50 text-yellow-700"
              }`}>
                {callbackTimeLabel(nextLead.callbackAt).label}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="text-center text-gray-400 text-sm py-3 mb-5">
          No more leads in this filter — queue complete after this.
        </div>
      )}

      {/* CTAs */}
      <div className="flex gap-3">
        <button
          onClick={onGoNow}
          className="flex-1 flex items-center justify-center gap-2 py-3 bg-blue-600 text-white rounded-xl font-bold text-base hover:bg-blue-700 active:bg-blue-800 transition-colors shadow-sm"
        >
          <ArrowRight className="h-5 w-5" />
          Go Now
        </button>
        <button
          onClick={onPause}
          className="flex items-center gap-1.5 px-4 py-3 bg-amber-100 text-amber-800 rounded-xl font-medium text-sm hover:bg-amber-200 transition-colors"
        >
          <Pause className="h-4 w-4" />
          Pause
        </button>
        <button
          onClick={onSkipNext}
          disabled={!nextLead}
          className="flex items-center gap-1.5 px-4 py-3 bg-gray-100 text-gray-600 rounded-xl text-sm hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <SkipForward className="h-4 w-4" />
          Skip Next
        </button>
      </div>
      <p className="text-center text-xs text-gray-400 mt-2.5">
        <kbd className="bg-gray-100 px-1 rounded">G</kbd> Go Now ·{" "}
        <kbd className="bg-gray-100 px-1 rounded">P</kbd> Pause/Resume ·{" "}
        <kbd className="bg-gray-100 px-1 rounded">X</kbd> Skip Next
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

  const [queue, setQueue] = useState<QueueMember[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<QueueCounts>({ pending: 0, due: 0, overdue: 0, upcoming: 0 });
  const [filter, setFilter] = useState<QueueFilter>("pending");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
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

  // Wrap-up timer state — shown between leads after a successful outcome save
  const [wrapUpActive, setWrapUpActive] = useState(false);
  const [wrapUpCountdown, setWrapUpCountdown] = useState(WRAP_UP_SECONDS);
  const wrapUpTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const phone = useSipPhone();
  const sipReady = phone?.regState === "registered";

  const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;

  const load = useCallback(async (f?: QueueFilter) => {
    // In power mode use the URL-derived filter unless an explicit override is passed
    const activeFilter = f ?? (powerModeActive ? powerFilter : filter);
    setLoading(true);
    setError("");
    try {
      const res = await apiGet<{ queue: QueueMember[]; total: number; counts: QueueCounts }>(
        `/crm/queue?filter=${activeFilter}`,
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
  }, [filter, powerFilter, powerModeActive, token]);

  useEffect(() => { load(); }, [load]);

  // Sync URL power filter → local filter state so TabButtons reflect it
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
    load(f);
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

  function openWorkspacePowerMode(member: QueueMember) {
    const params = new URLSearchParams({ contactId: member.contactId });
    if (member.campaign) params.set("campaignId", member.campaign.id);
    params.set("memberId", member.id);
    params.set("mode", "power");
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

  return (
    <div className="min-h-screen bg-gray-50">
      {callbackModalMember && (
        <SetCallbackModal
          member={callbackModalMember}
          onClose={() => setCallbackModalMember(null)}
          onSaved={() => { setCallbackModalMember(null); load(); }}
        />
      )}

      {/* Sticky Power Dialer action bar */}
      {powerModeActive && (
        <div className="sticky top-0 z-20 bg-blue-700 text-white shadow-lg">
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <Zap className="h-4 w-4 shrink-0" />
              <span className="font-bold text-sm shrink-0">Power Dialer</span>

              {/* Filter toggle — Pending / Due / Overdue */}
              <div className="flex rounded-lg overflow-hidden border border-blue-500 text-xs shrink-0">
                {(
                  [
                    { f: "pending" as QueueFilter, label: "Pending", count: counts.pending },
                    { f: "due" as QueueFilter, label: "Due", count: counts.due },
                    { f: "overdue" as QueueFilter, label: "Overdue", count: counts.overdue },
                  ] as const
                ).map(({ f, label, count }) => (
                  <button
                    key={f}
                    onClick={() => { setWrapUpActive(false); switchPowerFilter(f); }}
                    className={`px-2.5 py-1 font-medium transition-colors flex items-center gap-1 ${
                      filter === f
                        ? "bg-white text-blue-700"
                        : "text-blue-100 hover:bg-blue-600"
                    }`}
                  >
                    {label}
                    {count > 0 && (
                      <span className={`rounded-full px-1.5 leading-tight ${
                        f === "overdue" && count > 0
                          ? "bg-red-400 text-white"
                          : filter === f
                            ? "bg-blue-100 text-blue-700"
                            : "bg-blue-600 text-blue-100"
                      }`}>
                        {count}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {paused && (
                <span className="bg-amber-400 text-amber-900 text-xs font-bold px-2 py-0.5 rounded shrink-0">
                  PAUSED
                </span>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => { setPaused((p) => !p); setWrapUpActive(false); }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition-colors"
              >
                {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                {paused ? "Resume" : "Pause"}
              </button>
              <button
                onClick={() => router.push("/crm/queue")}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white/20 hover:bg-white/30 rounded-lg text-sm font-medium transition-colors"
              >
                <ZapOff className="h-3.5 w-3.5" />
                Stop
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-3xl mx-auto px-4 py-8">
        {/* Queue health banner — power mode sticky status (SIP, pause, overdue) */}
        {powerModeActive && !loading && (() => {
          if (!sipReady) return (
            <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-amber-50 border border-amber-300 rounded-xl text-sm text-amber-800">
              <AlertCircle className="h-4 w-4 shrink-0" />
              SIP disconnected — calls will not go through until you re-register
            </div>
          );
          if (paused) return (
            <div className="mb-4 flex items-center justify-between gap-2 px-4 py-3 bg-amber-50 border border-amber-300 rounded-xl text-sm text-amber-800">
              <span className="flex items-center gap-2">
                <Pause className="h-4 w-4 shrink-0" />
                Queue paused — press <kbd className="bg-amber-100 px-1 rounded mx-0.5">P</kbd> or Resume to continue
              </span>
            </div>
          );
          if (counts.overdue > 0 && filter === "pending") return (
            <div className="mb-4 flex items-center justify-between gap-2 px-4 py-3 bg-red-50 border border-red-300 rounded-xl text-sm text-red-800">
              <span className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {counts.overdue} callback{counts.overdue !== 1 ? "s" : ""} overdue
              </span>
              <button
                onClick={() => switchPowerFilter("overdue")}
                className="text-xs text-red-700 underline hover:no-underline shrink-0"
              >
                Switch to Overdue →
              </button>
            </div>
          );
          return null;
        })()}

        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <ListOrdered className="h-6 w-6 text-blue-600" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                My Queue{powerModeActive ? "" : ""}
              </h1>
              {!loading && (
                <p className="text-sm text-gray-500 mt-0.5">
                  {total === 0 ? "Nothing in this view" : `${total} lead${total !== 1 ? "s" : ""}`}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!powerModeActive && (
              <button
                onClick={() => router.push("/crm/queue?mode=power")}
                disabled={loading || total === 0}
                className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                title={total === 0 ? "No pending leads to dial" : "Start Power Dialer mode"}
              >
                <Zap className="h-4 w-4" />
                Start Power Dialer
              </button>
            )}
            <button onClick={() => load()} disabled={loading || acting} className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* Tabs — only shown in manual mode; power mode uses pending filter always */}
        {!powerModeActive && (
          <div className="flex gap-1 p-1 bg-gray-100 rounded-xl mb-5 overflow-x-auto">
            <TabButton active={filter === "pending"} label="Next Up" count={counts.pending} onClick={() => switchFilter("pending")} />
            <TabButton active={filter === "due"} label="Due Today" count={counts.due} urgent={counts.overdue > 0} onClick={() => switchFilter("due")} />
            <TabButton active={filter === "overdue"} label="Overdue" count={counts.overdue} urgent={counts.overdue > 0} onClick={() => switchFilter("overdue")} />
            <TabButton active={filter === "upcoming"} label="Upcoming" count={counts.upcoming} onClick={() => switchFilter("upcoming")} />
          </div>
        )}

        {/* Content */}
        {loading ? (
          <div className="py-24 text-center text-gray-400 text-sm">Loading…</div>
        ) : error ? (
          <div className="py-24 text-center text-red-500 text-sm">{error}</div>
        ) : !next ? (
          powerModeActive ? (
            // Power mode — queue exhausted
            <div className="py-24 text-center">
              <CheckCheck className="h-14 w-14 text-green-400 mx-auto mb-4" />
              <p className="text-gray-800 font-bold text-2xl mb-1">Queue Complete!</p>
              <p className="text-gray-400 text-sm mb-6">You&apos;ve worked through all pending leads.</p>
              <button
                onClick={() => router.push("/crm/queue")}
                className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 shadow"
              >
                Exit Power Dialer
              </button>
            </div>
          ) : (
            // Manual mode — empty state
            <div className="py-24 text-center">
              <Inbox className="h-12 w-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-600 font-medium text-lg">
                {filter === "pending" ? "Queue is empty" :
                 filter === "due" ? "No callbacks due today" :
                 filter === "overdue" ? "No overdue callbacks" :
                 "No upcoming callbacks"}
              </p>
              <p className="text-gray-400 text-sm mt-1">
                {filter === "pending" ? "No active campaigns with leads assigned to you." :
                 "Great! Check the Next Up tab for new leads."}
              </p>
              {filter !== "pending" && (
                <button onClick={() => switchFilter("pending")} className="mt-4 text-sm text-blue-600 hover:underline">
                  View Next Up →
                </button>
              )}
            </div>
          )
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
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b bg-gray-50">
                  <h2 className="text-sm font-semibold text-gray-700">
                    Up Next ({rest.length + 1} total remaining)
                  </h2>
                </div>
                {rest.map((m, i) => (
                  <QueueRow key={m.id} member={m} rank={i + 2} filter={filter} />
                ))}
                {total > queue.length && (
                  <div className="px-4 py-3 text-center text-sm text-gray-400">
                    + {total - queue.length} more in queue
                  </div>
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
              onAction={(action, extra) => handleAction(next.id, action, extra)}
            />

            {rest.length > 0 && (
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b bg-gray-50">
                  <h2 className="text-sm font-semibold text-gray-700">
                    {filter === "pending" ? `Up Next (${rest.length + 1} total remaining)` :
                     filter === "overdue" ? `Also Overdue (${rest.length + 1} total)` :
                     filter === "due" ? `Also Due Today (${rest.length + 1} total)` :
                     `Upcoming Callbacks (${rest.length + 1} total)`}
                  </h2>
                </div>
                {rest.map((m, i) => (
                  <QueueRow key={m.id} member={m} rank={i + 2} filter={filter} />
                ))}
                {total > queue.length && (
                  <div className="px-4 py-3 text-center text-sm text-gray-400">
                    + {total - queue.length} more in queue
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main page export — wraps inner component in Suspense for useSearchParams ──

export default function QueuePage() {
  return (
    <Suspense fallback={<div className="py-24 text-center text-gray-400 text-sm">Loading…</div>}>
      <QueuePageInner />
    </Suspense>
  );
}
