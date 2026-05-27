"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckSquare,
  AlertCircle,
  Clock,
  PhoneCall,
  CheckCheck,
  Megaphone,
  ListOrdered,
  Bell,
  Settings,
  BarChart3,
  Stethoscope,
  BookUser,
  Headset,
  Sparkles,
  CalendarDays,
  LayoutDashboard,
  Radio,
  UserPlus,
  ClipboardList,
} from "lucide-react";
import {
  CRMPageShell,
  CRMCard,
  CRMPageHeader,
  CRMStat,
  crm,
  cn,
  DashboardKpiTile,
  DashboardActionCard,
  DashboardListRow,
  DashboardSectionHeader,
  LiveCrmOperationsPanel,
  RecentActivityPanel,
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
    <div className="crm-dashboard-shortcuts grid grid-cols-2 gap-2">
      {items.map((a) => (
        <Link
          key={a.key}
          href={a.href}
          className="crm-dashboard-shortcut group flex items-center gap-2 rounded-crm border border-crm-border/70 bg-crm-surface-2/45 px-2.5 py-2 text-xs font-medium text-crm-text no-underline transition-all duration-200 hover:-translate-y-px hover:border-crm-border hover:bg-crm-surface-2"
        >
          <span className="crm-dashboard-shortcut-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/60 text-crm-accent">{a.icon}</span>
          <span className="truncate">{a.label}</span>
        </Link>
      ))}
    </div>
  );
}

