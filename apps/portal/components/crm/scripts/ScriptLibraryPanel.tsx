"use client";

import { useState } from "react";
import { Archive, Clock, FileText, Plus, RotateCcw, Search } from "lucide-react";
import { CRMCard } from "../CRMCard";
import { crm } from "../crmClasses";
import { cn } from "../cn";
import { SCRIPT_TEMPLATES } from "./ScriptTemplates";
import type { ScriptSummary } from "./scriptTypes";

interface ScriptLibraryPanelProps {
  scripts: ScriptSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onUseTemplate: (templateKey: string) => void;
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

export function ScriptLibraryPanel({
  scripts,
  selectedId,
  onSelect,
  onCreate,
  onUseTemplate,
}: ScriptLibraryPanelProps) {
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const activeScripts = scripts.filter((s) => s.isActive);
  const archivedScripts = scripts.filter((s) => !s.isActive);

  const filteredActive = activeScripts.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()),
  );
  const filteredArchived = archivedScripts.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()),
  );

  const isEmpty = activeScripts.length === 0;

  return (
    <div className={crm.scriptsLibraryCol}>
      {/* Header */}
      <CRMCard padding="md">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-crm-accent" />
            <span className="text-sm font-semibold text-crm-text">Script Library</span>
            {activeScripts.length > 0 ? (
              <span className="rounded-full border border-crm-border bg-crm-surface-2 px-2 py-0.5 text-[10px] font-bold text-crm-muted tabular-nums">
                {activeScripts.length}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onCreate}
            className={cn(crm.btnPrimary, "py-1.5 text-xs")}
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </button>
        </div>

        {/* Search */}
        {scripts.length > 0 ? (
          <div className="relative mt-3">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crm-muted" />
            <input
              type="search"
              placeholder="Search scripts…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={cn(crm.input, crm.inputWithIcon, "py-2 text-xs")}
            />
          </div>
        ) : null}
      </CRMCard>

      {/* Empty state — guided templates */}
      {isEmpty ? (
        <CRMCard padding="md">
          <p className={cn(crm.label, "mb-3")}>Start with a template</p>
          <div className="flex flex-col gap-2">
            {SCRIPT_TEMPLATES.map((tpl) => (
              <button
                key={tpl.key}
                type="button"
                onClick={() => onUseTemplate(tpl.key)}
                className={crm.scriptTemplateCard}
              >
                <span className="text-xs font-semibold text-crm-text">{tpl.label}</span>
                <span className="text-[11px] leading-tight text-crm-muted">{tpl.description}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onCreate}
            className={cn(crm.btnGhost, "mt-3 w-full justify-center text-xs")}
          >
            <Plus className="h-3.5 w-3.5" />
            Start from scratch
          </button>
        </CRMCard>
      ) : (
        /* Script list */
        <CRMCard padding="none" className="overflow-hidden">
          {/* Active scripts */}
          <div className="flex flex-col">
            {filteredActive.length === 0 && search ? (
              <p className="px-4 py-3 text-xs text-crm-muted">No results for "{search}"</p>
            ) : (
              filteredActive.map((s) => (
                <ScriptListItem
                  key={s.id}
                  script={s}
                  isSelected={selectedId === s.id}
                  onSelect={onSelect}
                />
              ))
            )}
          </div>

          {/* Archived section */}
          {archivedScripts.length > 0 ? (
            <>
              <div className="border-t border-crm-border/60">
                <button
                  type="button"
                  onClick={() => setShowArchived((v) => !v)}
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left"
                >
                  <Archive className="h-3 w-3 text-crm-muted" />
                  <span className={cn(crm.label, "flex-1 normal-case text-[10px]")}>
                    Archived ({archivedScripts.length})
                  </span>
                  <span className="text-[10px] text-crm-muted/70">{showArchived ? "▲" : "▼"}</span>
                </button>
              </div>
              {showArchived
                ? filteredArchived.map((s) => (
                    <ScriptListItem
                      key={s.id}
                      script={s}
                      isSelected={selectedId === s.id}
                      onSelect={onSelect}
                      archived
                    />
                  ))
                : null}
            </>
          ) : null}
        </CRMCard>
      )}
    </div>
  );
}

function ScriptListItem({
  script,
  isSelected,
  onSelect,
  archived = false,
}: {
  script: ScriptSummary;
  isSelected: boolean;
  onSelect: (id: string) => void;
  archived?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(script.id)}
      className={cn(
        "group relative flex w-full items-stretch text-left transition-colors",
        isSelected
          ? "bg-crm-accent/10"
          : "hover:bg-crm-surface-2/60",
        archived && "opacity-60",
      )}
    >
      {/* Status strip */}
      <span
        className={cn(
          crm.scriptStatusStrip,
          "my-2 ml-2",
          !archived && isSelected
            ? "bg-crm-accent"
            : archived
              ? "bg-crm-border/60"
              : "bg-crm-border/40 group-hover:bg-crm-border",
        )}
      />

      <div className="min-w-0 flex-1 px-3 py-2.5">
        <p
          className={cn(
            "truncate text-xs font-semibold leading-tight",
            isSelected ? "text-crm-accent" : "text-crm-text",
            archived && "line-through",
          )}
        >
          {script.name}
        </p>
        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-crm-muted">
          <Clock className="h-2.5 w-2.5" />
          <span>{relativeTime(script.updatedAt)}</span>
          {!script.isActive ? (
            <>
              <span>·</span>
              <span className="text-crm-muted/70">archived</span>
            </>
          ) : null}
        </div>
      </div>

      {/* Restore icon for archived */}
      {archived ? (
        <div className="flex items-center pr-3">
          <RotateCcw className="h-3 w-3 text-crm-muted/50" />
        </div>
      ) : null}
    </button>
  );
}
