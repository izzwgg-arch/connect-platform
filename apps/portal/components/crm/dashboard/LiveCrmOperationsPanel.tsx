"use client";

import Link from "next/link";
import { AlertCircle, Clock, Radio } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { LoadingSkeleton } from "../../LoadingSkeleton";
import { QueuePressureGauge, Sparkline } from "../charts";

// ── Prop types (mirrors page-level computed shapes) ───────────────────────────

type CampaignItem = {
  id: string;
  name: string;
  memberCount?: number;
};

type QueueItem = {
  id: string;
  contact: { displayName: string } | null;
  campaign: { id: string; name: string } | null;
};

export type LiveCrmOpsPanelProps = {
  loading: boolean;
  /** Queue total (team-wide for admins, personal otherwise) */
  queueDepth: number | string;
  overdueCallbacks: number;
  dueTodayCallbacks: number;
  callsToday: number | string;
  outcomesToday: number | string;
  contactsToday: number | string;
  activeCampaigns: CampaignItem[];
  queueOverdueItems: QueueItem[];
  queueDueItems: QueueItem[];
  canViewQueue: boolean;
  canViewCampaigns: boolean;
};

// ── Sub-components ────────────────────────────────────────────────────────────

function OpsMetric({
  label,
  value,
  tone = "neutral",
  href,
  meta,
}: {
  label: string;
  value: number | string;
  tone?: "neutral" | "danger" | "warn" | "positive";
  href?: string;
  meta?: string;
}) {
  const valueClass =
    tone === "danger"
      ? "text-crm-danger"
      : tone === "warn"
        ? "text-crm-warning"
        : tone === "positive"
          ? "text-crm-success"
          : "text-crm-text";

  const borderClass =
    tone === "danger"
      ? "border-crm-danger/35 bg-crm-danger/8 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
      : tone === "warn"
        ? "border-crm-warning/30 bg-crm-warning/6 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
        : tone === "positive"
          ? "border-crm-success/30 bg-crm-success/6 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
          : "border-crm-border/70 bg-crm-surface-2/35";

  const inner = (
    <div
      className={cn(
        "flex min-h-[4.35rem] flex-col justify-between gap-1 rounded-crm border px-3 py-2.5 transition-all duration-200",
        borderClass,
        href && "cursor-pointer hover:-translate-y-px hover:brightness-105",
      )}
    >
      <span className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">{label}</span>
      <span className={cn("text-xl font-bold tabular-nums leading-tight", valueClass)}>{value}</span>
      {meta ? <span className="truncate text-[10px] font-medium text-crm-muted">{meta}</span> : null}
    </div>
  );

  if (!href) return inner;
  return (
    <Link href={href} className="block no-underline text-inherit">
      {inner}
    </Link>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function LiveCrmOperationsPanel({
  loading,
  queueDepth,
  overdueCallbacks,
  dueTodayCallbacks,
  callsToday,
  outcomesToday,
  contactsToday,
  activeCampaigns,
  queueOverdueItems,
  queueDueItems,
  canViewQueue,
  canViewCampaigns,
}: LiveCrmOpsPanelProps) {
  const hasQueueItems = queueOverdueItems.length > 0 || queueDueItems.length > 0;
  const qNum = typeof queueDepth === "number" ? queueDepth : Number.isFinite(Number(queueDepth)) ? Number(queueDepth) : 0;
  const sixHourSeries = Array.from({ length: 18 }, () => qNum);
  const queueTone = overdueCallbacks > 0 ? "danger" : dueTodayCallbacks > 0 ? "warn" : qNum > 0 ? "neutral" : "positive";
  const queueStatus = overdueCallbacks > 0 ? "Degraded" : dueTodayCallbacks > 0 ? "Watch" : qNum > 0 ? "Live" : "Clear";

  return (
    <div className={cn(crm.opCard, "border-crm-border/85")}>
      {/* Ambient glow overlay */}
      <div className={crm.opCardGlow} />

      <div className="relative z-[1] p-4 sm:p-5">
        {/* Header */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className={cn(crm.iconBox, "h-8 w-8 shrink-0")}>
              <Radio size={15} />
            </span>
            <div>
              <h2 className="text-sm font-semibold tracking-tight text-crm-text">Live CRM Operations</h2>
              <p className="mt-0.5 text-[11px] text-crm-muted">Queue pressure, campaigns, and follow-up exceptions</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                crm.chip,
                "shrink-0 text-[10px]",
                queueTone === "danger"
                  ? "border-crm-danger/35 bg-crm-danger/10 text-crm-danger"
                  : queueTone === "warn"
                    ? "border-crm-warning/35 bg-crm-warning/10 text-crm-warning"
                    : queueTone === "positive"
                      ? "border-crm-success/35 bg-crm-success/10 text-crm-success"
                      : crm.chipActive,
              )}
            >
              <span
                className={
                  queueTone === "danger"
                    ? crm.statusDotDanger
                    : queueTone === "warn"
                      ? crm.statusDotWarn
                      : queueTone === "positive"
                        ? crm.statusDotLive
                        : crm.statusDotSync
                }
              />
              {queueStatus}
            </span>
            <span className={cn(crm.chip, "shrink-0 text-[10px]")}>Now</span>
          </div>
        </div>

        {loading ? (
          <LoadingSkeleton rows={4} />
        ) : (
          <>
            {/* Centerpiece header: gauge + mini line (placeholder series from current value) */}
            <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
              <QueuePressureGauge value={qNum} className="justify-self-start" />
              <div className={cn(crm.opInset, "flex min-w-0 flex-col justify-center px-3 py-2.5")}>
                <div className="mb-1 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-crm-muted">
                  <span>Current load visual</span>
                  <span>{queueStatus}</span>
                </div>
                <Sparkline
                  series={sixHourSeries}
                  width={520}
                  height={44}
                  stroke={1.6}
                  color="var(--crm-accent)"
                  fill="transparent"
                  ariaLabel="Queue depth visual — current-load placeholder"
                />
              </div>
            </div>

            {/* Metric grid */}
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <OpsMetric
                label="Due today"
                value={dueTodayCallbacks}
                tone={dueTodayCallbacks > 0 ? "warn" : "neutral"}
                href={canViewQueue && dueTodayCallbacks > 0 ? "/crm/queue?filter=due" : undefined}
                meta="callbacks"
              />
              <OpsMetric
                label="Calls today"
                value={callsToday}
                tone={typeof callsToday === "number" && callsToday > 0 ? "positive" : "neutral"}
                meta="linked"
              />
              <OpsMetric label="Outcomes" value={outcomesToday} meta="logged" />
              <OpsMetric
                label="Contacts"
                value={contactsToday}
                tone={typeof contactsToday === "number" && contactsToday > 0 ? "positive" : "neutral"}
                meta="new today"
              />
            </div>

            {/* Divider */}
            <div className="mb-4 border-t border-crm-border/40" />

            {/* Bottom section: campaigns + queue activity */}
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Active Campaigns */}
              {canViewCampaigns ? (
                <div>
                  <p className={cn(crm.label, "mb-2 flex items-center gap-1.5")}>
                    Active campaigns
                    {activeCampaigns.length > 0 && (
                      <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-crm-success/20 px-1 text-[9px] font-bold tabular-nums text-crm-success">
                        {activeCampaigns.length}
                      </span>
                    )}
                  </p>
                  {activeCampaigns.length === 0 ? (
                    <p className="text-xs text-crm-muted">
                      No active campaigns ·{" "}
                      <Link href="/crm/campaigns" className="text-crm-accent hover:brightness-110">
                        Launch one →
                      </Link>
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {activeCampaigns.slice(0, 4).map((c) => (
                        <Link
                          key={c.id}
                          href={`/crm/campaigns/${encodeURIComponent(c.id)}`}
                          className="group flex items-center justify-between gap-2 rounded-crm border border-crm-border/55 bg-crm-surface-2/40 px-2.5 py-1.5 text-inherit no-underline transition-all duration-200 hover:-translate-y-px hover:border-crm-border hover:bg-crm-surface-2/70"
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-1.5">
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-crm-success" />
                            <span className="truncate text-xs font-medium text-crm-text">{c.name}</span>
                          </span>
                          <span className="shrink-0 text-[10px] tabular-nums text-crm-muted">
                            {c.memberCount ?? 0} members
                          </span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}

              {/* Queue activity feed */}
              {canViewQueue ? (
                <div>
                  <p className={cn(crm.label, "mb-2")}>Queue activity</p>
                  {!hasQueueItems ? (
                    <p className="text-xs text-crm-muted">
                      Queue clear ·{" "}
                      <Link href="/crm/queue" className="text-crm-accent hover:brightness-110">
                        Open queue →
                      </Link>
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {queueOverdueItems.slice(0, 3).map((m) => (
                        <Link
                          key={`o-${m.id}`}
                          href="/crm/queue?filter=overdue"
                          className="flex items-center gap-2 rounded-crm border border-crm-danger/25 bg-crm-danger/6 px-2.5 py-1.5 text-inherit no-underline transition-all duration-200 hover:-translate-y-px hover:bg-crm-danger/10"
                        >
                          <AlertCircle size={11} className="shrink-0 text-crm-danger" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium text-crm-text">
                              {m.contact?.displayName ?? "Contact"}
                            </span>
                            <span className="block truncate text-[10px] text-crm-muted">
                              Overdue · {m.campaign?.name ?? "—"}
                            </span>
                          </span>
                        </Link>
                      ))}
                      {queueDueItems.slice(0, 2).map((m) => (
                        <Link
                          key={`d-${m.id}`}
                          href="/crm/queue?filter=due"
                          className="flex items-center gap-2 rounded-crm border border-crm-warning/25 bg-crm-warning/6 px-2.5 py-1.5 text-inherit no-underline transition-all duration-200 hover:-translate-y-px hover:bg-crm-warning/10"
                        >
                          <Clock size={11} className="shrink-0 text-crm-warning" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium text-crm-text">
                              {m.contact?.displayName ?? "Contact"}
                            </span>
                            <span className="block truncate text-[10px] text-crm-muted">
                              Due today · {m.campaign?.name ?? "—"}
                            </span>
                          </span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
