"use client";

import { cn } from "../cn";

export function QueueCountPill({
  label,
  count,
  active,
  urgent,
  onClick,
  disabled,
}: {
  label: string;
  count: number;
  active: boolean;
  urgent?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex min-w-[4.5rem] flex-col items-start rounded-crm border px-2.5 py-2 text-left transition-colors disabled:opacity-50",
        active
          ? "border-crm-accent/40 bg-crm-surface shadow-crm ring-1 ring-crm-accent/20"
          : "border-crm-border bg-crm-bg/80 hover:border-crm-border hover:bg-crm-surface",
      )}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide text-crm-muted">{label}</span>
      <span className={cn("text-lg font-bold tabular-nums", urgent && count > 0 ? "text-crm-danger" : "text-crm-text")}>
        {count}
      </span>
    </button>
  );
}
