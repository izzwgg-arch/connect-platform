"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Users,
  UserCheck,
  UserPlus,
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
  ChevronRight,
  BookUser,
  Headset,
  Sparkles,
  ArrowRight,
  Inbox,
  CalendarDays,
  LayoutDashboard,
} from "lucide-react";
import { PageHeader } from "../../../../components/PageHeader";
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
  importSource?: string;
  campaignId?: string | null;
};

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  priority?: string;
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

// ── Subcomponents ─────────────────────────────────────────────────────────────

function SoftPanel({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className="panel"
      style={{
        borderRadius: "0.75rem",
        border: "1px solid var(--border)",
        background: "var(--surface)",
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function KpiTile({
  label,
  value,
  sub,
  href,
  icon,
  loading,
  emphasize,
}: {
  label: string;
  value: number | string;
  sub?: string;
  href?: string;
  icon: React.ReactNode;
  loading: boolean;
  emphasize?: "neutral" | "attention" | "positive";
}) {
  const accentBorder =
    emphasize === "attention"
      ? "1px solid rgba(220,38,38,0.35)"
      : emphasize === "positive"
        ? "1px solid rgba(34,197,94,0.35)"
        : "1px solid var(--border)";

  const inner = (
    <div
      style={{
        padding: "1rem 1.1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.35rem",
        minHeight: "5.5rem",
        justifyContent: "flex-start",
        cursor: href ? "pointer" : "default",
        transition: "background 0.12s ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
        <span
          style={{
            fontSize: "0.6875rem",
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--text-dim)",
          }}
        >
          {label}
        </span>
        <span style={{ color: "var(--accent)", opacity: 0.85, display: "flex" }}>{icon}</span>
      </div>
      {loading ? (
        <div style={{ height: "2rem" }}>
          <LoadingSkeleton rows={1} />
        </div>
      ) : (
        <span style={{ fontSize: "1.65rem", fontWeight: 750, lineHeight: 1.1, color: "var(--text)" }}>{value}</span>
      )}
      {sub ? (
        <span style={{ fontSize: "0.75rem", color: "var(--text-dim)", lineHeight: 1.35 }}>{sub}</span>
      ) : null}
    </div>
  );

  return (
    <SoftPanel style={{ padding: 0, overflow: "hidden", border: accentBorder }}>
      {href ? (
        <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>
          {inner}
        </Link>
      ) : (
        inner
      )}
    </SoftPanel>
  );
}

function SectionTitle({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: { label: string; href: string };
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: "1rem",
        flexWrap: "wrap",
        marginBottom: "0.85rem",
      }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: "1.0625rem", fontWeight: 700, color: "var(--text)" }}>{title}</h2>
        {hint ? (
          <p style={{ margin: "0.25rem 0 0", fontSize: "0.8125rem", color: "var(--text-dim)", maxWidth: "48rem", lineHeight: 1.45 }}>
            {hint}
          </p>
        ) : null}
      </div>
      {action ? (
        <Link
          href={action.href}
          style={{
            fontSize: "0.8125rem",
            fontWeight: 600,
            color: "var(--accent)",
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
          }}
        >
          {action.label}
          <ArrowRight size={14} />
        </Link>
      ) : null}
    </div>
  );
}

function MiniListRow({
  title,
  meta,
  href,
  urgent,
}: {
  title: string;
  meta?: string;
  href: string;
  urgent?: boolean;
}) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.65rem",
        padding: "0.65rem 0.75rem",
        borderRadius: "0.5rem",
        textDecoration: "none",
        color: "inherit",
        border: "1px solid var(--border)",
        background: urgent ? "rgba(254,242,242,0.45)" : "var(--surface-hover)",
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontWeight: 600, fontSize: "0.875rem" }}>{title}</span>
        {meta ? (
          <span style={{ display: "block", fontSize: "0.75rem", color: "var(--text-dim)", marginTop: 2 }}>{meta}</span>
        ) : null}
      </span>
      <ChevronRight size={16} style={{ color: "var(--text-dim)", flexShrink: 0 }} />
    </Link>
  );
}

