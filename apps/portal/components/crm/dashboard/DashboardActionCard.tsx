"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";

export function DashboardActionCard({
  href,
  icon,
  label,
  count,
  tone = "default",
}: {
  href: string;
  icon: ReactNode;
  label: string;
  count: number;
  tone?: "default" | "danger" | "warn";
}) {
  const shell =
    tone === "danger"
      ? "border-crm-danger/35 bg-crm-danger/8 hover:bg-crm-danger/12 hover:shadow-[0_8px_24px_-16px_rgba(239,68,68,0.55)]"
      : tone === "warn"
        ? "border-crm-warning/35 bg-crm-warning/8 hover:bg-crm-warning/12 hover:shadow-[0_8px_24px_-16px_rgba(245,158,11,0.55)]"
        : "border-crm-border/70 bg-crm-surface-2/45 hover:border-crm-border hover:bg-crm-surface-2";

  const dot =
    tone === "danger" ? crm.statusDotDanger : tone === "warn" ? crm.statusDotWarn : cn(crm.statusDot, "bg-crm-accent");

  return (
    <Link
      href={href}
      className={cn(
        "group flex items-center gap-3 rounded-crm border px-3 py-2.5 text-inherit no-underline transition-all duration-200 hover:-translate-y-px",
        shell,
      )}
    >
      <span className={dot} />
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/60 text-crm-accent">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-crm-text">{label}</span>
        <span className="mt-0.5 block text-[10px] font-semibold uppercase tracking-wide text-crm-muted">Needs attention</span>
      </span>
      <span
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-xs font-bold tabular-nums",
          tone === "danger"
            ? "bg-crm-danger/20 text-crm-danger"
            : tone === "warn"
              ? "bg-crm-warning/20 text-crm-warning"
              : "bg-crm-accent/15 text-crm-accent",
        )}
      >
        {count}
      </span>
      <ChevronRight size={15} className="shrink-0 text-crm-muted transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

export function DashboardListRow({
  title,
  meta,
  href,
  urgent,
}: {
  title: string;
  meta?: string;
  href: string;
  urgent?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group flex items-center gap-2 rounded-crm border px-3 py-2 text-inherit no-underline transition-all duration-200 hover:-translate-y-px",
        urgent
          ? "border-crm-danger/30 bg-crm-danger/8 hover:bg-crm-danger/12"
          : "border-crm-border/65 bg-crm-surface-2/45 hover:border-crm-border hover:bg-crm-surface-2",
      )}
    >
      <span className={urgent ? crm.statusDotDanger : cn(crm.statusDot, "bg-crm-accent/80")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-crm-text">{title}</span>
        {meta ? <span className="mt-0.5 block truncate text-xs text-crm-muted">{meta}</span> : null}
      </span>
      <ChevronRight size={15} className="shrink-0 text-crm-muted transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
