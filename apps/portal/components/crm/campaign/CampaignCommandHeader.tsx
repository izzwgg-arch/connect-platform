"use client";

import Link from "next/link";
import {
  Trash2,
  ChevronDown,
  Download,
  Edit2,
  Mail,
  Megaphone,
  Pause,
  Play,
  Plus,
  Save,
  Shuffle,
  Upload,
  X,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { mk, ROW_STATUS } from "./campaignCinemaClasses";
import type { CampaignDetail, CampaignImportHistoryRow } from "./campaignTypes";
import { CAMPAIGN_PRIORITY_LABELS, CAMPAIGN_STATUS_LABELS } from "./campaignTypes";
import type { CampaignHealth } from "./campaignUtils";
import { lastImportLabel } from "./campaignUtils";

export function CampaignCommandHeader({
  campaign,
  health,
  importHistory,
  isAdmin,
  editingName,
  nameInput,
  onNameInput,
  onStartEditName,
  onSaveName,
  onCancelEditName,
  onUpdateStatus,
  onRequestDelete,
  canEditCampaign = false,
  onExport,
  onImport,
  onAddContacts,
  onDistribute,
  onEditCampaign,
  onBulkEmail,
}: {
  campaign: CampaignDetail;
  health: CampaignHealth;
  importHistory: CampaignImportHistoryRow[];
  isAdmin: boolean;
  editingName: boolean;
  nameInput: string;
  onNameInput: (v: string) => void;
  onStartEditName: () => void;
  onSaveName: () => void;
  onCancelEditName: () => void;
  onUpdateStatus: (status: CampaignDetail["status"]) => void;
  onRequestDelete?: () => void;
  canEditCampaign?: boolean;
  onExport: () => void;
  onImport: () => void;
  onAddContacts: () => void;
  onDistribute: () => void;
  onEditCampaign?: () => void;
  onBulkEmail?: () => void;
}) {
  const lastImport = lastImportLabel(importHistory);
  const statusStyle = ROW_STATUS[campaign.status] ?? ROW_STATUS.DRAFT;
  const isActive = campaign.status === "ACTIVE";
  const canPauseCampaign = isActive && isAdmin;
  const canDeleteCampaign = canEditCampaign && campaign.status !== "ARCHIVED";
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
          <Link href="/crm/campaigns" className="cinema-breadcrumb-link">
            Campaigns
          </Link>
          <span className="cinema-breadcrumb-sep">/</span>
          <span className="cinema-breadcrumb-current">{campaign.name}</span>
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
                  <h1 className="cinema-detail-title">{campaign.name}</h1>
                  <span className={cn(mk.pill, isActive ? mk.statusPillActive : mk.statusPillPaused)}>
                    {CAMPAIGN_STATUS_LABELS[campaign.status]}
                  </span>
                  <button
                    type="button"
                    onClick={onStartEditName}
                    className="cinema-btn-icon-edit"
                    aria-label="Edit campaign name"
                  >
                    <Edit2 className="h-4 w-4" />
                  </button>
                </div>
              )}
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--cinema-text-muted)]">{objective}</p>
              {(campaign.script || campaign.checklist) && (
                <p className="mt-2 cinema-detail-meta">
                  {campaign.script ? (
                    <>
                      Script: <span className="cinema-detail-meta-strong">{campaign.script.name}</span>
                    </>
                  ) : null}
                  {campaign.script && campaign.checklist ? " · " : null}
                  {campaign.checklist ? (
                    <>
                      Checklist: <span className="cinema-detail-meta-strong">{campaign.checklist.name}</span>
                    </>
                  ) : null}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center lg:justify-end">
            <span className={cn(mk.pill, isActive ? mk.statusPillActive : mk.statusPillPaused)}>
              {CAMPAIGN_PRIORITY_LABELS[campaign.priority ?? "NORMAL"]} priority
            </span>
          </div>
        </div>

        <dl className={mk.detailKpiBand}>
          {kpis.map((k) => (
            <div
              key={k.label}
              className={cn(
                mk.detailKpiTile,
                k.urgent && "cinema-detail-kpi-urgent",
              )}
            >
              <dt className="cinema-detail-kpi-label">{k.label}</dt>
              <dd className={cn(mk.detailKpiValue, k.urgent && "cinema-detail-kpi-urgent-value")}>{k.value}</dd>
            </div>
          ))}
        </dl>

        <div className="cinema-detail-toolbar">
          {onEditCampaign ? (
            <button type="button" onClick={onEditCampaign} className={mk.btnSecondary}>
              <Edit2 className="h-4 w-4" /> Edit campaign
            </button>
          ) : null}
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
          {onBulkEmail && (
            <button type="button" onClick={onBulkEmail} className={mk.btnSecondary}>
              <Mail className="h-4 w-4" /> Bulk Email
            </button>
          )}
          <button type="button" onClick={onExport} className={mk.btnSecondary}>
            <Download className="h-4 w-4" /> Export
          </button>
          {canPauseCampaign || canDeleteCampaign ? (
            <details className="relative">
              <summary className={cn(mk.btnSecondary, "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
                More
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
              </summary>
              <div className={cn(mk.menuPanel, "absolute right-0 top-[calc(100%+0.5rem)] z-30 min-w-40 p-1")}>
                {canPauseCampaign ? (
                  <button
                    type="button"
                    onClick={() => onUpdateStatus("PAUSED")}
                    className={mk.menuItem}
                  >
                    <Pause className="h-3.5 w-3.5" /> Pause
                  </button>
                ) : null}
                {canDeleteCampaign ? (
                  <button
                    type="button"
                    onClick={() => (onRequestDelete ? onRequestDelete() : onUpdateStatus("ARCHIVED"))}
                    className={mk.menuItemDanger}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </button>
                ) : null}
              </div>
            </details>
          ) : null}
          <p className="ml-auto w-full cinema-detail-meta sm:w-auto">
            {lastImport ? (
              <>
                Last import: <span className="cinema-detail-meta-strong">{lastImport}</span>
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
