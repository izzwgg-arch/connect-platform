"use client";

import {
  Archive,
  FileText,
  LibraryBig,
  PlayCircle,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { ScriptSummary } from "./scriptTypes";

export function ScriptOperationalSidebar({
  scripts,
}: {
  scripts: ScriptSummary[];
}) {
  const active = scripts.filter((s) => s.isActive);
  const archived = scripts.filter((s) => !s.isActive);
  const recent = [...scripts]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 4);

  return (
    <aside className={cn(crm.scriptsSideCol, "flex flex-col gap-2.5")}>
      <div className={crm.scriptsSidePanel}>
        <div className="mb-3 flex items-center gap-2">
          <span className="tasks-kpi-icon tasks-icon-scheduled">
            <LibraryBig className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-bold text-crm-text">Script Summary</p>
            <p className="text-xs text-crm-muted">{scripts.length} total scripts</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <MetricChip label="Active" value={active.length} tone="success" />
          <MetricChip label="Archived" value={archived.length} />
        </div>
      </div>

      <div className={crm.scriptsSidePanel}>
        <div className="mb-3 flex items-center gap-2">
          <span className="tasks-kpi-icon tasks-icon-neutral">
            <FileText className="h-4 w-4" />
          </span>
          <p className="text-sm font-bold text-crm-text">Recent Scripts</p>
        </div>
        {recent.length === 0 ? (
          <p className="rounded-crm border border-dashed border-crm-border/45 p-4 text-center text-xs text-crm-muted">
            No script activity yet.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {recent.map((script) => (
              <div key={script.id} className="flex items-center gap-2 rounded-crm border border-crm-border/35 bg-crm-surface/65 p-2.5">
                <span className={cn("tasks-kpi-icon", script.isActive ? "tasks-icon-scheduled" : "tasks-icon-neutral")}>
                  {script.isActive ? <PlayCircle className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-crm-text">{script.name}</span>
                  <span className="text-[10px] text-crm-muted">
                    {script.isActive ? "Active" : "Archived"}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function MetricChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success";
}) {
  return (
    <div className={cn(crm.metricTile, "min-h-[3rem]")}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-crm-muted">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-lg font-bold tabular-nums leading-none",
          tone === "success" ? "text-crm-success" : "text-crm-text",
        )}
      >
        {value}
      </p>
    </div>
  );
}
