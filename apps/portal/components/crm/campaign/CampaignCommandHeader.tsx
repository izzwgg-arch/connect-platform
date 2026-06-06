"use client";

import Link from "next/link";
import {
  Trash2,
  ChevronDown,
  CalendarClock,
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
  const canManageCampaignActions = canEditCampaign || isAdmin;
  const canPauseCampaign = isActive && canManageCampaignActions;
  const canDeleteCampaign = canEditCampaign && campaign.status !== "ARCHIVED";
  const createdDate = new Date(campaign.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <header className="campaign-detail-identity-card">
      <div className={mk.atmosphere} aria-hidden>
        <div className="absolute left-[-8%] top-[-35%] h-[65%] w-[50%] rounded-full bg-[radial-gradient(circle,rgba(52,211,153,0.16),transparent_70%)]" />
        <div className="absolute right-[-5%] top-0 h-[50%] w-[40%] rounded-full bg-[radial-gradient(circle,rgba(59,130,246,0.12),transparent_68%)]" />
      </div>

      <div className="campaign-detail-identity-inner">
        <p className={mk.breadcrumb}>
          <Link href="/crm/campaigns" className="cinema-breadcrumb-link">
            Campaigns
          </Link>
          <span className="cinema-breadcrumb-sep">/</span>
          <span className="cinema-breadcrumb-current">{campaign.name}</span>
        </p>

        <div className="campaign-detail-identity-row">
          <div className="flex min-w-0 flex-1 gap-3">
            <div className={cn(mk.rowBadge, statusStyle.badge, "h-12 w-12 shrink-0 rounded-xl sm:h-14 sm:w-14")}>
              <Megaphone className={cn("h-6 w-6", statusStyle.icon)} aria-hidden />
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
                </div>
              )}
              <div className="campaign-detail-identity-meta">
                <span className={cn(mk.pill, "campaign-detail-priority-pill")}>
                  {CAMPAIGN_PRIORITY_LABELS[campaign.priority ?? "NORMAL"]} priority
                </span>
                <span>
                  <CalendarClock className="h-3.5 w-3.5" />
                  Created {createdDate}
                </span>
                <span>{lastImport ? `Last import ${lastImport}` : "No imports yet"}</span>
              </div>
            </div>
          </div>

          <details className="campaign-detail-actions-menu">
            <summary className={cn(mk.btnPrimary, "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
              Actions
              <ChevronDown className="h-3.5 w-3.5 opacity-80" />
            </summary>
            <div className={cn(mk.menuPanel, "absolute right-0 top-[calc(100%+0.5rem)] z-40 min-w-52 p-1")}>
              {onEditCampaign ? (
                <button type="button" onClick={onEditCampaign} className={mk.menuItem}>
                  <Edit2 className="h-3.5 w-3.5" /> Edit campaign
                </button>
              ) : null}
              <button type="button" onClick={onStartEditName} className={mk.menuItem}>
                <Edit2 className="h-3.5 w-3.5" /> Rename
              </button>
              {campaign.status === "DRAFT" && canManageCampaignActions ? (
                <button type="button" onClick={() => onUpdateStatus("ACTIVE")} className={mk.menuItem}>
                  <Play className="h-3.5 w-3.5" /> Start campaign
                </button>
              ) : null}
              {campaign.status === "PAUSED" && canManageCampaignActions ? (
                <button type="button" onClick={() => onUpdateStatus("ACTIVE")} className={mk.menuItem}>
                  <Play className="h-3.5 w-3.5" /> Resume
                </button>
              ) : null}
              {canPauseCampaign ? (
                <button type="button" onClick={() => onUpdateStatus("PAUSED")} className={mk.menuItem}>
                  <Pause className="h-3.5 w-3.5" /> Pause
                </button>
              ) : null}
              {canManageCampaignActions ? (
                <button type="button" onClick={onImport} className={mk.menuItem}>
                  <Upload className="h-3.5 w-3.5" /> Import CSV
                </button>
              ) : null}
              <button type="button" onClick={onAddContacts} className={mk.menuItem}>
                <Plus className="h-3.5 w-3.5" /> Add contacts
              </button>
              {canManageCampaignActions ? (
                <button type="button" onClick={onDistribute} className={mk.menuItem}>
                  <Shuffle className="h-3.5 w-3.5" /> Distribute
                </button>
              ) : null}
              {onBulkEmail ? (
                <button type="button" onClick={onBulkEmail} className={mk.menuItem}>
                  <Mail className="h-3.5 w-3.5" /> Bulk Email
                </button>
              ) : null}
              <button type="button" onClick={onExport} className={mk.menuItem}>
                <Download className="h-3.5 w-3.5" /> Export
              </button>
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
        </div>
      </div>
    </header>
  );
}
