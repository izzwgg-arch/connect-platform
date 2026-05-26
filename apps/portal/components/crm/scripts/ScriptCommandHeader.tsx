"use client";

import { FileText, Layers3, LibraryBig, PlayCircle, Plus, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { SCRIPT_TEMPLATES } from "./ScriptTemplates";

export function ScriptCommandHeader({
  totalCount,
  activeCount,
  onCreate,
}: {
  totalCount: number;
  activeCount: number;
  onCreate: () => void;
}) {
  const templateCount = SCRIPT_TEMPLATES.length;

  return (
    <header className={crm.scriptsHero}>
      <div className={cn(crm.scriptsHeroGlow, "motion-reduce:hidden")} aria-hidden />
      <div
        className="pointer-events-none absolute left-8 top-8 h-24 w-24 rounded-full bg-violet-500/8 blur-2xl motion-reduce:hidden"
        aria-hidden
      />

      <div className="relative z-[1] flex flex-col gap-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
          <div className={crm.scriptsHeroIcon}>
            <FileText className="h-6 w-6" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.22em] text-crm-accent">
              Sales enablement
            </p>
            <h1 className="text-3xl font-bold tracking-tight text-crm-text sm:text-4xl">
              Call Scripts
            </h1>
            <p className="mt-2 max-w-2xl text-base leading-relaxed text-crm-muted">
              Sales playbooks and cold-call scripts for your outbound team.
            </p>
          </div>
        </div>

          <button type="button" onClick={onCreate} className={cn(crm.btnPrimary, "h-11 px-5 shadow-[0_14px_28px_-16px_rgba(2,132,199,0.55)]")}>
            <Plus className="h-4 w-4" />
            New Script
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile icon={<LibraryBig className="h-5 w-5" />} label="Total scripts" value={totalCount} sub="Script library" tone="blue" />
          <KpiTile icon={<PlayCircle className="h-5 w-5" />} label="Active playbooks" value={activeCount} sub="Ready to dial" tone="green" />
          <KpiTile icon={<Layers3 className="h-5 w-5" />} label="Starter templates" value={templateCount} sub="Built-in flows" tone="violet" />
          <KpiTile icon={<Zap className="h-5 w-5" />} label="Quick start flows" value={SCRIPT_TEMPLATES.length} sub="One-click starters" tone="amber" />
        </div>
      </div>
    </header>
  );
}

function KpiTile({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  sub: string;
  tone: "blue" | "green" | "violet" | "amber";
}) {
  return (
    <div className={cn(crm.scriptsKpiTile, `scripts-kpi-tile--${tone}`)}>
      <div className="flex items-start justify-between gap-3">
        <span className="text-[11px] font-bold uppercase tracking-wider text-crm-muted">
          {label}
        </span>
        <span className="scripts-kpi-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl">
          {icon}
        </span>
      </div>
      <div>
        <span className="block text-3xl font-bold tabular-nums leading-none text-crm-text sm:text-4xl">
          {value}
        </span>
        <span className="mt-1 block text-xs font-medium text-crm-muted/90">{sub}</span>
      </div>
    </div>
  );
}

