"use client";

import { useEffect, useState } from "react";
import { ClipboardList, Plus, Radio } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { CHECKLIST_TEMPLATES } from "./ChecklistTemplates";

export type ChecklistHeaderTab = "active" | "templates" | "progress";

const TABS: { id: ChecklistHeaderTab; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "templates", label: "Templates" },
  { id: "progress", label: "Progress" },
];

type Props = {
  activeCount: number;
  archivedCount: number;
  avgRequiredPct: number;
  liveReadyCount: number;
  tab: ChecklistHeaderTab;
  onTabChange: (tab: ChecklistHeaderTab) => void;
  onNewBlank: () => void;
};

function KpiTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "accent" | "success" | "warning";
}) {
  const toneClass =
    tone === "accent"
      ? "border-crm-accent/35 bg-crm-accent/8"
      : tone === "success"
        ? "border-crm-success/35 bg-crm-success/8"
        : tone === "warning"
          ? "border-crm-warning/35 bg-crm-warning/8"
          : "border-crm-border/35 bg-[#0a101c]/60";

  return (
    <div
      className={cn(
        crm.checklistKpiTile,
        toneClass,
        "flex min-w-[6.5rem] flex-1 flex-col gap-0.5"
      )}
    >
      <span className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">
        {label}
      </span>
      <span className="text-lg font-bold tabular-nums leading-none text-crm-text">
        {value}
      </span>
      <span className="text-[10px] text-crm-muted">{hint}</span>
    </div>
  );
}

function formatUpdatedAgo(seconds: number) {
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  return `${m}m ago`;
}

export function ChecklistCommandHeader({
  activeCount,
  archivedCount,
  avgRequiredPct,
  liveReadyCount,
  tab,
  onTabChange,
  onNewBlank,
}: Props) {
  const [, setTick] = useState(0);
  const [mountedAt] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const updatedSec = Math.floor((Date.now() - mountedAt) / 1000);
  const checklistModeOn = liveReadyCount > 0;

  return (
    <div className={crm.checklistCommandHeader}>
      <div className={crm.checklistCommandHeaderGlow} aria-hidden />

      <div className="relative z-[1] flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 gap-3">
            <span className={crm.checklistCommandIcon}>
              <ClipboardList size={20} />
            </span>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight text-crm-text sm:text-xl">
                Checklists
              </h1>
              <p className="mt-0.5 max-w-xl text-sm text-crm-muted">
                Workflow checklists for agents — used during live calls and
                campaign outreach.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-crm-success/35 bg-crm-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-crm-success">
                  <Radio size={10} className="checklist-live-dot" />
                  Live
                </span>
                <span className="text-[11px] text-crm-muted tabular-nums">
                  Updated {formatUpdatedAgo(updatedSec)}
                </span>
                {archivedCount > 0 && (
                  <span className="text-[11px] text-crm-muted">
                    · {archivedCount} archived
                  </span>
                )}
              </div>
            </div>
          </div>

          <button type="button" onClick={onNewBlank} className={cn(crm.btnPrimary, "shrink-0")}>
            <Plus size={15} />
            New checklist
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <KpiTile
            label="Active checklists"
            value={String(activeCount)}
            hint="In use"
            tone="accent"
          />
          <KpiTile
            label="Templates"
            value={String(CHECKLIST_TEMPLATES.length)}
            hint="Playbooks"
          />
          <KpiTile
            label="Completion"
            value={`${avgRequiredPct}%`}
            hint="Avg required ratio"
            tone="warning"
          />
          <KpiTile
            label="Checklist mode"
            value={checklistModeOn ? "ON" : "OFF"}
            hint={
              checklistModeOn
                ? `${liveReadyCount} live-ready`
                : "Add required steps"
            }
            tone={checklistModeOn ? "success" : "default"}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1 border-t border-crm-border/40 pt-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onTabChange(t.id)}
              className={cn(
                crm.checklistTab,
                tab === t.id && crm.checklistTabActive
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
