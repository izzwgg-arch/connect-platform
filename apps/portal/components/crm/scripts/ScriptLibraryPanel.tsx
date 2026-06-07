"use client";

import {
  Archive,
  Check,
  ChevronRight,
  Clock,
  FileText,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { ScriptStatusFilter } from "./ScriptCommandHeader";
import type { ScriptSummary } from "./scriptTypes";

interface ScriptLibraryPanelProps {
  scripts: ScriptSummary[];
  totalCount: number;
  selectedId: string | null;
  /** Increment after a successful create so search/status filters reset. */
  resetFiltersToken?: number;
  activeFilter: ScriptStatusFilter;
  search: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

function relativeDate(iso: string | null | undefined): string {
  if (!iso) return "No activity";
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "No activity";
  const diff = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return minutes <= 1 ? "just now" : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function scriptStatus(script: ScriptSummary) {
  return script.isActive ? "Active" : "Archived";
}

function scriptReadiness(script: ScriptSummary) {
  if (!script.isActive) {
    return {
      label: "Archived",
      detail: "Hidden from active call workflows",
      percent: 0,
      tone: "muted" as const,
    };
  }

  return {
    label: "Ready",
    detail: "Available to reps in live call workflows",
    percent: 100,
    tone: "success" as const,
  };
}

export function ScriptLibraryPanel({
  scripts,
  totalCount,
  selectedId,
  activeFilter,
  search,
  onSelect,
  onCreate,
}: ScriptLibraryPanelProps) {
  return (
    <ScriptCollection
      scripts={scripts}
      totalCount={totalCount}
      selectedId={selectedId}
      activeFilter={activeFilter}
      search={search}
      onSelect={onSelect}
      onCreate={onCreate}
    />
  );
}

function ScriptEmptyState({
  activeFilter,
  search,
  onCreate,
}: {
  activeFilter: ScriptStatusFilter;
  search: string;
  onCreate: () => void;
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
          : "Create a script when you are ready to define a reusable talk track."}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={onCreate} className="tasks-primary-action crm-create-blue-cta">
          Create New Script
        </button>
      </div>
    </div>
  );
}

function ScriptCollection({
  scripts,
  totalCount,
  selectedId,
  activeFilter,
  search,
  onSelect,
  onCreate,
}: {
  scripts: ScriptSummary[];
  totalCount: number;
  selectedId: string | null;
  activeFilter: ScriptStatusFilter;
  search: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  if (scripts.length === 0) {
    return <ScriptEmptyState activeFilter={activeFilter} search={search} onCreate={onCreate} />;
  }

  return (
    <section className="script-collection-shell crm-queue-list-panel">
      <div className="crm-queue-list-head">
        <div className="flex items-center gap-2">
          <FileText className="h-3.5 w-3.5 text-crm-muted" />
          <h2>Script rows</h2>
        </div>
        <span className="text-[10px] font-semibold text-crm-muted tabular-nums">
          {scripts.length} shown · {totalCount} total
        </span>
      </div>

      <div className="crm-queue-row-list">
        {scripts.map((script, index) => (
          <ScriptIndexRow
            key={script.id}
            script={script}
            rank={index + 1}
            selected={selectedId === script.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

function ScriptIndexRow({
  script,
  rank,
  selected,
  onSelect,
}: {
  script: ScriptSummary;
  rank: number;
  selected?: boolean;
  onSelect: (id: string) => void;
}) {
  const status = scriptStatus(script);
  const readiness = scriptReadiness(script);
  const updatedLabel = relativeDate(script.updatedAt);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(script.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(script.id);
        }
      }}
      className={cn(
        "crm-queue-row crm-script-row group",
        selected && "crm-queue-row-selected scripts-index-row-active",
        !script.isActive && "crm-queue-row-readonly opacity-90"
      )}
    >
      <div className="crm-queue-row-grid">
        <label
          className="crm-contact-row-check"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Select ${script.name}`}
        >
          <input
            type="checkbox"
            readOnly
            checked={selected}
            className={crm.checkbox}
          />
        </label>
        <span className="crm-queue-row-rank tabular-nums">{rank}</span>

        <div className="crm-queue-row-avatar script-row-avatar" aria-hidden>
          {script.isActive ? <FileText className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
        </div>

        <div className="crm-queue-row-main min-w-0">
          <div className="crm-queue-row-title-line">
            <span className="crm-queue-row-name truncate">{script.name}</span>
            <span className={cn("crm-queue-pill", script.isActive ? "crm-queue-pill-stage" : "crm-queue-pill-warning")}>
              {status}
            </span>
            <span
              className={cn(
                "tasks-status-pill",
                script.isActive ? "tasks-status-completed" : "tasks-status-muted"
              )}
            >
              {readiness.label}
            </span>
            {script.isDefault ? (
              <span className="crm-queue-pill crm-queue-pill-stage">Default</span>
            ) : null}
          </div>
          <p className="crm-queue-row-sub truncate">{readiness.detail}</p>
        </div>

        <div className="crm-queue-row-phone hidden md:flex">
          <FileText className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Script</span>
        </div>

        <div className="crm-queue-row-email hidden lg:flex">
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{script.isActive ? "Ready to use" : "Archived"}</span>
        </div>

        <div className="crm-queue-row-meta hidden xl:flex">
          <span className="crm-queue-pill crm-queue-pill-muted inline-flex items-center gap-0.5">
            <Clock className="h-3 w-3" />
            {updatedLabel}
          </span>
        </div>

        <span
          className={cn(
            "crm-queue-row-status shrink-0 tasks-status-pill",
            script.isActive ? "tasks-status-completed" : "tasks-status-muted"
          )}
        >
          {readiness.percent}%
        </span>

        <ChevronRight className="crm-queue-row-chevron h-4 w-4 shrink-0" />
      </div>
    </div>
  );
}
