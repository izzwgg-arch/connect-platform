"use client";

import Link from "next/link";
import { BarChart2, ChevronDown, History, ListOrdered, Shuffle, Upload } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { CRMCard } from "../CRMCard";
import type { CampaignDetail, CampaignImportHistoryRow, CampaignPriority, WorkloadRow } from "./campaignTypes";
import { CAMPAIGN_PRIORITY_LABELS } from "./campaignTypes";
import { CampaignImportEventCard } from "./CampaignImportEventCard";
import { CampaignGuidedEmpty } from "./CampaignGuidedEmpty";
import type { CampaignHealth } from "./campaignUtils";
import { powerQueueHref, queueHref } from "./campaignUtils";

type Script = { id: string; name: string };
type Checklist = { id: string; name: string };

export function CampaignOperationalSidebar({
  campaign,
  health,
  workload,
  workloadLoading,
  importHistory,
  importHistoryLoading,
  isAdmin,
  canQueue,
  scripts,
  checklists,
  onUpdateCampaign,
  onDistribute,
  onImport,
  onFilterUnassigned,
}: {
  campaign: CampaignDetail;
  health: CampaignHealth;
  workload: WorkloadRow[];
  workloadLoading: boolean;
  importHistory: CampaignImportHistoryRow[];
  importHistoryLoading: boolean;
  isAdmin: boolean;
  canQueue: boolean;
  scripts: Script[];
  checklists: Checklist[];
  onUpdateCampaign: (data: Record<string, unknown>) => void;
  onDistribute: () => void;
  onImport: () => void;
  onFilterUnassigned: () => void;
}) {
  const alerts: { title: string; body: string; action?: React.ReactNode }[] = [];

  if (isAdmin && health.unassignedMembers > 0) {
    alerts.push({
      title: "Unassigned members",
      body: `${health.unassignedMembers} lead${health.unassignedMembers !== 1 ? "s" : ""} need an owner.`,
      action: (
        <div className="flex flex-wrap gap-1.5 mt-2">
          <button type="button" onClick={onDistribute} className={cn(crm.btnPrimary, "text-xs py-1.5 px-2.5")}>
            Distribute
          </button>
          <button type="button" onClick={onFilterUnassigned} className={cn(crm.btnGhost, "text-xs py-1.5 px-2.5")}>
            Filter
          </button>
        </div>
      ),
    });
  }
  if (health.callback > 0 && canQueue) {
    alerts.push({
      title: "Callback pressure",
      body: `${health.callback} in CALLBACK — work from queue.`,
      action: (
        <div className="flex flex-wrap gap-1.5 mt-2">
          <Link href={`${queueHref(campaign.id)}&filter=overdue`} className={cn(crm.btnGhost, "text-xs py-1.5 px-2.5")}>
            Overdue
          </Link>
          <Link href={powerQueueHref(campaign.id, "overdue")} className={cn(crm.btnGhost, "text-xs py-1.5 px-2.5")}>
            Power
          </Link>
        </div>
      ),
    });
  }
  if (health.total === 0) {
    alerts.push({
      title: "Campaign empty",
      body: "Import CSV or add existing contacts to start outbound work.",
      action: (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {isAdmin && (
            <button type="button" onClick={onImport} className={cn(crm.btnPrimary, "text-xs py-1.5 px-2.5")}>
              <Upload className="h-3.5 w-3.5" /> Import
            </button>
          )}
        </div>
      ),
    });
  }

  return (
    <aside className="flex flex-col gap-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
      <CRMCard className="p-3 sm:p-4">
        <p className={crm.label}>Next actions</p>
        {alerts.length === 0 ? (
          <p className="mt-2 text-xs text-crm-muted">No alerts — roster looks balanced for this snapshot.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {alerts.map((a) => (
              <li key={a.title} className="rounded-crm border border-crm-border/70 bg-crm-surface-2/40 px-3 py-2.5">
                <p className="text-sm font-semibold text-crm-text">{a.title}</p>
                <p className="text-xs text-crm-muted mt-0.5">{a.body}</p>
                {a.action}
              </li>
            ))}
          </ul>
        )}
        {canQueue && health.activeQueueWork > 0 && (
          <Link href={queueHref(campaign.id)} className={cn(crm.btnSecondary, "w-full mt-3 text-xs justify-center")}>
            <ListOrdered className="h-3.5 w-3.5" />
            Open campaign queue ({health.activeQueueWork})
          </Link>
        )}
      </CRMCard>

      {isAdmin && (
        <CRMCard className="p-4">
          <div className="flex items-center justify-between gap-2 mb-2">
            <p className={crm.label}>
              <BarChart2 className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
              Assignment load
            </p>
            {workloadLoading ? <span className="text-[10px] text-crm-muted">…</span> : null}
          </div>
          {workload.length === 0 && !workloadLoading ? (
            <p className="text-xs text-crm-muted">No assignments yet.</p>
          ) : (
            <ul className="space-y-2 max-h-48 overflow-y-auto">
              {workload.map((row) => {
                const active = row.pending + row.inProgress;
                return (
                  <li
                    key={row.userId ?? "__unassigned__"}
                    className={cn(
                      "rounded-crm border px-2.5 py-2 text-xs",
                      row.userId === null ? "border-crm-warning/35 bg-crm-warning/8" : "border-crm-border/70",
                    )}
                  >
                    <div className="flex justify-between gap-2">
                      <span className={cn("font-semibold truncate", row.userId === null && "text-crm-warning italic")}>
                        {row.displayName}
                      </span>
                      <span className="tabular-nums font-bold text-crm-text shrink-0">{row.total}</span>
                    </div>
                    <p className="mt-1 text-crm-muted">
                      Active {active} · CB {row.callbacks} · Done {row.converted + row.skipped + row.dnc}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </CRMCard>
      )}

      <CRMCard className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <History className="h-4 w-4 text-crm-muted" />
          <p className={crm.label}>Import events</p>
        </div>
        {importHistoryLoading ? (
          <p className="text-xs text-crm-muted">Loading…</p>
        ) : importHistory.length === 0 ? (
          <CampaignGuidedEmpty
            compact
            title="No imports yet"
            steps={[
              { label: "Import CSV", hint: "preview before commit" },
              { label: "Add existing contacts", hint: "from your CRM roster" },
              { label: "Distribute", hint: "assign unowned leads" },
            ]}
            action={
              isAdmin ? (
                <button type="button" onClick={onImport} className={cn(crm.btnSecondary, "text-xs py-1.5")}>
                  <Upload className="h-3.5 w-3.5" /> Import CSV
                </button>
              ) : undefined
            }
          />
        ) : (
          <ul className="space-y-2 max-h-64 overflow-y-auto">
            {importHistory.slice(0, 5).map((row) => (
              <CampaignImportEventCard key={row.id} row={row} />
            ))}
          </ul>
        )}
        {isAdmin && (
          <button type="button" onClick={onImport} className={cn(crm.btnGhost, "w-full mt-3 text-xs justify-center")}>
            <Upload className="h-3.5 w-3.5" /> New import
          </button>
        )}
      </CRMCard>

      <details className={cn(crm.card, "group open:ring-1 open:ring-crm-accent/15")}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-crm-text hover:bg-crm-surface-2/50 rounded-crm-lg [&::-webkit-details-marker]:hidden">
          Campaign settings
          <ChevronDown className="h-4 w-4 text-crm-muted transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-crm-border/60 px-4 pb-4 pt-3 space-y-4">
          <div>
            <label className="block text-xs text-crm-muted mb-1">Call script</label>
            <select
              value={campaign.scriptId ?? ""}
              onChange={(e) => onUpdateCampaign({ scriptId: e.target.value || null })}
              className={crm.input}
            >
              <option value="">None</option>
              {scripts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-crm-muted mb-1">Checklist</label>
            <select
              value={campaign.checklistId ?? ""}
              onChange={(e) => onUpdateCampaign({ checklistId: e.target.value || null })}
              className={crm.input}
            >
              <option value="">None</option>
              {checklists.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-crm-muted mb-2">Smart queue priority</label>
            <div className="flex flex-wrap gap-1.5">
              {(["LOW", "NORMAL", "HIGH", "URGENT"] as CampaignPriority[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onUpdateCampaign({ priority: p })}
                  className={cn(
                    crm.campaignPriorityPill,
                    (campaign.priority ?? "NORMAL") === p &&
                      (p === "URGENT"
                        ? crm.campaignPriorityPillUrgent
                        : p === "HIGH"
                          ? crm.campaignPriorityPillHigh
                          : crm.campaignPriorityPillActive),
                  )}
                >
                  {CAMPAIGN_PRIORITY_LABELS[p]}
                </button>
              ))}
            </div>
          </div>
          {isAdmin && health.unassignedMembers > 0 && (
            <button type="button" onClick={onDistribute} className={cn(crm.btnSecondary, "w-full text-xs justify-center")}>
              <Shuffle className="h-3.5 w-3.5" /> Distribute unassigned
            </button>
          )}
        </div>
      </details>
    </aside>
  );
}