function ActionLinkRow({
  href,
  icon,
  label,
  hint,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  hint?: string;
}) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.65rem",
        padding: "0.55rem 0.65rem",
        borderRadius: "0.5rem",
        textDecoration: "none",
        color: "inherit",
        border: "1px solid var(--border)",
        background: "var(--surface-hover)",
      }}
    >
      <span style={{ color: "var(--accent)", display: "flex" }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontWeight: 600, fontSize: "0.875rem" }}>{label}</span>
        {hint ? <span style={{ display: "block", fontSize: "0.75rem", color: "var(--text-dim)", marginTop: 2 }}>{hint}</span> : null}
      </span>
      <ChevronRight size={16} style={{ color: "var(--text-dim)", flexShrink: 0 }} />
    </Link>
  );
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

  if (loading || !data) return null;
  const overdueTotal = (data.callbacks?.overdue?.count ?? 0) + (data.tasks?.overdue?.count ?? 0);
  if (!showBtn && overdueTotal === 0) return null;

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
      {showBtn ? (
        <button
          type="button"
          onClick={request}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.35rem",
            fontSize: "0.75rem",
            padding: "0.28rem 0.6rem",
            borderRadius: "999px",
            border: "1px solid var(--border)",
            background: "var(--surface-hover)",
            cursor: "pointer",
            color: "var(--text-dim)",
            fontWeight: 600,
          }}
        >
          <Bell size={12} /> Browser reminders
        </button>
      ) : null}
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
        if (baseAll.status !== "fulfilled") {
          setLoading(false);
          return;
        }
        const [sR, cR, tR, dR] = baseAll.value;
        setCrmSettings(sR.status === "fulfilled" ? sR.value : { enabled: false });
        setStats(cR.status === "fulfilled" ? cR.value : { total: 0, leads: 0, mine: 0, recentlyAdded: 0 });
        setTaskStats(tR.status === "fulfilled" ? tR.value : { myOpen: 0, dueToday: 0, overdue: 0 });
        setDaily(dR.status === "fulfilled" ? dR.value : null);
        setFollowUps(followR.status === "fulfilled" ? followR.value : null);
        if (pilotR.status === "fulfilled") {
          setPilotReadiness(pilotR.value);
          setPilotLoadFailed(false);
        } else {
          setPilotReadiness(null);
          setPilotLoadFailed(true);
        }
        if (
          importR.status === "fulfilled" &&
          importR.value &&
          typeof importR.value === "object" &&
          "batches" in importR.value
        ) {
          setImportBatches(importR.value.batches);
        } else {
          setImportBatches(null);
        }
        if (
          campR.status === "fulfilled" &&
          campR.value &&
          typeof campR.value === "object" &&
          "campaigns" in campR.value
        ) {
          setCampaigns(campR.value.campaigns);
        } else {
          setCampaigns(null);
        }
        if (
          queueWrap.status === "fulfilled" &&
          queueWrap.value &&
          Array.isArray(queueWrap.value)
        ) {
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
        if (baseAll.status !== "fulfilled") {
          setLoading(false);
          return;
        }
        const [sR, cR, tR, dR] = baseAll.value;
        setCrmSettings(sR.status === "fulfilled" ? sR.value : { enabled: false });
        setStats(cR.status === "fulfilled" ? cR.value : { total: 0, leads: 0, mine: 0, recentlyAdded: 0 });
        setTaskStats(tR.status === "fulfilled" ? tR.value : { myOpen: 0, dueToday: 0, overdue: 0 });
        setDaily(dR.status === "fulfilled" ? dR.value : null);
        setFollowUps(null);
        setPilotReadiness(null);
        setPilotLoadFailed(false);
        if (
          importR.status === "fulfilled" &&
          importR.value &&
          typeof importR.value === "object" &&
          "batches" in importR.value
        ) {
          setImportBatches(importR.value.batches);
        } else {
          setImportBatches(null);
        }
        if (
          campR.status === "fulfilled" &&
          campR.value &&
          typeof campR.value === "object" &&
          "campaigns" in campR.value
        ) {
          setCampaigns(campR.value.campaigns);
        } else {
          setCampaigns(null);
        }
        if (
          queueWrap.status === "fulfilled" &&
          queueWrap.value &&
          Array.isArray(queueWrap.value)
        ) {
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

  const pausedCampaigns =
    campaigns?.filter((c) => c.status === "PAUSED").slice(0, 3) ?? [];
  const activeCampaignRows = campaigns?.filter((c) => c.status === "ACTIVE").slice(0, 4) ?? [];

  const urgentCount =
    (alertData?.callbacks?.overdue?.count ?? 0) + (alertData?.tasks?.overdue?.count ?? 0);
  const dueTodayCount =
    (alertData?.callbacks?.dueToday?.count ?? 0) + (alertData?.tasks?.dueToday?.count ?? 0);

  const taskDueCount = isPlatformAdmin ? (taskStats?.dueToday ?? 0) : (taskStats?.myTasksDueToday ?? 0);
  const taskOverdueCount = isPlatformAdmin ? (taskStats?.overdue ?? 0) : (taskStats?.myTasksOverdue ?? 0);

  const adminActions = [
    can("can_view_crm_settings")
      ? {
          key: "settings",
          href: "/crm/settings",
          icon: <Settings size={18} />,
          label: "CRM settings & access",
          hint: "Defaults, users, and toggles",
        }
      : null,
    can("can_view_crm_import")
      ? {
          key: "import",
          href: "/crm/import",
          icon: <Upload size={18} />,
          label: "Import leads",
          hint: "CSV batches and history",
        }
      : null,
    can("can_view_crm_campaigns")
      ? {
          key: "campaign",
          href: "/crm/campaigns",
          icon: <Megaphone size={18} />,
          label: "Campaigns",
          hint: "Create, assign, and monitor",
        }
      : null,
    can("can_view_crm_reports")
      ? {
          key: "wallboard",
          href: "/crm/wallboard",
          icon: <BarChart3 size={18} />,
          label: "Live wallboard",
          hint: "Team queue snapshot",
        }
      : null,
    isPlatformAdmin
      ? {
          key: "diagnostics",
          href: "/crm/admin/diagnostics",
          icon: <Stethoscope size={18} />,
          label: "CRM diagnostics",
          hint: "Readiness checks",
        }
      : null,
  ].filter(Boolean) as { key: string; href: string; icon: React.ReactNode; label: string; hint: string }[];

  const agentActions = [
    can("can_view_crm_queue")
      ? {
          key: "queue",
          href: "/crm/queue",
          icon: <ListOrdered size={18} />,
          label: "My queue",
          hint: "Callbacks and next calls",
        }
      : null,
    can("can_view_crm_contacts")
      ? {
          key: "contacts",
          href: "/crm/contacts",
          icon: <BookUser size={18} />,
          label: "Contacts",
          hint: "Search and update records",
        }
      : null,
    can("can_view_crm_live_call")
      ? {
          key: "power",
          href: "/crm/live-call",
          icon: <Headset size={18} />,
          label: "Live call workspace",
          hint: "Power-dial entry",
        }
      : null,
  ].filter(Boolean) as { key: string; href: string; icon: React.ReactNode; label: string; hint: string }[];

  const recentImports = (importBatches ?? []).slice(0, 4);

  return (
    <div className="stack compact-stack" style={{ maxWidth: "1200px", margin: "0 auto" }}>
      <PageHeader
        title="Command center"
        subtitle="A focused view of what matters today—priorities first, details on demand."
      />

      {/* A — Hero / command strip */}
      <SoftPanel style={{ padding: "1.25rem 1.35rem" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: "0.85rem", alignItems: "flex-start" }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: "0.65rem",
                background: "color-mix(in srgb, var(--accent) 14%, transparent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--accent)",
                flexShrink: 0,
              }}
            >
              <LayoutDashboard size={22} strokeWidth={1.75} />
            </div>
            <div>
              <div style={{ fontSize: "1.125rem", fontWeight: 750, color: "var(--text)", letterSpacing: "-0.02em" }}>
                {greet}, {firstName}
              </div>
              <p style={{ margin: "0.35rem 0 0", fontSize: "0.875rem", color: "var(--text-dim)", lineHeight: 1.55, maxWidth: "36rem" }}>
                {loading ? (
                  <span style={{ display: "inline-block", minWidth: "12rem" }}>
                    <LoadingSkeleton rows={1} />
                  </span>
                ) : (
                  <>
                    {isPlatformAdmin
                      ? "Tenant snapshot: keep callbacks current, queue depth healthy, and campaigns moving."
                      : "Your next wins: clear overdue work first, then due-today follow-ups."}
                    {daily ? (
                      <>
                        {" "}
                        <span style={{ color: "var(--text-muted, var(--text-dim))" }}>
                          Today:{" "}
                          <Link href="/crm/reports" style={{ color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}>
                            {daily.callsLinkedToday} calls
                          </Link>
                          {" · "}
                          <Link href="/crm/reports" style={{ color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}>
                            {daily.dispositionsToday} outcomes
                          </Link>
                          {typeof daily.contactsCreatedToday === "number" ? (
                            <>
                              {" · "}
                              {daily.contactsCreatedToday} new contacts
                            </>
                          ) : null}
                        </span>
                      </>
                    ) : null}
                  </>
                )}
              </p>
            </div>
          </div>
          <NotifHint data={alertData} loading={loading} />
        </div>

        {/* Next actions — compact chips, not a banner wall */}
        {!loading && alertData ? (
          <div
            style={{
              marginTop: "1rem",
              paddingTop: "1rem",
              borderTop: "1px solid var(--border)",
              display: "flex",
              flexWrap: "wrap",
              gap: "0.5rem",
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-dim)", letterSpacing: "0.05em" }}>
              Next up
            </span>
            {urgentCount === 0 && dueTodayCount === 0 ? (
              <span style={{ fontSize: "0.8125rem", color: "var(--text-dim)", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                <CheckCheck size={14} style={{ color: "rgb(22,163,74)" }} /> No overdue callbacks or tasks in view.
              </span>
            ) : null}
            {(alertData.callbacks?.overdue?.count ?? 0) > 0 && can("can_view_crm_queue") ? (
              <Link
                href="/crm/queue?filter=overdue"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  padding: "0.35rem 0.65rem",
                  borderRadius: "999px",
                  background: "rgba(254,242,242,0.75)",
                  border: "1px solid rgba(252,165,165,0.8)",
                  color: "#b91c1c",
                  fontSize: "0.8125rem",
                  fontWeight: 700,
                  textDecoration: "none",
                }}
              >
                <AlertCircle size={14} /> {alertData.callbacks!.overdue.count} overdue callback
                {alertData.callbacks!.overdue.count !== 1 ? "s" : ""}
              </Link>
            ) : null}
            {(alertData.callbacks?.dueToday?.count ?? 0) > 0 && can("can_view_crm_queue") ? (
              <Link
                href="/crm/queue?filter=due"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  padding: "0.35rem 0.65rem",
                  borderRadius: "999px",
                  background: "var(--surface-hover)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                  fontSize: "0.8125rem",
                  fontWeight: 600,
                  textDecoration: "none",
                }}
              >
                <Clock size={14} /> {alertData.callbacks!.dueToday.count} due today
              </Link>
            ) : null}
            {(alertData.tasks?.overdue?.count ?? 0) > 0 ? (
              <Link
                href="/crm/tasks?due=overdue"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  padding: "0.35rem 0.65rem",
                  borderRadius: "999px",
                  background: "rgba(254,242,242,0.75)",
                  border: "1px solid rgba(252,165,165,0.8)",
                  color: "#b91c1c",
                  fontSize: "0.8125rem",
                  fontWeight: 700,
                  textDecoration: "none",
                }}
              >
                <CheckSquare size={14} /> {alertData.tasks!.overdue.count} overdue task{alertData.tasks!.overdue.count !== 1 ? "s" : ""}
              </Link>
            ) : null}
            {(alertData.tasks?.dueToday?.count ?? 0) > 0 ? (
              <Link
                href="/crm/tasks?due=today"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  padding: "0.35rem 0.65rem",
                  borderRadius: "999px",
                  background: "var(--surface-hover)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                  fontSize: "0.8125rem",
                  fontWeight: 600,
                  textDecoration: "none",
                }}
              >
                <CalendarDays size={14} /> {alertData.tasks!.dueToday.count} task{alertData.tasks!.dueToday.count !== 1 ? "si" : ""} due today
              </Link>
            ) : null}
            {can("can_view_crm_reports") ? (
              <Link href="/crm/reports" style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-dim)", marginLeft: "auto" }}>
                Open reports →
              </Link>
            ) : null}
          </div>
        ) : null}

      </SoftPanel>

      {/* Admin: compact workspace health (replaces giant readiness grid) */}
      {isPlatformAdmin ? (
        <SoftPanel style={{ padding: "1rem 1.15rem" }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
            <div style={{ fontSize: "0.8125rem", fontWeight: 700, color: "var(--text)" }}>Workspace health</div>
            <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>Live counts · same sources as diagnostics</span>
          </div>
          <div
            style={{
              marginTop: "0.85rem",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
              gap: "0.65rem 1.25rem",
            }}
          >
            <div>
              <div style={{ fontSize: "0.65rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-dim)" }}>CRM</div>
              <div style={{ fontSize: "0.9375rem", fontWeight: 700 }}>{crmSettings?.enabled ? "Enabled" : "Off"}</div>
            </div>
            <div>
              <div style={{ fontSize: "0.65rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-dim)" }}>Users w/ access</div>
              <div style={{ fontSize: "0.9375rem", fontWeight: 700 }}>{pilotLoadFailed ? "—" : (pilotReadiness?.usersWithCrmAccess ?? "—")}</div>
            </div>
            <div>
              <div style={{ fontSize: "0.65rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-dim)" }}>Active campaigns</div>
              <div style={{ fontSize: "0.9375rem", fontWeight: 700 }}>{pilotLoadFailed ? "—" : (pilotReadiness?.activeCampaigns ?? "—")}</div>
            </div>
            <div>
              <div style={{ fontSize: "0.65rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-dim)" }}>Queue depth</div>
              <div style={{ fontSize: "0.9375rem", fontWeight: 700 }}>{pilotLoadFailed ? "—" : (pilotReadiness?.queuePendingOrInProgress ?? "—")}</div>
            </div>
            <div>
              <div style={{ fontSize: "0.65rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-dim)" }}>Overdue callbacks</div>
              <div
                style={{
                  fontSize: "0.9375rem",
                  fontWeight: 700,
                  color: !pilotLoadFailed && (pilotReadiness?.overdueCallbacks ?? 0) > 0 ? "#b91c1c" : "var(--text)",
                }}
              >
                {pilotLoadFailed ? "—" : (pilotReadiness?.overdueCallbacks ?? "—")}
              </div>
            </div>
            {!pilotLoadFailed && pilotReadiness?.smsReadinessApplicable ? (
              <div>
                <div style={{ fontSize: "0.65rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-dim)" }}>SMS</div>
                <div style={{ fontSize: "0.9375rem", fontWeight: 700 }}>{pilotReadiness.smsProviderConfigured ? "Ready" : "Configure"}</div>
              </div>
            ) : null}
          </div>
        </SoftPanel>
      ) : null}

      {/* B — KPI row */}
      <section>
        <SectionTitle title="Signals" hint="Tap a tile to open the underlying list. All numbers are live from CRM APIs." />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
            gap: "0.85rem",
          }}
        >
          <KpiTile
            label="Active campaigns"
            value={activeCampaignsCount}
            sub="Running now"
            href={can("can_view_crm_campaigns") ? "/crm/campaigns?status=ACTIVE" : undefined}
            icon={<Megaphone size={17} />}
            loading={loading}
            emphasize="neutral"
          />
          <KpiTile
            label="Leads"
            value={stats?.leads ?? 0}
            sub="Stage: lead · needs nurture"
            href="/crm/contacts?stage=LEAD"
            icon={<TrendingUp size={17} />}
            loading={loading}
            emphasize="neutral"
          />
          <KpiTile
            label={isPlatformAdmin ? "Queue workload" : "My queue"}
            value={isPlatformAdmin ? (queueWorkloadTeam ?? "—") : queueWorkloadMine}
            sub={isPlatformAdmin ? "Pending + in progress (team)" : "Assigned, non-terminal"}
            href={can("can_view_crm_queue") ? "/crm/queue" : undefined}
            icon={<ListOrdered size={17} />}
            loading={loading}
            emphasize="neutral"
          />
          {can("can_view_crm_import") ? (
            <KpiTile
              label="Imports today"
              value={importsToday ?? "—"}
              sub={importsToday === null && !loading ? "No recent batch data" : "CSV batches started today"}
              href="/crm/import"
              icon={<Upload size={17} />}
              loading={loading}
              emphasize="neutral"
            />
          ) : null}
          <KpiTile
            label="Outcomes today"
            value={daily?.dispositionsToday ?? "—"}
            sub="Dispositions logged"
            href={can("can_view_crm_reports") ? "/crm/reports?tab=agents" : undefined}
            icon={<CheckCheck size={17} />}
            loading={loading}
            emphasize="neutral"
          />
          <KpiTile
            label="Calls linked"
            value={daily?.callsLinkedToday ?? taskStats?.callsLinkedToday ?? "—"}
            sub="CRM call events today"
            href="/crm/contacts"
            icon={<PhoneCall size={17} />}
            loading={loading}
            emphasize="neutral"
          />
        </div>
      </section>

      {/* C — Actionable work */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
          gap: "1.15rem",
          alignItems: "start",
        }}
      >
        {can("can_view_crm_queue") ? (
          <div>
            <SectionTitle title="Callbacks" hint="Top of your queue by priority." action={{ label: "View queue", href: "/crm/queue" }} />
            <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
              {loading ? (
                <LoadingSkeleton rows={3} />
              ) : (
                <>
                  {(queueOverduePreview?.queue ?? []).length === 0 && (queueDuePreview?.queue ?? []).length === 0 ? (
                    <SoftPanel style={{ padding: "0.9rem 1rem" }}>
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                        <Inbox size={18} style={{ color: "var(--text-dim)", flexShrink: 0, marginTop: 2 }} />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>No overdue or due-today callbacks in preview</div>
                          <p style={{ margin: "0.25rem 0 0", fontSize: "0.8125rem", color: "var(--text-dim)", lineHeight: 1.45 }}>
                            {(taskStats?.queueRemaining ?? 0) === 0
                              ? "Nothing assigned yet—ask a manager to add you to a campaign or assign leads."
                              : "Open the full queue for pending leads and other states."}
                          </p>
                          <Link href="/crm/queue" style={{ display: "inline-flex", marginTop: "0.5rem", fontSize: "0.8125rem", fontWeight: 600, color: "var(--accent)", textDecoration: "none" }}>
                            Go to queue →
                          </Link>
                        </div>
                      </div>
                    </SoftPanel>
                  ) : null}
                  {(queueOverduePreview?.queue ?? []).map((m) => (
                    <MiniListRow
                      key={`o-${m.id}`}
                      urgent
                      title={m.contact?.displayName ?? "Contact"}
                      meta={`Overdue · ${m.campaign?.name ?? "Campaign"}`}
                      href="/crm/queue?filter=overdue"
                    />
                  ))}
                  {(queueDuePreview?.queue ?? []).map((m) => (
                    <MiniListRow
                      key={`d-${m.id}`}
                      title={m.contact?.displayName ?? "Contact"}
                      meta={`Due today · ${m.campaign?.name ?? "Campaign"}`}
                      href="/crm/queue?filter=due"
                    />
                  ))}
                </>
              )}
            </div>
          </div>
        ) : null}

        {can("can_view_crm_campaigns") ? (
          <div>
            <SectionTitle
              title="Campaigns"
              hint="Where momentum usually stalls—or accelerates."
              action={{ label: "All campaigns", href: "/crm/campaigns" }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
              {loading ? <LoadingSkeleton rows={2} /> : null}
              {!loading && pausedCampaigns.length > 0 ? (
                <>
                  <div style={{ fontSize: "0.65rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-dim)", letterSpacing: "0.04em" }}>Paused</div>
                  {pausedCampaigns.map((c) => (
                    <MiniListRow
                      key={c.id}
                      title={c.name}
                      meta={`${c.memberCount ?? 0} members · needs review`}
                      href={`/crm/campaigns/${encodeURIComponent(c.id)}`}
                    />
                  ))}
                </>
              ) : null}
              {!loading && activeCampaignRows.length > 0 ? (
                <>
                  <div style={{ fontSize: "0.65rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-dim)", letterSpacing: "0.04em" }}>Active</div>
                  {activeCampaignRows.map((c) => (
                    <MiniListRow
                      key={c.id}
                      title={c.name}
                      meta={`${c.memberCount ?? 0} members`}
                      href={`/crm/campaigns/${encodeURIComponent(c.id)}`}
                    />
                  ))}
                </>
              ) : null}
              {!loading && activeCampaignRows.length === 0 && activeCampaignsCount === 0 ? (
                <SoftPanel style={{ padding: "0.9rem 1rem" }}>
                  <div style={{ display: "flex", gap: "0.6rem" }}>
                    <Sparkles size={18} style={{ color: "var(--accent)", flexShrink: 0 }} />
                    <div>
                      <div style={{ fontWeight: 700, fontSize: "0.875rem" }}>Start with one active campaign</div>
                      <p style={{ margin: "0.3rem 0 0.65rem", fontSize: "0.8125rem", color: "var(--text-dim)", lineHeight: 1.45 }}>
                        Import a list or enroll contacts, then move status to ACTIVE so queue and reporting light up.
                      </p>
                      <Link href="/crm/campaigns" style={{ fontSize: "0.8125rem", fontWeight: 700, color: "var(--accent)", textDecoration: "none" }}>
                        Open campaigns →
                      </Link>
                    </div>
                  </div>
                </SoftPanel>
              ) : null}
            </div>
          </div>
        ) : null}

        {can("can_view_crm_import") ? (
          <div>
            <SectionTitle title="Recent imports" hint="Latest CSV batches—open Import for full history." action={{ label: "Import leads", href: "/crm/import" }} />
            <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
              {loading ? <LoadingSkeleton rows={2} /> : null}
              {!loading && recentImports.length === 0 ? (
                <SoftPanel style={{ padding: "0.9rem 1rem", fontSize: "0.8125rem", color: "var(--text-dim)", lineHeight: 1.45 }}>
                  No batches yet. Upload a CSV to seed your pipeline; you can tie uploads to a campaign from the campaign screen.
                </SoftPanel>
              ) : null}
              {recentImports.map((b) => (
                <MiniListRow
                  key={b.id}
                  title={b.fileName}
                  meta={`${formatShortDate(b.createdAt)} · ${b.status.toLowerCase()} · ${b.processedRows}/${b.totalRows} rows`}
                  href={`/crm/import?batch=${encodeURIComponent(b.id)}`}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* Tasks strip */}
      <section>
        <SectionTitle title="Tasks" hint="Stay ahead of due dates." action={{ label: "View tasks", href: "/crm/tasks" }} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "0.85rem" }}>
          <KpiTile
            label="Open (mine)"
            value={taskStats?.myOpen ?? 0}
            sub="Assigned to you"
            href="/crm/tasks?assignedTo=me"
            icon={<CheckSquare size={17} />}
            loading={loading}
            emphasize="neutral"
          />
          <KpiTile
            label="Due today"
            value={taskDueCount}
            sub={isPlatformAdmin ? "Tenant open tasks" : "Your open tasks"}
            href="/crm/tasks?due=today"
            icon={<Clock size={17} />}
            loading={loading}
            emphasize="neutral"
          />
          <KpiTile
            label="Overdue"
            value={taskOverdueCount}
            sub="Still open"
            href="/crm/tasks?due=overdue"
            icon={<AlertCircle size={17} />}
            loading={loading}
            emphasize={taskOverdueCount > 0 ? "attention" : "neutral"}
          />
        </div>
      </section>

      {/* D — Shortcuts */}
      {(adminActions.length > 0 || agentActions.length > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: "1rem" }}>
          {adminActions.length > 0 ? (
            <SoftPanel style={{ padding: "1.1rem 1.15rem" }}>
              <h3 style={{ margin: "0 0 0.65rem", fontSize: "0.9375rem", fontWeight: 700 }}>Admin shortcuts</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
                {adminActions.map((a) => (
                  <ActionLinkRow key={a.key} href={a.href} icon={a.icon} label={a.label} hint={a.hint} />
                ))}
              </div>
            </SoftPanel>
          ) : null}
          {agentActions.length > 0 ? (
            <SoftPanel style={{ padding: "1.1rem 1.15rem" }}>
              <h3 style={{ margin: "0 0 0.65rem", fontSize: "0.9375rem", fontWeight: 700 }}>Agent shortcuts</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
                {agentActions.map((a) => (
                  <ActionLinkRow key={a.key} href={a.href} icon={a.icon} label={a.label} hint={a.hint} />
                ))}
              </div>
            </SoftPanel>
          ) : null}
        </div>
      )}

      {/* Contact pipeline (compact) */}
      <section>
        <SectionTitle title="Contact pipeline" hint="Quick census from CRM contacts." action={{ label: "Browse contacts", href: "/crm/contacts" }} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "0.85rem" }}>
          <KpiTile label="Total" value={stats?.total ?? 0} sub="All contacts" href="/crm/contacts" icon={<Users size={17} />} loading={loading} emphasize="neutral" />
          <KpiTile
            label="Assigned to me"
            value={stats?.mine ?? 0}
            sub="Owned in CRM"
            href="/crm/contacts?assignedToMe=true"
            icon={<UserCheck size={17} />}
            loading={loading}
            emphasize="neutral"
          />
          <KpiTile
            label="New this week"
            value={stats?.recentlyAdded ?? 0}
            sub="Last 7 days"
            icon={<UserPlus size={17} />}
            loading={loading}
            emphasize="neutral"
          />
        </div>
      </section>
    </div>
  );
}
