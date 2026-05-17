"use client";

import { AlertTriangle, CheckCircle2, ClipboardCheck, ExternalLink } from "lucide-react";
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

// ── Progress ring SVG ─────────────────────────────────────────────────────────

function ProgressRing({
  pct,
  size = 56,
  stroke = 5,
}: {
  pct: number;
  size?: number;
  stroke?: number;
}) {
  const radius = (size - stroke * 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);

  return (
    <svg width={size} height={size} className="-rotate-90" aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        className="text-crm-border/60"
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
        className="text-crm-accent transition-[stroke-dashoffset] duration-500"
      />
    </svg>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function ChecklistProgressPanel({ checklist }: Props) {
  if (!checklist) {
    return (
      <div className={cn(crm.card, crm.cardPad, "flex flex-col gap-4")}>
        <span className={crm.label}>Progress</span>
        <div className={cn(crm.emptyWrap, "py-8")}>
          <ClipboardCheck size={20} className="mx-auto mb-2 text-crm-muted/40" />
          <p className="text-[11px] text-crm-muted">Select a checklist</p>
        </div>
      </div>
    );
  }

  const total = checklist.items.length;
  const required = checklist.items.filter((i) => i.required);
  const optional = checklist.items.filter((i) => !i.required);
  const requiredCount = required.length;
  const optionalCount = optional.length;

  // Progress percentages (based on item counts — not live completions; this is management view)
  const coveragePct = total > 0 ? Math.round((requiredCount / total) * 100) : 0;

  return (
    <div className="flex flex-col gap-3">
      {/* Summary card */}
      <div className={cn(crm.card, crm.cardPad, "flex flex-col gap-4")}>
        <span className={crm.label}>Checklist overview</span>

        {/* Progress ring + stats */}
        <div className="flex items-center gap-4">
          <div className="relative shrink-0">
            <ProgressRing pct={total === 0 ? 0 : Math.round((requiredCount / (total || 1)) * 100)} />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-base font-bold tabular-nums text-crm-text">
                {total}
              </span>
              <span className="text-[9px] text-crm-muted">steps</span>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-crm-warning" />
              <span className="text-xs text-crm-muted">
                <strong className="tabular-nums text-crm-text">{requiredCount}</strong>{" "}
                required
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-crm-border" />
              <span className="text-xs text-crm-muted">
                <strong className="tabular-nums text-crm-text">{optionalCount}</strong>{" "}
                optional
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-crm-accent" />
              <span className="text-xs text-crm-muted">
                <strong className="tabular-nums text-crm-text">{coveragePct}%</strong>{" "}
                required ratio
              </span>
            </div>
          </div>
        </div>

        {/* Status */}
        {!checklist.isActive && (
          <div
            className={cn(
              crm.bannerWarning,
              "flex items-center gap-2 rounded-crm px-3 py-2"
            )}
          >
            <AlertTriangle size={13} className="shrink-0" />
            <span className="text-xs">Archived — not shown in live call</span>
          </div>
        )}

        {checklist.isActive && requiredCount === 0 && total > 0 && (
          <div
            className={cn(
              crm.bannerWarning,
              "flex items-center gap-2 rounded-crm px-3 py-2"
            )}
          >
            <AlertTriangle size={13} className="shrink-0" />
            <span className="text-xs">
              No required steps — agents may skip all items
            </span>
          </div>
        )}

        {checklist.isActive && total === 0 && (
          <div
            className={cn(
              crm.bannerWarning,
              "flex items-center gap-2 rounded-crm px-3 py-2"
            )}
          >
            <AlertTriangle size={13} className="shrink-0" />
            <span className="text-xs">Add steps before assigning to calls</span>
          </div>
        )}

        {checklist.isActive && total > 0 && requiredCount > 0 && (
          <div
            className={cn(
              crm.bannerSuccess,
              "flex items-center gap-2 rounded-crm px-3 py-2"
            )}
          >
            <CheckCircle2 size={13} className="shrink-0" />
            <span className="text-xs">Ready for live call usage</span>
          </div>
        )}
      </div>

      {/* Required items list */}
      {required.length > 0 && (
        <div className={cn(crm.card, crm.cardPad, "flex flex-col gap-3")}>
          <span className={crm.label}>Required steps</span>
          <div className="flex flex-col gap-1.5">
            {required.map((item, i) => (
              <div
                key={item.id}
                className="flex items-start gap-2 rounded-crm border border-crm-warning/25 bg-crm-warning/5 px-2.5 py-2"
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

      {/* Quick actions */}
      <div className={cn(crm.card, crm.cardPad, "flex flex-col gap-3")}>
        <span className={crm.label}>Quick actions</span>
        <div className="flex flex-col gap-2">
          <a
            href="/crm/live-call"
            className={cn(crm.btnSecondary, "justify-start text-xs")}
          >
            <ExternalLink size={12} />
            Open live call workspace
          </a>
          <a
            href="/crm/campaigns"
            className={cn(crm.btnSecondary, "justify-start text-xs")}
          >
            <ExternalLink size={12} />
            Assign to campaign
          </a>
        </div>
      </div>
    </div>
  );
}