/** Compact stat tile for Pipeline Snapshot — no icon, number-focused. */
function PipelineStat({
  label,
  value,
  href,
  tone,
}: {
  label: string;
  value: number | string;
  href?: string;
  tone?: "accent" | "danger" | "warn" | "success";
}) {
  const valueClass =
    tone === "accent"
      ? "text-crm-accent"
      : tone === "danger"
        ? "text-crm-danger"
        : tone === "warn"
          ? "text-crm-warning"
          : tone === "success"
            ? "text-crm-success"
            : "text-crm-text";

  const inner = (
    <div className="group relative overflow-hidden rounded-crm border border-crm-border/65 bg-crm-surface-2/35 px-3 py-2.5 transition-all duration-200 hover:-translate-y-px hover:border-crm-border/90 hover:bg-crm-surface-2/60">
      <div className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-crm-accent/50 opacity-0 transition-opacity group-hover:opacity-100" />
      <span className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">{label}</span>
      <span className={cn("mt-1 block text-xl font-bold tabular-nums leading-tight", valueClass)}>{value}</span>
    </div>
  );

  if (!href) return inner;
  return (
    <Link href={href} className="block no-underline text-inherit">
      {inner}
    </Link>
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

  // ── Derived metrics (each metric has exactly ONE display home) ────────────

  const alertData: FollowUpSummary | null = isPlatformAdmin
    ? (followUps ?? buildPersonalFollowUpSummary(taskStats))
    : buildPersonalFollowUpSummary(taskStats);

  const hourly = typeof window !== "undefined" ? new Date().getHours() : 12;
  const greet = greetingLabel(hourly);
  const firstName = user?.name?.split(/\s+/)[0] ?? "there";

  const activeCampaignsCount = daily?.activeCampaigns ?? taskStats?.activeCampaigns ?? 0;

  // Queue depth: admin gets team-wide; non-admin gets personal
  const queueDepth: number | string = isPlatformAdmin
    ? (pilotReadiness?.queuePendingOrInProgress ?? daily?.queueRemaining ?? "—")
    : (taskStats?.queueRemaining ?? 0);

  // Overdue callbacks: primary home is the KPI row. Action Required uses the same value.
  const overdueCallbacksCount = isPlatformAdmin
    ? (pilotReadiness?.overdueCallbacks ?? daily?.overdueCallbacks ?? 0)
    : (alertData?.callbacks?.overdue?.count ?? 0);

  const dueTodayCallbacks = alertData?.callbacks?.dueToday?.count ?? daily?.callbacksDueToday ?? 0;
  const callsTodayCount = daily?.callsLinkedToday ?? taskStats?.callsLinkedToday ?? "—";
  const contactsTodayCount = daily?.contactsCreatedToday ?? 0;

  const taskDueCount = isPlatformAdmin ? (taskStats?.dueToday ?? 0) : (taskStats?.myTasksDueToday ?? 0);
  const taskOverdueCount = isPlatformAdmin ? (taskStats?.overdue ?? 0) : (taskStats?.myTasksOverdue ?? 0);

  const activeCampaignRows = campaigns?.filter((c) => c.status === "ACTIVE").slice(0, 5) ?? [];
  const pausedCampaignRows = campaigns?.filter((c) => c.status === "PAUSED").slice(0, 3) ?? [];
  const importsToday =
    importBatches && importBatches.length > 0 ? countImportsToday(importBatches, new Date()) : null;
  const recentImports = (importBatches ?? []).slice(0, 3);

  const contactStats = stats ?? { total: 0, leads: 0, mine: 0, recentlyAdded: 0 };
  const queueNumeric = Number.isFinite(Number(queueDepth)) ? Number(queueDepth) : 0;
  const reminders = [
    dueTodayCallbacks > 0 && can("can_view_crm_queue")
      ? {
          key: "callbacks",
          href: "/crm/queue?filter=due",
          icon: <PhoneCall size={14} />,
          title: "Follow up on callbacks",
          meta: `${dueTodayCallbacks} due today`,
          tone: "danger" as const,
        }
      : null,
    activeCampaignsCount > 0 && can("can_view_crm_campaigns")
      ? {
          key: "campaigns",
          href: "/crm/campaigns?status=ACTIVE",
          icon: <Megaphone size={14} />,
          title: "Review campaigns",
          meta: `${activeCampaignsCount} active campaign${activeCampaignsCount === 1 ? "" : "s"}`,
          tone: "accent" as const,
        }
      : null,
    null,
  ].filter(Boolean) as {
    key: string;
    href: string;
    icon: React.ReactNode;
    title: string;
    meta: string;
    tone: "danger" | "accent" | "success";
  }[];

  const shortcuts = [
    can("can_view_crm_queue")
      ? { key: "queue", href: "/crm/queue", icon: <ListOrdered size={14} />, label: "Queue" }
      : null,
    can("can_view_crm_contacts")
      ? { key: "contacts", href: "/crm/contacts", icon: <BookUser size={14} />, label: "Contacts" }
      : null,
    can("can_view_crm_live_call")
      ? { key: "live", href: "/crm/live-call", icon: <Headset size={14} />, label: "Live call" }
      : null,
    can("can_view_crm_campaigns")
      ? { key: "campaigns", href: "/crm/campaigns", icon: <Megaphone size={14} />, label: "Campaigns" }
      : null,
    null,
    can("can_view_crm_reports")
      ? { key: "reports", href: "/crm/reports", icon: <BarChart3 size={14} />, label: "Reports" }
      : null,
    can("can_view_crm_settings")
      ? { key: "settings", href: "/crm/settings", icon: <Settings size={14} />, label: "Settings" }
      : null,
    isPlatformAdmin
      ? { key: "diag", href: "/crm/admin/diagnostics", icon: <Stethoscope size={14} />, label: "Diagnostics" }
      : null,
  ].filter(Boolean) as { key: string; href: string; icon: React.ReactNode; label: string }[];

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <CRMPageShell className={crm.dashboardWorkspace} innerClassName={crm.pageInnerDashboard}>
      <CRMPageHeader
        icon={<LayoutDashboard size={22} strokeWidth={1.75} />}
        title={`${greet}, ${firstName}`}
        subtitle="Here's what's happening with your communications operations."
        className="crm-dashboard-hero"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn(crm.chip, crm.chipActive)}>
              <Radio size={12} className="animate-pulse" /> Live
            </span>
            {can("can_view_crm_reports") ? (
              <Link href="/crm/reports?tab=operations" className={cn(crm.btnSecondary, "crm-dashboard-header-action text-xs")}>
                <BarChart3 size={14} /> Operations Report
              </Link>
            ) : null}
            {can("can_view_crm_settings") ? (
              <Link href="/crm/settings" className={cn(crm.btnSecondary, "crm-dashboard-header-action text-xs")}>
                <Settings size={14} /> Customize
              </Link>
            ) : null}
            <NotifHint data={alertData} loading={loading} />
          </div>
        }
      />

      {/* Main dashboard grid — KPI and operations left, operational rail right */}
      <div className="crm-dashboard-grid grid gap-4 lg:grid-cols-12">
        <div className="crm-dashboard-main-stack flex flex-col gap-4 lg:col-span-8">
          {/* Primary KPI row — each metric appears here only */}
          <section className="crm-dashboard-kpi-section">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <DashboardKpiTile
            label="Active campaigns"
            value={activeCampaignsCount}
            href={can("can_view_crm_campaigns") ? "/crm/campaigns?status=ACTIVE" : undefined}
            icon={<Megaphone size={17} />}
            loading={loading}
            series={Array.from({ length: 12 }, () => Number(activeCampaignsCount) || 0)}
            trendText="current"
            statusText={activeCampaignsCount > 0 ? "Running" : "Idle"}
            statusTone={activeCampaignsCount > 0 ? "positive" : "neutral"}
            accent="blue"
          />
          <DashboardKpiTile
            label={isPlatformAdmin ? "Queue depth" : "My queue"}
            value={queueDepth}
            href={can("can_view_crm_queue") ? "/crm/queue" : undefined}
            icon={<ListOrdered size={17} />}
            loading={loading}
            series={Array.from({ length: 12 }, () => (Number.isFinite(Number(queueDepth)) ? Number(queueDepth) : 0))}
            trendText="current"
            statusText={queueNumeric > 0 ? "Live queue" : "Clear"}
            statusTone={queueNumeric > 0 ? "syncing" : "positive"}
            accent="violet"
          />
          <DashboardKpiTile
            label="Overdue callbacks"
            value={overdueCallbacksCount}
            href={can("can_view_crm_queue") && overdueCallbacksCount > 0 ? "/crm/queue?filter=overdue" : undefined}
            icon={<AlertCircle size={17} />}
            tone={overdueCallbacksCount > 0 ? "danger" : "neutral"}
            loading={loading}
            series={Array.from({ length: 12 }, () => Number(overdueCallbacksCount) || 0)}
            trendText="current"
            statusText={overdueCallbacksCount > 0 ? "Degraded" : "Healthy"}
            statusTone={overdueCallbacksCount > 0 ? "danger" : "positive"}
            accent="rose"
          />
          <DashboardKpiTile
            label="Calls today"
            value={callsTodayCount}
            href={can("can_view_crm_reports") ? "/crm/reports?tab=operations" : undefined}
            icon={<PhoneCall size={17} />}
            loading={loading}
            series={Array.from({ length: 12 }, () => (Number.isFinite(Number(callsTodayCount)) ? Number(callsTodayCount) : 0))}
            trendText="current"
            statusText={Number(callsTodayCount) > 0 ? "Active" : "Quiet"}
            statusTone={Number(callsTodayCount) > 0 ? "positive" : "neutral"}
            accent="green"
          />
          <DashboardKpiTile
            label="Contacts today"
            value={contactsTodayCount}
            href={can("can_view_crm_contacts") ? "/crm/contacts" : undefined}
            icon={<UserPlus size={17} />}
            tone={contactsTodayCount > 0 ? "positive" : "neutral"}
            loading={loading}
            series={Array.from({ length: 12 }, () => Number(contactsTodayCount) || 0)}
            trendText="current"
            statusText={contactsTodayCount > 0 ? "Growing" : "Stable"}
            statusTone={contactsTodayCount > 0 ? "positive" : "neutral"}
            accent="cyan"
          />
          <DashboardKpiTile
            label="Tasks due"
            value={taskDueCount}
            href={can("can_view_crm_tasks") ? (taskDueCount > 0 ? "/crm/tasks?due=today" : "/crm/tasks") : undefined}
            icon={<ClipboardList size={17} />}
            tone={taskDueCount > 0 ? "warn" : "neutral"}
            loading={loading}
            series={Array.from({ length: 12 }, () => Number(taskDueCount) || 0)}
            trendText="current"
            statusText="Due today"
            statusTone={taskDueCount > 0 ? "warn" : "neutral"}
            accent="amber"
          />
            </div>
          </section>

          {/* Live CRM Operations — focal centerpiece */}
          <LiveCrmOperationsPanel
            loading={loading}
            queueDepth={queueDepth}
            overdueCallbacks={overdueCallbacksCount}
            dueTodayCallbacks={dueTodayCallbacks}
            callsToday={callsTodayCount}
            outcomesToday={daily?.dispositionsToday ?? "—"}
            contactsToday={contactsTodayCount}
            activeCampaigns={activeCampaignRows}
            queueOverdueItems={queueOverduePreview?.queue ?? []}
            queueDueItems={queueDuePreview?.queue ?? []}
            canViewQueue={can("can_view_crm_queue")}
            canViewCampaigns={can("can_view_crm_campaigns")}
          />

          {/* Pipeline Snapshot + Campaign Health — side by side */}
          <div className="grid gap-4 md:grid-cols-2">

            {/* Pipeline Snapshot — merges Contact Pipeline + Contact Growth */}
            <CRMCard className={cn("crm-dashboard-panel p-5", crm.opCard, "border-crm-border/80")}>
              <div className={crm.opCardGlow} />
              <div className="relative z-[1]">
              <DashboardSectionHeader
                title="Pipeline snapshot"
                action={{ label: "Contacts", href: "/crm/contacts" }}
              />
              {loading ? (
                <LoadingSkeleton rows={2} />
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <PipelineStat label="Total" value={contactStats.total} href="/crm/contacts" />
                  <PipelineStat
                    label="Leads"
                    value={contactStats.leads}
                    href="/crm/contacts?stage=LEAD"
                    tone="accent"
                  />
                  <PipelineStat
                    label="Assigned to me"
                    value={contactStats.mine}
                    href="/crm/contacts?assignedToMe=true"
                  />
                  <PipelineStat
                    label="New today"
                    value={daily?.contactsCreatedToday ?? 0}
                    tone={daily?.contactsCreatedToday ? "success" : undefined}
                  />
                </div>
              )}
              </div>
            </CRMCard>

            {/* Campaign Health — replaces Campaign Status donut + list */}
            {can("can_view_crm_campaigns") ? (
              <CRMCard className={cn("crm-dashboard-panel p-5", crm.opCard, "border-crm-border/80")}>
                <div className={crm.opCardGlow} />
                <div className="relative z-[1]">
                <DashboardSectionHeader
                  title="Campaign health"
                  action={{ label: "All campaigns", href: "/crm/campaigns" }}
                />
                {loading ? (
                  <LoadingSkeleton rows={3} />
                ) : activeCampaignRows.length === 0 && pausedCampaignRows.length === 0 ? (
                  <div className="rounded-crm border border-dashed border-crm-border/70 px-3 py-5 text-center">
                    <Sparkles size={16} className="mx-auto mb-1.5 text-crm-accent opacity-60" />
                    <p className="text-sm font-medium text-crm-text">No active campaigns</p>
                    <Link
                      href="/crm/campaigns"
                      className="mt-1 inline-block text-xs font-semibold text-crm-accent"
                    >
                      Create one →
                    </Link>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {activeCampaignRows.map((c) => (
                      <DashboardListRow
                        key={c.id}
                        title={c.name}
                        meta={`Active · ${c.memberCount ?? 0} members`}
                        href={`/crm/campaigns/${encodeURIComponent(c.id)}`}
                      />
                    ))}
                    {pausedCampaignRows.map((c) => (
                      <DashboardListRow
                        key={c.id}
                        title={c.name}
                        meta={`Paused · ${c.memberCount ?? 0} members`}
                        href={`/crm/campaigns/${encodeURIComponent(c.id)}`}
                      />
                    ))}
                  </div>
                )}
                </div>
              </CRMCard>
            ) : null}
          </div>
        </div>

        {/* Right — action column */}
        <aside className="crm-dashboard-right-rail flex flex-col gap-4 lg:col-span-4">
          <CRMCard className={cn("crm-dashboard-panel p-5", crm.opCard, "border-crm-border/80")}>
            <div className={crm.opCardGlow} />
            <div className="relative z-[1]">
              <DashboardSectionHeader title="Upcoming reminders" action={can("can_view_crm_tasks") ? { label: "View all", href: "/crm/tasks" } : undefined} />
              <div className="flex flex-col gap-2">
                {reminders.length > 0 ? reminders.map((item) => (
                  <Link
                    key={item.key}
                    href={item.href}
                    className={cn("crm-dashboard-reminder group flex items-center gap-3 rounded-crm border px-3 py-2.5 text-inherit no-underline transition-all duration-200 hover:-translate-y-px", `crm-dashboard-reminder-${item.tone}`)}
                  >
                    <span className="crm-dashboard-reminder-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-crm border">{item.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-crm-text">{item.title}</span>
                      <span className="mt-0.5 block truncate text-xs text-crm-muted">{item.meta}</span>
                    </span>
                  </Link>
                )) : (
                  <div className="crm-dashboard-empty-soft rounded-crm border border-dashed border-crm-border/70 px-3 py-4">
                    <p className="text-sm font-semibold text-crm-text">No reminders queued</p>
                    <p className="mt-1 text-xs text-crm-muted">Callbacks, active campaigns, and import activity will surface here.</p>
                  </div>
                )}
              </div>
            </div>
          </CRMCard>

          {/* Recent Activity — timeline or honest empty */}
          <RecentActivityPanel items={[]} />

          {/* Action Required — merges Needs Attention + Tasks (no ring chart) */}
          <CRMCard className={cn("crm-dashboard-panel p-5", crm.opCard, "border-crm-border/80")}>
            <div className={crm.opCardGlow} />
            <div className="relative z-[1]">
            <DashboardSectionHeader title="Action required" action={{ label: "Tasks", href: "/crm/tasks" }} />
            {loading ? (
              <LoadingSkeleton rows={4} />
            ) : (
              <div className="flex flex-col gap-2">
                {(alertData?.callbacks?.overdue?.count ?? 0) === 0 &&
                (alertData?.callbacks?.dueToday?.count ?? 0) === 0 &&
                taskOverdueCount === 0 &&
                taskDueCount === 0 ? (
                  <p className="flex items-center gap-2 rounded-crm border border-crm-success/25 bg-crm-success/8 px-3 py-2.5 text-sm font-medium text-crm-success">
                    <CheckCheck size={15} /> All caught up
                  </p>
                ) : null}

                {(alertData?.callbacks?.overdue?.count ?? 0) > 0 && can("can_view_crm_queue") ? (
                  <DashboardActionCard
                    href="/crm/queue?filter=overdue"
                    icon={<AlertCircle size={16} />}
                    label="Overdue callbacks"
                    count={alertData!.callbacks.overdue.count}
                    tone="danger"
                  />
                ) : null}

                {(alertData?.callbacks?.dueToday?.count ?? 0) > 0 && can("can_view_crm_queue") ? (
                  <DashboardActionCard
                    href="/crm/queue?filter=due"
                    icon={<Clock size={16} />}
                    label="Callbacks due today"
                    count={alertData!.callbacks.dueToday.count}
                    tone="warn"
                  />
                ) : null}

                {taskOverdueCount > 0 ? (
                  <DashboardActionCard
                    href="/crm/tasks?due=overdue"
                    icon={<CheckSquare size={16} />}
                    label="Overdue tasks"
                    count={taskOverdueCount}
                    tone="danger"
                  />
                ) : null}

                {taskDueCount > 0 ? (
                  <DashboardActionCard
                    href="/crm/tasks?due=today"
                    icon={<CalendarDays size={16} />}
                    label="Tasks due today"
                    count={taskDueCount}
                    tone="warn"
                  />
                ) : null}

                {/* Summary line when there's something but not all items show */}
                {(taskStats?.myOpen ?? 0) > 0 ? (
                  <p className="mt-1 text-xs text-crm-muted">
                    {taskStats!.myOpen} open task{taskStats!.myOpen !== 1 ? "s" : ""} total ·{" "}
                    <Link href="/crm/tasks" className="text-crm-accent hover:brightness-110">
                      View all →
                    </Link>
                  </p>
                ) : null}
              </div>
            )}
            </div>
          </CRMCard>

          {/* Compact Shortcuts */}
          {shortcuts.length > 0 ? (
            <CRMCard className={cn("crm-dashboard-panel p-5", crm.opCard, "border-crm-border/80")}>
              <div className={crm.opCardGlow} />
              <div className="relative z-[1]">
              <DashboardSectionHeader title="Shortcuts" />
              <ShortcutGrid items={shortcuts} />
              </div>
            </CRMCard>
          ) : null}

          {/* Recent imports — compact, sidebar-weight */}
          {can("can_view_crm_import") ? (
            <CRMCard className={cn("crm-dashboard-panel p-5", crm.opCard, "border-crm-border/80")}>
              <div className={crm.opCardGlow} />
              <div className="relative z-[1]">
              <DashboardSectionHeader
                title="Recent imports"
                action={{ label: "Import via Campaigns →", href: "/crm/campaigns" }}
              />
              {recentImports.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {recentImports.map((b) => (
                    <DashboardListRow
                      key={b.id}
                      title={b.fileName}
                      meta={`${formatShortDate(b.createdAt)} · ${b.status.toLowerCase()} · ${b.processedRows}/${b.totalRows}`}
                      href={`/crm/import?batch=${encodeURIComponent(b.id)}`}
                    />
                  ))}
                </div>
              ) : (
                <div className="crm-dashboard-empty-soft rounded-crm border border-dashed border-crm-border/70 px-3 py-4">
                  <p className="text-sm font-semibold text-crm-text">No recent imports</p>
                  <p className="mt-1 text-xs text-crm-muted">Completed import batches will appear here when available.</p>
                </div>
              )}
              </div>
            </CRMCard>
          ) : null}
        </aside>
      </div>
    </CRMPageShell>
  );
}
