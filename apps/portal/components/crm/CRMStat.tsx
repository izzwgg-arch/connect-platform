"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";
import { crm } from "./crmClasses";

export function CRMStat({
  label,
  value,
  emphasize,
  className,
}: {
  label: string;
  value: ReactNode;
  emphasize?: "default" | "warn" | "danger";
  className?: string;
}) {
  const valueClass =
    emphasize === "warn"
      ? "font-semibold tabular-nums text-crm-warning"
      : emphasize === "danger"
        ? "font-semibold tabular-nums text-crm-danger"
        : crm.statValue;

  return (
    <div className={cn("flex items-center gap-1.5 text-xs", className)}>
      <dt className={crm.statLabel}>{label}</dt>
      <dd className={valueClass}>{value}</dd>
    </div>
  );
}
