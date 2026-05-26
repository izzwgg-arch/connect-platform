"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  ExternalLink,
  Layers,
  ListChecks,
  Plus,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { cn } from "../cn";
import { crm } from "../crmClasses";

type ChecklistItem = {
  id: string;
  label: string;
  required: boolean;
};

type Checklist = {
  id: string;
  name: string;
  isActive: boolean;
  updatedAt?: string;
  items: ChecklistItem[];
};

type Props = {
  checklist: Checklist | null;
  checklists: Checklist[];
  avgRequiredPct: number;
  liveReadyCount: number;
  onNewBlank: () => void;
  onBrowseTemplates: () => void;
};

type ReadinessStatus = {
  label: string;
  hint: string;
  tone: "success" | "warning" | "muted";
};

function readinessStatus(checklist: Checklist): ReadinessStatus {
  if (!checklist.isActive) {
    return {
      label: "Archived",
      hint: "Restore to use in live calls",
      tone: "muted",
    };
  }
  if (checklist.items.length === 0) {
    return {
      label: "Needs required steps",
      hint: "Add workflow steps before going live",
      tone: "warning",
    };
  }
  const requiredCount = checklist.items.filter((i) => i.required).length;
  if (requiredCount === 0) {
    return {
      label: "Needs required steps",
      hint: "Mark key steps as required for agents",
      tone: "warning",
    };
  }
  return {
    label: "Ready for live calls",
    hint: "On track for live call workspace",
    tone: "success",
  };
}

function ProgressRing({
  requiredCount,
  total,
  size = 72,
  stroke = 6,
}: {
  requiredCount: number;
  total: number;
  size?: number;
  stroke?: number;
}) {
  const pct =
    total > 0 ? Math.round((requiredCount / total) * 100) : 0;
  const radius = (size - stroke * 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);
  const ringColor =
    pct >= 75
      ? "text-crm-warning"
      : pct >= 40
        ? "text-crm-accent"
        : "text-crm-muted";

  return (
    <svg width={size} height={size} className="-rotate-90" aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        className="text-crm-border/50"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        className={cn(ringColor, "transition-[stroke-dashoffset] duration-500")}
        style={{
          filter:
            pct > 0
              ? "drop-shadow(0 0 6px rgba(56,189,248,0.25))"
              : undefined,
        }}
      />
    </svg>
  );
}

