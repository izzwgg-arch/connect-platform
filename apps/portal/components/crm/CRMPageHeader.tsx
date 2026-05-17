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
  className,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <CRMCard className={cn("mb-0", className)}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 gap-3">
          {icon ? <div className={crm.iconBox}>{icon}</div> : null}
          <div className="min-w-0">
            <h1 className={crm.title}>{title}</h1>
            {subtitle ? <p className={crm.subtitle}>{subtitle}</p> : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div> : null}
      </div>
    </CRMCard>
  );
}
