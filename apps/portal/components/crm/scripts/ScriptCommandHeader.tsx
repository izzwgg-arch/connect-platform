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

import type { LucideIcon } from "lucide-react";

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

          icon={<FileText className="h-6 w-6" aria-hidden />}

          title="Scripts"

          subtitle="Sales playbooks and cold-call scripts for your outbound team."

          className={cn(crm.contactsHeaderPanel, "campaigns-command-header")}

          actions={

            <div className="campaigns-hero-actions">

              <button type="button" onClick={onCreate} className="campaigns-btn-primary">

                <Plus className="h-4 w-4" />

                New Script

              </button>

            </div>

          }

        />

      </CRMWorkspaceHeader>



      <CRMWorkspaceToolbar className="flex flex-col gap-3">

        <section className="crm-queue-kpi-strip grid w-full grid-cols-2 items-stretch gap-3 md:grid-cols-4 xl:grid-cols-4" aria-label="Script metrics">

          <KpiTile

            label="Active"

            value={String(activeCount)}

            hint="Ready to dial"

            icon={PlayCircle}

            tone="green"

          />

          <KpiTile

            label="Draft"

            value={String(draftCount)}

            hint="Pending publish"

            icon={FileText}

            tone="amber"

          />

          <KpiTile

            label="Archived"

            value={String(archivedCount)}

            hint="Hidden from use"

            icon={Archive}

            tone="violet"

          />

          <KpiTile

            label="Total"

            value={String(totalCount)}

            hint="Scripts required"

            icon={LibraryBig}

            tone="blue"

          />

        </section>



        <div className="crm-queue-filter-bar tasks-filter-bar">
          <div className="crm-queue-filter-grid scripts-filter-grid">
            <div className="crm-queue-filter-field crm-queue-filter-field-search">
              <Search className="crm-queue-filter-icon h-4 w-4 shrink-0 text-crm-muted" />
              <input
                id="crm-scripts-search"
                type="search"
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Name, body, playbook..."
                className="crm-queue-filter-control min-w-[10rem] flex-1"
                aria-label="Search scripts"
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => onSearchChange("")}
                  className="text-xs font-medium text-crm-accent hover:underline"
                >
                  Clear
                </button>
              ) : null}
            </div>

            <div className="crm-queue-filter-field">
              <label htmlFor="crm-scripts-status" className="sr-only">
                Status
              </label>
              <ConnectSelect
                id="crm-scripts-status"
                value={statusFilter}
                onChange={(value) => onStatusFilterChange(value as ScriptStatusFilter)}
                options={TABS.map((tab) => ({ value: tab.id, label: tab.label }))}
                className="min-w-[10rem] flex-1"
                size="sm"
              />
            </div>

            <div className="crm-queue-filter-field">
              <SortAsc className="h-4 w-4 shrink-0 text-crm-muted" />
              <label htmlFor="crm-scripts-sort" className="sr-only">
                Sort
              </label>
              <ConnectSelect
                id="crm-scripts-sort"
                value={sortMode}
                onChange={(value) => onSortModeChange(value as ScriptSortMode)}
                options={[
                  { value: "updated", label: "Updated" },
                  { value: "created", label: "Created" },
                  { value: "name", label: "Name" },
                ]}
                className="min-w-[10rem] flex-1"
                size="sm"
              />
            </div>

            <div className="crm-queue-filter-field scripts-filter-count">
              <span
                className="crm-queue-filter-control scripts-filter-count-value"
                aria-label={`${shownCount} scripts shown`}
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


