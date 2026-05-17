"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  TrendingUp,
  CheckSquare,
  AlertCircle,
  Clock,
  PhoneCall,
  CheckCheck,
  Megaphone,
  ListOrdered,
  Bell,
  Settings,
  Upload,
  BarChart3,
  Stethoscope,
  BookUser,
  Headset,
  Sparkles,
  Inbox,
  CalendarDays,
  LayoutDashboard,
  Radio,
} from "lucide-react";
import {
  CRMPageShell,
  CRMCard,
  CRMPageHeader,
  CRMStat,
  crm,
  cn,
  CRMDonutChart,
  CRMHorizontalBars,
  CRMChartLegend,
  CRMRingMetric,
  DashboardKpiTile,
  DashboardChartPanel,
  DashboardActionCard,
  DashboardListRow,
  DashboardSectionHeader,
  buildPipelineSegments,
  buildGrowthSegments,
  buildCampaignSegments,
  buildFollowUpBars,
  buildTodayActivityBars,
} from "../../../../components/crm";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { apiGet } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";

// ── Types ─────────────────────────────────────────────────────────────────────

type CrmStats = {
  total: number;
  leads: number;
  mine: number;
  recentlyAdded: number;
};

type TaskStats = {
  myOpen: number;
  dueToday: number;
  overdue: number;
  callsLinkedToday?: number;
  dispositionsToday?: number;
  activeCampaigns?: number;
  queueRemaining?: number;
  myOverdueCallbacks?: number;
  myCallbacksDueToday?: number;
  myTasksOverdue?: number;
  myTasksDueToday?: number;
};

type FollowUpSummary = {
  callbacks: { overdue: { count: number }; dueToday: { count: number } };
  tasks: { overdue: { count: number }; dueToday: { count: number } };
};

type CrmSettingsShape = { enabled: boolean };

type DailyReport = {
  dispositionsToday: number;
  callsLinkedToday: number;
  contactsCreatedToday: number;
  tasksDueToday: number;
  overdueTasks: number;
  callbacksDueToday: number;
  overdueCallbacks: number;
  activeCampaigns: number;
  queueRemaining: number;
};

type PilotReadiness = {
  crmEnabled: boolean;
  usersWithCrmAccess: number;
  activeCampaigns: number;
  queuePendingOrInProgress: number;
  overdueCallbacks: number;
  smsProviderConfigured: boolean;
  smsReadinessApplicable: boolean;
};

type ImportBatchRow = {
  id: string;
  fileName: string;
  status: string;
  createdAt: string;
  totalRows: number;
  processedRows: number;
};

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  memberCount?: number;
};

type QueueMemberPreview = {
  id: string;
  contactId: string;
  status: string;
  callbackAt: string | null;
  contact: { displayName: string } | null;
  campaign: { id: string; name: string } | null;
};

type QueuePreviewResponse = {
  queue: QueueMemberPreview[];
  total: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPersonalFollowUpSummary(ts: TaskStats | null): FollowUpSummary | null {
  if (!ts) return null;
  return {
    callbacks: {
      overdue: { count: ts.myOverdueCallbacks ?? 0 },
      dueToday: { count: ts.myCallbacksDueToday ?? 0 },
    },
    tasks: {
      overdue: { count: ts.myTasksOverdue ?? 0 },
      dueToday: { count: ts.myTasksDueToday ?? 0 },
    },
  };
}

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function countImportsToday(batches: ImportBatchRow[], now: Date): number {
  const start = startOfLocalDay(now).getTime();
  return batches.filter((b) => new Date(b.createdAt).getTime() >= start).length;
}

function greetingLabel(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function formatShortDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function NotifHint({ data, loading }: { data: FollowUpSummary | null; loading: boolean }) {
  const [perm, setPerm] = useState<NotificationPermission | null>(null);
  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) setPerm(Notification.permission);
  }, []);
  const showBtn = perm === "default" && typeof window !== "undefined" && "Notification" in window;

  function request() {
    if (!("Notification" in window)) return;
    void Notification.requestPermission().then(setPerm);
  }

  if (loading || !data || !showBtn) return null;

  return (
    <button type="button" onClick={request} className={cn(crm.chip, "cursor-pointer hover:bg-crm-surface-2")}>
      <Bell size={12} /> Reminders
    </button>
  );
}

