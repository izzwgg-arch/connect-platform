"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  CheckCheck,
  CheckSquare,
  Clock,
  ExternalLink,
  ListOrdered,
  Megaphone,
  PhoneCall,
  Timer,
  TrendingUp,
  UserCheck,
  Users,
  Zap,
} from "lucide-react";
import { apiGet } from "../../../../services/apiClient";
import { crm } from "../../../../components/crm/crmClasses";
import { cn } from "../../../../components/crm/cn";
import { CRMCard } from "../../../../components/crm/CRMCard";
import { CRMHorizontalBars } from "../../../../components/crm/charts/CRMHorizontalBars";
import { CRMRingMetric } from "../../../../components/crm/charts/CRMRingMetric";
import { CRM_CHART_COLORS } from "../../../../components/crm/charts/chartColors";
import { ReportsCommandHeader } from "../../../../components/crm/reports/ReportsCommandHeader";
import { ReportsHeroCard } from "../../../../components/crm/reports/ReportsHeroCard";
import { ReportsInsightFeed } from "../../../../components/crm/reports/ReportsInsightFeed";
import {
  ReportsOperationalTable,
  RtTd,
  RtTh,
} from "../../../../components/crm/reports/ReportsOperationalTable";
import type {
  AgentRow,
  CampaignRow,
  DailyReport,
  FollowUpMember,
  FollowUpTask,
  FollowUpsReport,
  HeroTone,
  ReportTab,
} from "../../../../components/crm/reports/reportsTypes";

// ── CSV export helper ─────────────────────────────────────────────────────────

