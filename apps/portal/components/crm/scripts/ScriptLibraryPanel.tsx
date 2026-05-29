"use client";

import { useEffect, useState } from "react";
import {
  Archive,
  ChevronDown,
  Clock,
  FileText,
  Filter,
  Grid2X2,
  ListFilter,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
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
  /** Increment after a successful create so search/status filters reset. */
  resetFiltersToken?: number;
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

type StatusFilter = "all" | "active" | "archived";

const CATEGORY_TONES = [
  "scripts-category-pill--blue",
  "scripts-category-pill--violet",
  "scripts-category-pill--green",
  "scripts-category-pill--amber",
  "scripts-category-pill--rose",
] as const;

function categoryFor(script: ScriptSummary): { label: string; tone: string } {
  const match = SCRIPT_TEMPLATES.find((tpl) =>
    script.name.toLowerCase().includes(tpl.label.toLowerCase().split(" ")[0] ?? ""),
  );
  const label = match?.label ?? "General";
  const tone = CATEGORY_TONES[Math.abs(script.name.length) % CATEGORY_TONES.length];
  return { label, tone };
}

export function ScriptLibraryPanel({
  scripts,
  selectedId,
  resetFiltersToken = 0,
  onSelect,
  onCreate,
  onUseTemplate,
}: ScriptLibraryPanelProps) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [templatesOpen, setTemplatesOpen] = useState(true);

  useEffect(() => {
    if (resetFiltersToken > 0) {
      setSearch("");
      setStatus("all");
    }
  }, [resetFiltersToken]);

  const activeScripts = scripts.filter((s) => s.isActive);

  const filteredScripts = scripts
    .filter((s) => {
      if (status === "active") return s.isActive;
      if (status === "archived") return !s.isActive;
      return true;
    })
    .filter((s) => s.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const showTemplateRail = activeScripts.length === 0 || templatesOpen;

  return (
    <div className={cn(crm.scriptsLibraryCol)}>
      <div className={cn(crm.scriptsPanelSupport, "flex flex-col overflow-hidden")}>
        <div className={crm.scriptsLibraryHeader}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="scripts-mini-icon scripts-mini-icon--blue">
                <FileText className="h-4 w-4" />
              </span>
              <span className="text-lg font-bold tracking-tight text-crm-text">All Scripts</span>
              <span className={crm.scriptsLibraryCount}>{scripts.length}</span>
            </div>
            <p className="mt-1 text-sm text-crm-muted">Search, organize, and open real call playbooks.</p>
          </div>
          <button
            type="button"
            onClick={onCreate}
            className={cn(crm.btnPrimary, "h-10 gap-1.5 px-4 text-sm")}
          >
            <Plus className="h-4 w-4" />
            New Script
          </button>
        </div>

        <div className="scripts-toolbar border-b border-crm-border/40 p-3 sm:p-4">
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto]">
            <div className="relative min-w-0">
              <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-crm-muted" />
              <input
                type="search"
                placeholder="Search scripts…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className={cn(crm.input, crm.inputWithIcon, "h-11 rounded-2xl py-2.5 text-sm")}
              />
            </div>
            <label className="relative">
              <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crm-muted" />
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as StatusFilter)}
                className={cn(crm.select, "h-11 min-w-[10rem] rounded-2xl pl-9 text-sm")}
              >
                <option value="all">All Status</option>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <div className="hidden items-center gap-1 rounded-2xl border border-crm-border bg-crm-surface-2/70 p-1 md:flex">
              <span className="rounded-xl bg-crm-surface px-2.5 py-2 text-crm-accent shadow-sm">
                <ListFilter className="h-4 w-4" />
              </span>
              <span className="px-2 py-2 text-crm-muted">
                <Grid2X2 className="h-4 w-4" />
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 p-3 sm:p-4">
          <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(8rem,0.7fr)_minmax(7rem,0.55fr)_minmax(7rem,0.5fr)_auto] gap-3 px-4 text-[11px] font-bold uppercase tracking-wider text-crm-muted lg:grid">
            <span>Script</span>
            <span>Category</span>
            <span>Status</span>
            <span>Updated</span>
            <span className="text-right">Actions</span>
          </div>

          <div className="flex max-h-[min(68vh,44rem)] flex-col gap-2 overflow-y-auto">
            {filteredScripts.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-crm-border px-4 py-8 text-center text-sm text-crm-muted">
                {search ? (
                  <>
                  No results for &ldquo;{search}&rdquo;
                  </>
                ) : (
                  "No scripts in this view yet."
                )}
              </p>
            ) : (
              filteredScripts.map((s) => (
                <ScriptListItem
                  key={s.id}
                  script={s}
                  isSelected={selectedId === s.id}
                  onSelect={onSelect}
                />
              ))
            )}
          </div>

          <div id="script-templates" className="rounded-[1.25rem] border border-crm-border/45 bg-crm-surface-2/35 p-3">
            <button
              type="button"
              onClick={() => setTemplatesOpen((v) => !v)}
              className="flex w-full items-center gap-2 text-left"
            >
              <span className="scripts-mini-icon scripts-mini-icon--violet">
                <SlidersHorizontal className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-crm-text">Starter Templates</span>
                <span className="text-xs text-crm-muted">Launch from existing playbook patterns.</span>
              </span>
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-crm-muted transition-transform",
                  templatesOpen && "rotate-180",
                )}
              />
            </button>

            {showTemplateRail ? (
              <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {SCRIPT_TEMPLATES.map((tpl) => {
                  const accent = SCRIPT_TEMPLATE_ACCENT_CLASSES[tpl.accent];
                  return (
                    <button
                      key={tpl.key}
                      type="button"
                      onClick={() => onUseTemplate(tpl.key)}
                      className={cn(crm.scriptTplCard, "min-h-[5.75rem]", accent.card)}
                    >
                      <span className={cn(crm.scriptTplStrip, accent.strip)} aria-hidden />
                      <span className={cn(crm.scriptTplIcon, accent.iconBox)} aria-hidden>
                        {tpl.icon}
                      </span>
                      <div className="min-w-0 flex-1 pr-1">
                        <span className="block text-sm font-bold text-crm-text">{tpl.label}</span>
                        <span className="mt-1 block text-xs leading-snug text-crm-muted">
                          {tpl.description}
                        </span>
                      </div>
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
              "w-full justify-center gap-2 rounded-2xl border-dashed py-3 text-sm",
            )}
          >
            <Plus className="h-4 w-4" />
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
}: {
  script: ScriptSummary;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const category = categoryFor(script);

  return (
    <button
      type="button"
      onClick={() => onSelect(script.id)}
      className={cn(
        crm.scriptCard,
        "w-full text-left",
        isSelected && crm.scriptCardActive,
        !script.isActive && crm.scriptCardArchived,
      )}
    >
      <span
        className={cn(
          crm.scriptStatusStrip,
          "my-3 ml-2",
          isSelected ? "bg-crm-accent" : script.isActive ? "bg-crm-success" : "bg-crm-border/50",
        )}
      />
      <div className="grid min-w-0 flex-1 gap-3 px-3 py-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(8rem,0.7fr)_minmax(7rem,0.55fr)_minmax(7rem,0.5fr)_auto] lg:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn("scripts-mini-icon", script.isActive ? "scripts-mini-icon--rose" : "scripts-mini-icon--muted")}>
            {script.isActive ? <FileText className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
          </span>
          <span className="min-w-0">
            <span
              className={cn(
                "block truncate text-base font-bold tracking-tight",
                isSelected ? "text-crm-accent" : "text-crm-text",
                !script.isActive && "line-through",
              )}
            >
              {script.name}
            </span>
            <span className="mt-1 flex items-center gap-1.5 text-xs text-crm-muted">
              <Clock className="h-3.5 w-3.5" />
              Last updated {relativeTime(script.updatedAt)}
            </span>
          </span>
        </div>
        <span className={cn("scripts-category-pill w-fit", category.tone)}>
          {category.label}
        </span>
        <span
          className={cn(
            "scripts-status-pill w-fit",
            script.isActive ? "scripts-status-pill--active" : "scripts-status-pill--archived",
          )}
        >
          {script.isActive ? "Active" : "Archived"}
        </span>
        <span className="text-sm font-medium text-crm-muted">{relativeTime(script.updatedAt)}</span>
        <span className="flex items-center justify-end pr-1 text-crm-muted">
          {script.isActive ? <ChevronDown className="-rotate-90 h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
        </span>
      </div>
    </button>
  );
}
