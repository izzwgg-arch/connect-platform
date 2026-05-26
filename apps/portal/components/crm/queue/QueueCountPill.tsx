"use client";

import type { ReactNode } from "react";
import { cn } from "../cn";
import { crm } from "../crmClasses";

export function QueueCountPill({
  label,
  count,
  active,
  urgent,
  icon,
  accent = "blue",
  microcopy,
  onClick,
  disabled,
}: {
  label: string;
  count: number | string;
  active: boolean;
  urgent?: boolean;
  icon?: ReactNode;
  accent?: "blue" | "violet" | "rose" | "green" | "cyan" | "amber";
  microcopy?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const numericCount = typeof count === "number" ? count : Number.parseFloat(count);
  const showUrgent = urgent && numericCount > 0 && !active;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        crm.queueCountPill,
        `crm-queue-kpi-${accent}`,
        "relative overflow-hidden",
        "bg-crm-surface-2",
        active && crm.queueCountPillActive,
        showUrgent && crm.queueCountPillUrgent,
        disabled && "opacity-50",
      )}
    >
      {active ? (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-crm-accent" aria-hidden />
      ) : showUrgent ? (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-crm-danger" aria-hidden />
      ) : null}
      <span className="flex w-full items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">{label}</span>
          <span
            className={cn(
              "crm-queue-kpi-value mt-1 block text-2xl font-bold tabular-nums leading-none tracking-tight",
              showUrgent ? "text-crm-danger" : active ? "text-crm-accent" : "text-crm-text",
            )}
          >
            {count}
          </span>
        </span>
        {icon ? (
          <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
            {icon}
          </span>
        ) : null}
      </span>
      <span className="crm-queue-kpi-micro text-[10px] font-medium text-crm-muted">
        {microcopy ?? "- vs yesterday"}
      </span>
    </button>
  );
}
