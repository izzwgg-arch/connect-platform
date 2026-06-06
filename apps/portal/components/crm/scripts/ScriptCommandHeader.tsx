"use client";

import {
  Archive,
  FileText,
  LibraryBig,
  PlayCircle,
  Plus,
  Search,
  SortAsc,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { ConnectSelect } from "../../ConnectSelect";
import { CRMPageHeader } from "../CRMPageHeader";
import { CRMWorkspaceHeader, CRMWorkspaceToolbar } from "../CRMWorkspaceShell";
import { crm } from "../crmClasses";

export type ScriptStatusFilter = "all" | "active" | "draft" | "archived";
export type ScriptSortMode = "updated" | "created" | "name";

const TABS: { id: ScriptStatusFilter; label: string }[] = [
  { id: "all", label: "All Scripts" },
  { id: "active", label: "Active" },
  { id: "draft", label: "Draft" },
  { id: "archived", label: "Archived" },
];

export function ScriptCommandHeader({
  totalCount,
  activeCount,
  draftCount,
  archivedCount,
  statusFilter,
  onStatusFilterChange,
  search,
  onSearchChange,
  sortMode,
  onSortModeChange,
  shownCount,
  onCreate,
}: {
  totalCount: number;
  activeCount: number;
  draftCount: number;
  archivedCount: number;
  statusFilter: ScriptStatusFilter;
  onStatusFilterChange: (filter: ScriptStatusFilter) => void;
  search: string;
  onSearchChange: (value: string) => void;
  sortMode: ScriptSortMode;
  onSortModeChange: (mode: ScriptSortMode) => void;
  shownCount: number;
  onCreate: () => void;
}) {
  return (
    <>
      <CRMWorkspaceHeader>
        <CRMPageHeader
          compact
          icon={<FileText className="h-5 w-5" />}
          title="Scripts"
          subtitle="Sales playbooks and cold-call scripts for your outbound team."
          className={cn("tasks-page-header", crm.contactsHeaderPanel)}
          actions={
            <div className="contacts-hero-actions flex flex-wrap items-center gap-2">
              <button type="button" onClick={onCreate} className="tasks-primary-action">
                <Plus className="h-4 w-4" />
                New Script
              </button>
            </div>
          }
        />
      </CRMWorkspaceHeader>

      <CRMWorkspaceToolbar className="flex flex-col gap-3">
        <div className="crm-queue-kpi-strip tasks-kpi-grid grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            icon={<PlayCircle className="h-5 w-5" />}
            label="Active"
            value={activeCount}
            sub="Ready to dial"
            tone="success"
          />
          <KpiTile
            icon={<FileText className="h-5 w-5" />}
            label="Draft"
            value={draftCount}
            sub="Pending publish"
            tone="warning"
          />
          <KpiTile
            icon={<Archive className="h-5 w-5" />}
            label="Archived"
            value={archivedCount}
            sub="Hidden from use"
            tone="scheduled"
          />
          <KpiTile
            icon={<LibraryBig className="h-5 w-5" />}
            label="Total"
            value={totalCount}
            sub="Scripts required"
            tone="neutral"
          />
        </div>

        <div className="crm-queue-filter-bar tasks-filter-bar flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => onStatusFilterChange(tab.id)}
                className={cn(
                  "tasks-filter-pill",
                  statusFilter === tab.id && "tasks-filter-pill-active"
                )}
              >
                {tab.label}
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
                placeholder="Search scripts"
                className="h-8 w-full rounded-full border border-crm-border bg-crm-surface-2 pl-8 pr-3 text-xs font-medium text-crm-text outline-none placeholder:text-crm-muted"
              />
            </label>
            <label className="tasks-sort-pill h-8">
              <SortAsc className="h-3.5 w-3.5" />
              <span className="sr-only">Sort</span>
              <ConnectSelect
                value={sortMode}
                onChange={(value) => onSortModeChange(value as ScriptSortMode)}
                options={[
                  { value: "updated", label: "Sort: Updated" },
                  { value: "created", label: "Sort: Created" },
                  { value: "name", label: "Sort: Name" },
                ]}
                size="sm"
              />
            </label>
            <span className="text-xs font-medium text-crm-muted tabular-nums">
              {shownCount} shown
            </span>
          </div>
        </div>
      </CRMWorkspaceToolbar>
    </>
  );
}

function KpiTile({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  sub: string;
  tone: "neutral" | "success" | "scheduled" | "warning";
}) {
  const iconClass =
    tone === "success"
      ? "tasks-icon-success"
      : tone === "scheduled"
        ? "tasks-icon-scheduled"
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
    <div className="crm-queue-kpi-card tasks-kpi-card">
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
        <span className="text-xs font-medium text-crm-muted/90">{sub}</span>
      </div>
      <span className={cn("tasks-kpi-icon", iconClass)}>{icon}</span>
    </div>
  );
}

