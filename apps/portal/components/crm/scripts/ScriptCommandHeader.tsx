"use client";

import { FileText } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { SCRIPT_TEMPLATES } from "./ScriptTemplates";

export function ScriptCommandHeader({
  totalCount,
  activeCount,
}: {
  totalCount: number;
  activeCount: number;
}) {
  const templateCount = SCRIPT_TEMPLATES.length;

  return (
    <header className={crm.scriptsHero}>
      <div className={cn(crm.scriptsHeroGlow, "motion-reduce:hidden")} aria-hidden />
      <div
        className="pointer-events-none absolute left-8 top-8 h-24 w-24 rounded-full bg-violet-500/8 blur-2xl motion-reduce:hidden"
        aria-hidden
      />

      <div className="relative z-[1] flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
          <div className={crm.scriptsHeroIcon}>
            <FileText className="h-6 w-6" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-crm-text sm:text-2xl">
              Call Scripts
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-crm-muted">
              Sales playbooks and cold-call scripts for your outbound team.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-stretch gap-2 sm:gap-2.5">
          <KpiTile label="Total scripts" value={totalCount} sub="In library" />
          <KpiTile label="Active playbooks" value={activeCount} sub="Ready to dial" accent />
          <KpiTile label="Starter templates" value={templateCount} sub="Quick-start flows" />
        </div>
      </div>
    </header>
  );
}

function KpiTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        crm.scriptsKpiTile,
        accent && "border-crm-accent/35 shadow-[0_0_20px_-10px_rgba(56,189,248,0.25)]",
      )}
    >
      <span className="text-[10px] font-medium uppercase tracking-wider text-crm-muted">
        {label}
      </span>
      <span
        className={cn(
          "text-2xl font-bold tabular-nums leading-none",
          accent ? "text-crm-accent" : "text-crm-text",
        )}
      >
        {value}
      </span>
      <span className="text-[10px] text-crm-muted/90">{sub}</span>
    </div>
  );
}

