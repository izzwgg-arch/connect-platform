"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../cn";

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
      ? "border-crm-danger/35 bg-crm-danger/8 hover:bg-crm-danger/12"
      : tone === "warn"
        ? "border-crm-warning/35 bg-crm-warning/8 hover:bg-crm-warning/12"
        : "border-crm-border bg-crm-surface-2/60 hover:bg-crm-surface-2";

  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 rounded-crm border px-3 py-2.5 text-inherit no-underline transition-colors",
        shell,
      )}
    >
      <span className="flex shrink-0 text-crm-accent">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-crm-text">{label}</span>
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
      <ChevronRight size={15} className="shrink-0 text-crm-muted" />
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
        "flex items-center gap-2 rounded-crm border px-3 py-2 text-inherit no-underline transition-colors",
        urgent
          ? "border-crm-danger/30 bg-crm-danger/8 hover:bg-crm-danger/12"
          : "border-crm-border bg-crm-surface-2/50 hover:bg-crm-surface-2",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-crm-text">{title}</span>
        {meta ? <span className="mt-0.5 block truncate text-xs text-crm-muted">{meta}</span> : null}
      </span>
      <ChevronRight size={15} className="shrink-0 text-crm-muted" />
    </Link>
  );
}
