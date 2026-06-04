"use client";

import { Suspense, useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ListOrdered, Clock, CheckCheck,
  RefreshCw, CalendarClock, X,
  AlertCircle, Sparkles, Megaphone, Inbox, BarChart3, Globe,
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
  QueueLeadDetailPanel,
  QueueLeadDetailPlaceholder,
  buildQueueContactWorkspaceHref,
  type QueueOperationalStats,
} from "../../../../components/crm";
import {
  QUEUE_TIMEZONE_FILTER_KEY,
  QUEUE_TIMEZONE_ZONE_OPTIONS,
  type TimezoneZoneFilter,
} from "../../../../components/crm/queue/queueTimezone";
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

  const [timezoneZone, setTimezoneZone] = useState<TimezoneZoneFilter>(() => {
    if (typeof window === "undefined") return "all";
    const stored = localStorage.getItem(QUEUE_TIMEZONE_FILTER_KEY) as TimezoneZoneFilter | null;
    if (stored && QUEUE_TIMEZONE_ZONE_OPTIONS.some((o) => o.value === stored)) return stored;
    return "all";
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
  const [activeIndex, setActiveIndex] = useState(0);

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

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (timezoneZone === "all") localStorage.removeItem(QUEUE_TIMEZONE_FILTER_KEY);
    else localStorage.setItem(QUEUE_TIMEZONE_FILTER_KEY, timezoneZone);
  }, [timezoneZone]);

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

  const load = useCallback(async (
    f?: QueueFilter,
    s?: SortMode,
    cid?: string | null,
    tz?: TimezoneZoneFilter,
  ) => {
    const activeFilter = f ?? filter;
    const activeSort = s ?? sortMode;
    // cid=undefined means "use current state", cid=null means "clear", cid=string means "use it"
    const activeCampaignId = cid !== undefined ? cid : campaignId;
    const activeTz = tz ?? timezoneZone;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ filter: activeFilter, sort: activeSort });
      if (activeCampaignId) params.set("campaignId", activeCampaignId);
      if (activeTz !== "all") params.set("timezoneZone", activeTz);
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
  }, [filter, sortMode, campaignId, timezoneZone, token]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setActiveIndex((idx) => {
      if (queue.length === 0) return 0;
      return Math.min(idx, queue.length - 1);
    });
  }, [queue]);

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

  function switchTimezoneZone(zone: TimezoneZoneFilter) {
    setTimezoneZone(zone);
    load(undefined, undefined, undefined, zone);
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

  const activeMember = queue[activeIndex] ?? null;
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
              compact
              className={crm.contactsHeaderPanel}
              icon={<ListOrdered className="h-6 w-6" aria-hidden />}
              title="My Queue"
              subtitle={
                loading
                  ? "Loading your assigned work…"
                  : total === 0
                    ? "Operational workbench — switch focus with queue snapshots"
                    : `${total} lead${total !== 1 ? "s" : ""} in this view`
              }
              actions={
                <div className="contacts-hero-actions flex flex-wrap items-center gap-2">
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
              <div className="crm-queue-filter-grid">
                {campaigns.length > 0 ? (
                  <div className="crm-queue-filter-field">
                    <Megaphone className="h-4 w-4 shrink-0 text-crm-muted" />
                    <label htmlFor="crm-queue-campaign" className={cn(crm.label, "shrink-0")}>Campaign</label>
                    <select
                      id="crm-queue-campaign"
                      value={campaignId ?? ""}
                      onChange={(e) => switchCampaign(e.target.value || null)}
                      className={cn(crm.input, "min-w-[10rem] flex-1 py-1.5")}
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
                <div className="crm-queue-filter-field">
                  <Globe className="h-4 w-4 shrink-0 text-crm-muted" />
                  <label htmlFor="crm-queue-timezone" className={cn(crm.label, "shrink-0")}>Timezone</label>
                  <select
                    id="crm-queue-timezone"
                    value={timezoneZone}
                    onChange={(e) => switchTimezoneZone(e.target.value as TimezoneZoneFilter)}
                    className={cn(crm.input, "min-w-[10rem] flex-1 py-1.5")}
                    disabled={loading}
                  >
                    {QUEUE_TIMEZONE_ZONE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  {timezoneZone !== "all" ? (
                    <button
                      type="button"
                      onClick={() => switchTimezoneZone("all")}
                      className="text-xs font-medium text-crm-accent hover:underline"
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
              </div>
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
        ) : queue.length === 0 ? (
          <QueueEmptyOperational
            filter={filter}
            campaignId={campaignId}
            onClearCampaign={() => switchCampaign(null)}
            onSwitchPending={() => switchFilter("pending")}
          />
        ) : (
          <div className="crm-queue-list-panel">
            <div className="crm-queue-list-head">
              <h2>
                {filter === "pending"
                  ? `Queue · ${queue.length} shown`
                  : filter === "overdue"
                    ? `Overdue · ${queue.length} shown`
                    : filter === "due"
                      ? `Due today · ${queue.length} shown`
                      : `Upcoming · ${queue.length} shown`}
              </h2>
              {timezoneZone !== "all" ? (
                <span className="text-[10px] font-semibold text-crm-accent">
                  {QUEUE_TIMEZONE_ZONE_OPTIONS.find((o) => o.value === timezoneZone)?.label}
                </span>
              ) : null}
            </div>
            <div className="crm-queue-row-list">
              {queue.map((m, i) => (
                <QueueOperationalRow
                  key={m.id}
                  member={m}
                  rank={i + 1}
                  isTop={i === 0}
                  isSelected={activeIndex === i}
                  onSelect={() => setActiveIndex(i)}
                />
              ))}
            </div>
            {total > queue.length && (
              <p className="border-t border-crm-border/60 py-2.5 text-center text-xs text-crm-muted/80">
                + {total - queue.length} more in queue (adjust filters or refresh)
              </p>
            )}
          </div>
        )}
            </CRMWorkspaceScrollRegion>
          </CRMWorkspaceMain>
          {!loading && !error ? (
            <CRMWorkspaceRightRail className="crm-queue-right-rail crm-queue-detail-rail flex flex-col min-h-0">
              {activeMember ? (
                <QueueLeadDetailPanel
                  member={activeMember}
                  rank={activeIndex + 1}
                  total={queue.length}
                  queueReturnTo={queueReturnTo}
                  acting={acting}
                  sipReady={sipReady}
                  canGoPrevious={activeIndex > 0}
                  canGoNext={activeIndex < queue.length - 1}
                  onPrevious={() => setActiveIndex((i) => Math.max(0, i - 1))}
                  onNext={() => setActiveIndex((i) => Math.min(queue.length - 1, i + 1))}
                  onAction={(action, extra) => handleAction(activeMember.id, action, extra)}
                  onDial={() => handleDial(activeMember)}
                />
              ) : (
                <QueueLeadDetailPlaceholder />
              )}
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



