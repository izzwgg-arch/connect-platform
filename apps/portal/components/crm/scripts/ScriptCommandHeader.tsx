"use client";

import { FileText, Layers3, LibraryBig, PlayCircle, Plus, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { CRMPageHeader } from "../CRMPageHeader";
import { CRMWorkspaceHeader, CRMWorkspaceToolbar } from "../CRMWorkspaceShell";
import { SCRIPT_TEMPLATES } from "./ScriptTemplates";

export function ScriptCommandHeader({
  totalCount,
  activeCount,
  onCreate,
}: {
  totalCount: number;
  activeCount: number;
  onCreate: () => void;
}) {
  const templateCount = SCRIPT_TEMPLATES.length;

  return (
    <>
      <CRMWorkspaceHeader>
        <CRMPageHeader
          icon={<FileText className="h-5 w-5" />}
          title="Call Scripts"
          subtitle="Sales playbooks and cold-call scripts for your outbound team."
          className="tasks-page-header"
          actions={
            <button type="button" onClick={onCreate} className="tasks-primary-action">
              <Plus className="h-4 w-4" />
              New Script
            </button>
          }
        />
      </CRMWorkspaceHeader>

      <CRMWorkspaceToolbar className="flex flex-col gap-3">
        <div className="tasks-kpi-grid grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            icon={<LibraryBig className="h-5 w-5" />}
            label="Total scripts"
            value={totalCount}
            sub="Script library"
            tone="neutral"
          />
          <KpiTile
            icon={<PlayCircle className="h-5 w-5" />}
            label="Active playbooks"
            value={activeCount}
            sub="Ready to dial"
            tone="success"
          />
          <KpiTile
            icon={<Layers3 className="h-5 w-5" />}
            label="Starter templates"
            value={templateCount}
            sub="Built-in flows"
            tone="scheduled"
          />
          <KpiTile
            icon={<Zap className="h-5 w-5" />}
            label="Quick start flows"
            value={SCRIPT_TEMPLATES.length}
            sub="One-click starters"
            tone="warning"
          />
        </div>
      </CRMWorkspaceToolbar>
    </>
  );
}

function KpiTile({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  sub: string;
  tone: "neutral" | "success" | "scheduled" | "warning";
}) {
  const iconClass =
    tone === "success"
      ? "tasks-icon-success"
      : tone === "scheduled"
        ? "tasks-icon-scheduled"
        : tone === "warning"
          ? "tasks-icon-warning"
          : "tasks-icon-neutral";
  const valueClass =
    tone === "success"
      ? "text-crm-success"
      : tone === "warning"
        ? "text-crm-warning"
        : "text-crm-text";

  return (
    <div className="tasks-kpi-card">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-[11px] font-semibold leading-none text-crm-muted">
          {label}
        </span>
        <span
          className={cn(
            "text-3xl font-semibold leading-none tracking-tight tabular-nums",
            valueClass
          )}
        >
          {value}
        </span>
        <span className="text-xs font-medium text-crm-muted/90">{sub}</span>
      </div>
      <span className={cn("tasks-kpi-icon", iconClass)}>{icon}</span>
    </div>
  );
}

