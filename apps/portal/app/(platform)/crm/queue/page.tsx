"use client";

import { Suspense, useEffect, useState, useCallback, useRef, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ListOrdered, PhoneCall, SkipForward, Clock, Ban,
  RefreshCw, CheckCheck, CalendarClock, UserCheck, X, Edit2,
  AlertCircle, Sparkles, Megaphone, Inbox, BarChart3, Flag,
} from "lucide-react";
import {
  CRMPageShell,
  CRMPageHeader,
  CRMActionBar,
  CRMWorkspaceShell,
  CRMWorkspaceChrome,
  CRMWorkspaceHeader,
  CRMWorkspaceToolbar,
  CRMWorkspaceBody,
  CRMWorkspaceMain,
  CRMWorkspaceScrollRegion,
  CRMWorkspaceRightRail,
  crm,
  cn,
  QueueOperationalRow,
  QueueEmptyOperational,
  QueueCountPill,
  type QueueOperationalStats,
} from "../../../../components/crm";
import { MEMBER_STATUS_COLORS, MEMBER_STATUS_LABELS } from "../../../../components/crm/queue/queueUtils";
import { apiGet, apiPatch } from "../../../../services/apiClient";
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

const SORT_MODE_KEY = "crm_queue_sort_mode";
const CAMPAIGN_FILTER_KEY = "crm_queue_campaign_id";

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

