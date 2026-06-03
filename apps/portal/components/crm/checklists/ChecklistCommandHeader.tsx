"use client";
import { useEffect, useState } from "react";
import {
  BarChart3,
  ClipboardList,
  Layers,
  type LucideIcon,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { cn } from "../cn";
import { CRMPageHeader } from "../CRMPageHeader";
import { CRMWorkspaceHeader, CRMWorkspaceToolbar } from "../CRMWorkspaceShell";
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
      ? "tasks-icon-scheduled"
      : tone === "success"
        ? "tasks-icon-success"
        : tone === "warning"
          ? "tasks-icon-warning"
          : "tasks-icon-neutral";
  const valueClass =
    tone === "success"
      ? "text-crm-success"
      : tone === "warning"
        ? "text-crm-warning"
        : "text-crm-text";

  return (
    <div className="tasks-kpi-card">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-[11px] font-semibold leading-none text-crm-muted">
          {label}
        </span>
        <span
          className={cn(
            "text-3xl font-semibold leading-none tracking-tight tabular-nums",
            valueClass
          )}
        >
          {value}
        </span>
        <span className="text-xs font-medium text-crm-muted/90">{hint}</span>
      </div>
      <span className={cn("tasks-kpi-icon", toneClass)}>
        <Icon size={17} />
      </span>
    </div>
  );
}

function formatUpdatedAgo(seconds: number) {
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
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
  const checklistModeOn = liveReadyCount > 0;
  const updatedSec = Math.floor((Date.now() - mountedAt) / 1000);

  useEffect(() => {
    const id = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <CRMWorkspaceHeader>
        <CRMPageHeader
          icon={<ClipboardList className="h-5 w-5" />}
          title="Checklists"
          subtitle="Workflow checklists for agents, live calls, and campaign outreach."
          className="tasks-page-header"
          actions={
            <>
              <button type="button" onClick={onBrowseTemplates} className="tasks-secondary-action">
                <Layers size={15} />
                Browse templates
              </button>
              <button type="button" onClick={onNewBlank} className="tasks-primary-action">
                <Plus size={15} />
                New checklist
              </button>
            </>
          }
        />
      </CRMWorkspaceHeader>

      <CRMWorkspaceToolbar className="flex flex-col gap-3">
        <div className="tasks-kpi-grid grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiTile
            label="Active Checklists"
            value={String(activeCount)}
            hint={
              activeCount === 1
                ? "1 in use right now"
                : `${activeCount} in use right now`
            }
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

        <div className="tasks-filter-bar flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onTabChange(t.id)}
                className={cn(
                  "tasks-filter-pill",
                  tab === t.id && "tasks-filter-pill-active"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="text-xs font-medium text-crm-muted tabular-nums">
            Live · Updated {formatUpdatedAgo(updatedSec)}
            {archivedCount > 0 ? ` · ${archivedCount} archived` : ""}
          </span>
        </div>
      </CRMWorkspaceToolbar>
    </>
  );
}
