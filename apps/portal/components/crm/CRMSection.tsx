"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";
import { crm } from "./crmClasses";

export function CRMSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(crm.sectionGap, className)}>
      {(title || description || actions) && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            {title ? <h2 className="text-sm font-semibold text-crm-text">{title}</h2> : null}
            {description ? <p className={cn(crm.muted, "mt-0.5")}>{description}</p> : null}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