function PriorityFocusCards({
  counts,
  stats,
  loading,
}: {
  counts: QueueCounts;
  stats: QueueOperationalStats | null;
  loading: boolean;
}) {
  const highPriority = counts.overdue + (stats?.myTasksOverdue ?? 0);
  const items = [
    { label: "Due Today", value: counts.due + (stats?.myTasksDueToday ?? 0), sub: "Tasks", href: "/crm/queue?filter=due", icon: <CalendarClock className="h-4 w-4" />, accent: "violet" },
    { label: "Overdue", value: counts.overdue + (stats?.myTasksOverdue ?? 0), sub: "Tasks", href: "/crm/queue?filter=overdue", icon: <AlertCircle className="h-4 w-4" />, accent: "rose" },
    { label: "Follow Ups", value: (stats?.myCallbacksDueToday ?? 0) + (stats?.myOverdueCallbacks ?? 0), sub: "Tasks", href: "/crm/tasks", icon: <PhoneCall className="h-4 w-4" />, accent: "amber" },
    { label: "High Priority", value: highPriority, sub: "Tasks", href: highPriority > 0 ? "/crm/queue?filter=overdue" : "/crm/tasks", icon: <Flag className="h-4 w-4" />, accent: "pink" },
  ] as const;

  return (
    <section className="crm-queue-priority-section crm-queue-priority-rail">
      <div className="mb-3">
        <h2 className="text-sm font-bold text-crm-text">Priority Focus</h2>
        <p className="mt-0.5 text-[11px] text-crm-muted">Next work signals for your assigned queue</p>
      </div>
      <div className="grid gap-2">
        {items.map((item) => (
          <Link key={item.label} href={item.href} className={cn("crm-queue-priority-card", `crm-queue-priority-${item.accent}`)}>
            <span className="crm-queue-priority-icon">{item.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-bold text-crm-text">{item.label}</span>
              <span className="mt-1 block text-xl font-bold tabular-nums leading-none text-crm-text">{loading ? "-" : item.value}</span>
              <span className="mt-0.5 block text-[10px] text-crm-muted">{item.sub}</span>
            </span>
            <span className="text-[10px] font-bold text-crm-accent">Open</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ── Inner page component (needs useSearchParams) ───────────────────────────────

function QueuePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const urlManualFilter = searchParams.get("filter");
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
  const [filter, setFilter] = useState<QueueFilter>(() => initialManualFilter);
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
    if (typeof window === "undefined") return "original";
    const stored = localStorage.getItem(SORT_MODE_KEY) as SortMode | null;
    if (stored === "smart" || stored === "original") return stored;
    return "original";
  });
  const sortModeSetFromTenantDefault = useRef(false);

  const [callbackModalMember, setCallbackModalMember] = useState<QueueMember | null>(null);

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
        // Apply tenant default filter only if URL has no explicit filter.
        if (!searchParams.get("filter") && !filter) {
          const def = s.defaultQueueFilter?.toLowerCase();
          if (def === "pending" || def === "due" || def === "overdue" || def === "upcoming") {
            setFilter(def as QueueFilter);
          }
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const phone = useSipPhone();
  const sipReady = phone?.regState === "registered";

  const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;

  const load = useCallback(async (f?: QueueFilter, s?: SortMode, cid?: string | null) => {
    const activeFilter = f ?? filter;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, sortMode, campaignId, token]);

  useEffect(() => { load(); }, [load]);

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
    } catch {
      // Silently ignore; load() will restore current state
    }
    setActing(false);
  }

  function handleDial(member: QueueMember) {
    const phoneNumber = member.contact?.primaryPhone;
    if (!phoneNumber) return;
    if (!sipReady) return;
    window.dispatchEvent(new CustomEvent("crm:dial", { detail: { target: phoneNumber } }));
  }

  const queueReturnTo = useMemo(() => {
    const q = searchParams.toString();
    return q ? `/crm/queue?${q}` : "/crm/queue";
  }, [searchParams]);

  const next = queue[0] ?? null;
  const rest = queue.slice(1);
  const completedToday = opStats?.dispositionsToday ?? 0;
  const callsToday = opStats?.callsLinkedToday ?? 0;
  const sessionEfficiency = callsToday > 0 ? Math.round((completedToday / callsToday) * 100) : 0;

  return (
    <CRMPageShell className={crm.queueWorkspace} innerClassName={crm.pageInnerQueue}>
      {callbackModalMember && (
        <SetCallbackModal
          member={callbackModalMember}
          onClose={() => setCallbackModalMember(null)}
          onSaved={() => { setCallbackModalMember(null); load(); }}
        />
      )}

      <CRMWorkspaceShell>
        <CRMWorkspaceChrome>
          <CRMWorkspaceHeader>
            <CRMPageHeader
              className="crm-queue-hero"
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
                <div className="crm-queue-hero-actions flex flex-wrap items-center gap-2">
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
                  <button type="button" onClick={() => load()} disabled={loading || acting} className={crm.btnSecondary}>
                    <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                    Refresh
                  </button>
                </div>
              }
            />
          </CRMWorkspaceHeader>
          <CRMWorkspaceToolbar className="flex flex-col gap-3">
            <div className="crm-queue-kpi-strip grid w-full grid-cols-2 items-stretch gap-3 md:grid-cols-3 xl:grid-cols-6">
              <QueueCountPill label="Pending" count={counts.pending} active={filter === "pending"} icon={<Inbox className="h-4 w-4" />} accent="blue" onClick={() => switchFilter("pending")} disabled={loading} />
              <QueueCountPill label="Due" count={counts.due} active={filter === "due"} urgent={counts.due > 0} icon={<Clock className="h-4 w-4" />} accent="violet" onClick={() => switchFilter("due")} disabled={loading} />
              <QueueCountPill label="Overdue" count={counts.overdue} active={filter === "overdue"} urgent={counts.overdue > 0} icon={<AlertCircle className="h-4 w-4" />} accent="rose" onClick={() => switchFilter("overdue")} disabled={loading} />
              <QueueCountPill label="Upcoming" count={counts.upcoming} active={filter === "upcoming"} icon={<CalendarClock className="h-4 w-4" />} accent="amber" onClick={() => switchFilter("upcoming")} disabled={loading} />
              <QueueCountPill label="Completed Today" count={completedToday} active={false} icon={<CheckCheck className="h-4 w-4" />} accent="green" microcopy="0% vs yesterday" onClick={() => router.push("/crm/reports")} disabled={loading || opStatsLoading} />
              <QueueCountPill label="Session Efficiency" count={`${sessionEfficiency}%`} active={false} icon={<BarChart3 className="h-4 w-4" />} accent="cyan" microcopy={`${sessionEfficiency}% today`} onClick={() => router.push("/crm/reports")} disabled={loading || opStatsLoading} />
            </div>
            <CRMActionBar className="crm-queue-filter-bar">
              {campaigns.length > 0 ? (
                <div className="flex w-full flex-wrap items-center gap-2">
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
          </CRMWorkspaceToolbar>
        </CRMWorkspaceChrome>

        <CRMWorkspaceBody split={!loading && !error}>
          <CRMWorkspaceMain className="crm-queue-main-workspace">
            <CRMWorkspaceScrollRegion className="crm-queue-center-workspace flex min-w-0 flex-col gap-3">
        {loading ? (
          <div className="py-24 text-center text-crm-muted/80 text-sm">Loading…</div>
        ) : error ? (
          <div className="py-24 text-center text-red-500 text-sm">{error}</div>
        ) : !next ? (
          <>
            <QueueEmptyOperational
              filter={filter}
              campaignId={campaignId}
              onClearCampaign={() => switchCampaign(null)}
              onSwitchPending={() => switchFilter("pending")}
            />
          </>
        ) : (
          <>
            <MemberCard
              member={next}
              isTop={true}
              filter={filter}
              acting={acting}
              sipReady={sipReady}
              queueReturnTo={queueReturnTo}
              onDial={() => handleDial(next)}
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
                      onQuickCall={m.contact?.primaryPhone ? () => handleDial(m) : undefined}
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
            </CRMWorkspaceScrollRegion>
          </CRMWorkspaceMain>
          {!loading && !error ? (
            <CRMWorkspaceRightRail className="crm-queue-right-rail flex flex-col gap-3">
              <PriorityFocusCards counts={counts} stats={opStats} loading={opStatsLoading} />
            </CRMWorkspaceRightRail>
          ) : null}
        </CRMWorkspaceBody>
      </CRMWorkspaceShell>
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



