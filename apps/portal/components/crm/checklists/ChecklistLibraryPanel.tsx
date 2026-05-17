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
import { CHECKLIST_TEMPLATES } from "./ChecklistTemplates";

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
};

export function ChecklistLibraryPanel({
  checklists,
  selectedId,
  onSelect,
  onNewBlank,
  onNewFromTemplate,
  isCreating,
}: Props) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const active = checklists.filter((c) => c.isActive);
  const archived = checklists.filter((c) => !c.isActive);

  return (
    <div className={cn(crm.card, "flex flex-col overflow-hidden")}>
      {/* Panel header */}
      <div className="flex items-center justify-between border-b border-crm-border px-3 py-2.5">
        <span className={crm.label}>Checklists</span>
        <button
          onClick={onNewBlank}
          className={cn(
            crm.btnGhost,
            "h-7 w-7 !p-0 shrink-0",
            isCreating && "border-crm-accent/40 text-crm-accent"
          )}
          title="New checklist"
          aria-label="New checklist"
        >
          <Plus size={13} />
        </button>
      </div>

      <div className="flex flex-col gap-0.5 overflow-y-auto p-2 flex-1">
        {/* Active checklists */}
        {active.length === 0 && !isCreating && (
          <div className="px-2 py-3 text-center">
            <ClipboardList
              size={22}
              className="mx-auto mb-1.5 text-crm-muted/60"
            />
            <p className="text-[11px] text-crm-muted">No checklists yet.</p>
          </div>
        )}

        {isCreating && (
          <div
            className={cn(
              crm.checklistCard,
              "border-crm-accent/40 ring-1 ring-crm-accent/20 bg-crm-accent/8"
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

        {active.map((c) => {
          const isSelected = selectedId === c.id;
          const requiredCount = c.items.filter((i) => i.required).length;
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={cn(
                crm.checklistCard,
                isSelected && crm.checklistCardActive,
                "w-full text-left"
              )}
            >
              <span
                className={cn(
                  crm.checklistStatusStrip,
                  isSelected ? "bg-crm-accent" : "bg-crm-border/60"
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
                  <div
                    className={cn(
                      "truncate text-xs font-medium",
                      isSelected ? "text-crm-accent" : "text-crm-text"
                    )}
                  >
                    {c.name}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className="text-[10px] text-crm-muted tabular-nums">
                      {c.items.length} steps
                    </span>
                    {requiredCount > 0 && (
                      <span className="text-[10px] text-crm-warning">
                        · {requiredCount} req
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          );
        })}

        {/* Templates section */}
        <div className="mt-2">
          <button
            onClick={() => setTemplatesOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
          >
            <Layers size={11} className="shrink-0 text-crm-muted/70" />
            <span className={cn(crm.label, "flex-1 text-[10px]")}>
              Templates
            </span>
            {templatesOpen ? (
              <ChevronDown size={11} className="text-crm-muted/60" />
            ) : (
              <ChevronRight size={11} className="text-crm-muted/60" />
            )}
          </button>

          {templatesOpen && (
            <div className="flex flex-col gap-0.5 pl-1">
              {CHECKLIST_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onNewFromTemplate(t.id)}
                  className="flex w-full items-center gap-2 rounded-crm px-2 py-1.5 text-left transition-colors hover:bg-crm-surface-2"
                >
                  <span className="text-sm">{t.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium text-crm-text">
                      {t.name}
                    </div>
                    <div className="text-[10px] text-crm-muted">
                      {t.items.length} steps
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Archived section */}
        {archived.length > 0 && (
          <div className="mt-2 border-t border-crm-border/40 pt-2">
            <button
              onClick={() => setArchivedOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
            >
              <span className={cn(crm.label, "flex-1 text-[10px]")}>
                Archived ({archived.length})
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
                      onClick={() => onSelect(c.id)}
                      className={cn(
                        crm.checklistCard,
                        crm.checklistCardArchived,
                        isSelected && "border-crm-border/60 bg-crm-surface-2/60",
                        "w-full text-left"
                      )}
                    >
                      <span className="w-1 shrink-0 rounded-l-crm bg-crm-border/40" />
                      <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2">
                        <ClipboardList size={12} className="shrink-0 text-crm-muted/50" />
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
