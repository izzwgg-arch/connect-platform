"use client";

import { useState } from "react";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Plus,
  RotateCcw,
  Search,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import {
  SCRIPT_TEMPLATES,
  SCRIPT_TEMPLATE_ACCENT_CLASSES,
} from "./ScriptTemplates";
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
  const [templatesOpen, setTemplatesOpen] = useState(true);

  const activeScripts = scripts.filter((s) => s.isActive);
  const archivedScripts = scripts.filter((s) => !s.isActive);

  const filteredActive = activeScripts.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()),
  );
  const filteredArchived = archivedScripts.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()),
  );

  const showTemplateRail = activeScripts.length === 0 || templatesOpen;

  return (
    <div className={cn(crm.scriptsLibraryCol)}>
      <div className={cn(crm.scriptsPanelSupport, "flex flex-col overflow-hidden")}>
        <div className="flex items-center justify-between border-b border-crm-border/40 bg-[#101923]/40 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-crm-accent" />
            <span className="text-sm font-semibold text-crm-text">Script Library</span>
            {activeScripts.length > 0 ? (
              <span className="rounded-full border border-crm-border/60 bg-[#101923]/80 px-2 py-0.5 text-[10px] font-bold tabular-nums text-crm-muted">
                {activeScripts.length}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onCreate}
            className={cn(crm.btnPrimary, "gap-1.5 py-1.5 text-xs")}
          >
            <Plus className="h-3.5 w-3.5" />
            New script
          </button>
        </div>

        {scripts.length > 0 ? (
          <div className="border-b border-crm-border/40 px-3 py-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crm-muted" />
              <input
                type="search"
                placeholder="Search scripts…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className={cn(crm.input, crm.inputWithIcon, "py-2 text-xs")}
              />
            </div>
          </div>
        ) : null}

        <div className="flex max-h-[min(70vh,42rem)] flex-col gap-0 overflow-y-auto p-2">
          {activeScripts.length > 0 ? (
            <>
              {filteredActive.length === 0 && search ? (
                <p className="px-2 py-3 text-center text-xs text-crm-muted">
                  No results for &ldquo;{search}&rdquo;
                </p>
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

              {archivedScripts.length > 0 ? (
                <>
                  <button
                    type="button"
                    onClick={() => setShowArchived((v) => !v)}
                    className="mt-2 flex w-full items-center gap-1.5 rounded-crm px-2 py-1.5 text-left hover:bg-[#101923]/50"
                  >
                    <Archive className="h-3 w-3 text-crm-muted" />
                    <span className="flex-1 text-[10px] font-bold uppercase tracking-wider text-crm-muted">
                      Archived ({archivedScripts.length})
                    </span>
                    <ChevronDown
                      className={cn(
                        "h-3 w-3 text-crm-muted transition-transform",
                        showArchived && "rotate-180",
                      )}
                    />
                  </button>
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
            </>
          ) : null}

          <div id="script-templates" className={cn(activeScripts.length > 0 && "mt-3 border-t border-crm-border/40 pt-3")}>
            {activeScripts.length > 0 ? (
              <button
                type="button"
                onClick={() => setTemplatesOpen((v) => !v)}
                className="mb-2 flex w-full items-center gap-1.5 px-1 text-left"
              >
                <span className={crm.label}>Start with a template</span>
                <ChevronDown
                  className={cn(
                    "ml-auto h-3 w-3 text-crm-muted transition-transform",
                    templatesOpen && "rotate-180",
                  )}
                />
              </button>
            ) : (
              <p className={cn(crm.label, "mb-2 px-1")}>Start with a template</p>
            )}

            {showTemplateRail ? (
              <div className="flex flex-col gap-2">
                {SCRIPT_TEMPLATES.map((tpl) => {
                  const accent = SCRIPT_TEMPLATE_ACCENT_CLASSES[tpl.accent];
                  return (
                    <button
                      key={tpl.key}
                      type="button"
                      onClick={() => onUseTemplate(tpl.key)}
                      className={cn(crm.scriptTplCard, accent.card)}
                    >
                      <span className={cn(crm.scriptTplStrip, accent.strip)} aria-hidden />
                      <span className={cn(crm.scriptTplIcon, accent.iconBox)} aria-hidden>
                        {tpl.icon}
                      </span>
                      <div className="min-w-0 flex-1 pr-1">
                        <span className="block text-xs font-semibold text-crm-text">{tpl.label}</span>
                        <span className="mt-0.5 block text-[10px] leading-snug text-crm-muted">
                          {tpl.description}
                        </span>
                      </div>
                      <ChevronRight
                        className={cn("h-3.5 w-3.5 shrink-0 opacity-50", accent.meta)}
                        aria-hidden
                      />
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={onCreate}
            className={cn(
              crm.btnSecondary,
              "mt-3 w-full justify-center gap-2 border-dashed text-xs",
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            Start from scratch
          </button>
        </div>
      </div>
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
        crm.scriptCard,
        "mb-1 w-full text-left",
        isSelected && crm.scriptCardActive,
        archived && crm.scriptCardArchived,
      )}
    >
      <span
        className={cn(
          crm.scriptStatusStrip,
          "my-2 ml-1.5",
          isSelected ? "bg-crm-accent" : archived ? "bg-crm-border/50" : "bg-crm-border/40",
        )}
      />
      <div className="min-w-0 flex-1 px-2 py-2">
        <p
          className={cn(
            "truncate text-xs font-semibold",
            isSelected ? "text-crm-accent" : "text-crm-text",
            archived && "line-through",
          )}
        >
          {script.name}
        </p>
        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-crm-muted">
          <Clock className="h-2.5 w-2.5" />
          <span>{relativeTime(script.updatedAt)}</span>
        </div>
      </div>
      {archived ? (
        <div className="flex items-center pr-2">
          <RotateCcw className="h-3 w-3 text-crm-muted/50" />
        </div>
      ) : null}
    </button>
  );
}
