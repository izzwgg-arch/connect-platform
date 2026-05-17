"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";
import { CRMCard } from "./CRMCard";

/** Compact toolbar row for filters, bulk actions, or secondary controls. */
export function CRMActionBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <CRMCard padding="md" className={cn("flex flex-wrap items-center gap-3", className)}>
      {children}
    </CRMCard>
  );
}
