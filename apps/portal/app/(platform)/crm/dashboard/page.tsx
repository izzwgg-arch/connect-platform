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
  callbacks: {
    overdue: { count: number };
    dueToday: { count: number };
  };
  tasks: {
    overdue: { count: number };
    dueToday: { count: number };
  };
};

type CrmSettingsShape = {
  enabled: boolean;
};

type DailyReport = {
  activeCampaigns: number;
  queueRemaining: number;
  overdueCallbacks: number;
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

// ── Alert strip ────────────────────────────────────────────────────────────────

function CrmAlertStrip({ data, loading }: { data: FollowUpSummary | null; loading: boolean }) {
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setNotifPermission(Notification.permission);
    }
  }, []);

  function handleEnableNotifications() {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    void Notification.requestPermission().then((result) => {
      setNotifPermission(result);
      if (result === "granted" && data) {
        const overdueTotal =
          (data.callbacks?.overdue?.count ?? 0) + (data.tasks?.overdue?.count ?? 0);
        const body =
          overdueTotal > 0
            ? `${overdueTotal} overdue item${overdueTotal !== 1 ? "s" : ""} need your attention`
            : "You're all caught up — no overdue items right now.";
        new Notification("CRM Reminders enabled", { body, icon: "/favicon.ico" });
      }
    });
  }

  if (loading) return null;

  const cbOverdue = data?.callbacks?.overdue?.count ?? 0;
  const cbDueToday = data?.callbacks?.dueToday?.count ?? 0;
  const taskOverdue = data?.tasks?.overdue?.count ?? 0;
  const taskDueToday = data?.tasks?.dueToday?.count ?? 0;
  const hasUrgent = cbOverdue > 0 || taskOverdue > 0;
  const hasAny = hasUrgent || cbDueToday > 0 || taskDueToday > 0;

  const showNotifButton =
    notifPermission === "default" && typeof window !== "undefined" && "Notification" in window;

  if (!hasAny) {
    return (
      <div
        style={{
          padding: "0.75rem 1rem",
          borderRadius: "0.625rem",
          background: "#f0fdf4",
          border: "1px solid #86efac",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
            fontSize: "0.875rem",
            fontWeight: 600,
            color: "#15803d",
          }}
        >
          <CheckCheck size={16} />
          All caught up — no overdue callbacks or tasks in your scope.
        </span>
        {showNotifButton && (
          <button
            type="button"
            onClick={handleEnableNotifications}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              fontSize: "0.75rem",
              padding: "0.25rem 0.625rem",
              borderRadius: 6,
              border: "1px solid #86efac",
              background: "#dcfce7",
              cursor: "pointer",
              color: "#15803d",
            }}
          >
            <Bell size={12} /> Enable reminders
          </button>
        )}
        {notifPermission === "granted" && (
          <span
            style={{
              fontSize: "0.75rem",
              color: "#15803d",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.25rem",
            }}
          >
            <Bell size={12} /> Reminders on
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        padding: "0.875rem 1rem",
        borderRadius: "0.625rem",
        background: hasUrgent ? "#fef2f2" : "#fffbeb",
        border: `1px solid ${hasUrgent ? "#fca5a5" : "#fcd34d"}`,
        display: "flex",
        alignItems: "center",
        gap: "0.625rem",
        flexWrap: "wrap",
      }}
    >
      <AlertCircle size={15} style={{ color: hasUrgent ? "#dc2626" : "#d97706", flexShrink: 0 }} />

      {cbOverdue > 0 && (
        <Link
          href="/crm/queue?filter=overdue"
          style={{
            fontSize: "0.8125rem",
            fontWeight: 700,
            color: "#dc2626",
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.2rem",
          }}
        >
          {cbOverdue} overdue callback{cbOverdue !== 1 ? "s" : ""}
        </Link>
      )}
      {cbDueToday > 0 && (
        <Link
          href="/crm/queue?filter=due"
          style={{
            fontSize: "0.8125rem",
            fontWeight: 600,
            color: "#b45309",
            textDecoration: "none",
          }}
        >
          {cbDueToday} callback{cbDueToday !== 1 ? "s" : ""} due today
        </Link>
      )}
      {taskOverdue > 0 && (
        <Link
          href="/crm/tasks?due=overdue"
          style={{
            fontSize: "0.8125rem",
            fontWeight: 700,
            color: "#dc2626",
            textDecoration: "none",
          }}
        >
          {taskOverdue} overdue task{taskOverdue !== 1 ? "s" : ""}
        </Link>
      )}
      {taskDueToday > 0 && (
        <Link
          href="/crm/tasks?due=today"
          style={{
            fontSize: "0.8125rem",
            fontWeight: 600,
            color: "#b45309",
            textDecoration: "none",
          }}
        >
          {taskDueToday} task{taskDueToday !== 1 ? "s" : ""} due today
        </Link>
      )}

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.5rem", flexShrink: 0 }}>
        <Link href="/crm/reports" style={{ fontSize: "0.75rem", color: "var(--text-dim)", textDecoration: "underline" }}>
          View reports
        </Link>
        {showNotifButton && (
          <button
            type="button"
            onClick={handleEnableNotifications}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.3rem",
              fontSize: "0.75rem",
              padding: "0.25rem 0.625rem",
              borderRadius: 6,
              border: `1px solid ${hasUrgent ? "#fca5a5" : "#fcd34d"}`,
              background: hasUrgent ? "#fee2e2" : "#fef9c3",
              cursor: "pointer",
              color: hasUrgent ? "#991b1b" : "#92400e",
            }}
          >
            <Bell size={11} /> Enable reminders
          </button>
        )}
        {notifPermission === "granted" && (
          <span
            style={{
              fontSize: "0.75rem",
              color: "#15803d",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.25rem",
            }}
          >
            <Bell size={11} /> Reminders on
          </span>
        )}
      </div>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  note,
  icon,
  loading,
  href,
}: {
  label: string;
  value: number | string;
  note: string;
  icon: React.ReactNode;
  loading: boolean;
  href?: string;
}) {
  const inner = (
    <div
      className="panel"
      style={{
        padding: "1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        transition: "background 0.12s",
        cursor: href ? "pointer" : "default",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span
          style={{
            fontSize: "0.75rem",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--text-dim)",
          }}
        >
          {label}
        </span>
        <span style={{ color: "var(--accent)", opacity: 0.8 }}>{icon}</span>
      </div>
      {loading ? (
        <div style={{ height: "2rem" }}>
          <LoadingSkeleton rows={1} />
        </div>
      ) : (
        <span style={{ fontSize: "2rem", fontWeight: 700, lineHeight: 1 }}>{value}</span>
      )}
      <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{note}</span>
    </div>
  );

  if (href) {
    return (
      <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>
        {inner}
      </Link>
    );
  }
  return inner;
}

type ReadinessTone = "ok" | "warn" | "bad";

function ReadinessCard({
  title,
  value,
  detail,
  tone,
  loading,
}: {
  title: string;
  value: string;
  detail: string;
  tone: ReadinessTone;
  loading: boolean;
}) {
  const border =
    tone === "ok" ? "1px solid #86efac" : tone === "warn" ? "1px solid #fcd34d" : "1px solid #fca5a5";
  const bg =
    tone === "ok" ? "#f0fdf4" : tone === "warn" ? "#fffbeb" : "#fef2f2";
  const valueColor = tone === "ok" ? "#15803d" : tone === "warn" ? "#b45309" : "#dc2626";

  return (
    <div className="panel" style={{ padding: "1rem 1.125rem", border, background: bg }}>
      <div style={{ fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-dim)", letterSpacing: "0.04em" }}>
        {title}
      </div>
      {loading ? (
        <div style={{ marginTop: "0.5rem" }}>
          <LoadingSkeleton rows={1} />
        </div>
      ) : (
        <div style={{ marginTop: "0.35rem", fontSize: "1.35rem", fontWeight: 800, color: valueColor }}>{value}</div>
      )}
      <p style={{ margin: "0.35rem 0 0", fontSize: "0.78rem", color: "var(--text-dim)", lineHeight: 1.45 }}>{detail}</p>
    </div>
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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CrmDashboardPage() {
  const { can, backendJwtRole } = useAppContext();

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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    const baseLoads = [
      apiGet<CrmSettingsShape>("/crm/settings"),
      apiGet<CrmStats>("/crm/contacts/stats"),
      apiGet<TaskStats>("/crm/tasks/stats"),
    ] as const;

    const basePromise = Promise.allSettled(baseLoads);

    if (isPlatformAdmin) {
      void Promise.allSettled([
        basePromise,
        apiGet<FollowUpSummary>("/crm/reports/follow-ups"),
        apiGet<PilotReadiness>("/crm/admin/pilot-readiness"),
      ]).then(([baseR, followR, pilotR]) => {
        if (!active) return;
        if (baseR.status !== "fulfilled") {
          setLoading(false);
          return;
        }
        const [settingsR, contactR, taskR] = baseR.value;
        setCrmSettings(settingsR.status === "fulfilled" ? settingsR.value : { enabled: false });
        setStats(contactR.status === "fulfilled" ? contactR.value : { total: 0, leads: 0, mine: 0, recentlyAdded: 0 });
        setTaskStats(
          taskR.status === "fulfilled" ? taskR.value : { myOpen: 0, dueToday: 0, overdue: 0 },
        );
        setFollowUps(followR.status === "fulfilled" ? followR.value : null);
        if (pilotR.status === "fulfilled") {
          setPilotReadiness(pilotR.value);
          setPilotLoadFailed(false);
        } else {
          setPilotReadiness(null);
          setPilotLoadFailed(true);
        }
        setDaily(null);
        setLoading(false);
      });
    } else {
      void Promise.allSettled([basePromise, apiGet<DailyReport>("/crm/reports/daily")]).then(([baseR, dailyR]) => {
        if (!active) return;
        if (baseR.status !== "fulfilled") {
          setLoading(false);
          return;
        }
        const [settingsR, contactR, taskR] = baseR.value;
        setCrmSettings(settingsR.status === "fulfilled" ? settingsR.value : { enabled: false });
        setStats(contactR.status === "fulfilled" ? contactR.value : { total: 0, leads: 0, mine: 0, recentlyAdded: 0 });
        setTaskStats(
          taskR.status === "fulfilled" ? taskR.value : { myOpen: 0, dueToday: 0, overdue: 0 },
        );
        setFollowUps(null);
        setPilotReadiness(null);
        setPilotLoadFailed(false);
        setDaily(dailyR.status === "fulfilled" ? dailyR.value : null);
        setLoading(false);
      });
    }

    return () => {
      active = false;
    };
  }, [isPlatformAdmin]);

  const alertData: FollowUpSummary | null = isPlatformAdmin
    ? followUps
    : buildPersonalFollowUpSummary(taskStats);

  const activeCampaignsCount = isPlatformAdmin
    ? (pilotReadiness?.activeCampaigns ?? taskStats?.activeCampaigns ?? 0)
    : (daily?.activeCampaigns ?? taskStats?.activeCampaigns ?? 0);

  const adminActions = [
    can("can_view_crm_settings")
      ? {
          key: "settings",
          href: "/crm/settings",
          icon: <Settings size={18} />,
          label: "Enable & confirm CRM settings",
          hint: "Tenant toggle, queue defaults, and user access",
        }
      : null,
    can("can_view_crm_import")
      ? {
          key: "import",
          href: "/crm/import",
          icon: <Upload size={18} />,
          label: "Import leads",
          hint: "CSV upload and batch history",
        }
      : null,
    can("can_view_crm_campaigns")
      ? {
          key: "campaign",
          href: "/crm/campaigns",
          icon: <Megaphone size={18} />,
          label: "Create or open a campaign",
          hint: "Start ACTIVE work and add contacts",
        }
      : null,
    can("can_view_crm_campaigns")
      ? {
          key: "assign",
          href: "/crm/campaigns",
          icon: <UserCheck size={18} />,
          label: "Assign leads to agents",
          hint: "Open a campaign → members → bulk assign",
        }
      : null,
    can("can_view_crm_reports")
      ? {
          key: "wallboard",
          href: "/crm/wallboard",
          icon: <BarChart3 size={18} />,
          label: "Open live wallboard",
          hint: "Team queue snapshot",
        }
      : null,
    isPlatformAdmin
      ? {
          key: "diagnostics",
          href: "/crm/admin/diagnostics",
          icon: <Stethoscope size={18} />,
          label: "Open CRM diagnostics",
          hint: "Readiness checks for admins",
        }
      : null,
  ].filter(Boolean) as { key: string; href: string; icon: React.ReactNode; label: string; hint: string }[];

  const agentActions = [
    can("can_view_crm_queue")
      ? {
          key: "queue",
          href: "/crm/queue",
          icon: <ListOrdered size={18} />,
          label: "Open My Queue",
          hint: "Pending, due, and overdue callbacks",
        }
      : null,
    can("can_view_crm_queue")
      ? {
          key: "callbacks",
          href: "/crm/queue?filter=due",
          icon: <Clock size={18} />,
          label: "Check due callbacks",
          hint: "Jumps to Due Today on the queue",
        }
      : null,
    can("can_view_crm_contacts")
      ? {
          key: "contacts",
          href: "/crm/contacts",
          icon: <BookUser size={18} />,
          label: "Open contacts",
          hint: "Search and manage CRM contacts",
        }
      : null,
    can("can_view_crm_live_call")
      ? {
          key: "power",
          href: "/crm/live-call",
          icon: <Headset size={18} />,
          label: "Start live call workspace",
          hint: "Power-dial / live workflow entry point",
        }
      : null,
  ].filter(Boolean) as { key: string; href: string; icon: React.ReactNode; label: string; hint: string }[];

  const taskDueCount = isPlatformAdmin ? (taskStats?.dueToday ?? 0) : (taskStats?.myTasksDueToday ?? 0);
  const taskOverdueCount = isPlatformAdmin ? (taskStats?.overdue ?? 0) : (taskStats?.myTasksOverdue ?? 0);

  return (
    <div className="stack compact-stack">
      <PageHeader
        title="CRM Dashboard"
        subtitle="First-day pilot view — readiness, quick actions, and where today’s work lives."
      />

      <CrmAlertStrip data={alertData} loading={loading} />

      {/* Pilot readiness */}
      <div className="panel" style={{ padding: "1.25rem" }}>
        <h3 style={{ margin: 0, fontSize: "0.9375rem", fontWeight: 600 }}>Pilot readiness</h3>
        <p style={{ margin: "0.35rem 0 1rem", fontSize: "0.8125rem", color: "var(--text-dim)", lineHeight: 1.45 }}>
          Live counts from CRM (no polling). Fix warnings in the linked pages.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: "0.75rem",
          }}
        >
          <ReadinessCard
            title="CRM enabled"
            value={crmSettings?.enabled ? "Yes" : "No"}
            detail={crmSettings?.enabled ? "Tenant CRM flag is on." : "Enable CRM under Settings."}
            tone={crmSettings?.enabled ? "ok" : "bad"}
            loading={loading}
          />

          {isPlatformAdmin ? (
            <>
              <ReadinessCard
                title="Users with CRM access"
                value={pilotLoadFailed ? "—" : String(pilotReadiness?.usersWithCrmAccess ?? 0)}
                detail={
                  pilotLoadFailed
                    ? "Could not load admin snapshot."
                    : (pilotReadiness?.usersWithCrmAccess ?? 0) > 0
                      ? "Enabled rows in CRM user access."
                      : "Grant at least one agent under CRM Settings."
                }
                tone={
                  pilotLoadFailed ? "warn" : (pilotReadiness?.usersWithCrmAccess ?? 0) > 0 ? "ok" : "warn"
                }
                loading={loading}
              />
              <ReadinessCard
                title="Active campaigns"
                value={pilotLoadFailed ? "—" : String(pilotReadiness?.activeCampaigns ?? 0)}
                detail="Running campaigns (status ACTIVE)."
                tone={
                  pilotLoadFailed ? "warn" : (pilotReadiness?.activeCampaigns ?? 0) > 0 ? "ok" : "warn"
                }
                loading={loading}
              />
              <ReadinessCard
                title="Queue pending / in progress"
                value={pilotLoadFailed ? "—" : String(pilotReadiness?.queuePendingOrInProgress ?? 0)}
                detail="Tenant-wide PENDING + IN_PROGRESS on ACTIVE campaigns."
                tone="ok"
                loading={loading}
              />
              <ReadinessCard
                title="Overdue callbacks (tenant)"
                value={pilotLoadFailed ? "—" : String(pilotReadiness?.overdueCallbacks ?? 0)}
                detail="Callback status before today on ACTIVE campaigns."
                tone={
                  pilotLoadFailed ? "warn" : (pilotReadiness?.overdueCallbacks ?? 0) > 0 ? "bad" : "ok"
                }
                loading={loading}
              />
              {pilotLoadFailed ? null : pilotReadiness?.smsReadinessApplicable ? (
                <ReadinessCard
                  title="Outbound SMS (CRM)"
                  value={pilotReadiness?.smsProviderConfigured ? "Configured" : "Not configured"}
                  detail={
                    pilotReadiness?.smsProviderConfigured
                      ? "Provider credentials and from-number resolve."
                      : "Set tenant SMS provider before sending from contact pages."
                  }
                  tone={pilotReadiness?.smsProviderConfigured ? "ok" : "warn"}
                  loading={loading}
                />
              ) : null}
            </>
          ) : (
            <>
              <ReadinessCard
                title="Active campaigns"
                value={String(daily?.activeCampaigns ?? taskStats?.activeCampaigns ?? 0)}
                detail="Running campaigns for your tenant."
                tone={(daily?.activeCampaigns ?? taskStats?.activeCampaigns ?? 0) > 0 ? "ok" : "warn"}
                loading={loading}
              />
              <ReadinessCard
                title="My queue depth"
                value={String(taskStats?.queueRemaining ?? 0)}
                detail="Assigned non-terminal members on ACTIVE campaigns."
                tone="ok"
                loading={loading}
              />
              <ReadinessCard
                title="Team queue (pending / in progress)"
                value={daily?.queueRemaining != null ? String(daily.queueRemaining) : "—"}
                detail="Same definition as reports / wallboard totals."
                tone="ok"
                loading={loading}
              />
              <ReadinessCard
                title="My overdue callbacks"
                value={String(taskStats?.myOverdueCallbacks ?? 0)}
                detail="CALLBACK before today, assigned to you."
                tone={(taskStats?.myOverdueCallbacks ?? 0) > 0 ? "bad" : "ok"}
                loading={loading}
              />
            </>
          )}
        </div>
      </div>

      {/* First-day actions */}
      {(adminActions.length > 0 || agentActions.length > 0) && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "1rem",
          }}
        >
          {adminActions.length > 0 ? (
            <div className="panel" style={{ padding: "1.25rem" }}>
              <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.9375rem", fontWeight: 600 }}>Admin — start here</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {adminActions.map((a) => (
                  <ActionLinkRow key={a.key} href={a.href} icon={a.icon} label={a.label} hint={a.hint} />
                ))}
              </div>
            </div>
          ) : null}

          {agentActions.length > 0 ? (
            <div className="panel" style={{ padding: "1.25rem" }}>
              <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.9375rem", fontWeight: 600 }}>Agent — start here</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {agentActions.map((a) => (
                  <ActionLinkRow key={a.key} href={a.href} icon={a.icon} label={a.label} hint={a.hint} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* Empty states */}
      {can("can_view_crm_campaigns") && !loading && activeCampaignsCount === 0 ? (
        <div
          className="panel"
          style={{
            padding: "1rem 1.25rem",
            border: "1px dashed var(--border)",
            background: "var(--surface-hover)",
          }}
        >
          <strong style={{ fontSize: "0.875rem" }}>No active campaigns yet</strong>
          <p style={{ margin: "0.35rem 0 0.75rem", fontSize: "0.8125rem", color: "var(--text-dim)", lineHeight: 1.45 }}>
            Create a campaign or import leads into a draft, then set status to ACTIVE.
          </p>
          <Link
            href="/crm/campaigns"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              fontSize: "0.8125rem",
              fontWeight: 700,
              color: "var(--accent)",
              textDecoration: "none",
            }}
          >
            Create or import a campaign <ChevronRight size={14} />
          </Link>
        </div>
      ) : null}

      {!loading && (taskStats?.queueRemaining ?? 0) === 0 && can("can_view_crm_queue") ? (
        <div className="panel" style={{ padding: "1rem 1.25rem", background: "#fffbeb", border: "1px solid #fcd34d" }}>
          <strong style={{ fontSize: "0.875rem", color: "#92400e" }}>No assigned leads in your queue</strong>
          <p style={{ margin: "0.35rem 0 0", fontSize: "0.8125rem", color: "#92400e", lineHeight: 1.45 }}>
            Ask a manager to add you as a campaign member or bulk-assign leads to you.
          </p>
        </div>
      ) : null}

      {taskStats?.myOverdueCallbacks != null &&
      taskStats.myOverdueCallbacks > 0 &&
      can("can_view_crm_queue") ? (
        <div className="panel" style={{ padding: "1rem 1.25rem", background: "#fef2f2", border: "1px solid #fca5a5" }}>
          <Link
            href="/crm/queue?filter=overdue"
            style={{ fontSize: "0.875rem", fontWeight: 800, color: "#dc2626", textDecoration: "none" }}
          >
            You have {taskStats.myOverdueCallbacks} overdue callback{taskStats.myOverdueCallbacks !== 1 ? "s" : ""} — open queue →
          </Link>
        </div>
      ) : null}

      {/* Stat cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "1rem",
        }}
      >
        <StatCard
          label="Total Contacts"
          value={stats?.total ?? 0}
          note="All CRM contacts"
          icon={<Users size={18} />}
          loading={loading}
          href="/crm/contacts"
        />
        <StatCard
          label="Active Leads"
          value={stats?.leads ?? 0}
          note="Stage: Lead"
          icon={<TrendingUp size={18} />}
          loading={loading}
          href="/crm/contacts?stage=LEAD"
        />
        <StatCard
          label="Assigned to Me"
          value={stats?.mine ?? 0}
          note="My pipeline"
          icon={<UserCheck size={18} />}
          loading={loading}
          href="/crm/contacts?assignedToMe=true"
        />
        <StatCard
          label="Added This Week"
          value={stats?.recentlyAdded ?? 0}
          note="Last 7 days"
          icon={<UserPlus size={18} />}
          loading={loading}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "1rem" }}>
        <StatCard
          label="My Open Tasks"
          value={taskStats?.myOpen ?? 0}
          note="Assigned to me"
          icon={<CheckSquare size={18} />}
          loading={loading}
          href="/crm/tasks?assignedTo=me"
        />
        <StatCard
          label="Due Today"
          value={taskDueCount}
          note={isPlatformAdmin ? "Open tasks due today (tenant)" : "Open tasks due today (mine)"}
          icon={<Clock size={18} />}
          loading={loading}
          href="/crm/tasks?due=today"
        />
        <StatCard
          label="Overdue"
          value={taskOverdueCount}
          note={isPlatformAdmin ? "Past due, still open (tenant)" : "Past due, still open (mine)"}
          icon={<AlertCircle size={18} />}
          loading={loading}
          href="/crm/tasks?due=overdue"
        />
        <StatCard
          label="Calls Today"
          value={taskStats?.callsLinkedToday ?? 0}
          note="CRM calls linked today"
          icon={<PhoneCall size={18} />}
          loading={loading}
          href="/crm/contacts"
        />
        <StatCard
          label="Dispositions Today"
          value={taskStats?.dispositionsToday ?? 0}
          note="Outcomes saved today"
          icon={<CheckCheck size={18} />}
          loading={loading}
          href="/crm/reports?tab=agents"
        />
        <StatCard
          label="Active Campaigns"
          value={activeCampaignsCount}
          note="Running campaigns"
          icon={<Megaphone size={18} />}
          loading={loading}
          href="/crm/campaigns?status=ACTIVE"
        />
        <StatCard
          label="My Queue"
          value={taskStats?.queueRemaining ?? 0}
          note="Leads remaining"
          icon={<ListOrdered size={18} />}
          loading={loading}
          href="/crm/queue"
        />
      </div>
    </div>
  );
}
