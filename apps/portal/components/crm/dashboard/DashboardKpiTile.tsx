"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { CRMCard } from "../CRMCard";
import { crm } from "../crmClasses";
import { LoadingSkeleton } from "../../LoadingSkeleton";
import { Sparkline } from "../charts";

export function DashboardKpiTile({
  label,
  value,
  href,
  icon,
  loading,
  tone = "neutral",
  series,
  trendText,
  trendTone,
  statusText = "Live",
  statusTone,
  accent = "blue",
}: {
  label: string;
  value: number | string;
  href?: string;
  icon: ReactNode;
  loading: boolean;
  tone?: "neutral" | "warn" | "danger" | "positive";
  series?: number[];
  trendText?: string;
  trendTone?: "neutral" | "warn" | "danger" | "positive";
  statusText?: string;
  statusTone?: "neutral" | "syncing" | "warn" | "danger" | "positive";
  accent?: "blue" | "violet" | "rose" | "green" | "cyan" | "amber";
}) {
  const border =
    tone === "danger"
      ? "border-crm-danger/45 bg-crm-danger/5"
      : tone === "warn"
        ? "border-crm-warning/45 bg-crm-warning/5"
        : tone === "positive"
          ? "border-crm-success/40 bg-crm-success/5"
          : "border-crm-border/80";

  const valueClass =
    tone === "danger"
      ? "text-crm-danger"
      : tone === "warn"
        ? "text-crm-warning"
        : tone === "positive"
          ? "text-crm-success"
          : "text-crm-text";

  const dotClass =
    statusTone === "danger"
      ? crm.statusDotDanger
      : statusTone === "warn"
        ? crm.statusDotWarn
        : statusTone === "syncing"
          ? crm.statusDotSync
          : statusTone === "positive"
            ? crm.statusDotLive
            : cn(crm.statusDot, "bg-crm-muted/60");

  const inner = (
    <div
      className={cn(
        "crm-dashboard-kpi relative z-[1] flex min-h-[7.25rem] flex-col gap-2.5 p-3.5",
        `crm-dashboard-kpi-${accent}`,
        href && "cursor-pointer",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="crm-dashboard-kpi-label block truncate text-[0.65rem] font-bold uppercase tracking-wider text-crm-muted">{label}</span>
          <span className="crm-dashboard-kpi-status mt-1 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-crm-muted">
            <span className={dotClass} />
            {statusText}
          </span>
        </div>
        <span className="crm-dashboard-kpi-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface-2/60 text-crm-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          {icon}
        </span>
      </div>
      {loading ? (
        <div className="h-7 pt-0.5">
          <LoadingSkeleton rows={1} />
        </div>
      ) : (
        <span className={cn("crm-dashboard-kpi-value text-[1.65rem] font-bold tabular-nums leading-none tracking-tight", valueClass)}>{value}</span>
      )}
      {!loading && series && series.length > 1 ? (
        <div className="crm-dashboard-kpi-footer mt-auto flex items-end justify-between gap-2">
          <Sparkline
            series={series}
            width={120}
            height={22}
            stroke={1.25}
            color={
              tone === "danger"
                ? "var(--crm-danger)"
                : tone === "warn"
                ? "var(--crm-warning)"
                : tone === "positive"
                ? "var(--crm-success)"
                : "var(--crm-accent)"
            }
            ariaLabel={`${label} current trend`}
          />
          {trendText ? (
            <span
              className={cn(
                "shrink-0 text-[10px] font-semibold uppercase tracking-wider",
                trendTone === "danger"
                  ? "text-crm-danger"
                  : trendTone === "warn"
                  ? "text-crm-warning"
                  : trendTone === "positive"
                  ? "text-crm-success"
                  : "text-crm-muted",
              )}
            >
              {trendText}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <CRMCard padding="none" className={cn("crm-dashboard-kpi-card", crm.opCard, crm.opCardHover, border)}>
      <div className={crm.opCardGlow} />
      {href ? (
        <Link href={href} className="block no-underline text-inherit">
          {inner}
        </Link>
      ) : (
        inner
      )}
    </CRMCard>
  );
}
