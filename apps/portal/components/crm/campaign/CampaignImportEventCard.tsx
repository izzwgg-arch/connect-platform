"use client";

import Link from "next/link";
import { AlertTriangle, FileUp } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { CampaignImportHistoryRow } from "./campaignTypes";
import { CAMPAIGN_IMPORT_STATUS_CHIP } from "./campaignTypes";
import { campaignImportStatusLabel, formatImportTimestamp } from "./campaignUtils";

export function CampaignImportEventCard({ row }: { row: CampaignImportHistoryRow }) {
  const chip = CAMPAIGN_IMPORT_STATUS_CHIP[row.status] ?? "bg-crm-bg text-crm-text border-crm-border";
  const hasIssues = row.errorCount > 0 || row.status === "PARTIAL" || row.status === "FAILED";
  const enrolled = row.createdCount + row.updatedCount;
  const qualityPct =
    row.totalRows > 0 ? Math.round(((row.totalRows - row.errorCount - row.skippedCount) / row.totalRows) * 100) : 100;

  return (
    <li className={cn(crm.card, "p-3 hover:border-crm-accent/25 transition-colors")}>
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-crm bg-crm-accent/12 text-crm-accent">
          <FileUp className="h-4 w-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-crm-text" title={row.fileName}>
              {row.fileName}
            </p>
            <span className={cn("rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide", chip)}>
              {campaignImportStatusLabel(row.status)}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-crm-muted">
            {formatImportTimestamp(row.createdAt)}
            {row.createdBy ? ` · ${row.createdBy.displayName}` : ""}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
            <Metric label="Rows" value={row.totalRows} />
            <Metric label="Created" value={row.createdCount} accent="success" />
            <Metric label="Updated" value={row.updatedCount} accent="accent" />
            <Metric label="Skipped" value={row.skippedCount} />
          </div>
          {row.errorCount > 0 && (
            <p className="mt-1.5 flex items-center gap-1 text-xs text-crm-danger">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {row.errorCount} row error{row.errorCount !== 1 ? "s" : ""}
            </p>
          )}
          {hasIssues && row.errorCount === 0 && (
            <p className="mt-1 text-[11px] text-crm-warning">Review batch for partial enrollment or skipped rows.</p>
          )}
          <p className="mt-1.5 text-[11px] text-crm-muted">
            Import quality: <span className="font-medium text-crm-text">{qualityPct}%</span> rows without errors/skips
            {enrolled > 0 ? ` · ${enrolled} contact writes` : ""}
          </p>
        </div>
        <Link
          href={`/crm/import?batch=${encodeURIComponent(row.id)}`}
          className="shrink-0 text-xs font-semibold text-crm-accent hover:underline self-center"
        >
          Details →
        </Link>
      </div>
    </li>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "success" | "accent";
}) {
  const valueClass =
    accent === "success" ? "text-crm-success" : accent === "accent" ? "text-crm-accent" : "text-crm-text";
  return (
    <div>
      <span className="text-crm-muted">{label}</span>{" "}
      <span className={cn("font-semibold tabular-nums", valueClass)}>{value}</span>
    </div>
  );
}
