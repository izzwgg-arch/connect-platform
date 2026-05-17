"use client";

import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { CRMCard } from "../CRMCard";
import type { HeroTone } from "./reportsTypes";

const toneConfig: Record<
  HeroTone,
  { border: string; value: string; badge: string; glow: string }
> = {
  healthy: {
    border: "border-crm-success/35",
    value: "text-crm-success",
    badge: "border-crm-success/30 bg-crm-success/10 text-crm-success",
    glow: "shadow-[0_0_28px_-8px_rgba(52,211,153,0.20)]",
  },
  warn: {
    border: "border-crm-warning/40",
    value: "text-crm-warning",
    badge: "border-crm-warning/30 bg-crm-warning/10 text-crm-warning",
    glow: "shadow-[0_0_28px_-8px_rgba(251,191,36,0.20)]",
  },
  danger: {
    border: "border-crm-danger/40",
    value: "text-crm-danger",
    badge: "border-crm-danger/30 bg-crm-danger/10 text-crm-danger",
    glow: "shadow-[0_0_28px_-8px_rgba(234,96,104,0.22)]",
  },
  neutral: {
    border: "border-crm-border",
    value: "text-crm-text",
    badge: "border-crm-border/70 bg-crm-surface-2 text-crm-muted",
    glow: "",
  },
};

export function ReportsHeroCard({
  label,
  value,
  sublabel,
  statusMessage,
  tone = "neutral",
  trend,
  icon,
  visualSlot,
}: {
  label: string;
  value: string | number;
  sublabel?: string;
  statusMessage?: string;
  tone?: HeroTone;
  trend?: "up" | "down" | "flat";
  icon: ReactNode;
  visualSlot?: ReactNode;
}) {
  const t = toneConfig[tone];
  const TrendIcon =
    trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;

  return (
    <CRMCard
      padding="none"
      className={cn("flex flex-col gap-0 overflow-hidden", t.border, t.glow)}
    >
      <div className="flex items-start justify-between gap-2 px-4 pt-4 pb-1">
        <span className="text-[0.65rem] font-bold uppercase tracking-wider text-crm-muted">
          {label}
        </span>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-crm bg-crm-surface-2/80 text-crm-muted">
          {icon}
        </span>
      </div>

      <div className="flex items-end gap-2 px-4 pb-1.5">
        <span className={cn("text-3xl font-bold tabular-nums leading-none", t.value)}>
          {value}
        </span>
        {trend && (
          <TrendIcon
            className={cn(
              "mb-0.5 h-4 w-4 shrink-0",
              tone === "healthy"
                ? "text-crm-success"
                : tone === "warn"
                  ? "text-crm-warning"
                  : tone === "danger"
                    ? "text-crm-danger"
                    : "text-crm-muted",
            )}
            aria-hidden
          />
        )}
      </div>

      {sublabel && (
        <p className="px-4 pb-1 text-xs text-crm-muted">{sublabel}</p>
      )}

      {visualSlot && (
        <div className="px-4 pb-3 pt-1">{visualSlot}</div>
      )}

      {statusMessage && (
        <div
          className={cn(
            "mx-3 mb-3 rounded-crm border px-2.5 py-1.5 text-[11px] font-medium leading-snug",
            t.badge,
          )}
        >
          {statusMessage}
        </div>
      )}
    </CRMCard>
  );
}
