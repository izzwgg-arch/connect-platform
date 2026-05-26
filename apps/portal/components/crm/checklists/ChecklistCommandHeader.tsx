"use client";

import { useEffect, useState } from "react";
import {
  BarChart3,
  ClipboardList,
  Layers,
  type LucideIcon,
  Plus,
  Radio,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
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
  onBrowseTemplates: () => void;
};

function KpiTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string;
  hint: string;
  icon: LucideIcon;
  tone?: "default" | "accent" | "success" | "warning";
}) {
  const toneClass =
    tone === "accent"
      ? "checklist-kpi-blue"
      : tone === "success"
        ? "checklist-kpi-green"
        : tone === "warning"
          ? "checklist-kpi-amber"
          : "checklist-kpi-violet";

  return (
    <div
      className={cn(
        crm.checklistKpiTile,
        toneClass,
        "relative flex min-h-[7.25rem] min-w-0 flex-col justify-between gap-3 overflow-hidden p-4"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="checklist-kpi-icon flex h-10 w-10 items-center justify-center rounded-xl border">
          <Icon size={17} />
        </span>
        <span className="checklist-kpi-sparkline mt-2 h-5 w-14" aria-hidden />
      </div>
      <div>
        <span className="block text-[11px] font-bold tracking-tight text-crm-text">
          {label}
        </span>
        <span className="mt-1 block text-2xl font-bold tabular-nums leading-none text-crm-text">
          {value}
        </span>
        <span className="mt-1 block text-[10px] text-crm-muted">{hint}</span>
      </div>
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
  onBrowseTemplates,
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

      <div className="relative z-[1] flex flex-col gap-5 p-4 sm:p-5 lg:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 gap-4">
            <span className={crm.checklistCommandIcon}>
              <ClipboardList size={24} />
            </span>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-tight text-crm-text sm:text-3xl">
                Checklists
              </h1>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-crm-muted">
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

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onBrowseTemplates}
              className={cn(crm.btnSecondary, "shrink-0")}
            >
              <Layers size={15} />
              Browse templates
            </button>
            <button type="button" onClick={onNewBlank} className={cn(crm.btnPrimary, "shrink-0")}>
              <Plus size={15} />
              New checklist
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiTile
            label="Active Checklists"
            value={String(activeCount)}
            hint={activeCount === 1 ? "1 in use right now" : `${activeCount} in use right now`}
            icon={ClipboardList}
            tone="accent"
          />
          <KpiTile
            label="Templates"
            value={String(CHECKLIST_TEMPLATES.length)}
            hint="Playbooks available"
            icon={Layers}
          />
          <KpiTile
            label="Completion Rate"
            value={`${avgRequiredPct}%`}
            hint="Avg required ratio"
            icon={BarChart3}
            tone="warning"
          />
          <KpiTile
            label="Live Mode"
            value={checklistModeOn ? "ON" : "OFF"}
            hint={
              checklistModeOn
                ? `${liveReadyCount} live-ready`
                : "Add required steps"
            }
            icon={ShieldCheck}
            tone={checklistModeOn ? "success" : "default"}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-crm-border/40 pt-3">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-crm-muted">
            <Sparkles size={12} className="text-crm-accent" />
            Command center
          </span>
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
