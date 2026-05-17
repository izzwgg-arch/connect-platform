"use client";

import { useState } from "react";
import {
  Archive,
  CheckSquare,
  Copy,
  ExternalLink,
  FileText,
  LayoutList,
  Pencil,
  RotateCcw,
} from "lucide-react";
import { crm } from "../crmClasses";
import { cn } from "../cn";
import { ScriptSectionBlock } from "./ScriptSectionBlock";
import { parseScriptSections } from "./ScriptTemplates";
import type { Script } from "./scriptTypes";

interface ScriptWorkspaceProps {
  script: Script;
  loading?: boolean;
  onEdit: () => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
}

type ViewMode = "playbook" | "checklist";

export function ScriptWorkspace({
  script,
  loading = false,
  onEdit,
  onArchive,
  onRestore,
}: ScriptWorkspaceProps) {
  const [mode, setMode] = useState<ViewMode>("playbook");
  const [stepsDone, setStepsDone] = useState<Record<number, boolean>>({});
  const [copiedAll, setCopiedAll] = useState(false);

  const sections = parseScriptSections(script.body);
  const sectionsDone = sections.filter((_, i) => stepsDone[i]);
  const progress = sections.length > 0 ? (sectionsDone.length / sections.length) * 100 : 0;

  function handleCopyAll() {
    void navigator.clipboard.writeText(script.body).then(() => {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    });
  }

  if (loading) {
    return (
      <div className={cn(crm.scriptsPanelPrimary, "min-h-[28rem] p-5")}>
        <div className={crm.scriptsPanelPrimaryGlow} aria-hidden />
        <div className="relative z-[1] flex flex-col gap-3">
          <div className="h-5 w-48 animate-pulse rounded bg-crm-surface-2/80" />
          <div className="h-3 w-32 animate-pulse rounded bg-crm-surface-2/80" />
          {[80, 60, 90, 70].map((w, i) => (
            <div
              key={i}
              className="h-3 animate-pulse rounded bg-crm-surface-2/80"
              style={{ width: `${w}%` }}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={cn(crm.scriptsPanelPrimary, "flex min-h-[28rem] flex-col")}>
      <div className={crm.scriptsPanelPrimaryGlow} aria-hidden />
      <div className="relative z-[1] flex flex-col gap-2.5 overflow-y-auto p-4 sm:p-5">
        <div className="rounded-crm-lg border border-crm-border/50 bg-[#101923]/50 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className={crm.scriptsHeroIcon}>
                <FileText className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-crm-text">{script.name}</h2>
                  {!script.isActive ? (
                    <span className="rounded-full border border-crm-border bg-crm-surface-2 px-2 py-0.5 text-[10px] font-medium text-crm-muted">
                      Archived
                    </span>
                  ) : (
                    <span className="rounded-full border border-crm-success/35 bg-crm-success/10 px-2 py-0.5 text-[10px] font-medium text-crm-success">
                      Active
                    </span>
                  )}
                </div>
                <p className={cn(crm.footnote, "mt-0.5")}>
                  {sections.length} section{sections.length !== 1 ? "s" : ""}
                  {" · "}
                  Updated{" "}
                  {new Date(script.updatedAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleCopyAll}
                className={cn(crm.btnGhost, "text-xs")}
                title="Copy full script"
              >
                {copiedAll ? (
                  <>✓ Copied</>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copy all
                  </>
                )}
              </button>
              <button type="button" onClick={onEdit} className={cn(crm.btnSecondary, "text-xs")}>
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </button>
              {script.isActive ? (
                <button
                  type="button"
                  onClick={() => onArchive(script.id)}
                  className={cn(crm.btnGhost, "text-xs")}
                  title="Archive script"
                >
                  <Archive className="h-3.5 w-3.5" />
                  Archive
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onRestore(script.id)}
                  className={cn(crm.btnGhost, "text-xs text-crm-success")}
                  title="Restore script"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Restore
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-crm-border/60 pt-3">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setMode("playbook")}
                className={mode === "playbook" ? crm.scriptModeTabActive : crm.scriptModeTab}
              >
                <LayoutList className="h-3.5 w-3.5" />
                Playbook
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("checklist");
                  setStepsDone({});
                }}
                className={mode === "checklist" ? crm.scriptModeTabActive : crm.scriptModeTab}
              >
                <CheckSquare className="h-3.5 w-3.5" />
                Checklist
              </button>
            </div>

            {sections.length > 1 ? (
              <div className="flex flex-wrap items-center gap-1 border-l border-crm-border/60 pl-2">
                {sections.map((s, i) => (
                  <a
                    key={i}
                    href={`#section-${i}`}
                    className={crm.scriptSectionPill}
                    title={s.title || `Section ${i + 1}`}
                  >
                    {s.title ? s.title.slice(0, 20) : `§${i + 1}`}
                  </a>
                ))}
              </div>
            ) : null}

            <a
              href="/crm/live-call"
              className={cn(crm.btnGhost, "ml-auto text-xs")}
              title="Open in Live Call workspace"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Live call
            </a>
          </div>

          {mode === "checklist" && sections.length > 0 ? (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-[10px] text-crm-muted">
                <span>Progress</span>
                <span className="tabular-nums">
                  {sectionsDone.length}/{sections.length} sections
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-crm-surface-2">
                <div
                  className="h-full rounded-full bg-crm-success transition-all duration-300 motion-reduce:transition-none"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          {sections.length === 0 ? (
            <div className="rounded-crm border border-dashed border-crm-border/60 bg-[#101923]/40 px-4 py-6 text-center">
              <p className="text-sm text-crm-muted">
                This script has no content yet.{" "}
                <button
                  type="button"
                  onClick={onEdit}
                  className="text-crm-accent hover:underline"
                >
                  Edit to add sections.
                </button>
              </p>
            </div>
          ) : (
            sections.map((section, i) => (
              <ScriptSectionBlock
                key={i}
                index={i}
                title={section.title}
                content={section.content}
                defaultOpen={i === 0}
                checklistMode={mode === "checklist"}
                stepDone={!!stepsDone[i]}
                onStepDone={(done) => setStepsDone((prev) => ({ ...prev, [i]: done }))}
              />
            ))
          )}
        </div>

        {mode === "checklist" && progress === 100 ? (
          <div className={cn(crm.bannerSuccess, "rounded-crm-lg px-4 py-3")}>
            <div className="flex items-center gap-2">
              <CheckSquare className="h-4 w-4" />
              <p className="text-sm font-semibold">All sections complete. Great call!</p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

