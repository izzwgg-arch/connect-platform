"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";
import { crm } from "./crmClasses";

export function CRMPageShell({
  children,
  className,
  innerClassName,
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
}) {
  return (
    <div className={cn(crm.page, className)}>
      <div className={cn(crm.pageInner, innerClassName)}>{children}</div>
    </div>
  );
}
