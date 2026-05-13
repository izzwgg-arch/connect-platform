"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Users, UserCheck, UserPlus, TrendingUp, CheckSquare, AlertCircle, Clock, PhoneCall, CheckCheck, Megaphone, ListOrdered, Bell } from "lucide-react";
import { PageHeader } from "../../../../components/PageHeader";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { apiGet } from "../../../../services/apiClient";

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
    notifPermission === "default" &&
    typeof window !== "undefined" &&
    "Notification" in window;

  if (!hasAny) {
    return (
      <div style={{
        padding: "0.75rem 1rem", borderRadius: "0.625rem",
        background: "#f0fdf4", border: "1px solid #86efac",
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap",
      }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem", fontWeight: 600, color: "#15803d" }}>
          <CheckCheck size={16} />
          All caught up — no overdue callbacks or tasks.
        </span>
        {showNotifButton && (
          <button
            onClick={handleEnableNotifications}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.75rem", padding: "0.25rem 0.625rem", borderRadius: 6, border: "1px solid #86efac", background: "#dcfce7", cursor: "pointer", color: "#15803d" }}
          >
            <Bell size={12} /> Enable reminders
          </button>
        )}
        {notifPermission === "granted" && (
          <span style={{ fontSize: "0.75rem", color: "#15803d", display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
            <Bell size={12} /> Reminders on
          </span>
        )}
      </div>
    );
  }

  return (
    <div style={{
      padding: "0.875rem 1rem", borderRadius: "0.625rem",
      background: hasUrgent ? "#fef2f2" : "#fffbeb",
      border: `1px solid ${hasUrgent ? "#fca5a5" : "#fcd34d"}`,
      display: "flex", alignItems: "center", gap: "0.625rem", flexWrap: "wrap",
    }}>
      <AlertCircle size={15} style={{ color: hasUrgent ? "#dc2626" : "#d97706", flexShrink: 0 }} />

      {cbOverdue > 0 && (
        <Link href="/crm/queue?filter=overdue" style={{ fontSize: "0.8125rem", fontWeight: 700, color: "#dc2626", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "0.2rem" }}>
          {cbOverdue} overdue callback{cbOverdue !== 1 ? "s" : ""}
        </Link>
      )}
      {cbDueToday > 0 && (
        <Link href="/crm/queue?filter=due" style={{ fontSize: "0.8125rem", fontWeight: 600, color: "#b45309", textDecoration: "none" }}>
          {cbDueToday} callback{cbDueToday !== 1 ? "s" : ""} due today
        </Link>
      )}
      {taskOverdue > 0 && (
        <Link href="/crm/tasks?due=overdue" style={{ fontSize: "0.8125rem", fontWeight: 700, color: "#dc2626", textDecoration: "none" }}>
          {taskOverdue} overdue task{taskOverdue !== 1 ? "s" : ""}
        </Link>
      )}
      {taskDueToday > 0 && (
        <Link href="/crm/tasks?due=today" style={{ fontSize: "0.8125rem", fontWeight: 600, color: "#b45309", textDecoration: "none" }}>
          {taskDueToday} task{taskDueToday !== 1 ? "s" : ""} due today
        </Link>
      )}

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.5rem", flexShrink: 0 }}>
        <Link href="/crm/reports" style={{ fontSize: "0.75rem", color: "var(--text-dim)", textDecoration: "underline" }}>
          View reports
        </Link>
        {showNotifButton && (
          <button
            onClick={handleEnableNotifications}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", fontSize: "0.75rem", padding: "0.25rem 0.625rem", borderRadius: 6, border: `1px solid ${hasUrgent ? "#fca5a5" : "#fcd34d"}`, background: hasUrgent ? "#fee2e2" : "#fef9c3", cursor: "pointer", color: hasUrgent ? "#991b1b" : "#92400e" }}
          >
            <Bell size={11} /> Enable reminders
          </button>
        )}
        {notifPermission === "granted" && (
          <span style={{ fontSize: "0.75rem", color: "#15803d", display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
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
        <span style={{ fontSize: "0.75rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)" }}>
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
    return <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>{inner}</Link>;
  }
  return inner;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CrmDashboardPage() {
  const [stats, setStats] = useState<CrmStats | null>(null);
  const [taskStats, setTaskStats] = useState<TaskStats | null>(null);
  const [followUps, setFollowUps] = useState<FollowUpSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      apiGet<CrmStats>("/crm/contacts/stats"),
      apiGet<TaskStats>("/crm/tasks/stats"),
      apiGet<FollowUpSummary>("/crm/reports/follow-ups"),
    ]).then(([contactResult, taskResult, followUpResult]) => {
      if (!active) return;
      setStats(contactResult.status === "fulfilled" ? contactResult.value : { total: 0, leads: 0, mine: 0, recentlyAdded: 0 });
      setTaskStats(taskResult.status === "fulfilled" ? taskResult.value : { myOpen: 0, dueToday: 0, overdue: 0 });
      setFollowUps(followUpResult.status === "fulfilled" ? followUpResult.value : null);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  return (
    <div className="stack compact-stack">
      <PageHeader
        title="CRM Dashboard"
        subtitle="Your communications CRM — contacts, leads, campaigns, and live call workflows."
      />

      {/* Alert strip — overdue/due callbacks + tasks */}
      <CrmAlertStrip data={followUps} loading={loading} />

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

      {/* Task stat cards */}
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
          value={taskStats?.dueToday ?? 0}
          note="Open tasks due today"
          icon={<Clock size={18} />}
          loading={loading}
          href="/crm/tasks?due=today"
        />
        <StatCard
          label="Overdue"
          value={taskStats?.overdue ?? 0}
          note="Past due, still open"
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
          value={taskStats?.activeCampaigns ?? 0}
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

      {/* Getting started panel */}
      <div className="panel" style={{ padding: "1.5rem" }}>
        <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.9375rem", fontWeight: 600 }}>Quick Actions</h3>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <Link
            href="/crm/contacts"
            style={{
              padding: "0.4375rem 1rem",
              borderRadius: "0.5rem",
              background: "var(--accent)",
              color: "#fff",
              fontSize: "0.875rem",
              fontWeight: 600,
              textDecoration: "none",
              display: "inline-block",
            }}
          >
            View All Contacts
          </Link>
          <Link
            href="/crm/reports"
            style={{
              padding: "0.4375rem 1rem",
              borderRadius: "0.5rem",
              background: "var(--surface-hover)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              fontSize: "0.875rem",
              fontWeight: 600,
              textDecoration: "none",
              display: "inline-block",
            }}
          >
            View Reports
          </Link>
          <Link
            href="/crm/settings"
            style={{
              padding: "0.4375rem 1rem",
              borderRadius: "0.5rem",
              background: "var(--surface-hover)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              fontSize: "0.875rem",
              fontWeight: 600,
              textDecoration: "none",
              display: "inline-block",
            }}
          >
            CRM Settings
          </Link>
        </div>
      </div>

      {/* Phase roadmap */}
      <div className="panel" style={{ padding: "1.5rem" }}>
        <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.9375rem", fontWeight: 600 }}>Coming Next</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {[
            { phase: "Phase 2", items: "Campaigns, call queue, call workspace, CDR linkage" },
            { phase: "Phase 3", items: "Import pipeline, scripts, checklists, dispositions" },
            { phase: "Phase 4", items: "Transcription, AI summaries, workflow automation" },
            { phase: "Phase 5", items: "Local presence, power dialer, live call workspace" },
          ].map(({ phase, items }) => (
            <div key={phase} style={{ display: "flex", gap: "0.75rem", fontSize: "0.875rem" }}>
              <span style={{ fontWeight: 700, color: "var(--accent)", minWidth: 70 }}>{phase}</span>
              <span style={{ color: "var(--text-dim)" }}>{items}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