function ShortcutGrid({
  items,
}: {
  items: { key: string; href: string; icon: React.ReactNode; label: string }[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {items.map((a) => (
        <Link
          key={a.key}
          href={a.href}
          className="flex items-center gap-2 rounded-crm border border-crm-border bg-crm-surface-2/50 px-3 py-2 text-sm font-medium text-crm-text no-underline transition-colors hover:bg-crm-surface-2"
        >
          <span className="text-crm-accent">{a.icon}</span>
          <span className="truncate">{a.label}</span>
        </Link>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CrmDashboardPage() {
  const { can, backendJwtRole, user } = useAppContext();

  const isPlatformAdmin = useMemo(
    () =>
      backendJwtRole === "ADMIN" ||
      backendJwtRole === "TENANT_ADMIN" ||
      backendJwtRole === "SUPER_ADMIN",
    [backendJwtRole],
  );

  const [crmSettings, setCrmSettings] = useState<CrmSettingsShape | null>(null);
  const [stats, setStats] = useState<CrmStats | null>(null);
  const [taskStats, setTaskStats] = useState<TaskStats | null>(null);
  const [followUps, setFollowUps] = useState<FollowUpSummary | null>(null);
  const [daily, setDaily] = useState<DailyReport | null>(null);
  const [pilotReadiness, setPilotReadiness] = useState<PilotReadiness | null>(null);
  const [pilotLoadFailed, setPilotLoadFailed] = useState(false);
  const [importBatches, setImportBatches] = useState<ImportBatchRow[] | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [queueOverduePreview, setQueueOverduePreview] = useState<QueuePreviewResponse | null>(null);
  const [queueDuePreview, setQueueDuePreview] = useState<QueuePreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    const base = [
      apiGet<CrmSettingsShape>("/crm/settings"),
      apiGet<CrmStats>("/crm/contacts/stats"),
      apiGet<TaskStats>("/crm/tasks/stats"),
      apiGet<DailyReport>("/crm/reports/daily"),
    ] as const;

    const finishBase = (baseAll: PromiseSettledResult<PromiseSettledResult<unknown>[]>) => {
      if (baseAll.status !== "fulfilled") return false;
      const [sR, cR, tR, dR] = baseAll.value;
      setCrmSettings(sR.status === "fulfilled" ? (sR.value as CrmSettingsShape) : { enabled: false });
      setStats(
        cR.status === "fulfilled"
          ? (cR.value as CrmStats)
          : { total: 0, leads: 0, mine: 0, recentlyAdded: 0 },
      );
      setTaskStats(
        tR.status === "fulfilled"
          ? (tR.value as TaskStats)
          : { myOpen: 0, dueToday: 0, overdue: 0 },
      );
      setDaily(dR.status === "fulfilled" ? (dR.value as DailyReport) : null);
      return true;
    };

    if (isPlatformAdmin) {
      void Promise.allSettled([
        Promise.allSettled(base),
        apiGet<FollowUpSummary>("/crm/reports/follow-ups"),
        apiGet<PilotReadiness>("/crm/admin/pilot-readiness"),
        can("can_view_crm_import") ? apiGet<{ batches: ImportBatchRow[] }>("/crm/import/batches?limit=24") : Promise.resolve(null),
        can("can_view_crm_campaigns") ? apiGet<{ campaigns: CampaignRow[] }>("/crm/campaigns") : Promise.resolve(null),
        can("can_view_crm_queue")
          ? Promise.allSettled([
              apiGet<QueuePreviewResponse>("/crm/queue?filter=overdue&limit=4&sort=smart"),
              apiGet<QueuePreviewResponse>("/crm/queue?filter=due&limit=4&sort=smart"),
            ])
          : Promise.resolve(null),
      ]).then(([baseAll, followR, pilotR, importR, campR, queueWrap]) => {
        if (!active) return;
        if (!finishBase(baseAll)) {
          setLoading(false);
          return;
        }
        setFollowUps(followR.status === "fulfilled" ? followR.value : null);
        if (pilotR.status === "fulfilled") {
          setPilotReadiness(pilotR.value);
          setPilotLoadFailed(false);
        } else {
          setPilotReadiness(null);
          setPilotLoadFailed(true);
        }
        if (importR.status === "fulfilled" && importR.value && "batches" in importR.value) {
          setImportBatches(importR.value.batches);
        } else setImportBatches(null);
        if (campR.status === "fulfilled" && campR.value && "campaigns" in campR.value) {
          setCampaigns(campR.value.campaigns);
        } else setCampaigns(null);
        if (queueWrap.status === "fulfilled" && queueWrap.value && Array.isArray(queueWrap.value)) {
          const [o, d] = queueWrap.value;
          setQueueOverduePreview(o.status === "fulfilled" ? o.value : null);
          setQueueDuePreview(d.status === "fulfilled" ? d.value : null);
        } else {
          setQueueOverduePreview(null);
          setQueueDuePreview(null);
        }
        setLoading(false);
      });
    } else {
      void Promise.allSettled([
        Promise.allSettled(base),
        can("can_view_crm_import") ? apiGet<{ batches: ImportBatchRow[] }>("/crm/import/batches?limit=24") : Promise.resolve(null),
        can("can_view_crm_campaigns") ? apiGet<{ campaigns: CampaignRow[] }>("/crm/campaigns") : Promise.resolve(null),
        can("can_view_crm_queue")
          ? Promise.allSettled([
              apiGet<QueuePreviewResponse>("/crm/queue?filter=overdue&limit=4&sort=smart"),
              apiGet<QueuePreviewResponse>("/crm/queue?filter=due&limit=4&sort=smart"),
            ])
          : Promise.resolve(null),
      ]).then(([baseAll, importR, campR, queueWrap]) => {
        if (!active) return;
        if (!finishBase(baseAll)) {
          setLoading(false);
          return;
        }
        setFollowUps(null);
        setPilotReadiness(null);
        setPilotLoadFailed(false);
        if (importR.status === "fulfilled" && importR.value && "batches" in importR.value) {
          setImportBatches(importR.value.batches);
        } else setImportBatches(null);
        if (campR.status === "fulfilled" && campR.value && "campaigns" in campR.value) {
          setCampaigns(campR.value.campaigns);
        } else setCampaigns(null);
        if (queueWrap.status === "fulfilled" && queueWrap.value && Array.isArray(queueWrap.value)) {
          const [o, d] = queueWrap.value;
          setQueueOverduePreview(o.status === "fulfilled" ? o.value : null);
          setQueueDuePreview(d.status === "fulfilled" ? d.value : null);
        } else {
          setQueueOverduePreview(null);
          setQueueDuePreview(null);
        }
        setLoading(false);
      });
    }

    return () => {
      active = false;
    };
  }, [isPlatformAdmin]);

  const alertData: FollowUpSummary | null = isPlatformAdmin
    ? (followUps ?? buildPersonalFollowUpSummary(taskStats))
    : buildPersonalFollowUpSummary(taskStats);

  const hourly = typeof window !== "undefined" ? new Date().getHours() : 12;
  const greet = greetingLabel(hourly);
  const firstName = user?.name?.split(/\s+/)[0] ?? "there";

  const activeCampaignsCount = daily?.activeCampaigns ?? taskStats?.activeCampaigns ?? 0;
  const queueWorkloadTeam = daily?.queueRemaining ?? null;
  const queueWorkloadMine = taskStats?.queueRemaining ?? 0;
  const importsToday =
    importBatches && importBatches.length > 0 ? countImportsToday(importBatches, new Date()) : null;

  const pausedCampaigns = campaigns?.filter((c) => c.status === "PAUSED").slice(0, 3) ?? [];
  const activeCampaignRows = campaigns?.filter((c) => c.status === "ACTIVE").slice(0, 4) ?? [];

  const taskDueCount = isPlatformAdmin ? (taskStats?.dueToday ?? 0) : (taskStats?.myTasksDueToday ?? 0);
  const taskOverdueCount = isPlatformAdmin ? (taskStats?.overdue ?? 0) : (taskStats?.myTasksOverdue ?? 0);
  const taskOpenCount = taskStats?.myOpen ?? 0;
  const taskPressureMax = Math.max(1, taskOpenCount + taskDueCount + taskOverdueCount);

  const contactStats = stats ?? { total: 0, leads: 0, mine: 0, recentlyAdded: 0 };
  const pipelineSegments = buildPipelineSegments(contactStats);
  const growthSegments = buildGrowthSegments(contactStats);
  const campaignSegments = buildCampaignSegments(campaigns ?? []);
  const followUpBars = alertData ? buildFollowUpBars(alertData) : [];
  const todayBars = daily ? buildTodayActivityBars(daily) : [];

  const recentImports = (importBatches ?? []).slice(0, 4);

  const shortcuts = [
    can("can_view_crm_queue")
      ? { key: "queue", href: "/crm/queue", icon: <ListOrdered size={16} />, label: "Queue" }
      : null,
    can("can_view_crm_contacts")
      ? { key: "contacts", href: "/crm/contacts", icon: <BookUser size={16} />, label: "Contacts" }
      : null,
    can("can_view_crm_live_call")
      ? { key: "live", href: "/crm/live-call", icon: <Headset size={16} />, label: "Live call" }
      : null,
    can("can_view_crm_campaigns")
      ? { key: "campaigns", href: "/crm/campaigns", icon: <Megaphone size={16} />, label: "Campaigns" }
      : null,
    can("can_view_crm_import")
      ? { key: "import", href: "/crm/import", icon: <Upload size={16} />, label: "Import" }
      : null,
    can("can_view_crm_reports")
      ? { key: "reports", href: "/crm/reports", icon: <BarChart3 size={16} />, label: "Reports" }
      : null,
    can("can_view_crm_settings")
      ? { key: "settings", href: "/crm/settings", icon: <Settings size={16} />, label: "Settings" }
      : null,
    isPlatformAdmin
      ? { key: "diag", href: "/crm/admin/diagnostics", icon: <Stethoscope size={16} />, label: "Diagnostics" }
      : null,
  ].filter(Boolean) as { key: string; href: string; icon: React.ReactNode; label: string }[];

  const todayLine = daily
    ? `${daily.callsLinkedToday} calls · ${daily.dispositionsToday} outcomes · ${daily.contactsCreatedToday} new contacts`
    : null;

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        icon={<LayoutDashboard size={22} strokeWidth={1.75} />}
        title="Command center"
        subtitle={`${greet}, ${firstName}${todayLine ? ` · Today: ${todayLine}` : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn(crm.chip, crm.chipActive)}>
              <Radio size={12} className="animate-pulse" /> Live
            </span>
            <NotifHint data={alertData} loading={loading} />
          </div>
        }
      />

      {isPlatformAdmin ? (
        <CRMCard className="p-4">
          <DashboardSectionHeader title="Workspace health" action={{ label: "Diagnostics", href: "/crm/admin/diagnostics" }} />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            <CRMStat label="CRM" value={crmSettings?.enabled ? "On" : "Off"} />
            <CRMStat label="Users" value={pilotLoadFailed ? "—" : (pilotReadiness?.usersWithCrmAccess ?? "—")} />
            <CRMStat label="Campaigns" value={pilotLoadFailed ? "—" : (pilotReadiness?.activeCampaigns ?? "—")} />
            <CRMStat label="Queue depth" value={pilotLoadFailed ? "—" : (pilotReadiness?.queuePendingOrInProgress ?? "—")} />
            <CRMStat
              label="Overdue CB"
              value={pilotLoadFailed ? "—" : (pilotReadiness?.overdueCallbacks ?? "—")}
              emphasize={!pilotLoadFailed && (pilotReadiness?.overdueCallbacks ?? 0) > 0 ? "danger" : "default"}
            />
            {!pilotLoadFailed && pilotReadiness?.smsReadinessApplicable ? (
              <CRMStat label="SMS" value={pilotReadiness.smsProviderConfigured ? "Ready" : "Setup"} />
            ) : null}
          </dl>
        </CRMCard>
      ) : null}

      <section>
        <p className={cn(crm.label, "mb-3")}>Today</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <DashboardKpiTile
            label="Active campaigns"
            value={activeCampaignsCount}
            href={can("can_view_crm_campaigns") ? "/crm/campaigns?status=ACTIVE" : undefined}
            icon={<Megaphone size={17} />}
            loading={loading}
          />
          <DashboardKpiTile
            label="Leads"
            value={stats?.leads ?? 0}
            href="/crm/contacts?stage=LEAD"
            icon={<TrendingUp size={17} />}
            loading={loading}
          />
          <DashboardKpiTile
            label={isPlatformAdmin ? "Queue depth" : "My queue"}
            value={isPlatformAdmin ? (queueWorkloadTeam ?? "—") : queueWorkloadMine}
            href={can("can_view_crm_queue") ? "/crm/queue" : undefined}
            icon={<ListOrdered size={17} />}
            loading={loading}
          />
          {can("can_view_crm_import") ? (
            <DashboardKpiTile
              label="Imports today"
              value={importsToday ?? "—"}
              href="/crm/import"
              icon={<Upload size={17} />}
              loading={loading}
            />
          ) : null}
          <DashboardKpiTile
            label="Outcomes"
            value={daily?.dispositionsToday ?? "—"}
            href={can("can_view_crm_reports") ? "/crm/reports?tab=agents" : undefined}
            icon={<CheckCheck size={17} />}
            loading={loading}
          />
          <DashboardKpiTile
            label="Calls linked"
            value={daily?.callsLinkedToday ?? taskStats?.callsLinkedToday ?? "—"}
            href="/crm/contacts"
            icon={<PhoneCall size={17} />}
            loading={loading}
          />
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-12">
        <div className="flex flex-col gap-5 lg:col-span-8">
          <div className="grid gap-5 md:grid-cols-2">
            <DashboardChartPanel title="Contact pipeline" action={{ label: "Contacts", href: "/crm/contacts" }}>
              <CRMDonutChart
                segments={pipelineSegments}
                centerValue={contactStats.total}
                centerLabel="total"
              />
              <CRMChartLegend segments={pipelineSegments} />
            </DashboardChartPanel>

            <DashboardChartPanel
              title="Follow-up pressure"
              action={can("can_view_crm_queue") ? { label: "Queue", href: "/crm/queue" } : undefined}
            >
              {loading ? (
                <LoadingSkeleton rows={4} />
              ) : alertData ? (
                <CRMHorizontalBars items={followUpBars} />
              ) : (
                <p className="text-sm text-crm-muted">No follow-up data</p>
              )}
            </DashboardChartPanel>

            <DashboardChartPanel
              title="Campaign status"
              action={can("can_view_crm_campaigns") ? { label: "Campaigns", href: "/crm/campaigns" } : undefined}
            >
              <CRMDonutChart
                segments={campaignSegments}
                centerValue={(campaigns ?? []).length}
                centerLabel="campaigns"
              />
              <CRMChartLegend segments={campaignSegments} />
            </DashboardChartPanel>

            <DashboardChartPanel
              title="Today's activity"
              action={can("can_view_crm_reports") ? { label: "Reports", href: "/crm/reports" } : undefined}
            >
              {loading ? (
                <LoadingSkeleton rows={4} />
              ) : daily ? (
                <CRMHorizontalBars items={todayBars} />
              ) : (
                <p className="text-sm text-crm-muted">No activity yet today</p>
              )}
            </DashboardChartPanel>
          </div>

          <DashboardChartPanel title="Contact growth" action={{ label: "Mine", href: "/crm/contacts?assignedToMe=true" }}>
            <CRMDonutChart segments={growthSegments} centerValue={contactStats.recentlyAdded} centerLabel="new 7d" />
            <div className="flex flex-col gap-2 sm:pl-2">
              <CRMChartLegend segments={growthSegments} />
              <dl className="mt-2 grid grid-cols-2 gap-3 border-t border-crm-border/60 pt-3">
                <CRMStat label="Assigned to me" value={contactStats.mine} />
                <CRMStat label="Leads" value={contactStats.leads} />
              </dl>
            </div>
          </DashboardChartPanel>
        </div>

        <aside className="flex flex-col gap-5 lg:col-span-4">
          <CRMCard className="p-5">
            <DashboardSectionHeader title="Needs attention" />
            {loading ? (
              <LoadingSkeleton rows={3} />
            ) : alertData ? (
              <div className="flex flex-col gap-2">
                {(alertData.callbacks?.overdue?.count ?? 0) === 0 &&
                (alertData.callbacks?.dueToday?.count ?? 0) === 0 &&
                (alertData.tasks?.overdue?.count ?? 0) === 0 &&
                (alertData.tasks?.dueToday?.count ?? 0) === 0 ? (
                  <p className="flex items-center gap-2 text-sm text-crm-muted">
                    <CheckCheck size={16} className="text-crm-success" /> All clear
                  </p>
                ) : null}
                {(alertData.callbacks?.overdue?.count ?? 0) > 0 && can("can_view_crm_queue") ? (
                  <DashboardActionCard
                    href="/crm/queue?filter=overdue"
                    icon={<AlertCircle size={16} />}
                    label="Overdue callbacks"
                    count={alertData.callbacks!.overdue.count}
                    tone="danger"
                  />
                ) : null}
                {(alertData.callbacks?.dueToday?.count ?? 0) > 0 && can("can_view_crm_queue") ? (
                  <DashboardActionCard
                    href="/crm/queue?filter=due"
                    icon={<Clock size={16} />}
                    label="Callbacks due today"
                    count={alertData.callbacks!.dueToday.count}
                    tone="warn"
                  />
                ) : null}
                {(alertData.tasks?.overdue?.count ?? 0) > 0 ? (
                  <DashboardActionCard
                    href="/crm/tasks?due=overdue"
                    icon={<CheckSquare size={16} />}
                    label="Overdue tasks"
                    count={alertData.tasks!.overdue.count}
                    tone="danger"
                  />
                ) : null}
                {(alertData.tasks?.dueToday?.count ?? 0) > 0 ? (
                  <DashboardActionCard
                    href="/crm/tasks?due=today"
                    icon={<CalendarDays size={16} />}
                    label="Tasks due today"
                    count={alertData.tasks!.dueToday.count}
                    tone="warn"
                  />
                ) : null}
              </div>
            ) : null}
          </CRMCard>

          <CRMCard className="p-5">
            <DashboardSectionHeader title="Tasks" action={{ label: "Open tasks", href: "/crm/tasks" }} />
            {loading ? (
              <LoadingSkeleton rows={2} />
            ) : (
              <div className="flex flex-col gap-4">
                <CRMRingMetric
                  value={taskOverdueCount}
                  max={taskPressureMax}
                  label="Overdue"
                  sublabel={`${taskOpenCount} open · ${taskDueCount} due today`}
                  color="var(--crm-danger)"
                />
                <div className="grid grid-cols-3 gap-2 border-t border-crm-border/60 pt-3">
                  <div className="text-center">
                    <div className="text-lg font-bold tabular-nums text-crm-text">{taskOpenCount}</div>
                    <div className="text-[10px] font-semibold uppercase text-crm-muted">Open</div>
                  </div>
                  <div className="text-center">
                    <div className="text-lg font-bold tabular-nums text-crm-warning">{taskDueCount}</div>
                    <div className="text-[10px] font-semibold uppercase text-crm-muted">Due</div>
                  </div>
                  <div className="text-center">
                    <div className="text-lg font-bold tabular-nums text-crm-danger">{taskOverdueCount}</div>
                    <div className="text-[10px] font-semibold uppercase text-crm-muted">Late</div>
                  </div>
                </div>
              </div>
            )}
          </CRMCard>

          {shortcuts.length > 0 ? (
            <CRMCard className="p-5">
              <DashboardSectionHeader title="Shortcuts" />
              <ShortcutGrid items={shortcuts} />
            </CRMCard>
          ) : null}
        </aside>
      </div>

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {can("can_view_crm_queue") ? (
          <CRMCard className="flex flex-col p-5">
            <DashboardSectionHeader title="Callbacks" action={{ label: "Queue", href: "/crm/queue" }} />
            {loading ? (
              <LoadingSkeleton rows={3} />
            ) : (
              <div className="flex flex-col gap-2">
                {(queueOverduePreview?.queue ?? []).length === 0 && (queueDuePreview?.queue ?? []).length === 0 ? (
                  <div className="rounded-crm border border-dashed border-crm-border px-3 py-4 text-center">
                    <Inbox size={18} className="mx-auto mb-2 text-crm-muted" />
                    <p className="text-sm font-medium text-crm-text">Queue clear in preview</p>
                    <Link href="/crm/queue" className="mt-2 inline-block text-xs font-semibold text-crm-accent">
                      Open queue →
                    </Link>
                  </div>
                ) : null}
                {(queueOverduePreview?.queue ?? []).map((m) => (
                  <DashboardListRow
                    key={`o-${m.id}`}
                    urgent
                    title={m.contact?.displayName ?? "Contact"}
                    meta={`Overdue · ${m.campaign?.name ?? "Campaign"}`}
                    href="/crm/queue?filter=overdue"
                  />
                ))}
                {(queueDuePreview?.queue ?? []).map((m) => (
                  <DashboardListRow
                    key={`d-${m.id}`}
                    title={m.contact?.displayName ?? "Contact"}
                    meta={`Due today · ${m.campaign?.name ?? "Campaign"}`}
                    href="/crm/queue?filter=due"
                  />
                ))}
              </div>
            )}
          </CRMCard>
        ) : null}

        {can("can_view_crm_campaigns") ? (
          <CRMCard className="flex flex-col p-5">
            <DashboardSectionHeader title="Campaigns" action={{ label: "All", href: "/crm/campaigns" }} />
            {loading ? (
              <LoadingSkeleton rows={2} />
            ) : (
              <div className="flex flex-col gap-2">
                {pausedCampaigns.map((c) => (
                  <DashboardListRow
                    key={c.id}
                    title={c.name}
                    meta={`Paused · ${c.memberCount ?? 0} members`}
                    href={`/crm/campaigns/${encodeURIComponent(c.id)}`}
                  />
                ))}
                {activeCampaignRows.map((c) => (
                  <DashboardListRow
                    key={c.id}
                    title={c.name}
                    meta={`Active · ${c.memberCount ?? 0} members`}
                    href={`/crm/campaigns/${encodeURIComponent(c.id)}`}
                  />
                ))}
                {!loading && activeCampaignRows.length === 0 && activeCampaignsCount === 0 ? (
                  <div className="rounded-crm border border-dashed border-crm-border px-3 py-4 text-center">
                    <Sparkles size={18} className="mx-auto mb-2 text-crm-accent" />
                    <p className="text-sm font-medium text-crm-text">No active campaigns</p>
                    <Link href="/crm/campaigns" className="mt-2 inline-block text-xs font-semibold text-crm-accent">
                      Create one →
                    </Link>
                  </div>
                ) : null}
              </div>
            )}
          </CRMCard>
        ) : null}

        {can("can_view_crm_import") ? (
          <CRMCard className="flex flex-col p-5">
            <DashboardSectionHeader title="Recent imports" action={{ label: "Import", href: "/crm/import" }} />
            {loading ? (
              <LoadingSkeleton rows={2} />
            ) : recentImports.length === 0 ? (
              <p className="text-sm text-crm-muted">No batches yet</p>
            ) : (
              <div className="flex flex-col gap-2">
                {recentImports.map((b) => (
                  <DashboardListRow
                    key={b.id}
                    title={b.fileName}
                    meta={`${formatShortDate(b.createdAt)} · ${b.status.toLowerCase()} · ${b.processedRows}/${b.totalRows}`}
                    href={`/crm/import?batch=${encodeURIComponent(b.id)}`}
                  />
                ))}
              </div>
            )}
          </CRMCard>
        ) : null}
      </div>
    </CRMPageShell>
  );
}