function downloadCsv(filename: string, rows: string[][]): void {
  const content = rows
    .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Dark campaign status chip ─────────────────────────────────────────────────

function CampaignChip({ status }: { status: string }) {
  const cls: Record<string, string> = {
    ACTIVE: "border-crm-success/35 bg-crm-success/10 text-crm-success",
    PAUSED: "border-crm-warning/35 bg-crm-warning/10 text-crm-warning",
    COMPLETED: "border-crm-accent/35 bg-crm-accent/10 text-crm-accent",
    DRAFT: "border-crm-border/70 bg-crm-surface-2/60 text-crm-muted",
    ARCHIVED: "border-crm-border/50 bg-crm-surface-2/40 text-crm-muted/60",
  };
  return (
    <span
      className={cn(
        "inline-flex rounded-crm border px-2 py-0.5 text-xs font-medium",
        cls[status] ?? "border-crm-border/70 bg-crm-surface-2/60 text-crm-muted",
      )}
    >
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

// ── Inline conversion progress bar ────────────────────────────────────────────

function ConversionBar({
  converted,
  total,
  rate,
}: {
  converted: number;
  total: number;
  rate: number;
}) {
  const pct = total > 0 ? Math.min(100, (converted / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2 min-w-[110px]">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-crm-surface-2">
        <div
          className="h-full rounded-full bg-crm-success transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums text-crm-text">
        {rate}%
      </span>
    </div>
  );
}

// ── Compact pending pressure bar ──────────────────────────────────────────────

function PendingBar({ pending, total }: { pending: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (pending / total) * 100) : 0;
  const tone =
    pct > 70
      ? "bg-crm-accent"
      : pct > 40
        ? "bg-crm-warning"
        : "bg-crm-success";
  return (
    <div className="flex items-center gap-2 min-w-[90px]">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-crm-surface-2">
        <div
          className={cn("h-full rounded-full transition-[width] duration-300", tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-crm-muted">
        {pending}
      </span>
    </div>
  );
}

// ── CRM role chip ─────────────────────────────────────────────────────────────

function RoleChip({ role }: { role: string }) {
  const cls: Record<string, string> = {
    ADMIN: "border-violet-500/30 bg-violet-500/10 text-violet-300",
    MANAGER: "border-crm-accent/30 bg-crm-accent/10 text-crm-accent",
    AGENT: "border-crm-border/70 bg-crm-surface-2/60 text-crm-muted",
  };
  return (
    <span
      className={cn(
        "inline-flex rounded-crm border px-2 py-0.5 text-xs font-medium",
        cls[role] ?? "border-crm-border/70 bg-crm-surface-2/60 text-crm-muted",
      )}
    >
      {role.charAt(0) + role.slice(1).toLowerCase()}
    </span>
  );
}

// ── Metric value with dash fallback ──────────────────────────────────────────

function MetricVal({
  v,
  tone,
  tabular = true,
}: {
  v: number;
  tone?: "success" | "warning" | "danger" | "accent" | "muted";
  tabular?: boolean;
}) {
  const colorMap = {
    success: "text-crm-success",
    warning: "text-crm-warning",
    danger: "text-crm-danger",
    accent: "text-crm-accent",
    muted: "text-crm-muted",
  };
  const color = v === 0 ? "text-crm-muted/50" : tone ? colorMap[tone] : "text-crm-text";
  return (
    <span className={cn("font-semibold", tabular && "tabular-nums", color)}>
      {v === 0 ? "—" : v.toLocaleString()}
    </span>
  );
}

// ── Operations tab ────────────────────────────────────────────────────────────

function OperationsTab({
  data,
  loading,
  campaigns,
  agents,
  followUps,
}: {
  data: DailyReport | null;
  loading: boolean;
  campaigns: CampaignRow[];
  agents: AgentRow[];
  followUps: FollowUpsReport | null;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <div className={crm.reportsHeroGrid}>
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-36 animate-pulse rounded-crm-lg border border-crm-border bg-crm-surface"
            />
          ))}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={cn(crm.emptyWrap, "py-16")}>
        <AlertCircle className="mx-auto mb-3 h-8 w-8 text-crm-danger/60" />
        <p className={crm.emptyTitle}>Failed to load operations data</p>
      </div>
    );
  }

  const totalOverdue = data.overdueTasks + data.overdueCallbacks;

  const queueTone: HeroTone =
    data.queueRemaining === 0 && data.activeCampaigns > 0
      ? "warn"
      : data.queueRemaining > 0
        ? "healthy"
        : "neutral";
  const queueStatus =
    data.queueRemaining === 0 && data.activeCampaigns > 0
      ? "Queue exhausted across all campaigns"
      : data.queueRemaining === 0
        ? "No active campaigns with queue work"
        : data.queueRemaining > 100
          ? "Strong queue volume — full work session available"
          : data.queueRemaining > 20
            ? "Moderate queue load remaining today"
            : "Light queue — may exhaust before day end";

  const cbTone: HeroTone =
    data.overdueCallbacks >= 5
      ? "danger"
      : data.overdueCallbacks > 0
        ? "warn"
        : "healthy";
  const cbStatus =
    data.overdueCallbacks === 0
      ? "No overdue callbacks — SLA healthy"
      : data.overdueCallbacks >= 5
        ? "Callback SLA risk — immediate action needed"
        : `${data.overdueCallbacks} overdue — review before new calls`;

  const activityTone: HeroTone =
    data.dispositionsToday >= 10
      ? "healthy"
      : data.dispositionsToday >= 3
        ? "neutral"
        : "warn";
  const activityStatus =
    data.dispositionsToday === 0
      ? "No dispositions recorded yet today"
      : data.dispositionsToday >= 10
        ? "Active session underway — strong output"
        : "Low activity — check agent status";

  const followupTone: HeroTone =
    totalOverdue >= 5 ? "danger" : totalOverdue > 0 ? "warn" : "healthy";
  const followupStatus =
    totalOverdue === 0
      ? "All follow-ups on schedule — no overdue items"
      : totalOverdue >= 5
        ? "Follow-up SLA risk — manager review needed"
        : `${totalOverdue} overdue item${totalOverdue !== 1 ? "s" : ""} need attention`;

  const activityBars = [
    { label: "Dispositions today", value: data.dispositionsToday, color: CRM_CHART_COLORS.accent },
    { label: "Calls linked", value: data.callsLinkedToday, color: CRM_CHART_COLORS.success },
    { label: "Contacts enrolled", value: data.contactsCreatedToday, color: CRM_CHART_COLORS.violet },
    { label: "Tasks due today", value: data.tasksDueToday, color: CRM_CHART_COLORS.warning },
    { label: "Callbacks due today", value: data.callbacksDueToday, color: CRM_CHART_COLORS.danger },
  ].filter((b) => b.value > 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Hero row */}
      <div className={crm.reportsHeroGrid}>
        <ReportsHeroCard
          label="Queue Pressure"
          value={data.queueRemaining.toLocaleString()}
          sublabel={`${data.activeCampaigns} active campaign${data.activeCampaigns !== 1 ? "s" : ""}`}
          tone={queueTone}
          trend={data.queueRemaining > 0 ? "up" : "flat"}
          icon={<ListOrdered className="h-4 w-4" />}
          statusMessage={queueStatus}
        />
        <ReportsHeroCard
          label="Callback Health"
          value={data.overdueCallbacks}
          sublabel={`${data.callbacksDueToday} total due today`}
          tone={cbTone}
          trend={data.overdueCallbacks > 0 ? "down" : "flat"}
          icon={<CalendarClock className="h-4 w-4" />}
          statusMessage={cbStatus}
        />
        <ReportsHeroCard
          label="Today's Activity"
          value={data.dispositionsToday}
          sublabel={`${data.callsLinkedToday} calls linked to contacts`}
          tone={activityTone}
          trend={data.dispositionsToday > 5 ? "up" : "flat"}
          icon={<CheckCheck className="h-4 w-4" />}
          statusMessage={activityStatus}
        />
        <ReportsHeroCard
          label="Follow-up Pressure"
          value={totalOverdue}
          sublabel={`${data.tasksDueToday} tasks due today`}
          tone={followupTone}
          trend={totalOverdue > 0 ? "down" : "flat"}
          icon={<Timer className="h-4 w-4" />}
          statusMessage={followupStatus}
        />
      </div>

      {/* Main + Sidebar */}
      <div className={crm.reportsGrid}>
        {/* Left main */}
        <div className={crm.reportsMainCol}>
          {/* Activity distribution */}
          <CRMCard>
            <p className={cn(crm.label, "mb-4")}>Today's Activity Distribution</p>
            {activityBars.length > 0 ? (
              <CRMHorizontalBars items={activityBars} />
            ) : (
              <p className={cn(crm.muted, "py-4 text-center italic")}>
                No activity recorded yet today
              </p>
            )}
          </CRMCard>

          {/* Queue ring + contacts overview */}
          <CRMCard>
            <p className={cn(crm.label, "mb-4")}>Work Queue Status</p>
            <div className="flex flex-wrap items-center gap-6">
              <CRMRingMetric
                value={data.queueRemaining}
                max={Math.max(data.queueRemaining + data.dispositionsToday, 1)}
                label="Pending"
                sublabel="in queue"
                color={
                  queueTone === "healthy"
                    ? CRM_CHART_COLORS.success
                    : queueTone === "warn"
                      ? CRM_CHART_COLORS.warning
                      : CRM_CHART_COLORS.muted
                }
                size={80}
              />
              <div className="grid flex-1 grid-cols-2 gap-3">
                {[
                  { label: "Contacts enrolled today", val: data.contactsCreatedToday, icon: <UserCheck className="h-3.5 w-3.5" /> },
                  { label: "Active campaigns", val: data.activeCampaigns, icon: <Megaphone className="h-3.5 w-3.5" /> },
                  { label: "Tasks due today", val: data.tasksDueToday, icon: <CheckSquare className="h-3.5 w-3.5" /> },
                  { label: "Overdue tasks", val: data.overdueTasks, icon: <AlertCircle className="h-3.5 w-3.5" />, urgent: data.overdueTasks > 0 },
                ].map(({ label, val, icon, urgent }) => (
                  <div
                    key={label}
                    className={cn(
                      crm.metricTile,
                      urgent && val > 0 ? "border-crm-danger/30" : "",
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-crm-muted">
                      {icon}
                      <span className="text-[10px] font-bold uppercase tracking-wide">
                        {label}
                      </span>
                    </div>
                    <span
                      className={cn(
                        "mt-1 text-xl font-bold tabular-nums",
                        urgent && val > 0 ? "text-crm-danger" : "text-crm-text",
                      )}
                    >
                      {val.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </CRMCard>

          {/* Quick links */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Open Queue", href: "/crm/queue", icon: <ListOrdered className="h-4 w-4" /> },
              { label: "Campaigns", href: "/crm/campaigns", icon: <Megaphone className="h-4 w-4" /> },
              { label: "Contacts", href: "/crm/contacts", icon: <Users className="h-4 w-4" /> },
              { label: "Follow-ups", href: "/crm/reports?tab=follow-ups", icon: <CalendarClock className="h-4 w-4" /> },
            ].map(({ label, href, icon }) => (
              <Link
                key={label}
                href={href}
                className={cn(
                  crm.card,
                  "flex items-center gap-2 px-3 py-2.5 text-sm font-medium text-crm-muted transition-colors hover:border-crm-border/90 hover:text-crm-text no-underline",
                )}
              >
                <span className="text-crm-accent">{icon}</span>
                {label}
                <ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0 opacity-50" />
              </Link>
            ))}
          </div>
        </div>

        {/* Right sidebar */}
        <div className={crm.reportsSideCol}>
          <CRMCard>
            <div className="mb-3 flex items-center justify-between">
              <p className={crm.label}>Operational Alerts</p>
            </div>
            <ReportsInsightFeed
              daily={data}
              campaigns={campaigns}
              agents={agents}
              followUps={followUps}
              loading={false}
            />
          </CRMCard>

          {/* Power session prompt */}
          {data.queueRemaining > 0 && data.activeCampaigns > 0 && (
            <CRMCard className="border-crm-accent/25 bg-crm-accent/5">
              <div className="flex items-start gap-3">
                <Zap className="mt-0.5 h-5 w-5 shrink-0 text-crm-accent" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-crm-text">
                    {data.queueRemaining.toLocaleString()} contacts ready
                  </p>
                  <p className="mt-0.5 text-xs text-crm-muted">
                    Start a power session to work through the queue
                  </p>
                  <Link
                    href="/crm/queue"
                    className={cn(crm.btnPrimary, "mt-3 w-full justify-center text-xs py-2")}
                  >
                    Open My Queue <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </div>
            </CRMCard>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Campaigns tab ─────────────────────────────────────────────────────────────

function CampaignsTab({
  data,
  loading,
  statusFilter,
  onStatusFilter,
  onExportRequest,
}: {
  data: CampaignRow[];
  loading: boolean;
  statusFilter: string;
  onStatusFilter: (s: string) => void;
  onExportRequest: () => void;
}) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-4">
      {/* Filter bar */}
      <CRMCard padding="md">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-semibold text-crm-text">Campaign Performance</p>
            <span className={cn(crm.chip, data.length > 0 && "border-crm-accent/30 bg-crm-accent/10 text-crm-accent")}>
              {data.length}
            </span>
          </div>
          <div className="ml-auto flex flex-wrap gap-1">
            {["all", "ACTIVE", "PAUSED", "COMPLETED"].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onStatusFilter(s)}
                className={cn(
                  statusFilter === s ? crm.filterPillActive : crm.filterPill,
                  "text-xs py-1 px-2.5",
                )}
              >
                {s === "all" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
        </div>
      </CRMCard>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-crm bg-crm-surface-2/50" />
          ))}
        </div>
      ) : (
        <ReportsOperationalTable
          cols={10}
          isEmpty={data.length === 0}
          head={
            <>
              <RtTh>Campaign</RtTh>
              <RtTh align="center">Status</RtTh>
              <RtTh align="center">Total</RtTh>
              <RtTh align="center">Pending</RtTh>
              <RtTh align="center">Contacted</RtTh>
              <RtTh align="center">Callbacks</RtTh>
              <RtTh align="center">Converted</RtTh>
              <RtTh align="center">DNC</RtTh>
              <RtTh>Conversion</RtTh>
              <RtTh align="center">Attempts</RtTh>
            </>
          }
        >
          {data.map((c) => (
            <tr
              key={c.id}
              className="cursor-pointer transition-colors hover:bg-crm-surface-2/40"
              onClick={() => router.push(`/crm/campaigns/${c.id}`)}
            >
              <RtTd>
                <p className="font-medium text-crm-text">{c.name}</p>
                <p className="text-xs text-crm-muted">
                  {new Date(c.lastActivityAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </RtTd>
              <RtTd align="center">
                <CampaignChip status={c.status} />
              </RtTd>
              <RtTd align="center">
                <MetricVal v={c.total} />
              </RtTd>
              <RtTd align="center">
                <PendingBar pending={c.pending} total={c.total} />
              </RtTd>
              <RtTd align="center">
                <MetricVal v={c.contacted} tone="accent" />
              </RtTd>
              <RtTd align="center">
                <MetricVal v={c.callbacks} tone={c.callbacks > 0 ? "warning" : undefined} />
              </RtTd>
              <RtTd align="center">
                <MetricVal v={c.converted} tone="success" />
              </RtTd>
              <RtTd align="center">
                <MetricVal v={c.dnc} tone={c.dnc > 0 ? "muted" : undefined} />
              </RtTd>
              <RtTd>
                <ConversionBar converted={c.converted} total={c.total} rate={c.conversionRate} />
              </RtTd>
              <RtTd align="center">
                <MetricVal v={c.totalAttempts} />
              </RtTd>
            </tr>
          ))}
        </ReportsOperationalTable>
      )}
    </div>
  );
}

// ── Agents tab ────────────────────────────────────────────────────────────────

function AgentsTab({
  data,
  loading,
  days,
  onDays,
}: {
  data: AgentRow[];
  loading: boolean;
  days: number;
  onDays: (d: number) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <CRMCard padding="md">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-semibold text-crm-text">Agent Activity</p>
            <span className={cn(crm.chip, data.length > 0 && "border-crm-accent/30 bg-crm-accent/10 text-crm-accent")}>
              {data.length}
            </span>
          </div>
          <div className="ml-auto flex gap-1">
            {([1, 7, 30] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onDays(d)}
                className={cn(
                  days === d ? crm.filterPillActive : crm.filterPill,
                  "text-xs py-1 px-2.5",
                )}
              >
                {d === 1 ? "Today" : `${d}d`}
              </button>
            ))}
          </div>
        </div>
      </CRMCard>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-crm bg-crm-surface-2/50" />
          ))}
        </div>
      ) : (
        <ReportsOperationalTable
          cols={7}
          isEmpty={data.length === 0}
          head={
            <>
              <RtTh>Agent</RtTh>
              <RtTh align="center">Role</RtTh>
              <RtTh align="center">Queue</RtTh>
              <RtTh align="center">Callbacks Due</RtTh>
              <RtTh align="center">Dispositions Today</RtTh>
              <RtTh align="center">Converted ({days}d)</RtTh>
              <RtTh align="center">Open Tasks</RtTh>
            </>
          }
        >
          {data.map((a) => (
            <tr key={a.userId} className="transition-colors hover:bg-crm-surface-2/40">
              <RtTd>
                <p className="font-medium text-crm-text">{a.displayName}</p>
                <p className="text-xs text-crm-muted">{a.email}</p>
              </RtTd>
              <RtTd align="center">
                <RoleChip role={a.crmRole} />
              </RtTd>
              <RtTd align="center">
                <MetricVal v={a.assignedQueue} />
              </RtTd>
              <RtTd align="center">
                <MetricVal v={a.callbacksDueToday} tone={a.callbacksDueToday > 0 ? "warning" : undefined} />
              </RtTd>
              <RtTd align="center">
                <MetricVal v={a.dispositionsToday} tone={a.dispositionsToday > 0 ? "accent" : undefined} />
              </RtTd>
              <RtTd align="center">
                <MetricVal v={a.convertedLast} tone={a.convertedLast > 0 ? "success" : undefined} />
              </RtTd>
              <RtTd align="center">
                <MetricVal v={a.openTasks} tone={a.openTasks > 5 ? "warning" : undefined} />
              </RtTd>
            </tr>
          ))}
        </ReportsOperationalTable>
      )}
    </div>
  );
}

