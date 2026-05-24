"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  ListChecks,
} from "lucide-react";
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
  items: ChecklistItem[];
};

type Props = {
  checklist: Checklist | null;
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

export function ChecklistProgressPanel({ checklist }: Props) {
  if (!checklist) {
    return (
      <div className={cn(crm.checklistPanelSupport, crm.checklistProgressCard)}>
        <span className={crm.label}>Overall progress</span>
        <div
          className={cn(
            crm.emptyWrap,
            cn(crm.checklistInsetSurface, "mt-3 border-crm-border/40 py-8")
          )}
        >
          <ClipboardCheck
            size={22}
            className="mx-auto mb-2 text-crm-muted/40"
          />
          <p className="text-[11px] text-crm-muted">
            Select a checklist to see structure and readiness
          </p>
        </div>
      </div>
    );
  }

  const total = checklist.items.length;
  const required = checklist.items.filter((i) => i.required);
  const optional = checklist.items.filter((i) => !i.required);
  const requiredCount = required.length;
  const optionalCount = optional.length;
  const coveragePct =
    total > 0 ? Math.round((requiredCount / total) * 100) : 0;
  const status = readinessStatus(checklist);

  return (
    <div className="flex flex-col gap-2.5">
      <div className={cn(crm.checklistProgressCard, "flex flex-col gap-4")}>
        <div className="flex items-center justify-between gap-2">
          <span className={crm.label}>Overall progress</span>
          {checklist.isActive && total > 0 && requiredCount > 0 && (
            <span className="checklist-live-dot h-1.5 w-1.5 shrink-0 rounded-full bg-crm-success" />
          )}
        </div>

        <div className="flex items-center gap-4">
          <div className="relative shrink-0">
            <div
              className="absolute inset-0 rounded-full bg-crm-accent/12 blur-xl"
              aria-hidden
            />
            <ProgressRing
              requiredCount={requiredCount}
              total={total}
              size={76}
              stroke={6}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-lg font-bold tabular-nums leading-none text-crm-text">
                {coveragePct}%
              </span>
              <span className="text-[9px] uppercase tracking-wide text-crm-muted">
                required
              </span>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <StatRow
              dotClass="bg-crm-warning"
              label="Required steps"
              value={requiredCount}
              valueClass={
                requiredCount > 0 ? "text-crm-warning" : "text-crm-text"
              }
            />
            <StatRow
              dotClass="bg-crm-border"
              label="Optional steps"
              value={optionalCount}
            />
            <StatRow
              dotClass="bg-crm-accent"
              label="Total steps"
              value={total}
            />
          </div>
        </div>

        <div
          className={cn(
            "rounded-crm-lg border px-3 py-2.5",
            status.tone === "success" &&
              "border-crm-success/35 bg-gradient-to-r from-crm-success/12 to-transparent",
            status.tone === "warning" &&
              "border-crm-warning/35 bg-gradient-to-r from-crm-warning/12 to-transparent",
            status.tone === "muted" &&
              cn(crm.checklistInsetSurface, "border-crm-border/50")
          )}
        >
          <div className="flex items-center gap-2">
            {status.tone === "success" ? (
              <CheckCircle2 size={14} className="shrink-0 text-crm-success" />
            ) : (
              <AlertTriangle
                size={14}
                className={cn(
                  "shrink-0",
                  status.tone === "warning"
                    ? "text-crm-warning"
                    : "text-crm-muted"
                )}
              />
            )}
            <div className="min-w-0">
              <p className="text-xs font-semibold text-crm-text">{status.label}</p>
              <p className="text-[10px] text-crm-muted">{status.hint}</p>
            </div>
          </div>
        </div>
      </div>

      {required.length > 0 && (
        <div className={cn(crm.checklistProgressCard, "flex flex-col gap-3")}>
          <div className="flex items-center gap-2">
            <ListChecks size={12} className="text-crm-warning" />
            <span className={crm.label}>Required steps</span>
          </div>
          <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
            {required.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-2 rounded-crm border border-crm-warning/25 bg-gradient-to-r from-crm-warning/8 to-transparent px-2.5 py-2"
              >
                <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-crm-warning/40 bg-crm-warning/10 text-[9px] font-bold tabular-nums text-crm-warning">
                  {checklist.items.indexOf(item) + 1}
                </span>
                <span className="text-[11px] leading-snug text-crm-text">
                  {item.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={cn(crm.checklistPanelSupport, "p-3 flex flex-col gap-2")}>
        <span className={crm.label}>Quick actions</span>
        <a
          href="/crm/live-call"
          className={cn(crm.btnSecondary, "justify-start text-xs")}
        >
          <ExternalLink size={12} />
          Open live call workspace
        </a>
        <a
          href="/crm/campaigns"
          className={cn(crm.btnGhost, "justify-start px-2 text-xs")}
        >
          <ExternalLink size={12} />
          Assign to campaign
        </a>
      </div>
    </div>
  );
}
