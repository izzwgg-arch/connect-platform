"use client";

import { Archive, ClipboardCheck, FileText, ListChecks } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";

type ChecklistItem = {
  id: string;
  label: string;
  required: boolean;
};

type Checklist = {
  id: string;
  name: string;
  isActive: boolean;
  updatedAt?: string;
  items: ChecklistItem[];
};

type Props = {
  checklist: Checklist | null;
  checklists: Checklist[];
  avgRequiredPct: number;
  liveReadyCount: number;
  onNewBlank: () => void;
};

function StatRow({
  dotClass,
  label,
  value,
  valueClass,
}: {
  dotClass: string;
  label: string;
  value: number;
  valueClass?: string;
}) {
  return (
    <div className={cn(crm.checklistInsetSurface, "flex items-center justify-between gap-2 rounded-crm border border-crm-border/40 px-2.5 py-1.5")}>
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", dotClass)} />
        <span className="text-[11px] text-crm-muted">{label}</span>
      </div>
      <span
        className={cn(
          "text-sm font-bold tabular-nums",
          valueClass ?? "text-crm-text"
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function ChecklistProgressPanel({
  checklist,
  checklists,
  avgRequiredPct,
  liveReadyCount,
}: Props) {
  const active = checklists.filter((item) => item.isActive);
  const draft = checklists.filter((item) => item.isActive && item.items.length === 0);
  const archived = checklists.filter((item) => !item.isActive);
  const selectedTotal = checklist?.items.length ?? 0;
  const selectedRequired = checklist?.items.filter((item) => item.required) ?? [];
  const selectedRequiredCount = selectedRequired.length;
  const selectedOptionalCount = Math.max(0, selectedTotal - selectedRequiredCount);
  const recent = [...checklists]
    .sort(
      (a, b) =>
        new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime()
    )
    .slice(0, 3);

  return (
    <div className="flex flex-col gap-3">
      <div className={crm.checklistRailCard}>
        <div className="mb-3 flex items-center gap-2">
          <span className="tasks-kpi-icon tasks-icon-scheduled">
            <ClipboardCheck className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-bold text-crm-text">Checklist Summary</h2>
            <p className="text-xs text-crm-muted">{checklists.length} total checklists</p>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <StatRow dotClass="bg-crm-success" label="Active" value={active.length} valueClass="text-crm-success" />
          <StatRow dotClass="bg-crm-warning" label="Draft" value={draft.length} valueClass="text-crm-warning" />
          <StatRow dotClass="bg-crm-border" label="Archived" value={archived.length} />
          <StatRow dotClass="bg-crm-accent" label="Live-ready" value={liveReadyCount} valueClass="text-crm-accent" />
          <StatRow dotClass="bg-crm-accent" label="Avg required" value={avgRequiredPct} valueClass="text-crm-accent" />
        </div>
      </div>

      {checklist ? (
        <div className={crm.checklistRailCard}>
          <div className="mb-3 flex items-center gap-2">
            <span className="tasks-kpi-icon tasks-icon-neutral">
              <FileText className="h-4 w-4" />
            </span>
            <h2 className="text-sm font-bold text-crm-text">Selected Checklist</h2>
          </div>
          <p className="truncate text-sm font-semibold text-crm-text">{checklist.name}</p>
          <div className="mt-3 flex flex-col gap-1.5">
            <StatRow dotClass="bg-crm-accent" label="Steps" value={selectedTotal} />
            <StatRow dotClass="bg-crm-warning" label="Required" value={selectedRequiredCount} />
            <StatRow dotClass="bg-crm-border" label="Optional" value={selectedOptionalCount} />
          </div>
        </div>
      ) : null}

      <div className={crm.checklistRailCard}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-crm-text">Recent Activity</h2>
        </div>
        {recent.length === 0 ? (
          <div className="rounded-[1rem] border border-dashed border-crm-border/45 p-4 text-center">
            <ClipboardCheck size={20} className="mx-auto mb-2 text-crm-muted/45" />
            <p className="text-xs text-crm-muted">No checklist activity yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {recent.map((item, index) => (
              <div key={item.id} className="flex items-center gap-2 rounded-[1rem] border border-crm-border/35 bg-crm-surface/65 p-2.5">
                <span className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border",
                  index === 0
                    ? "border-crm-accent/25 bg-crm-accent/10 text-crm-accent"
                    : index === 1
                      ? "border-crm-warning/25 bg-crm-warning/10 text-crm-warning"
                      : "border-violet-400/25 bg-violet-400/10 text-violet-300"
                )}>
                  {item.isActive ? <ListChecks size={14} /> : <Archive size={14} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-crm-text">
                    {item.name} {item.isActive ? "updated" : "archived"}
                  </span>
                  <span className="text-[10px] text-crm-muted">
                    {item.items.length} steps
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
