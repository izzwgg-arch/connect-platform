"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";

export function DashboardSectionHeader({
  title,
  action,
  className,
}: {
  title: string;
  action?: { label: string; href: string };
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-center justify-between gap-3", className)}>
      <h2 className="text-sm font-semibold tracking-tight text-crm-text">{title}</h2>
      {action ? (
        <Link
          href={action.href}
          className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-crm-accent hover:brightness-110"
        >
          {action.label}
          <ArrowRight size={13} />
        </Link>
      ) : null}
    </div>
  );
}

export function DashboardPanelLabel({ children }: { children: ReactNode }) {
  return <p className={cn(crm.label, "mb-3")}>{children}</p>;
}