// ── Follow-ups tab ────────────────────────────────────────────────────────────

function FollowUpsTab({
  data,
  loading,
}: {
  data: FollowUpsReport | null;
  loading: boolean;
}) {
  const router = useRouter();

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-crm bg-crm-surface-2/50" />
        ))}
      </div>
    );
  }

  if (!data) {
    return (
      <div className={cn(crm.emptyWrap, "py-16")}>
        <AlertCircle className="mx-auto mb-3 h-8 w-8 text-crm-danger/60" />
        <p className={crm.emptyTitle}>Failed to load follow-up data</p>
      </div>
    );
  }

  const totalUrgent = data.callbacks.overdue.count + data.tasks.overdue.count;

  function CallbackSection({
    title,
    bucket,
    urgent,
  }: {
    title: string;
    bucket: { count: number; rows: FollowUpMember[] };
    urgent?: boolean;
  }) {
    if (bucket.count === 0) return null;
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3
            className={cn(
              "text-sm font-semibold",
              urgent ? "text-crm-danger" : "text-crm-warning",
            )}
          >
            {title}
          </h3>
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs font-bold",
              urgent
                ? "border-crm-danger/30 bg-crm-danger/10 text-crm-danger"
                : "border-crm-warning/30 bg-crm-warning/10 text-crm-warning",
            )}
          >
            {bucket.count}
          </span>
        </div>
        <ReportsOperationalTable
          cols={5}
          isEmpty={bucket.rows.length === 0}
          head={
            <>
              <RtTh>Contact</RtTh>
              <RtTh>Campaign</RtTh>
              <RtTh>Callback Time</RtTh>
              <RtTh>Note</RtTh>
              <RtTh>Assigned</RtTh>
            </>
          }
        >
          {bucket.rows.map((m) => (
            <tr
              key={m.id}
              className="cursor-pointer transition-colors hover:bg-crm-surface-2/40"
              onClick={() => router.push(`/crm/contacts/${m.contactId}`)}
            >
              <RtTd>
                <p className="font-medium text-crm-text">{m.contactName}</p>
                {m.contactPhone && (
                  <p className="text-xs text-crm-muted">{m.contactPhone}</p>
                )}
              </RtTd>
              <RtTd>
                <span className="text-xs text-crm-muted">{m.campaign?.name ?? "—"}</span>
              </RtTd>
              <RtTd>
                <span
                  className={cn(
                    "text-xs font-medium",
                    urgent ? "text-crm-danger" : "text-crm-warning",
                  )}
                >
                  {m.callbackAt
                    ? new Date(m.callbackAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "—"}
                </span>
              </RtTd>
              <RtTd>
                <span className="max-w-[180px] truncate text-xs italic text-crm-muted">
                  {m.callbackNote ?? "—"}
                </span>
              </RtTd>
              <RtTd>
                <span className="text-xs text-crm-muted">
                  {m.assignedTo?.name ?? "Unassigned"}
                </span>
              </RtTd>
            </tr>
          ))}
        </ReportsOperationalTable>
      </div>
    );
  }

  function TaskSection({
    title,
    bucket,
    urgent,
  }: {
    title: string;
    bucket: { count: number; rows: FollowUpTask[] };
    urgent?: boolean;
  }) {
    if (bucket.count === 0) return null;
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3
            className={cn(
              "text-sm font-semibold",
              urgent ? "text-crm-danger" : "text-crm-warning",
            )}
          >
            {title}
          </h3>
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs font-bold",
              urgent
                ? "border-crm-danger/30 bg-crm-danger/10 text-crm-danger"
                : "border-crm-warning/30 bg-crm-warning/10 text-crm-warning",
            )}
          >
            {bucket.count}
          </span>
        </div>
        <ReportsOperationalTable
          cols={5}
          isEmpty={bucket.rows.length === 0}
          head={
            <>
              <RtTh>Contact</RtTh>
              <RtTh>Task</RtTh>
              <RtTh>Due</RtTh>
              <RtTh align="center">Priority</RtTh>
              <RtTh>Assigned</RtTh>
            </>
          }
        >
          {bucket.rows.map((t) => (
            <tr
              key={t.id}
              className="cursor-pointer transition-colors hover:bg-crm-surface-2/40"
              onClick={() => router.push(`/crm/contacts/${t.contactId}`)}
            >
              <RtTd>
                <p className="font-medium text-crm-text">{t.contactName}</p>
                {t.contactPhone && (
                  <p className="text-xs text-crm-muted">{t.contactPhone}</p>
                )}
              </RtTd>
              <RtTd>
                <span className="max-w-[200px] truncate text-sm text-crm-text">
                  {t.title}
                </span>
              </RtTd>
              <RtTd>
                <span
                  className={cn(
                    "text-xs font-medium",
                    urgent ? "text-crm-danger" : "text-crm-warning",
                  )}
                >
                  {t.dueAt
                    ? new Date(t.dueAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })
                    : "—"}
                </span>
              </RtTd>
              <RtTd align="center">
                <span
                  className={cn(
                    "rounded-crm border px-1.5 py-0.5 text-xs font-medium",
                    t.priority === "URGENT"
                      ? "border-crm-danger/30 bg-crm-danger/10 text-crm-danger"
                      : t.priority === "HIGH"
                        ? "border-crm-warning/30 bg-crm-warning/10 text-crm-warning"
                        : "border-crm-border/70 bg-crm-surface-2 text-crm-muted",
                  )}
                >
                  {t.priority}
                </span>
              </RtTd>
              <RtTd>
                <span className="text-xs text-crm-muted">
                  {t.assignedTo?.name ?? "Unassigned"}
                </span>
              </RtTd>
            </tr>
          ))}
        </ReportsOperationalTable>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {totalUrgent > 0 && (
        <div className="flex items-center gap-3 rounded-crm-lg border border-crm-danger/30 bg-crm-danger/8 px-4 py-3 text-sm text-crm-danger">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <strong>
            {totalUrgent} overdue item{totalUrgent !== 1 ? "s" : ""} need immediate
            attention.
          </strong>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <p className={cn(crm.label, "border-b border-crm-border/40 pb-2")}>Callbacks</p>
        <CallbackSection title="Overdue Callbacks" bucket={data.callbacks.overdue} urgent />
        <CallbackSection title="Due Today" bucket={data.callbacks.dueToday} />
        <CallbackSection title="Due This Week" bucket={data.callbacks.dueThisWeek} />
        {data.callbacks.overdue.count === 0 &&
          data.callbacks.dueToday.count === 0 &&
          data.callbacks.dueThisWeek.count === 0 && (
            <p className={cn(crm.muted, "italic")}>No callbacks due</p>
          )}
      </div>

      <div className="flex flex-col gap-4">
        <p className={cn(crm.label, "border-b border-crm-border/40 pb-2")}>Tasks</p>
        <TaskSection title="Overdue Tasks" bucket={data.tasks.overdue} urgent />
        <TaskSection title="Due Today" bucket={data.tasks.dueToday} />
        {data.tasks.overdue.count === 0 && data.tasks.dueToday.count === 0 && (
          <p className={cn(crm.muted, "italic")}>No tasks due</p>
        )}
      </div>
    </div>
  );
}

