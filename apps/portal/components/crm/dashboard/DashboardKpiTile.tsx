"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { CRMCard } from "../CRMCard";
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
}) {
  const border =
    tone === "danger"
      ? "border-crm-danger/40"
      : tone === "warn"
        ? "border-crm-warning/40"
        : tone === "positive"
          ? "border-crm-success/35"
          : "border-crm-border";

  const valueClass =
    tone === "danger"
      ? "text-crm-danger"
      : tone === "warn"
        ? "text-crm-warning"
        : tone === "positive"
          ? "text-crm-success"
          : "text-crm-text";

  const inner = (
    <div className={cn("flex min-h-[4.75rem] flex-col gap-1.5 p-4", href && "cursor-pointer hover:bg-crm-surface-2/40")}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.65rem] font-bold uppercase tracking-wider text-crm-muted">{label}</span>
        <span className="flex text-crm-accent opacity-90">{icon}</span>
      </div>
      {loading ? (
        <div className="h-7">
          <LoadingSkeleton rows={1} />
        </div>
      ) : (
        <span className={cn("text-2xl font-bold tabular-nums leading-tight", valueClass)}>{value}</span>
      )}
      {!loading && series && series.length > 1 ? (
        <div className="mt-0.5 flex items-end justify-between gap-2">
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
            ariaLabel={`${label} — current visual placeholder`}
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
    <CRMCard padding="none" className={border}>
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
