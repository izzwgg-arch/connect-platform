"use client";

import {
  Archive,
  ChevronRight,
  Clock,
  FileText,
  RotateCcw,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { ScriptStatusFilter, ScriptViewMode } from "./ScriptCommandHeader";
import type { ScriptSummary } from "./scriptTypes";

interface ScriptLibraryPanelProps {
  scripts: ScriptSummary[];
  totalCount: number;
  selectedId: string | null;
  /** Increment after a successful create so search/status filters reset. */
  resetFiltersToken?: number;
  viewMode: ScriptViewMode;
  activeFilter: ScriptStatusFilter;
  search: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function scriptStatus(script: ScriptSummary) {
  return script.isActive ? "Active" : "Archived";
}

export function ScriptLibraryPanel({
  scripts,
  totalCount,
  selectedId,
  viewMode,
  activeFilter,
  search,
  onSelect,
  onCreate,
}: ScriptLibraryPanelProps) {
  return (
    <div className={cn(crm.scriptsLibraryCol, "min-h-0 flex-1")}>
      <div className={cn(crm.scriptsPanelSupport, "flex min-h-0 flex-1 flex-col overflow-hidden")}>
        <ScriptCollection
          scripts={scripts}
          totalCount={totalCount}
          selectedId={selectedId}
          viewMode={viewMode}
          activeFilter={activeFilter}
          search={search}
          onSelect={onSelect}
          onCreate={onCreate}
        />
      </div>
    </div>
  );
}

function ScriptEmptyState({
  activeFilter,
  search,
}: {
  activeFilter: ScriptStatusFilter;
  search: string;
}) {
  const filtered = activeFilter !== "all" || search.trim().length > 0;

  return (
    <div className="tasks-empty-state">
      <div className="tasks-empty-icon text-crm-accent">
        <FileText className="h-9 w-9" />
      </div>
      <p className="text-lg font-semibold tracking-tight text-crm-text">
        {filtered ? "No scripts match" : "No scripts yet"}
      </p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-crm-muted">
        {filtered
          ? "Adjust the filters or search to see more scripts."
          : "Create a script from the New Script button when you are ready."}
      </p>
    </div>
  );
}

function ScriptCollection({
  scripts,
  totalCount,
  selectedId,
  viewMode,
  activeFilter,
  search,
  onSelect,
}: {
  scripts: ScriptSummary[];
  totalCount: number;
  selectedId: string | null;
  viewMode: ScriptViewMode;
  activeFilter: ScriptStatusFilter;
  search: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  if (scripts.length === 0) {
    return <ScriptEmptyState activeFilter={activeFilter} search={search} />;
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="tasks-list-card-header flex items-center justify-between gap-3 px-4 py-4 sm:px-5">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-crm-muted" />
          <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-crm-text">
            Scripts ({scripts.length})
          </h2>
        </div>
        <span className="text-xs font-medium text-crm-muted tabular-nums">
          {totalCount} total
        </span>
      </div>

      <div className={cn(crm.workspaceScrollRegion, viewMode === "card" ? "p-3 sm:p-4" : "")}>
        {viewMode === "list" ? (
          <>
            <div className="hidden border-b border-crm-border/55 px-5 py-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-crm-muted md:grid md:grid-cols-[minmax(0,1fr)_auto_auto_auto] md:items-center md:gap-4">
              <span>Script</span>
              <span>Status</span>
              <span>Updated</span>
              <span>Action</span>
            </div>
            <div className="divide-y divide-crm-border/55">
              {scripts.map((script) => (
                <ScriptListItem
                  key={script.id}
                  script={script}
                  isSelected={selectedId === script.id}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {scripts.map((script) => (
              <ScriptCard
                key={script.id}
                script={script}
                isSelected={selectedId === script.id}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ScriptCard({
  script,
  isSelected,
  onSelect,
}: {
  script: ScriptSummary;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const status = scriptStatus(script);

  return (
    <button
      type="button"
      onClick={() => onSelect(script.id)}
      className={cn(
        "tasks-list-row rounded-crm border border-crm-border/60 p-4 text-left transition-colors",
        isSelected && "border-crm-accent/45 bg-crm-accent/10 ring-1 ring-crm-accent/25",
        !script.isActive && "opacity-70"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className={cn("tasks-kpi-icon", script.isActive ? "tasks-icon-scheduled" : "tasks-icon-neutral")}>
            {script.isActive ? <FileText className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-crm-text">
              {script.name}
            </span>
            <span className="mt-1 block text-xs text-crm-muted">
              Updated {relativeTime(script.updatedAt)}
            </span>
          </span>
        </div>
        <span className={cn("tasks-status-pill", script.isActive ? "tasks-status-completed" : "tasks-status-muted")}>
          {status}
        </span>
      </div>
    </button>
  );
}

function ScriptListItem({
  script,
  isSelected,
  onSelect,
}: {
  script: ScriptSummary;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const status = scriptStatus(script);

  return (
    <button
      type="button"
      onClick={() => onSelect(script.id)}
      className={cn(
        "tasks-list-row grid w-full grid-cols-1 gap-2 px-4 py-4 text-left md:grid-cols-[minmax(0,1fr)_auto_auto_auto] md:items-center md:gap-4 sm:px-5",
        isSelected && crm.scriptCardActive,
        !script.isActive && crm.scriptCardArchived,
      )}
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className={cn("tasks-kpi-icon", script.isActive ? "tasks-icon-scheduled" : "tasks-icon-neutral")}>
          {script.isActive ? <FileText className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
        </span>
        <span className="min-w-0">
          <span className={cn("block truncate text-sm font-semibold", isSelected ? "text-crm-accent" : "text-crm-text")}>
            {script.name}
          </span>
          <span className="mt-1 flex items-center gap-1.5 text-xs text-crm-muted">
            <Clock className="h-3.5 w-3.5" />
            Updated {relativeTime(script.updatedAt)}
          </span>
        </span>
      </span>
      <span
        className={cn(
          "tasks-status-pill w-fit",
          script.isActive ? "tasks-status-completed" : "tasks-status-muted"
        )}
      >
        {status}
      </span>
      <span className="text-sm font-medium text-crm-muted">{relativeTime(script.updatedAt)}</span>
      <span className="flex items-center justify-end pr-1 text-crm-muted">
        {script.isActive ? <ChevronRight className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
      </span>
    </button>
  );
}
