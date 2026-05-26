"use client";

import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  CheckSquare,
  ClipboardList,
  Copy,
  Lightbulb,
  PhoneCall,
  Plus,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { CRMRingMetric } from "../charts/CRMRingMetric";
import { SCRIPT_TEMPLATES } from "./ScriptTemplates";
import type { ScriptSummary } from "./scriptTypes";

export function ScriptOperationalSidebar({
  scripts,
  onCreate,
  onBrowseTemplates,
}: {
  scripts: ScriptSummary[];
  onCreate: () => void;
  onBrowseTemplates?: () => void;
}) {
  const active = scripts.filter((s) => s.isActive);
  const archived = scripts.filter((s) => !s.isActive);
  const total = scripts.length;
  const ringMax = Math.max(total, 1);

  return (
    <aside className={cn(crm.scriptsSideCol, "flex flex-col gap-2.5")}>
      <div className={crm.scriptsSidePanel}>
        <div className="mb-3 flex items-center gap-2">
          <span className="scripts-mini-icon scripts-mini-icon--violet">
            <BadgeCheck className="h-4 w-4" />
          </span>
          <p className="text-sm font-bold text-crm-text">Instructions</p>
        </div>
        <div className="scripts-instruction-card rounded-2xl px-3 py-3 text-sm text-crm-muted">
          Follow these steps to create, organize, and optimize call scripts that drive better conversations and results.
        </div>
        <ol className="mt-3 flex flex-col gap-3">
          {[
            ["Create a Script", "Click New Script to build from scratch or use a template."],
            ["Organize by Flow", "Use clear names so reps can find the right conversation fast."],
            ["Activate Your Playbook", "Keep high-performing scripts active for live call use."],
            ["Track & Improve", "Review and update scripts based on team feedback."],
          ].map(([title, body], index) => (
            <li key={title} className="flex gap-3">
              <span className="scripts-step-badge">{index + 1}</span>
              <span>
                <span className="block text-xs font-bold text-crm-text">{title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-crm-muted">{body}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className={cn(crm.scriptsSidePanel, "scripts-side-panel--tips")}>
        <div className="mb-3 flex items-center gap-2">
          <span className="scripts-mini-icon scripts-mini-icon--green">
            <Lightbulb className="h-4 w-4" />
          </span>
          <p className="text-sm font-bold text-crm-text">Pro Tips</p>
        </div>
        <ul className="flex flex-col gap-2 text-xs text-crm-muted">
          {[
            "Keep scripts conversational, not robotic.",
            "Personalize with the contact's name and context.",
            "Review and update scripts regularly.",
          ].map((tip) => (
            <li key={tip} className="flex items-center gap-2">
              <CheckSquare className="h-3.5 w-3.5 shrink-0 text-crm-success" />
              <span>{tip}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className={cn(crm.scriptsSidePanel, "scripts-side-panel--actions")}>
        <p className="mb-2.5 text-sm font-bold text-crm-text">Quick Actions</p>
        <div className="flex flex-col gap-1.5">
          <QuickAction icon={<Plus className="h-3.5 w-3.5" />} label="Create new script" onClick={onCreate} />
          <QuickAction
            icon={<Copy className="h-3.5 w-3.5" />}
            label="Browse templates"
            onClick={onBrowseTemplates}
            href={onBrowseTemplates ? undefined : "#script-templates"}
          />
          <QuickAction
            icon={<PhoneCall className="h-3.5 w-3.5" />}
            label="Go live in Live Call"
            href="/crm/live-call"
          />
        </div>
      </div>

      <div className={crm.scriptsSidePanel}>
        <p className="mb-2.5 text-sm font-bold text-crm-text">Workspace Actions</p>
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
        <div className="my-3 grid grid-cols-2 gap-2">
          <MetricChip label="Active" value={active.length} tone="success" />
          <MetricChip label="Templates" value={SCRIPT_TEMPLATES.length} />
        </div>
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

function QuickAction({
  icon,
  label,
  onClick,
  href,
}: {
  icon: ReactNode;
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
  icon: ReactNode;
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
