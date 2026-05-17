"use client";

import Link from "next/link";
import {
  Archive,
  Download,
  Edit2,
  ListOrdered,
  Pause,
  Play,
  Plus,
  Save,
  Shuffle,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { CRMCard } from "../CRMCard";
import type { CampaignDetail, CampaignImportHistoryRow } from "./campaignTypes";
import { CampaignPriorityBadge, CampaignStatusBadge } from "./CampaignStatusBadge";
import type { CampaignHealth } from "./campaignUtils";
import { CAMPAIGN_PRIORITY_LABELS, CAMPAIGN_STATUS_LABELS } from "./campaignTypes";
import { lastImportLabel, powerQueueHref, queueHref } from "./campaignUtils";

export function CampaignCommandHeader({
  campaign,
  health,
  importHistory,
  isAdmin,
  canQueue,
  editingName,
  nameInput,
  onNameInput,
  onStartEditName,
  onSaveName,
  onCancelEditName,
  onUpdateStatus,
  onExport,
  onImport,
  onAddContacts,
  onDistribute,
}: {
  campaign: CampaignDetail;
  health: CampaignHealth;
  importHistory: CampaignImportHistoryRow[];
  isAdmin: boolean;
  canQueue: boolean;
  editingName: boolean;
  nameInput: string;
  onNameInput: (v: string) => void;
  onStartEditName: () => void;
  onSaveName: () => void;
  onCancelEditName: () => void;
  onUpdateStatus: (status: CampaignDetail["status"]) => void;
  onExport: () => void;
  onImport: () => void;
  onAddContacts: () => void;
  onDistribute: () => void;
}) {
  const lastImport = lastImportLabel(importHistory);
  const objective =
    campaign.description?.trim() ||
    `${CAMPAIGN_STATUS_LABELS[campaign.status]} program · ${CAMPAIGN_PRIORITY_LABELS[campaign.priority ?? "NORMAL"]} queue priority`;

  return (
    <CRMCard className="overflow-hidden p-0">
      <div className="grid gap-0 lg:grid-cols-12">
        <div className="border-b border-crm-border/60 p-3 sm:p-4 lg:col-span-4 lg:border-b-0 lg:border-r">
          {editingName ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                autoFocus
                value={nameInput}
                onChange={(e) => onNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveName();
                  if (e.key === "Escape") onCancelEditName();
                }}
                className={cn(crm.input, "max-w-md text-lg font-semibold")}
              />
              <button type="button" onClick={onSaveName} className={crm.btnPrimary} aria-label="Save name">
                <Save className="h-4 w-4" />
              </button>
              <button type="button" onClick={onCancelEditName} className={crm.campaignDetailBtnTertiary} aria-label="Cancel">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <h1 className="text-xl font-bold tracking-tight text-crm-text sm:text-2xl">{campaign.name}</h1>
              <button
                type="button"
                onClick={onStartEditName}
                className={cn(crm.campaignDetailBtnTertiary, "mt-0.5 shrink-0 p-1.5")}
                aria-label="Edit campaign name"
              >
                <Edit2 className="h-4 w-4" />
              </button>
            </div>
          )}
          <p className="mt-2 line-clamp-3 text-sm leading-snug text-crm-muted">{objective}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <CampaignStatusBadge status={campaign.status} variant="index" />
            <CampaignPriorityBadge priority={campaign.priority ?? "NORMAL"} />
          </div>
          {(campaign.script || campaign.checklist) && (
            <p className="mt-2 text-xs text-crm-muted">
              {campaign.script ? (
                <>
                  Script: <span className="font-medium text-crm-text">{campaign.script.name}</span>
                </>
              ) : null}
              {campaign.script && campaign.checklist ? " · " : null}
              {campaign.checklist ? (
                <>
                  Checklist: <span className="font-medium text-crm-text">{campaign.checklist.name}</span>
                </>
              ) : null}
            </p>
          )}
        </div>

        <div className="border-b border-crm-border/60 bg-crm-surface-2/30 p-3 sm:p-4 lg:col-span-5 lg:border-b-0 lg:border-r">
          <p className={crm.label}>Live snapshot</p>
          <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <HeaderStat label="Queue work" value={health.activeQueueWork} hint="Pending + in progress" urgent={health.activeQueueWork > 0} />
            <HeaderStat label="Callbacks" value={health.callback} hint="CALLBACK status" urgent={health.callback > 0} />
            <HeaderStat label="Members" value={health.total} />
            <HeaderStat label="Converted" value={`${health.converted} (${health.conversionPct}%)`} />
            <HeaderStat label="Assigned agents" value={health.activeAgents} hint="With roster load" />
            <HeaderStat
              label="Unassigned"
              value={health.unassignedMembers}
              hint="Needs distribute"
              urgent={isAdmin && health.unassignedMembers > 0}
            />
          </dl>
          <p className="mt-3 text-[11px] leading-snug text-crm-muted">
            {lastImport ? (
              <>
                Last import: <span className="font-medium text-crm-text">{lastImport}</span>
              </>
            ) : (
              "No campaign CSV imports on record yet."
            )}
          </p>
        </div>

        <div className="flex min-w-0 flex-col gap-2 p-3 sm:p-4 lg:col-span-3">
          <p className={crm.label}>Operations</p>
          <div className="mt-1 flex flex-col gap-1.5">
            {campaign.status === "DRAFT" && isAdmin && (
              <button type="button" onClick={() => onUpdateStatus("ACTIVE")} className={cn(crm.btnPrimary, "w-full justify-center text-sm py-2")}>
                <Play className="h-4 w-4 shrink-0" /> Start campaign
              </button>
            )}
            {campaign.status === "PAUSED" && isAdmin && (
              <button type="button" onClick={() => onUpdateStatus("ACTIVE")} className={cn(crm.btnPrimary, "w-full justify-center text-sm py-2")}>
                <Play className="h-4 w-4 shrink-0" /> Resume campaign
              </button>
            )}
            {canQueue && (
              <Link href={queueHref(campaign.id)} className={cn(crm.btnPrimary, "w-full justify-center text-sm py-2")}>
                <ListOrdered className="h-4 w-4 shrink-0" /> Open queue
              </Link>
            )}
            {canQueue && campaign.status === "ACTIVE" && (
              <Link href={powerQueueHref(campaign.id)} className={cn(crm.campaignDetailBtnSecondary, "w-full justify-center text-sm")}>
                <Zap className="h-4 w-4 shrink-0" /> Power session
              </Link>
            )}
            {isAdmin && (
              <button type="button" onClick={onImport} className={cn(crm.campaignDetailBtnSecondary, "w-full justify-center text-sm")}>
                <Upload className="h-4 w-4 shrink-0" /> Import
              </button>
            )}
            <button type="button" onClick={onAddContacts} className={cn(crm.campaignDetailBtnSecondary, "w-full justify-center text-sm")}>
              <Plus className="h-4 w-4 shrink-0" /> Add contacts
            </button>
            {isAdmin && (
              <button type="button" onClick={onDistribute} className={cn(crm.campaignDetailBtnSecondary, "w-full justify-center text-sm")}>
                <Shuffle className="h-4 w-4 shrink-0" /> Distribute
              </button>
            )}
          </div>
          <div className="mt-auto flex flex-wrap gap-1 border-t border-crm-border/50 pt-2">
            {campaign.status === "ACTIVE" && isAdmin && (
              <button type="button" onClick={() => onUpdateStatus("PAUSED")} className={cn(crm.campaignDetailBtnTertiary, "text-crm-warning")}>
                <Pause className="h-3.5 w-3.5 shrink-0" /> Pause
              </button>
            )}
            {(campaign.status === "ACTIVE" || campaign.status === "PAUSED") && isAdmin && (
              <button
                type="button"
                onClick={() => {
                  if (confirm("Archive this campaign?")) onUpdateStatus("ARCHIVED");
                }}
                className={crm.campaignDetailBtnTertiary}
              >
                <Archive className="h-3.5 w-3.5 shrink-0" /> Archive
              </button>
            )}
            <button type="button" onClick={onExport} className={crm.campaignDetailBtnTertiary} title="Export CSV">
              <Download className="h-3.5 w-3.5 shrink-0" /> Export
            </button>
          </div>
        </div>
      </div>
    </CRMCard>
  );
}

function HeaderStat({
  label,
  value,
  hint,
  urgent,
}: {
  label: string;
  value: string | number;
  hint?: string;
  urgent?: boolean;
}) {
  return (
    <div className={cn("rounded-crm border px-2.5 py-2", urgent ? "border-crm-warning/35 bg-crm-warning/8" : "border-crm-border/70 bg-crm-surface/80")}>
      <dt className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-xl font-bold tabular-nums", urgent ? "text-crm-warning" : "text-crm-text")}>{value}</dd>
      {hint ? <p className="mt-0.5 text-[10px] leading-snug text-crm-muted">{hint}</p> : null}
    </div>
  );
}
