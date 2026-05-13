"use client";

import { Suspense, useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ListOrdered, PhoneCall, ExternalLink, SkipForward, Clock, Ban,
  RefreshCw, CheckCheck, Inbox, CalendarClock, UserCheck, X, Edit2,
  ChevronRight, AlertCircle, Zap, ZapOff, Pause, Play,
} from "lucide-react";
import { apiGet, apiPatch } from "../../../../services/apiClient";
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
// Shown as the primary card in Power Dialer mode — large Call button, SIP check.

function PowerCard({
  member,
  sipReady,
  paused,
  acting,
  feedback,
  onCall,
  onAction,
  onOpenWorkspace,
}: {
  member: QueueMember;
  sipReady: boolean;
  paused: boolean;
  acting: boolean;
  feedback: string | null;
  onCall: () => void;
  onAction: (action: string, extra?: Record<string, unknown>) => void;
  onOpenWorkspace: () => void;
}) {
  const contact = member.contact;
  const phone = contact?.primaryPhone;
  const isCallback = member.status === "CALLBACK";
  const cb = member.callbackAt ? callbackTimeLabel(member.callbackAt) : null;

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

      {/* Pills: last disposition, last activity */}
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

      {/* Brief action feedback */}
      {feedback && (
        <div className="flex items-center gap-2 text-green-700 bg-green-50 text-sm px-3 py-2 rounded-lg mb-4 border border-green-200 font-semibold">
          <CheckCheck className="h-4 w-4 shrink-0" />
          {feedback} — loading next lead…
        </div>
      )}

      {/* LARGE CALL BUTTON */}
      <button
        onClick={onCall}
        disabled={!phone || !sipReady || acting || paused}
        className="w-full flex items-center justify-center gap-3 py-4 px-6 rounded-xl font-bold text-white text-lg mb-4 bg-green-500 hover:bg-green-600 active:bg-green-700 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed shadow-md disabled:shadow-none transition-all"
      >
        <PhoneCall className="h-6 w-6" />
        {phone ? `Call ${phone}` : "No phone number"}
      </button>

      {/* Secondary actions */}
      <div className="flex flex-wrap gap-2 mb-4">
        <button
          onClick={onOpenWorkspace}
          disabled={acting}
          className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
        >
          <ExternalLink className="h-3.5 w-3.5" />Open Workspace
        </button>
        {!isCallback && (
          <button
            onClick={() => onAction("skip")}
            disabled={acting || paused}
            className="flex items-center gap-1.5 px-2.5 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            <SkipForward className="h-3.5 w-3.5" />Skip
          </button>
        )}
        {!isCallback && (
          <button
            onClick={() => onAction("defer")}
            disabled={acting || paused}
            className="flex items-center gap-1.5 px-2.5 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            <Clock className="h-3.5 w-3.5" />Defer
          </button>
        )}
        <button
          onClick={() => onAction("set-callback-modal")}
          disabled={acting}
          className="flex items-center gap-1.5 px-2.5 py-2 border border-yellow-300 text-yellow-700 rounded-lg text-sm hover:bg-yellow-50 disabled:opacity-50"
        >
          <CalendarClock className="h-3.5 w-3.5" />
          {isCallback ? "Edit Callback" : "Set Callback"}
        </button>
        <button
          onClick={() => { if (confirm(`Mark ${contact?.displayName ?? "this contact"} as Do Not Call?`)) onAction("dnc"); }}
          disabled={acting || paused}
          className="flex items-center gap-1.5 px-2.5 py-2 border border-red-200 text-red-600 rounded-lg text-sm hover:bg-red-50 disabled:opacity-50"
        >
          <Ban className="h-3.5 w-3.5" />DNC
        </button>
      </div>

      {/* Keyboard hints */}
      {!paused && (
        <div className="text-xs text-gray-400 text-center select-none">
          Keyboard shortcuts: &nbsp;
          <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-xs font-mono">C</kbd> call &nbsp;
          <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-xs font-mono">S</kbd> skip &nbsp;
          <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-xs font-mono">D</kbd> defer
        </div>
      )}
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

// ── Inner page component (needs useSearchParams) ───────────────────────────────

function QueuePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const powerModeActive = searchParams.get("mode") === "power";

  const [queue, setQueue] = useState<QueueMember[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<QueueCounts>({ pending: 0, due: 0, overdue: 0, upcoming: 0 });
  const [filter, setFilter] = useState<QueueFilter>("pending");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [callbackModalMember, setCallbackModalMember] = useState<QueueMember | null>(null);
  const [paused, setPaused] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const phone = useSipPhone();
  const sipReady = phone?.regState === "registered";

  const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;

  const load = useCallback(async (f?: QueueFilter) => {
    const activeFilter = f ?? filter;
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
  }, [filter, token]);

  useEffect(() => { load(); }, [load]);

  function switchFilter(f: QueueFilter) {
    setFilter(f);
    load(f);
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

  // Keyboard shortcuts (C / S / D) — only active in power dialer mode, not while paused, not while typing
  const nextRef = useRef<QueueMember | null>(null);
  nextRef.current = queue[0] ?? null;

  useEffect(() => {
    if (!powerModeActive || paused) return;

    function handleKey(e: KeyboardEvent) {
      // Never fire while the user is typing in an input/textarea/select or contenteditable
      const tgt = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tgt.tagName)) return;
      if (tgt.getAttribute("contenteditable") === "true") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const current = nextRef.current;
      if (!current) return;

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
  }, [powerModeActive, paused, sipReady]);

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
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <Zap className="h-4 w-4 shrink-0" />
              <span className="font-bold text-sm">Power Dialer</span>
              {!loading && (
                <span className="text-xs text-blue-200 shrink-0">
                  {total === 0 ? "Queue empty" : `${total} lead${total !== 1 ? "s" : ""} remaining`}
                </span>
              )}
              {paused && (
                <span className="bg-amber-400 text-amber-900 text-xs font-bold px-2 py-0.5 rounded shrink-0">
                  PAUSED
                </span>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => setPaused((p) => !p)}
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
            <PowerCard
              member={next}
              sipReady={sipReady}
              paused={paused}
              acting={acting}
              feedback={actionFeedback}
              onCall={() => handlePowerDial(next)}
              onAction={(action, extra) => handleAction(next.id, action, extra)}
              onOpenWorkspace={() => openWorkspacePowerMode(next)}
            />

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
