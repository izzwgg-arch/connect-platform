"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  ListOrdered, PhoneCall, ExternalLink, SkipForward, Clock, Ban,
  RefreshCw, CheckCheck, Inbox, CalendarClock, UserCheck, X, Edit2,
  ChevronRight, AlertCircle,
} from "lucide-react";
import { apiGet, apiPost, apiPatch } from "../../../../services/apiClient";

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
  const diff = d.getTime() - now.getTime(); // positive = future
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
    // datetime-local format: YYYY-MM-DDTHH:MM
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

// ── Member Card ─────────────────────────────────────────────────────────────────

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

      {/* Pills */}
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

      {/* Actions */}
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

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function QueuePage() {
  const [queue, setQueue] = useState<QueueMember[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<QueueCounts>({ pending: 0, due: 0, overdue: 0, upcoming: 0 });
  const [filter, setFilter] = useState<QueueFilter>("pending");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [callbackModalMember, setCallbackModalMember] = useState<QueueMember | null>(null);

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

  async function handleAction(memberId: string, action: string, extra?: Record<string, unknown>) {
    if (action === "set-callback-modal") {
      const m = queue.find((x) => x.id === memberId);
      if (m) setCallbackModalMember(m);
      return;
    }
    setActing(true);
    try {
      await apiPatch(`/crm/queue/${memberId}`, { action, ...extra }, token);
      await load();
    } catch {}
    setActing(false);
  }

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

      <div className="max-w-3xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <ListOrdered className="h-6 w-6 text-blue-600" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900">My Queue</h1>
              {!loading && (
                <p className="text-sm text-gray-500 mt-0.5">
                  {total === 0 ? "Nothing in this view" : `${total} lead${total !== 1 ? "s" : ""}`}
                </p>
              )}
            </div>
          </div>
          <button onClick={() => load()} disabled={loading || acting} className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 p-1 bg-gray-100 rounded-xl mb-5 overflow-x-auto">
          <TabButton active={filter === "pending"} label="Next Up" count={counts.pending} onClick={() => switchFilter("pending")} />
          <TabButton active={filter === "due"} label="Due Today" count={counts.due} urgent={counts.overdue > 0} onClick={() => switchFilter("due")} />
          <TabButton active={filter === "overdue"} label="Overdue" count={counts.overdue} urgent={counts.overdue > 0} onClick={() => switchFilter("overdue")} />
          <TabButton active={filter === "upcoming"} label="Upcoming" count={counts.upcoming} onClick={() => switchFilter("upcoming")} />
        </div>

        {/* Content */}
        {loading ? (
          <div className="py-24 text-center text-gray-400 text-sm">Loading…</div>
        ) : error ? (
          <div className="py-24 text-center text-red-500 text-sm">{error}</div>
        ) : !next ? (
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
        ) : (
          <>
            {/* Primary card */}
            <MemberCard
              member={next}
              isTop={true}
              filter={filter}
              acting={acting}
              onAction={(action, extra) => handleAction(next.id, action, extra)}
            />

            {/* Remaining list */}
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
