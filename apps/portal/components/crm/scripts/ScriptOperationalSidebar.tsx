"use client";

import Link from "next/link";
import {
  ArrowRight,
  CheckSquare,
  ClipboardList,
  Copy,
  FileText,
  Layers,
  PhoneCall,
  Plus,
  Zap,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { CRMRingMetric } from "../charts/CRMRingMetric";
import { SCRIPT_TEMPLATES } from "./ScriptTemplates";
import type { ScriptSummary } from "./scriptTypes";

export function ScriptOperationalSidebar({
  scripts,
  onCreate,
}: {
  scripts: ScriptSummary[];
  onCreate: () => void;
}) {
  const active = scripts.filter((s) => s.isActive);
  const archived = scripts.filter((s) => !s.isActive);
  const total = scripts.length;
  const ringMax = Math.max(total, 1);

  return (
    <aside className={cn(crm.scriptsSideCol, "flex flex-col gap-2.5")}>
      <div className={crm.scriptsSidePanel}>
        <p className={cn(crm.label, "mb-3")}>Progress overview</p>
        <CRMRingMetric
          value={active.length}
          max={ringMax}
          label="Active scripts"
          sublabel={
            archived.length > 0
              ? `${archived.length} archived · ${total} total`
              : `${total} in library`
          }
          color="var(--crm-success)"
        />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <MetricChip label="Active" value={active.length} tone="success" />
          <MetricChip label="Archived" value={archived.length} />
        </div>
      </div>

      <div className={crm.scriptsSidePanel}>
        <p className={cn(crm.label, "mb-2.5")}>Script workload</p>
        <ul className="flex flex-col gap-1.5 text-xs">
          <WorkloadRow icon={<FileText className="h-3.5 w-3.5" />} label="In library" value={total} />
          <WorkloadRow
            icon={<Layers className="h-3.5 w-3.5 text-crm-accent" />}
            label="Starter templates"
            value={SCRIPT_TEMPLATES.length}
          />
          <WorkloadRow
            icon={<CheckSquare className="h-3.5 w-3.5 text-crm-success" />}
            label="Ready to dial"
            value={active.length}
          />
        </ul>
      </div>

      <div className={crm.scriptsSidePanel}>
        <p className={cn(crm.label, "mb-2.5")}>Quick actions</p>
        <div className="flex flex-col gap-1">
          <QuickAction icon={<Plus className="h-3.5 w-3.5" />} label="Create new script" onClick={onCreate} />
          <QuickAction
            icon={<Copy className="h-3.5 w-3.5" />}
            label="Browse templates"
            href="#script-templates"
          />
          <QuickAction
            icon={<PhoneCall className="h-3.5 w-3.5" />}
            label="Go live in Live Call"
            href="/crm/live-call"
          />
        </div>
      </div>

      <div className={crm.scriptsSidePanel}>
        <p className={cn(crm.label, "mb-2.5")}>Workspace shortcuts</p>
        <div className="grid grid-cols-2 gap-2">
          <ShortcutCard href="/crm/tasks" label="Tasks" icon={<CheckSquare className="h-4 w-4" />} />
          <ShortcutCard
            href="/crm/checklists"
            label="Checklists"
            icon={<ClipboardList className="h-4 w-4" />}
          />
        </div>
        <Link href="/crm/live-call" className={cn(crm.scriptsLiveCta, "mt-3")}>
          <Zap className="h-4 w-4" />
          Live Call Workspace
        </Link>
      </div>
    </aside>
  );
}

function MetricChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success";
}) {
  return (
    <div className={cn(crm.metricTile, "min-h-[3rem]")}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-crm-muted">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-lg font-bold tabular-nums leading-none",
          tone === "success" ? "text-crm-success" : "text-crm-text",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function WorkloadRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <li className={crm.scriptsWorkloadRow}>
      <span className="flex items-center gap-2 text-crm-muted">
        {icon}
        {label}
      </span>
      <span className="font-semibold tabular-nums text-crm-text">{value}</span>
    </li>
  );
}

function QuickAction({
  icon,
  label,
  onClick,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  href?: string;
}) {
  const className =
    "scripts-quick-action flex w-full items-center justify-between gap-2 rounded-crm border border-transparent px-2 py-1.5 text-left text-xs font-medium text-crm-text transition-colors hover:border-crm-border/50";

  if (href) {
    return (
      <Link href={href} className={className}>
        <span className="flex items-center gap-2">
          {icon}
          {label}
        </span>
        <ArrowRight className="h-3 w-3 text-crm-muted" />
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className={className}>
      <span className="flex items-center gap-2">
        {icon}
        {label}
      </span>
      <ArrowRight className="h-3 w-3 text-crm-muted" />
    </button>
  );
}

function ShortcutCard({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(crm.scriptsShortcutCard, "text-crm-muted hover:text-crm-text")}
    >
      {icon}
      {label}
    </Link>
  );
}
