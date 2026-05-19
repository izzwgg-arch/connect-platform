"use client";

import Link from "next/link";
import { AlertCircle, Clock, Radio } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { LoadingSkeleton } from "../../LoadingSkeleton";

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
}: {
  label: string;
  value: number | string;
  tone?: "neutral" | "danger" | "warn" | "positive";
  href?: string;
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
      ? "border-crm-danger/35 bg-crm-danger/8"
      : tone === "warn"
        ? "border-crm-warning/30 bg-crm-warning/6"
        : tone === "positive"
          ? "border-crm-success/30 bg-crm-success/6"
          : "border-crm-border/70 bg-crm-surface-2/30";

  const inner = (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-crm border px-3 py-2.5 transition-colors",
        borderClass,
        href && "cursor-pointer hover:brightness-105",
      )}
    >
      <span className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">{label}</span>
      <span className={cn("text-xl font-bold tabular-nums leading-tight", valueClass)}>{value}</span>
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

  return (
    <div className="relative overflow-hidden rounded-crm-lg border border-crm-border/80 bg-crm-surface shadow-[0_8px_40px_-12px_rgba(0,0,0,0.55)]">
      {/* Ambient glow overlay */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_65%_55%_at_0%_0%,rgba(56,189,248,0.07),transparent_52%),radial-gradient(ellipse_35%_35%_at_100%_105%,rgba(99,102,241,0.05),transparent_50%)]" />

      <div className="relative z-[1] p-4 sm:p-5">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className={cn(crm.iconBox, "h-8 w-8 shrink-0")}>
              <Radio size={15} />
            </span>
            <h2 className="text-sm font-semibold tracking-tight text-crm-text">Live CRM Operations</h2>
          </div>
          <span className={cn(crm.chip, crm.chipActive, "shrink-0 text-[10px]")}>
            <Radio size={10} className="animate-pulse" />
            Live
          </span>
        </div>

        {loading ? (
          <LoadingSkeleton rows={4} />
        ) : (
          <>
            {/* Metric grid */}
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <OpsMetric
                label="Queue depth"
                value={queueDepth}
                href={canViewQueue ? "/crm/queue" : undefined}
              />
              <OpsMetric
                label="Overdue CBs"
                value={overdueCallbacks}
                tone={overdueCallbacks > 0 ? "danger" : "neutral"}
                href={canViewQueue && overdueCallbacks > 0 ? "/crm/queue?filter=overdue" : undefined}
              />
              <OpsMetric
                label="Due today"
                value={dueTodayCallbacks}
                tone={dueTodayCallbacks > 0 ? "warn" : "neutral"}
                href={canViewQueue && dueTodayCallbacks > 0 ? "/crm/queue?filter=due" : undefined}
              />
              <OpsMetric
                label="Calls today"
                value={callsToday}
                tone={typeof callsToday === "number" && callsToday > 0 ? "positive" : "neutral"}
              />
              <OpsMetric label="Outcomes" value={outcomesToday} />
              <OpsMetric
                label="New contacts"
                value={contactsToday}
                tone={typeof contactsToday === "number" && contactsToday > 0 ? "positive" : "neutral"}
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
                          className="flex items-center justify-between gap-2 rounded-crm border border-crm-border/55 bg-crm-surface-2/40 px-2.5 py-1.5 text-inherit no-underline transition-colors hover:border-crm-border hover:bg-crm-surface-2/70"
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
                          className="flex items-center gap-2 rounded-crm border border-crm-danger/25 bg-crm-danger/6 px-2.5 py-1.5 text-inherit no-underline transition-colors hover:bg-crm-danger/10"
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
                          className="flex items-center gap-2 rounded-crm border border-crm-warning/25 bg-crm-warning/6 px-2.5 py-1.5 text-inherit no-underline transition-colors hover:bg-crm-warning/10"
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
