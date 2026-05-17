"use client";

import { cn } from "../cn";
import { crm } from "../crmClasses";

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
  const showUrgent = urgent && count > 0 && !active;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        crm.queueCountPill,
        "relative overflow-hidden",
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
      <span className="text-[10px] font-semibold uppercase tracking-wide text-crm-muted">{label}</span>
      <span
        className={cn(
          "text-xl font-bold tabular-nums leading-tight",
          showUrgent ? "text-crm-danger" : active ? "text-crm-accent" : "text-crm-text",
        )}
      >
        {count}
      </span>
    </button>
  );
}
