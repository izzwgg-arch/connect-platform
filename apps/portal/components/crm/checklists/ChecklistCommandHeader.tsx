"use client";
import {
  Archive,
  ClipboardList,
  FileText,
  LayoutGrid,
  List,
  type LucideIcon,
  Plus,
  Search,
  SortAsc,
} from "lucide-react";
import { cn } from "../cn";
import { CRMPageHeader } from "../CRMPageHeader";
import { CRMWorkspaceHeader, CRMWorkspaceToolbar } from "../CRMWorkspaceShell";

export type ChecklistHeaderTab = "all" | "active" | "draft" | "archived";
export type ChecklistSortMode = "updated" | "name" | "steps";
export type ChecklistViewMode = "card" | "list";

const TABS: { id: ChecklistHeaderTab; label: string }[] = [
  { id: "all", label: "All Checklists" },
  { id: "active", label: "Active" },
  { id: "draft", label: "Draft" },
  { id: "archived", label: "Archived" },
];

type Props = {
  activeCount: number;
  archivedCount: number;
  draftCount: number;
  totalCount: number;
  avgRequiredPct: number;
  liveReadyCount: number;
  tab: ChecklistHeaderTab;
  onTabChange: (tab: ChecklistHeaderTab) => void;
  search: string;
  onSearchChange: (value: string) => void;
  sortMode: ChecklistSortMode;
  onSortModeChange: (mode: ChecklistSortMode) => void;
  viewMode: ChecklistViewMode;
  onViewModeChange: (mode: ChecklistViewMode) => void;
  shownCount: number;
  onNewBlank: () => void;
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

export function ChecklistCommandHeader({
  activeCount,
  archivedCount,
  draftCount,
  totalCount,
  avgRequiredPct,
  liveReadyCount,
  tab,
  onTabChange,
  search,
  onSearchChange,
  sortMode,
  onSortModeChange,
  viewMode,
  onViewModeChange,
  shownCount,
  onNewBlank,
}: Props) {
  return (
    <>
      <CRMWorkspaceHeader>
        <CRMPageHeader
          icon={<ClipboardList className="h-5 w-5" />}
          title="Checklists"
          subtitle="Workflow checklists for agents, live calls, and campaign outreach."
          className="tasks-page-header"
          actions={
            <button type="button" onClick={onNewBlank} className="tasks-primary-action">
              <Plus size={15} />
              New Checklist
            </button>
          }
        />
      </CRMWorkspaceHeader>

      <CRMWorkspaceToolbar className="flex flex-col gap-3">
        <div className="tasks-kpi-grid grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiTile
            label="Active"
            value={String(activeCount)}
            hint={`${liveReadyCount} live-ready`}
            icon={ClipboardList}
            tone="success"
          />
          <KpiTile
            label="Draft"
            value={String(draftCount)}
            hint="Needs steps"
            icon={FileText}
            tone="warning"
          />
          <KpiTile
            label="Archived"
            value={String(archivedCount)}
            hint="Hidden from live use"
            icon={Archive}
          />
          <KpiTile
            label="Total"
            value={String(totalCount)}
            hint={`${avgRequiredPct}% avg required`}
            icon={ClipboardList}
            tone="accent"
          />
        </div>

        <div className="tasks-filter-bar flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
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
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <label className="relative min-w-0 sm:w-56">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crm-muted" />
              <input
                type="search"
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Search checklists"
                className="h-8 w-full rounded-full border border-crm-border bg-crm-surface-2 pl-8 pr-3 text-xs font-medium text-crm-text outline-none placeholder:text-crm-muted"
              />
            </label>
            <label className="tasks-sort-pill h-8">
              <SortAsc className="h-3.5 w-3.5" />
              <span className="sr-only">Sort</span>
              <select
                value={sortMode}
                onChange={(event) => onSortModeChange(event.target.value as ChecklistSortMode)}
                className="bg-transparent text-xs font-bold text-inherit outline-none [color-scheme:dark]"
              >
                <option value="updated">Sort: Updated</option>
                <option value="name">Sort: Name</option>
                <option value="steps">Sort: Steps</option>
              </select>
            </label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onViewModeChange("card")}
                className={cn("tasks-filter-icon-button", viewMode === "card" && "tasks-filter-icon-button-active")}
                title="Card View"
              >
                <LayoutGrid className="h-4 w-4" />
                <span className="sr-only">Card View</span>
              </button>
              <button
                type="button"
                onClick={() => onViewModeChange("list")}
                className={cn("tasks-filter-icon-button", viewMode === "list" && "tasks-filter-icon-button-active")}
                title="List View"
              >
                <List className="h-4 w-4" />
                <span className="sr-only">List View</span>
              </button>
            </div>
            <span className="text-xs font-medium text-crm-muted tabular-nums">
              {shownCount} shown
            </span>
          </div>
        </div>
      </CRMWorkspaceToolbar>
    </>
  );
}
