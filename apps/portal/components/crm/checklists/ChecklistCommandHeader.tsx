"use client";
import {
  Archive,
  ClipboardList,
  FileText,
  type LucideIcon,
  Plus,
  Search,
  SortAsc,
} from "lucide-react";
import { cn } from "../cn";
import { ConnectSelect } from "../../ConnectSelect";
import { CRMPageHeader } from "../CRMPageHeader";
import { CRMWorkspaceHeader, CRMWorkspaceToolbar } from "../CRMWorkspaceShell";
import { crm } from "../crmClasses";

export type ChecklistHeaderTab = "all" | "active" | "draft" | "archived";
export type ChecklistSortMode = "updated" | "name" | "steps";

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
  shownCount: number;
  onNewBlank: () => void;
};

function KpiTile({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  icon: LucideIcon;
  tone: "blue" | "green" | "violet" | "amber" | "rose" | "cyan";
}) {
  return (
    <div className={cn(crm.queueCountPill, `crm-queue-kpi-${tone}`, "relative overflow-hidden bg-crm-surface-2")}>
      <span className="flex w-full items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">
            {label}
          </span>
          <span className="crm-queue-kpi-value mt-1 block text-2xl font-bold tabular-nums leading-none tracking-tight text-crm-text">
            {value}
          </span>
        </span>
        <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
          <Icon className="h-4 w-4" />
        </span>
      </span>
      <span className="crm-queue-kpi-micro text-[10px] font-medium text-crm-muted">{hint}</span>
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
  shownCount,
  onNewBlank,
}: Props) {
  return (
    <>
      <CRMWorkspaceHeader>
        <CRMPageHeader
          compact
          icon={<ClipboardList className="h-6 w-6" aria-hidden />}
          title="Checklists"
          subtitle="Workflow checklists for agents, live calls, and campaign outreach."
          className={cn(crm.contactsHeaderPanel, "campaigns-command-header")}
          actions={
            <div className="campaigns-hero-actions">
              <button type="button" onClick={onNewBlank} className="campaigns-btn-primary">
                <Plus className="h-4 w-4" />
                New Checklist
              </button>
            </div>
          }
        />
      </CRMWorkspaceHeader>

      <CRMWorkspaceToolbar className="flex flex-col gap-3">
        <section className="crm-queue-kpi-strip grid w-full grid-cols-2 items-stretch gap-3 md:grid-cols-4 xl:grid-cols-4" aria-label="Checklist metrics">
          <KpiTile
            label="Total"
            value={String(totalCount)}
            hint={`${avgRequiredPct}% avg required`}
            icon={ClipboardList}
            tone="blue"
          />
          <KpiTile
            label="Active"
            value={String(activeCount)}
            hint={`${liveReadyCount} live-ready`}
            icon={ClipboardList}
            tone="green"
          />
          <KpiTile
            label="Draft"
            value={String(draftCount)}
            hint="Needs steps"
            icon={FileText}
            tone="amber"
          />
          <KpiTile
            label="Archived"
            value={String(archivedCount)}
            hint="Hidden from live use"
            icon={Archive}
            tone="violet"
          />
        </section>

        <div className="crm-queue-filter-bar tasks-filter-bar">
          <div className="crm-queue-filter-grid checklist-filter-grid">
            <div className="crm-queue-filter-field crm-queue-filter-field-search">
              <Search className="crm-queue-filter-icon h-4 w-4 shrink-0 text-crm-muted" />
              <input
                id="crm-checklists-search"
                type="search"
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Name, description, workflow..."
                className="crm-queue-filter-control min-w-[10rem] flex-1"
                aria-label="Search checklists"
              />
              {search ? (
                <button type="button" onClick={() => onSearchChange("")} className="text-xs font-medium text-crm-accent hover:underline">
                  Clear
                </button>
              ) : null}
            </div>

            <div className="crm-queue-filter-field">
              <label htmlFor="crm-checklists-status" className="sr-only">Status</label>
              <ConnectSelect
                id="crm-checklists-status"
                value={tab}
                onChange={(value) => onTabChange(value as ChecklistHeaderTab)}
                options={TABS.map((t) => ({ value: t.id, label: t.label }))}
                className="min-w-[10rem] flex-1"
                size="sm"
              />
            </div>

            <div className="crm-queue-filter-field">
              <SortAsc className="h-4 w-4 shrink-0 text-crm-muted" />
              <label htmlFor="crm-checklists-sort" className="sr-only">Sort</label>
              <ConnectSelect
                id="crm-checklists-sort"
                value={sortMode}
                onChange={(value) => onSortModeChange(value as ChecklistSortMode)}
                options={[
                  { value: "updated", label: "Updated" },
                  { value: "name", label: "Name" },
                  { value: "steps", label: "Steps" },
                ]}
                className="min-w-[10rem] flex-1"
                size="sm"
              />
            </div>

            <div className="crm-queue-filter-field checklist-filter-count">
              <span
                className="crm-queue-filter-control checklist-filter-count-value"
                aria-label={`${shownCount} checklists shown`}
              >
                {shownCount}
              </span>
            </div>
          </div>
        </div>
      </CRMWorkspaceToolbar>
    </>
  );
}
