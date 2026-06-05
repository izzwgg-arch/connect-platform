"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";
import { crm } from "./crmClasses";
import { CRMCard } from "./CRMCard";

export function CRMPageHeader({
  icon,
  title,
  subtitle,
  actions,
  art,
  className,
  compact = false,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** Optional decorative artwork rendered absolutely behind the header content. */
  art?: ReactNode;
  className?: string;
  /** Matches CRM Contacts command header — tighter padding and type scale. */
  compact?: boolean;
}) {
  return (
    <CRMCard className={cn("mb-0", Boolean(art) && "relative overflow-hidden", className)} padding={compact ? "md" : "lg"}>
      {art ? (
        <div
          className="pointer-events-none"
          style={{ position: "absolute", inset: 0, zIndex: 0 }}
          aria-hidden
        >
          {art}
        </div>
      ) : null}
      <div
        style={{ position: "relative", zIndex: 1 }}
        className={cn(
          "flex flex-col lg:flex-row lg:justify-between",
          compact ? "gap-2.5 lg:items-center" : "gap-4 lg:items-start",
        )}
      >
        <div className={cn("flex min-w-0", compact ? "gap-2.5" : "gap-3")}>
          {icon ? (
            <div className={cn(crm.iconBox, compact && "crm-command-header-icon")}>{icon}</div>
          ) : null}
          <div className="min-w-0">
            <h1 className={compact ? crm.commandHeaderTitle : crm.title}>{title}</h1>
            {subtitle ? (
              <p className={compact ? crm.commandHeaderSubtitle : crm.subtitle}>{subtitle}</p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div> : null}
      </div>
    </CRMCard>
  );
}
