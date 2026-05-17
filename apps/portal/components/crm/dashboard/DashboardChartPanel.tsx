"use client";

import type { ReactNode } from "react";
import { CRMCard } from "../CRMCard";
import { DashboardSectionHeader } from "./DashboardSectionHeader";

export function DashboardChartPanel({
  title,
  action,
  children,
  footer,
}: {
  title: string;
  action?: { label: string; href: string };
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <CRMCard className="flex h-full flex-col p-5">
      <DashboardSectionHeader title={title} action={action} className="mb-4" />
      <div className="flex flex-1 flex-col gap-4 sm:flex-row sm:items-center">{children}</div>
      {footer ? <div className="mt-4 border-t border-crm-border/60 pt-3">{footer}</div> : null}
    </CRMCard>
  );
}
