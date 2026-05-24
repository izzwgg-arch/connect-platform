"use client";

import { useState } from "react";
import {
  ClipboardList,
  ChevronDown,
  ChevronRight,
  Plus,
  Layers,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import {
  CHECKLIST_TEMPLATES,
  TEMPLATE_ACCENT_CLASSES,
} from "./ChecklistTemplates";

type ChecklistSummary = {
  id: string;
  name: string;
  isActive: boolean;
  items: { id: string; required: boolean }[];
};

type Props = {
  checklists: ChecklistSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewBlank: () => void;
  onNewFromTemplate: (templateId: string) => void;
  isCreating: boolean;
  templatesExpanded?: boolean;
};

export function ChecklistLibraryPanel({
  checklists,
  selectedId,
  onSelect,
  onNewBlank,
  onNewFromTemplate,
  isCreating,
  templatesExpanded,
}: Props) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(true);

  const active = checklists.filter((c) => c.isActive);
  const archived = checklists.filter((c) => !c.isActive);
  const showTemplates = templatesExpanded ?? templatesOpen;

  return (
    <div className={cn(crm.checklistPanelSupport, "flex flex-col overflow-hidden")}>
      <div className="checklist-library-header border-b border-crm-border/25 px-3 py-3">
        <span className={crm.label}>Checklist library</span>
        <button
          type="button"
          onClick={onNewBlank}
          className={cn(
            crm.btnPrimary,
            "mt-2.5 w-full justify-center text-xs",
            isCreating && "ring-1 ring-crm-accent/40"
          )}
        >
          <Plus size={14} />
          New checklist
        </button>
      </div>

      <div className="flex flex-col gap-0.5 overflow-y-auto p-2 flex-1 max-h-[min(70vh,42rem)]">
        {active.length === 0 && !isCreating && (
          <div className={cn(crm.checklistInsetSurface, "rounded-crm border border-dashed border-crm-border/50 px-2 py-4 text-center")}>
            <ClipboardList
              size={20}
              className="mx-auto mb-1.5 text-crm-muted/50"
            />
            <p className="text-[11px] text-crm-muted">No checklists yet.</p>
            <p className="mt-1 text-[10px] text-crm-muted/80">
              Use a template or + to start.
            </p>
          </div>
        )}

        {isCreating && (
          <div
            className={cn(
              crm.checklistCard,
              "border-crm-accent/45 ring-1 ring-crm-accent/25 bg-crm-accent/10 shadow-[0_0_16px_-6px_rgba(56,189,248,0.2)]"
            )}
          >
            <span className="w-1 shrink-0 rounded-l-crm bg-crm-accent" />
            <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2">
              <ClipboardList size={13} className="shrink-0 text-crm-accent" />
              <span className="truncate text-xs font-medium text-crm-accent">
                New checklist…
              </span>
            </div>
          </div>
        )}

        {active.length > 0 && (
          <p className="px-1 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-crm-muted">
            Active checklists
          </p>
        )}

        {active.map((c) => {
          const isSelected = selectedId === c.id;
          const requiredCount = c.items.filter((i) => i.required).length;
          const liveReady = c.items.length > 0 && requiredCount > 0;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              className={cn(
                crm.checklistCard,
                isSelected && crm.checklistCardActive,
                "w-full text-left transition-all duration-300 hover:-translate-y-px hover:shadow-[0_8px_24px_-12px_rgba(56,189,248,0.15)]"
              )}
            >
              <span
                className={cn(
                  crm.checklistStatusStrip,
                  isSelected
                    ? "bg-crm-accent"
                    : liveReady
                      ? "bg-crm-success"
                      : "bg-crm-warning/70"
                )}
              />
              <div className="flex min-w-0 flex-1 items-start gap-2 px-2 py-2">
                <ClipboardList
                  size={13}
                  className={cn(
                    "mt-0.5 shrink-0",
                    isSelected ? "text-crm-accent" : "text-crm-muted"
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "truncate text-xs font-medium",
                        isSelected ? "text-crm-accent" : "text-crm-text"
                      )}
                    >
                      {c.name}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide",
                        liveReady
                          ? "border-crm-success/35 bg-crm-success/10 text-crm-success"
                          : "border-crm-warning/35 bg-crm-warning/10 text-crm-warning"
                      )}
                    >
                      {liveReady ? "In use" : "Draft"}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className="text-[10px] text-crm-muted tabular-nums">
                      {c.items.length} steps
                    </span>
                    {requiredCount > 0 && (
                      <span className="text-[10px] text-crm-warning tabular-nums">
                        · {requiredCount} req
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          );
        })}

        <div className="mt-2 border-t border-crm-border/35 pt-2">
          <button
            type="button"
            onClick={() => setTemplatesOpen((v) => !v)}
            className={cn(
              "flex w-full items-center gap-1.5 rounded-crm px-2 py-1.5 text-left transition-colors hover:bg-crm-surface-2/80",
              templatesExpanded && "bg-crm-accent/8 ring-1 ring-crm-accent/20"
            )}
          >
            <Layers size={11} className="shrink-0 text-crm-accent/70" />
            <span className={cn(crm.label, "flex-1 text-[10px]")}>
              Templates
            </span>
            {showTemplates ? (
              <ChevronDown size={11} className="text-crm-muted/60" />
            ) : (
              <ChevronRight size={11} className="text-crm-muted/60" />
            )}
          </button>

          {showTemplates && (
            <div className="mt-1 flex flex-col gap-1 pl-0.5">
              {CHECKLIST_TEMPLATES.map((t) => {
                const accent = TEMPLATE_ACCENT_CLASSES[t.accent];
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onNewFromTemplate(t.id)}
                    className={cn(
                      "group relative flex w-full items-center gap-2 overflow-hidden rounded-crm border border-crm-border/40 px-2 py-1.5 text-left transition-all duration-200 hover:-translate-y-px hover:border-crm-border/60 hover:bg-crm-surface-2/90",
                      accent.card
                    )}
                  >
                    <span
                      className={cn(
                        "absolute left-0 top-0 bottom-0 w-0.5",
                        accent.strip
                      )}
                      aria-hidden
                    />
                    <span
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-crm border text-xs",
                        accent.iconBox
                      )}
                    >
                      {t.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] font-medium text-crm-text group-hover:text-white">
                        {t.name}
                      </div>
                      <div className="text-[10px] text-crm-muted tabular-nums">
                        {t.items.length} steps
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {archived.length > 0 && (
          <div className="mt-2 border-t border-crm-border/35 pt-2">
            <button
              type="button"
              onClick={() => setArchivedOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
            >
              <span className={cn(crm.label, "flex-1 text-[10px]")}>
                Archived checklists ({archived.length})
              </span>
              {archivedOpen ? (
                <ChevronDown size={11} className="text-crm-muted/60" />
              ) : (
                <ChevronRight size={11} className="text-crm-muted/60" />
              )}
            </button>

            {archivedOpen && (
              <div className="flex flex-col gap-0.5">
                {archived.map((c) => {
                  const isSelected = selectedId === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => onSelect(c.id)}
                      className={cn(
                        crm.checklistCard,
                        crm.checklistCardArchived,
                        isSelected &&
                          "border-crm-border/60 bg-crm-surface-2/50 opacity-80",
                        "w-full text-left"
                      )}
                    >
                      <span className="w-1 shrink-0 rounded-l-crm bg-crm-border/40" />
                      <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2">
                        <ClipboardList
                          size={12}
                          className="shrink-0 text-crm-muted/50"
                        />
                        <span className="truncate text-[11px] text-crm-muted">
                          {c.name}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
