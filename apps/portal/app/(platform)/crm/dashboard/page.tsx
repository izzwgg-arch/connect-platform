"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Users, UserCheck, UserPlus, TrendingUp, CheckSquare, AlertCircle, Clock, PhoneCall, CheckCheck, Megaphone, ListOrdered } from "lucide-react";
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      apiGet<CrmStats>("/crm/contacts/stats"),
      apiGet<TaskStats>("/crm/tasks/stats"),
    ]).then(([contactResult, taskResult]) => {
      if (!active) return;
      setStats(contactResult.status === "fulfilled" ? contactResult.value : { total: 0, leads: 0, mine: 0, recentlyAdded: 0 });
      setTaskStats(taskResult.status === "fulfilled" ? taskResult.value : { myOpen: 0, dueToday: 0, overdue: 0 });
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