function StatRow({
  dotClass,
  label,
  value,
  valueClass,
}: {
  dotClass: string;
  label: string;
  value: number;
  valueClass?: string;
}) {
  return (
    <div className={cn(crm.checklistInsetSurface, "flex items-center justify-between gap-2 rounded-crm border border-crm-border/40 px-2.5 py-1.5")}>
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", dotClass)} />
        <span className="text-[11px] text-crm-muted">{label}</span>
      </div>
      <span
        className={cn(
          "text-sm font-bold tabular-nums",
          valueClass ?? "text-crm-text"
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function ChecklistProgressPanel({
  checklist,
  checklists,
  avgRequiredPct,
  liveReadyCount,
  onNewBlank,
  onBrowseTemplates,
}: Props) {
  const active = checklists.filter((item) => item.isActive);
  const selectedTotal = checklist?.items.length ?? 0;
  const selectedRequired = checklist?.items.filter((item) => item.required) ?? [];
  const selectedRequiredCount = selectedRequired.length;
  const selectedOptionalCount = Math.max(0, selectedTotal - selectedRequiredCount);
  const coveragePct =
    checklist && selectedTotal > 0
      ? Math.round((selectedRequiredCount / selectedTotal) * 100)
      : avgRequiredPct;
  const status = checklist ? readinessStatus(checklist) : null;
  const recent = [...checklists]
    .sort(
      (a, b) =>
        new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime()
    )
    .slice(0, 3);

  const quality = [
    {
      label: coveragePct >= 75 ? "High completion rate" : "Completion structure improving",
      ok: coveragePct >= 75,
    },
    {
      label: active.some((item) => item.items.some((step) => step.required))
        ? "Required steps defined"
        : "Required steps needed",
      ok: active.some((item) => item.items.some((step) => step.required)),
    },
    {
      label: liveReadyCount > 0 ? "Used in live calls" : "Prepare for live calls",
      ok: liveReadyCount > 0,
    },
    {
      label: recent.length > 0 ? "Updated recently" : "No recent activity yet",
      ok: recent.length > 0,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className={crm.checklistRailCard}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-crm-text">Instructions</h2>
          <Sparkles size={14} className="text-crm-accent" />
        </div>
        <div className="rounded-[1rem] border border-violet-300/30 bg-violet-400/10 p-3 text-xs leading-relaxed text-crm-muted">
          Use checklists to guide agents through consistent conversations and
          improve outcomes.
        </div>
        <div className="mt-4 flex flex-col gap-3">
          {[
            ["Create a Checklist", "Build from scratch or use a template."],
            ["Add Workflow Steps", "Break the call flow into clear, actionable steps."],
            ["Set Required Steps", "Mark essential steps to ensure consistency."],
            ["Track & Optimize", "Monitor completion rates and improve over time."],
          ].map(([title, body], index) => (
            <div key={title} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-crm-accent/10 text-xs font-bold text-crm-accent">
                {index + 1}
              </span>
              <span>
                <span className="block text-xs font-bold text-crm-text">{title}</span>
                <span className="block text-[11px] leading-snug text-crm-muted">
                  {body}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className={crm.checklistRailCard}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-crm-text">Checklist Health</h2>
          {status && (
            <span className="text-[10px] font-semibold text-crm-muted">
              {status.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <div className="relative shrink-0">
            <div className="absolute inset-0 rounded-full bg-crm-success/12 blur-xl" aria-hidden />
            <ProgressRing
              requiredCount={coveragePct}
              total={100}
              size={86}
              stroke={7}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xl font-bold tabular-nums leading-none text-crm-text">
                {coveragePct}%
              </span>
              <span className="text-[9px] font-semibold uppercase tracking-wide text-crm-muted">
                Healthy
              </span>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <StatRow
              dotClass="bg-crm-warning"
              label="Required"
              value={selectedRequiredCount}
            />
            <StatRow
              dotClass="bg-crm-border"
              label="Optional"
              value={selectedOptionalCount}
            />
            <StatRow dotClass="bg-crm-accent" label="Active" value={active.length} />
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          {quality.map((item) => (
            <div key={item.label} className="flex items-center gap-2 text-xs">
              {item.ok ? (
                <CheckCircle2 size={13} className="shrink-0 text-crm-success" />
              ) : (
                <AlertTriangle size={13} className="shrink-0 text-crm-warning" />
              )}
              <span className="text-crm-muted">{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className={crm.checklistRailCard}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-crm-text">Recent Activity</h2>
        </div>
        {recent.length === 0 ? (
          <div className="rounded-[1rem] border border-dashed border-crm-border/45 p-4 text-center">
            <ClipboardCheck size={20} className="mx-auto mb-2 text-crm-muted/45" />
            <p className="text-xs text-crm-muted">No checklist activity yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {recent.map((item, index) => (
              <div key={item.id} className="flex items-center gap-2 rounded-[1rem] border border-crm-border/35 bg-crm-surface/65 p-2.5">
                <span className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border",
                  index === 0
                    ? "border-crm-accent/25 bg-crm-accent/10 text-crm-accent"
                    : index === 1
                      ? "border-crm-warning/25 bg-crm-warning/10 text-crm-warning"
                      : "border-violet-400/25 bg-violet-400/10 text-violet-300"
                )}>
                  <ListChecks size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-crm-text">
                    {item.name} {item.isActive ? "updated" : "archived"}
                  </span>
                  <span className="text-[10px] text-crm-muted">
                    {item.items.length} steps
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={crm.checklistRailCard}>
        <h2 className="mb-3 text-sm font-bold text-crm-text">Quick Actions</h2>
        <div className="flex flex-col gap-2">
          <button type="button" onClick={onNewBlank} className={cn(crm.btnPrimary, "justify-start text-xs")}>
            <Plus size={13} />
            Create new checklist
          </button>
          <button type="button" onClick={onBrowseTemplates} className={cn(crm.btnSecondary, "justify-between text-xs")}>
            <span className="inline-flex items-center gap-2">
              <Layers size={13} />
              Browse templates
            </span>
            <ChevronRight size={13} />
          </button>
          <Link href="/crm/live-call" className={cn(crm.btnGhost, "justify-start px-2 text-xs no-underline")}>
            <ExternalLink size={13} />
            Open live call workspace
          </Link>
        </div>
      </div>
    </div>
  );
}
