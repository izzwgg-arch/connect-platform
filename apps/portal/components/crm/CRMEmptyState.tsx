"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";
import { crm } from "./crmClasses";

export function CRMEmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(crm.emptyWrap, className)}>
      {icon ? <div className="mx-auto mb-3 flex justify-center text-crm-muted">{icon}</div> : null}
      <p className={crm.emptyTitle}>{title}</p>
      {description ? <p className={crm.emptyBody}>{description}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
