"use client";

import {
  BookOpen,
  CheckSquare,
  FileText,
  LayoutList,
  Plus,
  Sparkles,
  Trophy,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";

const FEATURES = [
  {
    icon: BookOpen,
    title: "Proven Playbooks",
    body: "Battle-tested scripts for every stage of the sales cycle.",
    accent: "text-crm-accent",
  },
  {
    icon: LayoutList,
    title: "Live Playbook View",
    body: "Section-by-section guidance while you're on the call.",
    accent: "text-violet-300",
  },
  {
    icon: CheckSquare,
    title: "Checklist Mode",
    body: "Step through objections, qualification, and closing.",
    accent: "text-crm-success",
  },
  {
    icon: Trophy,
    title: "Win More Calls",
    body: "Consistent messaging that converts cold leads.",
    accent: "text-crm-warning",
  },
] as const;

export function ScriptWorkspaceIdle({
  onCreate,
  onBrowseTemplates,
}: {
  onCreate: () => void;
  onBrowseTemplates: () => void;
}) {
  return (
    <div className={cn(crm.scriptsPanelPrimary, "flex min-h-[28rem] flex-col")}>
      <div className={crm.scriptsPanelPrimaryGlow} aria-hidden />

      <div className="relative z-[1] flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
        <div className="relative mb-6">
          <div
            className="scripts-idle-orb-glow absolute inset-0 -m-8 rounded-full blur-2xl motion-reduce:hidden"
            aria-hidden
          />
          <div className="scripts-idle-orb relative flex h-20 w-20 items-center justify-center rounded-2xl">
            <FileText className="h-10 w-10 text-crm-accent" aria-hidden />
          </div>
          <Sparkles
            className="absolute -right-1 -top-1 h-5 w-5 text-crm-warning motion-reduce:hidden"
            aria-hidden
          />
        </div>

        <h2 className="text-lg font-semibold text-crm-text sm:text-xl">
          Select a script to get started
        </h2>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-crm-muted">
          Choose a script from the library or create a new one to open the live playbook
          workspace.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button type="button" onClick={onCreate} className={cn(crm.btnPrimary, "gap-2 px-5")}>
            <Plus className="h-4 w-4" />
            New script
          </button>
          <button
            type="button"
            onClick={onBrowseTemplates}
            className={cn(crm.btnSecondary, "gap-2 px-5")}
          >
            <Sparkles className="h-4 w-4" />
            Browse templates
          </button>
        </div>

        <div className="mt-10 grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <div key={f.title} className={crm.scriptsFeatureCard}>
              <f.icon className={cn("h-4 w-4 shrink-0", f.accent)} aria-hidden />
              <p className="text-xs font-semibold text-crm-text">{f.title}</p>
              <p className="text-[11px] leading-snug text-crm-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
