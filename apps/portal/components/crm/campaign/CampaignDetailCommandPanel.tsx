"use client";

import Link from "next/link";
import { BarChart2, ChevronDown, History, ListOrdered, Shuffle, Upload } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { CampaignDetail, CampaignImportHistoryRow, CampaignPriority, WorkloadRow } from "./campaignTypes";
import { CAMPAIGN_PRIORITY_LABELS } from "./campaignTypes";
import { CampaignImportEventCard } from "./CampaignImportEventCard";
import { CampaignGuidedEmpty } from "./CampaignGuidedEmpty";
import type { CampaignHealth } from "./campaignUtils";
import { powerQueueHref, queueHref } from "./campaignUtils";

type Script = { id: string; name: string };
type Checklist = { id: string; name: string };

/** Full-width operational command strip — replaces skinny right rail (19E.3 detail). */
export function CampaignDetailCommandPanel({
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
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" onClick={onDistribute} className={cn(crm.campaignDetailBtnSecondary, "text-xs py-1.5 px-2.5")}>
            Distribute
          </button>
          <button type="button" onClick={onFilterUnassigned} className={cn(crm.campaignDetailBtnTertiary, "text-xs py-1.5 px-2.5")}>
            Filter roster
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
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Link href={`${queueHref(campaign.id)}&filter=overdue`} className={cn(crm.campaignDetailBtnTertiary, "text-xs py-1.5 px-2.5")}>
            Overdue queue
          </Link>
          <Link href={powerQueueHref(campaign.id, "overdue")} className={cn(crm.campaignDetailBtnTertiary, "text-xs py-1.5 px-2.5")}>
            Power session
          </Link>
        </div>
      ),
    });
  }

  return (
    <section className={cn(crm.campaignDetailCommandGrid, "min-w-0")} aria-label="Campaign operations">
      <div className={crm.campaignOpsCell}>
        <div className={crm.campaignOpsCellHeader}>
          <p className={crm.label}>Next actions</p>
        </div>
        {alerts.length === 0 ? (
          <p className="mt-2 text-xs leading-relaxed text-crm-muted">No alerts — roster looks balanced for this snapshot.</p>
        ) : (
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {alerts.map((a) => (
              <li key={a.title} className="rounded-crm border border-crm-border/70 bg-crm-surface-2/50 px-3 py-2.5">
                <p className="text-sm font-semibold text-crm-text">{a.title}</p>
                <p className="mt-0.5 text-xs text-crm-muted">{a.body}</p>
                {a.action}
              </li>
            ))}
          </ul>
        )}
        {canQueue && health.activeQueueWork > 0 && (
          <Link href={queueHref(campaign.id)} className={cn(crm.campaignDetailBtnSecondary, "mt-3 w-full justify-center text-xs")}>
            <ListOrdered className="h-3.5 w-3.5 shrink-0" />
            Open campaign queue ({health.activeQueueWork})
          </Link>
        )}
      </div>

      {isAdmin && (
        <div className={crm.campaignOpsCell}>
          <div className={crm.campaignOpsCellHeader}>
            <p className={crm.label}>
              <BarChart2 className="-mt-0.5 mr-1 inline h-3.5 w-3.5" />
              Assignment load
            </p>
            {workloadLoading ? <span className="text-[10px] text-crm-muted">…</span> : null}
          </div>
          {workload.length === 0 && !workloadLoading ? (
            <p className="text-xs text-crm-muted">No assignments yet.</p>
          ) : (
            <ul className="grid max-h-52 gap-2 overflow-y-auto sm:grid-cols-2">
              {workload.map((row) => {
                const active = row.pending + row.inProgress;
                return (
                  <li
                    key={row.userId ?? "__unassigned__"}
                    className={cn(
                      "rounded-crm border px-2.5 py-2 text-xs",
                      row.userId === null ? "border-crm-warning/35 bg-crm-warning/8" : "border-crm-border/70 bg-crm-surface-2/40",
                    )}
                  >
                    <div className="flex justify-between gap-2">
                      <span className={cn("truncate font-semibold", row.userId === null && "italic text-crm-warning")}>
                        {row.displayName}
                      </span>
                      <span className="shrink-0 font-bold tabular-nums text-crm-text">{row.total}</span>
                    </div>
                    <p className="mt-1 text-crm-muted">
                      Active {active} · CB {row.callbacks} · Done {row.converted + row.skipped + row.dnc}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className={crm.campaignOpsCell}>
        <div className="mb-2 flex items-center gap-2">
          <History className="h-4 w-4 shrink-0 text-crm-muted" />
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
              { label: "Add contacts", hint: "from CRM roster" },
              { label: "Distribute", hint: "assign unowned leads" },
            ]}
            action={
              isAdmin ? (
                <button type="button" onClick={onImport} className={cn(crm.campaignDetailBtnSecondary, "text-xs py-1.5")}>
                  <Upload className="h-3.5 w-3.5 shrink-0" /> Import CSV
                </button>
              ) : undefined
            }
          />
        ) : (
          <ul className="grid max-h-52 gap-2 overflow-y-auto">
            {importHistory.slice(0, 4).map((row) => (
              <CampaignImportEventCard key={row.id} row={row} />
            ))}
          </ul>
        )}
        {isAdmin && (
          <button type="button" onClick={onImport} className={cn(crm.campaignDetailBtnTertiary, "mt-3 w-full justify-center text-xs")}>
            <Upload className="h-3.5 w-3.5 shrink-0" /> New import
          </button>
        )}
      </div>

      <div className={cn(crm.campaignOpsCell, "p-0 overflow-hidden")}>
        <details className="group h-full open:ring-1 open:ring-crm-accent/15">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-crm-text hover:bg-crm-surface-2/50 [&::-webkit-details-marker]:hidden">
            Campaign settings
            <ChevronDown className="h-4 w-4 shrink-0 text-crm-muted transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-4 border-t border-crm-border/60 px-4 pb-4 pt-3">
            <div>
              <label className="mb-1 block text-xs text-crm-muted">Call script</label>
              <select
                value={campaign.scriptId ?? ""}
                onChange={(e) => onUpdateCampaign({ scriptId: e.target.value || null })}
                className={crm.select}
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
              <label className="mb-1 block text-xs text-crm-muted">Checklist</label>
              <select
                value={campaign.checklistId ?? ""}
                onChange={(e) => onUpdateCampaign({ checklistId: e.target.value || null })}
                className={crm.select}
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
              <label className="mb-2 block text-xs text-crm-muted">Smart queue priority</label>
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
              <button type="button" onClick={onDistribute} className={cn(crm.campaignDetailBtnSecondary, "w-full justify-center text-xs")}>
                <Shuffle className="h-3.5 w-3.5 shrink-0" /> Distribute unassigned
              </button>
            )}
          </div>
        </details>
      </div>
    </section>
  );
}