// ── Intelligence tab ──────────────────────────────────────────────────────────

function IntelligenceTab({
  daily,
  campaigns,
  agents,
  followUps,
  loading,
}: {
  daily: DailyReport | null;
  campaigns: CampaignRow[];
  agents: AgentRow[];
  followUps: FollowUpsReport | null;
  loading: boolean;
}) {
  const activeCampaigns = campaigns.filter((c) => c.status === "ACTIVE");
  const topCampaigns = [...activeCampaigns]
    .sort((a, b) => b.conversionRate - a.conversionRate)
    .slice(0, 5);
  const needsAttention = [...activeCampaigns]
    .filter((c) => c.total > 0 && c.pending / c.total > 0.5)
    .sort((a, b) => b.pending - a.pending)
    .slice(0, 5);

  const topAgents = [...agents]
    .filter((a) => a.dispositionsToday > 0)
    .sort((a, b) => b.dispositionsToday - a.dispositionsToday)
    .slice(0, 5);

  const coachingOps = [...agents]
    .filter((a) => a.callbacksDueToday > 2 || a.openTasks > 5)
    .slice(0, 5);

  return (
    <div className="flex flex-col gap-6">
      {/* Full insight feed */}
      <CRMCard>
        <p className={cn(crm.label, "mb-3")}>Operational Intelligence</p>
        <ReportsInsightFeed
          daily={daily}
          campaigns={campaigns}
          agents={agents}
          followUps={followUps}
          loading={loading}
        />
      </CRMCard>

      <div className={crm.reportsGrid}>
        {/* Left: campaign analysis */}
        <div className={crm.reportsMainCol}>
          {topCampaigns.length > 0 && (
            <CRMCard>
              <p className={cn(crm.label, "mb-3")}>Top Performing Campaigns</p>
              <ReportsOperationalTable
                cols={4}
                isEmpty={topCampaigns.length === 0}
                head={
                  <>
                    <RtTh>Campaign</RtTh>
                    <RtTh align="center">Converted</RtTh>
                    <RtTh>Conversion</RtTh>
                    <RtTh align="center">Pending</RtTh>
                  </>
                }
              >
                {topCampaigns.map((c, i) => (
                  <tr key={c.id} className="transition-colors hover:bg-crm-surface-2/40">
                    <RtTd>
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-crm-surface-2 text-[10px] font-bold text-crm-muted tabular-nums">
                          {i + 1}
                        </span>
                        <span className="font-medium text-crm-text">{c.name}</span>
                      </div>
                    </RtTd>
                    <RtTd align="center">
                      <MetricVal v={c.converted} tone="success" />
                    </RtTd>
                    <RtTd>
                      <ConversionBar
                        converted={c.converted}
                        total={c.total}
                        rate={c.conversionRate}
                      />
                    </RtTd>
                    <RtTd align="center">
                      <MetricVal v={c.pending} />
                    </RtTd>
                  </tr>
                ))}
              </ReportsOperationalTable>
            </CRMCard>
          )}

          {needsAttention.length > 0 && (
            <CRMCard>
              <div className="mb-3 flex items-center gap-2">
                <p className={crm.label}>Campaigns Needing Attention</p>
                <span className="rounded-full border border-crm-warning/30 bg-crm-warning/10 px-2 py-0.5 text-xs font-bold text-crm-warning">
                  {needsAttention.length}
                </span>
              </div>
              <p className="mb-3 text-xs text-crm-muted">
                Active campaigns with &gt;50% of contacts still pending
              </p>
              <ReportsOperationalTable
                cols={4}
                isEmpty={needsAttention.length === 0}
                head={
                  <>
                    <RtTh>Campaign</RtTh>
                    <RtTh>Queue Backlog</RtTh>
                    <RtTh align="center">Callbacks</RtTh>
                    <RtTh align="center">Total</RtTh>
                  </>
                }
              >
                {needsAttention.map((c) => (
                  <tr key={c.id} className="transition-colors hover:bg-crm-surface-2/40">
                    <RtTd>
                      <span className="font-medium text-crm-text">{c.name}</span>
                    </RtTd>
                    <RtTd>
                      <PendingBar pending={c.pending} total={c.total} />
                    </RtTd>
                    <RtTd align="center">
                      <MetricVal
                        v={c.callbacks}
                        tone={c.callbacks > 0 ? "warning" : undefined}
                      />
                    </RtTd>
                    <RtTd align="center">
                      <MetricVal v={c.total} />
                    </RtTd>
                  </tr>
                ))}
              </ReportsOperationalTable>
            </CRMCard>
          )}

          {topCampaigns.length === 0 && needsAttention.length === 0 && !loading && (
            <div className={crm.emptyWrap}>
              <p className={crm.emptyTitle}>No active campaign data</p>
              <p className={cn(crm.emptyBody)}>
                Start a campaign to see performance intelligence here.
              </p>
              <Link href="/crm/campaigns" className={cn(crm.btnPrimary, "mt-4 inline-flex")}>
                Go to Campaigns <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </div>
          )}
        </div>

        {/* Right: agent intelligence */}
        <div className={crm.reportsSideCol}>
          {topAgents.length > 0 && (
            <CRMCard>
              <p className={cn(crm.label, "mb-3")}>Agent Leaderboard Today</p>
              <ul className="flex flex-col gap-2">
                {topAgents.map((a, i) => (
                  <li
                    key={a.userId}
                    className="flex items-center gap-3 rounded-crm border border-crm-border/60 bg-crm-surface-2/40 px-3 py-2"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-crm-surface-2 text-[11px] font-bold tabular-nums text-crm-muted">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-crm-text">
                        {a.displayName}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <span className="text-sm font-bold tabular-nums text-crm-success">
                        {a.dispositionsToday}
                      </span>
                      <p className="text-[10px] text-crm-muted">dispositions</p>
                    </div>
                  </li>
                ))}
              </ul>
            </CRMCard>
          )}

          {coachingOps.length > 0 && (
            <CRMCard>
              <div className="mb-3 flex items-center gap-2">
                <p className={crm.label}>Coaching Opportunities</p>
                <span className="rounded-full border border-crm-warning/30 bg-crm-warning/10 px-2 py-0.5 text-xs font-bold text-crm-warning">
                  {coachingOps.length}
                </span>
              </div>
              <ul className="flex flex-col gap-2">
                {coachingOps.map((a) => (
                  <li
                    key={a.userId}
                    className="rounded-crm border border-crm-border/60 bg-crm-surface-2/40 px-3 py-2"
                  >
                    <p className="text-sm font-medium text-crm-text">{a.displayName}</p>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-crm-muted">
                      {a.callbacksDueToday > 2 && (
                        <span className="text-crm-warning">
                          {a.callbacksDueToday} callbacks due
                        </span>
                      )}
                      {a.openTasks > 5 && (
                        <span className="text-crm-warning">
                          {a.openTasks} open tasks
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </CRMCard>
          )}

          {topAgents.length === 0 && coachingOps.length === 0 && !loading && (
            <CRMCard>
              <p className={crm.muted}>No agent activity data available.</p>
            </CRMCard>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const [tab, setTab] = useState<ReportTab>("operations");
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const [dailyData, setDailyData] = useState<DailyReport | null>(null);
  const [campaignsData, setCampaignsData] = useState<CampaignRow[]>([]);
  const [agentsData, setAgentsData] = useState<AgentRow[]>([]);
  const [followUpsData, setFollowUpsData] = useState<FollowUpsReport | null>(null);

  const [dailyLoading, setDailyLoading] = useState(false);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [followUpsLoading, setFollowUpsLoading] = useState(false);

  const [campaignStatusFilter, setCampaignStatusFilter] = useState("all");
  const [agentDays, setAgentDays] = useState(30);

  const token =
    typeof window !== "undefined"
      ? (localStorage.getItem("token") ?? undefined)
      : undefined;

  // Loaders
  const loadDaily = useCallback(() => {
    setDailyLoading(true);
    apiGet<DailyReport>("/crm/reports/daily", token)
      .then(setDailyData)
      .catch(() => {})
      .finally(() => {
        setDailyLoading(false);
        setLastRefreshed(new Date());
      });
  }, [token]);

  const loadCampaigns = useCallback(
    (sf: string) => {
      setCampaignsLoading(true);
      apiGet<{ campaigns: CampaignRow[] }>(
        `/crm/reports/campaigns?status=${sf}`,
        token,
      )
        .then((r) => setCampaignsData(r.campaigns))
        .catch(() => {})
        .finally(() => {
          setCampaignsLoading(false);
          setLastRefreshed(new Date());
        });
    },
    [token],
  );

  const loadAgents = useCallback(
    (d: number) => {
      setAgentsLoading(true);
      apiGet<{ agents: AgentRow[] }>(
        `/crm/reports/agents?days=${d}`,
        token,
      )
        .then((r) => setAgentsData(r.agents))
        .catch(() => {})
        .finally(() => {
          setAgentsLoading(false);
          setLastRefreshed(new Date());
        });
    },
    [token],
  );

  const loadFollowUps = useCallback(() => {
    setFollowUpsLoading(true);
    apiGet<FollowUpsReport>("/crm/reports/follow-ups", token)
      .then(setFollowUpsData)
      .catch(() => {})
      .finally(() => {
        setFollowUpsLoading(false);
        setLastRefreshed(new Date());
      });
  }, [token]);

  const loadAll = useCallback(() => {
    loadDaily();
    loadCampaigns(campaignStatusFilter);
    loadAgents(agentDays);
    loadFollowUps();
  }, [loadDaily, loadCampaigns, loadAgents, loadFollowUps, campaignStatusFilter, agentDays]);

  // Initial tab load + URL deep-link
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    // Backwards compat: old "daily" deep-links map to "operations"
    const mapped: ReportTab =
      t === "daily"
        ? "operations"
        : t === "campaigns" || t === "agents" || t === "follow-ups" || t === "intelligence"
          ? (t as ReportTab)
          : "operations";
    setTab(mapped);
  }, []);

  // Load data when tab changes
  useEffect(() => {
    if (tab === "operations") {
      if (!dailyData) loadDaily();
    } else if (tab === "campaigns") {
      if (campaignsData.length === 0) loadCampaigns(campaignStatusFilter);
    } else if (tab === "agents") {
      if (agentsData.length === 0) loadAgents(agentDays);
    } else if (tab === "follow-ups") {
      if (!followUpsData) loadFollowUps();
    } else if (tab === "intelligence") {
      // Load all for intelligence
      if (!dailyData) loadDaily();
      if (campaignsData.length === 0) loadCampaigns("all");
      if (agentsData.length === 0) loadAgents(agentDays);
      if (!followUpsData) loadFollowUps();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  function handleTabChange(next: ReportTab) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState({}, "", url.toString());
  }

  function handleRefresh() {
    if (tab === "operations") loadDaily();
    else if (tab === "campaigns") loadCampaigns(campaignStatusFilter);
    else if (tab === "agents") loadAgents(agentDays);
    else if (tab === "follow-ups") loadFollowUps();
    else if (tab === "intelligence") loadAll();
  }

  function handleCampaignStatusFilter(sf: string) {
    setCampaignStatusFilter(sf);
    loadCampaigns(sf);
  }

  function handleAgentDays(d: number) {
    setAgentDays(d);
    loadAgents(d);
  }

  function handleExport() {
    if (tab === "campaigns" && campaignsData.length > 0) {
      downloadCsv("campaigns-report.csv", [
        ["Campaign", "Status", "Total", "Pending", "Contacted", "Callbacks", "Converted", "DNC", "Conversion %", "Attempts"],
        ...campaignsData.map((c) => [
          c.name,
          c.status,
          String(c.total),
          String(c.pending),
          String(c.contacted),
          String(c.callbacks),
          String(c.converted),
          String(c.dnc),
          String(c.conversionRate),
          String(c.totalAttempts),
        ]),
      ]);
    } else if (tab === "agents" && agentsData.length > 0) {
      downloadCsv("agents-report.csv", [
        ["Agent", "Email", "Role", "Queue", "Callbacks Due", "Dispositions Today", "Converted", "Open Tasks"],
        ...agentsData.map((a) => [
          a.displayName,
          a.email,
          a.crmRole,
          String(a.assignedQueue),
          String(a.callbacksDueToday),
          String(a.dispositionsToday),
          String(a.convertedLast),
          String(a.openTasks),
        ]),
      ]);
    } else if (tab === "operations" && dailyData) {
      downloadCsv("operations-report.csv", [
        ["Metric", "Value"],
        ["Dispositions Today", String(dailyData.dispositionsToday)],
        ["Calls Linked Today", String(dailyData.callsLinkedToday)],
        ["Contacts Created Today", String(dailyData.contactsCreatedToday)],
        ["Tasks Due Today", String(dailyData.tasksDueToday)],
        ["Overdue Tasks", String(dailyData.overdueTasks)],
        ["Callbacks Due Today", String(dailyData.callbacksDueToday)],
        ["Overdue Callbacks", String(dailyData.overdueCallbacks)],
        ["Active Campaigns", String(dailyData.activeCampaigns)],
        ["Queue Remaining", String(dailyData.queueRemaining)],
      ]);
    }
  }

  const anyLoading =
    dailyLoading || campaignsLoading || agentsLoading || followUpsLoading;

  return (
    <div className={cn("crm-page-shell min-h-screen", crm.reportsWorkspace)}>
      <ReportsCommandHeader
        activeTab={tab}
        onTabChange={handleTabChange}
        lastRefreshed={lastRefreshed}
        loading={anyLoading}
        onRefresh={handleRefresh}
        onExport={handleExport}
      />

      <div className={crm.pageInnerReports}>
        {tab === "operations" && (
          <OperationsTab
            data={dailyData}
            loading={dailyLoading}
            campaigns={campaignsData}
            agents={agentsData}
            followUps={followUpsData}
          />
        )}
        {tab === "campaigns" && (
          <CampaignsTab
            data={campaignsData}
            loading={campaignsLoading}
            statusFilter={campaignStatusFilter}
            onStatusFilter={handleCampaignStatusFilter}
            onExportRequest={handleExport}
          />
        )}
        {tab === "agents" && (
          <AgentsTab
            data={agentsData}
            loading={agentsLoading}
            days={agentDays}
            onDays={handleAgentDays}
          />
        )}
        {tab === "follow-ups" && (
          <FollowUpsTab data={followUpsData} loading={followUpsLoading} />
        )}
        {tab === "intelligence" && (
          <IntelligenceTab
            daily={dailyData}
            campaigns={campaignsData}
            agents={agentsData}
            followUps={followUpsData}
            loading={anyLoading}
          />
        )}
      </div>
    </div>
  );
}
