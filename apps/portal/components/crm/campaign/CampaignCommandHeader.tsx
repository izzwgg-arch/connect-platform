"use client";

import Link from "next/link";
import {
  Archive,
  ChevronDown,
  Download,
  Edit2,
  ListOrdered,
  Megaphone,
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
import { mk, ROW_STATUS } from "./campaignCinemaClasses";
import type { CampaignDetail, CampaignImportHistoryRow } from "./campaignTypes";
import { CAMPAIGN_PRIORITY_LABELS, CAMPAIGN_STATUS_LABELS } from "./campaignTypes";
import type { CampaignHealth } from "./campaignUtils";
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
  const statusStyle = ROW_STATUS[campaign.status] ?? ROW_STATUS.DRAFT;
  const isActive = campaign.status === "ACTIVE";
  const objective =
    campaign.description?.trim() ||
    `${CAMPAIGN_STATUS_LABELS[campaign.status]} program · ${CAMPAIGN_PRIORITY_LABELS[campaign.priority ?? "NORMAL"]} priority`;

  const kpis = [
    { label: "Members", value: health.total },
    { label: "Queue work", value: health.activeQueueWork, urgent: health.activeQueueWork > 0 },
    { label: "Callbacks", value: health.callback, urgent: health.callback > 0 },
    { label: "Contacted", value: health.contactedProgress },
    { label: "Converted", value: health.converted },
    { label: "Conv. rate", value: `${health.conversionPct}%` },
  ];

  return (
    <header className={mk.detailHero}>
      <div className={mk.atmosphere} aria-hidden>
        <div className="absolute left-[-8%] top-[-35%] h-[65%] w-[50%] rounded-full bg-[radial-gradient(circle,rgba(52,211,153,0.16),transparent_70%)]" />
        <div className="absolute right-[-5%] top-0 h-[50%] w-[40%] rounded-full bg-[radial-gradient(circle,rgba(59,130,246,0.12),transparent_68%)]" />
      </div>

      <div className={mk.detailHeroInner}>
        <p className={mk.breadcrumb}>
          <Link href="/crm/campaigns" className="hover:text-[#93c5fd]">
            Campaigns
          </Link>
          <span className="mx-1.5 text-white/25">/</span>
          <span className="text-[#9aa8be]">{campaign.name}</span>
        </p>

        <div className={mk.detailTitleRow}>
          <div className="flex min-w-0 flex-1 gap-4">
            <div className={cn(mk.rowBadge, statusStyle.badge, "h-16 w-16 shrink-0")}>
              <Megaphone className={cn("h-8 w-8", statusStyle.icon)} aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
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
                    className={cn(crm.input, "max-w-md text-xl font-bold")}
                  />
                  <button type="button" onClick={onSaveName} className={mk.btnGreen} aria-label="Save name">
                    <Save className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={onCancelEditName} className={mk.btnSecondary} aria-label="Cancel">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">{campaign.name}</h1>
                  <span className={cn(mk.pill, isActive ? mk.statusPillActive : mk.statusPillPaused)}>
                    {CAMPAIGN_STATUS_LABELS[campaign.status]}
                  </span>
                  <button
                    type="button"
                    onClick={onStartEditName}
                    className="rounded-lg border border-white/10 p-1.5 text-[#8b9cb3] hover:border-white/20 hover:text-white"
                    aria-label="Edit campaign name"
                  >
                    <Edit2 className="h-4 w-4" />
                  </button>
                </div>
              )}
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#9aa8be]">{objective}</p>
              {(campaign.script || campaign.checklist) && (
                <p className="mt-2 text-xs text-[#6d7f99]">
                  {campaign.script ? (
                    <>
                      Script: <span className="font-medium text-[#e2e9f4]">{campaign.script.name}</span>
                    </>
                  ) : null}
                  {campaign.script && campaign.checklist ? " · " : null}
                  {campaign.checklist ? (
                    <>
                      Checklist: <span className="font-medium text-[#e2e9f4]">{campaign.checklist.name}</span>
                    </>
                  ) : null}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center lg:justify-end">
            {canQueue && isActive && (
              <Link href={powerQueueHref(campaign.id)} className={mk.btnGreen}>
                <Zap className="h-4 w-4 shrink-0" />
                Open in dialer
              </Link>
            )}
            {canQueue && (
              <Link href={queueHref(campaign.id)} className={mk.btnSecondary}>
                <ListOrdered className="h-4 w-4 shrink-0" />
                Queue
                <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
              </Link>
            )}
            {canQueue && isActive && (
              <Link
                href={powerQueueHref(campaign.id)}
                className="inline-flex items-center gap-2 rounded-xl border border-[#fb923c]/35 bg-[#fb923c]/10 px-4 py-2.5 text-sm font-semibold text-[#fdba74] hover:border-[#fb923c]/50"
              >
                <Zap className="h-4 w-4" />
                Power mode
              </Link>
            )}
          </div>
        </div>

        <dl className={mk.detailKpiBand}>
          {kpis.map((k) => (
            <div
              key={k.label}
              className={cn(
                mk.detailKpiTile,
                k.urgent && "border-[#fbbf24]/35 bg-[#fbbf24]/8",
              )}
            >
              <dt className="text-[10px] font-bold uppercase tracking-wider text-[#6d7f99]">{k.label}</dt>
              <dd className={cn(mk.detailKpiValue, k.urgent && "text-[#fcd34d]")}>{k.value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4">
          {campaign.status === "DRAFT" && isAdmin && (
            <button type="button" onClick={() => onUpdateStatus("ACTIVE")} className={mk.btnPrimary}>
              <Play className="h-4 w-4" /> Start campaign
            </button>
          )}
          {campaign.status === "PAUSED" && isAdmin && (
            <button type="button" onClick={() => onUpdateStatus("ACTIVE")} className={mk.btnPrimary}>
              <Play className="h-4 w-4" /> Resume
            </button>
          )}
          {isAdmin && (
            <button type="button" onClick={onImport} className={mk.btnSecondary}>
              <Upload className="h-4 w-4" /> Import CSV
            </button>
          )}
          <button type="button" onClick={onAddContacts} className={mk.btnSecondary}>
            <Plus className="h-4 w-4" /> Add contacts
          </button>
          {isAdmin && (
            <button type="button" onClick={onDistribute} className={mk.btnSecondary}>
              <Shuffle className="h-4 w-4" /> Distribute
            </button>
          )}
          {campaign.status === "ACTIVE" && isAdmin && (
            <button
              type="button"
              onClick={() => onUpdateStatus("PAUSED")}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#fbbf24]/30 px-3 py-2 text-xs font-semibold text-[#fcd34d] hover:bg-[#fbbf24]/10"
            >
              <Pause className="h-3.5 w-3.5" /> Pause
            </button>
          )}
          {(campaign.status === "ACTIVE" || campaign.status === "PAUSED") && isAdmin && (
            <button
              type="button"
              onClick={() => {
                if (confirm("Archive this campaign?")) onUpdateStatus("ARCHIVED");
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs font-semibold text-[#8b9cb3] hover:text-[#f87171]"
            >
              <Archive className="h-3.5 w-3.5" /> Archive
            </button>
          )}
          <button type="button" onClick={onExport} className={mk.btnSecondary}>
            <Download className="h-4 w-4" /> Export
          </button>
          <p className="ml-auto w-full text-[11px] text-[#6d7f99] sm:w-auto">
            {lastImport ? (
              <>
                Last import: <span className="font-medium text-[#9aa8be]">{lastImport}</span>
              </>
            ) : (
              "No campaign CSV imports on record yet."
            )}
          </p>
        </div>
      </div>
    </header>
  );
}
