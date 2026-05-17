"use client";

import Link from "next/link";
import { BarChart2, ChevronDown, History, ListOrdered, Shuffle, Upload } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { mk } from "./campaignCinemaClasses";
import type { CampaignDetail, CampaignImportHistoryRow, CampaignPriority, WorkloadRow } from "./campaignTypes";
import { CAMPAIGN_PRIORITY_LABELS } from "./campaignTypes";
import { CampaignImportEventCard } from "./CampaignImportEventCard";
import { CampaignGuidedEmpty } from "./CampaignGuidedEmpty";
import type { CampaignHealth } from "./campaignUtils";
import { powerQueueHref, queueHref } from "./campaignUtils";

type Script = { id: string; name: string };
type Checklist = { id: string; name: string };

const LOAD_COLORS = ["#60a5fa", "#a78bfa", "#34d399", "#fbbf24", "#fb923c", "#f472b6"];

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
  const alerts: { title: string; body: string; icon: string; action?: React.ReactNode }[] = [];

  if (isAdmin && health.unassignedMembers > 0) {
    alerts.push({
      title: "Unassigned members",
      body: `${health.unassignedMembers} lead${health.unassignedMembers !== 1 ? "s" : ""} need an owner.`,
      icon: "text-[#a78bfa]",
      action: (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={onDistribute} className={mk.btnSecondary}>
            Distribute
          </button>
          <button type="button" onClick={onFilterUnassigned} className={mk.btnQueueRow}>
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
      icon: "text-[#fb923c]",
      action: (
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={`${queueHref(campaign.id)}&filter=overdue`} className={mk.btnQueueRow}>
            Overdue queue
          </Link>
          <Link href={powerQueueHref(campaign.id, "overdue")} className={mk.btnQueueRow}>
            Power session
          </Link>
        </div>
      ),
    });
  }

  const maxLoad = Math.max(...workload.map((w) => w.total), 1);

  return (
    <section className={mk.opsGrid} aria-label="Campaign operations">
      <div className={mk.opsCard}>
        <p className={mk.opsTitle}>Next actions</p>
        {alerts.length === 0 ? (
          <p className="mt-3 text-xs leading-relaxed text-[#8b9cb3]">
            No alerts — roster looks balanced for this snapshot.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {alerts.map((a) => (
              <li
                key={a.title}
                className="rounded-xl border border-white/[0.08] bg-[#0f1522]/60 px-3 py-3"
              >
                <p className={cn("text-sm font-bold text-white", a.icon)}>{a.title}</p>
                <p className="mt-0.5 text-xs text-[#8b9cb3]">{a.body}</p>
                {a.action}
              </li>
            ))}
          </ul>
        )}
        {canQueue && health.activeQueueWork > 0 && (
          <Link href={queueHref(campaign.id)} className={cn(mk.btnPrimary, "mt-4 w-full")}>
            <ListOrdered className="h-4 w-4" />
            Open queue ({health.activeQueueWork})
          </Link>
        )}
      </div>

      {isAdmin && (
        <div className={mk.opsCard}>
          <p className={mk.opsTitle}>
            <BarChart2 className="mr-1.5 inline h-4 w-4 text-[#60a5fa]" />
            Assignment load
          </p>
          {workloadLoading ? (
            <p className="mt-3 text-xs text-[#8b9cb3]">Loading…</p>
          ) : workload.length === 0 ? (
            <p className="mt-3 text-xs text-[#8b9cb3]">No assignments yet.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {workload.map((row, i) => {
                const pct = Math.round((row.total / maxLoad) * 100);
                const color = LOAD_COLORS[i % LOAD_COLORS.length];
                return (
                  <li key={row.userId ?? "__unassigned__"}>
                    <div className="flex justify-between gap-2 text-xs">
                      <span
                        className={cn(
                          "truncate font-semibold text-[#e2e9f4]",
                          row.userId === null && "italic text-[#fcd34d]",
                        )}
                      >
                        {row.displayName}
                      </span>
                      <span className="shrink-0 font-bold tabular-nums text-white">{row.total}</span>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[#0f1522]">
                      <div
                        className="h-full rounded-full transition-[width] duration-500"
                        style={{ width: `${pct}%`, background: color }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className={mk.opsCard}>
        <p className={mk.opsTitle}>
          <History className="mr-1.5 inline h-4 w-4 text-[#a78bfa]" />
          Import events
        </p>
        {importHistoryLoading ? (
          <p className="mt-3 text-xs text-[#8b9cb3]">Loading…</p>
        ) : importHistory.length === 0 ? (
          <div className="mt-3">
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
                  <button type="button" onClick={onImport} className={mk.btnSecondary}>
                    <Upload className="h-4 w-4" /> Import CSV
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <ul className="mt-3 max-h-48 space-y-2 overflow-y-auto">
            {importHistory.slice(0, 4).map((row) => (
              <CampaignImportEventCard key={row.id} row={row} />
            ))}
          </ul>
        )}
        {isAdmin && (
          <button type="button" onClick={onImport} className={cn(mk.btnQueueRow, "mt-4 w-full")}>
            <Upload className="h-4 w-4" /> New import
          </button>
        )}
      </div>

      <div className={cn(mk.opsCard, "p-0 overflow-hidden")}>
        <details className="group h-full open:ring-1 open:ring-[#3b82f6]/20">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-4 text-sm font-bold text-white hover:bg-white/[0.03] [&::-webkit-details-marker]:hidden">
            Campaign settings
            <ChevronDown className="h-4 w-4 shrink-0 text-[#8b9cb3] transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-4 border-t border-white/[0.06] px-5 pb-5 pt-4">
            <div>
              <label className="mb-1 block text-xs text-[#8b9cb3]">Call script</label>
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
              <label className="mb-1 block text-xs text-[#8b9cb3]">Checklist</label>
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
              <label className="mb-2 block text-xs text-[#8b9cb3]">Smart queue priority</label>
              <div className="flex flex-wrap gap-1.5">
                {(["LOW", "NORMAL", "HIGH", "URGENT"] as CampaignPriority[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => onUpdateCampaign({ priority: p })}
                    className={cn(
                      "rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors",
                      (campaign.priority ?? "NORMAL") === p
                        ? "border-[#3b82f6]/45 bg-[#3b82f6]/15 text-[#93c5fd]"
                        : "border-white/10 bg-[#0f1522] text-[#8b9cb3] hover:border-white/18",
                    )}
                  >
                    {CAMPAIGN_PRIORITY_LABELS[p]}
                  </button>
                ))}
              </div>
            </div>
            {isAdmin && health.unassignedMembers > 0 && (
              <button type="button" onClick={onDistribute} className={cn(mk.btnSecondary, "w-full")}>
                <Shuffle className="h-4 w-4" /> Distribute unassigned
              </button>
            )}
          </div>
        </details>
      </div>
    </section>
  );
}
